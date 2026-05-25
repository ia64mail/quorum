# #12: Handler-Controlled Commit and Push

## Summary

Move `git add`, `git commit`, and `git push` out of the SDK loop and into `InvocationHandler`. Agents only edit files; the handler stages, commits with a structured message, and pushes to the remote after `claudeCode.execute()` completes. This completes the "agents only edit, handler does git" model established by #11's worktree isolation.

## Problem Statement

Today, agents with developer/teamlead roles can run `git commit` directly via Bash during the SDK loop. The handler only detects uncommitted changes post-invocation (`checkUncommittedChanges()` at `invocation-handler.service.ts:272`). This creates several problems:

- **Uncontrolled commit timing** -- agents commit mid-task, capturing partial work
- **Inconsistent commit messages** -- each agent formats messages differently; no structured convention is enforced
- **No handler-level verification** -- the handler has no opportunity to validate or control what gets committed before it reaches the remote
- **Partial commits on error** -- an agent that commits halfway through a task and then fails leaves broken commits on the branch

Under the QRM8 model, the handler is the sole committer. After SDK execution completes successfully, the handler checks for changes, stages everything, creates a structured commit message derived from the invocation metadata, and pushes to the remote. Agents are mechanically prevented from running git commit/push through updated `deniedBashCommands` for all roles.

**Dependencies:** #11 (worktree cwd -- commit/push targets the worktree) and #15 (PAT wiring -- push authenticates via the gh credential helper configured by #15's agent entrypoint). Both are merged.

## Implementation Details

### 1. Replace `checkUncommittedChanges()` with `commitAndPush()`

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

Replace the existing `checkUncommittedChanges()` method (lines 272-291) with a new `commitAndPush(cwd: string, request: InvokeRequest)` method. The current method only warns about uncommitted changes; the new method stages, commits, and pushes them.

**Method signature:**

```ts
private async commitAndPush(cwd: string, request: InvokeRequest): Promise<void>
```

**Logic:**

1. Run `git status --porcelain` in the worktree cwd
2. If output is empty (no changes): log INFO `"No changes to commit after invocation: correlationId=<id>"` and return early
3. If changes exist:
   a. `git add -A` (stage all changes in the worktree)
   b. Derive the commit message (see section 2 below)
   c. `git commit -m "<derived message>"` -- use the derived message
   d. `git push origin <request.branch>` -- regular push, no force-push
4. On push failure: throw an error that surfaces in `InvokeResponse` as `{ success: false, error: "push rejected: <stderr>" }`

All git commands run with `{ cwd }` pointing to the worktree path.

**Auth model:** The gh credential helper configured by #15's `docker/agent/entrypoint.sh` handles HTTPS authentication transparently. The handler does NOT read `GH_TOKEN` or inject credentials into the push command. `git push origin <branch>` just works because `gh auth setup-git` configured the credential helper at container start.

### 2. Commit Message Derivation

The handler constructs a structured commit message from the invocation's `request.action` and `request.correlationId`. Two paths:

**Path A -- Ticket ID found in action:**

Scan `request.action` for a ticket ID pattern: `#\d+` (e.g., `#12`, `#42`). Use the **first match** as the commit prefix.

Format: `#<id>: <action gist>`

Example: action = `"Implement handler-controlled commit for #12"` produces `#12: Implement handler-controlled commit for #12`

**Path B -- No ticket ID in action:**

Fall back to a correlationId-based reference using the first 8 characters of the correlationId.

Format: `(no-ticket/<corrId-short>): <action gist>`

Example: action = `"Fix linting errors"`, correlationId = `"abc123def456"` produces `(no-ticket/abc123de): Fix linting errors`

**Gist rules:**

- Use the first line of `request.action` as the gist (split on `\n`, take index 0)
- Truncate to 80 characters max for the full first line (prefix + gist combined)
- If the action is multi-line, the remaining lines are NOT appended to the commit message body -- keep it to a single-line message. The invocation metadata (correlationId, action) is already logged by the handler.

Extract the message derivation into a pure helper function for testability:

```ts
/** Visible for testing. */
export function deriveCommitMessage(action: string, correlationId: string): string
```

### 3. Order of Operations in `runInvocation()`

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

The current structure under #11 is:

```
try {
  git fetch origin
  git worktree add
  try {
    execute()
    logResult()
    checkUncommittedChanges()    <-- REPLACE THIS
    return response
  } catch { ... }
  finally { worktree remove }
}
```

The change:

```
try {
  git fetch origin
  git worktree add
  try {
    execute()
    logResult()
    if (result.success) {
      await this.commitAndPush(worktreePath, request)   <-- NEW
    }
    return response
  } catch { ... }
  finally { worktree remove }
}
```

**Critical: only commit on success.** If the SDK execution fails (`result.success === false`), do NOT commit. Failed invocations may have left the worktree in a broken state -- committing garbage is worse than losing the changes (the worktree is ephemeral anyway).

**Error handling for `commitAndPush`:** If `commitAndPush()` throws (e.g., push rejected), the error must be surfaced in the `InvokeResponse`. Wrap the call so a failure changes the response to `{ success: false, error: "Commit/push failed: <message>" }`. The worktree remove in `finally` still runs regardless.

### 4. Update `deniedBashCommands` for All Roles

**File:** `apps/agent/src/config/role-tool-profiles.ts`

Under the "handler does git" model, ALL roles must deny: `git commit`, `git push`, `git checkout -b`, `git branch`.

