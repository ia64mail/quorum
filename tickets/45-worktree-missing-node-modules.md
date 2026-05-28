# #45: Per-invocation worktree missing node_modules — agent npm commands fail under #11 isolation

## Summary

Per-invocation git worktrees created by #11 do not contain a `node_modules` directory. Any `npm run build`, `npm run lint`, or `npm run test` command run from the worktree cwd fails because Node's module resolution cannot find project dependencies. The fix is to symlink the image-installed `/app/node_modules` into each worktree immediately after `git worktree add` succeeds.

## Problem Statement

The Docker agent image installs all dependencies at build time to `/app/node_modules` (`Dockerfile:71 — COPY --from=builder --chown=quorum:quorum /app/node_modules ./node_modules`). Under the #11 worktree model, the SDK subprocess's cwd is `/var/agent-worktrees/<correlationId>/` — a `git worktree add`-created checkout branched from `/var/agent-repo/`. Neither location has `node_modules`:

- `/var/agent-worktrees/<correlationId>/` is a fresh git checkout — git does not track `node_modules` (gitignored)
- `/var/agent-repo/` is a bare-ish clone with no `npm install` run at boot
- `/app/node_modules` exists but is not an ancestor of the worktree path, so Node's upward module resolution never finds it

In-worktree `npm install` is not a viable recovery path:
- The container runs with `read_only: true` (`docker-compose.yml:25`, via `x-base-security`)
- `npm install` requires writable `~/.npm` cache → `mkdir: cannot create directory '/home/quorum/.npm': Read-only file system`
- Even if writable, the available tmpfs budget (`/var/agent-worktrees` at 1GB, `/tmp` at 512MB) is not sized for a full dependency tree extraction
- Partial install attempts leave corrupted state (observed: `jest-resolve` missing `defaultPlatform` property)

**Concrete failure evidence** (from `logs/developer-20260527T021431.jsonl`):

| Timestamp | Event | Detail |
|-----------|-------|--------|
| `2026-05-27T13:47:50` | `npm run build` | `Exit 127, sh: 1: nest: not found` — NestJS CLI binary not on PATH, `node_modules/.bin` absent |
| `2026-05-27T13:49:36` | `npm install` recovery attempt | `mkdir: cannot create directory '/home/quorum/.npm': Read-only file system` |
| `2026-05-27T13:50:26` | Partial install aftermath | `TypeError: Cannot read properties of undefined (reading 'defaultPlatform')` — corrupted `jest-resolve` |

This blocks **every** implementation dispatch that requires build/lint/test verification — effectively every ticket. Discovered during the end-to-end run of issue #39 (PR #44).

## Design Context

The worktree lifecycle was established by #11 (ticket `tickets/11-worktree-per-invocation.md`). The lifecycle is: `git fetch origin` → `git worktree add` → SDK execution → handler commit/push → `git worktree remove --force`. The gap is between step 2 (worktree created) and step 3 (SDK execution) — at this point the worktree has the source tree but no `node_modules`.

#11's ticket (Section 6, "PATH env var update") explicitly removed the stale `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` from the Dockerfile agent stage, noting: *"Agents primarily use CC CLI's built-in tools, not project devDependency binaries. If a future ticket needs project scripts in agents, it can add `npm install` to the entrypoint and restore the PATH at that time."* This is that future ticket — except symlink is cheaper than `npm install`.

