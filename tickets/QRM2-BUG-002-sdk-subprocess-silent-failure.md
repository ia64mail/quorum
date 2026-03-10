# QRM2-BUG-002: Claude Code SDK Subprocess Silent Failure

**Status: Resolved**

## Summary

After resolving all three spawn/permission issues in QRM2-BUG-001, the Claude Code SDK subprocess starts but produces **zero messages** before the async generator exhausts. The SDK's `query()` generator completes silently — no `init`, no `assistant`, no `result`, no error. Invocations fail with "Generator completed without a result message" after ~31 seconds, costing $0.00 (no API call made).

## Problem Statement

With BUG-001 fixes applied (env spread, debug directory, tmpfs ownership), containers start cleanly and the SDK subprocess spawns without ENOENT or permission errors. However, every invocation produces:

```
[InvocationHandler] Invocation received: correlationId=8d565945-... action="Say hello to confirm you're available and ready to work" caller=moderator depth=0
[ClaudeCodeService] SDK env check: HOME=/home/quorum PATH=present ANTHROPIC_API_KEY=sk-ant-api... cwd=/mnt/quorum/workspace model=claude-sonnet-4-5-20250929
[ClaudeCodeService] SDK generator exhausted after 0 messages and 31591ms
[InvocationHandler] Invocation failed: correlationId=8d565945-... error="Generator completed without a result message" cost=$0.0000 duration=31592ms
```

Key observations:
- **0 messages yielded** — not even a `system/init` message
- **~31 seconds duration** — consistent across all attempts, suggests a timeout
- **$0.00 cost** — no Anthropic API call was made
- **Env is correct** — HOME, PATH, ANTHROPIC_API_KEY all verified present
- **Reproducible** across all agent roles (architect, teamlead, developer)

This is a **blocking bug** — agents start and register successfully but cannot process any invocation.

## Root Cause Analysis

Two issues combined to produce the silent failure:

### 1. `~/.claude.json` write blocked by read-only filesystem (primary)

The CLI subprocess writes a config file to `/home/quorum/.claude.json` (in the home directory root — **not** inside `~/.claude/`). The container's `read_only: true` filesystem blocked this write with EROFS. The CLI's fallback chain (atomic write → non-atomic write) also failed, and the CLI then hung for ~30 seconds waiting on "Remote settings" and "Policy limits" loading promises before timing out and exiting silently.

From the SDK debug log (`/tmp/sdk-debug.log`):
```
[ERROR] Failed to write file atomically: Error: EROFS: read-only file system, open '/home/quorum/.claude.json.tmp.20.1773102288420'
[DEBUG] Falling back to non-atomic write for /home/quorum/.claude.json
[DEBUG] Non-atomic write also failed: Error: EROFS: read-only file system, open '/home/quorum/.claude.json'
...
[DEBUG] Remote settings: Loading promise timed out, resolving anyway    ← 30s later
[DEBUG] Policy limits: Loading promise timed out, resolving anyway
```

**Fix:** Build-time symlink in `Dockerfile`: `ln -s /tmp/.claude.json /home/quorum/.claude.json` — the CLI writes through the symlink to tmpfs.

### 2. Missing writable XDG directories (preventive)

The container only provided tmpfs at `/tmp` and `/home/quorum/.claude`. The CLI may also need standard XDG base directories:

- `~/.config/` — CLI configuration and settings cache
- `~/.local/` — local data and state files
- `~/.cache/` — runtime caches

Added as tmpfs mounts to prevent similar EROFS failures in other code paths.

### 2. Subprocess stderr was swallowed (observability)

The SDK's `query()` accepts a `stderr` callback option, but we weren't using it. All error output from the CLI subprocess (including the EROFS write failures and any diagnostic messages) was discarded. The SDK also supports `debugFile` for detailed initialization logging — also unused.

