# QRM2-BUG-004: Write Path Guard Tool Name Mismatch

Status: Resolved

## Summary

The write path guard in `createToolGuardHook()` originally checked for tool names `FileWrite`, `FileEdit`, and `NotebookEdit`, but the Claude Code SDK uses `Write`, `Edit`, and `NotebookEdit` as actual tool names. This was **Issue 1**. Additionally, the `canUseTool` callback was never invoked under `permissionMode: 'bypassPermissions'` because that mode skips all permission checks — this was **Issue 2**. After fixing both, a third issue emerged: the subprocess rejects the `{ behavior: 'allow' }` response from `canUseTool` with a ZodError ("Invalid union schema"), meaning **deny works but allow is broken** — this was **Issue 3** (now resolved).

## Problem Statement

During the QRM2-009 E2E smoke test (Run 1, 2026-03-14), Scenario 11 asked the architect to create a file at `docs/smoke-test-arch.md` (should succeed) and `src/forbidden.ts` (should be denied). Both writes succeeded.

**Expected behavior:** The `canUseTool` guard denies the architect's write to `src/forbidden.ts` with the message `"This role can only write to: docs/, tickets/"`.

**Actual behavior:** Both writes succeed. The architect creates `src/forbidden.ts` without any denial.

**Impact:** All `allowedWritePaths` restrictions are non-functional. The architect and productowner roles have no effective write path enforcement, violating the principle of least privilege defined in QRM2-005.

## Root Cause Analysis

### Issue 1 — Tool Name Mismatch (RESOLVED)

The guard hook in `tool-guard-hook.ts` compared the incoming `toolName` against the `WRITE_TOOLS` constant defined in `role-tool-profiles.ts`:

```typescript
// Before (wrong)
export const WRITE_TOOLS = ['FileWrite', 'FileEdit', 'NotebookEdit'] as const;

// After (correct)
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
```

| Expected (in `WRITE_TOOLS`) | Actual (from SDK) |
|------------------------------|-------------------|
| `FileWrite` | `Write` |
| `FileEdit` | `Edit` |
| `NotebookEdit` | `NotebookEdit` |

### Issue 2 — `bypassPermissions` Prevents `canUseTool` Invocation (RESOLVED)

`ClaudeCodeService` used `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true`. Under this mode, the Claude Code subprocess never sends `can_use_tool` control requests to the SDK — it executes all tools without asking. The `canUseTool` callback was dead code.

**Evidence:** SDK debug log showed `executePreToolHooks called for tool: Write` followed by immediate file write — no permission check, no `can_use_tool` control message.

**Fix:** Changed to `permissionMode: 'default'`, removed `allowDangerouslySkipPermissions`. The SDK adds `--permission-prompt-tool stdio` when `canUseTool` is provided, which routes permission requests through the SDK's stdio protocol back to the `canUseTool` callback.

### Issue 3 — `canUseTool` "allow" Response Missing Required `updatedInput` (RESOLVED)

After fixing Issues 1 and 2, E2E testing (Runs 2-4, 2026-03-14) revealed:
- **Deny path works:** `src/forbidden.ts` correctly blocked with message `"This role can only write to: docs/, tickets/"` ✅
- **Allow path broken:** `docs/smoke-test-arch.md` fails with "ZodError - Invalid union schema" ✗

**Evidence from debug logging in `toCanUseTool`:**
```
[canUseTool] toolName=Write input={"file_path":"/mnt/quorum/workspace/docs/smoke-test-arch.md","content":"# Smoke Test"}
[canUseTool] result={"allowed":true}
[canUseTool] toolName=Write input={"file_path":"/mnt/quorum/workspace/src/forbidden.ts","content":"// should fail"}
[canUseTool] result={"allowed":false,"reason":"This role can only write to: docs/, tickets/"}
```

The guard hook logic is correct — it returns `allowed: true` for docs/ and `allowed: false` for src/. The `toCanUseTool` adapter correctly maps these to `{ behavior: 'allow' }` and `{ behavior: 'deny', message: '...' }`. But the subprocess rejects the allow response.

**Root cause:** The `PermissionResultAllow` type requires `updatedInput` as a **mandatory** field. Our `toCanUseTool` adapter was returning `{ behavior: 'allow', updatedPermissions: options.suggestions }` — missing `updatedInput` entirely. The subprocess's Zod validator for the `PermissionResult` union type rejected this because the allow variant requires `updatedInput` (the tool input to execute with, original or modified).

