# #15: PAT Wiring and SDK Environment Filtering

## Summary

Harden the agent SDK subprocess environment, bootstrap `gh` CLI auth for both moderator and agent containers, and configure git credential helpers so handler-level git operations (clone, fetch, push) authenticate without exposing the raw token. Ticket #20 already wired `GH_TOKEN` into `docker-compose.yml` and `.env.example` and installed the `gh` CLI — this ticket addresses the **residual scope**: replacing the agent-side `...process.env` spread with an env-var allowlist that excludes secrets, creating an agent entrypoint that runs `gh auth login` + `gh auth setup-git` and then strips the raw token from the env, running the same auth bootstrap in the moderator entrypoint, and adding tool-guard deny rules to prevent the model from reading the persisted gh credential file.

## Problem Statement

### Agent-side env leak

`apps/agent/src/llm/claude-code.service.ts` line 105-108 passes the SDK subprocess its environment via:

```typescript
env: {
  ...process.env,
  ANTHROPIC_API_KEY: this.config.anthropic.apiKey,
},
```

This spreads **every env var** from the NestJS host process into the Claude Code subprocess — including `GH_TOKEN`, `ANTHROPIC_API_KEY` (the raw env version), `MCP_SERVER_URL`, `AGENT_CALLBACK_URL`, and all other Docker Compose env vars. The model running inside the SDK subprocess can read any of these via `printenv`, `echo $GH_TOKEN`, or `cat /proc/self/environ`. Once visible, the token could be exfiltrated through tool calls (e.g., `curl` to an external endpoint, embedding the token in a commit message, or storing it in context).

The fix is an **allowlist**: explicitly enumerate the env vars the CC CLI subprocess needs to function, and exclude everything else.

### Moderator gh auth gap

