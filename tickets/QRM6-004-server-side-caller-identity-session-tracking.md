# QRM6-004: Server-Side Caller Identity & Session Tracking

## Summary

Implement automatic injection of `callerRole`, `correlationId`, and `sessionId` for tool calls originating from registered MCP sessions. The MCP server maintains a per-session state map (keyed by the per-session `McpServer` instance) that records the caller's role at `register_agent` time, tracks the active `correlationId`, and caches `sessionId` values returned by agent invocations. Tool handlers consult this map and inject defaults the client did not provide — explicit client values always win.

After this ticket, the moderator's CC CLI no longer needs prompt-level instructions to pass `callerRole`, `correlationId`, or `sessionId` on every tool call. The server derives them from the session identity, eliminating a class of bugs where the LLM drops required fields across long conversations.

## Problem Statement

Today, every tool call from any MCP client must explicitly include identity and tracking fields:

- `invoke_agent` requires `callerRole` (which role is calling), `correlationId` (call chain tracer), and optionally `sessionId` (for agent session resume).
- `context_store` requires `agentRole` and `correlationId` (for conversation scope).
- `context_query` and `context_summarize` require `correlationId` (for conversation scope).

The current terminal app handles this via `augmentArgs()` (`apps/terminal/src/chat/chat.service.ts:565`), a client-side function that injects `callerRole='moderator'`, the current `correlationId`, `depth=0`, and cached `sessionId` values into every outgoing tool call. The `agentSessions` map (`chat.service.ts:303`) tracks session IDs returned by agents, and `trackAgentSession()` (`chat.service.ts:594`) updates the cache from response JSON.

With the moderator moving to CC CLI (QRM6-002), this client-side augmentation disappears. CC CLI has no custom middleware to inject fields. Relying on the LLM prompt to always pass `callerRole` and `correlationId` is fragile — LLMs drop fields in long conversations, and `sessionId` tracking requires parsing and caching response JSON across turns.

**What changes:**
- `McpService` maintains session-indexed state: a map from per-session `McpServer` instances to `{role, correlationId, agentSessions}`.
- `register_agent` populates the `role` binding when a client registers.
- Tool handlers for `invoke_agent`, `context_store`, `context_query`, and `context_summarize` auto-inject defaults from the session state when the client omits them.
- After `invoke_agent` completes, the handler caches the returned `sessionId` in the session state for subsequent calls to the same target role.
- `callerRole` in `invoke_agent` becomes optional in the schema (was required).
- Session state is cleaned up when the MCP session closes.

**What stays the same:**
- The `InvokeRequest`/`InvokeResponse` types — no changes to the messaging contract.
- Agent-originated tool calls — agents already pass `callerRole` explicitly; auto-injection just provides a safety net.
- `MessageBroker.invoke()` — no changes to broker logic (session cache update happens in the `McpService` tool handler, not the broker).
- Clarification auto-persist added in QRM6-003 — unchanged.
- `sessionId=""` override semantics — preserved and enforced server-side.

**Risks of deferral:** Without server-side injection, the moderator CC CLI prompt must reliably pass `callerRole` and `correlationId` on every tool call. Dropped fields cause cryptic broker errors ("callerRole is required"), incorrect correlation scoping, or lost session resume. This blocks QRM6-005 (`new_conversation` tool, which writes to the session state map introduced here) and degrades the reliability of QRM6-007 (moderator CLAUDE.md).

## Design Context

This ticket implements **D4 (Caller Identity — Server-Side Binding via MCP Session ID)** and **D6 (Agent Session Tracking — Server-Side, Not Moderator-Side)** from the QRM6 roadmap.

**D4 summary:** On `register_agent(role='moderator')`, the MCP server records `mcp-session → moderator`. For any subsequent tool call, the server looks up the session's role and injects `callerRole` if not provided. Explicit values always win. Default `depth=0` for moderator-originated calls.

**D6 summary:** The MCP server tracks `lastSessionId[session][targetRole]` and auto-injects `sessionId` into `invoke_agent` calls unless the caller explicitly sets `sessionId=""` to force a fresh session. On response, the handler updates the cache with the returned `sessionId`.

