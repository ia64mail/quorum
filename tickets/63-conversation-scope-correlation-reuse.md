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

## Design Context

The architect's analysis (project scope, key `63-design-notes`) established the **mint-vs-reuse mental model**: correlationId is bound to a work unit (ticket-shaped), not to a user turn. The moderator maintains an ephemeral in-memory binding map of ticket → correlationId in its CC chat history — no persistence layer, no API field, lost on session restart (graceful degradation to today's per-turn behavior).

The decision flowchart is:
- **(a) New work unit** (first time touching a ticket, ad-hoc question, exploration): call `new_conversation`, record the returned correlationId as that ticket's binding.
- **(b) Continuing a bound ticket** (same turn or later turn): do NOT call `new_conversation`; pass the ticket's bound correlationId explicitly via `invoke_agent(correlationId=<id>)`. The explicit parameter overrides session state per the existing resolution logic at `mcp.service.ts:357-359` (`args.correlationId ?? state?.correlationId ?? randomUUID()`).
- **(c) Non-ticket turns** (ad-hoc questions, repo exploration): default to today's per-turn fresh mint via `new_conversation`.

This directly subsumes the architect's #59 **Shape 2b** (cross-turn retry / failure recovery): under the old model, a retry at turn N+1 mints a fresh correlationId, making the failed agent's conversation-scope checkpoints invisible and requiring the moderator to bridge by querying the old correlationId manually. Under the new model, the ticket's binding persists — retry automatically lands in the same conversation partition. The bridge step becomes unnecessary.

**Pre-existing misinformation absorbed into this ticket:** Three passages in `docker/moderator/CLAUDE.md` (lines 34, 115, 233) incorrectly claim `new_conversation` clears cached agent sessions. The code at `mcp.service.ts:1136-1163` proves it only assigns `state.correlationId` — it never touches `state.agentSessions`. Line 214 of the same file and the `new_conversation` tool description at `mcp.service.ts:1123-1124` correctly state sessions persist. This misinformation predates the session-resume feature and was never corrected. It sits inside text that #63 will rewrite, so it is fixed as part of this ticket.

## Implementation Details

This is a prompt/doc-only change. No behavioral code changes are expected. Implementation can land in a **single commit** — no multi-unit splitting needed.

### Moderator Persona Snippet — New Turn Lifecycle

The following text replaces the current Turn Lifecycle section (`docker/moderator/CLAUDE.md` lines 32–38) verbatim:

```markdown
## Turn Lifecycle (CRITICAL)

At each turn start, decide: new work unit, or continuing a bound ticket?

**New work unit** (first time touching a ticket, ad-hoc question, exploration):
Call `new_conversation`. Record the returned correlationId as that ticket's
binding for the session.

**Continuing a bound ticket:**
Do NOT call `new_conversation`. Pass the ticket's bound correlationId explicitly
via `invoke_agent(correlationId=<id>)`.

Always run `git fetch origin && git pull --ff-only` at turn start regardless.

The binding map lives in your chat history — lost on session restart, reverting
to today's mint-per-turn behavior (graceful degradation).

If you forget the binding or lose it, the system degrades to today's per-turn
behavior — fragmented but functional.
```

### Concurrent Same-Role Guidance

Add the following paragraph adjacent to the Turn Lifecycle section or the Sizing implementation dispatches section:

> Do not dispatch concurrent same-role agents on a single ticket. Code collisions from concurrent writes to the same codebase files are the primary risk — correlationId sharing compounds it by adding conversation-scope key collisions (e.g., two developers both writing "research_findings" to the same partition, last-write-wins). Sequential dispatch eliminates both risks and costs nothing in practice — the second dispatch benefits from the first's conversation-scope checkpoints.

### 9-Site Update List

**`docker/moderator/CLAUDE.md`** (7 sites):

