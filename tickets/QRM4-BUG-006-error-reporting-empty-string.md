# QRM4-BUG-006: SDK Error Reporting — Empty String Hides Failure Subtype

## Summary

When the Claude Code SDK returns a failure result with an empty `errors` array, `ClaudeCodeService.processMessage()` logs `error=""` instead of the actual failure subtype (e.g. `error_max_turns`). A secondary gap: the failure log path in `InvocationHandler.logResult()` omits `numTurns`, making turn exhaustion undiagnosable from logs alone.

## Problem Statement

Observed in [Run 5](../logs/sessions/2026-04-02-qrm4-run5.md) — the developer's first invocation failed after 34 tool calls and 110s:

```
19:54:59.750 warn InvocationHandler — Invocation failed: correlationId=9d574a22... error="" cost=$0.7297 duration=110093ms
```

The empty error string made root cause analysis require manual log correlation and code reading. The actual failure was `error_max_turns` — the SDK exhausted its 20-turn default.

**Root cause:** In `apps/agent/src/llm/claude-code.service.ts:152`:

```typescript
error: message.errors?.join('; ') ?? message.subtype,
```

When the SDK returns `errors: []` (empty array), `.join('; ')` produces `""` (empty string). The nullish coalescing operator `??` only triggers on `null`/`undefined`, not on empty string — so `message.subtype` (which contains the actual failure reason) is never reached.

**Secondary issue:** The failure branch of `InvocationHandler.logResult()` (line 114-118) logs `error`, `cost`, and `duration` but not `numTurns`. The success branch logs `turns=N` but the failure branch does not. This means turn exhaustion can only be diagnosed by counting SDK tool log entries manually.

## Implementation Details

### Fix 1: `??` to `||` in `processMessage()`

**File:** `apps/agent/src/llm/claude-code.service.ts:152`

Change the nullish coalescing operator to a logical OR, so that empty string (falsy) falls through to `message.subtype`:

```typescript
// Before
error: message.errors?.join('; ') ?? message.subtype,

// After
error: message.errors?.join('; ') || message.subtype,
```

This ensures:
- `errors: undefined` → `undefined || subtype` → subtype (correct, same as before)
- `errors: []` → `"" || subtype` → subtype (fixed — was previously `""`)
- `errors: ['msg']` → `"msg" || subtype` → `"msg"` (correct, same as before)
- `errors: ['a', 'b']` → `"a; b" || subtype` → `"a; b"` (correct, same as before)

### Fix 2: Add `numTurns` to failure result and failure log

The SDK's `result` message includes `num_turns` regardless of success/failure subtype. Currently the failure branch of `processMessage()` does not extract it, and `ExecuteResult` failure branch does not carry it.

**File:** `apps/agent/src/llm/claude-code.types.ts`

Add `numTurns` to the failure branch of `ExecuteResult`:

```typescript
| {
    success: false;
    error: string;
    durationMs: number;
    totalCostUsd: number;
    numTurns?: number;   // ← add (optional — may not be present on pre-API failures)
  };
```

**File:** `apps/agent/src/llm/claude-code.service.ts:150-155`

Include `numTurns` in the failure return:

```typescript
return {
  success: false,
  error: message.errors?.join('; ') || message.subtype,
  durationMs: message.duration_ms,
  totalCostUsd: message.total_cost_usd,
  numTurns: message.num_turns,
};
```

**File:** `apps/agent/src/connection/invocation-handler.service.ts:114-118`

Add turn count to the failure log:

```typescript
this.logger.warn(
  `Invocation failed: ${base} error="${result.error}" ` +
    `turns=${result.numTurns ?? '?'} ` +
    `cost=$${result.totalCostUsd.toFixed(4)} duration=${result.durationMs}ms`,
);
```

### Test updates

Update existing test fixtures in `claude-code.service.spec.ts` that assert on the failure path to verify:
- `errors: []` now produces the subtype string, not `""`
- `errors: undefined` still produces the subtype string
- `errors: ['x']` still produces `"x"`
- Failure result includes `numTurns` when present

Update `invocation-handler.service.spec.ts` to verify the failure log includes `turns=`.

## Acceptance Criteria

- [ ] `errors: []` produces `error: message.subtype` (not `""`)
- [ ] `errors: undefined` still produces `error: message.subtype`
- [ ] `errors: ['msg']` still produces `error: "msg"`
- [ ] `ExecuteResult` failure branch includes optional `numTurns`
- [ ] `processMessage()` failure return includes `numTurns` from SDK result
- [ ] `logResult()` failure path logs `turns=N` (or `turns=?` when unavailable)
- [ ] Existing tests updated and passing
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes

## Dependencies and References

- **Discovered in:** [Run 5 session report](../logs/sessions/2026-04-02-qrm4-run5.md) — Issue 1
- **Files touched:** `claude-code.service.ts`, `claude-code.types.ts`, `invocation-handler.service.ts`, and their spec files
- **Related:** QRM4-BUG-007 (per-role maxTurns) addresses the underlying turn exhaustion; this ticket fixes the reporting