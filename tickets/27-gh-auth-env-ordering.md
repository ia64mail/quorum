# #27: Fix #15 entrypoint bootstrap defects — gh auth ordering and read-only gitconfig

## Problem

After merging #15 (PAT wiring) into `8-workspace-isolation-staging`, `./scripts/start.sh` brings the whole system down. The mcp-server container stays healthy because its entrypoint did not change, but every container that runs the new `gh auth` bootstrap — `architect`, `developer`, `teamlead`, and `moderator` — exits with code `1` within seconds of starting.

There are **two** independent pre-existing defects in the #15 bootstrap. Both abort `set -euo pipefail`, and they surface on the same entrypoint run — fixing only the first lets the script reach the second.

**Defect 1 — gh auth login ordering.** `docker logs quorum-architect-1` (and the same for the other three):

```
The value of the GH_TOKEN environment variable is being used for authentication.
To have GitHub CLI store credentials instead, first clear the value from the environment.
```

**Defect 2 — gh auth setup-git on read-only filesystem** (surfaces in the next entrypoint line, after Defect 1 is fixed):

```
failed to set up git credential helper: failed to run git:
error: could not lock config file /home/quorum/.gitconfig: Read-only file system
```

The system is fully blocked: no agent connects to the broker, the moderator session cannot be attached, and every downstream QRM8 ticket (#11, #12, #13, #14) that depends on a runnable staging environment is gated on this fix.

## Root Cause

Both `docker/agent/entrypoint.sh:9-16` and `docker/moderator/entrypoint.sh:39-46` use this pattern:

```bash
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token   # ← Defect 1: GH_TOKEN still in env
  gh auth setup-git                                # ← Defect 2: writes to read-only ~/.gitconfig
  unset GH_TOKEN                                   # ← (also: too late for Defect 1)
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
fi
```

### Defect 1 — gh refuses to persist credentials while GH_TOKEN is in env

`gh` treats `GH_TOKEN` as the authoritative credential source and refuses to write `~/.config/gh/hosts.yml` while it's set — a persisted hosts.yml would be redundant and ambiguous against the env var. In that state, `gh auth login --with-token` prints the warning above and exits non-zero. `set -euo pipefail` aborts the entrypoint before `node dist/main.js` (agent) or `tail -f /dev/null` (moderator) is reached.

The pre-merge security review of #15 flagged a nearby concern ("invalid `GH_TOKEN` aborts startup") but identified the wrong trigger — the abort fires for **any** `GH_TOKEN` value, because the ordering of `unset GH_TOKEN` relative to `gh auth login --with-token` is wrong regardless of token validity.

### Defect 2 — gh auth setup-git writes to read-only ~/.gitconfig

`gh auth setup-git` runs `git config --global credential.https://github.com.helper '!gh auth git-credential'`. By default, `git config --global` writes to `~/.gitconfig`. In the Quorum container security model (`x-base-security` / `x-agent-security` in `docker-compose.yml`), the rootfs is mounted `read_only: true` and only specific paths are tmpfs:

| Path | Source |
|------|--------|
| `/tmp` | tmpfs (all containers) |
| `/home/quorum/.config` | tmpfs (all containers) |
| `/home/quorum/.local` | tmpfs (all containers) |
| `/home/quorum/.cache` | tmpfs (all containers) |
| `/home/quorum/.claude` | tmpfs (agents) / named volume (moderator) |

`/home/quorum/.gitconfig` is **not** on any tmpfs, so `git config --global` fails with `error: could not lock config file /home/quorum/.gitconfig: Read-only file system`. `gh` propagates the non-zero exit and `set -euo pipefail` aborts the entrypoint.

This defect was never tested at merge time because the #15 review focused on env-var leakage and prompt-level credential reads — the read-only-fs interaction with `gh auth setup-git`'s default config path wasn't exercised.

## Design

Two entrypoint-only changes, applied identically to `docker/agent/entrypoint.sh` and `docker/moderator/entrypoint.sh`:

```bash
if [ -n "${GH_TOKEN:-}" ]; then
  # Defect 1 fix — capture token, unset GH_TOKEN, THEN pipe to gh.
  _token="$GH_TOKEN"
  unset GH_TOKEN
  echo "$_token" | gh auth login --with-token
  unset _token

  # Defect 2 fix — redirect git's global config to a writable tmpfs path
  # before gh auth setup-git tries to write the credential helper.
  mkdir -p /home/quorum/.config/git
  export GIT_CONFIG_GLOBAL=/home/quorum/.config/git/config
  gh auth setup-git

  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — git operations requiring auth will fail" >&2
fi
```

### Why this is safe (Defect 1)

- `_token` is a shell-local variable, never exported — it does not propagate to any subprocess except the explicit `echo "$_token" | gh …` pipeline.
- `unset GH_TOKEN` happens before any subprocess sees the env, so the SDK env allowlist (`claude-code.service.ts:103`) becomes a defense-in-depth measure rather than the only barrier.
- The `echo … |` pipe uses bash's builtin `echo`, so the token never appears in `ps -ef` argv listings.

### Why this is correct (Defect 2)

`GIT_CONFIG_GLOBAL` is git's documented override for the global-config path — it's the same mechanism the XDG-base-dir spec uses (`$XDG_CONFIG_HOME/git/config`). When set, `git config --global ...` writes there instead of `~/.gitconfig`. `gh auth setup-git` inherits the env and respects the override transparently — no gh-specific configuration needed.

The chosen path `/home/quorum/.config/git/config` lives on the existing `/home/quorum/.config` tmpfs (already declared in `x-base-security`). No `docker-compose.yml` change is required.

`export` propagates `GIT_CONFIG_GLOBAL` to all descendant processes:
- Agent: NestJS process (PID 1 after `exec node dist/main.js`) inherits it, so `InvocationHandler` git operations use the same credential helper. SDK subprocess inherits the env from NestJS, but it doesn't need git (the env allowlist will be tightened in #11/#12 anyway).
- Moderator: PID 1 is `tail -f /dev/null`, but its env persists on the container. `docker compose exec moderator claude` inherits container env, so the CC CLI session sees `GIT_CONFIG_GLOBAL` and any `git`/`gh` operations during the user session pick up the credential helper.

### Security model — unchanged

- Credential persistence still happens at `~/.config/gh/hosts.yml` (tmpfs on agents, tmpfs on moderator per current `x-base-security`).
- Read-only rootfs is preserved; we use an already-declared tmpfs mount.
- Env allowlist (#15) and credential-path deny rules (#15) still apply.

## Acceptance Criteria

1. `docker/agent/entrypoint.sh` captures `GH_TOKEN` into a local variable, unsets `GH_TOKEN`, then pipes the saved value into `gh auth login --with-token`; the local variable is unset after the pipeline. *(Defect 1)*
2. `docker/moderator/entrypoint.sh` applies the same pattern. *(Defect 1)*
3. Both entrypoints `mkdir -p /home/quorum/.config/git` and `export GIT_CONFIG_GLOBAL=/home/quorum/.config/git/config` before calling `gh auth setup-git`. *(Defect 2)*
4. `./scripts/start.sh` against staging brings all three agents + moderator + mcp-server up; `docker ps` shows no `Exited (1)` rows for quorum services.
5. Inside a running agent container, `gh auth status` reports the PAT user as logged in to `github.com`, and `printenv GH_TOKEN` produces an empty line (env var is gone).
6. Inside the running moderator container, `gh auth status` reports the same, and the existing MCP self-verify (`claude mcp list | grep quorum:`) at `docker/moderator/entrypoint.sh:93` still passes.
7. Inside a running container, `git config --global --get credential.https://github.com.helper` returns the gh helper string (confirms `gh auth setup-git` wrote successfully to the tmpfs path).
8. No changes outside the two `entrypoint.sh` files — `Dockerfile`, `docker-compose.yml`, `settings.json`, and the SDK env allowlist are not touched.

## Notes

- Both fixes are shell-bootstrap defects, not security regressions — the env allowlist and credential-path deny rules from #15 still apply.
- The fix does not invalidate the #15 security review; it only enforces the assumption "the entrypoint actually runs to completion."
- Once merged into `8-workspace-isolation-staging`, this unblocks #11 (worktrees), #12 (handler commit/push), #13 (branch-in-flight guard), and #14 (moderator git client). No other tickets are affected.
- `GIT_CONFIG_GLOBAL` is not currently in the SDK env allowlist; that's intentional — the SDK subprocess does not perform git operations (handler-controlled per #12 design). If a future ticket exposes git to the SDK subprocess, the allowlist will need updating then.
