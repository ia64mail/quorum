# QRM6-005: `new_conversation` Tool

## Summary

Add a `new_conversation` MCP tool that mints a fresh correlation ID for the current user turn and resets the per-MCP-session agent session cache. This is the mechanism by which the moderator signals "the user started a new topic" — downstream tool calls inherit the new correlation ID via QRM6-004's auto-injection chain, and agent session resume starts fresh rather than resuming a stale session from a prior turn.

After this ticket, `McpSessionState.correlationId` (introduced in QRM6-004 but always `undefined`) is populated, completing the three-level correlation ID fallback: `explicit arg > session state (set by new_conversation) > randomUUID()`.

## Problem Statement

Today, correlation IDs are either passed explicitly by the caller or auto-generated per tool call via `randomUUID()`. The terminal app's `ChatService` mints a single UUID per user input (`chat.service.ts:390`) and injects it into every tool call for that turn via `augmentArgs()`. This gives each user turn a consistent correlation ID — all agent invocations and context operations within a turn share the same scope.

With the moderator moving to CC CLI, `augmentArgs()` disappears. QRM6-004 introduced session-state auto-injection, but the `correlationId` field on `McpSessionState` is never written — every tool call that omits `correlationId` falls through to `randomUUID()`, generating a **different** ID per call. This breaks conversation-scoped context: an `invoke_agent` call and a subsequent `context_query` within the same turn would get different correlation IDs, making them invisible to each other.

Additionally, the `agentSessions` cache (also from QRM6-004) accumulates session IDs across user turns. Without a reset signal, `invoke_agent(target=developer)` in turn N+1 would auto-resume the developer's session from turn N — which may be correct for continuation but wrong when the user explicitly starts a new topic.

**What changes:**
- A `new_conversation` tool is registered on every per-session `McpServer` instance.
- Calling it mints a `correlationId`, writes it to `McpSessionState.correlationId`, and clears `McpSessionState.agentSessions`.
- The moderator's CLAUDE.md (QRM6-007) will instruct the LLM to call `new_conversation` at the start of each user turn.

**What stays the same:**
- The auto-injection chain in all tool handlers (QRM6-004) — this ticket populates the field they already read.
- The `randomUUID()` fallback — if the moderator forgets to call `new_conversation`, auto-generation still works (each tool call gets its own random ID, same as pre-QRM6-004 behavior).
- `InvokeRequest`/`InvokeResponse` types — no changes.
- Agent-originated tool calls — agents pass `correlationId` explicitly; this tool is moderator-facing.

**Risks of deferral:** Without `new_conversation`, the session-state `correlationId` is never populated. The moderator must either pass `correlationId` explicitly on every tool call (fragile — LLMs drop fields) or accept fragmented correlation scoping (each tool call gets a random ID). This degrades conversation context coherence and blocks QRM6-007 (moderator CLAUDE.md relies on `new_conversation` for turn scoping) and QRM6-008 (test scenarios for the tool).

## Design Context

This ticket implements **D5 (Correlation ID — Per-Turn, Minted by the Moderator)** from the QRM6 roadmap.

**D5 summary:** The moderator mints a fresh correlation ID at the start of each user turn via `new_conversation`. The tool returns the UUID and clears the per-role session cache. CLAUDE.md prompt guidance ensures the moderator calls it reliably. Server fallback: auto-generated `randomUUID()` when no session-state `correlationId` exists.

**QRM6-004 foundation:** The `McpSessionState` interface, `sessionStates` map, and auto-injection chain are all in place. Specifically:
- `McpSessionState.correlationId` field exists but is always `undefined` (line 36 of `mcp.service.ts`).
- All tool handlers already resolve via `args.correlationId ?? state?.correlationId ?? ...` — the chain reads the field; this ticket writes it.
- `McpSessionState.agentSessions` is a `Map<AgentRole, string>` that accumulates across `invoke_agent` calls — this ticket adds the reset mechanism.

**Correlation ID lifecycle (from roadmap):**
```
User turn N starts
  -> Moderator calls new_conversation() -> returns correlationId = C_N
     -> Moderator calls invoke_agent(target=developer, action=...)
        -> Server auto-injects correlationId=C_N, callerRole='moderator', sessionId=(cached or null)
     -> Moderator calls context_query(scope=conversation, ...)
        -> Server auto-injects correlationId=C_N
  -> Moderator responds to user

User turn N+1 starts
  -> Moderator calls new_conversation() -> returns C_{N+1}
     -> agentSessions cache cleared (fresh session resume for all roles)
```

