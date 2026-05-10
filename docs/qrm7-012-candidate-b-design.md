# QRM7-012 Candidate B′ — Live-SSE-Response Signal Design

**Status:** Approved (architect review 2026-05-10)
**Ticket:** [QRM7-012](../tickets/QRM7-012-sse-stream-death-reaps-moderator.md)

## Problem

The `hasOpenedSse` boolean on `McpSessionState` (QRM7-011-B) is dead code. CC CLI 2.1.126 opens GET SSE within ~20 ms of session creation — before `register_agent` fires — so `hasOpenedSse` is sticky-true before the moderator role binds. The `isSessionAlive` exemption branch (`role === moderator && !hasOpenedSse`) never engages. The moderator session survives only because Candidate A's 30-min `SESSION_LIVENESS_TIMEOUT_MS` floor backstops the 5-min GET reopen cadence.

## Design

Replace `hasOpenedSse: boolean` (sticky, dead) with `activeSseToken: object | null` (transient, live-tracking).

### McpSessionState

```typescript
interface McpSessionState {
  role?: AgentRole;
  correlationId?: string;
  agentSessions: Map<AgentRole, string>;
  lastSeenAt: number;
  // Candidate B: replaces hasOpenedSse
  activeSseToken: object | null;
}
```

### McpService API

```typescript
// Returns an opaque identity token for this SSE session.
// Called by the controller on GET open.
markSseAlive(server: McpServer): object

// Clears activeSseToken only if the passed token matches the current one.
// Called by the controller in res.on('close').
markSseDead(server: McpServer, token: object): void
```

### isSessionAlive Invariant

```typescript
isSessionAlive(server: McpServer): boolean {
  const state = this.sessionStates.get(server);
  if (!state) return false;
  // Layer 1 — QRM7-009: agent-role sessions always exempt
  if (state.role && state.role !== AgentRole.moderator) return true;
  // Layer 2 — Candidate B: moderator with live SSE response exempt
  if (state.role === AgentRole.moderator && state.activeSseToken !== null) return true;
  // Layer 3 — Default: lastSeenAt check (30-min timeout)
  return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
}
```

### Controller Wiring

```typescript
// In handleGet, after touchSession:
const sseToken = this.mcpService.markSseAlive(mcpServer);
await transport.handleRequest(req, res);
this.startSseKeepalive(res, mcpServer);

res.on('close', () => {
  this.mcpService.markSseDead(mcpServer, sseToken);
});
```

## Key Refinements (B → B′)

### R1: Opaque Identity Token (not Response object)

`McpService` is protocol-level with no Express/HTTP knowledge. Storing a `Response` object on `McpSessionState` would leak HTTP concerns into the service layer.

Instead, `markSseAlive` creates a plain `{}` object as a unique identity token (reference equality). The controller captures the token on GET open and passes it to `markSseDead` in the `close` handler. This preserves the architecture boundary and solves the GET-reopen concurrency race (see below).

### R2: Keep the `setInterval` in `startSseKeepalive`

**Critical safety finding.** The ticket recommends removing the "dead" `setInterval` block, but `startSseKeepalive` is called from **two** paths:

1. **GET handler** — `setInterval` is dead here (CC CLI ends the response within 15s; first tick sees `writableEnded=true` and self-clears).
2. **POST handler** via `maybeStartKeepalive` (QRM6-BUG-011) — `setInterval` is **load-bearing** for long-running POST-SSE responses (e.g., 10-minute `invoke_agent` calls). It prevents undici's 5-min `bodyTimeout` from aborting the POST body.

Removing the `setInterval` would silently break POST-SSE keepalive. The self-clearing behavior on GETs costs one no-op tick — negligible. Keep the function unchanged.

### R3: Diagnostic Cleanup

Remove QRM7-011/012 temporary diagnostic logs (`markSseOpened` flip log, keepalive-tick branch log). Keep the reaper-check debug log (low cost, high value for future debugging).

## Concurrency: GET-Reopen Race

CC CLI reopens GET every ~5 min on the same session ID. If a new GET arrives before the prior response's `close` fires:

| Time | Event | `activeSseToken` |
|------|-------|-------------------|
| T+0 | GET₁ arrives | `token₁` |
| T+5:00 | GET₂ arrives | `token₂` (overwrite) |
| T+5:01 | GET₁ `close` fires | **No change** — `token₂ ≠ token₁`, identity check fails |
| T+5:15 | GET₂ `close` fires | `null` — `token₂` matches, cleared |

The stale `close` handler is a no-op because its captured token no longer matches `activeSseToken`. No false clearing of a live SSE signal.

## Compatibility

| Mechanism | Impact |
|-----------|--------|
| QRM7-009 same-role eviction | Unaffected. `register_agent` evicts prior sessions regardless of SSE state. |
| QRM7-001 reaper | Preserved. Moderator reaps when `activeSseToken` is null AND `lastSeenAt` exceeds 30 min. |
| QRM7-001 fail-fast (`invoke_agent` → dead moderator) | Preserved. `McpElicitationConnection.isConnected()` delegates to `isSessionAlive`. |
| QRM6-BUG-011 POST-SSE keepalive | Preserved. `setInterval` in `startSseKeepalive` unchanged. |
| Memory bounding | Preserved. Same-role eviction + `lastSeenAt` timeout for anonymous sessions. |

## Test Matrix

### McpService (mcp.service.spec.ts)

1. Moderator with `activeSseToken` alive → `isSessionAlive` true even when `lastSeenAt` stale
2. `markSseDead` with matching token clears `activeSseToken` → falls through to `lastSeenAt`
3. `markSseDead` with stale token (different from active) → no-op
4. SSE opened before `register_agent` → exempt while alive, reaps after close + stale `lastSeenAt`
5. Same-role eviction works against moderator with `activeSseToken` alive
6. `markSseAlive`/`markSseDead` no-op for unknown server

### McpController (mcp.controller.spec.ts)

7. GET handler calls `markSseAlive` (replaces `markSseOpened` test)
8. `res.on('close')` calls `markSseDead` with token from `markSseAlive`
9. GET reopen calls `markSseAlive` again (new token)
10. POST-SSE keepalive interval still fires pings (existing test, unchanged)
