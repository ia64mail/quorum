# QRM4-BUG-010: Reduce Agent Turn Consumption and Remove Hardcoded maxTurns Default

## Summary

Developer agents hit `error_max_turns` on two consecutive implementation runs (Run 5: QRM4-002, Run 7: QRM4-003) despite BUG-008's checkpointing mitigation. The hardcoded `maxTurns: 20` fallback in `ClaudeCodeService` likely conflicts with the SDK's own default, and developer prompts waste ~43% of turns on non-implementation overhead (TodoWrite, sequential verification). Remove the hardcoded default, reduce turn waste via prompt and permission changes, and add TodoWrite to the developer disallowed tools list.

## Problem Statement

**The `error_max_turns` failure is the most frequent agent failure mode**, occurring in 2 of 4 implementation runs (50% failure rate for developer implementation tasks). BUG-008 (incremental checkpointing) reduced recovery cost from full re-research to ~$0.20/10 turns, but did not prevent the failure itself.

Three contributing factors:

### 1. Hardcoded `maxTurns: 20` conflicts with SDK semantics

`ClaudeCodeService` passes `maxTurns: params.maxTurns ?? 20` to the SDK (`claude-code.service.ts:46`). However, the SDK type definitions reveal ambiguity:

- Agent definition (`sdk.d.ts:65`): *"Maximum number of agentic turns (API round-trips)"*
- Query options (`sdk.d.ts:855`): *"Maximum number of conversation turns. A turn consists of a user message and assistant response."*

Agents routinely complete 30-40 reported `num_turns` without hitting the limit (Run 5 developer retry: 35 turns, Run 5 teamlead: 40 turns), while the limit triggers at 20-21. This indicates the SDK's internal counting differs from `num_turns` in results, and our `?? 20` may be imposing a tighter constraint than the SDK's own default.

### 2. TodoWrite wastes ~6 turns per implementation cycle

In Run 7's failed QRM4-003 attempt, the developer made 6 TodoWrite calls — internal task tracking that produces no output visible to other agents or the user. Of 21 turns, ~29% were TodoWrite overhead. The agent already has agent-scope checkpointing (BUG-008) for progress tracking, making TodoWrite redundant and wasteful.

### 3. Sequential verification wastes 2 turns per cycle

Developers run `npm run build`, `npm run lint`, and `npm run test` as separate Bash calls (3 turns) instead of chaining them (`npm run build && npm run lint && npm run test`, 1 turn). This is a prompt guidance gap.

## Design Context

This ticket addresses the same incident chain as BUG-007 (per-role maxTurns configuration) and BUG-008 (incremental checkpointing), but takes a different approach:

- **BUG-007** (DEFERRED) proposes per-role turn budgets wired through the broker. That remains deferred pending SDK semantics clarification and recalibration of per-role values against actual turn data.
- **BUG-008** (ACCEPTED) added prompt-level checkpointing guidance. It reduced retry cost but didn't prevent the failure.
- **BUG-010** (this ticket) attacks the problem from the other direction: reduce turn consumption and remove the likely-incorrect hardcoded default. If this eliminates failures, BUG-007's per-role budgets become a safety net rather than a fix.

## Implementation Details

### 1. Remove hardcoded `maxTurns: 20` fallback

**File:** `apps/agent/src/llm/claude-code.service.ts`

Change line 46 from:
```typescript
maxTurns: params.maxTurns ?? 20,
```

To conditionally spread the option only when explicitly provided:
```typescript
...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
```