| Site | Line(s) | Current text (quoted) | Replacement gist |
|------|---------|-----------------------|------------------|
| 1 | 23 | `**conversation** (tied to the current turn's correlation ID)` | Change to `**conversation** (tied to the current work unit's correlation ID)` |
| 2 | 32–38 | Entire Turn Lifecycle section: "You MUST call `new_conversation` at the start of each user turn…" | Replace with the Moderator Persona Snippet above (verbatim). This is the core rule change. |
| 3 | 34 | "It also clears cached agent sessions so invocations start fresh for a new topic." | **DELETE** — factually incorrect per code (`mcp.service.ts:1136-1163` only sets `state.correlationId`, never touches `state.agentSessions`). Subsumed by the Turn Lifecycle rewrite at Site 2. |
| 4 | 115 | "or split across user turns, where `new_conversation` produces the same effect" | Remove the parenthetical. `new_conversation` does NOT clear session caches (same pre-existing bug as Site 3). Replace with: "Pass `sessionId: ""` on each split invocation to discharge cumulative-transcript cost." Remove the false equivalence with `new_conversation`. |
| 5 | 137 | "After calling `new_conversation`, run `git fetch origin && git pull --ff-only`" | Change to: "At the start of each turn, run `git fetch origin && git pull --ff-only`" — must work when `new_conversation` is skipped (bound-ticket continuation). Already captured in the Turn Lifecycle snippet ("Always run `git fetch origin && git pull --ff-only` at turn start regardless.") — verify this Workspace Model paragraph stays consistent with the snippet. |
| 6 | 186–189 | Failure Recovery: "Query **conversation** scope with `mode=get-all` (not search) using the same correlationId" | Simplify to: "using the ticket's bound correlationId." Under the new model, the bound correlationId IS the ticket's ID — the bridge step from Shape 2b is subsumed. |
| 7 | 233 | "The `new_conversation` tool at the start of each turn already clears session caches, so invocations in a new turn start fresh automatically." | **DELETE or rewrite** — contradicts line 214 ("cached sessionIds persist across `new_conversation` boundaries") and the code. Under the new model `new_conversation` isn't always called at turn start, making this doubly wrong. Replace with a sentence consistent with line 214: e.g., "Session caches persist across `new_conversation` boundaries. Pass `sessionId: ""` when you want a completely fresh agent session." |

**`apps/mcp-server/src/mcp/mcp.service.ts`** (1 site):

| Site | Line(s) | Current text (quoted) | Replacement gist |
|------|---------|-----------------------|------------------|
| 8 | 1120–1125 | `new_conversation` tool description: "for the current user turn" and "Call this at the beginning of each new user turn." | Change "for the current user turn" → "for the current work unit" and "Call this at the beginning of each new user turn" → "Call this when starting a new work unit (new ticket, ad-hoc question)." The CLAUDE.md guidance is the authoritative override, but the tool description should not actively contradict it. |

**`libs/common/src/prompts/role-prompt-templates.ts`** (1 site):

| Site | Line(s) | Current text (quoted) | Replacement gist |
|------|---------|-----------------------|------------------|
| 9 | 241 | Moderator template Failure Recovery: "using the same correlationId" | Same update as Site 6 — change to "using the ticket's bound correlationId" to reference the work-unit binding. |

### Sites Confirmed Unchanged

These locations were surveyed and require no modification:
- `SYSTEM_PREAMBLE:72` — "Tied to the current correlation" is neutral enough.
- `SYSTEM_PREAMBLE:80` — agent-facing correlationId auto-inject, not moderator-facing.
- `SYSTEM_PREAMBLE:117` — "within the same invocation chain (same correlationId)" remains correct; under #63 retries reuse the ticket's binding.
- Developer template:368 — agent-facing checkpoint guidance, not affected by moderator binding rule.
- `docker/moderator/CLAUDE.md:214` (Session Resume) — correctly states sessions persist; no change needed.

### Failure-Mode Catalog

Every failure mode degrades gracefully to today's behavior or better:

