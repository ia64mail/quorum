# QRM2-BUG-005: Graceful Shutdown — Context Not Persisted & Agents Reconnect During Teardown

## Summary

Two related issues prevent clean graceful shutdown. The MCP server's `InMemoryStore.onModuleDestroy()` never fires because `enableShutdownHooks()` is missing from `main.ts`, so the context file is never written. Additionally, agent and terminal `McpClientService` instances reconnect and re-register during shutdown because the `transport.onclose` handler does not check whether the application is shutting down.

## Problem Statement

During QRM2-011 validation (2026-03-15), a `persistence_test` entry was stored in the Context Store via the architect agent. After `Ctrl+C` (`docker compose down`):

1. **No `quorum.context` file was created** — the `[InMemoryStore] Context saved: ...` log line never appeared.
2. **Agents re-registered after unregistering** — the shutdown logs show agents unregistering, then immediately reconnecting and re-registering before Docker sends SIGKILL (exit code 137).

**Impact:**
- QRM2-011 file persistence is non-functional — context is lost on every restart.
- Shutdown takes longer than necessary; Docker must SIGKILL containers because the reconnection loop keeps them alive past the grace period.

## Root Cause Analysis

### Issue 1 — `enableShutdownHooks()` Missing from MCP Server

NestJS does **not** listen for SIGTERM/SIGINT by default. The `agent` and `terminal` apps both call `app.enableShutdownHooks()` (added in QRM1-007 and QRM1-010), but the MCP server's `main.ts` does not. Without this call, the `OnModuleDestroy` lifecycle hook on `InMemoryStore` is never invoked.

**File:** `apps/mcp-server/src/main.ts`

The bootstrap function goes straight from `NestFactory.create()` to `app.listen()` with no `enableShutdownHooks()` in between. Compare with `apps/agent/src/main.ts` line 10 and `apps/terminal/src/main.ts` line 11 which both have the call.

### Issue 2 — Reconnection Fires During Shutdown

When `onApplicationShutdown()` runs on agent/terminal `McpClientService`, it calls `unregister()` then `closeTransport()`. Closing the transport triggers the `transport.onclose` callback, which unconditionally calls `handleReconnection()`. The reconnection succeeds (the MCP server is still alive at this point), re-registering the agent. Docker then waits for the grace period and SIGKILL's the container.

**Sequence observed in logs:**
```
AgentRegistry: Unregistered agent: developer
McpClientService: Unregistered developer
McpClientService: MCP transport closed, attempting reconnection    ← onclose fires
McpController: Session created: 39e595f0-...                      ← reconnect succeeds
AgentRegistry: Registered agent: developer                        ← re-registered
developer-1 exited with code 137                                  ← SIGKILL
```

**Files:**
- `apps/agent/src/connection/mcp-client.service.ts` lines 92-96
- `apps/terminal/src/connection/mcp-client.service.ts` lines 80-84

## Implementation Details

### Fix 1 — Add `enableShutdownHooks()` to MCP Server

Add `app.enableShutdownHooks()` in `apps/mcp-server/src/main.ts` after `NestFactory.create()` and before `app.listen()`. This is the same pattern already used by the other two apps.

### Fix 2 — Shutdown Guard in `McpClientService`

Add a `shuttingDown` boolean flag to both `McpClientService` implementations (agent and terminal). Set it to `true` at the start of `onApplicationShutdown()`. In the `transport.onclose` callback, check the flag and return early if shutting down — skip the reconnection attempt entirely.

The `registered = false` assignment should still run (it's a cleanup), but the `handleReconnection()` call and the warning log should be guarded.

## Acceptance Criteria

- [ ] `apps/mcp-server/src/main.ts` calls `app.enableShutdownHooks()`
- [ ] `InMemoryStore.onModuleDestroy()` fires on SIGTERM, producing `Context saved: N items` log
- [ ] `quorum.context` file is written to the workspace directory on shutdown
- [ ] Context survives a restart cycle (store → shutdown → start → verify)
- [ ] Agent `McpClientService` does not reconnect during graceful shutdown
- [ ] Terminal `McpClientService` does not reconnect during graceful shutdown
- [ ] No re-registration log lines appear after unregistration during shutdown
- [ ] All containers exit with code 0 (not 137) during graceful shutdown
- [ ] `npm run test` passes with no regressions
- [ ] `npm run lint` passes with no regressions

## Dependencies and References

### Prerequisites
- None — standalone fix

### What This Blocks
- QRM2-011 file persistence is non-functional until Issue 1 is fixed
- Clean shutdown behavior for all future lifecycle hooks

### References
- Discovered during: QRM2-011 manual validation (2026-03-15)
- QRM2-011 ticket: `tickets/QRM2-011-context-store-file-persistence.md`
- QRM1-007 ticket: Added `enableShutdownHooks()` to agent app
- QRM1-010 ticket: Added `enableShutdownHooks()` to terminal app
- `apps/mcp-server/src/main.ts` — missing `enableShutdownHooks()`
- `apps/mcp-server/src/context-store/in-memory-store.ts` — `onModuleDestroy()` (lines 70-93)
- `apps/agent/src/connection/mcp-client.service.ts` — `transport.onclose` (lines 92-96)
- `apps/terminal/src/connection/mcp-client.service.ts` — `transport.onclose` (lines 80-84)
- NestJS docs: [Lifecycle Events — Application Shutdown](https://docs.nestjs.com/fundamentals/lifecycle-events#application-shutdown)