# #63: Conversation-scope addressing — moderator-bound correlationId reuse across collaborating agents

## Summary

Today every `invoke_agent` resolves correlationId as `args.correlationId ?? state?.correlationId ?? randomUUID()`, and the moderator persona mints a fresh correlationId via `new_conversation` once per user turn. Cross-turn dispatches on the same ticket therefore land in fragmented conversation-scope partitions, so collaborating agents cannot read each other's `conversation:<corrId>:<key>` writes.

The #61 session (one-turn dev+review) observed the first conversation-scope handoff in the series purely by accident — both dispatches shared the per-turn correlationId. The #59 session (multi-turn, fresh per dispatch) reverted to QRM8's write-only behavior, and the architect's design notes only reached the developer because they were filed in **project** scope as a workaround.

## Motivation

The QRM9 roadmap (`tickets/49-stabilization/49-stabilization.md`, design conclusion #3 and the Deferred section) explicitly named "managing correlationId so a ticket's collaborating agents share one conversation partition (moderator-driven, analogous to session resume)" as the unresolved design question after the bootstrap-channel fixes (#55/#56) and the search-floor fix (#61) landed.

Two session reports now empirically frame the choice:
- `logs/sessions/2026-06-16-qrm9-61-context-audit.md` — handoff works under a shared correlationId.
- `logs/sessions/2026-06-17-qrm9-59-context-audit.md` — handoff vanishes without one.

Channel mechanism unchanged — addressing decided the outcome.

## Problem Statement

The moderator owns correlationId minting (`new_conversation` at `apps/mcp-server/src/mcp/mcp.service.ts:1137`) and the per-call override (`invoke_agent` at `:357-359` already accepts an explicit `correlationId`). The runtime supports the desired binding today; what is missing is the orchestration discipline that decides *when* to mint a fresh correlationId vs reuse an existing binding.

The fix is moderator-side: extend the moderator persona to bind correlationId to a work-unit scope (ticket-shaped, but defined ephemerally by the moderator's judgment — **not** surfaced as a `ticketId` field in the API), and update the prompt/doc sites currently teaching per-turn binding.

See `tickets/{this-issue-number}-conversation-scope-correlation-reuse.md` for the full spec (Implementation Details and Acceptance Criteria authored by the teamlead after architect design review).

## Status — Stub Pending Architect Design Review

Implementation Details, Acceptance Criteria, and Dependencies are intentionally deferred to a follow-up commit on this branch. The next steps are:

1. **Architect** stores design notes in project scope under key `63-design-notes` covering: mint-vs-reuse mental model (ticket-shaped, ephemeral, moderator-judgment; not a runtime `ticketId`), fallback semantics (forgotten binding ≡ today's behavior — graceful degradation), the prompt/doc update sites that currently teach per-turn binding, and explicit out-of-scope items (no `ticketId` field in the API, no persistence layer, concurrent same-role siblings handled by "don't dispatch concurrently on one ticket" prompt guidance — not a structural mitigation).
2. **Teamlead** expands this stub into a full spec citing the architect's design notes.
3. **User Phase 1 review** of the completed spec PR.

## Dependencies and References
- **Parent epic:** [#49](https://github.com/ia64mail/quorum/issues/49) (QRM9 Roadmap — Stabilization)
- **Surfaced by:** [`tickets/49-stabilization/49-stabilization.md`](49-stabilization/49-stabilization.md) — design conclusion #3 and the Deferred section
- **Empirical basis:**
  - `logs/sessions/2026-06-16-qrm9-61-context-audit.md` — shared correlationId → conversation handoff worked
  - `logs/sessions/2026-06-17-qrm9-59-context-audit.md` — rotated correlationId → conversation handoff vanished
- **Related architect analysis (Shapes 1–4 retry-correlation):** [`tickets/59-agent-scope-role-keyed-partition.md`](59-agent-scope-role-keyed-partition.md), `59-design-notes` in project scope
- **Runtime touchpoints (no code change expected here; for context):**
  - `apps/mcp-server/src/mcp/mcp.service.ts:1137` — `new_conversation` mints `randomUUID()`
  - `apps/mcp-server/src/mcp/mcp.service.ts:357-359` — `invoke_agent` resolves `args.correlationId ?? state?.correlationId ?? randomUUID()` (the per-call override already exists)
