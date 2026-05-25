# #12: Handler-Controlled Commit and Push

## Summary

Move `git add`, `git commit`, and `git push` out of the SDK loop and into `InvocationHandler`. Agents only edit files and populate a `commitMessage` on their response; the handler stages, commits with the agent-provided message, and pushes to the remote after `claudeCode.execute()` completes. This completes the "agents only edit, handler does git" model established by #11's worktree isolation.

## Problem Statement

Today, agents with developer/teamlead roles can run `git commit` directly via Bash during the SDK loop. The handler only detects uncommitted changes post-invocation (`checkUncommittedChanges()` at `invocation-handler.service.ts:272`). This creates several problems:

- **Uncontrolled commit timing** -- agents commit mid-task, capturing partial work
- **Inconsistent commit messages** -- each agent formats messages differently; no structured convention is enforced
- **No handler-level verification** -- the handler has no opportunity to validate or control what gets committed before it reaches the remote
- **Partial commits on error** -- an agent that commits halfway through a task and then fails leaves broken commits on the branch

Under the QRM8 model, the handler is the sole committer. The agent that did the work has full context (action, files changed, decisions made) and is therefore best positioned to author the commit message. The agent populates `commitMessage` on `InvokeResponse`; after SDK execution completes successfully, the handler checks for changes, stages everything, commits using the agent-provided message (or a minimal fallback), and pushes to the remote. Agents are mechanically prevented from running git commit/push through updated `deniedBashCommands` for all roles.

**Dependencies:** #11 (worktree cwd -- commit/push targets the worktree) and #15 (PAT wiring -- push authenticates via the gh credential helper configured by #15's agent entrypoint). Both are merged.

## Implementation Details

### 1. Extend `InvokeResponse` Schema

**File:** `libs/common/src/messaging/invoke.types.ts`

Add an optional `commitMessage` field to the `InvokeResponse` interface:

```ts
export interface InvokeResponse {
  success: boolean;
  result?: string;
  error?: string;
  totalCostUsd?: number;
  durationMs?: number;
  sessionId?: string;
  /**
   * Populated by the agent when work resulted in file changes.
   * Used verbatim by InvocationHandler for the commit message.
   * Optional — a minimal fallback applies if missing.
   */
  commitMessage?: string;
}
```

This field is populated by agents that modified files during the invocation. The handler consumes it in `commitAndPush()`. It is never parsed from external input — `InvokeResponse` is constructed internally by the broker/handler (the existing comment on the interface already notes this).

### 2. Replace `checkUncommittedChanges()` with `commitAndPush()`

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

Replace the existing `checkUncommittedChanges()` method (lines 272-291) with a new `commitAndPush()` method.

**Method signature:**

```ts
private async commitAndPush(
  cwd: string,
  request: InvokeRequest,
  response: InvokeResponse,
): Promise<void>
```

**Logic:**

1. Run `git status --porcelain` in the worktree cwd
2. **If no changes**: log INFO `"No changes to commit after invocation: correlationId=<id>"` and return early — skip commit/push entirely
3. **If changes exist AND `response.commitMessage` is present**: use it verbatim
   - `git add -A && git commit -m "<response.commitMessage>" && git push origin <request.branch>`
   - This is the primary, well-lit path
4. **If changes exist AND `commitMessage` is missing**: synthesize a minimal fallback message and log WARN
   - Fallback format: `(no-message/<corrId-short>): changes from <request.target> invocation`
   - `<corrId-short>` = first 8 characters of `request.correlationId`
   - Log WARN: `"Agent did not provide commitMessage: correlationId=<id> — using fallback"` so it's observable
   - Still commits and pushes — do NOT fail the invocation because the agent forgot
5. On push failure: throw an error that surfaces in `InvokeResponse` as `{ success: false, error: "push rejected: <stderr>" }`

All git commands run with `{ cwd }` pointing to the worktree path.

**Auth model:** The gh credential helper configured by #15's `docker/agent/entrypoint.sh` handles HTTPS authentication transparently. The handler does NOT read `GH_TOKEN` or inject credentials into the push command. `git push origin <branch>` just works because `gh auth setup-git` configured the credential helper at container start.

**Note on the old `deriveCommitMessage()` helper:** The prior design proposed a regex-based helper that scanned `request.action` for ticket IDs. That approach is replaced by the agent-authored `commitMessage` on `InvokeResponse`. The simple fallback message above does not need a separate exported function — inline it in `commitAndPush()`. If test ergonomics favor extraction, a private helper is fine but it does not need to be exported (no regex parsing, no ticket-ID scanning).

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
      await this.commitAndPush(worktreePath, request, response)   <-- NEW
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

### 5. Update Agent Role Prompt — Git Discipline Section

**File:** `libs/common/src/prompts/role-prompt-templates.ts`