The parent epic (#8, `tickets/8-workspace-isolation.md`) Worktree Lifecycle diagram (lines 230–256) shows the handler commit/push step but does not address dependency availability. This is a gap in the original design — the worktree model assumed SDK-internal tooling only and did not account for agents running project npm scripts.

## Implementation Details

### Fix: Symlink `/app/node_modules` into worktree after creation

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

After `git worktree add` succeeds (line ~130, before the SDK execution `try` block at line ~133), add a symlink step:

```ts
await execFileAsync('ln', ['-s', '/app/node_modules', `${worktreePath}/node_modules`]);
```

This creates a symbolic link `<worktreePath>/node_modules → /app/node_modules`. Node's module resolution finds the symlink at `<cwd>/node_modules`, follows it to `/app/node_modules`, and all project binaries (`nest`, `jest`, `eslint`) resolve correctly.

**Import change:** The current file imports `exec` from `node:child_process` and creates `execAsync = promisify(exec)` (lines 2–3). The symlink call should use `execFile` (argv array, no shell) to avoid shell injection from correlationId values:

```ts
import { exec, execFile } from 'node:child_process';
// ...
const execFileAsync = promisify(execFile);
```

**Insertion point:** Between the successful `git worktree add` (end of the try/catch at line ~130) and the SDK execution try block (line ~133). The structure becomes:

```
runInvocation(request):
  git fetch origin
  git worktree add <worktreePath> <branch>
  ln -s /app/node_modules <worktreePath>/node_modules    ← NEW
  try:
    claudeCode.execute({ cwd: worktreePath })
    ...
  finally:
    git worktree remove --force <worktreePath>
```

**Error handling:** Symlink creation failure should return a clear `InvokeResponse` error, same pattern as the existing `git worktree add` error handling:

```ts
try {
  await execFileAsync('ln', ['-s', '/app/node_modules', `${worktreePath}/node_modules`]);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  this.logger.error(
    `node_modules symlink failed: correlationId=${request.correlationId} ${msg}`,
  );
  // Clean up the worktree we just created before returning error
  try {
    await execAsync(`git worktree remove --force ${worktreePath}`, { cwd: repoDir });
  } catch { /* best-effort cleanup */ }
  return {
    success: false,
    error: `Worktree setup failed: node_modules symlink: ${msg}`,
  };
}
```

**Note on cleanup:** `git worktree remove --force` in the `finally` block already handles worktree removal. The symlink lives inside the worktree directory, so removing the worktree removes the symlink. The symlink target (`/app/node_modules`) is never touched — it's a separate filesystem path owned by the Docker image layer.

### Why symlink (not alternatives)

| Alternative | Why rejected |
|-------------|-------------|
| In-worktree `npm install` | Blocked by `read_only: true` filesystem + tmpfs size constraints. Even if writable, adds 30–60s per invocation and requires network access. |
| Mount `/app/node_modules` as tmpfs/volume into worktree | Overcomplicated — requires docker-compose changes, per-invocation mount orchestration. Symlink achieves the same resolution with zero infrastructure cost. |
| Re-root worktrees under `/app/` | Fights the deliberate `/var/agent-worktrees/<correlationId>/` design from #11. `/app/` is the image install directory, not a scratch space. tmpfs self-healing property (orphan cleanup on restart) would be lost. |
| Restore `PATH` env to include `/app/node_modules/.bin` | Only solves direct CLI binary invocation (`nest`, `jest`). Does not solve `require()` / `import` resolution — Node still needs `node_modules` in the module resolution chain. |
| `NODE_PATH=/app/node_modules` env var | Solves runtime `require()` but not npm script binary resolution. npm scripts resolve `.bin/` relative to the nearest `node_modules`, which still wouldn't exist. Partial fix at best. |

### Scope guard

- **DO NOT** modify the Dockerfile — `/app/node_modules` is already correctly installed
- **DO NOT** modify `docker-compose.yml` — no new volumes or mounts needed
- **DO NOT** modify the agent entrypoint — this is a handler-level fix, not a boot-time fix
- **DO NOT** add `npm install` to any path — the symlink is the solution

## Acceptance Criteria

- [x] After `git worktree add` succeeds, handler creates symlink `<worktreePath>/node_modules → /app/node_modules`
- [x] Symlink creation uses `execFile` argv form (not `execAsync` shell interpolation) — prevents shell injection from correlationId values
- [x] Symlink-creation failure returns a clear `InvokeResponse` error and cleans up the just-created worktree before returning
- [x] `npm run build` from inside the worktree succeeds (NestJS CLI binary resolves)
- [x] `npm run lint` from inside the worktree succeeds (ESLint binary resolves)
- [x] `npm run test` from inside the worktree succeeds (Jest binary resolves)
- [x] `git worktree remove --force` cleanup unaffected — symlink removal does not touch `/app/node_modules`
- [x] Unit test in `invocation-handler.service.spec.ts` verifies symlink call: correct command (`ln`), correct argv (`['-s', '/app/node_modules', '<worktreePath>/node_modules']`), and correct insertion point (after worktree add, before SDK execute)
- [x] `npm run build`, `npm run lint`, `npm run test` all pass in the development environment (no regressions)

## Dependencies and References

**Blocks:**
- #39 (PR #44) — end-to-end implementation cannot verify without working npm commands in worktree

**Built atop:**
- #11 (Worktree Per Invocation) — introduced the worktree lifecycle this bug arose under

**Parent epic:**
- #8 (QRM8 — Workspace Isolation)

**References:**
- `tickets/11-worktree-per-invocation.md` — worktree lifecycle design, Section 6 PATH removal rationale
- `tickets/8-workspace-isolation.md` — Worktree Lifecycle diagram (lines 230–256), D1 design decision
- `apps/agent/src/connection/invocation-handler.service.ts` — worktree setup code (lines 99–200)
- `Dockerfile:71` — `COPY --from=builder --chown=quorum:quorum /app/node_modules ./node_modules`
- `docker-compose.yml:20–40` — `x-base-security` (`read_only: true`) and `x-agent-security` (tmpfs definitions)
- Failure logs: `logs/developer-20260527T021431.jsonl` around timestamps 13:47–13:53

## Architect Review

**Not requested.** This is a localized bug fix within the well-defined worktree lifecycle established by #11. It adds one step (symlink) to the existing setup sequence — no new abstractions, no cross-module contract changes, no design decisions beyond "use symlink vs. alternatives" (which is straightforward). The worktree-isolation boundary is preserved, not modified.

## Implementation Notes

**Files modified:**
- `apps/agent/src/connection/invocation-handler.service.ts` — added `execFile` import, `execFileAsync` promisify, symlink step with try/catch error handling and worktree cleanup on failure
- `apps/agent/src/connection/invocation-handler.service.spec.ts` — added `mockExecFile` alongside `mockExec`, default success behavior in `beforeEach`, 3 new tests in `describe('node_modules symlink (#45)')`: argv shape, call ordering, failure path with cleanup

**Deviations:** None. Implementation follows the ticket design exactly.

**Verification results:**
- `npm run build` — 3 webpack compilations succeeded
- `npm run lint` — clean (eslint auto-fixed no issues)
- `npm run test` — 46 suites, 828 tests passed (825 baseline + 3 new), 0 failures
