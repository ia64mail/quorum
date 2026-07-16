# #87: Deep-tier /code-review skill does not complete inside a single-shot agent invocation

## Summary

The Deep review tier (`action: "/code-review"`) silently no-ops when dispatched to a Quorum
agent. On CC CLI / claude-agent-sdk **0.3.207** the skill's parallel review sub-agents (spawned
via the Agent/Task tool) run **in the background by default**; the main turn then calls
`ScheduleWakeup` expecting a harness re-invoke. A Quorum invocation is **single-shot** — one SDK
`query()` per `invoke_agent`, with the message loop stopping at the first `result` frame — so the
turn ends, the background sub-agents are killed, and no verdict / PR comment is produced. The
invocation still returns `success: true`. This ticket specifies the fix; **no code changes are
made in this commit** (spec only).

## Problem Statement

**Current situation.** Live trace 2026-07-16, PR #86 review (team lead session `b86451f3`): the
skill spawned 3 `Agent` sub-agents (~17:19:41–17:19:58), called `ScheduleWakeup(delaySeconds: 120)`,
emitted "I'll wait for the three review agents to complete; the harness will re-invoke me when they
finish," the SDK `query()` then completed (`turns=20`), and `InvocationHandler` returned "No changes
to push" — **zero PR comments, no verdict**. The #79 review had to be re-run as a synchronous,
natural-language deep review to conclude. Approx. \$1.51 was burned producing nothing.

