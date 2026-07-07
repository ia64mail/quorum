# #76: Agent prompt actualization — review built-in role prompts + quorum.md; land the tested ticket-consumption guidance

## Summary

A housekeeping pass over the standing text that frames every agent invocation — built-in role prompts, `quorum.md`, the moderator persona, root `CLAUDE.md`, and `tickets/README.md` — with two distinct parts. **Part 1 (precise, evidence-backed, specified verbatim below):** land the ticket-consumption discipline guidance exactly as validated by the Arm A″ controlled experiment runs, where this text — and nothing else — lifted latent-defect recovery in the library-present condition from **1/3 (Arm A′) to 2/3 (Arm A″)**. **Part 2 (broad, analysis deferred):** review the remaining prompt surfaces against current runtime behavior and actualize what has drifted; this ticket fixes the scope and the acceptance bar, not the findings.

## Problem Statement

The prompt surfaces accreted across nine milestones while the runtime around them kept moving — bootstrap context assembly (#55/#56/#70), session resume semantics, per-invocation worktrees (#11/#65), long-poll continuation (#47), skill dispatch, timeout changes (#72). Nothing systematically re-reads these files against present behavior, so they drift the same way any documentation does — except these files are *load-bearing*: they are injected into every agent's context and measurably steer investigation behavior.

The evidence that this text has measurable effect (and measurable limits) comes from the Article #2 follow-up experiment (Arm A″, three controlled runs against the #74 latent defect on a scrubbed replica, 2026-07-07):

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

Constraints for the implementation pass: prompt-only changes (no runtime code); each edit traceable to a named drift or a named experiment finding; `npm run build`/`lint`/`test` green (template specs will need updating alongside template text).

## Acceptance Criteria

1. - [ ] Part-1 guidance present verbatim in all three files at the specified anchors (a grep for "Interrogate, don't consult" and "absence is a finding" matches `tickets/README.md`, `CLAUDE.md`, `docker/moderator/CLAUDE.md`).
2. - [ ] Part-1 wording byte-faithful to this spec (no paraphrase).
3. - [ ] Part-2 review performed per surface, with a short drift log (what changed and why, or "no drift") recorded in the ticket's Implementation Notes.
4. - [ ] Prompt template spec files updated to match any template changes.
5. - [ ] `npm run build`, `npm run lint`, `npm run test` pass with no regressions.

## Dependencies and References

- Evidence base: Article #2 ("The Ticket Library and the 'Unknown Unknown' Problem") + its A″ follow-up write-up; experiment record in local scratch (`tickets/tmp/articles/02-ticket-library/`, gitignored) — key result: A′ 1/3 → A″ 2/3, sole delta = the Part-1 text.
- [#74](74-getall-cap-recency-truncation.md) — the latent defect the experiment ran against (closed, superseded by #70); its Resolution amendment carries the seam this guidance exists to catch.
- [#51](51-ticket-library-verification-discipline.md) — the original "truth about a change" consumption discipline this extends.
- Epic: [#49 QRM9 Stabilization](49-stabilization/49-stabilization.md).

## Out of Scope

- **Deterministic enforcement** (read-ledger gate on the tool-guard hook that blocks a first dispatch/edit until the session has consulted the library) — the natural follow-up to the "channel, not checkpoint" finding, but a runtime change deserving its own ticket and its own measurement.
- Restructuring the role system or tool profiles beyond staleness fixes.
- `docs/` accuracy sweep (separate concern; this ticket is the *prompt* surfaces).