**QRM6-003 foundation:** The Approach A closure capture pattern — where `registerTools(session)` receives the per-session `McpServer` and tool handlers close over it — is already established. QRM6-004 extends this by using the `McpServer` instance as the key into a session state map, rather than only using it for elicitation connection construction.

**Source logic being migrated:**
- `augmentArgs()` at `chat.service.ts:565-591` — injects `callerRole`, `correlationId`, `depth`, and `sessionId` into tool calls
- `agentSessions` map at `chat.service.ts:303` — caches session IDs per target role
- `trackAgentSession()` at `chat.service.ts:594-604` — extracts `sessionId` from response JSON and updates cache
- `currentCorrelationId` at `chat.service.ts:301` — the active correlation ID for the current conversation

## Implementation Details

### 1. Session State Interface

Define a `McpSessionState` interface in `mcp.service.ts` (or a co-located file if the developer prefers separation):

- `role?: AgentRole` — populated at `register_agent` time; undefined for sessions that haven't registered
- `correlationId?: string` — the active conversation correlation ID; set by `new_conversation` (QRM6-005) or auto-generated on first use
- `agentSessions: Map<AgentRole, string>` — cached `sessionId` per target role, updated after `invoke_agent` responses

### 2. Session State Map in `McpService`

Add a private map to `McpService`:

    private readonly sessionStates = new Map<McpServer, McpSessionState>();

**Why `McpServer` as key (not `mcp-session-id` string):** The per-session `McpServer` instance is already in scope via closure capture (Approach A from QRM6-003). Tool handlers don't have access to the `mcp-session-id` header — that lives in the controller layer. Using the `McpServer` as the key avoids threading the session ID string through registration calls.

**Lifecycle:**
- **Creation:** In `connect()`, after creating the per-session `McpServer`, insert an empty state entry: `this.sessionStates.set(session, { agentSessions: new Map() })`.
- **Cleanup:** `connect()` should return the `McpServer` instance so the controller can reference it. Add a `disconnect(server: McpServer)` method that removes the entry from the map. The controller calls `disconnect()` in its `transport.onclose` handler. Log the cleanup for observability.

**Important:** The singleton `this.server` (created in the constructor and used for `onModuleInit` tool registration) should NOT get a session state entry. Only per-session instances created in `connect()` get tracked. Tool handlers on the singleton will find no session state and skip injection — this is correct because the singleton is never used for real client sessions.

### 3. `connect()` Return Value and Controller Wiring

**`McpService.connect()`** — change return type from `Promise<void>` to `Promise<McpServer>`:

1. Create per-session `McpServer` (existing)
2. Insert empty session state into `sessionStates` map (new)
3. Register tools (existing)
4. Connect to transport (existing)
5. Return the `McpServer` instance (new)

**`McpService.disconnect(server: McpServer)`** — new method:

1. Delete the session state from `sessionStates`
2. Log the cleanup

**`McpController`** — update to track the per-session server and clean up on close:

- In `handlePost()` (new session path), capture the return value of `mcpService.connect(transport)`
- Store a `Map<string, McpServer>` alongside the existing `Map<string, Transport>` (or a combined entry)
- In `transport.onclose`, call `mcpService.disconnect(serverInstance)` before deleting the transport from the sessions map
- The `handleDelete()` method should also call `disconnect()` for explicit session termination

### 4. `register_agent` — Populate Session State Role

In the `register_agent` handler, after creating the connection and registering with the registry, look up the session state for the closure-captured `server` and set the role:

    const state = this.sessionStates.get(server);
    if (state) {
      state.role = role;
    }

This associates the MCP session with the registered agent role. For the moderator, this means subsequent tool calls from that session will auto-inject `callerRole='moderator'`. For agents (which also call `register_agent`), their role is similarly bound.

### 5. `invoke_agent` — Auto-Injection and Session Cache

Make `callerRole` optional in the input schema: change from `z.enum(agentRoleValues).describe(...)` to `z.enum(agentRoleValues).optional().describe(...)`. Update the description to note that the server injects from the session identity if omitted.

In the handler, before building the `InvokeRequest`:

1. **Look up session state:** `const state = this.sessionStates.get(server)` (where `server` is the closure-captured per-session instance).