## Implementation Details

### 1. Tool Registration

Add a `registerNewConversationTool(server: McpServer)` private method to `McpService`, following the same pattern as the other `register*Tool` methods. Call it from `registerTools()` alongside the existing tool registrations.

**Tool name:** `new_conversation`. The roadmap mentions `start_conversation` as an alternative but `new_conversation` better signals the semantic: "a new conversation scope begins now." It also aligns with the roadmap's primary choice and all existing documentation references (D5, the correlation lifecycle diagrams, the tool auto-augmentation table).

**Input schema:**
- `description` — `z.string().optional()` — Human-readable note for logging and context store traceability. Not functionally required, but useful for agents reviewing context store entries later ("user asked about auth flow" vs anonymous UUID).

**Handler logic:**

1. Look up session state via `this.sessionStates.get(server)`.
2. If no session state exists (singleton server path or unregistered session), return a successful response with a freshly generated `correlationId` but log a warning. The tool should not error — the moderator may call it before `register_agent` in edge cases, and returning a usable correlation ID is still valuable. However, without session state, the ID won't be auto-injected into subsequent calls.
3. Generate `correlationId = randomUUID()`.
4. Write to session state: `state.correlationId = correlationId`.
5. Clear the agent sessions cache: `state.agentSessions.clear()`. This is a `Map.clear()` call — simple, no iteration needed.
6. Log the action at `info` level: tool name, new correlation ID, description (if provided), and the number of agent sessions that were cleared (for observability).
7. Return `{ correlationId }` serialized as JSON in the standard MCP text content format.

**Return value:** `{ correlationId: "<uuid>" }`. Minimal — the moderator's LLM does not need to parse or remember this value (auto-injection handles downstream propagation), but returning it allows explicit use if desired and makes the tool's effect visible in CC CLI's tool-result rendering.

### 2. Placement in `registerTools()`

Insert the call between `registerContextStatsTool` and `registerProjectResource` — grouping it with tools rather than resources, but after the context tools since it's a lifecycle/orchestration tool, not a data tool:

```
this.registerContextStatsTool(server);
this.registerNewConversationTool(server);  // <-- new
this.registerProjectResource(server);
```

### 3. Edge Cases and Behavioral Contracts

**Multiple calls per turn:** If the moderator calls `new_conversation` twice in the same turn, the second call overwrites the first correlation ID and re-clears `agentSessions`. This is idempotent and harmless — the last correlation ID wins. No warning needed; this is valid usage (e.g., moderator realizes it started the wrong conversation scope and corrects).

**Call without prior `register_agent`:** The session state entry is created in `connect()` with `role: undefined` and an empty `agentSessions` map. `new_conversation` works fine — it writes `correlationId` and clears the (already empty) sessions. The `role` being undefined doesn't affect this tool's behavior. Subsequent tool calls may still need `callerRole` explicitly, but that's the same pre-registration behavior as today.

**Singleton server path:** The `this.server` instance created in the constructor has no entry in `sessionStates`. `new_conversation` on this path generates a correlation ID, returns it successfully, but cannot persist it in session state. Log at `warn` level. This path is only hit in tests using the singleton directly — real client sessions always go through `connect()`.

**`sessionId=""` interaction:** `new_conversation` clearing `agentSessions` achieves the same effect as the moderator passing `sessionId=""` on every subsequent `invoke_agent` — both result in fresh agent sessions. The difference: clearing the cache means "forget all prior sessions" (automatic), while `sessionId=""` means "force fresh for this specific call" (explicit override). They compose correctly — after `new_conversation`, the cache is empty, so auto-injection finds nothing, and the agent starts fresh.

**Correlation ID format:** Standard `randomUUID()` (v4 UUID via `node:crypto`). Matches the existing pattern used throughout the codebase (`mcp.service.ts` line 192, `mcp.controller.ts` line 11).

### 4. Schema Description

The tool description should be clear enough that CC CLI's tool listing and the moderator's LLM understand the purpose:

> "Start a new conversation scope. Mints a fresh correlation ID for the current user turn and clears cached agent sessions so subsequent invocations start fresh. Call this at the beginning of each new user turn."

This description serves double duty: it's what the LLM reads in the tool list, and it's the guidance for when to call it. QRM6-007's CLAUDE.md will reinforce this with explicit prompt instructions.

### 5. No Changes to Other Tools

All auto-injection logic was implemented in QRM6-004 and already reads `state?.correlationId`. This ticket only **writes** the field. No modifications needed to `invoke_agent`, `context_store`, `context_query`, or `context_summarize` handlers.

