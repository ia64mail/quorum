# QRM4-BUG-007: Per-Role maxTurns Configuration

## Summary

All agent invocations use a hardcoded `maxTurns: 20` default regardless of role. Implementation-heavy roles like developer regularly exhaust this limit on tasks requiring significant codebase research. Add per-role `maxTurns` configuration mirroring the existing `ROLE_TIMEOUTS` pattern, and wire it through `InvokeRequest` so the broker controls turn budgets.

## Problem Statement

In [Run 5](../logs/sessions/2026-04-02-qrm4-run5.md), the developer's first invocation failed after exhausting the 20-turn default. The developer made 34 tool calls (21 Reads for research, then Writes/Edits for implementation) across 20 turns. The SDK terminated mid-task with `error_max_turns`.

The `ExecuteParams.maxTurns` field already exists (`claude-code.types.ts:29`) and `ClaudeCodeService` already reads it (`claude-code.service.ts:46`), but `InvocationHandler.handle()` never passes it — the field is always `undefined`, always defaulting to 20.

Meanwhile, per-role *timeouts* are already differentiated in `ROLE_TIMEOUTS` (`role-timeouts.ts`):

| Role | Timeout |
|------|---------|
| architect | 5 min |
| teamlead | 10 min |
| developer | 30 min |
| qa | 15 min |
| productowner | 2 min |

Turn budgets should follow the same pattern — a developer implementing a feature needs more turns than a product owner answering a clarification.

## Design Context

The broker already owns per-role configuration (`ROLE_TIMEOUTS`) and controls the invocation lifecycle. The turn budget follows the same pattern: add `maxTurns` to `InvokeRequest`, broker sets it from `ROLE_MAX_TURNS[target]` before delivery, agent reads it in `InvocationHandler`. This keeps per-role tuning in one place (the broker), makes turn budgets visible in the invocation request for logging/observability, and mirrors `ROLE_TIMEOUTS` exactly.

## Implementation Details

### 1. Add `ROLE_MAX_TURNS` constant

**File:** `apps/mcp-server/src/messaging/role-timeouts.ts`

Rename to `role-limits.ts` (or add alongside) — add a parallel constant:

```typescript
export const ROLE_MAX_TURNS: Partial<Record<AgentRole, number>> = {
  [AgentRole.architect]: 30,        // design review — moderate research
  [AgentRole.teamlead]: 40,         // ticket creation — reads many files
  [AgentRole.developer]: 60,        // implementation — heavy research + code writing
  [AgentRole.qa]: 40,               // test writing + execution
  [AgentRole.productowner]: 10,     // clarification — minimal tool use
};
```

Keep a `DEFAULT_MAX_TURNS = 20` for roles without an entry.

### 2. Add `maxTurns` to `InvokeRequest`

**File:** `libs/common/src/messaging/invoke.types.ts`

```typescript
export interface InvokeRequest {
  // ... existing fields ...
  /** Maximum SDK turns for this invocation. Set by the broker from per-role config. */
  maxTurns?: number;
}
```

Optional field — backward-compatible. Existing requests without it continue to work (agent falls back to its local default).

### 3. Broker sets `maxTurns` before delivery

**File:** `apps/mcp-server/src/messaging/message-broker.service.ts`

In `invoke()`, after safeguard checks pass and before calling `agent.handle()`, set the turn budget:

```typescript
request.maxTurns = ROLE_MAX_TURNS[target] ?? DEFAULT_MAX_TURNS;
```

### 4. InvocationHandler passes `maxTurns` to SDK

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

In `handle()`, pass the field through to `execute()`:

```typescript
const result = await this.claudeCode.execute({
  prompt: this.buildPrompt(request),
  systemPrompt: this.promptService.getSystemPrompt(request.caller),
  mcpServers: this.bridge.createBridge(request),
  disallowedTools: this.permissions.getDisallowedTools(),
  canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
  maxTurns: request.maxTurns,   // ← new
});
```

The `ClaudeCodeService` already handles `undefined` via `params.maxTurns ?? 20`, so the fallback chain is: `request.maxTurns` → `ROLE_MAX_TURNS[target]` → `DEFAULT_MAX_TURNS` → `20`.

### 5. Log the turn budget

In `InvocationHandler.handle()`, log the received `maxTurns` in the invocation-received message:

```typescript
this.logger.log(
  `Invocation received: correlationId=${request.correlationId} ` +
    `action="${request.action}" caller=${request.caller} ` +
    `depth=${request.depth} maxTurns=${request.maxTurns ?? 'default'}`,
);
```

### Test updates

- `message-broker.service.spec.ts`: verify `maxTurns` is set on the request before delivery, using correct per-role value
- `invocation-handler.service.spec.ts`: verify `maxTurns` from request is passed through to `execute()`
- `role-timeouts.spec.ts` (or `role-limits.spec.ts`): verify all roles in the enum have an entry or default

## Acceptance Criteria

- [ ] `ROLE_MAX_TURNS` constant exists with per-role values
- [ ] `DEFAULT_MAX_TURNS` constant provides fallback
- [ ] `InvokeRequest.maxTurns` field added (optional, backward-compatible)
- [ ] `MessageBroker.invoke()` sets `request.maxTurns` from `ROLE_MAX_TURNS`
- [ ] `InvocationHandler.handle()` passes `request.maxTurns` to `ClaudeCodeService.execute()`
- [ ] Invocation-received log includes `maxTurns`
- [ ] Developer role gets at least 60 turns (sufficient for Run 5 scenario)
- [ ] Roles without explicit entry fall back to `DEFAULT_MAX_TURNS`
- [ ] Tests updated and passing
- [ ] `npm run build`, `npm run lint`, `npm run test` pass

## Dependencies and References

- **Discovered in:** [Run 5 session report](../logs/sessions/2026-04-02-qrm4-run5.md) — Issue 1
- **Existing pattern:** `ROLE_TIMEOUTS` in `apps/mcp-server/src/messaging/role-timeouts.ts`
- **Existing plumbing:** `ExecuteParams.maxTurns` (`claude-code.types.ts:29`), `ClaudeCodeService` line 46
- **Related:** QRM4-BUG-006 (error reporting) fixes the diagnostics; this ticket fixes the underlying limit
- **Related:** QRM4-BUG-008 (incremental context) reduces turns consumed by retries