**Why now.** This surfaced immediately after the #68 SDK/CLI bump (CC CLI 2.1.126 → 2.1.207 /
agent-sdk 0.3.207), which made the Agent/Task tool background-by-default. It is squarely a QRM9
stabilization regression. Note #31 records that `/code-review` **previously worked end-to-end** on
the older CLI ("5 parallel Sonnet auditors + 4 Haiku confidence scorers ran → structured review
posted on PR #32"), so this is a behavior change in the runtime, not a never-worked feature.

**Risks of not fixing.**
- The Deep tier is **mandated** by the Review Protocol (`quorum.md`) for sensitive surfaces
  (git/commit handling, permission guards, broker safeguards, auth). If `/code-review` no-ops,
  those changes go effectively unreviewed or get quietly downgraded to a manual review.
- The failure is **silent**: `success: true` with a plausible interim message. The moderator
  cannot distinguish it from a real review without independently inspecting the PR.
- Any skill that fans out background sub-agents inside an agent invocation is affected;
  `/code-review` is the concrete, highest-priority case.

## Design Context

**The invocation-completion contract, and who owns it.** The single-shot semantics live in
`ClaudeCodeService.executeQuery()` — the `for await (const message of gen)` loop
(`apps/agent/src/llm/claude-code.service.ts:244-251`) returns the moment `processMessage` maps a
`result` frame (line 247). `InvocationHandler.runInvocation()`
(`apps/agent/src/connection/invocation-handler.service.ts:100-233`) then runs `commitAndPush` and
removes the worktree in a `finally` block, tearing down the subprocess (and any surviving background
sub-agents). No single ticket owns "*drain outstanding background work before completing*":

- #11 established the worktree-per-invocation lifecycle (`runInvocation`, cleanup in `finally`).
- #12 established `commitAndPush` gated on `result.success` (hence "No changes to push").
- QRM7-015/016 established long-poll continuation (`wait_invocation`) for the **server-side
  moderator↔agent delivery** path — *not* the in-agent `query()` turn semantics.
- BUG-010 / #78 shaped the message loop and `processMessage` subtype handling.

The "stop at the first result frame, one `query()` per invoke" behavior is therefore a **seam
between tickets**, not an owned contract. Per `tickets/README.md` ("Ask which ticket owns the
interaction"), that absence is itself a finding: this ticket should be treated as establishing the
completion-contract clause for background/deferred work, and any change here interacts with the #11
cleanup and #12 commit gating.

**SDK 0.3.207 surface (verified in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`).**
- `AgentDefinition.background?: boolean` (line 79) — "Run this agent as a background task
  (non-blocking, fire-and-forget) when invoked." Applies only to agent **types we define** via the
  `agents` option; the skill spawns generic Task subagents, and we pass **no** `agents` option, so
  this field does not directly govern the skill's fan-out.
- `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` (line 5221) — "Disable agent view (`claude agents`, `--bg`,
  `/background`, the on-demand daemon)." Candidate lever for suppressing background hand-off.
- `TerminalReason` (line 6714) includes `'background_requested'` and `'completed'`.
- `SDKResultMessage` carries `terminal_reason?: TerminalReason` on **both** the success (line 4189)
  and error (line 4158) variants.
- Stop-hook / HookInput exposes `background_tasks?: BackgroundTaskSummary[]` and `scheduled_tasks`
  (lines 6584-6629): "Lets hooks distinguish 'session is done' from 'session is paused waiting for
  background work to wake it'." — the observability lever for detecting the no-op.
- `Query.backgroundTasks(toolUseId?)` (line 2515) backgrounds foreground tasks (Ctrl+B); it is not
  a drain primitive.

## Investigation Findings

Grounded against current code, the installed SDK (0.3.207), and the vendored skill:

1. **Skill location & fan-out.** `docker/plugins/code-review/commands/code-review.md`. Steps 1–3
   use Haiku agents (eligibility, CLAUDE.md discovery, PR summary); step 4 launches **5 parallel
   Sonnet agents**; step 5 launches a parallel Haiku scorer per issue; step 8 posts the `gh pr
   comment`. Every sub-agent is a Task-tool spawn. Plugin wiring (per notes #29/#31,
   QRM5-BUG-002): entrypoint-seeded to `~/.claude/plugins/cache/.../code-review`, referenced by
   `CODE_REVIEW_PLUGIN` in `role-tool-profiles.ts`, dispatched as the namespaced skill
   `code-review:code-review`.

2. **Background execution is not controllable from our current call site.** `query()` options in
   `claude-code.service.ts:203-241` pass no `agents` option and no background-related flag. The SDK
   `env` is a tight allowlist (`SDK_ENV_ALLOWLIST`, lines 43-63) plus `ANTHROPIC_API_KEY` — no
   `CLAUDE_CODE_DISABLE_AGENT_VIEW`. So the Task tool uses the harness default (background) with no
   override on our side. The `env` object at lines 219-222 is the injection point for an env-based
   lever.

3. **The loop stops at the first result frame and does not drain.** `executeQuery`
   (`claude-code.service.ts:244-251`) returns on the first mapped `result`. There is no inspection
   of in-flight `background_tasks` and no continuation. `InvocationHandler` (lines 207-233) maps the
   envelope straight to `InvokeResponse` and cleans up.

4. **The silent-success seam.** `processMessage`'s `result` branch
   (`claude-code.service.ts:332-345`) maps `subtype === 'success'` to `{ success: true }` and
   **never consults `terminal_reason`** on the success variant (it is only read on the
   `mirror_error` / error paths, lines 298-303 and ~352). A turn that ends with pending background
   work (terminal_reason `background_requested`, or `completed` while `scheduled_tasks`/`background_tasks`
   are non-empty) is therefore reported as a clean success. This is the exact point where the no-op
   becomes invisible.

5. **Out-of-charter — is `/code-review` the only affected skill?** No. Any skill that fans out via
   the Task/Agent tool shares the failure mode (e.g. `/simplify`, `/review`, `deep-research`,
   `security-review` all can spawn sub-agents). `/code-review` is the one the Review Protocol
   *mandates* for sensitive surfaces, so it is the priority; the chosen fix should be
   skill-agnostic where practical (a session-level or completion-contract change) rather than
   patching one skill's prose.

## Candidate Fix Approaches

| # | Approach | Pros | Cons / Risks |
|---|----------|------|--------------|
| **A** | **Suppress background hand-off at the session level** — inject `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` (and consider `CLAUDE_CODE_DISABLE_WORKFLOWS=1`) into the SDK `env` block so Task sub-agents run in the foreground and complete within the single `query()` turn. | Surgical (a few lines in the `env` object at `claude-code.service.ts:219-222`); skill-agnostic — fixes every fan-out skill at once; no completion-contract rewrite; aligns the runtime with the single-shot model. | **Behavior is a hypothesis**: the env flag disables the daemon/`--bg`/`/background` surface, but that it *forces the Task tool to run foreground* (vs. erroring, or the model still calling ScheduleWakeup) must be confirmed by a live run. Global for the session (acceptable, arguably desirable, for single-shot). |
| **B** | **Drain background tasks in the message loop before returning** — on a result frame with `terminal_reason: 'background_requested'` (or non-empty `background_tasks`), keep consuming the generator / feed continuation until tasks settle, then emit the final verdict. | Preserves the skill's parallel pipeline; most faithful to the multi-agent design. | Deep, risky change to the invocation-completion contract (#11/#12 seam); single-shot `query()` has no continuation input and the SDK expects a `ScheduleWakeup`-driven re-invoke — reconstructing that inside one turn is complex and easy to get subtly wrong; interacts with worktree cleanup timing. |
| **C** | **Stop-hook gating** — add a `Stop` hook (via the `hooks` option) that, when `background_tasks` is non-empty, blocks stop to keep the turn alive. | Cheap observability; reuses `sdk-hooks.factory.ts`. | Blocking stop does **not** itself drain tasks or feed results back; if the model has already called `ScheduleWakeup`, its loop is done. Useful as a **detector/guard**, not a standalone fix. |
| **D** | **Adjust / replace the vendored skill** — fork `code-review.md` to forbid `ScheduleWakeup` and mandate synchronous/foreground sub-agent use (or collapse to a single inline reviewer). | Full control over vendored file; no runtime change. | Background-by-default is a **harness** behavior; skill prose does not request background, so instructing "run synchronously" may not change the default without a runtime lever (A). Diverges the vendored skill from upstream; maintenance cost. Skill-specific — does not fix sibling skills. |
| **E** | **Constrain the Deep tier to a synchronous review path** — bypass `/code-review` for agents; run the Deep tier as a structured synchronous natural-language review (the #79 fallback). | Reliable today; no dependence on unverified SDK behavior. | Loses the multi-agent confidence-scored pipeline that defines the Deep tier; effectively a documentation/protocol change rather than a fix of the reported defect. Good **fallback**, not the primary. |

## Recommended Approach

**Primary: A (suppress background hand-off via env) + C (completion guard), with E as the
documented fallback if A cannot be made to work in a rebuilt container.**

Rationale: single-shot invocation is a hard architectural constraint (one `query()` per
`invoke_agent`, established across #11/#12 and the QRM7-016 delivery model); the regression is the
Task tool's *background-by-default*. The cleanest fix aligns the runtime to single-shot by forcing
**foreground** sub-agent execution (A) rather than rebuilding a continuation loop (B) or diverging
the vendored skill (D). Two layers:

1. **Correctness (A).** Add `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` to the SDK `env` object in
   `claude-code.service.ts` (evaluate `CLAUDE_CODE_DISABLE_WORKFLOWS=1` alongside). Goal: Task
   sub-agents run in-turn so the skill reaches its `gh pr comment` step before the turn ends. This
   is a hypothesis until the Verification Runbook confirms it on a live rebuilt agent.

2. **Observability guard (C, defense-in-depth).** In `processMessage`'s success branch
   (`claude-code.service.ts:332-345`), inspect `terminal_reason`: if it is `background_requested`
   (or a success/`completed` frame arrives with non-empty `background_tasks` / `scheduled_tasks`),
   do **not** return a clean `success: true` — surface it as an unsuccessful/incomplete invocation
   with a diagnostic error (and a WARN log) so the moderator never mistakes a no-op for a completed
   review. This layer is valuable **regardless** of whether A fully succeeds, and it directly kills
   the "silent success" half of the bug.

**Fallback (E).** If the Verification Runbook shows A does not reliably force foreground on
0.3.207, fall back to routing the agent-side Deep tier through a synchronous natural-language deep
review (the #79 pattern), and record the runtime limitation in `docs/`. The guard (C) remains in
either outcome.

This ticket **specifies** the approach; the implementer should confirm A empirically before
committing to it, and escalate to the architect if the completion-contract change grows beyond the
env flag + guard (i.e. if B becomes necessary).

## Acceptance Criteria

- [ ] **Root cause documented in-code.** The chosen lever is implemented with a comment at the call
      site citing SDK 0.3.207 background-by-default and the single-shot constraint.
- [ ] **Correctness lever (A) applied.** `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` (and, if adopted,
      `CLAUDE_CODE_DISABLE_WORKFLOWS=1`) injected into the SDK `env` block in
      `claude-code.service.ts`, or an equivalently-justified alternative if the Verification Runbook
      refutes A (with the fallback E documented).
- [ ] **Completion guard (C) applied.** `processMessage` no longer returns a clean `success: true`
      for a result frame that indicates pending/deferred background work
      (`terminal_reason === 'background_requested'`, or a success frame with non-empty
      `background_tasks` / `scheduled_tasks`); it returns an incomplete/unsuccessful envelope with a
      diagnostic message and a WARN log.
- [ ] **Unit coverage.** New tests in `claude-code.service.spec.ts` for the guard: (a) a
      `background_requested` result frame maps to a non-success envelope; (b) a `completed` frame
      with in-flight background tasks maps to non-success; (c) an ordinary `success` frame with no
      background work still maps to `success: true` (no regression). If A adds an env key, a test
      asserts the key is present in the SDK `env` (mirror the existing `SDK_ENV_ALLOWLIST` / env
      tests).
- [ ] **Baseline preserved.** `npm run build`, `npm run lint`, and `npm run test` all green; test
      count ≥ 907 (current baseline: 48 suites / 907 tests) plus the new tests.
- [ ] **Verification Runbook documented and executed post-rebuild.** Because true end-to-end
      verification requires a container rebuild + live agent run (the containers are **not**
      currently rebuilt), the ticket carries the runbook below; the operator/moderator runs it after
      deploy and records the outcome in the Implementation Notes.

### Verification Runbook (post-rebuild — deferred, operator/moderator-driven)

1. Rebuild and restart with the fix: `./scripts/start.sh -d` (agent images rebuilt so the new
   `env` / `processMessage` code and the vendored skill are live).
2. Open (or reuse) a small PR with a reviewable diff on a feature branch.
3. Moderator dispatches `action: "/code-review"` to the team lead for that PR.
4. **Expected (fix working):** the review sub-agents run to completion **within the single
   invocation**; a verdict is posted as a `gh pr comment` on the PR; the invocation returns
   `success: true` **with** the review actually present on the PR. `ScheduleWakeup` is not the
   terminal action. Confirm in `logs/{role}-*.jsonl` that no `terminal_reason=background_requested`
   / pending-task warning fired.
5. **Guard check:** artificially confirm the guard by inspecting a run where background work is
   still pending at turn end (or via the unit tests) — the envelope must be non-success, not a
   silent `success: true`.
6. **If A is refuted** (sub-agents still background / no PR comment): record the observed
   `terminal_reason` and `background_tasks` from the logs, activate fallback E (synchronous
   Deep-tier path), and note the runtime limitation in `docs/`.
7. Record all of the above (commands, log excerpts, PR comment link) in this ticket's Implementation
   Notes and in a project-scope synthesis.

## Dependencies and References

- **Milestone / epic:** QRM9 — Stabilization (epic #49). Residual-hygiene regression from the #68
  SDK/CLI bump; sibling to #78/#79/#80.
- **Owns / establishes:** the completion-contract clause for background/deferred work — an
  interaction previously unowned across #11 (worktree lifecycle) and #12 (commitAndPush gating).
- **Code:** `apps/agent/src/llm/claude-code.service.ts` (env block :219-222, message loop :244-251,
  `processMessage` result branch :332-345); `apps/agent/src/connection/invocation-handler.service.ts`
  (:100-233); `docker/plugins/code-review/commands/code-review.md`;
  `apps/agent/src/llm/sdk-hooks.factory.ts` (no Stop hook today).
- **SDK:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 0.3.207 — `background` (:79),
  `CLAUDE_CODE_DISABLE_AGENT_VIEW` (:5221), `TerminalReason` (:6714), `SDKResultMessage.terminal_reason`
  (:4158, :4189), Stop-hook `background_tasks`/`scheduled_tasks` (:6584-6629).
- **Context notes:** #29, #31, QRM5-BUG-002 (plugin wiring); QRM7-015/016 (long-poll delivery
  contrast); #78 (`processMessage` subtype handling precedent).
- **Related protocol:** `quorum.md` Review Protocol — Deep tier mandate for sensitive surfaces.