The `SYSTEM_PREAMBLE` constant contains a "Git Discipline" section (lines 89-98) that currently tells agents to commit before returning using the `QRMX-NNN: <description>` format. Under #12 this is no longer accurate — agents must NOT run `git commit`/`git push` directly (deny rules will block it). The section must be rewritten to reflect the handler-controlled commit model.

**Replace the current Git Discipline section with:**

```
## Git Discipline

Under handler-controlled commits, you do NOT run \`git commit\` or \`git push\` directly — those commands are denied.

When your task results in file changes, populate the \`commitMessage\` field on your \`InvokeResponse\` describing what changed. The handler will stage all changes, commit using your message verbatim, and push to the remote.

**Commit message format:** Follow the canonical convention from quorum.md Codebase Conventions:
- \`#<issue-number>: <concise description>\` (post-#20 standard)
- \`QRMX-NNN: <concise description>\` (legacy, for tickets predating the GH-issue convention)

If your task involved multiple logically distinct changes, bundle them into a single commit message — use a multi-line format (first line: summary; body: details). The handler performs one commit per invocation; multiple commits per invocation are not supported.

If you do not populate \`commitMessage\`, the handler will use a minimal fallback — but this is a last resort. Always provide a meaningful commit message when you modified files.
```

**Key differences from the prior version:**
- Removes instruction to run `git commit` directly
- Removes "use separate commits" for multiple logical units (handler does single commit)
- Adds instruction to populate `commitMessage` on `InvokeResponse`
- References the canonical format from `quorum.md` instead of hardcoding a single format
- Notes the single-commit-per-invocation constraint

### 6. Update Tool Guard Tests

**File:** `apps/agent/src/config/tool-guard-hook.spec.ts`

The existing bash filtering tests (lines 93-149) use a profile with `deniedBashCommands: ['git push', 'rm -rf', 'npm publish']`. These tests remain valid -- the behaviour hasn't changed, only the per-role profiles have.

Add new test cases to cover the newly denied commands:

- `git commit -m "message"` denied
- `git commit --amend` denied
- `git checkout -b new-branch` denied (but `git checkout main` still allowed -- prefix is `git checkout -b`, not `git checkout`)
- `git branch feature-x` denied
- `git branch -D feature-x` denied

These can go in the existing `bash filtering` describe block or a new subsection.

### 7. Update InvocationHandler Tests

**File:** `apps/agent/src/connection/invocation-handler.service.spec.ts`

The existing `uncommitted changes check` describe block (lines 920-1029) must be reworked or replaced with a `commit and push` describe block. Tests to add:

- **Happy path (with commitMessage):** SDK succeeds with changes present and `response.commitMessage` set -> handler runs `git add -A`, `git commit -m "<commitMessage>"`, `git push origin <branch>`. Verify command sequence and cwd.
- **Happy path (fallback):** SDK succeeds with changes present but `response.commitMessage` is undefined -> handler uses fallback message format `(no-message/<corrId-short>): changes from <target> invocation`. Verify WARN log emitted.
- **No changes:** SDK succeeds, `git status --porcelain` returns empty -> no commit, no push, invocation still succeeds. Verify INFO log.
- **Push rejection:** `git push` fails -> `InvokeResponse` has `success: false` with error containing the push stderr.
- **No commit on failure:** SDK returns `success: false` -> `commitAndPush()` is NOT called. Verify no `git add` or `git commit` commands.
- **Multi-line commitMessage:** Agent provides a multi-line commit message -> handler passes it through verbatim (no truncation by the handler).

No `deriveCommitMessage` unit tests are needed — the old regex-based exported helper is replaced by the trivial inline fallback.

## Acceptance Criteria

- [x] `InvokeResponse` interface extended with optional `commitMessage?: string` field (with inline doc comment)
- [x] `checkUncommittedChanges()` replaced by `commitAndPush(cwd, request, response)` in `InvocationHandler`
- [x] When `response.commitMessage` is present: handler uses it verbatim for `git commit -m`
- [x] When `response.commitMessage` is absent and changes exist: handler synthesizes fallback `(no-message/<corrId-short>): changes from <target> invocation` and logs WARN
- [x] `git push origin <branch>` runs after commit (no force-push); push rejection surfaces as `InvokeResponse { success: false, error: "..." }`
- [x] No commit/push when `result.success === false` (error path skips commit)
- [x] No commit/push when worktree has no changes after execution (log INFO, return success)
- [x] `deniedBashCommands` updated: developer denies `git commit`, `git push`, `git checkout -b`, `git branch`
- [x] `deniedBashCommands` updated: teamlead denies `git commit`, `git push`, `git checkout -b`, `git branch`
- [x] `deniedBashCommands` updated: architect adds `git branch` (already denies `git push`, `git commit`, `git checkout -b`)
- [x] `deniedBashCommands` updated: qa adds `git checkout -b`, `git branch` (already denies `git push`, `git commit`)
- [x] `tool-guard-hook.spec.ts` updated with tests for newly denied git commands
- [x] `invocation-handler.service.spec.ts` updated: happy-path commit/push tests (with and without commitMessage), no-changes test, push-rejection test, fallback-message + WARN test, no-commit-on-failure test
- [x] `SYSTEM_PREAMBLE` Git Discipline section rewritten: agents told NOT to run `git commit`/`git push`, instructed to populate `commitMessage` on `InvokeResponse`, canonical format referenced, single-commit-per-invocation constraint noted

