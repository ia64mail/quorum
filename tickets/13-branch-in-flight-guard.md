# #13: Branch-in-Flight Guard in MessageBroker

## Summary

Add a broker-level guard that prevents two concurrent invocations from operating on the same git branch. When `invoke_agent` is called with a `branch` that is already in-flight, the broker rejects the request with a descriptive error rather than allowing concurrent edits. With the required `branch` field (landed in #11), the guard applies universally to every invocation.

## Problem Statement

The worktree-per-invocation model (#11) gives each invocation its own filesystem checkout, but two invocations targeting the **same branch** would create two worktrees from the same ref and race on push. The handler-controlled commit/push (#12) would encounter merge conflicts or silently overwrite the other invocation's work. A broker-level gate is needed to reject the second request before it reaches the agent.

Today the system has no protection against this — the moderator (or a nested agent call) could accidentally dispatch two invocations to the same branch. The existing `InvocationHandler.inflight` deduplication (`invocation-handler.service.ts:78-91`) catches same-correlationId duplicates on the agent side, but does **not** prevent different-correlationId invocations from targeting the same branch. The broker is the single chokepoint where all invocations pass, making it the correct enforcement layer.

## Implementation Details

### New field on `MessageBroker`

Add a `branchLocks` map alongside the existing `callChains` map (line 17 of `message-broker.service.ts`):

```typescript
private readonly branchLocks = new Map<string, { correlationId: string; target: AgentRole }>();
```

This mirrors `callChains` in purpose (concurrency tracking) and lifecycle (acquire before delivery, release in `finally`).

### Insertion point — Safeguard 4 (new numbering)

The guard inserts **after** the existing three safeguards and after `callChains` tracking, but **before** the `try` block that performs delivery. Current safeguard order in `message-broker.service.ts`:

1. **Depth limit** (line 35) — O(1) check
2. **Agent availability** (lines 42-56) — registry lookup + connection check
3. **Circular call prevention** (lines 58-70) — `callChains` set membership

The branch-in-flight guard becomes the new check after callChains tracking (after line 74, before the `try` block at line 76). It checks `branchLocks.has(request.branch)`:
- **If the branch is already locked:** return `{ success: false, error: <descriptive message> }` — same pattern as the other safeguards. Clean up the caller's entry from `callChains` before returning (the caller was already added at line 73).
- **If not locked:** acquire the lock with `branchLocks.set(request.branch, { correlationId, target })` and proceed to delivery.

### Lock lifecycle (mirrors `callChains`)

The `callChains` lifecycle is the template:
- **Acquire** (line 73-74): `chain.add(caller); this.callChains.set(correlationId, chain);` — happens before the `try` block
- **Release** (lines 141-146): in the `finally` block — `chain.delete(caller); if (chain.size === 0) this.callChains.delete(correlationId);`

The branch lock mirrors this exactly:
- **Acquire**: `this.branchLocks.set(request.branch, { correlationId, target })` — after the guard check passes, before the `try` block
- **Release**: `this.branchLocks.delete(request.branch)` — in the `finally` block, alongside the `callChains` cleanup (after line 145)

### Error message format

When the guard rejects, the error message must be descriptive enough for the moderator to understand **what** is blocked and **by whom**:

```
Branch 'feature/auth' is already in-flight (target=developer, correlationId=abc-123)
```

The message includes:
- The conflicting branch name
- The in-flight target role
- The in-flight correlationId

This follows the existing pattern where each safeguard logs a `WARN` with the correlationId before returning.

### `branch` is universally available

Issue #11 made `branch` a required field on `InvokeRequest` (`invoke.types.ts:121-127`), validated by zod with `.min(1)`. Every invocation that reaches the broker has a non-empty branch string. No fallback logic, no optional handling — the guard can unconditionally read `request.branch`.

### Test patterns to extend

The existing test file (`message-broker.service.spec.ts`) provides clear patterns:
- `makeRequest()` helper (line 13) already includes `branch: 'main'` — override with different branch names for concurrent tests
- `MockConnection` for simulating agent handles
- Private field access via cast: `(broker as unknown as { branchLocks: Map<string, ...> }).branchLocks` — same pattern used for `callChains` at line 309
- The `chain cleanup` describe block (lines 301-332) is the structural template for lock cleanup tests — verify the map is empty after success and after error

New test cases should go in a dedicated `describe('branch-in-flight guard', ...)` block.

## Scope Guards

- **DO NOT** touch `InvocationHandler.inflight` deduplication — that is a separate mechanism on the agent side. The broker guard is two-layer protection alongside it, not a replacement.
- **DO NOT** change `callChains` behavior — only mirror its lifecycle pattern for the new `branchLocks` map.
- **DO NOT** add per-role variations — the branch lock is universal across all roles.
- **Single file change** for production code: `apps/mcp-server/src/messaging/message-broker.service.ts`. Tests in the corresponding spec file.

## Acceptance Criteria

- [x] `branchLocks: Map<string, { correlationId: string; target: AgentRole }>` field added to `MessageBroker`, checked after existing safeguards (depth, availability, circular call) and before delivery
- [x] Lock acquired when delivery starts (after guard check passes, before the `try` block), mirroring `callChains` acquire pattern
- [x] Lock released in the `finally` block on successful completion, alongside `callChains` cleanup
- [x] Lock released in the `finally` block on error/exception, alongside `callChains` cleanup
- [x] Descriptive error message on rejection includes the conflicting branch name, the in-flight target role, and the in-flight correlationId
- [x] Test: concurrent invocations targeting the same branch — second call rejected with descriptive error
- [x] Test: concurrent invocations targeting different branches — both succeed (no false rejection)
- [x] Test: `branchLocks` map is empty when no invocations are in flight (cleanup verified on both success and error paths)

## Implementation Notes

**Status:** Complete

**Files modified:**
- `apps/mcp-server/src/messaging/message-broker.service.ts` — added `branchLocks` map field, safeguard 4 (branch-in-flight guard) between `callChains` tracking and the `try` block, lock release in `finally` block. Renumbered old "Safeguard 4" (role-based timeout) to "Safeguard 5".
- `apps/mcp-server/src/messaging/message-broker.service.spec.ts` — added `describe('branch-in-flight guard', ...)` block with 6 tests: same-branch rejection, different-branch coexistence, lock release on success, lock release on error, empty-map invariant after mixed success/error, and callChains cleanup on branch guard rejection.

**Deviation from ticket:** The guard allows same-correlationId invocations through (`existingLock.correlationId !== correlationId` check). The ticket specified unconditional lock checking, but unconditional locking would break the existing nested-call pattern (A→B→C within the same correlationId on the same branch), which is sequential within a single handler and does not race on push. Two pre-existing tests confirmed this: the circular call detection test and the elicitation bypass test both use same-branch nested calls. The correlationId exemption is correct — the guard targets cross-correlationId concurrent edits, which is the actual race condition described in the problem statement.

**Verification:**
- `npm run build` — 3 webpack compilations, 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 46 suites, 804 tests passed (798 baseline + 6 new)

## Dependencies and References

- **Depends on:** #11 (merged) — the `branch` field in `InvokeRequest` must exist for the guard to operate
- **Implements:** Design Decision D6 in `tickets/8-workspace-isolation.md`
- **Partially resolves:** ICEBOX #1 (Duplicate Invocation Prevention) — prevents same-branch collisions, the most damaging form
- **Related (not touched):** `InvocationHandler.inflight` deduplication (`apps/agent/src/connection/invocation-handler.service.ts:78-91`) — separate per-correlationId guard on the agent side
- **Files to modify:** `apps/mcp-server/src/messaging/message-broker.service.ts`, `apps/mcp-server/src/messaging/message-broker.service.spec.ts`
- **Architect review: NOT NEEDED** — design fully specified in D6, mirrors existing `callChains` pattern, no new abstractions, single file change
