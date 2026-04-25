# Session Resume Investigation

> **Date:** 2026-04-25  
> **SDK Version:** `@anthropic-ai/claude-agent-sdk@0.2.110`  
> **Status:** Root cause identified, fix designed

## Problem

Calling `query()` with `resume: "<sessionId>"` silently starts a fresh session instead of resuming the previous one. No error, no warning — just a new session ID in the `system/init` message.

## Root Cause

The SDK's `query()` function has **two distinct code paths** for resume, gated on whether `sessionStore` is provided:

### Path 1: `resume` + `sessionStore` (works)

```
query({ prompt, options: { resume: id, sessionStore: store } })
```

1. SDK calls `store.load({ projectKey, sessionId })` to get transcript entries
2. Writes entries to a **temp directory** as `<sessionId>.jsonl`
3. Sets `CLAUDE_CONFIG_DIR` to the temp dir
4. Spawns subprocess with `--resume <sessionId>`
5. Subprocess finds the `.jsonl` in the temp dir → **resume succeeds**
6. During the session, new entries are mirrored to `store.append()`

### Path 2: `resume` only, no `sessionStore` (our current code — broken in containers)

```
query({ prompt, options: { resume: id } })
```

1. SDK spawns subprocess with `--resume <sessionId>`
2. Subprocess looks for `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
3. File does not exist (ephemeral container filesystem) → **silently starts fresh**

The subprocess CLI does **not throw** when the session file is missing — it logs a telemetry event (`tengu_session_resumed, success: false, failure_reason: not_found`) and falls through to create a new session. Because no exception reaches the SDK caller, our fallback catch block (lines 32-51 of `claude-code.service.ts`) never engages.

### Why the file is missing

Our agent containers are ephemeral Docker containers. Each invocation may run in a fresh container. The session `.jsonl` files are written to `~/.claude/projects/` inside the container during the session, but this path is on the container's ephemeral filesystem — it does not survive container recreation.

The diagnostic showing "session files ARE being written" was correct: the files exist **during** the session. They just don't persist to the **next** container that tries to resume them.

## Ruling Out Other Hypotheses

| Hypothesis | Status | Evidence |
|---|---|---|
| `settingSources: ['project']` suppresses persistence | **Ruled out** | `settingSources` only controls which `.claude/settings.json` files are loaded. Session persistence is controlled by `persistSession` (default: `true`). |
| `resume` expects a different ID format | **Ruled out** | The `session_id` from `system/init` is a standard UUID. The CLI's `WW7()` validator accepts UUIDs directly. |
| `resume` needs additional config | **Confirmed** | In containerized/ephemeral environments, `resume` needs either a `SessionStore` adapter or persistent storage at the session file path. |
| `cwd` mismatch | **Ruled out** | We pass the same `cwd` (`workspaceDir`) every time. The encoded path is deterministic. |

## The Fix: `SessionStore` Adapter

The SDK provides a `SessionStore` interface specifically for this use case (multi-host, ephemeral containers). The interface has two required methods:

```typescript
type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  // Optional: listSessions, delete, listSubkeys
};

type SessionKey = {
  projectKey: string;  // encoded cwd
  sessionId: string;   // UUID
  subpath?: string;    // e.g. "subagents/agent-<id>"
};
```

### Option A: Shared-volume `FileSessionStore` (recommended)

Write a `SessionStore` that persists to `/mnt/quorum/workspace/.sessions/` (the shared Docker volume). This is the simplest approach:

- `append()` appends JSONL entries to a file keyed by `projectKey/sessionId`
- `load()` reads and returns the entries
- No external dependencies (no Redis/S3/Postgres)
- Storage survives container restarts because the volume is persistent
- Implement `listSubkeys()` for subagent transcript resume

### Option B: `InMemorySessionStore` (testing only)

The SDK ships `InMemorySessionStore` — useful for tests but data is lost when the process exits. Not viable for cross-container resume.

### Option C: Redis/Postgres `SessionStore`

If we later need cross-host resume (e.g., scaling agent containers across nodes), implement against Redis or Postgres. Reference adapters exist at `examples/session-stores/` in the SDK repo.

## Implementation Notes

1. **`sessionStore` + `persistSession: false` is forbidden** — the SDK throws. Keep `persistSession: true` (current setting).

2. **`sessionStore` is not in `.d.ts`** — the type is exported at runtime but not in the TypeScript declarations (alpha API). Use `as any` or augment the module declaration.

3. **Mirror writes are best-effort** — if `append()` fails, the SDK emits a `mirror_error` system message but continues. The local transcript is the source of truth.

4. **`listSubkeys()` enables subagent resume** — without it, only the main transcript is restored on resume.

5. **The fallback catch block is still valuable** — even with `SessionStore`, `load()` could fail. Keep the retry-without-resume logic but add logging to detect when it fires.

6. **The official docs warn about this exact scenario:**
   > "If a resume call returns a fresh session instead of the expected history, the most common cause is a mismatched cwd. Sessions are stored under `~/.claude/projects/<encoded-cwd>/*.jsonl` [...] The session file also needs to exist on the current machine."

## References

- [SDK Sessions Documentation](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Session Storage Documentation](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [GitHub Issue #2778: TypeScript SDK ignores resume parameter](https://github.com/anthropics/claude-code/issues/2778)
- [GitHub Issue #8069: Resume gives different session_id](https://github.com/anthropics/claude-code/issues/8069)
- [GitHub Issue #97: Customizable Session Storage Backend](https://github.com/anthropics/claude-agent-sdk-typescript/issues/97)
- SDK source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (function `I$$` = exported `query`)
