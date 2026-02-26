# QRM1-012: End-to-End Connectivity Smoke Test

## Summary

Add runtime observability to the MCP server with a registry status endpoint and a gated test endpoint for deterministic safeguard verification. Deliver a smoke test runbook for validating the QRM1 milestone's success criterion — all containers register, communicate, and enforce broker safeguards — against the live Docker deployment.

## Problem Statement

QRM1-001 through QRM1-011 built the full communication infrastructure: MCP server, message broker with safeguards, agent registration, invocation routing, LLM tool loops, role prompts, and Docker containerization. Every component is individually unit-tested (251 tests), but the integrated system has never been verified as a whole. The QRM1 milestone's success criterion — "`docker compose up` brings up MCP server + 4 agent containers that register and communicate" — is currently unverified.

Two gaps block end-to-end verification:

- **No runtime registry visibility** — The `AgentRegistry` tracks connected agents internally but exposes no HTTP endpoint. Verifying "are all 4 agents registered?" requires reading container logs and inferring state from broker behavior. A `GET /registry` endpoint provides direct, scriptable verification.

- **No way to test broker safeguards deterministically** — The broker's safeguards (depth limit, unavailable role, circular call) are well-tested in unit tests, but verifying them in the integrated Docker system requires routing requests through the MCP protocol (JSON-RPC), which is complex to script with `curl`. A lightweight `POST /test/invoke` endpoint that routes directly through `MessageBroker.invoke()` enables simple HTTP-based safeguard testing. Gated behind `ENABLE_TEST_ENDPOINTS=true` to prevent production exposure.

## Design Context

### Registry Status Endpoint

Follows the `HealthController` pattern — plain NestJS controller, no terminus, no auth. The `AgentRegistry.getAll()` method already exists and returns `AgentConnection[]` with `role` and `isConnected()`. The controller maps these to JSON:

```json
{
  "agents": [
    { "role": "architect", "connected": true },
    { "role": "teamlead", "connected": true },
    { "role": "developer", "connected": true },
    { "role": "moderator", "connected": true }
  ]
}
```

Exposes role + connected status only. No callback URLs (internal implementation detail).

### Test Invoke Endpoint

A `POST /test/invoke` endpoint on the MCP server that accepts an `InvokeRequest` body and routes directly through `MessageBroker.invoke()`. Bypasses MCP protocol complexity and allows direct `curl`-based safeguard testing. Reuses the same Zod validation schema as the agent's `InvocationController`.

Gated: the `TestModule` is only imported by `McpServerModule` when `ENABLE_TEST_ENDPOINTS=true`. The env var is set in `docker-compose.yml` for the mcp-server service.

### Smoke Test Strategy

The runbook uses `curl` and `docker compose exec` against the running Docker system. Agent ports are not mapped to host (only mcp-server:3000 is port-mapped), so live agent scenarios use `docker compose exec mcp-server` to run requests from inside the Docker network.

Scenarios split into deterministic (crafted HTTP, no LLM) and live LLM (require Anthropic API key):

| Scenario | Type | Endpoint |
|----------|------|----------|
| Service health | Deterministic | `GET /health` |
| Agent registration | Deterministic | `GET /registry` |
| Single-hop invocation | Live LLM | `POST /invoke` (via exec) |
| Context store relay | Live LLM | `POST /invoke` (via exec) |
| Unavailable role safeguard | Deterministic | `POST /test/invoke` |
| Depth limit safeguard | Deterministic | `POST /test/invoke` |
| Circular call safeguard | Live LLM | `POST /invoke` (via exec) |
| Log correlation | Deterministic (post-hoc) | `docker compose logs` |

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `GET /registry` endpoint on MCP server | Auth/access control on endpoints |
| `POST /test/invoke` gated test endpoint | Automated CI integration test suite |
| Smoke test runbook (`tickets/QRM1-013-smoke-test-runbook.md`) | Scripted test harness or test framework |
| `ENABLE_TEST_ENDPOINTS` env var gating | Production deployment hardening |
| Unit tests for new controllers | Load testing or performance benchmarks |
| Docker Compose env var addition | Additional Docker Compose service changes |

## Implementation Details

### 1. Registry Controller — `apps/mcp-server/src/registry/`

