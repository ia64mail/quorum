# #56: Bootstrap token budget structurally excludes project-notes records

## Summary

The bootstrap context budget gives project scope `BOOTSTRAP_MAX_TOKENS(1000) × BOOTSTRAP_PROJECT_RATIO(0.6) = 600` tokens, while the `{ticket-id}-project-notes` synthesis records the role prompts mandate for cross-ticket reuse weigh 425–674+ tokens in practice. The selection loop skips any item that would overflow and keeps filling with smaller ones, so a full-size project-notes record can **never** be bootstrapped — its slot goes to small stale records instead. Fix: raise `BOOTSTRAP_MAX_TOKENS` to 5000 and `BOOTSTRAP_PROJECT_RATIO` to 0.8 (project budget 4000 tokens ≈ 6–8 typical notes). Cost impact on Opus 4.8 is ~$0.03–0.10 per invocation (~3% of a typical review invocation) with healthy prompt caching.

## Problem Statement

### The mismatch

Budget configuration (`apps/mcp-server/src/config/bootstrap.config.ts`):

```ts
maxTokens:    parseInt(process.env.BOOTSTRAP_MAX_TOKENS || '1000', 10),
projectRatio: parseFloat(process.env.BOOTSTRAP_PROJECT_RATIO || '0.6'),
```

Selection (`apps/mcp-server/src/messaging/bootstrap-context.service.ts`, `applyBudget`): items are walked newest-first and any item that would exceed the remaining budget is **skipped with `continue`** — the loop then keeps admitting smaller (typically older) items.

The teamlead role prompt instructs: *"Store project-scope synthesis after accepting a code review — key: `{ticket-id}-project-notes` … This is cross-ticket knowledge."* Measured sizes of that record family (token estimate = `len(JSON.stringify(value))/4`, the same estimator `applyBudget` uses): `29-project-notes` 428, `QRM5-BUG-002-project-notes` 568, `QRM4-004-design-notes` 583, `31-project-notes` 674 (v1) / ~830 (v2), `QRM5-005-design-notes` 1879. Anything above 600 tokens is unbootstrappable **regardless of recency**; after the first ~430-token record is admitted, anything above ~170 is.

### Evidence — QRM8 reference session (2026-05-24 → 05-27)

- All 34 bootstrap assemblies delivered 3–4 items / 549–598 tokens — i.e. the budget was the binding constraint with ~110 project records available.
- Concrete failure case: the ticket #31 second review (05-24 00:36) bootstrapped the same 4 items as the day before, **excluding `31-project-notes` v1 (674 tokens, written 21 h earlier — the single most relevant record for that task)** while including two QRM6 elicitation-test strings (10 and 12 tokens, written a month earlier) that rode along in every bootstrap of the session.
- The skip-and-continue behavior is exactly what lets tiny stale records fill the slots a fresh synthesis record cannot occupy.

### The dead conversation share

Budget reclaim is one-directional (`bootstrap-context.service.ts`, step 6): unused **project** budget is donated to conversation scope, but unused **conversation** budget is never returned to project scope. Conversation partitions are keyed by the invocation's own fresh correlationId, so on virtually every invocation the conversation partition is empty at bootstrap time — the conversation share is dead budget. At the current ratio that's 400 of 1000 tokens; at a naive ×5 it would be 2000 of 5000.

Risk of not fixing: the one channel that delivers context without the agent asking is capped below the size of the records written for it; combined with the scoped-search dead ends already observed (conversation/agent searches returning 0/0 across the session), agents effectively run on ticket files and moderator prompts alone while the store accumulates write-only knowledge.

## Design Context

`docs/context-management.md` (bootstrap injection, scopes) and the role prompts establish project-notes as the cross-ticket reuse channel. The budget default predates both the project-notes convention (records grew to 400–800+ tokens as review synthesis matured) and the OpenSearch-scale store (~117 project records as of 2026-06-11 vs a handful when the default was set).

## Implementation Details