### 6. No Changes to `MessageBroker`

The broker receives fully-formed `InvokeRequest` objects with `correlationId` already resolved by the `McpService` tool handler. The broker does not know or care whether the ID came from `new_conversation`, explicit args, or `randomUUID()` fallback.

## Acceptance Criteria

- [x] `new_conversation` tool is registered on every per-session `McpServer` instance (via `registerTools`)
- [x] Tool input schema has an optional `description` string field
- [x] Tool handler generates a fresh `correlationId` via `randomUUID()` and returns `{ correlationId: "<uuid>" }`
- [x] Handler writes the new `correlationId` to `McpSessionState.correlationId` for the calling session
- [x] Handler clears `McpSessionState.agentSessions` for the calling session (resets session resume cache)
- [x] After calling `new_conversation`, subsequent `invoke_agent` / `context_store` / `context_query` / `context_summarize` calls from the same session auto-inject the new correlation ID (verified via the existing QRM6-004 injection chain)
- [x] After calling `new_conversation`, subsequent `invoke_agent` calls do NOT auto-inject cached `sessionId` values from prior turns (cache was cleared)
- [x] Multiple `new_conversation` calls in the same session are idempotent — last one wins, no errors
- [x] Calling `new_conversation` on a session without prior `register_agent` succeeds (returns correlation ID, writes to session state)
- [x] Calling `new_conversation` on the singleton server path (no session state) returns a correlation ID but logs a warning
- [x] Tool description clearly communicates purpose and usage guidance for the LLM
- [x] Handler logs at `info` level: new correlation ID, description (if provided), number of cleared agent sessions
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes (existing tests, no regressions — new tests deferred to QRM6-008)
- [x] No changes to `apps/terminal/` — the existing terminal service remains untouched

## Dependencies and References

**Depends on:**
- QRM6-004 (Server-Side Caller Identity & Session Tracking) — provides the `McpSessionState` interface, `sessionStates` map, and the auto-injection chain that reads `correlationId`. Without QRM6-004, there is no session state to write to. **Status: Complete.**

**Blocks:**
- QRM6-007 (Moderator CLAUDE.md) — the prompt instructs the moderator to call `new_conversation` at the start of each user turn; the tool must exist first.
- QRM6-008 (Tests) — includes `new_conversation` unit tests: fresh UUID generation, session state write, `agentSessions` cache clear, idempotent re-calls.
- QRM6-009 (Terminal deletion) — the terminal's per-turn correlation ID minting (`chat.service.ts:390`) is fully superseded by this tool.

**Key codebase references:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | **Primary modification target** — add `registerNewConversationTool()`, call from `registerTools()` |
| `apps/mcp-server/src/mcp/mcp.service.ts:33-40` | `McpSessionState` interface — `correlationId` field this tool writes, `agentSessions` field this tool clears |
| `apps/mcp-server/src/mcp/mcp.service.ts:68` | `sessionStates` map — lookup target for the handler |
| `apps/mcp-server/src/mcp/mcp.service.ts:191-192` | Existing `correlationId` resolution chain in `invoke_agent` — reads the field this tool writes |
| `apps/mcp-server/src/mcp/mcp.service.ts:391` | Existing `correlationId` resolution in `context_store` — same pattern |
| `apps/mcp-server/src/mcp/index.ts` | Barrel export — no changes needed (McpSessionState already exported) |
| `apps/terminal/src/chat/chat.service.ts:390` | Terminal's per-turn correlation ID minting — the logic this tool replaces |
| `apps/terminal/src/chat/chat.service.ts:303` | Terminal's `agentSessions` map — the cache-clear this tool replaces |

**Design references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D5 (Correlation ID — Per-Turn, Minted by the Moderator), Correlation ID Lifecycle diagram, Tool Call Auto-Augmentation table
- [QRM6-004-server-side-caller-identity-session-tracking.md](QRM6-004-server-side-caller-identity-session-tracking.md) — Session state infrastructure, auto-injection pattern

## Implementation Notes

**Status:** Complete

**Date:** 2026-04-23

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Modified | Added `registerNewConversationTool()` private method (lines 666-721), called from `registerTools()` (line 111). Updated `McpSessionState` JSDoc (line 30) and `McpService` class docblock (line 54) to list the new tool. |

### Verification

- `npm run build` — compiles successfully (all 4 webpack targets)
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 760 tests passing, 49 suites (0 new tests — deferred to QRM6-008)
