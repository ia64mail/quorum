# QRM4-BUG-015: Agents Do Not Commit Work Before Returning

## Summary

In Run 10, seven agent invocations modified 7+ files (31 new tests, 4 documentation updates, ticket files) but none committed their changes. The shared workspace accumulated uncommitted modifications across the entire session, with no git trail of which agent changed what or when. Adding commit discipline — via prompt instructions and a post-invocation safety net — would bring order to multi-agent file modifications and provide an auditable history of each agent's contributions.

## Problem Statement

Run 10 completed the QRM4 milestone: two tickets through the full pipeline (ticket creation → implementation → review) across 7 invocations. Every invocation that modified files returned successfully without committing:

| Invocation | Agent | Files Changed | Committed? |
|-----------|-------|---------------|------------|
| Architect: roadmap scan | architect | 0 (read-only) | N/A |
| TeamLead: QRM4-005 ticket | teamlead | 1 (ticket file) | **No** |
| TeamLead: QRM4-006 ticket | teamlead | 1 (ticket file) | **No** |
| Developer: QRM4-005 impl | developer | 3 (spec files) | **No** |
| Developer: QRM4-006 impl | developer | 4 (docs/config) | **No** |
| TeamLead: QRM4-005 review | teamlead | 0 (read-only review) | N/A |
| TeamLead: QRM4-006 review | teamlead | 0 (read-only review) | N/A |

At session end, all modifications existed as unstaged changes in the workspace — 42 context items were persisted to the Context Store, but zero git commits recorded the file-level work.

### Why this matters

1. **No attribution trail** — `git log` shows nothing from the session. It's impossible to determine which agent modified which file, or in what order. For debugging, rollback, or post-session analysis, the git history is the primary artifact.

2. **No atomic rollback** — if the developer's QRM4-006 implementation had introduced a regression, there's no way to `git revert` just that agent's changes. Everything is a single undifferentiated blob of uncommitted work.

3. **Review integrity** — the teamlead reviewed QRM4-005 and accepted 10/10, but the reviewed code was never snapshotted. If a subsequent invocation modified the same files (possible in parallel dispatch), the review verdict applies to code that no longer matches what was reviewed.

4. **Parallel dispatch risk** — Run 10 dispatched two parallel pairs (teamlead + developer at 00:43:16 and 00:47:07). If both agents modify overlapping files without committing, changes from one can silently overwrite the other's work. Commits between invocations create save points.

### Current state

- The developer role prompt (`libs/common/src/prompts/role-prompt-templates.ts`) mentions "Git operations — read history, create branches, commit changes" as an allowed capability, but does not instruct agents to commit before returning.
- Docker containers have git identity pre-configured (`GIT_AUTHOR_NAME: Quorum Agent`, `GIT_AUTHOR_EMAIL: quorum-agent@noreply.local` in `docker-compose.yml`).
- `InvocationHandler.handle()` packages the response immediately after `claudeCode.execute()` returns — no post-execution validation occurs.

## Design Context

Agents share a single workspace repository mounted at `/mnt/quorum/workspace`. All file modifications are immediately visible to all agents regardless of commits — commits don't affect cross-agent visibility, but they provide **ordering, attribution, and rollback points**.

The enforcement should be two-layered:

1. **Soft enforcement (prompt instructions)** — instruct agents to commit their work with a descriptive message before completing their task. This is the primary mechanism — Claude Code agents are highly responsive to prompt instructions and git commit is a natural part of their workflow.

2. **Hard enforcement (post-invocation check)** — after the SDK returns, check `git status` for uncommitted changes. If found, log a warning. This catches cases where the agent forgot or was cut off by `maxTurns`.

The hard enforcement layer should **warn, not fail** — failing the invocation after the agent has already done useful work would be counterproductive. The warning surfaces the gap for the moderator and session analysis.

## Implementation Details

### Part 0: Project convention in quorum.md

Add a **Commit Message Convention** subsection to the `## Codebase Conventions` section of `quorum.md`. This establishes a project-wide rule that every commit message starts with the ticket ID, making `git log --grep=QRM4-005` a reliable way for agents (and humans) to locate all work related to a ticket.

Current git history illustrates the problem: some commits bury the ticket ID mid-message (`fix moderator prompt caching and cost tracking (QRM4-BUG-012)`), some omit it entirely (`Improve InMemoryStore search functionality`), and some use inconsistent formats. Agents searching history with `git log --grep` get incomplete results.

Add the following to `quorum.md` under `## Codebase Conventions`:

```markdown
### Commit Messages
- **Prefix every commit with the ticket ID**: `QRMX-NNN: <concise description>`
- For bug tickets: `QRMX-BUG-NNN: <concise description>`
- When no ticket applies (e.g. ad-hoc fixes during session): `QRMX(no-ticket): <description>`
- Keep the description concise — what changed and why, not how
- Multiple logical units → separate commits, each with the same ticket prefix
- Examples:
  - `QRM4-005: add bootstrap context unit tests`
  - `QRM4-BUG-012: fix moderator prompt caching`
  - `QRM4(no-ticket): fix typo in docker-compose healthcheck`
```

This convention lives in `quorum.md` because it's a **project rule** that applies to all agents and human contributors, not just prompt-injected guidance. The prompt instructions in Part 1 reinforce it.

### Part 1: Prompt instructions

Add commit requirements to the role prompt templates in `libs/common/src/prompts/role-prompt-templates.ts`. Each role that modifies files should include an instruction to commit before returning.

