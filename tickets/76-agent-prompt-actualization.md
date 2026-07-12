# #76: Agent prompt actualization — review built-in role prompts + quorum.md; land the tested ticket-consumption guidance

## Summary

A housekeeping pass over the standing text that frames every agent invocation — built-in role prompts, `quorum.md`, the moderator persona, root `CLAUDE.md`, and `tickets/README.md` — with three distinct parts. **Part 1 (precise, evidence-backed, specified verbatim below):** land the ticket-consumption discipline guidance exactly as validated by the Arm A″ controlled experiment runs, where this text — and nothing else — lifted latent-defect recovery in the library-present condition from **1/3 (Arm A′) to 2/3 (Arm A″)**. **Part 2 (broad, analysis deferred):** review the remaining prompt surfaces against current runtime behavior and actualize what has drifted; this ticket fixes the scope and the acceptance bar, not the findings. **Part 3 (added during the PR #77 review pass, 2026-07-12):** review execution and reporting discipline — every review concludes with a full review report published verbatim on the PR, and reviews are dispatched at one of three cost tiers (lightweight / `/review` / `/code-review`) so review depth scales with change risk.

## Problem Statement

The prompt surfaces accreted across nine milestones while the runtime around them kept moving — bootstrap context assembly (#55/#56/#70), session resume semantics, per-invocation worktrees (#11/#65), long-poll continuation (#47), skill dispatch, timeout changes (#72). Nothing systematically re-reads these files against present behavior, so they drift the same way any documentation does — except these files are *load-bearing*: they are injected into every agent's context and measurably steer investigation behavior.

The evidence that this text has measurable effect (and measurable limits) comes from the follow-up experiment to Article #2, ["The Ticket Library and the 'Unknown Unknown' Problem"](https://ia64mail.github.io/quorum/the-ticket-library-and-the-unknown-unknown-problem/) (Arm A″: three controlled runs against the #74 latent defect on a scrubbed replica, 2026-07-07). The article is the canonical published reference for the experiment — its design, the defect under test, and the baseline four-arm matrix (A 3/3 · A′ 1/3 · B 2/3 · B′ 0/3); the A″ arm extends that matrix with the guidance-only condition and is documented in local scratch only (see [Dependencies and References](#dependencies-and-references)):

- Adding ~20 lines of **generic** consumption-discipline guidance to `tickets/README.md` + both `CLAUDE.md` files — the only delta vs the A′ condition — moved recovery of an un-ticketed latent defect from 1/3 to 2/3.
- The recovery mechanism was visible in the traces: one run's moderator read the new README section during its first investigation window and then briefed its architect with *"verify each yourself against current code — do not trust me"*; another run's architect entered the ticket library by topic search before reading any source file.
- The one miss showed the limit: the deciding agent **framed its diagnosis before reading anything**, and no downstream role reopened the question. Standing guidance is a *channel, not a checkpoint* — it works when ingested at framing time and cannot force that ingestion. (A deterministic read-ledger gate on the tool-guard hook is the candidate follow-up; **out of scope here** — see Out of Scope.)

Risk of not doing it: the fleet keeps operating on prompt text that describes a system several milestones old, and the one intervention with measured positive effect stays stranded in an experiment replica instead of the real repo.

## Implementation Details

### Part 1 — bake in the A″ guidance (verbatim; do not paraphrase)

Three files, one addition each. The wording below is **frozen** — it is the exact text the experiment validated; rewording it forfeits the evidence basis.

**1a. `tickets/README.md`** — insert a new section between `## A Ticket Is the Truth About a Change, Not About the Present` (after its closing "This complements, rather than replaces, …" paragraph) and `## Naming Convention`:

```markdown
## When the Library Doesn't Answer — Interrogate, Don't Consult

The discipline above governs how to read what a ticket says. An equally common failure is
over-trusting what the library as a whole seems to settle. Two rules extend the snapshot
discipline from single tickets to the library:

- **Interrogate, don't consult.** A ticket tells you what was known when it was written — so
  when you open one, ask what it does *not* cover and what has changed since. A ticket that
  reads as a definitive answer about code you are about to change is a **hypothesis to
  re-verify against the present code**, not a conclusion. Treating a true record as
  reassurance is how correct tickets produce wrong changes: the record is accurate for its
  own transaction and silent about everything nearby — including the thing you are about to
  break.
- **Ask which ticket owns the interaction.** This codebase was built ticket by ticket, so each
  ticket owns one transition — but constraints and defects often live in the *seams between
  tickets*, in interactions no single ticket owns. Before relying on the library's answer,
  ask: **which ticket owns the interaction I am looking at?** If none does, that absence is a
  finding, not an all-clear — an investigation belongs exactly there, and what it learns
  belongs in a new ticket. Failing to find a definitive answer in the library never means the
  question is settled; it means you are standing **between** tickets, and the present code is
  your primary evidence.
```

**1b. Root `CLAUDE.md`** — in the `### Ticket Library` section's consumption-discipline paragraph, insert one sentence before the final "See [A Ticket Is the Truth About a Change…]" sentence:

```markdown
A ticket also answers only for its own transition — if no ticket owns the interaction you
are examining, that absence is a finding, not an all-clear: investigate the present code as
primary evidence, and interrogate any ticket you do consult — ask what it does not cover
and what has changed since — rather than reading it as reassurance about nearby code.
```

**1c. `docker/moderator/CLAUDE.md`** — the moderator persona carries the identical paragraph; apply the **identical** sentence in the identical position. (Deliberate: the experiment traces show the moderator's first-window self-diagnosis pre-frames every downstream agent — the moderator must be inside the discipline, not outside it.)

### Part 2 — prompt-surface review (scope fixed here, analysis deferred to implementation)

Review each surface against current runtime behavior; actualize or delete what has drifted. Surfaces in scope:

| Surface | What to check (non-exhaustive; the implementation pass does the real analysis) |
|---|---|
| `libs/common/src/prompts/role-prompt-templates.ts` (+spec) | Role responsibilities vs actual flows (e.g. review dispatch via `/code-review`, ticket-authoring phase, worktree/commit discipline per #65); stale references to superseded mechanics |
| `quorum.md` | Workspace conventions vs present runtime: commit cadence, GitHub Workflow section vs gh-workflow skill, context-store guidance vs #55/#56/#70 reality |
| `docker/moderator/CLAUDE.md` | Turn lifecycle, session-resume and cost notes vs current SDK behavior; skill-dispatch table completeness; Ticket Workflow Discipline vs practice |
| Root `CLAUDE.md` | Project structure/doc table accuracy; build commands; anything describing removed or changed behavior |
| `apps/agent/src/config/role-tool-profiles.ts` (+spec) | Tool profiles vs what roles actually need today (read-only check — changes only if trivially stale) |

Constraints for the implementation pass: prompt-only changes (no runtime code, with one exception: the L3 bootstrap-header string in `bootstrap-context.service.ts`); each edit traceable to a named drift or a named experiment finding; `npm run build`/`lint`/`test` green (template specs will need updating alongside template text).

### Part-2 findings — composite-prompt review (2026-07-07)

**Method:** instead of reviewing surface files one-by-one, the review reconstructed the **composite prompt each role actually receives at invocation start** — verbatim rendered prompts extracted from the A7–A9 experiment run logs (`=== Initial prompt` entries per role), confirmed byte-identical to the templates on this branch, then cross-checked against current runtime code. A role's composite is: (1) `SYSTEM_PREAMBLE` + role template (system prompt, rendered by `RolePromptService`); (2) broker-injected bootstrap block (`## Prior Decisions …`) + the moderator-authored action (user prompt); (3) ambient — the repo root `CLAUDE.md` auto-loaded into every agent session (`claude-code.service.ts:159` sets `settingSources: ['project']`) plus `quorum.md` read on instruction; (4) for the moderator, `docker/moderator/CLAUDE.md` with `@quorum.md` imported.

Severity reflects observed or likely behavioral impact, grounded in the 15 archived experiment runs.

#### High

- **H1 — Shared-workspace fiction in 5 places.** The pre-#65 model ("all agents see the same files; changes by one agent are immediately visible") is still asserted in: `SYSTEM_PREAMBLE` Workspace section *and* its Capabilities bullet (`role-prompt-templates.ts:41,44-45`), `quorum.md` Constraints ("Shared workspace: … immediately visible to everyone"), and the moderator persona lines 18 and 70 — where it directly contradicts the persona's own correct "Workspace Model" section (changes arrive only via `git fetch`/`git pull`). Every agent is handed a false synchronization model in the highest-authority layer.
  *Suggested change:* rewrite all five sites to the isolated-clone / per-invocation-worktree / git-sync model; the persona's "Workspace Model" section wording is the reference.
- **H2 — No brief-authoring guidance for the moderator (experiment seed: A8 vs A9).** The persona covers *when* to dispatch and *which* skill, but nothing about *how to frame* an investigation brief. A8's brief ("verify each yourself — do not trust me", falsifiable hypotheses) recovered the defect cheaply; A9's brief pre-framed the diagnosis and sank the run. The moderator's W0 framing is the single highest-leverage prompt surface the experiment demonstrated.
  *Suggested change:* add a short "Authoring agent briefs" section to the persona: state hypotheses, not conclusions; instruct the agent to verify claims itself against current code; point into the ticket library; never pre-exonerate code. (Goes slightly beyond drift-fixing — new guidance, evidence-backed by A7–A9 traces)
- **H3 — Commit-discipline contradiction across three layers.** `SYSTEM_PREAMBLE` Git Discipline: handler makes **one commit per invocation**, `git commit`/`git push` denied, no-ticket prefix form absent. `quorum.md` Commit Messages: "multiple logical units → separate commits" (impossible under the handler) and `QRMX(no-ticket):` (assumes a milestone digit). Moderator persona: silent on handler-controlled commits entirely. Observed consequence (A7): the moderator briefed the developer to "push to origin when done" (impossible) and invented the prefix `QRM(no-ticket):`; other runs produced `#55-followup:` and bare-slug prefixes.
  *Suggested change:* (a) preamble gains the no-ticket prefix form incl. a defined fallback when no milestone is in flight; (b) quorum.md's multi-commit line gets the one-commit-per-invocation caveat; (c) persona gains a short "handler-controlled commits" note so briefs stop instructing agents to push. (Item (c) is new guidance)

#### Medium

- **M1 — Dead moderator template + dead generic fallback.** `getRolePromptTemplate` is only called by the agent app with its own role, and moderator is not in `DEPLOYABLE_AGENT_ROLES` — the ~65-line `[AgentRole.moderator]` entry (with its own duplicate Skill Dispatch table) is never rendered; agent→moderator calls route via elicitation. `GENERIC_PROMPT_TEMPLATE` is equally unreachable (all six roles have dedicated entries). Both mislead maintainers into syncing text with no runtime effect.
  *Suggested change:* delete both (or reduce to an explicitly-marked tombstone comment); update template specs accordingly.
- **M2 — Phantom tool names.** `FileRead`/`FileWrite`/`FileEdit` do not exist — the real CC tools are `Read`/`Write`/`Edit` (the guard hook checks `Write`/`Edit`/`NotebookEdit`, `role-tool-profiles.ts:129`). Wrong names appear in the preamble Capabilities, architect + developer templates, and quorum.md role configs (Architect §3, Developer Implementation Protocol §1).
  *Suggested change:* correct the names at every occurrence.
- **M3 — Resume-cost guidance conflicts inside the persona.** "Sizing implementation dispatches": "resume does NOT save cost — only fresh sessions do" vs "Session Resume → Cost behavior": tight back-to-back resume reads at ~10× discount within the cache TTL. Additionally the "Session caches persist across `new_conversation` boundaries / pass `sessionId: ''`…" sentence appears twice (persona lines 228 and 247).
  *Suggested change:* reconcile to one consistent cost model (cache-TTL-dependent), keep a single canonical sentence, delete the duplicate.
- **M4 — No size rubric for project-scope context writes.** Agent scope has the ≤400-token rubric; project scope has none. Observed consequence (A7): the architect stored a ~2.5k-token finding which the bootstrap then re-injected verbatim into every downstream invocation — the teamlead received it twice (bootstrap block + the moderator's brief quoting it). With `BOOTSTRAP_MAX_TOKENS=5000`, one oversized record monopolizes the budget.
  *Suggested change:* add a project-scope write rubric to the preamble's Shared Context section and the architect template — store a compact summary + pointer (ticket/doc/commit), not the full report.
- **M5 — Review-charter breadth unguided (experiment seed: A9 vs A7).** Nothing in the persona's skill-dispatch section or quorum.md's Review Protocol requires looking beyond the brief's charter; A9's "verify none of the do-NOT-touch list was modified" charter made the review verify the fence instead of the defect, while A7's review spontaneously asked "which ticket owns this interaction?" and won.
  *Suggested change:* one line in the persona's review-dispatch guidance + quorum.md Review Protocol: every review includes at least one out-of-charter pass (e.g. "which ticket owns the interaction this change touches?"). (New guidance)
- **M6 — Stale counts, tables, and audience notes.** "7 tools, 2 resources" in root `CLAUDE.md` and the persona — actually 9 tools (+`wait_invocation`, `new_conversation`) and 2 resources. The persona's Documentation table lacks `docs/mcp-connectivity.md`. Root `CLAUDE.md`'s scope note claims the file is "for Claude Code sessions developing the Quorum codebase from outside the system," yet `settingSources: ['project']` injects it into every in-container agent session — that channel is exactly why Part-1b reaches agents; the scope note should own that audience.
  *Suggested change:* fix counts, add the missing doc-table row, amend the scope note to name both audiences.

#### Low

- **L1 — Pending envelopes unknown to agents.** Only the moderator persona documents `wait_invocation`/pending handling. Fine today (agent-to-agent calls return inline) but one preamble sentence would remove a dead end if that changes.
- **L2 — `rm -rf` denial text mismatch.** Architect/QA templates promise `rm -rf /` denial while their profiles deny the broader `rm -rf`; developer/teamlead profiles deny only `rm -rf /`. Align template text with profiles (and note the profile inconsistency for a possible follow-up — profiles are read-only in this ticket's scope).
- **L3 — Bootstrap block lacks framing text.** The injected block opens with raw records under `## Prior Decisions` with no instruction on how to treat them (hypotheses to re-verify, possibly stale — the exact A″ lesson). The header string lives in `bootstrap-context.service.ts`, so fixing it crosses this ticket's "prompt-only, no runtime code" constraint. Should fold in as a one-string exception.

#### Edit list (maps findings → edits; confirmed, not yet applied)

1. H1 rewrite (5 sites) — pure drift fix.
2. H2 "Authoring agent briefs" persona section — new guidance.
3. H3 commit-discipline reconciliation (preamble + quorum.md + persona) — mixed drift fix / new guidance.
4. M1 deletions, M2 tool-name fixes, M3 resume-cost reconciliation + dedupe, M6 counts/table/scope-note — pure drift fixes.
5. M4 project-scope write rubric + M5 out-of-charter review line — new guidance.
6. L1/L2 one-liners — pure drift fixes. L3 — one-string exception in `bootstrap-context.service.ts`.
7. Part 1 lands verbatim as frozen, independent of all of the above.

### Part 3 — review execution and reporting discipline (added during PR #77 review, 2026-07-12)

Added after Parts 1–2 landed, from two user requests during the PR review pass. Evidence: the QRM9 closed-PR record (#60/#62/#64) shows the published review artifact was often near-empty — the raw `/code-review` comment reads "No issues found. Checked for bugs and CLAUDE.md compliance." (~200 chars) — because (a) the Review Protocol's Accept path prescribed no report structure, (b) the teamlead template had no code-review section at all, and (c) every review paid for the deep multi-agent pipeline regardless of change risk, encouraging exactly this thin output.

**3a — Full-report reporting discipline.** The review deliverable is a full review report published **verbatim** on the PR: overview of what the change does, per-criterion verification with evidence (`file:line`), the reviewer's own findings with severity, and an explicit Accept/Decline verdict. Depth bar: the comment must show *what was verified and how* — a bare verdict or "no issues found" is a skill output, not a review report; a review is not concluded until the full report is visible on the PR. Landed in: new teamlead-template "Code Review" section; `quorum.md` Reporting item 2 upgraded from "verdict summary" to "full review report" (mirrored in the no-skill-output paragraph and the Team Lead role-config pointer).

**3b — Three-tier review model.** The dispatcher picks the cheapest tier the change justifies; the tier sets the machinery, not the discipline (3a applies at every tier):

| Tier | `action` | When | Cost |
|------|----------|------|------|
| 1 — Lightweight | Natural-language ask (no skill) | Small, mechanical, or low-risk changes with high prior confidence; follow-up re-reviews | Quick and cheap |
| 2 — Standard | `/review` | **Default for most reviews** | Moderate — one structured pass |
| 3 — Deep | `/code-review` | Low-confidence, questionable, or highly sensitive changes (permission guards, broker safeguards, git/commit handling, auth) | Long and expensive — the multi-agent plugin pipeline behind the #72 timeout bump |

Escalate (1 → 2 → 3) rather than repeat a tier when a review leaves open questions or its findings are disputed. Canonical tier definitions: `quorum.md` → Review Protocol → "Review Tiers"; dispatch-side selection table in the persona's Skill Dispatch section (retitled "Reviews Are Tiered", replacing the "ALWAYS `/code-review`" rule); the teamlead template names the tiers.

**Runtime-code exception (second, alongside L3):** `role-tool-profiles.ts` adds `'review'` to architect + teamlead `allowedSkills`. Required because the built-in review skill ships in the agent CLI binary (`claude-agent-sdk-linux-x64/claude`) but the tool-guard hook gates `Skill` calls by bare-name allowlist — without the entry, a `/review` dispatch would be denied. Static verification only (binary string probe); the first post-rebuild tier-2 dispatch is the live validation.

## Acceptance Criteria

1. - [x] Part-1 guidance present verbatim in all three files at the specified anchors (a grep for "Interrogate, don't consult" and "absence is a finding" matches `tickets/README.md`, `CLAUDE.md`, `docker/moderator/CLAUDE.md`).
2. - [x] Part-1 wording byte-faithful to this spec (no paraphrase; the 1b/1c sentence lands as a single line to match the target paragraphs' one-line style).
3. - [x] Part-2 review performed per surface, with a short drift log (what changed and why, or "no drift") recorded in the ticket's Implementation Notes.
4. - [x] Prompt template spec files updated to match any template changes.
5. - [x] `npm run build`, `npm run lint`, `npm run test` pass with no regressions (48 suites, 896 tests after M1's dead-template test removals and the new assertions; 900 after Part 3's additions).
6. - [x] Part-3 discipline present at every surface: teamlead template "Code Review" section (full report, published verbatim via `gh pr comment`, tier names), `quorum.md` "Review Tiers" + full-review-report depth bar in Reporting, persona tier-selection table replacing the "ALWAYS `/code-review`" rule, `'review'` in architect + teamlead `allowedSkills` with spec assertions.

## Implementation Notes

Drift log — one entry per edit-list item as it lands (AC-3):

- **H1 (2026-07-11)** — rewrote all 5 shared-workspace-fiction sites to the isolated-clone / per-invocation-worktree / git-sync model (persona "Workspace Model" wording as reference): preamble Capabilities bullet + Workspace section (`role-prompt-templates.ts`), `quorum.md` Constraints ("Shared workspace" → "Isolated workspaces"), persona lines 18 and 70. Spec updated: the Workspace test now asserts the isolated-worktree wording instead of `/mnt/quorum/workspace`. A 6th occurrence ("directly against the shared workspace") sits inside the dead `[AgentRole.moderator]` template and is left for M1's deletion.
- **H2 (2026-07-11)** — added "Authoring Agent Briefs" section to the persona (after "Agent Capabilities Awareness"): hypotheses-not-conclusions, verify-every-claim-yourself framing, point into the ticket library, never pre-exonerate code. New guidance seeded by A8 (falsifiable brief → recovery) vs A9 (pre-framed brief + do-not-touch fence → miss).
- **H3 (2026-07-11)** — commit-discipline reconciliation: (a) preamble format list gains the no-ticket form with a defined fallback (`QRMX(no-ticket):` with the in-flight milestone, bare `(no-ticket):` when none) + matching definition in `quorum.md` Commit Messages; (b) quorum.md's multi-commit line gains the one-commit-per-invocation agent caveat; (c) persona gains a "Handler-controlled commits" note under Agent Capabilities Awareness so briefs stop instructing agents to push (A7 seed). Spec gains a `QRMX(no-ticket)` assertion.
- **M1 (2026-07-11)** — deleted the dead `[AgentRole.moderator]` template (~65 lines incl. its duplicate Skill Dispatch table) and `GENERIC_PROMPT_TEMPLATE`; the map doc-comment now carries a tombstone note explaining why moderator has no entry. `getRolePromptTemplate` throws for roles without a template (deployment misconfiguration) instead of silently falling back; `GENERIC_PROMPT_TEMPLATE` removed from the barrel export. Specs updated: moderator/generic-fallback test blocks removed, throw behavior asserted in both the template spec and `role-prompt.service.spec.ts` (test count 906 → 895). This deletion also removed the 6th shared-workspace occurrence noted in the H1 entry.
- **M2 (2026-07-11)** — corrected phantom tool names `FileRead`/`FileWrite`/`FileEdit` → `Read`/`Write`/`Edit` at every remaining occurrence: preamble Capabilities, architect + developer templates, `quorum.md` Architect §3 + Developer Implementation Protocol §1. Specs updated to assert the real names, including two `role-tool-profiles.spec.ts` tests whose not-denied assertions were vacuous against the phantom names (now assert `Write`/`Edit`).
- **M3 (2026-07-11)** — reconciled the persona's resume-cost guidance to the single cache-TTL-dependent model: "Sizing implementation dispatches" no longer claims "resume does NOT save cost — only fresh sessions do", it now explains the discount depends on landing inside the ~5-min prompt-cache TTL and cross-references "Cost behavior of resume". Deleted the duplicate trailing "Session caches persist across `new_conversation` boundaries…" sentence (redundant with the Session Resume opening paragraph). Persona-only change; no template/spec impact.
- **M4 (2026-07-11)** — added a project-scope write rubric (compact summary ≤ ~400 tokens + pointer to ticket/doc/commit, never the full report; oversized records crowd out the bootstrap budget) to the preamble's Shared Context project bullet and the architect template's Context Management section. New guidance seeded by A7 (architect's ~2.5k-token finding re-injected verbatim into every downstream bootstrap). Spec gains a rubric assertion.
- **M5 (2026-07-11)** — added the out-of-charter review requirement: `quorum.md` Review Protocol gains pass (e) ("which ticket owns the interaction this change touches?"), and the persona's Skill Dispatch section gains a line requiring every review brief to ask for at least one out-of-charter pass. New guidance seeded by A9 (do-not-touch charter verified the fence, missed the defect) vs A7 (review spontaneously asked the ownership question and won).
- **M6 (2026-07-11)** — fixed stale counts and audience notes: "7 tools, 2 resources" → "9 tools, 2 resources" in root `CLAUDE.md` and the persona (verified against 9 `registerTool` calls in `mcp.service.ts`); persona Documentation table gains the missing `docs/mcp-connectivity.md` row; root `CLAUDE.md` scope note now names both audiences (outside-the-system CC sessions + every in-container agent session via `settingSources: ['project']`).
- **L1 (2026-07-11)** — one preamble sentence on pending envelopes added to the Communication section's `invoke_agent` bullet (inline is the norm; `status: "pending"` + `invocationId` → cycle `wait_invocation` until `completed`/`failed`). Spec communication-model test asserts `wait_invocation`.
- **L2 (2026-07-11)** — aligned template denial text with profiles: architect + QA templates now say `rm -rf` (their profiles deny the broad form); developer + teamlead template text already matched their profiles (`rm -rf /`). Noted for follow-up (profiles are read-only here): developer/teamlead profiles deny only the literal `rm -rf /`, which does not cover `rm -rf <path>` — profile-level inconsistency across roles stands.
- **L3 (2026-07-11)** — bootstrap block framing text landed as the approved one-string exception. **Correction to this ticket's earlier claim:** the rendered `## Prior Decisions` header does NOT live in `bootstrap-context.service.ts` (that mcp-server service assembles the records); the string is rendered agent-side in `invocation-handler.service.ts` (`renderBootstrapContext`). The framing line ("snapshots… treat each as a hypothesis to re-verify against the present code, not as settled fact") was added there; handler spec asserts it.

Post-review addenda (PR #77 review, 2026-07-12) — the three-tier and reporting-depth entries below are Part 3's drift log (see [Part 3](#part-3--review-execution-and-reporting-discipline-added-during-pr-77-review-2026-07-12)):

- **Correction to AC-1's grep formula.** AC-1 claims a grep for "Interrogate, don't consult" *and* "absence is a finding" matches all three files — but the frozen 1b/1c sentence never contained the phrase "Interrogate, don't consult" (it says "interrogate any ticket you do consult"), so that phrase matches only `tickets/README.md`. The implementation is byte-faithful to the frozen spec text (mechanically diffed); the AC's self-check sentence was imprecise at spec time. Working greps: "Interrogate, don't consult" → `tickets/README.md`; "absence is a finding" → all three files.
- **quorum.md Git-discipline qualifier (H3 family).** The Constraints bullet "Developers commit implementation; team leads can commit ticket updates" read as agents running `git commit`, contradicting the handler-controlled-commit model H3 documented. Added a qualifier: for agents, "commit" means authoring the commit message — the handler runs the actual `git commit`/`git push`.
- **`docs/system-design.md` tool count (M6 replica).** The source-tree diagram's `mcp/` line still said "7 tools, 2 resources" — the same stale count M6 fixed in root `CLAUDE.md` and the persona. Fixed as a one-line replica; the broader `docs/` accuracy sweep remains out of scope (see Out of Scope).
- **Three-tier review model (user-requested follow-up, 2026-07-12).** Introduced explicit review tiers so review cost scales with change risk: **1 — Lightweight** (natural-language ask, no skill; small high-confidence changes and re-reviews), **2 — Standard (`/review`)** (the default for most reviews; one structured pass), **3 — Deep (`/code-review`)** (low-confidence, questionable, or highly sensitive changes; the multi-agent plugin pipeline behind the #72 timeout bump). Canonical tier definitions live in quorum.md → Review Protocol → "Review Tiers"; the persona's Skill Dispatch section (retitled "Reviews Are Tiered", replacing the "ALWAYS `/code-review`" rule) carries the dispatch-side selection table + escalate-don't-repeat rule; the teamlead template's Code Review section names the tiers; Reporting rules made skill-agnostic (raw output rule now covers `/review` too). **One runtime-code touch beyond the L3 exception:** `role-tool-profiles.ts` adds `'review'` to architect + teamlead `allowedSkills` — verified the built-in review skill ships in the agent CLI binary (`claude-agent-sdk-linux-x64/claude` contains the skill's "Review a pull request" description) and the tool-guard hook gates Skill calls by bare name, so without the allowlist entry a `/review` dispatch would be blocked. Specs assert the new allowlist entries and tier text.
- **Teamlead review-reporting depth (user-requested follow-up, 2026-07-12; M5/H2 family).** Evidence from QRM9 closed PRs (#60/#62/#64): the raw `/code-review` comment posted per the Reporting rule is often near-empty ("No issues found. Checked for bugs and CLAUDE.md compliance.", 132–224 chars), and the Review Protocol's step-5 **Accept** path prescribed no report structure — so the published review could satisfy the letter of the rule while showing nothing of what was verified. The teamlead template also had no code-review section at all. Added: (a) a "Code Review" section to the teamlead template — execute the full Review Protocol (not just the skill), write a full review report (overview, per-criterion evidence, findings, verdict; depth bar: "no issues found" is a skill output, not a review report), and publish it **verbatim** via `gh pr comment` as the review deliverable; (b) quorum.md Reporting item 2 upgraded from "verdict summary" to "full review report" with the same depth bar (mirrored in the no-skill-output paragraph and the Team Lead role-config pointer); (c) teamlead spec assertion. New guidance (not drift), seeded by observed shallow review comments rather than experiment traces.

## Dependencies and References

- Evidence base: Article #2 — ["The Ticket Library and the 'Unknown Unknown' Problem"](https://ia64mail.github.io/quorum/the-ticket-library-and-the-unknown-unknown-problem/) (canonical URL) — the published account of the experiment: design, the #74-class latent defect, and the baseline four-arm matrix (Arm A 3/3 · A′ 1/3 · B 2/3 · B′ 0/3). The Arm A″ follow-up (guidance-only condition, runs A7–A9) is **not** covered by the article; its write-up and run records live in local scratch (`tickets/tmp/articles/02-ticket-library/`, gitignored) — key result: A′ 1/3 → A″ 2/3, sole delta = the Part-1 text.
- [#74](74-getall-cap-recency-truncation.md) — the latent defect the experiment ran against (closed, superseded by #70); its Resolution amendment carries the seam this guidance exists to catch.
- [#51](51-ticket-library-verification-discipline.md) — the original "truth about a change" consumption discipline this extends.
- Epic: [#49 QRM9 Stabilization](49-stabilization/49-stabilization.md).

## Out of Scope

- **Deterministic enforcement** (read-ledger gate on the tool-guard hook that blocks a first dispatch/edit until the session has consulted the library) — the natural follow-up to the "channel, not checkpoint" finding, but a runtime change deserving its own ticket and its own measurement.
- Restructuring the role system or tool profiles beyond staleness fixes.
- `docs/` accuracy sweep (separate concern; this ticket is the *prompt* surfaces).