This is a documented issue: [anthropics/claude-agent-sdk-python#200](https://github.com/anthropics/claude-agent-sdk-python/issues/200) and [#227](https://github.com/anthropics/claude-agent-sdk-python/issues/227) describe the same problem in the Python SDK.

**Fix:** Changed the allow response in `toCanUseTool()` to pass through the original `input`:

```typescript
// Before (broken — missing required updatedInput)
return { behavior: 'allow', updatedPermissions: options?.suggestions };

// After (correct — passes tool input back as required)
return { behavior: 'allow', updatedInput: input };
```

Per the [official SDK documentation](https://platform.claude.com/docs/en/agent-sdk/user-input), the correct allow response format is `{ behavior: 'allow', updatedInput: input }` where `updatedInput` contains the original (or modified) tool input parameters.

## What Was Changed (Issues 1, 2, & 3)

| File | Change |
|------|--------|
| `apps/agent/src/config/role-tool-profiles.ts` | `WRITE_TOOLS`: `['FileWrite', 'FileEdit', 'NotebookEdit']` → `['Write', 'Edit', 'NotebookEdit']`; updated comment |
| `apps/agent/src/config/tool-guard-hook.ts` | Updated comment referencing tool names |
| `apps/agent/src/config/tool-guard-hook.spec.ts` | All `FileWrite`/`FileEdit` → `Write`/`Edit` in test cases |
| `apps/agent/src/config/role-tool-profiles.spec.ts` | Updated `WRITE_TOOLS` assertion to expect `Write`/`Edit` |
| `apps/agent/src/config/role-permission.service.spec.ts` | Updated integration test to use `Write` instead of `FileWrite` |
| `apps/agent/src/llm/claude-code.service.ts` | `permissionMode: 'bypassPermissions'` → `'default'`; removed `allowDangerouslySkipPermissions` |
| `apps/agent/src/llm/claude-code.service.spec.ts` | Updated test assertion to match new permission mode |
| `apps/agent/src/connection/invocation-handler.service.ts` | `toCanUseTool` allow response: `{ behavior: 'allow', updatedInput: input }` (was missing required `updatedInput`) |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Updated allow assertion to expect `updatedInput` instead of `updatedPermissions` |

All unit tests pass (413/413). Lint clean.

## Resolution Summary

All three issues are now resolved. The root causes were:
1. **Issue 1:** Wrong tool names in `WRITE_TOOLS` constant (`FileWrite`/`FileEdit` vs SDK's `Write`/`Edit`)
2. **Issue 2:** `bypassPermissions` mode skips `canUseTool` entirely — switched to `permissionMode: 'default'`
3. **Issue 3:** Missing required `updatedInput` field in allow response — the SDK's Zod schema for `PermissionResultAllow` requires `updatedInput` (the tool input to execute with). Our adapter was omitting it, causing the union validation to fail. Fixed by passing the original `input` through as `updatedInput`.

**References for Issue 3:**
- [anthropics/claude-agent-sdk-python#200](https://github.com/anthropics/claude-agent-sdk-python/issues/200) — same serialization bug reported in Python SDK
- [anthropics/claude-agent-sdk-python#227](https://github.com/anthropics/claude-agent-sdk-python/issues/227) — follow-up confirming the fix
- [Official SDK permissions docs](https://platform.claude.com/docs/en/agent-sdk/permissions) — correct `canUseTool` response format

## Acceptance Criteria

- [x] `WRITE_TOOLS` uses `Write` and `Edit` (matching actual SDK tool names)
- [x] Unit tests for `createToolGuardHook()` use correct tool names
- [x] Architect cannot write outside `docs/` and `tickets/` (Issue 3 fixed — `updatedInput` now passed)
- [x] Productowner cannot write outside `tickets/` (Issue 3 fixed)
- [x] Developer and teamlead remain unrestricted (no `allowedWritePaths`)
- [x] `npm run test` passes with no regressions (414/414)
- [x] `npm run lint` passes with no regressions

## Dependencies and References

### Prerequisites
- None — standalone fix

### What This Blocks
- QRM2-009 Scenario 11 (Permission Enforcement) cannot fully pass until Issue 3 is resolved
- QRM2 milestone completion (all scenarios must pass)

### References
- Discovered during: QRM2-009 E2E Smoke Test, Run 1 (2026-03-14), Scenario 11
- `apps/agent/src/config/role-tool-profiles.ts` — `WRITE_TOOLS` constant
- `apps/agent/src/config/tool-guard-hook.ts` — write path filtering
- `apps/agent/src/config/role-permission.service.ts` — `getToolGuardHook()`
- `apps/agent/src/connection/invocation-handler.service.ts` — `toCanUseTool()` integration
- `apps/agent/src/llm/claude-code.service.ts` — `permissionMode` and `canUseTool` wiring
- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 1107-1116 for `PermissionResult`, 1094-1105 for `PermissionRequestHookSpecificOutput`)
- SDK source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (line 21 for `processControlRequest`)
- QRM2-005 ticket: `tickets/QRM2-005-role-permission-profiles.md` (original permission design)
- QRM2-BUG-001: Similar class of bug (SDK assumption mismatch)