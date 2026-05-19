# #10: FileSessionStore on Named Volume

## Summary

Replace `InMemorySessionStore` with a file-backed `FileSessionStore` that persists SDK session transcripts to per-role Docker named volumes. This ticket bundles three related changes that together enable durable cross-turn session resume: (a) the `FileSessionStore` class implementing the SDK `SessionStore` interface with JSONL-per-session persistence, (b) removal of the `agentSessions.clear()` call in `new_conversation` so cached sessionIds survive across turns (D9), and (c) a `reminder` field in the `new_conversation` response instructing the moderator to run `git pull` before reading workspace files (D10).

## Problem Statement

The current `InMemorySessionStore` (`apps/agent/src/llm/claude-code.service.ts:24`) keeps session transcripts in process memory only. When a container restarts, all session data is lost and the SDK silently falls back to a fresh session instead of resuming the prior conversation. This was identified as a root cause in `tickets/tmp/session-resume-investigation.md` — the SDK's resume path requires a `SessionStore` adapter that survives process restarts; without one, `--resume <sessionId>` looks for a `.jsonl` file that doesn't exist on the ephemeral container filesystem and silently starts a new session (no error, no warning).

Compounding this, the `new_conversation` tool (`apps/mcp-server/src/mcp/mcp.service.ts:1111`) calls `state.agentSessions.clear()` at every turn boundary, destroying the cached sessionId for every role. Even when the moderator wants to continue with the same agent across turns, the cache is wiped, forcing a fresh session. This defeats the purpose of session persistence.

These issues produce two concrete failure modes:
1. **Container restart = session loss**: Agent restarts drop all transcript history; the next `invoke_agent` with `resume: sessionId` silently starts fresh (no WARN, no error — the SDK just returns a new sessionId).
2. **Turn boundary = forced fresh start**: `new_conversation` wipes the sessionId cache, making cross-turn resume impossible even within the same container lifetime.

## Implementation Details

### 1. New file: `apps/agent/src/llm/file-session-store.ts`

A new class implementing the SDK's `SessionStore` interface (`@anthropic-ai/claude-agent-sdk`). Persists session transcripts as JSONL files on a Docker named volume at `/var/agent-sessions/`.

**SDK interface to implement** (from `sdk.d.ts:3604-3681`, marked `@alpha`):

```typescript
type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
  // Optional methods not needed for v1: listSessions, listSessionSummaries, delete
};

type SessionKey = { projectKey: string; sessionId: string; subpath?: string; };
type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown; };
```

**Class skeleton:**

```typescript
@Injectable()
export class FileSessionStore implements SessionStore {
  constructor(private readonly baseDir: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    // Resolve file path: baseDir/<sessionId>.jsonl (or baseDir/<sessionId>/subagents/<subpath>.jsonl for subkeys)
    // Append each entry as a JSON line (appendFile, not writeFile)
    // Create parent directory if needed (mkdir -p equivalent)
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    // Resolve file path using sessionId only (ignore projectKey — D3 design decision)
    // Read .jsonl, parse each line as JSON, return array
    // Return null if file does not exist
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    // List subpath entries under baseDir/<sessionId>/subagents/
    // Return empty array if directory does not exist
    // Enables subagent transcript resume
  }
}
```

