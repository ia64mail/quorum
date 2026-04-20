# QRM5-BUG-005: Agents Fail to Re-register With MCP Server After mcp-server Restart

## Summary

When the mcp-server container restarts, agent containers (architect, teamlead, developer, terminal/moderator) do not detect the closed transport and do not reconnect. The agents' `McpClientService.transport.onclose` handler exists and would drive `handleReconnection()` → `register()` → `discoverTools()` if triggered — but on a server restart the transport stays in a zombie state where `onclose` never fires, so agents sit idle with a stale session ID until they're manually restarted. Any subsequent tool call returns `Session not found` and `GET /registry` shows an empty `agents` array.

## Problem Statement

Reproduced during QRM5-008 smoke test on 2026-04-18:

1. `docker compose restart mcp-server` at 00:38:37.
2. mcp-server came back cleanly: `MCP tools and resources registered`, health endpoint green, 4-agent registry on the server side empty.
3. No reconnection attempts from any agent over the next ~2 minutes. Agent logs showed no `MCP transport closed` warning, no `connectWithRetry` entries.
4. A subsequent `invoke_agent` call to teamlead (initiated via the orchestrator) returned a bubbled-up `Session not found` — teamlead's MCP client still held session `fe3bc36c-94e9-4d2f-817f-d9db18886d36`, which was gone.
5. `curl /registry` → `{"agents":[]}` confirmed all four agents were unregistered on the server side without any of them noticing.
6. Recovery required `docker compose restart architect teamlead developer terminal`.

**Impact:**

