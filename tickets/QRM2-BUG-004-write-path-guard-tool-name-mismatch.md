# QRM2-BUG-004: Write Path Guard Tool Name Mismatch

Status: Open

## Summary

The write path guard in `createToolGuardHook()` checks for tool names `FileWrite`, `FileEdit`, and `NotebookEdit`, but the Claude Code SDK uses `Write`, `Edit`, and `NotebookEdit` as actual tool names. The guard silently passes all write operations because the tool name comparison never matches, rendering `allowedWritePaths` restrictions (architect → `docs/`, `tickets/`; productowner → `tickets/`) completely unenforced.

## Problem Statement

During the QRM2-009 E2E smoke test (Run 1, 2026-03-14), Scenario 11 asked the architect to create a file at `docs/smoke-test-arch.md` (should succeed) and `src/forbidden.ts` (should be denied). Both writes succeeded.

**Expected behavior:** The `canUseTool` guard denies the architect's write to `src/forbidden.ts` with the message `"This role can only write to: docs/, tickets/"`.

**Actual behavior:** Both writes succeed. The architect creates `src/forbidden.ts` without any denial.

**Impact:** All `allowedWritePaths` restrictions are non-functional. The architect and productowner roles have no effective write path enforcement, violating the principle of least privilege defined in QRM2-005.

## Root Cause Analysis

The guard hook in `tool-guard-hook.ts` (line 52) compares the incoming `toolName` against the `WRITE_TOOLS` constant defined in `role-tool-profiles.ts` (line 82):

```typescript
// role-tool-profiles.ts:82
export const WRITE_TOOLS = ['FileWrite', 'FileEdit', 'NotebookEdit'] as const;
```

But Claude Code's SDK reports its built-in tools with these names:

| Expected (in `WRITE_TOOLS`) | Actual (from SDK) |
|------------------------------|-------------------|
| `FileWrite` | `Write` |
| `FileEdit` | `Edit` |
| `NotebookEdit` | `NotebookEdit` |

The `WRITE_TOOLS.includes(toolName)` check on line 52 returns `false` for `Write` and `Edit`, so the write path filtering block is never entered. Only `NotebookEdit` would match (but it's already in `disallowedTools` for architect and productowner, so it never reaches the guard).

This is the same class of bug as QRM2-BUG-001 (assumptions about Claude Code internals that break under real execution). The tool names were likely inferred from documentation or naming conventions rather than verified against actual SDK tool call payloads.

## Implementation Details

### Fix

Update `WRITE_TOOLS` in `role-tool-profiles.ts` to use the actual SDK tool names:

```typescript
// Before
export const WRITE_TOOLS = ['FileWrite', 'FileEdit', 'NotebookEdit'] as const;

// After
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
```

### Verification

1. Update the existing unit tests for `createToolGuardHook()` to use `Write` and `Edit` as tool names (they currently use `FileWrite`/`FileEdit` and would pass — confirming they tested the wrong names).
2. Re-run QRM2-009 Scenario 11:
   - Architect writes to `docs/smoke-test-arch.md` → **allowed**
   - Architect writes to `src/forbidden.ts` → **denied** with message `"This role can only write to: docs/, tickets/"`
3. `npm run test` — all existing tests pass (after updating tool names in test fixtures).

### Files to Modify

| File | Change |
|------|--------|
| `apps/agent/src/config/role-tool-profiles.ts` | `WRITE_TOOLS`: `FileWrite` → `Write`, `FileEdit` → `Edit` |
| `apps/agent/src/config/tool-guard-hook.spec.ts` | Update test fixtures to use `Write`/`Edit` tool names |

## Acceptance Criteria

- [ ] `WRITE_TOOLS` uses `Write` and `Edit` (matching actual SDK tool names)
- [ ] Unit tests for `createToolGuardHook()` use correct tool names
- [ ] Architect cannot write outside `docs/` and `tickets/` (verified via E2E Scenario 11)
- [ ] Productowner cannot write outside `tickets/` (if deployed)
- [ ] Developer and teamlead remain unrestricted (no `allowedWritePaths`)
- [ ] `npm run test` passes with no regressions
- [ ] `npm run lint` passes with no regressions

## Dependencies and References

### Prerequisites
- None — standalone fix

### What This Blocks
- QRM2-009 Scenario 11 (Permission Enforcement) cannot pass until this is resolved
- QRM2 milestone completion (all scenarios must pass)

### References
- Discovered during: QRM2-009 E2E Smoke Test, Run 1 (2026-03-14), Scenario 11
- `apps/agent/src/config/role-tool-profiles.ts` — `WRITE_TOOLS` constant (line 82)
- `apps/agent/src/config/tool-guard-hook.ts` — write path filtering (lines 49-74)
- `apps/agent/src/config/role-permission.service.ts` — `getToolGuardHook()`
- `apps/agent/src/connection/invocation-handler.service.ts` — `toCanUseTool()` integration (lines 17-35, 68)
- QRM2-005 ticket: `tickets/QRM2-005-role-permission-profiles.md` (original permission design)
- QRM2-BUG-001: Similar class of bug (SDK assumption mismatch)