The tool guard hook uses **prefix matching after normalisation** (collapse whitespace, strip sudo, lowercase) -- see `tool-guard-hook.ts:105-113`. So denied prefix `'git push'` matches `git push origin main`, `git push --force`, `git  push` (extra spaces), etc. And `'git commit'` matches `git commit -m "..."`, `git commit --amend`, etc.

Current state and required changes per role:

| Role | Current deniedBashCommands | Changes needed |
|------|--------------------------|----------------|
| **developer** | `git push --force`, `git push -f`, `rm -rf /` | Replace with: `git commit`, `git push`, `git checkout -b`, `git branch`, `rm -rf /` |
| **architect** | `git push`, `git commit`, `git checkout -b`, `rm -rf`, `npm publish` | Add: `git branch`. Rest already covered. |
| **teamlead** | `git push --force`, `git push -f`, `rm -rf /`, `npm publish` | Replace force-push-only entries with: `git commit`, `git push`, `git checkout -b`, `git branch`, `rm -rf /`, `npm publish` |
| **qa** | `git push`, `git commit`, `rm -rf`, `npm publish` | Add: `git checkout -b`, `git branch`. Rest already covered. |
| **productowner** | `[]` (Bash fully disabled at tool level) | No change -- Bash is disabled entirely via `disallowedTools` |

**Note on developer/teamlead:** The current `git push --force` and `git push -f` entries are subsumed by the broader `git push` prefix. Remove the old force-specific entries and replace with the bare `git push`.

### 5. Update Tool Guard Tests

**File:** `apps/agent/src/config/tool-guard-hook.spec.ts`

The existing bash filtering tests (lines 93-149) use a profile with `deniedBashCommands: ['git push', 'rm -rf', 'npm publish']`. These tests remain valid -- the behaviour hasn't changed, only the per-role profiles have.

Add new test cases to cover the newly denied commands:

- `git commit -m "message"` denied
- `git commit --amend` denied
- `git checkout -b new-branch` denied (but `git checkout main` still allowed -- prefix is `git checkout -b`, not `git checkout`)
- `git branch feature-x` denied
- `git branch -D feature-x` denied

These can go in the existing `bash filtering` describe block or a new subsection.

### 6. Update InvocationHandler Tests

**File:** `apps/agent/src/connection/invocation-handler.service.spec.ts`

The existing `uncommitted changes check` describe block (lines 920-1029) must be reworked or replaced with a `commit and push` describe block. Tests to add:

- **Happy path:** SDK succeeds with changes present -> handler runs `git add -A`, `git commit -m "..."`, `git push origin <branch>`. Verify command sequence and cwd.
- **No changes:** SDK succeeds, `git status --porcelain` returns empty -> no commit, no push, invocation still succeeds. Verify INFO log.
- **Push rejection:** `git push` fails -> `InvokeResponse` has `success: false` with error containing the push stderr.
- **Commit message with ticket ID:** action contains `#42` -> commit message starts with `#42:`.
- **Commit message without ticket ID:** action has no ticket pattern -> commit message uses `(no-ticket/<corrId>):` format.
- **No commit on failure:** SDK returns `success: false` -> `commitAndPush()` is NOT called. Verify no `git add` or `git commit` commands.
- **Commit message truncation:** action longer than 80 chars -> first line of commit message is truncated.

The existing `deriveCommitMessage` helper should also have direct unit tests since it's exported.

## Acceptance Criteria

- [ ] `checkUncommittedChanges()` replaced by `commitAndPush(cwd, request)` in `InvocationHandler`
- [ ] Commit message uses ticket-ID prefix when `#<number>` pattern found in action (e.g., `#12: <gist>`)
- [ ] Commit message uses correlationId fallback when no ticket ID found (e.g., `(no-ticket/abc123de): <gist>`)
- [ ] Commit message first line is 80 chars max
- [ ] `git push origin <branch>` runs after commit (no force-push); push rejection surfaces as `InvokeResponse { success: false, error: "..." }`
- [ ] No commit/push when `result.success === false` (error path skips commit)
- [ ] No commit/push when worktree has no changes after execution (log INFO, return success)
- [ ] `deniedBashCommands` updated: developer denies `git commit`, `git push`, `git checkout -b`, `git branch`
- [ ] `deniedBashCommands` updated: teamlead denies `git commit`, `git push`, `git checkout -b`, `git branch`
- [ ] `deniedBashCommands` updated: architect adds `git branch` (already denies `git push`, `git commit`, `git checkout -b`)
- [ ] `deniedBashCommands` updated: qa adds `git checkout -b`, `git branch` (already denies `git push`, `git commit`)
- [ ] `tool-guard-hook.spec.ts` updated with tests for newly denied git commands
- [ ] `invocation-handler.service.spec.ts` updated: happy-path commit/push test, no-changes test, push-rejection test, commit-message format tests, no-commit-on-failure test

## Dependencies and References

- **Depends on:** #11 (worktree cwd -- merged), #15 (PAT wiring -- merged)
- **Blocks:** None directly, but completes the handler-controlled git model that the overall QRM8 isolation depends on
- **Design reference:** `tickets/8-workspace-isolation.md` -- D2 (Handler-Controlled Commits), Concern #7 (tool-guard updates)
- **Code reference:** `apps/agent/src/config/tool-guard-hook.ts` lines 105-113 -- `normaliseBashCommand()` shows the prefix matching logic (collapse whitespace, strip sudo, lowercase)
- **Related:** #13 (branch-in-flight guard) -- operates at the broker level, independent of this handler-level change
- **Issue:** https://github.com/ia64mail/quorum/issues/12