**Key design choice (D3):** Lookup is keyed by `sessionId` only. The `projectKey` is accepted on `append()` for SDK compatibility but ignored on `load()`. Under worktree isolation (#11), the cwd changes per invocation, which changes `projectKey`. Since sessionIds are globally-unique UUIDs, keying on sessionId alone is sufficient and safe. This eliminates the "hidden tradeoff" from Concern #3 in the roadmap.

**File layout:**
- Main transcript: `<baseDir>/<sessionId>.jsonl`
- Subagent transcripts: `<baseDir>/<sessionId>/subagents/<subpath>.jsonl`
- `listSubkeys()` lists the subagent subpaths

**Error handling:** `append()` failures are best-effort per SDK contract — the SDK continues on `mirror_error`. `load()` should catch parse errors and return `null` (triggering fresh session) rather than throwing. Log a WARN on corrupt files.

### 2. Modify: `apps/agent/src/llm/claude-code.service.ts`

**Current state (line 24):** `private readonly sessionStore = new InMemorySessionStore();` — inline construction, no DI.

**Change:** Replace inline `InMemorySessionStore` with injected `FileSessionStore`.

- Remove import of `InMemorySessionStore` from `@anthropic-ai/claude-agent-sdk` (line 4)
- Import `FileSessionStore` from `./file-session-store`
- Inject `FileSessionStore` via constructor DI instead of inline construction (line 24 becomes a constructor parameter)
- Register `FileSessionStore` as a NestJS provider in the agent module, using a factory provider that reads the base directory from config or a constant (`/var/agent-sessions/`)

**DI wiring approach:** Use a factory provider in the agent's LLM module:

```typescript
{
  provide: FileSessionStore,
  useFactory: () => new FileSessionStore('/var/agent-sessions/'),
}
```

This is cleaner than embedding the path knowledge in the service. If the base dir needs to become configurable later, the factory reads from `AgentConfigService`.

### 3. Modify: `apps/mcp-server/src/mcp/mcp.service.ts` — D9 + D10

**D9: Remove `agentSessions.clear()` (lines 1109-1111)**

In `registerNewConversationTool()`:
- Delete line 1109 (`const clearedSessions = state.agentSessions.size;`)
- Delete line 1111 (`state.agentSessions.clear();`)
- Update the log message at line 1113-1116 to remove the `clearedSessions=` field, and add `cachedSessions=${state.agentSessions.size}` instead (shows how many sessions persist, useful for diagnostics)
- Update the tool description at lines 1077-1080: remove "and clears cached agent sessions so subsequent invocations start fresh" — replace with "Cached agent session IDs persist across calls for cross-turn resume; pass `sessionId: ""` to `invoke_agent` to force a fresh session."

What stays: `correlationId` minting (context scoping), `callChains` reset (which happens elsewhere in the broker). What goes: only the `agentSessions.clear()` line.

**D10: Add `reminder` field to response (lines 1119-1126)**

Change the `new_conversation` response from `{ correlationId }` to `{ correlationId, reminder }` where `reminder` is the constant string:

```
"Run git fetch origin && git pull --ff-only before reading any workspace files — agent commits since your last turn may not be in your local clone."
```

This fires at every turn boundary and survives prompt drift better than relying on moderator CLAUDE.md alone. Apply to both the normal response (lines 1119-1126) and the no-state fallback response (lines 1099-1106).

### 4. Modify: `apps/agent/src/connection/invocation-handler.service.ts` — Silent-fallback detection

**In `logResult()` (lines 240-255):** Add a WARN check when resume was requested but the returned sessionId differs from the requested one, indicating the SDK silently fell back to a fresh session:

```typescript
// After the existing success log block:
if (result.success && request.sessionId && result.sessionId !== request.sessionId) {
  this.logger.warn(
    `Session resume silent fallback: correlationId=${request.correlationId} ` +
    `requested=${request.sessionId} got=${result.sessionId}`
  );
}
```

This makes the silent-fallback failure mode visible in logs — a persistent debugging pain point during QRM5 session resume work. The condition fires only when resume was explicitly requested (`request.sessionId` is truthy) and the SDK returned a different sessionId.

### 5. Modify: `docker-compose.yml` — Per-role named volumes

Add a named volume per agent role for session persistence at `/var/agent-sessions/`. Each role gets its own volume to prevent cross-role session leakage.

**Volume definitions** (add to the `volumes:` section at bottom):
- `architect-sessions:`
- `teamlead-sessions:`
- `developer-sessions:`

**Volume mounts** (add to each agent service's `volumes:` list):
- architect: `architect-sessions:/var/agent-sessions`
- teamlead: `teamlead-sessions:/var/agent-sessions`
- developer: `developer-sessions:/var/agent-sessions`

Note: `qa` and `productowner` services are not currently defined in `docker-compose.yml`. Their session volumes (`qa-sessions:`, `productowner-sessions:`) should be added when those services are defined. No action in this ticket.

### 6. Unit tests

- **`apps/agent/src/llm/file-session-store.spec.ts`** (new): Test `FileSessionStore` against the SDK contract:
  - `append()` writes JSONL entries to the correct file path
  - `load()` returns entries for known sessionId regardless of projectKey value
  - `load()` returns `null` for unknown sessionId
  - `listSubkeys()` returns subpath names for sessions with subagent transcripts
  - `listSubkeys()` returns empty array for sessions without subagents
  - Round-trip: `append()` then `load()` returns the same entries
  - Concurrent `append()` calls to the same session produce valid JSONL
  - Corrupt JSONL line is handled gracefully (returns `null` or skips bad lines)
  - Use `os.tmpdir()` for test base directory; clean up in `afterEach`

- **`apps/mcp-server/src/mcp/mcp.service.spec.ts`** (modify if tests exist): Verify:
  - `new_conversation` response includes `reminder` field
  - `agentSessions` cache persists across `new_conversation` calls (D9)

## Acceptance Criteria

- [ ] `FileSessionStore.load({sessionId})` returns session entries regardless of `projectKey` value (sessionId-only lookup)
- [ ] `FileSessionStore.append()` persists JSONL entries that survive container restart
- [ ] Resume across invocations: SDK `query()` with `resume: sessionId` + `sessionStore` restores prior transcript
- [ ] `agentSessions.clear()` removed from `new_conversation` — cached sessionIds survive across turns (D9)
- [ ] `WARN` logged in `InvocationHandler.logResult()` when `result.sessionId !== request.sessionId` (silent-fallback detection)
- [ ] (Optional) Latest per-role sessionId persisted to `context_store` project scope (`latest-session:<role>` key) on each response; restored on MCP startup for cross-restart resilience. Deferrable to QRM9 if implementation cost is non-trivial — the `agentSessions` cache is in-process and lost on MCP restart, but MCP restarts are infrequent and the FileSessionStore data survives regardless
- [ ] `new_conversation` response includes a `reminder` field instructing the moderator to run `git fetch origin && git pull --ff-only` before reading workspace files (D10)

## Dependencies and References

**Dependencies:** None — independent foundation work. No blocking dependencies on other QRM8 tickets.

**References:**
- [#8: QRM8 Roadmap](8-workspace-isolation.md) — Design decisions D3, D9, D10; scope definition; concerns and resolutions
- [Session Resume Investigation](tmp/session-resume-investigation.md) — Root cause analysis of silent resume failures; Option A (FileSessionStore) design
- [QRM5-001: Agent Session Resume](QRM5-001-agent-session-resume.md) — Original session resume architecture; surfaced `sessionId` in `InvokeRequest`/`InvokeResponse`
- QRM6 D5/D6 — Correlation ID and session tracking; established `agentSessions` cache and `new_conversation` reset pattern (D9 refines this)
- SDK `SessionStore` interface — `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3604-3681` (marked `@alpha`)
