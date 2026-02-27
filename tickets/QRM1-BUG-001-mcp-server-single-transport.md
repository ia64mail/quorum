# QRM1-BUG-001: MCP Server Rejects Concurrent Agent Connections

## Summary

The MCP server crashes with "Already connected to a transport" when multiple agents connect simultaneously. A single `McpServer` instance is shared across all sessions, but the MCP SDK only allows one transport per `McpServer`. The fix is to create per-session `McpServer` instances.

## Problem Statement

During the QRM1-012 E2E smoke test, `docker compose up` starts 4 agents (architect, teamlead, developer, terminal) that all attempt to connect to the MCP server via Streamable HTTP transport. The first connection succeeds, but all subsequent connections fail with:

```
Error: Already connected to a transport. Call close() before connecting to a new
transport, or use a separate Protocol instance per connection.
```

This is a **blocking bug** — the system cannot operate with more than one agent connected. The QRM1 milestone's success criterion ("4 agent containers that register and communicate") cannot be met.

### Root Cause

`McpService` creates a single `McpServer` instance in its constructor and reuses it for every `connect()` call. The MCP SDK's `McpServer` internally extends `Protocol`, which maintains a 1:1 relationship with a transport. Calling `connect()` a second time without `close()` throws.

The `McpController` correctly creates per-session `StreamableHTTPServerTransport` instances, but passes them all to the same `McpServer` via `McpService.connect()`.

### Secondary Issue

Also discovered during startup: `McpServerConfigModule` exports `McpServerConfigService` but is not `@Global()`. Modules like `MessagingModule` and `McpModule` that inject `McpServerConfigService` fail with dependency resolution errors unless they explicitly import `McpServerConfigModule`. This was fixed during the smoke test session by adding `@Global()` to `McpServerConfigModule` — that fix is already applied.

## Design Context

The MCP SDK's architecture dictates one transport per `Protocol` (and by extension per `McpServer`) instance. The SDK error message itself prescribes the solution: "use a separate Protocol instance per connection."

Since all MCP tool handlers close over shared NestJS services (`MessageBroker`, `ContextStore`, `AgentRegistry`, `McpServerConfigService`), creating per-session `McpServer` instances does not fragment state — each session's tools route through the same singleton services.

## Implementation Details

### Refactor `McpService` to per-session server factory

Extract tool/resource registration into a `registerTools(server: McpServer)` method. Change `connect()` to create a new `McpServer` instance per session, register all tools on it, then connect the transport.

The existing `this.server` field and `onModuleInit()` call should be preserved — tests use `service.server` to access registered tool handlers via SDK internals (see `mcp.service.spec.ts` helper functions `getToolHandler`, `getResourceHandler`).

```
connect(transport):
  session = new McpServer(...)
  registerTools(session)
  session.connect(transport)
```

### Files to modify

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Extract `registerTools(server)`, change all `registerXxx()` methods to accept a server param, create per-session server in `connect()` |

### Fix session registration ordering in `McpController`

Discovered during implementation: `McpController.handlePost()` read `transport.sessionId` **before** calling `transport.handleRequest()`. The `StreamableHTTPServerTransport` only generates its session ID during `handleRequest` (when processing the `initialize` message), so `transport.sessionId` was always `undefined` at the point it was read. The session was never stored in the `sessions` map, causing all subsequent requests with an `mcp-session-id` header to 404 with "Session not found".

Fix: move `transport.handleRequest()` **before** reading `transport.sessionId` and registering the session in the map.

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Move `handleRequest()` before session ID read and map registration |

## Acceptance Criteria

- [x] `McpService.connect()` creates a new `McpServer` per session instead of reusing the singleton
- [x] Tool/resource registration is extracted into a reusable `registerTools(server)` method
- [x] Existing `service.server` field preserved for test compatibility
- [x] `McpController` session registration happens after `handleRequest` so session ID is available
- [x] `npm run test` passes (all 258 existing tests)
- [x] `docker compose up` succeeds with all 4 agents registering (verified via `GET /registry`)

## Implementation Notes

Completed in two changes:

**1. `apps/mcp-server/src/mcp/mcp.service.ts`** — Per-session `McpServer` factory

- Extracted `registerTools(server: McpServer)` private method that orchestrates all tool/resource registration.
- All nine `registerXxx()` methods now accept a `server` parameter instead of using `this.server`.
- `connect()` creates a fresh `McpServer` instance, calls `registerTools()` on it, then connects the transport.
- `onModuleInit()` still calls `registerTools(this.server)` so tests that access `service.server._registeredTools` continue to work.
- Shared NestJS services (`MessageBroker`, `ContextStore`, `AgentRegistry`, `McpServerConfigService`) remain singletons — per-session servers do not fragment state.

**2. `apps/mcp-server/src/mcp/mcp.controller.ts`** — Session registration ordering

- Moved `transport.handleRequest(req, res, req.body)` before reading `transport.sessionId`.
- The `StreamableHTTPServerTransport` generates its session ID inside `handleRequest` when processing the `initialize` JSON-RPC message. Reading it beforehand always returned `undefined`.
- Without this fix, the session was never stored in the `sessions` map, so every follow-up request with `mcp-session-id` header returned 404 "Session not found".

## Dependencies and References

### Prerequisites
- QRM1-005 — MCP Server Bootstrap (introduced `McpService`)
- QRM1-007 — Agent-to-Server Connection (agent registration flow)

### What This Blocks
- QRM1-012 — E2E Connectivity Smoke Test (cannot complete without this fix)
- QRM1 milestone completion

### References
- [tickets/QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — Smoke test where bug was discovered
- [tickets/QRM1-012-e2e-connectivity-smoke-test.md](QRM1-012-e2e-connectivity-smoke-test.md) — Ticket that produced the smoke test
- MCP SDK source: `Protocol.connect()` enforces single-transport constraint