2. **Resolve `callerRole`:** `args.callerRole ?? state?.role`. If both are undefined, return an error — callerRole is needed for broker safeguards.

3. **Resolve `correlationId`:** `args.correlationId ?? state?.correlationId ?? randomUUID()`. Maintains the existing fallback of auto-generating when omitted. If the session has an active correlationId (set by QRM6-005's `new_conversation`), it takes precedence over random generation but not over an explicit argument.

4. **Resolve `sessionId`:**
   - If `args.sessionId === ""`: force fresh — set `sessionId = undefined` in the request. Do NOT inject from cache.
   - If `args.sessionId` is provided and non-empty: use as-is.
   - If `args.sessionId` is undefined/not provided: look up `state?.agentSessions.get(target)`. Inject if found, leave undefined if not.

5. **Resolve `depth`:** Keep the existing `z.number().default(0)` — Zod already applies the default. No session-state injection needed.

After the broker returns the `InvokeResponse`:

6. **Update session cache:** If `response.sessionId` is a non-empty string and the session state exists, update: `state.agentSessions.set(target, response.sessionId)`. This is the server-side equivalent of `trackAgentSession()`.

### 6. `context_store` — Auto-Inject `correlationId` and `agentRole`

In the `context_store` handler, before processing:

1. Look up session state via `this.sessionStates.get(server)`.
2. Resolve `correlationId`: `args.correlationId ?? state?.correlationId`. Existing validation for conversation-scope-without-correlationId still applies after resolution.
3. Resolve `agentRole`: `args.agentRole ?? state?.role`. The role is optional in the schema and remains so — injection provides the default.

### 7. `context_query` and `context_summarize` — Auto-Inject `correlationId`

Same pattern as `context_store` for `correlationId` resolution:

1. Look up session state.
2. Resolve: `args.correlationId ?? state?.correlationId`.

No other fields need injection for these tools.

### 8. Passing `server` to Tool Registration Methods

The tool registration methods (`registerInvokeAgentTool`, `registerContextStoreTool`, etc.) currently receive the `McpServer` as `server`. The closure capture is already in place from QRM6-003's Approach A. No structural change is needed — the handler closures already close over `server`, which is the per-session instance. The new code simply uses `server` as a lookup key into `sessionStates`.

**Note:** For the singleton server (registered in `onModuleInit`), `this.sessionStates.get(server)` returns `undefined` because the singleton is never added to the map. All injection code must handle `state` being `undefined` gracefully — this is the no-injection-available case, which falls through to existing behavior (explicit args required or auto-generated correlationId).

### 9. Schema Description Updates

Update the following tool schema descriptions to reflect auto-injection:

- `invoke_agent.callerRole`: "Role of the calling agent. Auto-injected from MCP session identity if omitted."
- `invoke_agent.correlationId`: "Correlation ID for call chain tracing. Auto-injected from session state if omitted, generated if neither available."
- `invoke_agent.sessionId`: "Resume a prior SDK session. Auto-injected from session cache if omitted. Pass empty string to force a fresh session."
- `context_store.correlationId`: "Required for conversation scope. Auto-injected from session state if omitted."
- `context_store.agentRole`: "Agent role creating this item. Auto-injected from session identity if omitted."
- `context_query.correlationId`: "Scope identifier. Auto-injected from session state if omitted."
- `context_summarize.correlationId`: add note about auto-injection if not already present.

## Acceptance Criteria

- [x] `McpSessionState` interface exists with `role`, `correlationId`, and `agentSessions` fields
- [x] `McpService` maintains a `Map<McpServer, McpSessionState>` for per-session state tracking
- [x] `connect()` creates a session state entry and returns the `McpServer` instance
- [x] `disconnect(server)` method removes the session state entry and logs the cleanup
- [x] `McpController` calls `disconnect()` on transport close and explicit session deletion
- [x] `register_agent` handler populates `sessionState.role` from the registered role
- [x] `invoke_agent` schema: `callerRole` is optional (was required); server injects from session state when omitted
- [x] `invoke_agent` handler: auto-injects `callerRole` from session state when client omits it
- [x] `invoke_agent` handler: auto-injects `correlationId` from session state; falls back to `randomUUID()` if neither provided nor in state
- [x] `invoke_agent` handler: auto-injects `sessionId` from `agentSessions` cache when client omits it
- [x] `invoke_agent` handler: `sessionId=""` forces fresh session (no cache injection, `undefined` passed to broker)
- [x] `invoke_agent` handler: updates `agentSessions` cache from `response.sessionId` after broker returns
- [x] `context_store` handler: auto-injects `correlationId` and `agentRole` from session state when omitted
- [x] `context_query` handler: auto-injects `correlationId` from session state when omitted
- [x] `context_summarize` handler: auto-injects `correlationId` from session state when omitted
- [x] Explicit client-provided values always override session-state defaults (all tools)
- [x] Singleton `McpServer` (registered in `onModuleInit`) has no session state entry — injection gracefully skips
- [x] Tool schema descriptions updated to document auto-injection behavior
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes (existing 760 tests, 49 suites — no regressions)
- [x] No changes to `apps/terminal/` — the existing terminal service remains untouched

## Dependencies and References

- **Depends on:**
  - QRM6-003 (MCP elicitation connection — establishes the Approach A closure capture pattern and per-session `McpServer` in tool handlers; introduces `McpElicitationConnection` which confirms the moderator registers via the session)
- **Blocks:**
  - QRM6-005 (`new_conversation` tool — writes `correlationId` to the session state map and clears `agentSessions`; requires the map infrastructure from this ticket)
  - QRM6-008 (tests — includes session-state injection unit tests and session cache tests)
  - QRM6-009 (terminal deletion — `augmentArgs()` and `agentSessions` map in the terminal are superseded by this server-side implementation)

**Key codebase references:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Primary modification target — session state map, tool handler auto-injection, `connect()`/`disconnect()` lifecycle |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Wiring — captures per-session `McpServer` from `connect()`, calls `disconnect()` on session close |
| `apps/terminal/src/chat/chat.service.ts:565-591` | Source logic — `augmentArgs()` shows exactly what fields to inject and the precedence rules |
| `apps/terminal/src/chat/chat.service.ts:303` | Source logic — `agentSessions` map for session cache pattern |
| `apps/terminal/src/chat/chat.service.ts:594-604` | Source logic — `trackAgentSession()` for session-ID extraction from response |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | No changes — broker receives fully-formed `InvokeRequest`; session cache update happens in the McpService handler |
| `libs/common/src/messaging/invoke.types.ts` | `InvokeRequest`/`InvokeResponse` types — `response.sessionId` is the field cached; no type changes needed |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | Existing test suite — must not regress; tests use the singleton `this.server` which has no session state |

**Design references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D4 (Caller Identity), D6 (Session Tracking), Tool Call Auto-Augmentation table, Agent Session Resume flow diagram
- [QRM6-003-mcp-elicitation-connection.md](QRM6-003-mcp-elicitation-connection.md) — Approach A closure capture pattern (foundation for session state lookup)
- [docs/message-broker.md](../docs/message-broker.md) — Broker safeguards (circular call prevention uses `caller` — must not be undefined)

## Implementation Notes

**Status:** Complete

**Date:** 2026-04-23

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Modified | Added `McpSessionState` interface, `sessionStates` map, `disconnect()` method, changed `connect()` to return `McpServer`, auto-injection logic in all 4 tool handlers (`invoke_agent`, `context_store`, `context_query`, `context_summarize`), session cache update after `invoke_agent`, role binding in `register_agent`, updated schema descriptions |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Modified | Added `mcpServers` map alongside `sessions`, captures `McpServer` from `connect()`, calls `disconnect()` in `transport.onclose` and `handleDelete` |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | Modified | Updated mock to return `McpServer` from `connect()`, added `disconnect` mock |
| `apps/mcp-server/src/mcp/index.ts` | Modified | Added `export type { McpSessionState }` for downstream consumers (QRM6-005) |

### Verification

- `npm run build` — 4/4 webpack compilations successful
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 760 tests passing (49 suites), 0 new tests (QRM6-008 covers session-state testing)
- `git diff -- apps/terminal/` — empty (no terminal changes)
