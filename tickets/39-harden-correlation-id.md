# #39: Harden correlationId — UUID validation and shell-safe worktree paths

## Summary

Defense-in-depth hardening for `correlationId` when used as a filesystem path component and shell argument in the per-invocation worktree machinery (#11). Two changes: (1) add `z.string().uuid()` validation on `correlationId` in both the MCP tool input schema and the shared `invokeRequestSchema`, and (2) convert shell-interpolated `execAsync` calls for `git worktree add` and `git worktree remove --force` to argv-array `execFile` calls that bypass `sh -c`.

## Problem Statement

PR #38's code review ([finding](https://github.com/ia64mail/quorum/pull/38#issuecomment-4529651722)) identified that `correlationId` is accepted as `z.string().optional()` with no format constraint and is interpolated directly into:

- A filesystem path: `/var/agent-worktrees/<correlationId>`
- Shell commands via `execAsync` (which uses `sh -c`): `git worktree add ${worktreePath} ${request.branch}` and `git worktree remove --force ${worktreePath}`

A crafted `correlationId` containing `../` sequences could resolve the worktree path outside `/var/agent-worktrees/`, and shell metacharacters could inject arbitrary commands.

The [review verdict](https://github.com/ia64mail/quorum/pull/38#issuecomment-4529656126) downgraded this from blocking to advisory because: (1) `invoke_agent` is internal-only (trusted callers within Docker network), (2) `correlationId` is auto-generated as `randomUUID()` when not supplied, (3) container hardening (`read_only: true`, `cap_drop: ALL`, `no-new-privileges`) limits blast radius, and (4) `git worktree add` to a traversed path would fail on a non-empty target. However, the unsanitized interpolation is a code-pattern concern worth closing as defense-in-depth.

## Implementation Details

### 1. UUID Format Validation on `correlationId`

**Two schema sites need the same change:**

**Site A — MCP tool input schema** (`apps/mcp-server/src/mcp/mcp.service.ts`, ~L307-312):

The `invoke_agent` tool's zod input schema currently declares:
```ts
correlationId: z.string().optional()
```
Change to:
```ts
correlationId: z.string().uuid().optional()
```
This is the external-facing entry point — where the moderator or nested agent calls supply `correlationId`. The `z.uuid()` refinement rejects any non-UUID string with a descriptive zod error before the value reaches the broker.

**Site B — Shared InvokeRequest schema** (`libs/common/src/messaging/invoke.types.ts`, ~L70-74):

The `invokeRequestSchema` currently declares:
```ts
correlationId: z.string()
```
Change to:
```ts
correlationId: z.string().uuid()
```
This is the broker-internal contract — the `correlationId` is always present (non-optional) by the time it reaches the broker, because `mcp.service.ts` L353-354 resolves it: `args.correlationId ?? state?.correlationId ?? randomUUID()`. The `randomUUID()` fallback already produces valid UUIDs, so this validation is non-breaking for the auto-generated path.

**Non-breaking verification:** The resolution chain in `mcp.service.ts` L352-354 uses `randomUUID()` (from `node:crypto`) as the final fallback. UUID v4 output passes `z.string().uuid()` validation. Session-state `correlationId` values originate from the same `randomUUID()` call on earlier hops. No caller in the system constructs non-UUID `correlationId` values manually.

### 2. Shell-Safe Git Worktree Commands via `execFile`

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

Three `execAsync` calls interpolate user-influenced values into shell strings. Two of them construct worktree commands using `correlationId` (via `worktreePath`) and `request.branch`:

**Line 118:** `git worktree add`
```ts
// BEFORE:
await execAsync(`git worktree add ${worktreePath} ${request.branch}`, { cwd: repoDir });

// AFTER:
await execFileAsync('git', ['worktree', 'add', worktreePath, request.branch], { cwd: repoDir });
```

**Line 189:** `git worktree remove --force`
```ts
// BEFORE:
await execAsync(`git worktree remove --force ${worktreePath}`, { cwd: repoDir });

// AFTER:
await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoDir });
```

**Import change:** Add `execFile` from `node:child_process` alongside the existing `exec` import, and create a promisified wrapper:

```ts
import { exec, execFile } from 'node:child_process';
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
```

The existing `execAsync` calls that don't interpolate user-influenced values (`git fetch origin` at L105, `git status --porcelain` at L290, `git add -A` at L312, `git commit` at L313, `git push` at L316) can remain as `execAsync` — they use only constants or the `shellQuote`-protected commit message. The developer should assess whether converting `git push origin ${request.branch}` (L316) to `execFileAsync` is also warranted, since `request.branch` is similarly user-supplied. If so, that's a bonus hardening included in this ticket's scope.

**Why `execFile` instead of shell escaping:** `execFile` bypasses the shell entirely — arguments are passed as an argv array directly to the spawned process. This eliminates the entire class of shell injection, whereas manual escaping is fragile and must be maintained. `execFile` is the canonical Node.js fix for this pattern.

### 3. Test Updates

**File:** `apps/agent/src/connection/invocation-handler.service.spec.ts`

The existing test suite mocks `childProcess.exec` via `jest.mock('node:child_process')`. The `execFile`-converted calls will invoke `childProcess.execFile` instead, so the mock infrastructure needs extension:

**Mock setup:** Add a `mockExecFile` alongside the existing `mockExec`:
```ts
const mockExecFile = childProcess.execFile as unknown as jest.Mock;
```

Configure `mockExecFile` in `beforeEach` with the same default success behavior as `mockExec`. The existing `jest.mock('node:child_process')` auto-mocks all exports, so `execFile` is already mocked — it just needs a default implementation.

**Retarget existing tests:** Tests in the `describe('worktree lifecycle (#11)')` block that assert on `mockExec` call arguments for `git worktree add` and `git worktree remove` must be updated to assert on `mockExecFile` instead. The argument shape changes from `(cmdString, opts, cb)` to `(binary, argsArray, opts, cb)`.

**New tests — UUID schema rejection:**

Add a test (in the MCP tool schema test file or as an integration test) that verifies `correlationId` with a non-UUID string (e.g., `"not-a-uuid"`, `"../../../etc/passwd"`) is rejected by the zod schema with a descriptive error. Also verify that a valid UUID v4 string passes.

**New tests — argv array verification:**

Add tests that verify the `execFile` calls receive the expected argv arrays — specifically that `worktreePath` and `request.branch` appear as discrete array elements, not interpolated into a shell string. This can be verified by inspecting `mockExecFile.mock.calls` for the exact argument structure:
```ts
expect(mockExecFile).toHaveBeenCalledWith(
  'git',
  ['worktree', 'add', expectedWorktreePath, expectedBranch],
  { cwd: expectedRepoDir },
  expect.any(Function),
);
```

## Acceptance Criteria

- [ ] `correlationId` in `invoke_agent` MCP tool schema (`mcp.service.ts`) rejects non-UUID strings with a descriptive zod error
- [ ] `correlationId` in `invokeRequestSchema` (`invoke.types.ts`) rejects non-UUID strings
- [ ] Auto-generated correlationIds (via `randomUUID()`) still pass validation (no regression)
- [ ] `git worktree add` call in `invocation-handler.service.ts` uses `execFileAsync` with argv array (no shell interpolation)
- [ ] `git worktree remove --force` call in `invocation-handler.service.ts` uses `execFileAsync` with argv array (no shell interpolation)
- [ ] Unit tests cover UUID schema rejection with non-UUID and path-traversal strings
- [ ] Unit tests verify `execFileAsync` argv structure for worktree commands
- [ ] Existing worktree lifecycle tests pass after mock retargeting
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass

## Dependencies and References

**Depends on:**
- #11 (Worktree Per Invocation) — introduced the worktree lifecycle and `correlationId`-as-path pattern. Merged.
- #38 (PR for #11) — code review that identified this hardening opportunity. Merged.

**Blocks:** Nothing — this is optional defense-in-depth hardening.

**References:**
- Original code review finding: https://github.com/ia64mail/quorum/pull/38#issuecomment-4529651722
- Review verdict and downgrade rationale: https://github.com/ia64mail/quorum/pull/38#issuecomment-4529656126
- `tickets/11-worktree-per-invocation.md` — parent implementation ticket
- `11-design-notes` in Context Store (project scope) — architect design review for #11
- `13-project-notes` in Context Store (project scope) — branch-in-flight guard (related broker safeguard)
- GitHub issue: https://github.com/ia64mail/quorum/issues/39
