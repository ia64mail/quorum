# #65: Worktree commit/push hardening — agent-made commits orphan in the shared clone instead of reaching origin

## Summary

An agent invocation that commits inside its git worktree can leave a commit that **never reaches origin**. The commit advances the branch ref in the agent's shared clone (`/var/agent-repo/.git`), but origin stays behind, so the commit is invisible to the moderator (which reads origin) and poisons every later worktree on that branch (worktrees branch from the local ref). The result is "agent says done, moderator can't see it," split-brain *hallucinated-commit* recovery loops, and non-fast-forward push failures.

Three compounding defects produce this, all in `apps/agent`:

1. **Deny-guard is prefix-only** — agents can commit despite the design forbidding it.
2. **Sandbox enables commit but not push** — the agent has git *identity* but no *credential*, so its own `git push` always fails (this is the **intentional** secret-isolation boundary, QRM8 D5 — kept as-is).
3. **Framework won't clean up** — the handler's `commitAndPush` returns early on a clean working tree, so an agent-made commit is never pushed by the one process that *can* push.

The keystone is defect 3: fix it and agent-made commits stop becoming orphans regardless of how they were made. This ticket lands the keystone plus the surrounding hardening so the failure mode cannot recur and self-heals when it does ("full hardening" scope).

## Problem Statement

The intended design is **handler-controlled commits** (`docs/system-design.md:413`): the agent SDK subprocess must not run `git commit`/`git push`/`git checkout -b`/`git branch`; the `InvocationHandler` is the sole committer — it runs `git add -A && git commit` (message authored by the agent and returned in `InvokeResponse.commitMessage`) and `git push origin <branch>` after each successful invocation (`docs/system-design.md:202`). Cross-agent visibility flows only through origin (`docs/system-design.md:209`).

That invariant is violated in three independent ways.

### Defect 1 — the deny-guard is prefix-only and bypassable

`apps/agent/src/config/role-tool-profiles.ts` denies `git commit`, `git push`, `git checkout -b`, `git branch` for every role. But `apps/agent/src/config/tool-guard-hook.ts` enforces the deny list with `normalised.startsWith(prefix)` over the whole command string (after collapsing whitespace, stripping leading `sudo`, lowercasing):

```ts
// tool-guard-hook.ts (Bash branch)
for (const prefix of deniedPrefixes) {
  if (normalised.startsWith(prefix)) { return { allowed: false, ... }; }
}
```

Anything that does not *start with* the denied token slips through:

- `cd <worktree> && git commit …` → starts with `cd` → **allowed**
- `git -C <worktree> commit …` → starts with `git -c` → **allowed**
- `GIT_AUTHOR_DATE=… git commit …` (env prefix) → **allowed**

So an agent that decides to commit (e.g. while running `/code-review`) can, in practice, get a commit through.

### Defect 2 — the sandbox lets the agent commit but not push (intentional; do not loosen)

The CC CLI subprocess env is an allowlist, `SDK_ENV_ALLOWLIST` in `apps/agent/src/llm/claude-code.service.ts:26-46`. It forwards git **identity** but not the **credential path**:

