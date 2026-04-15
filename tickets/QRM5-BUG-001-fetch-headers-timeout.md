# QRM5-BUG-001: Undici headersTimeout Kills Long-Running Agent Invocations

## Summary

Node.js's built-in `fetch()` (undici) enforces a default `headersTimeout` of 300,000ms (5 minutes). `HttpAgentConnection.handle()` relies on an AbortController with the role-specific timeout (30 minutes for developer), but undici closes the TCP connection at ~5 minutes before the AbortController fires. This caused the first QRM5 session failure: the developer completed QRM5-001 implementation (commit `6062d86`, 552 tests green) but its response was discarded because the server-side connection had already been killed.

## Problem Statement

In QRM5 Run 1, the moderator dispatched the developer to implement QRM5-001 at 02:30:27 UTC. The developer worked for 5m 17s (59 turns, $2.75), committed successfully, and stored context. At 02:35:28 — exactly ~301 seconds into the invocation — the MCP server logged:

```
[HttpAgentConnection] Agent developer unreachable: fetch failed
[MessageBroker] Completed: correlationId=bb523219 target=developer success=false
```

The error hit the **general catch branch** (line 80-83 of `http-agent-connection.ts`), producing `"unreachable: fetch failed"` — not the AbortError branch (line 75-79) which would produce `"invocation timed out"`. This confirms the failure originated in the transport layer, not the application timeout.

The developer finished 17 seconds later at 02:35:45, but its response was discarded. The moderator's MCP tool call never resolved — the `invoke_agent` tool hung until the user Ctrl+C'd at 02:38:39. The session ended without code review.

### Why this matters

1. **Role timeouts are ineffective** — `ROLE_TIMEOUTS` gives developer 30 minutes, but undici kills the connection at 5 minutes. Every implementation invocation exceeding 5 minutes will fail, regardless of the configured timeout.

2. **Work is completed but lost** — the developer does the work, commits, stores context, but the response never reaches the moderator. The moderator treats it as a failure and may re-dispatch (wasting another $2-3), or the user kills the session thinking it's hung.

3. **Error doesn't propagate** — the MCP server marks the invocation failed at 02:35:28, but the moderator's `invoke_agent` tool call doesn't receive the error. The moderator hangs silently until the Docker containers are killed. The user sees no feedback for ~3 minutes.

### Root cause

Node.js's built-in `fetch()` uses undici under the hood. Undici enforces two internal timeouts that are independent of any `AbortSignal`:

- **`headersTimeout`**: time to receive response headers after sending the request. Default: 300,000ms (5 minutes).
- **`bodyTimeout`**: time to receive the response body after headers. Default: 300,000ms.

The agent's `/invoke` endpoint is synchronous — it doesn't send response headers until the invocation completes. For any invocation exceeding 5 minutes, undici's `headersTimeout` fires first, closing the socket with a generic "fetch failed" error that bypasses the AbortController.

### Current state

- `HttpAgentConnection.handle()` (`apps/mcp-server/src/registry/http-agent-connection.ts`, line 34-87) uses `fetch()` with an `AbortSignal` but no dispatcher/agent configuration
- `ROLE_TIMEOUTS` (`apps/mcp-server/src/messaging/role-timeouts.ts`) correctly allocates 30 minutes for developer, 10 for teamlead, etc.
- The AbortController timeout and the undici timeout are independent — whichever fires first wins

## Design Context

The invocation HTTP call is a long-poll: the MCP server sends a POST to `{callbackUrl}/invoke` and waits for the complete response. During an implementation task, no data flows on the connection for minutes — the agent is busy running tools, editing files, running tests. This idle-connection pattern is inherently fragile with default HTTP timeouts.

### Implementation — Custom undici dispatcher with extended timeouts

Create an undici `Agent` (HTTP client agent, not Quorum agent) with `headersTimeout` and `bodyTimeout` exceeding the maximum role timeout, and pass it as the `dispatcher` option to `fetch()`:

```typescript
import { Agent as UndiciAgent } from 'undici';

// In HttpAgentConnection constructor or as a module-level singleton
private readonly dispatcher = new UndiciAgent({
  headersTimeout: 35 * 60_000,  // 35 min (exceeds max role timeout of 30 min)
  bodyTimeout: 35 * 60_000,
});

// In handle()
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(request),
  signal: controller.signal,
  dispatcher: this.dispatcher,
});
```

This preserves the existing AbortController mechanism as the sole timeout authority. The undici timeouts become a ceiling that never fires before the AbortController. Minimal change (3 lines + 1 import), no architectural changes, role-specific timeouts continue to work as designed.

Note: `undici` is bundled with Node.js but may need to be added as an explicit dependency (`npm install undici`) if direct imports don't resolve.

### Files to modify

| File | Change |
|------|--------|
| `apps/mcp-server/src/registry/http-agent-connection.ts` | Add undici `Agent` dispatcher with extended timeouts, pass to `fetch()` |
| `apps/mcp-server/src/registry/http-agent-connection.spec.ts` | Add test verifying dispatcher is used (mock undici) |
| `package.json` | Add `undici` as explicit dependency if not re-exportable from Node.js built-ins |

## Acceptance Criteria

- [ ] `HttpAgentConnection.handle()` uses a `fetch()` dispatcher with `headersTimeout` and `bodyTimeout` exceeding the maximum role timeout
- [ ] The AbortController remains the sole timeout authority — undici internal timeouts never fire first
- [ ] Invocations lasting 5+ minutes complete successfully (verified by checking that `"fetch failed"` does not appear in logs)
- [ ] The fix does not affect invocations under 5 minutes
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` — all existing tests pass, no regressions

## Dependencies and References

- **Observed in:** QRM5 Run 1 (`logs/sessions/2026-04-14-qrm5-run1.md`) — developer invocation 4 at 02:30:27
- **HttpAgentConnection:** `apps/mcp-server/src/registry/http-agent-connection.ts`
- **Role timeouts:** `apps/mcp-server/src/messaging/role-timeouts.ts` — developer: 30 min
- **Node.js undici defaults:** `headersTimeout` = 300,000ms, `bodyTimeout` = 300,000ms
- **Blocks:** Any implementation invocation expected to exceed 5 minutes