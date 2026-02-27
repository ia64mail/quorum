# QRM1-BUG-003: InvocationHandler Does Not Log Correlation ID

## Summary

The `InvocationHandler` logs incoming invocations with `action` and `caller` but omits the `correlationId`. This makes cross-service log tracing incomplete for direct agent invocations — correlation IDs only appear in `MessageBroker` logs for broker-routed requests.

## Problem Statement

During QRM1-013 smoke test Run 2, Scenario 8 (Log Correlation) checked for `correlationId` values across service logs:

- `smoke-test-001` and `smoke-test-002` (direct invocations to architect/developer) — **not found** in any logs
- `smoke-test-003` and `smoke-test-004` (broker-routed via `/test/invoke`) — found in `MessageBroker` logs on the MCP server

The architect's `InvocationHandler` logged:
```
Invocation received: action="Respond with exactly: SMOKE_TEST_OK" caller=moderator depth=0
```

The `correlationId` field is present in the `InvokeRequest` DTO but not included in the log message. For broker-routed requests the `MessageBroker` logs it, but for direct HTTP invocations (which bypass the broker) the correlation ID is lost entirely.

### Impact

- Cross-service tracing is broken for direct invocations
- Debugging production issues requires matching timestamps instead of correlation IDs
- The smoke test's Scenario 8 cannot fully pass

## Implementation Details

### Fix: Add correlationId to InvocationHandler log messages

In `apps/agent/src/invocation/invocation.handler.ts`, include `correlationId` in the log message for incoming invocations:

```
Invocation received: correlationId=smoke-test-001 action="..." caller=moderator depth=0
```

Also include it in any subsequent log messages within the same invocation flow (tool calls, completion, errors) to enable full tracing.

### Files to modify

| File | Change |
|------|--------|
| `apps/agent/src/invocation/invocation.handler.ts` | Add `correlationId` to all log messages |

## Acceptance Criteria

- [ ] `InvocationHandler` log messages include `correlationId` field
- [ ] `correlationId` appears in logs for tool calls and completion within the same invocation
- [ ] `npm run test` passes
- [ ] Smoke test Scenario 8 finds correlation IDs in both MCP server and agent logs

## Dependencies and References

### Prerequisites
- None

### What This Blocks
- QRM1-013 — Smoke test Scenario 8 full pass

### References
- [tickets/QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — Smoke test Run 2, Scenario 8
- `apps/agent/src/invocation/invocation.handler.ts` — InvocationHandler implementation
- `libs/common/src/messaging/invoke-request.ts` — InvokeRequest DTO with `correlationId` field