The instruction should be added to the `SYSTEM_PREAMBLE` (shared across all roles) rather than individual role templates, since any role could modify files. Place it in the workflow/process section of the preamble.

Suggested prompt addition:
```
## Git Discipline

When you modify files during a task, commit your changes before completing the invocation.
Follow the commit message convention from quorum.md — always prefix with the ticket ID:
Format: `QRMX-NNN: <concise description>`
Example: `QRM4-005: add bootstrap context unit tests`

If you created or modified multiple logical units, use separate commits.
Do not commit if you only read files or queried context without making changes.
```

This is soft enforcement — the agent may still forget under `maxTurns` pressure or if it runs out of turns mid-implementation. Part 2 catches those cases.

### Part 2: Post-invocation uncommitted changes check

In `apps/agent/src/connection/invocation-handler.service.ts`, after `claudeCode.execute()` returns and before packaging the `InvokeResponse`, run a `git status --porcelain` check in the workspace directory.

The check should:
1. Execute `git status --porcelain` in the workspace directory
2. If the output is non-empty (uncommitted changes exist), log a warning with the list of modified files
3. Include a `hasUncommittedChanges: boolean` flag in the response metadata (extend `InvokeResponse` if needed, or log-only for now)
4. Never fail the invocation — the work is done, the commit gap is informational

Implementation sketch for the post-invocation check:

```typescript
// After claudeCode.execute() returns, before packaging response
private async checkUncommittedChanges(correlationId: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: this.config.agent.workspaceDir,
    });
    if (stdout.trim()) {
      this.logger.warn(
        `Uncommitted changes after invocation: correlationId=${correlationId}\n${stdout.trim()}`,
      );
      return true;
    }
    return false;
  } catch {
    return false; // git not available or not a repo — skip silently
  }
}
```

This is a diagnostic tool, not a gate. It surfaces the problem in logs and session reports so it can be tracked over time.

### Part 3: Moderator confirmation gates (deferred)

Run 10 was the first session where the moderator auto-continued through the entire pipeline without user confirmation. This may be the intended behavior for "complete the milestone" prompts. Observe the next 2-3 runs to determine whether confirmation gates should be configurable (e.g., a `MODERATOR_AUTO_CONTINUE` env var or a per-phase confirmation mode). If the no-pause pattern consistently produces good results, codify it. If it causes issues (e.g., implementing the wrong thing without a chance to correct), add gates.

This part is **out of scope** for this ticket — noted here for context and future reference.

### Files to modify

| File | Change |
|------|--------|
| `quorum.md` | Add `### Commit Messages` subsection under `## Codebase Conventions` |
| `libs/common/src/prompts/role-prompt-templates.ts` | Add git discipline section to `SYSTEM_PREAMBLE` |
| `libs/common/src/prompts/role-prompt-templates.spec.ts` | Update snapshot/assertion tests if preamble content is validated |
| `apps/agent/src/connection/invocation-handler.service.ts` | Add `checkUncommittedChanges()` method, call after `execute()` returns |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Add tests for uncommitted changes check (mock `execAsync`) |

## Acceptance Criteria

- [ ] `quorum.md` has a `### Commit Messages` convention under `## Codebase Conventions` requiring ticket-ID-prefixed commits
- [x] `SYSTEM_PREAMBLE` in role prompt templates includes git commit instructions for agents that modify files
- [ ] Commit message format in the prompt references the `quorum.md` convention (ticket ID prefix)
- [x] `InvocationHandler` checks `git status --porcelain` after agent execution completes
- [x] Uncommitted changes are logged as a warning with the list of affected files
- [x] The check never fails or blocks the invocation — warning only
- [x] The check handles non-git workspaces gracefully (no crash if git is unavailable)
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` — all existing tests pass, no regressions

## Dependencies and References

- **Prompt templates:** `libs/common/src/prompts/role-prompt-templates.ts`
- **Invocation handler:** `apps/agent/src/connection/invocation-handler.service.ts`
- **Git identity config:** `docker-compose.yml` (lines 10-13) — `GIT_AUTHOR_NAME: Quorum Agent`
- **Observed in:** Run 10 (`logs/sessions/2026-04-10-qrm4-run10.md`) — 0 commits across 7 invocations
- **Related:** Run 10 Issue #2 (no user confirmation pauses) — deferred, observe next runs

## Implementation Notes

**Status:** Accepted ✅ — All 9/9 acceptance criteria verified.

**Commit:** `da0e928`

**Files modified:**
| File | Change |
|------|--------|
| `libs/common/src/prompts/role-prompt-templates.ts` | Added `## Git Discipline` section to `SYSTEM_PREAMBLE` with commit instructions, message format, multi-commit guidance, and read-only skip rule |
| `libs/common/src/prompts/role-prompt-templates.spec.ts` | 3 new tests: commit instructions present, commit format specified, no-commit-for-reads instruction |
| `apps/agent/src/connection/invocation-handler.service.ts` | Added `checkUncommittedChanges()` private method using `promisify(exec)` + `git status --porcelain`. Injected `AgentConfigService` for `workspaceDir`. Called after `logResult()` in `handle()` |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | 7 new tests: git status called, warning on dirty, no warning on clean, git unavailable, non-git repo, success despite dirty, check on failed invocations |

**Deviations:** None — implementation matches ticket spec exactly.

**Verification results:**
- `npm run build`: 4 bundles compiled successfully
- `npm run lint`: 0 errors, 0 warnings
- `npm run test`: 39 suites, 537 tests, all pass (10 new tests total)