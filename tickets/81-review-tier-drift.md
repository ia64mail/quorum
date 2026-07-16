# #81: Review Protocol tier drift — `/review` dispatch retroactively runs the `/code-review` fan-out

## Summary

During the #68 Round-2 review run (2026-07-15, PR #69), the teamlead was dispatched a **tier-2 `/review`** but executed the **tier-3 `code-review` skill** — and did so *retroactively*, after already completing the full review manually. On CC CLI 2.1.207 (bumped by #68) that skill fans out 5 parallel review subagents, so the invocation cost **$10.63** against a historical teamlead-review band of $1.79–$2.73. The review was paid for twice: once inline, once via the skill. This ticket closes the protocol gap that produced the drift: bind each review tier to its skill explicitly, prohibit retroactive skill runs manufactured only to satisfy the reporting format, and remove a stale QRM5-era moderator instruction that contradicts the tier model.

## Problem Statement

The three-tier review model (lightweight / `/review` / `/code-review`) and the two-comment PR reporting rule were introduced by #76 (PR #77, commits `ef0c3ea` and `afba865`, landed on `49-stabilization` 2026-07-12). Two gaps interact:

1. **The tier→skill binding is implicit.** `quorum.md` § Review Tiers names the tiers after the skills but never states that a `/review` dispatch must be satisfied by the `review` skill — run *first*, never substituted with `code-review`. The teamlead role template (`libs/common/src/prompts/role-prompt-templates.ts`, tier paragraph) frames skill output as "raw input — the review itself is yours", which invites doing the review inline and treating the skill run as a formality.
2. **The Reporting rule compels a skill run even when the review is already done.** § Reporting requires a verbatim *raw skill output* first comment for any skill-tier dispatch. A reviewer who completed the review inline is thereby forced to run a review skill purely to manufacture that comment.

Observed failure (session `ba10ca57` in `logs/teamlead-20260715T023016.jsonl`, 03:24–03:39, 52 turns):

1. **03:24–03:29** — teamlead performs the complete review manually (35 tool calls: eligibility gates, all four briefed findings, out-of-charter pass).
2. **03:29:28** — greps `quorum.md` for `Review Protocol|Reporting`.
3. **03:29:44** — states verbatim: *"I've completed the manual review. Per the Review Protocol, I need to invoke the code-review skill to produce raw output that will be posted as the first PR comment."* — then calls `Skill {"skill":"code-review","args":"HEAD~1..HEAD --effort medium"}`.
4. **03:30–03:35** — the skill spawns 5 parallel review subagents (Angle A–E + sweep), each independently re-reading the diff on Opus. Subagent tokens bill into the session's `total_cost_usd` but not its turn count, which is why cost-per-turn looked 4× out of line.

Contributing ambiguities behind the wrong-skill pick:

- **Name collision** — the dispatch says `/review`, the task *is* a code review, and `code-review` is the skill literally named for the job.
- **Scope fit** — the built-in `review` skill is PR-scoped, while the brief demanded a single-commit scope ("Review ONLY the developer's latest commit"); `code-review HEAD~1..HEAD` matches that interface directly.
- **Escalation license** — `quorum.md` ("Escalate a tier (1 → 2 → 3) rather than repeat one when a review leaves open questions or its findings are disputed") reads as addressed to whoever is reviewing; Round-2 was exactly a re-review of disputed Round-1 findings. Per the tier model's intent the escalation decision belongs to the *dispatcher* authoring the next brief, but the text does not say so at the reviewer-facing site.
- **Stale moderator instruction** — `docker/moderator/settings.json` still carries the QRM5-BUG-002-era line "ALWAYS use action: '/code-review' when dispatching code reviews — never send free-form review prompts", contradicting the #76 tier model where `/review` is the default. The moderator ignored it this run (it correctly dispatched tier 2 per the persona's tier table), but it can push future dispatches straight to the expensive tier.

Ruled out during investigation: API errors/retries (none in the session window) and model pricing drift (`.env` has pinned `ANTHROPIC_MODEL=claude-opus-4-7` since 2026-07-07, covering both the cheap 07-13 review — `Skill {"skill":"review"}`, $2.46, same 16,027-char role prompt — and the expensive 07-15 one). The drift is stochastic agent judgment on identical prompts, so double-digit reviews will recur whenever the conflation repeats.

