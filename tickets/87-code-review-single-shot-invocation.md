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

## Adjudication note

The option table above is retained as the investigation record. The design was **adjudicated by
the architect** (context `87-design-notes`, project scope) and **steered by the repo owner** (PR #88
review). The outcome **changed from the original A-primary recommendation**: A rested on an
*undocumented* side effect (`CLAUDE_CODE_DISABLE_AGENT_VIEW` disables the daemon / `--bg` /
`/background` surface, **not** in-session Task-tool backgrounding — `sdk.d.ts:5221`), so it is
**demoted to optional belt-and-suspenders**. The primary lever is now a **deterministic per-call
input rewrite** (a documented SDK mechanism the repo already exercises), plus a **`ScheduleWakeup`
deny** and **guard C** (corrected). The section below is the settled, implementation-ready design —
the implementer makes **zero design decisions**.

## Final Design (Adjudicated) — Implementation Details

Three edits form the fix stack; a fourth (A) is optional; E remains the documented fallback. All
file:line evidence below was verified by the architect against the working tree and installed SDK
0.3.207 (`87-design-notes`).

### 1. PRIMARY — deterministic foreground rewrite (PreToolUse `updatedInput`)

**Edit site:** `apps/agent/src/llm/sdk-hooks.factory.ts` — extend the **existing** `PreToolUse`
hook in `createObservabilityHooks` (currently lines 27-39; it logs `SDK tool start` then returns
`PASS_THROUGH` at line 35). This hook already fires on **every** tool call on every invocation, so
it is the guaranteed interception point.

**Do NOT** use `tool-guard-hook.ts` — it is a synchronous `ToolGuardResult { allowed, reason }`
surface wired through `canUseTool` and has **no `updatedInput` channel**. `canUseTool`
(`toCanUseTool`, `invocation-handler.service.ts:35-56`) also fires only for permission-gated tools;
whether the CLI auto-approves `Agent` under `permissionMode: 'default'` is not statically verifiable,
so `canUseTool` may not fire for `Agent` at all. PreToolUse is the correct site.

**Exact shape.** After the existing debug log, before the `return PASS_THROUGH`, add — scoped
**strictly** to `tool_name === 'Agent'`:

```ts
if (tool_name === 'Agent') {
  const ti = (tool_input ?? {}) as Record<string, unknown>;
  if (ti.run_in_background !== false) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...ti, run_in_background: false },
      },
    };
  }
}
return PASS_THROUGH;
```

Spread the original input; override **only** `run_in_background`. Do **not** set
`permissionDecision` (leave the permission flow intact).

**Tool / param names (architect-verified against `sdk-tools.d.ts`, do NOT guess):**
- Tool name is **`Agent`** — `AgentInput` at `sdk-tools.d.ts:444`, in the `ToolInputSchemas` union
  (:12); `ExitPlanModeOutput.hasTaskTool` / "Agent tool available" (:2774) confirms `Agent` is the
  subagent spawner. There is **no** separate `Task` spawner tool — the `Task*` interfaces
  (`TaskCreate/Get/Update/List/Stop/Output`) are todo / background-task **management**, not spawners.
  The live trace in the Problem Statement ("spawned 3 `Agent` sub-agents") independently confirms the
  live name is `Agent`.
- Param is **`run_in_background?: boolean`** — `sdk-tools.d.ts:464`, doc: "Agents run in the
  background by default; … Set to false to run this agent synchronously."

**Scope guard — do NOT rewrite `Bash`.** `run_in_background` also appears on `BashInput`
(`sdk-tools.d.ts:508`); the rewrite must be gated strictly on `tool_name === 'Agent'` so background
`Bash` calls are untouched.

**SDK mechanism evidence.** `PreToolUseHookSpecificOutput.updatedInput` exists at
`sdk.d.ts:2206-2211` (fields `hookEventName`, `permissionDecision?`, `permissionDecisionReason?`,
`updatedInput?`, `additionalContext?`), reachable via `SyncHookJSONOutput.hookSpecificOutput`
(`sdk.d.ts:6657`). Precedent for `updatedInput` rewrites in this repo: BUG-004 (the `canUseTool`
allow-branch variant at `invocation-handler.service.ts:46`).

### 2. `ScheduleWakeup` deny

