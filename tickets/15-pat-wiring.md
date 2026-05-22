# #15: PAT Wiring and SDK Environment Filtering

## Summary

Harden the agent SDK subprocess environment and bootstrap `gh` CLI auth for the moderator. Ticket #20 already wired `GH_TOKEN` into `docker-compose.yml` and `.env.example` and installed the `gh` CLI — this ticket addresses the **residual scope**: replacing the agent-side `...process.env` spread with an env-var allowlist that excludes secrets, running `gh auth login` in the moderator entrypoint so the CC CLI session doesn't need the raw token, and adding tool-guard deny rules to prevent the model from reading the persisted gh credential file.

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
# Authenticate gh CLI with the PAT, then strip the raw token from the env
# so the CC CLI session cannot exfiltrate it via $GH_TOKEN. The token
# persists on disk at ~/.config/gh/hosts.yml (moderator-claude-data volume).
if [ -n "${GH_TOKEN:-}" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token
  unset GH_TOKEN
  echo "gh auth: logged in and GH_TOKEN unset from env"
else
  echo "WARN: GH_TOKEN not set — gh CLI will not be authenticated" >&2
fi
```

**Design notes:**
- The `if [ -n "${GH_TOKEN:-}" ]` guard handles the case where GH_TOKEN is unset (e.g., local dev without GitHub access).
- `unset GH_TOKEN` removes it from the shell env; subsequent `exec tail -f /dev/null` inherits the cleaned env, and when the user attaches via `docker compose exec -it moderator claude`, the CC CLI session also inherits the cleaned env.
- The token persists at `~/.config/gh/hosts.yml` on the `moderator-claude-data` named volume, so it survives container restarts without needing `GH_TOKEN` again (until the PAT expires/rotates).
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

### 4. Files that require NO changes

These were already handled by ticket #20 and must NOT be modified:

- `docker-compose.yml` — `GH_TOKEN` is already in moderator env block (line 172) and `x-shared-env` (line 9)
- `.env.example` — `GH_TOKEN` entry already present
- `Dockerfile` — `gh` CLI 2.92.0+ already installed in both stages

## Acceptance Criteria

- [ ] **SDK env allowlist implemented:** `claude-code.service.ts` uses an allowlist (not `...process.env`) to construct the `env` option for the SDK `query()` call. The allowlist is defined as a named constant, not inline.
- [ ] **GH_TOKEN excluded from SDK subprocess:** With `GH_TOKEN` set in the NestJS process env, `callArgs.options.env.GH_TOKEN` is `undefined` in the test suite. A new test case explicitly verifies this security property.
- [ ] **NestJS-internal vars excluded from SDK subprocess:** `MCP_SERVER_URL`, `AGENT_ROLE`, `AGENT_CALLBACK_URL`, `LOG_LEVEL`, `LOG_JSON_DIR` are not present in the SDK env. At least one of these is asserted in a test.
- [ ] **Allowlisted vars forwarded correctly:** `HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LANG`, git identity vars — all present in SDK env when set in host process. Existing test assertions for `PATH` and `ANTHROPIC_API_KEY` still pass.
- [ ] **Moderator gh auth bootstrap:** `docker/moderator/entrypoint.sh` runs `gh auth login --with-token` from `$GH_TOKEN` and then `unset GH_TOKEN` before the CC CLI session starts. Guarded by `[ -n "${GH_TOKEN:-}" ]` so missing token doesn't abort startup.
- [ ] **Moderator credential path deny rules:** `docker/moderator/settings.json` includes deny patterns that block `Read` and `Bash` access to `~/.config/gh/**` paths. Existing deny rules (`Write`, `Edit`, `NotebookEdit`) are preserved.
- [ ] **No changes to docker-compose.yml or .env.example:** These files are untouched (already complete from #20).
- [ ] **Build/lint/test pass:** `npm run build`, `npm run lint`, and `npm run test` all pass with zero errors and zero warnings.

## Dependencies and References

### Dependencies

- **Depends on (already met):** #20 (PR-based workflow bootstrap) — delivered `GH_TOKEN` Docker Compose wiring, `.env.example` entry, and `gh` CLI installation. Merged to staging.
- **Depends on (already met):** #10 (FileSessionStore) — no direct dependency, but #10 closed before #15 starts, keeping the sequential flow.

### Blocks

- **#11 (Worktree Per Invocation)** — clone/fetch operations need git auth from the NestJS process env (`GH_TOKEN` available to the handler).
- **#12 (Handler Commit/Push)** — push auth requires `GH_TOKEN` in the handler's env.
- **#14 (Moderator Becomes Standalone Git Client)** — moderator needs `gh` auth (from the entrypoint bootstrap) for clone and PR operations.

### References

- **Epic D5:** `tickets/8-workspace-isolation.md` § "D5: Fine-Grained PAT, Env-Filtered from SDK Subprocess" — the design decision this ticket implements
- **Ticket #20 overlap analysis:** `tickets/20-pr-based-workflow-bootstrap.md` § "QRM8 Roadmap Audit" → Impact Analysis item 1
- `apps/agent/src/llm/claude-code.service.ts` — SDK subprocess env composition (lines 105-108)
- `apps/agent/src/llm/claude-code.service.spec.ts` — existing env assertions (lines 339-345)
- `docker/moderator/entrypoint.sh` — moderator startup script (insert gh auth block)
- `docker/moderator/settings.json` — moderator CC CLI deny rules