Risk of not doing it: every future `/review` dispatch carries a latent ~4× cost multiplier that fires whenever the reviewer reaches for the wrong skill or back-fills a skill run for reporting compliance — precisely the runs the tier model was introduced to keep cheap.

## Implementation Details

Five surfaces, all prompt/config text — no runtime code changes.

### 1. `quorum.md` § Review Protocol → Review Tiers — explicit tier→skill binding

Add the missing rules after the tier list:

- A `/review` dispatch is satisfied by the `review` skill; a `/code-review` dispatch by the `code-review` skill. **No substitution in either direction.**
- The skill run comes **first** in the Review Workflow — its raw output is an *input* to the reviewer's own passes, not a compliance artifact generated afterward.
- Tier escalation (1 → 2 → 3) is the **dispatcher's** decision, made when authoring the next brief. The reviewer never self-escalates the machinery mid-review; if the dispatched tier proves insufficient, that is a finding for the verdict, not a license to switch skills.

### 2. `quorum.md` § Reporting (PR workflow) — inline-review carve-out

Clarify that the two-comment format applies only when a review skill actually ran per its dispatched tier. If no skill ran, single-comment reporting applies (the existing "Without review-skill output" branch). Add an explicit prohibition: never run a review skill retroactively solely to produce a raw-output comment.

### 3. `libs/common/src/prompts/role-prompt-templates.ts` — mirror the binding in the teamlead template

Extend the tier paragraph with the same no-substitution / skill-first / no-self-escalation rules, keeping the "skill output is raw input — the review itself is yours" framing but anchoring it to the dispatched tier. Update the #76 follow-up block in `role-prompt-templates.spec.ts` to pin the new wording.

### 4. `docker/moderator/settings.json` — remove the stale QRM5-era instruction

Replace the "ALWAYS use action: '/code-review' …" line with tier-model-consistent wording: dispatch the cheapest justified tier per `quorum.md` → Review Tiers; `/review` is the default; never send free-form review prompts for skill-tier work (the surviving intent of the original rule).

### 5. `docker/moderator/CLAUDE.md` — consistency pass

Verify the tier table and the escalation note agree with the sharpened `quorum.md` wording (dispatcher owns escalation; tier sets the skill). Adjust only where they conflict — `quorum.md` remains canonical for tier definitions.

## Acceptance Criteria

- [ ] `quorum.md` § Review Tiers states the tier→skill binding: no substitution, skill runs first, reviewer never self-escalates (escalation belongs to the dispatcher).
- [ ] `quorum.md` § Reporting prohibits retroactive skill runs and scopes the two-comment format to reviews where the dispatched tier's skill actually ran.
- [ ] Teamlead role template carries the same rules; `role-prompt-templates.spec.ts` pins the new wording and is green.
- [ ] `docker/moderator/settings.json` no longer contains the "ALWAYS use action: '/code-review'" instruction; the replacement references the tier model.
- [ ] `docker/moderator/CLAUDE.md` tier guidance is consistent with the sharpened `quorum.md` text.
- [ ] `npm run build`, `npm run lint`, `npm run test` pass.
- [ ] Operator runtime check (post container rebuild, next `/review` dispatch): the teamlead invokes `Skill {"skill":"review"}` exactly once, before its own passes; invocation cost lands back in the historical $1.8–$2.7 band.

## Dependencies and References

- Investigation and full log evidence: issue #81 (this ticket's issue), summarizing the 2026-07-15 session analysis.
- Cost run: PR #69 Round-2 review, session `ba10ca57` in `logs/teamlead-20260715T023016.jsonl`.
- Protocol origin: #76 / PR #77 — `ef0c3ea` (three-tier model), `afba865` (two-comment reporting), `0e0a39b` (out-of-charter pass; contributes recon breadth only, not the drift).
- Skill blast-radius origin: #68 / PR #69 — CC CLI 2.1.126 → 2.1.207, where `code-review` became a 5-subagent pipeline even at `--effort medium`.
- Stale instruction origin: QRM5-BUG-002 (`e6f8ae3`, "enforce `/code-review` for structured review tasks").

## Out of Scope

- Any change to the review skills themselves (built-in `review`, vendored `code-review` plugin) or their effort semantics — this ticket governs which one is dispatched and when, not what they do.
- Cost telemetry/alerting on per-invocation spend (the moderator already flags >$3 calls turn-by-turn).
- Revisiting the #76 two-comment reporting design beyond the inline-review carve-out.