**Edit site:** `apps/agent/src/config/role-tool-profiles.ts` — add `'ScheduleWakeup'` to
`COMMON_DISALLOWED_TOOLS` (currently lines 58-61, alongside `AskUserQuestion` and `ExitPlanMode`).
Same rationale as the existing `AskUserQuestion` deny: a wakeup can **never** fire in a single-shot
invocation, so removing the tool from the schema stops the model from ever forming the "harness will
re-invoke me" plan — for any role, any skill.

`ScheduleWakeupInput` is a **real** SDK tool (`sdk-tools.d.ts:2553`, in `ToolInputSchemas`), so it
will **not** trigger #68's "matches no known tool" warning (that warning came from the stale
`Config` entry, which is not an SDK tool). Safe for all roles/skills.

Optional (same "wake me later" family, for completeness — implementer's discretion, non-blocking):
also deny `CronCreate` / `CronList` / `CronDelete`.

### 3. Guard C — CORRECTED (the key correction; the original ticket got this wrong)

**Edit site:** `apps/agent/src/llm/claude-code.service.ts`, `processMessage`'s **success** branch
(lines 332-345).

**Correction.** `SDKResultSuccess` (`sdk.d.ts:4167-4194`) carries **only** `terminal_reason?`
(:4189) and `deferred_tool_use?` — it does **not** expose `background_tasks` / `scheduled_tasks`.
Those live exclusively on `StopHookInput` (`sdk.d.ts:6586`/`:6588`), a different surface that is
**unreachable from the result frame**. The original ticket's AC-C ("success frame with non-empty
`background_tasks` / `scheduled_tasks`") is therefore **not implementable** at this call site.
Guard C keys off `terminal_reason` **only**.

**Exact predicate.** In the success branch, **before** returning `{ success: true, … }`, check
`message.terminal_reason === 'background_requested'`; if so, return the **failure** envelope and
`logger.warn` the same:

```ts
if (message.terminal_reason === 'background_requested') {
  this.logger.warn(
    'Invocation ended with pending background work ' +
      '(terminal_reason=background_requested) — sub-agent fan-out did not ' +
      'complete in the single-shot turn; see #87',
  );
  return {
    success: false,
    error:
      'Invocation ended with pending background work ' +
      '(terminal_reason=background_requested) — sub-agent fan-out did not ' +
      'complete in the single-shot turn; see #87',
    durationMs: message.duration_ms,
    totalCostUsd: message.total_cost_usd,
    numTurns: message.num_turns,
    terminalReason: message.terminal_reason,
  };
}
```

(Consider also `'tool_deferred'` as defensive coverage — implementer's discretion, non-blocking.)

**Why this is safe / sufficient:**
- It does **not** trip `isResumeFailure` (which matches only `'turn_setup_failed'`), so **no
  spurious retry** is triggered.
- `InvocationHandler` already skips `commitAndPush` on `success: false` → this directly kills the
  silent-success half of the bug (no "No changes to push" masquerading as a completed review).
- With the PreToolUse rewrite forcing `Agent` foreground **and** `ScheduleWakeup` denied, the
  `background_tasks` / `scheduled_tasks` collections are empty in practice, so `terminal_reason` is
  the sufficient signal — no Stop hook is needed.

### 4. A — optional belt-and-suspenders (demoted)

Optionally inject `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` into the SDK `env` block
(`claude-code.service.ts:219-222`). Harmless one-liner, but **must not** be the primary lever: it is
documented (`sdk.d.ts:5221`) to disable the detached-session / daemon surface, **not** in-session
Agent-tool backgrounding. Also optional: an `updatedInput` **mirror** in `toCanUseTool`'s allow
branch (`invocation-handler.service.ts:46`) for `Agent`, as a hedge if the build-time check shows
PreToolUse `updatedInput` is not honored on 0.3.207 (see Residual Risk).

### E — documented fallback (unchanged)

If the Verification Runbook shows the foreground rewrite does not reliably force foreground on
0.3.207, fall back to routing the agent-side Deep tier through a synchronous natural-language deep
review (the #79 pattern) and record the runtime limitation in `docs/`. Guard C remains in either
outcome.

### Blast-radius guidance (architect)

- **Skill-agnostic and beneficial.** Forcing `Agent` foreground fixes **every** single-shot
  fan-out skill (`/simplify`, `/review`, `security-review`), not just `/code-review`.
- **Parallelism is preserved.** Multiple `Agent` calls in one assistant message still run
  **concurrently** in the foreground; only the fire-and-forget hand-off is removed. The Deep tier's
  5-way fan-out survives.
- **Dispatch discipline.** `/code-review` must be dispatched only to **teamlead / architect**
  (`ROLE_TIMEOUTS` = 15 min), not a 2–5 min role, and with **no restrictive `maxTurns`**
  (`InvocationHandler` passes none — `claude-code.service.ts:223` sets `maxTurns` only when provided).
- **Timeout headroom exists.** 15-min role timeout + QRM7-017 long-poll continuation
  (`wait_invocation`, ~4m30s holds then `{status: pending}`) accommodate a multi-minute in-turn
  review. Historical proof it completes in-turn: note #31 (5 Sonnet + 4 Haiku ran → posted on PR #32)
  pre-background-default.

## Acceptance Criteria

- [ ] **AC-1 — Root cause documented in-code.** The PreToolUse rewrite and guard C each carry a
      comment at the call site citing SDK 0.3.207 `Agent` background-by-default and the single-shot
      constraint (reference #87).
- [ ] **AC-2 — Foreground-forcing lever applied (deterministic rewrite preferred; A optional).**
      The **PreToolUse hook** in `sdk-hooks.factory.ts` rewrites `tool_name === 'Agent'` calls to
      `run_in_background: false` via `hookSpecificOutput.updatedInput`, scoped strictly to `Agent`
      (Bash untouched). A (`CLAUDE_CODE_DISABLE_AGENT_VIEW=1` in the SDK `env`) is **optional
      belt-and-suspenders only**, not the primary lever.
- [ ] **AC-3 — `ScheduleWakeup` denied.** `'ScheduleWakeup'` added to `COMMON_DISALLOWED_TOOLS`
      (`role-tool-profiles.ts:58`), alongside `AskUserQuestion` / `ExitPlanMode`, with a comment on
      the single-shot rationale.
- [ ] **AC-C — Completion guard (corrected).** In `processMessage`'s success branch
      (`claude-code.service.ts:332-345`), a result frame with `terminal_reason ===
      'background_requested'` returns a **non-success** envelope (with `terminalReason` set) and a
      WARN log, instead of a clean `success: true`. The guard keys off `terminal_reason` **only** —
      it does **not** reference `background_tasks` / `scheduled_tasks`, which are **not** on the
      result frame (`SDKResultSuccess`, `sdk.d.ts:4167-4194`; those fields are `StopHookInput`-only).
- [ ] **AC-4 — Unit coverage.** New tests in `claude-code.service.spec.ts`: (a) a
      `terminal_reason === 'background_requested'` success-subtype frame maps to a **non-success**
      envelope carrying `terminalReason`; (b) an ordinary `success` frame with no `terminal_reason`
      (or `terminal_reason === 'completed'`) still maps to `success: true` (no regression); (c) the
      guard's error string does **not** trip `isResumeFailure` (no spurious retry). Optionally, a
      test asserting the PreToolUse hook returns `updatedInput` with `run_in_background: false` for an
      `Agent` input and `PASS_THROUGH` for a `Bash` input.
- [ ] **AC-5 — Baseline preserved.** `npm run build`, `npm run lint`, and `npm run test` all green;
      test count ≥ 907 (current baseline: 48 suites / 907 tests) plus the new tests.
- [ ] **AC-6 — Verification Runbook documented and executed post-rebuild.** Because true end-to-end
      verification requires a container rebuild + live agent run (containers are **not** currently
      rebuilt), the ticket carries the runbook below, including the build-time re-confirmation of
      tool/param names and `updatedInput` honored-ness; the operator/moderator runs it after deploy
      and records the outcome in the Implementation Notes.

### Verification Runbook (post-rebuild — deferred, operator/moderator-driven)

**Build-time re-confirmation (required — names/mechanism not runtime-verifiable pre-rebuild):**

1. **Tool / param names.** After rebuild, run one `/code-review` (or any fan-out) dispatch and grep
   `logs/{role}-*.jsonl` for `SDK tool start: Agent` (emitted by the existing PreToolUse debug log);
   inspect its `tool_input` to confirm the live tool name is `Agent` and the param is
   `run_in_background`. Same check for `ScheduleWakeup` — confirm no "matches no known tool" warning
   fires from the new `disallowedTools` entry.
2. **`updatedInput` honored-ness.** Confirm in the logs that the rewritten `Agent` calls run in the
   foreground (sub-agents complete in-turn; no `terminal_reason=background_requested`). **If the
   rewrite is NOT honored on 0.3.207** (sub-agents still background despite the hook firing), enable
   the **hedge**: mirror the same `{ ...input, run_in_background: false }` rewrite in `toCanUseTool`'s
   allow branch (`invocation-handler.service.ts:46`) for `Agent` (BUG-004 mechanism, proven in-repo).

**End-to-end:**

3. Rebuild and restart: `./scripts/start.sh -d` (agent images rebuilt so the new hook /
   `processMessage` / `disallowedTools` code is live).
4. Open (or reuse) a small PR with a reviewable diff on a feature branch.
5. Moderator dispatches `action: "/code-review"` to the **team lead or architect** (15-min role
   timeout) for that PR.
6. **Expected (fix working):** the review sub-agents run to completion **within the single
   invocation** (concurrently, in foreground); a verdict is posted as a `gh pr comment`; the
   invocation returns `success: true` **with** the review actually present on the PR. `ScheduleWakeup`
   is absent from the toolset and is never the terminal action. Confirm no
   `terminal_reason=background_requested` WARN fired.
7. **Guard check:** confirm guard C via the unit tests (or a run where background work is still
   pending at turn end) — the envelope must be non-success, not a silent `success: true`.
8. **If the rewrite is refuted** (sub-agents still background / no PR comment, even with the
   `canUseTool` hedge): record the observed `terminal_reason` from the logs, activate fallback E
   (synchronous Deep-tier path), and note the runtime limitation in `docs/`.
9. Record all of the above (commands, log excerpts, PR comment link) in this ticket's Implementation
   Notes and in a project-scope synthesis.

## Dependencies and References

- **Milestone / epic:** QRM9 — Stabilization (epic #49). Residual-hygiene regression from the #68
  SDK/CLI bump; sibling to #78/#79/#80.
- **Owns / establishes:** the completion-contract clause for background/deferred work — an
  interaction previously unowned across #11 (worktree lifecycle) and #12 (commitAndPush gating).
- **Code (edit sites):**
  - `apps/agent/src/llm/sdk-hooks.factory.ts` — **PRIMARY**, extend the existing `PreToolUse` hook
    (:27-39) with the `Agent` → `run_in_background: false` `updatedInput` rewrite.
  - `apps/agent/src/config/role-tool-profiles.ts` — add `'ScheduleWakeup'` to
    `COMMON_DISALLOWED_TOOLS` (:58-61).
  - `apps/agent/src/llm/claude-code.service.ts` — guard C in `processMessage` success branch
    (:332-345); optional A in env block (:219-222); message loop (:244-251) unchanged.
  - `apps/agent/src/connection/invocation-handler.service.ts` — optional `canUseTool` hedge
    (`toCanUseTool` allow branch :46); commit gating already skips on `success: false` (:100-233).
  - `docker/plugins/code-review/commands/code-review.md` — vendored skill (context only; not edited).
- **SDK:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 0.3.207 — `PreToolUseHookSpecificOutput.updatedInput`
  (:2206-2211), `SyncHookJSONOutput.hookSpecificOutput` (:6657), `TerminalReason` incl.
  `'background_requested'` (:6714), `SDKResultSuccess.terminal_reason` (:4189, no `background_tasks`
  on this frame — that is `StopHookInput`-only, :6586/:6588), `CLAUDE_CODE_DISABLE_AGENT_VIEW`
  (:5221, daemon surface only). `sdk-tools.d.ts` — `AgentInput` (:444), `run_in_background`
  (:464), `BashInput.run_in_background` (:508, do NOT rewrite), `ScheduleWakeupInput` (:2553).
- **Authoritative design:** context `87-design-notes` (project scope); repo-owner steer on PR #88.
- **Context notes:** #29, #31, QRM5-BUG-002 (plugin wiring); QRM7-015/016 (long-poll delivery
  contrast); #78 (`processMessage` subtype handling precedent).
- **Related protocol:** `quorum.md` Review Protocol — Deep tier mandate for sensitive surfaces.