1. **Raise the defaults** in `bootstrap.config.ts`: `BOOTSTRAP_MAX_TOKENS` default `1000 → 5000`, `BOOTSTRAP_PROJECT_RATIO` default `0.6 → 0.8`. Project budget becomes 4000 tokens (≈ 6–8 typical project-notes records, or 2 large design-notes + several small ones); conversation keeps 1000 — more than today's absolute 400, despite the lower ratio.
2. **Document the env vars** wherever bootstrap config is described (`docs/context-management.md`, `.env.example` if the vars are listed there) so deployments can tune down for cost-sensitive runs.
3. **Keep `applyBudget`'s skip-and-continue** — once ordering is recency-correct ([#55](55-bootstrap-getall-recency-ordering.md)), skipping an oversized item to admit the next-newest is the desired bin-packing behavior.
4. **Why ratio over bidirectional reclaim:** reclaiming unused conversation budget in code would adapt automatically, but it's a behavior change in `BootstrapContextService` for a value that is empty on ~100% of observed invocations. The ratio change achieves the same effective project budget as config-only tuning; bidirectional reclaim can be revisited if conversation-scope bootstrap ever becomes load-bearing.

### Cost analysis (Opus 4.8, per invocation)

Pricing: $5/MTok input, $25/MTok output; prompt-cache write 1.25× = $6.25/MTok, cache read 0.1× = $0.50/MTok. The bootstrap is injected into the initial user prompt, a stable prefix across the invocation's turns, so after turn 1 it bills at cache-read rates. Going from today's ~573 used tokens to a full ~5000 adds ~4,400 input tokens:

| Scenario | Math | Extra cost |
|---|---|---|
| Turn 1 (cache write) | 4,400 × $6.25/MTok | ~$0.028 |
| Each subsequent turn (cache read) | 4,400 × $0.50/MTok | ~$0.0022 |
| Long review invocation (~34 turns) | write + 33 reads | **~$0.10** |
| Short invocation (1–3 turns) | | ~$0.03 |
| Degenerate worst case (caching broken, full price every turn) | 4,400 × $5/MTok × 34 | ~$0.75 |

Reference point: the ticket #31 review invocation cost $3.39 — the increase is ~3% per long invocation, roughly $2–3 across a 34-invocation session. Sonnet/Haiku-billed agents scale proportionally cheaper.

## Acceptance Criteria

1. - [ ] `bootstrap.config.ts` defaults: `maxTokens` 5000, `projectRatio` 0.8; Zod schema unchanged (values still env-overridable).
2. - [ ] Bootstrap config env vars documented (docs and/or `.env.example`).
3. - [ ] Unit tests covering the new defaults and a budget-cut case at 4000-token project budget (e.g. seven ~600-token records → first six admitted).
4. - [ ] `npm run build`, `npm run lint`, `npm run test` pass with no regressions.
5. - [ ] Manual verification against the live `quorum-context` index: a bootstrap assembly includes the most recent `*-project-notes` records (requires the getAll ordering fix to be meaningful).
6. - [ ] Spot-check one post-fix invocation's cost/token usage to confirm the cache-read profile (bootstrap tokens appear in `cache_read_input_tokens` after turn 1, not full-price `input_tokens`).

## Dependencies and References

- **Depends on** [#55](55-bootstrap-getall-recency-ordering.md) (getAll recency ordering) — must land first or together; a bigger budget over unsorted results just admits more arbitrary records.
- Code: `apps/mcp-server/src/config/bootstrap.config.ts`, `apps/mcp-server/src/messaging/bootstrap-context.service.ts`.
- Docs: `docs/context-management.md`.
- Origin: QRM8 per-ticket context audit of the 2026-05-24 reference session (finding B2).

## Out of Scope

- Bidirectional budget reclaim in `BootstrapContextService` (revisit if conversation-scope bootstrap becomes load-bearing).
- Deduplicating bootstrap items against subsequent `context_query` search results (separate finding — search returned a bootstrap-duplicated record in the same context window).
- Write-time size caps or warnings for project-notes records.
- Query-aware bootstrap selection.
- Stale-record cleanup in the store.