**Rationale:** When `params.maxTurns` is `undefined` (which it always is today, since `InvocationHandler` doesn't pass it), the SDK uses its own internal default. Given that agents complete 30-40 turns without failure when the limit doesn't trigger, the SDK's default is likely higher and more appropriate than our hardcoded 20. This is the minimal-risk experiment recommended in BUG-007's deferral notes.

**Interaction with BUG-007:** When BUG-007 is eventually implemented and the broker sets `request.maxTurns`, `InvocationHandler` will pass it through to `ExecuteParams.maxTurns`, and the conditional spread will include it. The two tickets compose cleanly.

### 2. Add TodoWrite to developer `disallowedTools`

**File:** `apps/agent/src/config/role-permission.service.ts`

Add `'TodoWrite'` to the developer role's `disallowedTools` array. This mechanically prevents the SDK from offering TodoWrite to the agent, saving ~6 turns per implementation cycle.

**Rationale:** Prompt-only guidance ("don't use TodoWrite") is unreliable — the LLM may still call it. Mechanical enforcement via `disallowedTools` is zero-risk (TodoWrite has no side effects beyond the agent's internal state) and guaranteed effective. The developer prompt's BUG-008 checkpointing instructions already provide a superior alternative for progress tracking via agent-scope context.

**Scope:** Developer role only. Other roles (teamlead, architect) use fewer turns and haven't hit the limit.

### 3. Add verification chaining guidance to developer prompt

**File:** `libs/common/src/prompts/role-prompt-templates.ts`

Add a `## Verification` subsection to the developer prompt template, after the existing Context Management section:

```
## Verification
Always chain build, lint, and test into a single command:
`npm run build && npm run lint && npm run test`
This uses one turn instead of three. If a step fails, the chain stops at the failure — you still get the error output.
```

**Rationale:** This is prompt guidance, not mechanical enforcement, because there are legitimate cases where a developer might want to run a single verification step (e.g., just `npm run test` after a test-only change). The prompt makes the default behavior clear while allowing judgment.

### 4. Update `ExecuteParams.maxTurns` JSDoc

**File:** `apps/agent/src/llm/claude-code.types.ts`

Update the JSDoc on `maxTurns` (line 29) to reflect the new behavior:

```typescript
/** Maximum conversation turns before the session stops. When undefined,
 *  the SDK uses its own internal default. Set explicitly via InvokeRequest
 *  when per-role turn budgets are configured (see BUG-007). */
maxTurns?: number;
```

### Test updates

- `claude-code.service.spec.ts`: Verify that when `maxTurns` is `undefined`, the SDK options object does **not** contain a `maxTurns` key. Verify that when `maxTurns` is explicitly set (e.g., 60), it is passed through.
- `role-permission.service.spec.ts`: Verify developer's `disallowedTools` includes `'TodoWrite'`.

## Acceptance Criteria

- [x] `ClaudeCodeService` does not pass `maxTurns` to the SDK when `params.maxTurns` is `undefined`
- [x] `ClaudeCodeService` passes `maxTurns` through when explicitly set in `ExecuteParams`
- [x] Developer role's `disallowedTools` includes `TodoWrite`
- [x] Other roles' `disallowedTools` are unchanged
- [x] Developer prompt template includes verification chaining guidance
- [x] `ExecuteParams.maxTurns` JSDoc updated
- [x] Tests updated and passing for both `ClaudeCodeService` and `RolePermissionService`
- [x] `npm run build`, `npm run lint`, `npm run test` pass

## Implementation Notes

**Status:** Accepted ✅

**Files modified:**
- `apps/agent/src/llm/claude-code.service.ts` — removed hardcoded `maxTurns: 20` fallback, replaced with conditional spread
- `apps/agent/src/config/role-tool-profiles.ts` — added `'TodoWrite'` to developer `disallowedTools`
- `libs/common/src/prompts/role-prompt-templates.ts` — added `## Verification` section to developer prompt with chained build/lint/test guidance
- `apps/agent/src/llm/claude-code.types.ts` — updated `maxTurns` JSDoc to document SDK-default behavior and BUG-007 forward reference
- `apps/agent/src/llm/claude-code.service.spec.ts` — replaced test 7 (was asserting `maxTurns === 20`) with two tests: omission when undefined, passthrough when explicit
- `apps/agent/src/config/role-tool-profiles.spec.ts` — updated developer profile length assertion (3→4), added `TodoWrite` assertion
- `apps/agent/src/config/role-permission.service.spec.ts` — added explicit `TodoWrite` inclusion test for developer role

**Changes made:**
1. `ClaudeCodeService` — `maxTurns: params.maxTurns ?? 20` → `...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {})`. When `maxTurns` is unset, the key is absent from SDK options, letting the SDK use its own internal default. When BUG-007 wires per-role budgets through the broker, `InvocationHandler` will pass `maxTurns` explicitly and the conditional spread will include it.
2. Developer `disallowedTools` — added `'TodoWrite'` to the spread of `COMMON_DISALLOWED_TOOLS`. Mechanical enforcement (not prompt-only) prevents ~6 wasted turns per implementation cycle. Other roles unchanged.
3. Developer prompt — inserted `## Verification` subsection before `## Constraints` with `npm run build && npm run lint && npm run test` chaining guidance. Prompt-only (not mechanical) since single-step verification is sometimes legitimate.
4. `ExecuteParams.maxTurns` JSDoc — replaced "Defaults to 20" with SDK-default semantics and BUG-007 cross-reference.

**Deviations from ticket:** None — implementation matches all four specified changes exactly.

**Verification results:**
- `npm run build` — all 4 apps compiled successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 38 suites, 475 tests, all passing
- Other roles' `disallowedTools` unchanged (architect, teamlead, qa, productowner profiles untouched)

## Dependencies and References

- **Continues from:** [QRM4-BUG-008](QRM4-BUG-008-incremental-context-checkpointing.md) — checkpointing mitigation (accepted, but didn't prevent failures)
- **Related (deferred):** [QRM4-BUG-007](QRM4-BUG-007-per-role-max-turns.md) — per-role maxTurns configuration, remains deferred pending SDK semantics clarification and value recalibration
- **Related:** [QRM4-BUG-006](QRM4-BUG-006-error-reporting-empty-string.md) — error reporting fix (diagnostics side)
- **Evidence:** [Run 5 session report](../logs/sessions/2026-04-02-qrm4-run5.md), [Run 7 session report](../logs/sessions/2026-04-03-qrm4-run7.md)
- **SDK version:** `@anthropic-ai/claude-agent-sdk@^0.2.63`
- **Key files:** `apps/agent/src/llm/claude-code.service.ts`, `apps/agent/src/config/role-permission.service.ts`, `libs/common/src/prompts/role-prompt-templates.ts`, `apps/agent/src/llm/claude-code.types.ts`