- Forwarded: `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, `HOME`, `PATH`, … → `git commit` succeeds.
- Excluded: `GH_TOKEN` (the GitHub PAT) and `GIT_CONFIG_GLOBAL` (points at the gh credential-helper config written by `docker/agent/entrypoint.sh:21-23`) → the agent's `git push` has no credential helper and fails to authenticate.

This is the **deliberate** secret-isolation boundary (QRM8 D5): the agent is an LLM that can read its own environment and could leak `GH_TOKEN` (print it, write it to a file, push it, or be prompt-injected into doing so via code under review). Keeping the token out of the model-visible process is correct and **must not change**. The handler process (NestJS, PID-1 tree) *does* hold the token and is the intended pusher. The consequence — an agent that can commit but not push — is only a *problem* because of defects 1 and 3.

### Defect 3 — the framework won't push commits it didn't make (keystone)

`InvocationHandler.commitAndPush` (`apps/agent/src/connection/invocation-handler.service.ts:318-362`) gates the entire commit+push on a dirty working tree:

```ts
const { stdout: status } = await execAsync('git status --porcelain', { cwd });
if (!status.trim()) {
  this.logger.log(`No changes to commit after invocation: …`);
  return;                       // <-- early return: nothing committed, NOTHING PUSHED
}
```

When the agent already committed (defect 1), the tree is clean, so the handler returns here and **never pushes**. The handler only pushes changes *it* commits; it never checks for commits already ahead of origin (`git rev-list origin/<branch>..HEAD`). The agent's commit is stranded in the shared clone.

### How they compound

Defect 1 lets the agent commit → defect 2 stops the agent from pushing it → defect 3 stops the handler from pushing it → the commit lives only in the shared clone: invisible to the moderator and inherited by the next worktree on that branch.

### Evidence

- **#59 session (timeout-triggered), `logs/sessions/2026-06-17-qrm9-59-role-keyed-partition.md` §1.** The teamlead committed `4536832` locally during a timed-out-but-completed `/code-review`; it never pushed. The moderator (reading origin) concluded the commit was *hallucinated*; the teamlead (reading its worktree) insisted the work was done. Recovery took ~4 extra invocations, ~$2.35, ~40 min, and ended in an authorized `git reset --hard`. `git branch -a --contains 4536832` confirms it never reached any ref.
- **#63 session (no timeout — live, 2026-06-20).** The defect reproduced *without* any timeout. Both the developer and the teamlead independently committed the #63 stub work; none of it reached origin. Recovered manually by pushing the developer's commits to origin (`d853685` on `49-stabilization`, new branch `63-conversation-scope-correlation-reuse` at `17c9055`) and resetting the teamlead clone's divergent siblings (identical blobs, different SHAs) back to origin. This proves the orphan path is reachable in normal operation, not only under the broker/agent timeout split of #59.

## Design Context

- Single source of truth is **origin**; agent clones are disposable and sync only through the GitHub remote (`docs/system-design.md:63, 209`). The correct posture is therefore: every invocation should *start* from origin and *end* with everything it produced pushed to origin.
- The fix must preserve **handler-as-sole-pusher** (`docs/system-design.md:413`) and the **secret-isolation allowlist** (defect 2 / QRM8 D5). The remedy is to make the handler's push reliable and the worktree self-healing — **not** to grant the agent push rights.
- Relationship to #59 §1: that issue recommended (a) routing long reviews through the #47 always-pending mechanism so the broker doesn't write off a still-running agent, and (b) a worktree-level guard against orphan commits. This ticket implements the (b) family generically; the (a) timeout-routing fix is complementary and tracked separately under #47's lineage.

## Implementation Details

All changes are in `apps/agent`; no MCP, schema, or moderator changes.

### 1. `commitAndPush` — push anything ahead of origin (keystone)

In `invocation-handler.service.ts`, replace the clean-tree early-return with: commit only if dirty, then **always** push when the local branch is ahead of its remote-tracking ref. Determine "ahead" with `git rev-list --count origin/<branch>..HEAD` (the remote-tracking ref reflects the `git fetch origin` already run at worktree setup). Push only when the count is non-zero; log a no-op clearly when there is genuinely nothing to push. This makes both handler-made and agent-made commits reach origin, and is a no-op in the common (already-pushed / nothing-to-do) case.

### 2. Worktree reset-on-entry — self-heal divergence

In `runInvocation`, after `git fetch origin` and worktree creation, ensure the working branch is at `origin/<branch>` before the SDK runs (`git reset --hard origin/<branch>` in the new worktree, or create the worktree from the remote-tracking ref). This discards any stale local-ahead ref inherited from a prior orphan, so each invocation starts from canonical origin state. Combined with change 1 (commits always leave at end of invocation), no unpushed local commit should survive *between* invocations — the two changes close the loop from both ends. **Ordering note:** reset is start-of-invocation, push is end-of-invocation; they compose across invocations and must not be reordered within one (resetting after the agent works would discard the agent's output before it is pushed).

### 3. Fail-loud on non-fast-forward

When the push is rejected because origin moved under the agent (e.g. the #63 double-dispatch, two agents on one branch), do not swallow it into a silent local orphan. Attempt one `git pull --rebase origin <branch>` and retry the push; if the rebase conflicts, return a structured, diagnostic error to the broker (so the moderator sees a real failure to act on) rather than leaving the branch ahead-and-unpushed. The existing `commitAndPush` already throws `push rejected: …`; this refines it into recover-once-then-fail-loud.

### 4. Tokenize the deny-guard (defense-in-depth)

In `tool-guard-hook.ts`, change the Bash check from a whole-string prefix match to a per-segment scan: split the command on shell separators (`&&`, `;`, `|`, `&`), strip leading `cd …`/env-assignment/`sudo` prefixes from each segment, and match the denied verbs against each segment's leading command — including the `git -C <path> <verb>` form. This closes the `cd &&` / `git -C` / env-prefix bypasses. Keep the matcher conservative to avoid false positives on legitimate reads (e.g. `git log --grep=commit` must remain allowed). With change 1 in place this is no longer load-bearing for correctness (agent commits become harmless because they get pushed), but it restores the documented invariant and prevents the agent from authoring commits with non-standard messages that bypass the `<commit-message>` contract.

### 5. Lock the secret-isolation invariant

Do **not** add `GH_TOKEN` or `GIT_CONFIG_GLOBAL` to `SDK_ENV_ALLOWLIST`. Add a regression test asserting both are absent from the SDK env, plus an inline comment explaining that the agent's inability to push is intentional and that push reliability is the handler's responsibility (this ticket) — so a future maintainer does not "fix" the push gap by exposing the token.

## Acceptance Criteria

- [x] `commitAndPush` pushes commits that are ahead of `origin/<branch>` even when the working tree is clean (an agent-made commit reaches origin).
- [x] Framework-made commits (agent leaves the tree dirty + provides `commitMessage`) still commit and push exactly as today.
- [x] When there is genuinely nothing to push (no dirty tree, not ahead of origin), the handler is a clean no-op and logs it.
- [x] Worktree setup starts the working branch at `origin/<branch>`; a pre-seeded divergent local ref is reconciled to origin and not inherited by the SDK run.
- [x] A non-fast-forward push triggers one `pull --rebase` + retry; on unresolved conflict the invocation returns a structured error to the broker (no silent local orphan).
- [x] The deny-guard blocks `cd <wt> && git commit …`, `git -C <wt> commit …`, and env-prefixed `git commit …`, while still allowing read-only git (e.g. `git log --grep=commit`).
- [x] `SDK_ENV_ALLOWLIST` still excludes `GH_TOKEN` and `GIT_CONFIG_GLOBAL`; a test asserts their absence from the SDK subprocess env.
- [x] Unit tests cover: agent-committed-clean-tree → pushed; divergent local ref → reset on entry; non-ff → rebase-retry then fail-loud; the new deny-guard bypass forms.
- [x] `npm run build`, `npm run lint`, `npm run test` all green; new tests added on top of the existing baseline.

## Dependencies and References

- **Code:** `apps/agent/src/connection/invocation-handler.service.ts` (worktree setup + `commitAndPush`), `apps/agent/src/config/tool-guard-hook.ts`, `apps/agent/src/config/role-tool-profiles.ts`, `apps/agent/src/llm/claude-code.service.ts` (`SDK_ENV_ALLOWLIST`), `docker/agent/entrypoint.sh` (credential/`GIT_CONFIG_GLOBAL` setup — read-only reference).
- **Docs:** `docs/system-design.md:413` (handler-controlled commits), `:202` (commit/push flow), `:209` (origin as sync point), `:161` (git-auth allowlist / QRM8 D5).
- **Evidence:** `logs/sessions/2026-06-17-qrm9-59-role-keyed-partition.md` §1 (orphan from timeout); the #63 live recovery (2026-06-20, this session).
- **Related:** #59 §1 recommendation (worktree orphan guard + #47 always-pending timeout routing); epic #49 (stabilization).
- **Blocks:** reliable autonomous multi-agent runs on any branch where an agent commits — currently each such invocation risks a manual push/reset recovery.

## Out of Scope

- The `SDK_ENV_ALLOWLIST` secret boundary stays as-is (agent remains a non-pusher); this ticket explicitly does not loosen it.
- *Why* the moderator double-dispatches the same unit of work to two agents (the #63 developer+teamlead overlap) is a separate orchestration concern; this ticket only makes the resulting concurrent-branch push fail loudly instead of silently.
- The broker/agent timeout divergence (#59 §1, item 1 — routing `/code-review` through the #47 always-pending path) is complementary and tracked under #47's lineage, not here.

## Implementation Notes

**Status:** Complete

**Files modified (8):**
- `apps/agent/src/connection/invocation-handler.service.ts` — Keystone (`commitAndPush`): rewritten to commit dirty changes (existing) then push anything ahead of `origin/<branch>` via a new `countAhead` helper (`git rev-list --count origin/<branch>..HEAD`). Clean tree + not-ahead is a logged no-op (`No changes to push after invocation`); success log now reports `ahead=N`. Push extracted into `pushWithRebaseRetry` (one `git pull --rebase` + retry; structured `push rejected: ...` error preserving the initial failure if rebase or retry fails). `runInvocation` now resets the new worktree to `origin/<branch>` between worktree-add and the node_modules symlink; reset failure cleans up the worktree and returns a structured error. Inline comment marks the reset-before-SDK / push-after-SDK ordering as load-bearing.
- `apps/agent/src/connection/invocation-handler.service.spec.ts` — Existing push-asserting tests now mock `execFileAsync` to return `'1\n'` for the `rev-list` call so the push branch is taken (4 tests). No-changes-path log assertion updated from "No changes to commit after invocation" to "No changes to push after invocation". Push-rejected test reframed around the full rebase-fails path. New `#65 worktree commit/push hardening` describe block: 7 tests covering agent-committed-clean-tree → pushed; `git reset --hard` invoked; reset-before-SDK ordering; reset-failure cleanup; non-ff recover via rebase+retry; non-ff fail-loud on retry-still-fails.
- `apps/agent/src/config/tool-guard-hook.ts` — `normaliseBashCommand` removed; replaced with `splitShellSegments` (split on `&&|||;|\||&`), `extractSegmentHead` (strip env-assignments, `sudo`, leading `cd <path>`; normalise `git -C <path> <verb>` → `git <verb>`), and `matchesDeniedVerb` (word-boundary aware: alphanumeric-trailing verbs require space continuation; punctuation-trailing verbs like `'rm -rf /'` and `'git checkout -b'` accept any continuation, preserving legacy semantics).
- `apps/agent/src/config/tool-guard-hook.spec.ts` — New `#65 token-aware deny-guard` describe block: 18 tests covering `cd &&`, `git -C`, env-prefix bypasses; `;`, `|`, `&` shell separators; `sudo`+`cd` compounds; read-only allowance for `git log --grep=commit`, `git -C <wt> status`, `pwd && ls && git status`, bare `cd <path>`; word-boundary correctness (`git branches` not blocked by `git branch`).
- `apps/agent/src/llm/claude-code.service.ts` — `SDK_ENV_ALLOWLIST` unchanged. Added a 14-line block comment documenting the QRM8 D5 secret-isolation boundary: `GH_TOKEN` and `GIT_CONFIG_GLOBAL` are deliberately omitted so the agent can commit (has git identity) but cannot push (no credential helper), and push reliability is the handler's job — future maintainers must NOT add either to the allowlist. Inline annotation on the git-identity entries: "NOT credentials — see comment above".
- `apps/agent/src/llm/claude-code.service.spec.ts` — New regression test asserts BOTH `GH_TOKEN` and `GIT_CONFIG_GLOBAL` are absent from the SDK subprocess env after seeding both as `process.env` values.
- `tickets/65-worktree-commit-push-hardening.md` — Flipped AC checkboxes, added this section.

