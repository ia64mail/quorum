# #51: Ticket library — "truth about change, not current state" consumption discipline

## Summary

The ticket library guidance (`tickets/README.md`, and the Ticket Library section duplicated in both the root `CLAUDE.md` and `docker/moderator/CLAUDE.md`) tells agents what a ticket *is* — a time snapshot of reasoning — but does not tell them how to *consume* one safely. This ticket adds an explicit consumption discipline: a ticket is an accurate record of one change at the moment it was authored, but the system evolves through later changes — each captured by *its own* later ticket — so a single ticket's claims may have been superseded since. Read the library as a chain of transactions whose composition is the current state; reconcile across the chain, with code and runtime as final ground truth. It is a documentation-only change.

## Problem Statement

The current guidance establishes the right framing — tickets are "time snapshots," the codebase "remains the primary source of truth for *how*," and tickets explain "the sequence of decisions." But that framing is **descriptive**: it characterizes the artifact without giving the agent a rule for using it. The starting point is that a ticket *is* a source of truth — an accurate record of one change at the moment it was authored. The risk is not that the ticket is wrong; it is in mistaking *which* truth it carries. Two failure modes follow:

1. **Reading a transaction as the current state.** A ticket carries concrete facts: `file:line` references, payload shapes, log strings, flag names, behavioral claims. These were accurate for the change the ticket recorded. But the system keeps evolving, and an agent tends to read those facts as describing the system *now* and skip confirming them against the running code. When a later change has moved the code (a refactor, a renamed symbol, a flipped default), the agent acts on a fact that was true *then* and is stale *now*. The ticket is not at fault — it correctly describes its own transaction; the error is treating "true at this transaction" as "true currently."

2. **Reading one ticket in isolation instead of the chain.** Each ticket records one transition — the state *before* the work and the intended state *after*. The current state is the **composition of the whole chain of transactions**, not any single one. Crucially, the very change that superseded an earlier ticket's claim is itself recorded by a *later* ticket — this is how the library reinforces itself: tickets are the source of truth for *how the system changed over time*. An agent that reads one mid-history ticket without following the chain (predecessor/successor references, the chronological numbering) reconstructs a superseded state, not the present.

These are structural risks in how an autonomous agent consumes the library, independent of ticket quality. The library already mitigates the *implementation-drift* edge case — where merged code diverges from the originating ticket — via mandatory post-implementation `Implementation Notes` + `Deviations from Ticket Spec`, co-committed with the work. What remains unaddressed is the *temporal* case above: a ticket accurate for its own transaction, later superseded by subsequent transactions. The fix is a consumption rule that says so — reconcile across the chain, and confirm against code as final ground truth — and that is what this ticket adds.

## Why now

The library is the bootstrap context for every role in the system, and agents act on it autonomously inside isolated worktrees with no human reading each ticket claim before it is used. The guidance should encode its own failure mode where the agent will read it — before the first ticket — rather than leaving "verify before you trust" as tribal knowledge.

## Design Context

This aligns the ticket library's *consumption* guidance with the source-of-truth hierarchy already stated across the repo: code and the running system are ground truth; `docs/` describes current-state architecture; `tickets/` explains the **why** and the **evolution path**. The change makes that hierarchy actionable at the point of ticket use, rather than only asserting it.

Scope is the single Quorum repository and its `QRM<N>-NNN` / `#NNN` chronological numbering. No cross-repository concerns are in scope.

## Implementation Details

Documentation-only. One new README subsection plus a matching pointer in both CLAUDE.md files.

### 1. `tickets/README.md` — new subsection

Add a subsection (after **Tickets vs Documentation**, before **Naming Convention**) titled along the lines of *"A ticket is the truth about a change, not about the present"* (the framing being: tickets *are* a source of truth — for how the system evolved — but not for its current state). It should state, in the README's existing voice:

- A ticket records an accurate transition from **state A → state B** at the moment it was authored. It is the truth about *that change*, not a live description of current behavior. The current state is the **composition of every transaction in the chain**; code and the running system are the final ground truth for it.
- **A claim true at its transaction may be stale now.** `file:line` references, payload/type shapes, log strings, flag names, and behavioral descriptions were accurate for the change the ticket recorded. They are not standing facts about the present — a later change may have moved them. Don't treat "true then" as "true now"; confirm the present A→B state before relying on it (e.g., read a flag's current value rather than assuming the ticket's).
- **Read the chain, not one ticket.** One ticket is one transaction. The change that superseded an earlier ticket is itself recorded by a *later* ticket — this is how tickets reinforce each other. To reconstruct current state, follow referenced/predecessor tickets and the chronological numbering across A→B→C→…→now; a single ticket in isolation gives you one transaction, possibly already superseded.
- **Reconcile across the chain, confirm against code.** Use `docs/` for current-state architecture and the code/running system for ground truth; use `tickets/` for the **why** and the **evolution path** — the ordered record of how the code reached its present shape.

Cross-reference the existing `Implementation Notes` / `Deviations from Ticket Spec` convention as the mechanism that keeps tickets honest about where they intentionally diverge from the merged code.

### 2. Both `CLAUDE.md` files — Ticket Library section pointer

The **Ticket Library** subsection exists, near-identically, in **two** files: the root `CLAUDE.md` (developer-facing, under Project Structure) and `docker/moderator/CLAUDE.md` (the in-container moderator persona, under its Project Structure section). Both must get the pointer, kept consistent between them.

In each Ticket Library subsection, add one sentence making the discipline visible at session start and pointing to the new README subsection — e.g. that a ticket is the truth about a change at its authoring moment (not the present state), so claims should be reconciled across the ticket chain and confirmed against current code/runtime, with the detail in `tickets/README.md`. Keep it to a sentence or two; the README holds the full guidance. The two pointers can be worded identically.

Keep both edits abstract about motivation — state the discipline and its rationale (a transaction read as current state; one ticket read in isolation) in general terms. Do not narrate a specific incident.

## Acceptance Criteria

- [ ] `tickets/README.md` has a new subsection establishing tickets as the truth about a change (A→B) but not about current state, covering: a claim true at its transaction may be stale now, read-the-chain (not one ticket), and reconcile-across-the-chain-confirm-against-code
- [ ] The subsection cross-references the existing `Implementation Notes` / `Deviations from Ticket Spec` convention as the implementation-drift mitigation it complements
- [ ] The Ticket Library section in **both** the root `CLAUDE.md` and `docker/moderator/CLAUDE.md` gains a one-to-two-sentence pointer to the new guidance, worded consistently between them
- [ ] No multi-repository / cross-repo language introduced anywhere
- [ ] Motivation is stated abstractly; no specific incident or external document is referenced
- [ ] Wording matches the existing voice of each file; numbering scheme references use Quorum's `QRM<N>-NNN` / `#NNN` convention
- [ ] This ticket's `Implementation Notes` section added on completion

## Dependencies and References

- `tickets/README.md` — ticket library conventions guide (primary file under change)
- `CLAUDE.md` (root) — Ticket Library subsection under Project Structure (secondary file under change)
- `docker/moderator/CLAUDE.md` — in-container moderator persona; carries a duplicate Ticket Library subsection that must receive the same pointer
- Related existing mechanism: post-implementation `Implementation Notes` + `Deviations from Ticket Spec` (README §Post-Implementation Update) — drift mitigation this discipline complements
- `docs/knowledge-management.md` — knowledge-domain framing that the source-of-truth hierarchy here is consistent with