## Out of Scope

- **Multi-commit per invocation** — one commit per invocation, possibly with a multi-line message. The handler does not split changes into multiple commits.
- **Per-role commit message format differences** — the canonical format from `quorum.md` Codebase Conventions applies uniformly to all roles.
- **Agent failure to populate `commitMessage`** — does NOT fail the invocation. The fallback path is forgiving by design; the WARN log makes it observable.
- **Handler-side commit message validation or transformation** — the handler uses the agent's message verbatim. Format enforcement is a prompt-level concern, not a runtime guard.

## Dependencies and References

- **Depends on:** #11 (worktree cwd -- merged), #15 (PAT wiring -- merged)
- **Blocks:** None directly, but completes the handler-controlled git model that the overall QRM8 isolation depends on
- **Design reference:** `tickets/8-workspace-isolation.md` -- D2 (Handler-Controlled Commits), Concern #7 (tool-guard updates)
- **Code reference:** `apps/agent/src/config/tool-guard-hook.ts` lines 105-113 -- `normaliseBashCommand()` shows the prefix matching logic (collapse whitespace, strip sudo, lowercase)
- **Code reference:** `libs/common/src/messaging/invoke.types.ts` lines 155-168 -- `InvokeResponse` interface (target for `commitMessage` field)
- **Code reference:** `libs/common/src/prompts/role-prompt-templates.ts` lines 89-98 -- `SYSTEM_PREAMBLE` Git Discipline section (target for rewrite)
- **Related:** #13 (branch-in-flight guard) -- operates at the broker level, independent of this handler-level change
- **Issue:** https://github.com/ia64mail/quorum/issues/12

## Implementation Notes

**Status:** Complete

### Files Modified

**Pass A (schema + handler + handler tests):**
- `libs/common/src/messaging/invoke.types.ts` — added optional `commitMessage?: string` to `InvokeResponse`
- `apps/agent/src/connection/invocation-handler.service.ts` — replaced `checkUncommittedChanges()` with `commitAndPush(cwd, request, response)`, gated on `result.success`
- `apps/agent/src/connection/invocation-handler.service.spec.ts` — replaced uncommitted-changes test block with commit-and-push tests (verbatim message, fallback + WARN, no-changes INFO, push rejection, no-commit-on-failure, multi-line message)

**Pass B (deny rules + prompt + tool guard tests + ticket flips):**
- `apps/agent/src/config/role-tool-profiles.ts` — updated `deniedBashCommands` for developer (replaced `git push --force`/`-f` with full set), teamlead (same), architect (added `git branch`), qa (added `git checkout -b` + `git branch`). Productowner unchanged (Bash fully disabled).
- `libs/common/src/prompts/role-prompt-templates.ts` — rewrote Git Discipline section in `SYSTEM_PREAMBLE` to handler-controlled commit model; updated Capabilities sections for architect, teamlead, developer, and qa roles to reflect new deny lists.
- `apps/agent/src/config/tool-guard-hook.spec.ts` — added 13 tests in `handler-controlled git deny patterns` block covering all newly denied commands, allowed read-only commands, whitespace normalization, and sudo stripping.
- `libs/common/src/prompts/role-prompt-templates.spec.ts` — updated existing tests to match rewritten Git Discipline section and updated role capability descriptions.
- `tickets/12-handler-commit-push.md` — flipped all 14 ACs, added this Implementation Notes section.

### Deviations from Spec

None. Implementation follows the ticket spec exactly.

### Verification Results

- `npm run build` — passes
- `npm run lint` — passes (0 errors, 0 warnings)
- `npm run test` — 813 tests across 46 suites, all passing (baseline 798 + 6 handler tests from Pass A + 13 tool guard tests from Pass B, minus 4 removed/replaced prompt template tests + updated replacements)

### Agent-Affecting Change

**⚠️ Post-merge rebuild required.** The `SYSTEM_PREAMBLE` Git Discipline rewrite changes what agents see in their system prompt. The `deniedBashCommands` updates change what the tool guard hook enforces at runtime. Both take effect only after rebuilding and restarting agent containers:

```bash
docker compose build architect developer teamlead qa && docker compose up -d
```

Agents must read the new prompt to understand that they should populate `commitMessage` on their `InvokeResponse` instead of running `git commit`/`git push` directly.
