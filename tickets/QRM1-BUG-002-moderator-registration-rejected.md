# QRM1-BUG-002: Moderator Registration Silently Rejected by MCP Server

## Summary

The terminal (moderator) calls `register_agent` with `role: 'moderator'`, but the tool's Zod input schema validates against `DEPLOYABLE_AGENT_ROLES` which excludes `moderator`. The server-side handler never executes. The terminal doesn't inspect the error response and logs "Registered as moderator" unconditionally.

## Problem Statement

During the QRM1-013 smoke test Run 2, `GET /registry` returned 3 agents (architect, developer, teamlead) instead of the expected 4. The moderator was missing despite terminal logs showing `"Registered as moderator at http://terminal:3001"`.

### Root Cause

Two cooperating bugs:

1. **Server-side: Zod enum excludes moderator.** The `register_agent` and `unregister_agent` tools in `McpService` validate the `role` argument against `DEPLOYABLE_AGENT_ROLES`:

   ```typescript
   role: z.enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
   ```

   `DEPLOYABLE_AGENT_ROLES` is defined in `libs/common/src/messaging/agent-role.enum.ts` as `[architect, teamlead, developer, qa, productowner]` — `moderator` is explicitly excluded. Zod rejects the input before the handler runs, returning an MCP error response.

2. **Client-side: Return value ignored.** The terminal's `McpClientService.register()` calls `this.client.callTool(...)` but never inspects the result. It unconditionally sets `this.registered = true` and logs success. The agent app's `register()` has the same pattern but doesn't trigger the bug because agent roles pass validation.

### Impact

- Moderator does not appear in `GET /registry`
- Any future broker-routed invocations targeting `moderator` will fail with "Agent moderator not registered"
- `unregister_agent` on shutdown also silently fails for the same reason

## Design Context

`DEPLOYABLE_AGENT_ROLES` was introduced to distinguish agent containers from the terminal (moderator). This distinction is valid for deployment topology but should not gate MCP registration — the moderator is a legitimate participant in the messaging system and needs to be addressable by the broker.

The `context_store` and `context_query` tools already use `Object.values(AgentRole)` for their agent role parameters, setting the precedent that all roles are valid MCP participants.

## Implementation Details

### Fix 1: Use full `AgentRole` enum in register/unregister tools

In `apps/mcp-server/src/mcp/mcp.service.ts`, change both `registerRegisterAgentTool()` and `registerUnregisterAgentTool()` to validate against all `AgentRole` values instead of `DEPLOYABLE_AGENT_ROLES`:

```typescript
role: z.enum(Object.values(AgentRole) as [string, ...string[]])
```

This matches the pattern already used by `context_store` and `context_query` in the same file.

### Fix 2: Check `callTool` return value in terminal registration

In `apps/terminal/src/connection/mcp-client.service.ts`, inspect the result of `callTool` for `isError: true` and throw/log appropriately instead of unconditionally setting `this.registered = true`.

The agent app (`apps/agent/src/connection/mcp-client.service.ts`) has the same silent-failure pattern and should receive the same fix for robustness.

### Files to modify

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Replace `DEPLOYABLE_AGENT_ROLES` with `Object.values(AgentRole)` in `register_agent` and `unregister_agent` Zod schemas |
| `apps/terminal/src/connection/mcp-client.service.ts` | Check `callTool` result for errors in `register()` and `unregister()` |
| `apps/agent/src/connection/mcp-client.service.ts` | Same `callTool` result check for consistency |

## Acceptance Criteria

- [ ] `register_agent` accepts `role: 'moderator'` and registers it in `AgentRegistry`
- [ ] `unregister_agent` accepts `role: 'moderator'`
- [ ] Terminal `register()` throws or logs an error when `callTool` returns `isError: true`
- [ ] Agent `register()` throws or logs an error when `callTool` returns `isError: true`
- [ ] `npm run test` passes
- [ ] `GET /registry` shows 4 agents (including moderator) after `docker compose up`

## Dependencies and References

### Prerequisites
- QRM1-BUG-001 — MCP Server per-session transport fix (already applied)

### What This Blocks
- QRM1-013 — Smoke test Scenario 2 (4 agents registered)
- QRM1 milestone completion

### References
- [tickets/QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — Smoke test Run 2 where bug was discovered
- `libs/common/src/messaging/agent-role.enum.ts` — `DEPLOYABLE_AGENT_ROLES` definition
- `apps/mcp-server/src/mcp/mcp.service.ts` — `register_agent` / `unregister_agent` tool definitions