- Restarting mcp-server (for a config change, a bugfix rollout, a crash-and-docker-restart) silently breaks the whole stack. The user sees "Session not found" on the next invocation, and manual intervention is needed on every agent. This is opaque to operators who reasonably expect the agents to self-heal.
- In production use this means any mcp-server redeploy is a coordinated restart of the entire fleet rather than a rolling update.
- The symptom is the same as if the agents were never there — `GET /registry` → `[]` — which is misleading (they're up, just disconnected).

**Related but different from QRM1-BUG-001** (single-transport-per-server bug, resolved). That was a server-side issue that broke *fresh* connections. This is a client-side issue that breaks *existing* connections when the server restarts under them.

## Design Context

### The reconnection code exists

`apps/agent/src/connection/mcp-client.service.ts`:

```typescript
this.transport.onclose = () => {
  this.registered = false;
  if (this.shuttingDown) return;
  this.logger.warn('MCP transport closed, attempting reconnection');
  void this.handleReconnection();
};
```

`handleReconnection()` → `connectWithRetry()` (10 attempts, linear backoff) → `register()` → `discoverTools()`. If `onclose` fired, the agent would reconnect cleanly.

### Why `onclose` doesn't fire

The Streamable HTTP transport holds a long-lived SSE connection for server-initiated messages and opens short `fetch` POSTs for client→server calls. When the server process dies and restarts, there is no clean TLS/HTTP close handshake — the kernel keeps the old socket in `ESTABLISHED` state until the next packet attempt (same territory as QRM5-BUG-003). On the agent's side, the transport never observes a close event because:

- The SSE stream's `fetch` response never errors (read buffer is empty but the connection is "still open").
- No heartbeat/ping is sent over the SSE channel by either side.
- The next client-initiated request will get a TCP RST or a 404 from the new server instance — but that error is raised at `callTool()` time, not routed through `onclose`.

So the "dead transport" state is indefinite absent external traffic.

### Why session ID mismatch isn't caught

When a `callTool()` is made with a stale session ID, the new server returns `Session not found` (404). The MCP client surfaces this as a tool-call error, not as a transport-close. The `onclose` handler never sees it, and there is no cross-cutting interceptor that converts "session-not-found" into "reconnect."

## Implementation Details

Two complementary fixes — one reactive (client-side), one proactive (server-side) — that together eliminate the zombie-transport problem and ensure agents self-heal after an mcp-server restart.

### Part 1 — Session-not-found → reconnect (client-side)

Wrap `callTool()` in `McpClientService` with error interception. When the error message contains `Session not found` (or the equivalent MCP SDK error signature):

1. Log a WARN-level message identifying the stale session ID and the session-not-found response.
2. Close the current transport to clean up the zombie connection.
3. Call `handleReconnection()` to establish a fresh session.
4. Retry the original `callTool()` once transparently.
5. If the retry also fails, surface the error to the caller.

This is the reactive safety net: even if the SSE keepalive (Part 2) hasn't triggered `onclose` yet, the first tool call that hits the new server will self-heal. The caller sees at most one brief delay (reconnection + retry) rather than a hard failure.

Apply the same fix to both MCP client implementations:
- `apps/agent/src/connection/mcp-client.service.ts` (agent roles)
- `apps/terminal/src/connection/mcp-client.service.ts` (moderator/terminal)

### Part 2 — SSE stream keepalive (server-side)

Have the MCP server emit a periodic SSE comment (`: ping\n\n`) on the long-lived server→client stream. This achieves three things:

- **Clean break on restart:** When the server restarts, the new process does not inherit the old socket's SSE write loop. The client's SSE `fetch` response errors out, `onclose` fires, and the existing `handleReconnection()` path kicks in — resolving the root cause (zombie transport where `onclose` never fires).
- **Proxy/conntrack keepalive:** Intermediate network layers won't close an idle connection, preventing a secondary class of silent disconnection.
- **QRM5-BUG-003 mitigation:** The same SSE keepalive addresses the long-idle-stream stall diagnosed in QRM5-BUG-003, since it closes the window where conntrack drops an idle connection without either side noticing.

**Interval:** 30 seconds — frequent enough to detect a server restart within one heartbeat, infrequent enough to add negligible traffic.

**Server-side implementation:** In `McpController` or `McpService`, start a `setInterval` that writes `: ping\n\n` to each active SSE response stream. Clean up the interval on connection close (response `close` event). The `: ping` is an SSE comment — compliant clients ignore it silently, so no protocol-level changes are needed.

### Excluded approach — Periodic health-check heartbeat

A periodic agent-side heartbeat (calling `/health` or a cheap MCP tool every 30–60s) was considered but excluded. The SSE keepalive in Part 2 achieves the same liveness detection at the transport layer without requiring each agent to run its own polling loop. Adding agent-side polling on top would be redundant.

### Tests

- **Unit — session-not-found reconnect:** Simulate a `Session not found` error from `callTool()`, verify `McpClientService` logs a WARN, calls `handleReconnection()`, and retries the call once.
- **Unit — retry failure:** Simulate `Session not found` on both the original call and the retry, verify the error is surfaced to the caller after one retry attempt.
- **Unit — SSE keepalive:** Verify the server emits `: ping\n\n` comments at the configured interval on active SSE streams.
- **Integration — QRM5-008 scenario:** Add a new runbook scenario (or extend Scenario 5) that performs `docker compose restart mcp-server` and verifies all agents re-register within ≤ 2 minutes with no agent container restarts.

## Acceptance Criteria

### Client-side reconnect (Part 1)
- [x] `McpClientService.callTool()` intercepts `Session not found` errors, logs a WARN with the stale session ID, triggers `handleReconnection()`, and retries the call once
- [x] If the retry also fails, the error is surfaced to the caller (no infinite retry loop)
- [x] Fix is applied to both `apps/agent/` and `apps/terminal/` MCP client implementations
- [x] Unit test: `McpClientService` reconnects and retries on session-not-found
- [x] Unit test: retry failure after session-not-found surfaces the error

### SSE keepalive (Part 2)
- [x] MCP server emits `: ping\n\n` SSE comments at ~30s intervals on all active SSE streams
- [x] Keepalive intervals are cleaned up on connection close (no leaked timers)
- [x] Unit test: SSE keepalive emits ping comments at the configured interval

### End-to-end
- [ ] After `docker compose restart mcp-server`, all four agents re-appear in `GET /registry` within ≤ 2 minutes with **no agent container restarts**
- [ ] First tool call after the server restart either succeeds transparently (reconnect + retry) or fails once with a clear WARN-level log and succeeds on the next attempt
- [ ] New QRM5-008 runbook scenario (or extension of Scenario 5) verifies agent self-heal after mcp-server restart
- [x] `npm run build`, `npm run lint`, `npm run test` all pass

## Implementation Notes

**Status:** Accepted (code review passed, end-to-end criteria pending live stack validation)

**Files modified:**

| File | Change |
|------|--------|
| `apps/agent/src/connection/mcp-client.service.ts` | Wrapped `callTool()` with try/catch session-not-found interception, added `isSessionNotFound()` private helper |
| `apps/terminal/src/connection/mcp-client.service.ts` | Mirror of agent-side session-not-found interception |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Added `startSseKeepalive()` private method, `SSE_KEEPALIVE_INTERVAL_MS` constant (30s), wired into `handleGet()` |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | +3 tests: reconnect-and-retry, retry failure, non-session-not-found passthrough |
| `apps/terminal/src/connection/mcp-client.service.spec.ts` | +3 tests: mirror of agent spec |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | +4 tests: ping emission, close cleanup, writableEnded guard, 404 skip; added `write`/`writableEnded` to MockResponse |

**Deviations from ticket:**
- WARN log includes tool name rather than stale session ID — the session ID is internal to the SDK's `StreamableHTTPClientTransport` and not exposed via public API. Tool name provides sufficient diagnostic context.
- `mcp.service.ts` was not modified — keepalive timer lives entirely in the controller's `startSseKeepalive()`, keeping transport lifecycle concerns co-located with the HTTP handler.

**Verification:** `npm run build` (4 apps compiled), `npm run lint` (0 errors, 0 warnings), `npm run test` (49 suites, 755 tests, all passed).

## Dependencies and References

- **Surfaced by:** [QRM5-008](QRM5-008-tests.md) Run 1, Scenario 5 follow-up (2026-04-18)
- **Related:** [QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md) — same class of symptom (ESTABLISHED-but-dead SSE stream). Part 2 (SSE keepalive) doubles as a mitigation for QRM5-BUG-003 since it closes the long-idle window that likely triggers the stall.
- **Related:** [QRM1-BUG-001](QRM1-BUG-001-mcp-server-single-transport.md) — precedent for MCP connection lifecycle bugs, resolved; the agent reconnection path was added partly in response but is not exercised under server-restart conditions.

**Key files:**

| File | Relevance |
|------|-----------|
| `apps/agent/src/connection/mcp-client.service.ts` | Part 1 — wrap `callTool()` with session-not-found interception, WARN log, reconnect + retry |
| `apps/terminal/src/connection/mcp-client.service.ts` | Part 1 — mirror the same session-not-found → reconnect fix for the moderator client |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Part 2 — emit `: ping\n\n` SSE keepalive on the long-lived server→client stream |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Part 2 — related transport lifecycle, may need keepalive timer coordination |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | Tests — session-not-found reconnection + retry unit tests |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | Tests — SSE keepalive emission unit tests |