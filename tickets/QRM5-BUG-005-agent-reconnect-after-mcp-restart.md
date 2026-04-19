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

Multiple layered fixes are possible; they can ship independently.

### Option A — Session-not-found → reconnect (minimum viable)

Wrap `callTool()` in `McpClientService`. On error, inspect whether the error is `Session not found` (or the equivalent MCP SDK signature). If so, close the current transport and call `handleReconnection()` before returning the error (or retrying the call once, transparently).

Tradeoff: reactive. The first caller after a server restart still sees an error. Subsequent calls work.

### Option B — Periodic heartbeat (stronger)

Every 30–60s, agents call an ultra-cheap MCP tool (or the server's HTTP `/health`) to prove the transport is live. On failure, trigger `handleReconnection()`. Converts "dead until next real request" into "dead for at most one heartbeat interval." Adds background traffic but the volume is negligible.

### Option C — Stream-level keepalive (deepest)

Have the MCP server emit a periodic SSE comment (`: ping\n\n`) on the long-lived stream. SSE clients handle this transparently and it keeps intermediate layers (conntrack, proxies) from closing the connection — and, critically, when the server restarts, the stream breaks cleanly and `onclose` fires. Requires server-side change in `McpController` or `McpService`.

**Recommended combination:** Option A (fast, safe, mostly sufficient) now, then option C once QRM5-BUG-003 is root-caused (they share a diagnosis surface — both are about SSE stream liveness). Option B is a reasonable alternative to C if C proves complex.

### Tests

- Unit: simulate `Session not found` from `callTool()`, verify `McpClientService` calls `handleReconnection()` and retries once.
- Integration: the runbook Scenario 5 variant where mcp-server restarts — after the restart, within N seconds the agents should re-register without container restarts. Add as a new scenario in QRM5-008 Part 3.

### Observational improvement (ships independently)

Add a WARN log on `callTool()` when the server returns `Session not found` — currently this error surfaces only as a bubbled-up tool result, with no dedicated log. At minimum, agents should complain loudly about session-ID mismatches even before a real fix ships.

## Acceptance Criteria

- [ ] After `docker compose restart mcp-server`, all four agents re-appear in `GET /registry` within ≤ 2 minutes with **no agent container restarts**
- [ ] First tool call after the server restart either succeeds (reconnect raced ahead) or fails once with a clear warn-level log and succeeds on the next attempt
- [ ] `McpClientService` emits a log line when a `Session not found` error is observed and when reconnection is triggered by that path
- [ ] Unit test: `McpClientService` reconnects on session-not-found
- [ ] New QRM5-008 Scenario (or extension of Scenario 5) verifies agent self-heal after mcp-server restart
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass

## Dependencies and References

- **Surfaced by:** [QRM5-008](QRM5-008-tests.md) Run 1, Scenario 5 follow-up (2026-04-18)
- **Related:** [QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md) — same class of symptom (ESTABLISHED-but-dead SSE stream). Option C here (SSE keepalive) may double as a mitigation for QRM5-BUG-003 since it closes the long-idle window that likely triggers the stall.
- **Related:** [QRM1-BUG-001](QRM1-BUG-001-mcp-server-single-transport.md) — precedent for MCP connection lifecycle bugs, resolved; the agent reconnection path was added partly in response but is not exercised under server-restart conditions.

**Key files:**

| File | Relevance |
|------|-----------|
| `apps/agent/src/connection/mcp-client.service.ts` | Primary fix site — wrap `callTool`, trigger reconnection on session-not-found, add heartbeat |
| `apps/terminal/src/connection/mcp-client.service.ts` | Terminal (moderator) client — mirror any fix applied to the agent client |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | For option C — emit SSE keepalive on the long-lived stream |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Related transport lifecycle |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | Extend with session-not-found reconnection test |