**Verification:** `npm run build`, `npm run lint`, `npm run test` all green. 906/906 tests across 48 suites (baseline 881 → +25 new tests across the three affected spec files).

**Deviations:** None. All five changes from the Implementation Details section landed as specified.

**Key implementation choices worth remembering:**

1. *Verb-matching word-boundary rule.* The new deny-guard matcher is hybrid: alphanumeric-trailing verbs (e.g. `git push`, `git branch`) require a space continuation, so `git branches` does not match `git branch`; punctuation-trailing verbs (e.g. `rm -rf /`, `git checkout -b`) accept any continuation, preserving the developer profile's legacy semantic where `'rm -rf /'` was used as a path-prefix indicator. This was the load-bearing nuance that almost caused a regression for the developer role's `'rm -rf /'` entry.

2. *Shell-split is deliberately naive.* `splitShellSegments` does not parse subshells, heredocs, or quoting. A quoted `&&` inside a commit-message argument would split the segment, but each sub-segment is then matched against denied verbs — the worst case is over-denying a contrived commit-message string that the agent is not supposed to author anyway. Documented inline so future contributors don't try to "improve" it into a full shell parser.

3. *Reset/push ordering is load-bearing.* Reset is start-of-invocation, push is end-of-invocation. They compose across invocations to close the orphan loop from both ends (no unpushed commit survives between invocations) — but they MUST NOT be reordered within one invocation; resetting after the SDK runs would discard the agent's output before it can be pushed. Inline comment in `runInvocation` documents this.

4. *Rebase-retry preserves the initial error.* The structured error wraps `(initial=<first push error>)` so the broker sees both the original non-ff and the recovery failure cause (rebase conflict vs second-push reject). Avoids the "lost root cause" trap.

5. *Secret-boundary comment is the maintainability story.* Without the 14-line comment on `SDK_ENV_ALLOWLIST`, a future maintainer investigating "why can't the agent push?" would naturally try to fix it by allowlisting `GH_TOKEN` — re-introducing the very leak this ticket hardens against. The comment explicitly redirects them to `commitAndPush` as the intended fix surface.