| Mode | Effect |
|------|--------|
| (a) Moderator forgets to reuse | Fresh correlationId → dispatch's conversation scope is isolated from prior work → exactly today's behavior. Project-scope workaround still works. |
| (b) Moderator reuses across unrelated tickets by mistake | Two tickets share a conversation partition → bootstrap includes noise → minor impact (budgeted bootstrap limits exposure, search is term-targeted). No data loss. |
| (c) Container restart mid-ticket | Binding map lost → next session starts fresh → today's behavior. Explicitly a non-goal. |
| (d) Agent fails mid-task, moderator retries next turn | Same correlationId reused → failed agent's checkpoints automatically visible. BETTER than today (Shape 2b subsumed). |
| (e) Multiple `new_conversation` calls in one turn | Last one wins for `state.correlationId` → harmless with explicit correlationId on dispatches. |
| (f) Moderator confuses bindings across two tickets in one turn | Degrades to (a) or (b) → graceful. |

## Acceptance Criteria

### Turn Lifecycle rewrite
- [ ] `docker/moderator/CLAUDE.md` Turn Lifecycle section (Site 2) is replaced with the new persona snippet (verbatim from Implementation Details above)
- [ ] Concurrent same-role guidance paragraph is present adjacent to Turn Lifecycle or Sizing implementation dispatches

### Conversation scope language update
- [ ] Site 1 — `docker/moderator/CLAUDE.md:23` says "current work unit's correlation ID" (not "current turn's")

### Session-cache-clearing misinformation fix
- [ ] Site 3 — `docker/moderator/CLAUDE.md:34` false claim that `new_conversation` clears cached agent sessions is removed (subsumed by Turn Lifecycle rewrite)
- [ ] Site 4 — `docker/moderator/CLAUDE.md:115` false equivalence between `new_conversation` and `sessionId: ""` is removed
- [ ] Site 7 — `docker/moderator/CLAUDE.md:233` false claim that `new_conversation` clears session caches is replaced with a sentence consistent with line 214 (sessions persist)

### Workspace Model consistency
- [ ] Site 5 — `docker/moderator/CLAUDE.md:137` git-fetch instruction works when `new_conversation` is skipped (bound-ticket continuation)

### Failure Recovery updates
- [ ] Site 6 — `docker/moderator/CLAUDE.md:186-189` references the ticket's bound correlationId
- [ ] Site 9 — `libs/common/src/prompts/role-prompt-templates.ts:241` Failure Recovery references the ticket's bound correlationId

### MCP tool description
- [ ] Site 8 — `apps/mcp-server/src/mcp/mcp.service.ts:1120-1125` `new_conversation` description says "work unit" instead of "user turn"

### Test coverage
- [ ] `role-prompt-templates.spec.ts` includes an assertion that the moderator template's Failure Recovery section references "conversation scope" and "get-all" (ensuring recovery path documentation survives refactors)

## Out of Scope

These were settled in prior user dialog and the architect's design review — they are constraints, not open questions:

1. **No `ticketId` field in the MCP API.** Work-unit scope is ephemeral, moderator-judgment, lives in the moderator's CC chat history only. No new MCP tool parameter, no persistence layer.
2. **No persistence across moderator container restarts.** Worst case = forgotten binding = today's behavior = graceful degradation.
3. **Concurrent same-role-on-one-ticket handled by prompt guidance only** — "don't dispatch concurrently" is a prompt rule, not a structural mitigation. The code-collision risk exists regardless of correlationId management.
4. **`correlationId` / `sessionId` independence stays** — already decoupled. Cross-turn `sessionId` resume works across `new_conversation` boundaries today (confirmed by code and `docker/moderator/CLAUDE.md:214`).
5. **No `new_conversation` parameter for idempotent reuse hints** — rejected by user.
6. **No new code changes to the MCP server** beyond the `new_conversation` description string (Site 8).

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