`RegistryController` with `@Controller('registry')` and single `@Get()` route. Injects `AgentRegistry`, maps `getAll()` to `{ agents: [{ role, connected }] }`. Added to `RegistryModule` controllers array and exported from barrel `index.ts`.

### 2. Test Controller — `apps/mcp-server/src/testing/`

New module directory with `TestController`, `TestModule`, and barrel export. `TestController` has `@Controller('test')` with `@Post('invoke')` route. Validates body with Zod schema (same as agent's `InvocationController`), passes to `MessageBroker.invoke()`, returns `InvokeResponse` directly.

`TestModule` imports `MessagingModule` (provides `MessageBroker`). Conditionally imported in `McpServerModule` when `process.env.ENABLE_TEST_ENDPOINTS === 'true'`.

### 3. Docker Compose — `docker-compose.yml`

Added `ENABLE_TEST_ENDPOINTS: "true"` to the mcp-server service environment block. No other compose changes.

### 4. Smoke Test Runbook — `tickets/QRM1-013-smoke-test-runbook.md`

Eight sequential verification scenarios covering health, registration, invocation, context store relay, three broker safeguards, and log correlation. Includes prerequisites, expected outputs, and a result summary table.

## Acceptance Criteria

- [ ] `GET /registry` returns registered agents with role and connected status
- [ ] `RegistryController` has unit tests
- [ ] `RegistryModule` includes `RegistryController`
- [ ] `POST /test/invoke` routes through `MessageBroker.invoke()` and returns response
- [ ] `TestController` has unit tests
- [ ] `TestModule` only loaded when `ENABLE_TEST_ENDPOINTS=true`
- [ ] `docker-compose.yml` sets `ENABLE_TEST_ENDPOINTS=true` for mcp-server
- [ ] `tickets/QRM1-013-smoke-test-runbook.md` covers all 8 scenarios
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (all existing + new tests)

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-24

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/registry/registry.controller.ts` | Created | `@Controller('registry')`, `@Get()` returns `{ agents: [{ role, connected }] }` by mapping `AgentRegistry.getAll()` |
| `apps/mcp-server/src/registry/registry.controller.spec.ts` | Created | 3 tests: empty registry, agents with connected status, all 4 QRM1 agents |
| `apps/mcp-server/src/registry/registry.module.ts` | Modified | Added `RegistryController` to controllers array |
| `apps/mcp-server/src/registry/index.ts` | Modified | Added `RegistryController` export |
| `apps/mcp-server/src/testing/test.controller.ts` | Created | `@Controller('test')`, `@Post('invoke')` with Zod validation, routes through `MessageBroker.invoke()` |
| `apps/mcp-server/src/testing/test.controller.spec.ts` | Created | 4 tests: valid request passthrough, error response passthrough, invalid body rejection, missing fields rejection |
| `apps/mcp-server/src/testing/test.module.ts` | Created | Imports `MessagingModule`, declares `TestController` |
| `apps/mcp-server/src/testing/index.ts` | Created | Barrel export for `TestController` and `TestModule` |
| `apps/mcp-server/src/mcp-server.module.ts` | Modified | Conditional `TestModule` import when `ENABLE_TEST_ENDPOINTS=true` |
| `docker-compose.yml` | Modified | Added `ENABLE_TEST_ENDPOINTS: "true"` to mcp-server environment |
| `tickets/QRM1-013-smoke-test-runbook.md` | Created | 8 scenarios: health, registration, single-hop invocation, context store relay, unavailable role, depth limit, circular call, log correlation |

## Dependencies and References

### Prerequisites
- QRM1-004 — Message Broker with 4 safeguards
- QRM1-005 — MCP Server Bootstrap
- QRM1-007 — Agent-to-Server Connection (AgentRegistry, HttpAgentConnection)
- QRM1-011 — Docker Containerization (health endpoint pattern, compose configuration)

### What This Blocks
- QRM1 milestone completion — this ticket provides the final verification

### References
- [tickets/QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — The runbook produced by this ticket
- [docs/system-design.md](../docs/system-design.md) — Overall architecture, container topology
- [docs/message-broker.md](../docs/message-broker.md) — Broker safeguards (depth, circular, availability, timeout)