The moderator container receives `GH_TOKEN` in its environment (wired by #20). Currently, `gh` CLI operations work because `gh` reads `GH_TOKEN` from the environment automatically. However, this means the raw token is visible to the CC CLI session — `echo $GH_TOKEN` inside the moderator's Claude Code session would print it. The model could exfiltrate this token the same way an agent could.

The fix: run `gh auth login --with-token` in `entrypoint.sh` to persist the token to `~/.config/gh/hosts.yml` on the named volume, then `unset GH_TOKEN` before the CC CLI starts. After this, `gh` CLI operations still work (gh reads the persisted credential file), but the raw token is not in the shell environment.

**Residual risk:** The model can still `cat ~/.config/gh/hosts.yml` to read the persisted token. This is mitigated by adding deny rules to `settings.json` that block Read and Bash access to `~/.config/gh/**`.

### Agent-side git auth gap

`GH_TOKEN` is present in the NestJS process env (via `x-shared-env` in docker-compose.yml), but **git does not read `GH_TOKEN` automatically** for HTTPS operations. When #11 runs `git clone` in the agent container entrypoint and #12 runs `git push` from `InvocationHandler`, those commands have no credential source unless one of the following is configured:

1. `gh auth login --with-token` + `gh auth setup-git` — configures git's credential helper to delegate to gh, which manages the token
2. A `~/.git-credentials` file with `https://x-access-token:$GH_TOKEN@github.com`
3. Token-in-URL per command (e.g., `git clone https://x-access-token:$GH_TOKEN@github.com/...`) — leaks into reflog

Option 1 is the cleanest: it parallels the moderator pattern, stores the credential once, and lets every git command authenticate transparently through the credential helper. After `gh auth setup-git`, the agent container can `unset GH_TOKEN` — the NestJS process never sees the raw token, and the handler's git operations work via the credential helper.

Currently, agents have no entrypoint script — the Dockerfile agent stage uses a bare `CMD` (line 97: `CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]`). This ticket creates a proper `docker/agent/entrypoint.sh` with the auth bootstrap. Ticket #11 will extend this entrypoint with `git clone` initialization.

### What #20 already delivered

Per ticket #20's "QRM8 Roadmap Audit" (Impact Analysis item 1), the following are **already done** and require NO changes in this ticket:

- `docker-compose.yml`: `GH_TOKEN: ${GH_TOKEN}` in moderator env block and `x-shared-env` anchor
- `.env.example`: `GH_TOKEN` entry with explanatory comment
- `Dockerfile`: `gh` CLI 2.92.0+ installed in both agent and moderator stages

## Implementation Details

### 1. SDK env allowlist (`apps/agent/src/llm/claude-code.service.ts`)

Replace the `...process.env` spread (lines 105-108) with an allowlist-based approach.

**Allowlist vars** — these are the env vars the CC CLI subprocess legitimately needs:

| Category | Vars | Rationale |
|----------|------|-----------|
| System essentials | `HOME`, `PATH`, `USER`, `SHELL`, `HOSTNAME` | File paths, binary lookup, user identity, shell for Bash tool, container identity |
| Locale & terminal | `TERM`, `LANG`, `LC_ALL` | Terminal output formatting, text processing locale |
| Runtime | `NODE_ENV`, `TMPDIR`, `TZ` | Runtime mode, temp directory, timezone |
| Git identity | `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Commit attribution (pre-#12, the SDK subprocess still does `git commit`; #12 may narrow this) |

**Explicitly excluded** (these are in `process.env` but must NOT reach the subprocess):

| Var | Why excluded |
|-----|-------------|
| `GH_TOKEN` | Primary security target — GitHub PAT |
| `ANTHROPIC_API_KEY` | Raw key from env; the SDK gets its own from `this.config.anthropic.apiKey` |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS` | NestJS config; model is set explicitly via SDK options |
| `MCP_SERVER_URL`, `MCP_REQUEST_TIMEOUT_MS` | NestJS app config, not needed by CC CLI |
| `AGENT_ROLE`, `AGENT_CALLBACK_URL`, `PORT` | NestJS service identity |
| `LOG_JSON_DIR`, `LOG_LEVEL` | NestJS logging config |
| `npm_config_cache` | npm cache dir |

**Implementation approach:** Define a constant `SDK_ENV_ALLOWLIST` array at module scope in `claude-code.service.ts`, then use a helper function to pick only those keys from `process.env`:

```typescript
const SDK_ENV_ALLOWLIST: readonly string[] = [
  'HOME', 'PATH', 'USER', 'SHELL', 'HOSTNAME',
  'TERM', 'LANG', 'LC_ALL',
  'NODE_ENV', 'TMPDIR', 'TZ',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
] as const;

function buildSdkEnv(allowlist: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}
```

Then in the `query()` call options:

```typescript
env: {
  ...buildSdkEnv(SDK_ENV_ALLOWLIST),
  ANTHROPIC_API_KEY: this.config.anthropic.apiKey,
},
```

`ANTHROPIC_API_KEY` is set explicitly from config (not from `process.env`), so it remains unchanged. The spread of `buildSdkEnv(...)` replaces the spread of `process.env`.

**Test updates** in `claude-code.service.spec.ts`:
- The existing assertion at line 339-343 checks `env` contains `ANTHROPIC_API_KEY` and `PATH` — both should still pass (PATH is allowlisted, ANTHROPIC_API_KEY is explicitly set).
- Add a **new assertion**: set `process.env.GH_TOKEN = 'test-token'` in the test setup, then verify `callArgs.options.env` does NOT have `GH_TOKEN`. This is the critical security property.
- Add a new assertion: verify that NestJS-specific env vars (`AGENT_ROLE`, `MCP_SERVER_URL`, etc.) are not present in the SDK env.

### 2. Moderator entrypoint gh auth bootstrap (`docker/moderator/entrypoint.sh`)

Insert the following block **after** the config merge/symlink section (after line 33, the `ln -sf` for quorum.md) and **before** the CC CLI self-verify section (before line 76, the `claude mcp list` check). The gh auth must happen before any `gh`/`claude` commands but after `jq` config merges are complete.

```bash
# Authenticate gh CLI with the PAT and configure git's credential helper,
# then strip the raw token from the env so the CC CLI session cannot
# exfiltrate it via $GH_TOKEN. The token persists on disk at
# ~/.config/gh/hosts.yml (tmpfs — re-created on each container start).
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token
  gh auth setup-git          # configures git credential helper → gh
  unset GH_TOKEN
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — gh CLI will not be authenticated" >&2
fi
```

**Design notes:**
- The `if [ -n "${GH_TOKEN:-}" ]` guard handles the case where GH_TOKEN is unset (e.g., local dev without GitHub access).
- `unset GH_TOKEN` removes it from the shell env; subsequent `exec tail -f /dev/null` inherits the cleaned env, and when the user attaches via `docker compose exec -it moderator claude`, the CC CLI session also inherits the cleaned env.
- The token persists at `~/.config/gh/hosts.yml`. Note: `/home/quorum/.config` is a **tmpfs** (from `x-base-security`), not the `moderator-claude-data` named volume — credentials are re-created from `GH_TOKEN` on every container start, which is the correct behavior (always uses the current PAT). The epic D5 description ("on the `moderator-claude-data` volume") is slightly inaccurate on this point.
- The echo confirms to `docker compose logs` that auth succeeded.

### 3. Moderator settings.json deny rules (`docker/moderator/settings.json`)

Add deny rules to prevent the model from reading the persisted gh credential file at `~/.config/gh/hosts.yml`. The current deny list:

```json
"deny": ["Write", "Edit", "NotebookEdit"]
```

Becomes:

```json
"deny": [
  "Write",
  "Edit",
  "NotebookEdit",
  "Read(/home/quorum/.config/gh/**)",
  "Bash(cat /home/quorum/.config/gh/*)",
  "Bash(cat ~/.config/gh/*)",
  "Bash(head /home/quorum/.config/gh/*)",
  "Bash(head ~/.config/gh/*)",
  "Bash(less /home/quorum/.config/gh/*)",
  "Bash(less ~/.config/gh/*)"
]
```

**Design rationale:** CC CLI deny rules use `ToolName(pattern)` glob matching against tool arguments. The `Read(...)` pattern covers the Read tool's file path argument. The `Bash(...)` patterns cover common file-reading commands with both absolute and tilde-expanded paths. This is defense-in-depth — the primary protection is `unset GH_TOKEN` in the entrypoint; the deny rules catch the residual risk of reading the persisted credential file.

**Note for the developer:** Verify the exact glob matching semantics during implementation. If CC CLI supports broader patterns (e.g., `Bash(*/.config/gh*)` matching any command containing the path), prefer fewer broad patterns over many narrow ones. The patterns above are conservative — they may need adjustment based on CC CLI's actual matching behavior.

### 4. Agent entrypoint with gh auth bootstrap

Create `docker/agent/entrypoint.sh` to replace the bare `CMD` in the Dockerfile agent stage (line 97). This script mirrors the moderator's auth pattern and gives #11 a clean extension point for `git clone` initialization.

**Script contents:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Authenticate gh CLI with the PAT and configure git's credential helper,
# then strip the raw token from the env so the NestJS process (and by
# extension the SDK subprocess) never sees it. The credential persists at
# ~/.config/gh/hosts.yml on tmpfs — re-created from GH_TOKEN on every
# container start.
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token
  gh auth setup-git          # configures git credential helper → gh
  unset GH_TOKEN
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — git operations requiring auth will fail" >&2
fi

# Preserve the original CMD behavior (create debug dir on tmpfs)
mkdir -p /home/quorum/.claude/debug

exec node dist/main.js
```

**Dockerfile changes** (agent stage, around line 91-97):

```dockerfile
# Bake the agent entrypoint (gh auth bootstrap).
COPY --chown=quorum:quorum docker/agent/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER quorum

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

This replaces the current `CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]` at line 97. The `mkdir` and `exec node` move into the entrypoint script.

**Design notes:**

- `gh auth setup-git` is the critical addition vs. the moderator pattern. It configures git's credential helper to delegate to gh — after this, `git clone`, `git fetch`, `git push` all authenticate via gh's persisted credential without needing `GH_TOKEN` in the environment.
- `unset GH_TOKEN` means the NestJS process starts with `GH_TOKEN` absent from `process.env`. This is **defense layer 1** — the env allowlist (§1) is defense layer 2. Even if the entrypoint auth fails and `unset` doesn't run, the allowlist still blocks `GH_TOKEN` from reaching the SDK subprocess.
- Agent `~/.config` is tmpfs (from `x-agent-security`), so credentials are wiped on container restart and re-created from the `GH_TOKEN` env var on next start. This is correct behavior — always uses the current PAT.
- #11 will extend this entrypoint by inserting `git clone` initialization between the auth block and the `exec node` line.

**Moderator entrypoint update:** Also add `gh auth setup-git` to the moderator's auth block (§2 above) — the moderator's `entrypoint.sh` currently doesn't configure the credential helper for git, relying on `GH_TOKEN` env for `gh`-mediated operations. With the raw token unset, direct `git push`/`git fetch` commands (which #14 will add) need the credential helper too.

### 5. Files that require NO changes

These were already handled by ticket #20 and must NOT be modified:

- `docker-compose.yml` — `GH_TOKEN` is already in moderator env block (line 172) and `x-shared-env` (line 9)
- `.env.example` — `GH_TOKEN` entry already present

**Note:** The Dockerfile agent stage IS modified by this ticket (COPY + ENTRYPOINT for the new entrypoint script). The `gh` CLI installation itself remains unchanged (#20 handled that).

## Acceptance Criteria

- [x] **SDK env allowlist implemented:** `claude-code.service.ts` uses an allowlist (not `...process.env`) to construct the `env` option for the SDK `query()` call. The allowlist is defined as a named constant, not inline.
- [x] **GH_TOKEN excluded from SDK subprocess:** With `GH_TOKEN` set in the NestJS process env, `callArgs.options.env.GH_TOKEN` is `undefined` in the test suite. A new test case explicitly verifies this security property.
- [x] **NestJS-internal vars excluded from SDK subprocess:** `MCP_SERVER_URL`, `AGENT_ROLE`, `AGENT_CALLBACK_URL`, `LOG_LEVEL`, `LOG_JSON_DIR` are not present in the SDK env. At least one of these is asserted in a test.
- [x] **Allowlisted vars forwarded correctly:** `HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LANG`, git identity vars — all present in SDK env when set in host process. Existing test assertions for `PATH` and `ANTHROPIC_API_KEY` still pass.
- [x] **Moderator gh auth bootstrap:** `docker/moderator/entrypoint.sh` runs `gh auth login --with-token` from `$GH_TOKEN` and then `unset GH_TOKEN` before the CC CLI session starts. Guarded by `[ -n "${GH_TOKEN:-}" ]` so missing token doesn't abort startup.
- [x] **Moderator credential path deny rules:** `docker/moderator/settings.json` includes deny patterns that block `Read` and `Bash` access to `~/.config/gh/**` paths. Existing deny rules (`Write`, `Edit`, `NotebookEdit`) are preserved.
- [x] **Agent entrypoint created:** `docker/agent/entrypoint.sh` exists and runs `gh auth login --with-token` + `gh auth setup-git` + `unset GH_TOKEN` before `exec node dist/main.js`. Guarded by `[ -n "${GH_TOKEN:-}" ]`.
- [x] **Dockerfile agent stage updated:** Agent stage uses `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` instead of the bare `CMD`. The old `mkdir -p /home/quorum/.claude/debug` logic is preserved inside the entrypoint script.
- [x] **Git credential helper configured:** After agent container startup, `git config --global credential.helper` reports the gh-managed helper (verifiable via `docker exec`). Direct `git ls-remote https://github.com/ia64mail/quorum.git` succeeds inside the container.
- [x] **Moderator also runs `gh auth setup-git`:** The moderator entrypoint's auth block includes `gh auth setup-git` so direct git commands (not just `gh` commands) authenticate via the credential helper.
- [x] **No changes to docker-compose.yml or .env.example:** These files are untouched (already complete from #20).
- [x] **Build/lint/test pass:** `npm run build`, `npm run lint`, and `npm run test` all pass with zero errors and zero warnings.

## Implementation Notes

**Status:** Accepted

**Date:** 2026-05-22

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/agent/src/llm/claude-code.service.ts` | Modified | Added `SDK_ENV_ALLOWLIST` constant and `buildSdkEnv()` helper; replaced `...process.env` spread with filtered env composition |
| `apps/agent/src/llm/claude-code.service.spec.ts` | Modified | Added 3 new tests (5a: GH_TOKEN exclusion, 5b: NestJS-internal var exclusion, 5c: allowlisted var forwarding) |
| `docker/moderator/entrypoint.sh` | Modified | Inserted gh auth bootstrap block (login + setup-git + unset) after config merge, before claude mcp list self-verify |
| `docker/moderator/settings.json` | Modified | Expanded deny list with 7 credential-path deny patterns (1 Read + 6 Bash variants) |
| `docker/agent/entrypoint.sh` | Created | Agent entrypoint with gh auth bootstrap + mkdir + exec node |
| `Dockerfile` | Modified | Agent stage: added COPY + chmod for entrypoint, replaced bare CMD with ENTRYPOINT |
| `tickets/8-workspace-isolation.md` | Modified | Updated D5/D11/D12 descriptions to reference agent entrypoint created by #15 |

### Deviations from Ticket Spec

- None. Implementation matches ticket spec verbatim across all four components.

### Verification

- `npm run build` — compiles successfully (webpack compiled, all 3 apps)
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 784 tests passing (3 new + 781 existing), 46 suites, 0 failures
- Scope discipline confirmed: zero diff on `docker-compose.yml` and `.env.example`
- Dockerfile changes confined to agent stage only (lines 92-101)

### Review

PR #26 — raw skill output + verdict summary posted as review comments. Accepted with no high-confidence issues.

## Dependencies and References

### Dependencies

- **Depends on (already met):** #20 (PR-based workflow bootstrap) — delivered `GH_TOKEN` Docker Compose wiring, `.env.example` entry, and `gh` CLI installation. Merged to staging.
- **Depends on (already met):** #10 (FileSessionStore) — no direct dependency, but #10 closed before #15 starts, keeping the sequential flow.

### Blocks

- **#11 (Worktree Per Invocation)** — clone/fetch operations authenticate via the gh credential helper configured by this ticket's agent entrypoint. #11 extends the entrypoint with `git clone` initialization — it does not need to handle auth.
- **#12 (Handler Commit/Push)** — `git push` from `InvocationHandler` authenticates via the credential helper. The handler does NOT need to read `GH_TOKEN` directly — `gh auth setup-git` bridges git↔gh transparently.
- **#14 (Moderator Becomes Standalone Git Client)** — moderator's `git clone`/`git push` authenticate via the credential helper configured by this ticket's moderator entrypoint update (`gh auth setup-git`). #14 adds the clone logic — it does not need to handle auth.

### References

- **Epic D5:** `tickets/8-workspace-isolation.md` § "D5: Fine-Grained PAT, Env-Filtered from SDK Subprocess" — the design decision this ticket implements
- **Ticket #20 overlap analysis:** `tickets/20-pr-based-workflow-bootstrap.md` § "QRM8 Roadmap Audit" → Impact Analysis item 1
- `apps/agent/src/llm/claude-code.service.ts` — SDK subprocess env composition (lines 105-108)
- `apps/agent/src/llm/claude-code.service.spec.ts` — existing env assertions (lines 339-345)
- `docker/moderator/entrypoint.sh` — moderator startup script (insert gh auth + setup-git block)
- `docker/moderator/settings.json` — moderator CC CLI deny rules
- `Dockerfile` — agent stage line 97 (current bare CMD → ENTRYPOINT), moderator stage line 148 (existing ENTRYPOINT)
- `docker/agent/entrypoint.sh` — new file: agent gh auth bootstrap + credential helper config