Without stderr capture, the only observable symptom was the ~31s timeout (the CLI's internal initialization timeout before it gives up and exits) and 0 messages.

### What was ruled out

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Missing `PATH` in subprocess env | Ruled out | Diagnostic log confirms `PATH=present` |
| Missing `ANTHROPIC_API_KEY` | Ruled out | Diagnostic log confirms key prefix `sk-ant-api...` |
| Wrong `HOME` directory | Ruled out | Diagnostic log confirms `HOME=/home/quorum` |
| Debug directory crash | Ruled out | No ENOENT errors in logs, containers stay running |
| tmpfs permission denied | Ruled out | Containers start cleanly, no permission errors |
| `cap_drop: ALL` blocking TCP | Ruled out | Capabilities not needed for standard TCP/TLS sockets |
| Network/DNS from containers | Ruled out | Docker bridge networking allows outbound by default |

## Changes Made

### 1. `ClaudeCodeService` — stderr capture and debug logging

**File:** `apps/agent/src/llm/claude-code.service.ts`

Added two SDK options to the `query()` call:

```typescript
debugFile: '/tmp/sdk-debug.log',
stderr: (data: string) => {
  this.logger.warn(`[subprocess stderr] ${data.trimEnd()}`);
},
```

- **`stderr` callback**: Captures all error output from the CLI subprocess in real-time and logs it as a warning. This surfaces errors like write failures, DNS issues, or initialization problems that were previously invisible.
- **`debugFile`**: Writes detailed SDK and CLI debug logs to `/tmp/sdk-debug.log` (tmpfs — always writable). Persists across the subprocess lifecycle for post-mortem analysis.
- **Message counter**: Added `messageCount` tracking and explicit error-level logging when the generator exhausts without a result, including elapsed time and message count.

### 2. `docker-compose.yml` — additional writable tmpfs mounts

**File:** `docker-compose.yml` (`x-agent-security` anchor)

Added tmpfs mounts for XDG base directories:

```yaml
tmpfs:
  - /tmp:size=512m,uid=1000,gid=1000
  - /home/quorum/.claude:size=256m,uid=1000,gid=1000
  - /home/quorum/.config:size=64m,uid=1000,gid=1000    # NEW
  - /home/quorum/.local:size=64m,uid=1000,gid=1000     # NEW
  - /home/quorum/.cache:size=128m,uid=1000,gid=1000    # NEW
```

**Security posture preserved:** These are ephemeral tmpfs mounts (RAM-backed, lost on container restart) owned by `quorum:quorum` (uid/gid 1000). They provide the minimum writable surface the CLI needs without relaxing `read_only: true` or `cap_drop: ALL`. The size limits (64m config/local, 128m cache) are conservative — the CLI writes minimal data to these paths.

### 3. `Dockerfile` — symlink `~/.claude.json` to tmpfs

**File:** `Dockerfile` (agent stage)

Added a build-time symlink so the CLI can write its config file on the read-only filesystem:

```dockerfile
ln -s /tmp/.claude.json /home/quorum/.claude.json
```

The symlink is baked into the image. At runtime, writes to `~/.claude.json` go through to `/tmp/.claude.json` on the tmpfs-backed `/tmp`. No security relaxation needed.

### 4. Test updates

**File:** `apps/agent/src/llm/claude-code.service.spec.ts`

Updated the options passthrough test to verify `debugFile` and `stderr` callback are present in the SDK call.

## Container Security Context (updated)

```yaml
# docker-compose.yml — x-agent-security anchor
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
read_only: true
tmpfs:
  - /tmp:size=512m,uid=1000,gid=1000
  - /home/quorum/.claude:size=256m,uid=1000,gid=1000
  - /home/quorum/.config:size=64m,uid=1000,gid=1000
  - /home/quorum/.local:size=64m,uid=1000,gid=1000
  - /home/quorum/.cache:size=128m,uid=1000,gid=1000
```

## Acceptance Criteria

- [x] Root cause identified and documented
- [x] SDK subprocess produces messages (at minimum `system/init`) — stderr/debug capture now surfaces errors; writable XDG paths unblock CLI initialization
- [x] Agents successfully process invocations and return results — CLI can now write to required directories
- [x] Container security posture preserved — tmpfs mounts are ephemeral, read-only root and dropped capabilities unchanged
- [x] `npm run test` passes with no regressions — 382/382 tests passing

## Dependencies and References

### Prerequisites
- QRM2-BUG-001 — SDK Spawn Failure (resolved — env, debug dir, tmpfs ownership)

### What This Blocks
- QRM2-007 — Prompt Adaptation
- QRM2-009 — E2E Integration Smoke Test

### References
- [tickets/QRM2-BUG-001-claude-code-sdk-spawn-failure.md](QRM2-BUG-001-claude-code-sdk-spawn-failure.md) — Prior spawn fixes
- [tickets/QRM2-001-docker-agent-image.md](QRM2-001-docker-agent-image.md) — Container hardening decisions
- Claude Agent SDK `@0.2.63`: `sdk.mjs` subprocess spawn, `cli.js` bundled CLI, `sdk.d.ts` Query type
- SDK options reference: `stderr` callback, `debugFile`, `debug` flag (from `sdk.d.ts` lines 635-1074)
- [tickets/QRM2-BUG-003-container-uid-mismatch.md](QRM2-BUG-003-container-uid-mismatch.md) — Related bind-mount UID mismatch (discovered during this investigation)

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-10

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/agent/src/llm/claude-code.service.ts` | Modified | Added `stderr` callback, `debugFile`, message counter, exhaustion error log |
| `apps/agent/src/llm/claude-code.service.spec.ts` | Modified | Assert `debugFile` and `stderr` in options passthrough test |
| `docker-compose.yml` | Modified | Added `~/.config`, `~/.local`, `~/.cache` tmpfs mounts to agent security anchor |
| `Dockerfile` | Modified | Added `ln -s /tmp/.claude.json /home/quorum/.claude.json` symlink in agent stage |
| `tickets/QRM2-BUG-002-sdk-subprocess-silent-failure.md` | Modified | Root cause documentation, acceptance criteria |
| `tickets/QRM2-BUG-003-container-uid-mismatch.md` | Created | Spin-off bug for host UID mismatch (discovered during log investigation) |

### Verification

- `npm run test` — 382 tests passing (0 new, 382 existing)
- `npm run lint` — 0 errors, 0 warnings
- `docker compose logs architect` — confirmed: session started (`fe8293bc-...`), 1 turn, $0.11, 5.6s
- All three agents (architect, teamlead, developer) start, register, and discover 7 MCP tools