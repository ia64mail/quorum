# #27: Fix gh auth ordering — GH_TOKEN must be unset before piping to gh in entrypoints

## Problem

After merging #15 (PAT wiring) into `8-workspace-isolation-staging`, `./scripts/start.sh` brings the whole system down. The mcp-server container stays healthy because its entrypoint did not change, but every container that runs the new `gh auth login --with-token` bootstrap — `architect`, `developer`, `teamlead`, `qa`, and `moderator` — exits with code `1` within seconds of starting.

`docker logs quorum-architect-1` (and the same for the other four):

```
The value of the GH_TOKEN environment variable is being used for authentication.
To have GitHub CLI store credentials instead, first clear the value from the environment.
```

The system is fully blocked: no agent connects to the broker, the moderator session cannot be attached, and every downstream QRM8 ticket (#11, #12, #13, #14) that depends on a runnable staging environment is gated on this fix.

## Root Cause

Both `docker/agent/entrypoint.sh:9-16` and `docker/moderator/entrypoint.sh:39-46` use this pattern:

```bash
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token   # ← runs while GH_TOKEN is still in env
  gh auth setup-git
  unset GH_TOKEN                                   # ← too late
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
fi
```

`gh` refuses to persist credentials to `~/.config/gh/hosts.yml` when `GH_TOKEN` is set in the environment — it treats the env var as the authoritative credential source and considers a written hosts.yml redundant and ambiguous. In that state, `gh auth login --with-token` prints the warning above and exits non-zero.

`set -euo pipefail` at the top of both scripts then aborts the entrypoint. The container exits with code `1` before `node dist/main.js` (agent) or `tail -f /dev/null` (moderator) is ever reached.

The pre-merge security review of #15 flagged a nearby concern ("invalid `GH_TOKEN` aborts startup") but identified the wrong trigger — the abort fires for **any** `GH_TOKEN` value, not just invalid ones, because the ordering of `unset GH_TOKEN` relative to `gh auth login --with-token` is wrong regardless of token validity.

## Design

Capture the token into a local shell variable, `unset GH_TOKEN` from the environment, **then** pipe the saved value into `gh auth login --with-token`. After `gh` finishes, scrub the local variable too so neither the env nor any subsequent shell expansion exposes the token.

Identical fix in both entrypoints:

```bash
if [ -n "${GH_TOKEN:-}" ]; then
  _token="$GH_TOKEN"
  unset GH_TOKEN                                # clear env before gh sees it
  echo "$_token" | gh auth login --with-token
  unset _token                                  # scrub local var
  gh auth setup-git
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — git operations requiring auth will fail" >&2
fi
```

Why this is safe:
- `_token` is a shell-local variable, never exported — it does not propagate to any subprocess except the explicit `echo "$_token" | gh …` pipeline.
- `unset GH_TOKEN` happens before any subprocess sees the env, so the SDK env allowlist (`claude-code.service.ts:103`) becomes a defense-in-depth measure rather than the only barrier.
- The `echo … |` pipe uses bash's builtin `echo`, so the token never appears in `ps -ef` argv listings.

No change to the security model from #15 — the credential still persists at `~/.config/gh/hosts.yml` (tmpfs on agents, named volume on moderator), and the gh credential helper still authenticates git operations transparently.

## Acceptance Criteria

1. `docker/agent/entrypoint.sh` captures `GH_TOKEN` into a local variable, unsets `GH_TOKEN`, then pipes the saved value into `gh auth login --with-token`; the local variable is unset after the pipeline.
2. `docker/moderator/entrypoint.sh` applies the same pattern.
3. `./scripts/start.sh` against staging brings all four agents + moderator + mcp-server up; `docker ps` shows no `Exited (1)` rows for quorum services.
4. Inside a running agent container, `gh auth status` reports the PAT user as logged in to `github.com`, and `printenv GH_TOKEN` produces an empty line (env var is gone).
5. Inside the running moderator container, `gh auth status` reports the same, and the existing MCP self-verify (`claude mcp list | grep quorum:`) at `docker/moderator/entrypoint.sh:93` still passes.
6. No changes outside the two `entrypoint.sh` files — `Dockerfile`, `docker-compose.yml`, `settings.json`, and the SDK env allowlist are not touched.

## Notes

- This is a shell-ordering bug, not a security regression — the env allowlist and credential-path deny rules from #15 still apply.
- The fix does not invalidate the #15 security review: the only assumption that changed is "the entrypoint actually runs to completion."
- Once merged into `8-workspace-isolation-staging`, this unblocks #11 (worktrees), #12 (handler commit/push), #13 (branch-in-flight guard), and #14 (moderator git client). No other tickets are affected.