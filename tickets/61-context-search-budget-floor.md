# #61: context_query search returns no results when the top-ranked record exceeds the token budget

## Summary

`context_query mode=search` applies its token budget with **skip-and-stop** admission: the first hit that would overflow the budget sets a `budgetExhausted` flag that then gates every subsequent (lower-ranked) hit. Because a single stored record can be larger than the entire default search budget (`CONTEXT_DEFAULT_MAX_TOKENS`, 2000 — while `*-design-notes` records reach ~2180 tokens on the live index), a search whose most-relevant hit is an oversized record returns an **empty or near-empty result set**, even when smaller relevant records ranked just below it would have fit. Fix: add a **return-at-least-the-top-hit floor** to both store backends so search never returns empty when hits exist, and raise the default ceiling `2000 → 3000` so a large top hit still leaves room for ~2 typical records. Skip-and-stop is otherwise preserved (search is relevance-ranked — the result is a ranked prefix, not a bin-packed set).

## Problem Statement

### The mismatch

The search handler resolves the budget from config (`apps/mcp-server/src/mcp/mcp.service.ts`, `mode === 'search'`):

```ts
const maxTokens = args.maxTokens ?? this.config.context.defaultMaxTokens;
```

`defaultMaxTokens` defaults to 2000 (`apps/mcp-server/src/config/context.config.ts`, `CONTEXT_DEFAULT_MAX_TOKENS || '2000'`). Both backends then walk relevance-ranked hits and stop at the first overflow:

```ts
// apps/mcp-server/src/context-store/opensearch/opensearch-store.ts (search)
const fits = !budgetExhausted && consumed + tokens <= tokenBudget;
if (fits) {
  consumed += tokens;
  results.push(hit._source);
} else {
  budgetExhausted = true;   // <-- every later hit is now gated by !budgetExhausted
}
```

```ts
// apps/mcp-server/src/context-store/in-memory-store.ts (search)
if (!budgetExhausted && tokens <= tokenBudget) {
  tokenBudget -= tokens;
  results.push(item);
} else {
  budgetExhausted = true;
}
```

When the **top-ranked hit alone** exceeds the budget (`tokens > maxTokens`), it is rejected, `budgetExhausted` is set, and the loop returns **zero results** — despite the store holding smaller relevant records further down the ranking. The agent receives an empty array and concludes no relevant context exists.

### Why skip-and-stop itself is correct (and is kept)

Unlike the bootstrap channel ([#56](56-bootstrap-budget-sizing.md)), search results are **ranked by relevance**. Truncating at the first overflow yields the highest-relevance prefix that fits — the desired behavior; we must *not* skip a large high-rank record to admit a small low-rank one (that would reorder by size, not relevance). So the bug is **not** the skip-and-stop policy. The bug is the absence of a **floor**: when even the single best hit doesn't fit, the channel should still return that one hit rather than nothing.

### Evidence — live `quorum-context` index (2026-06-15)

Measured with the production estimator (`ceil(JSON.stringify(value).length / 4)`) over the 117 project records (see [#56](56-bootstrap-budget-sizing.md) Implementation Notes for the full distribution):

- **2 records exceed the entire 2000-token default budget**: `QRM6-007-design-notes` (2180), `11-design-notes` (2040). As a sole top hit, each returns an empty result set today.
- **4 more consume 80–95% of the budget alone** (1595–1879), so a search topped by any of them returns just that one hit and stops — even when the next-ranked hit would fit in a slightly larger budget.
- Project record sizes overall: min 10, median 360, mean 447, max 2180. At mean ~447 tok/record, the current 2000 budget already returns ~4–5 typical records — confirming the ceiling is *adequate for typical hits*; the defect is purely the oversized-top-hit edge.

Risk of not fixing: the one retrieval path the QRM8 audit found working (project search, 9/9 hits) silently fails exactly when the most relevant record is also the largest — i.e. for the high-value synthesis records agents most need.

## Design Context

`docs/context-management.md` (Pattern: search / `context_query`) documents search as "ranked by relevance … accumulated within the `maxTokens` budget". The budget is a *total-context* cap, not a per-item cap; the contract should guarantee that a non-empty hit set always yields at least one returned item. `CONTEXT_DEFAULT_MAX_TOKENS` is the fallback only — agents may pass `args.maxTokens` per call. This finding is the search-channel analogue of [#56](56-bootstrap-budget-sizing.md) (bootstrap budget below record sizes) and was surfaced during that ticket's live-index analysis.

## Implementation Details

1. **Return-at-least-the-top-hit floor (primary)** — in both `OpenSearchStore.search` and `InMemoryStore.search`, always admit the first (top-ranked) hit even if it alone exceeds the budget, then close the gate. Representative shape (OpenSearch):

   ```ts
   const isTopHit = results.length === 0;
   const fits = consumed + tokens <= tokenBudget;
   if (!budgetExhausted && (fits || isTopHit)) {
     consumed += tokens;
     results.push(hit._source);
     if (!fits) budgetExhausted = true; // oversized top hit admitted — stop here
   } else {
     budgetExhausted = true;
   }
   ```

   InMemory mirrors this (its loop decrements `tokenBudget`; the same `isTopHit` carve-out applies). The per-hit trace `includedInResult` must mark the floored top hit as included; `truncatedByTokenBudget` still reflects that later hits were dropped.

2. **Raise the default ceiling `2000 → 3000`** in `context.config.ts` (`CONTEXT_DEFAULT_MAX_TOKENS` default) — clears the largest live record (2180) and leaves room for ~2 additional typical records after a large top hit. `CONTEXT_DEFAULT_MAX_TOKENS` is not set in `docker-compose.yml`, so the code default governs deployment; update `.env.example` and the docs accordingly. 3000 (not the bootstrap's 5000/4000) is deliberate: search is a per-query, full-priced, relevance-ranked pull, so a modest ceiling avoids returning low-relevance tail hits — the floor, not the ceiling, is the correctness fix.

3. **Keep skip-and-stop** for all non-top hits (ranked-prefix semantics) — do not switch to bin-packing.

## Acceptance Criteria

1. - [x] `OpenSearchStore.search` and `InMemoryStore.search` return the top-ranked hit even when it alone exceeds the token budget (no empty result set when ≥1 hit matches).
2. - [x] Non-top hits still follow skip-and-stop (ranked prefix; no size-based reordering).
3. - [x] `CONTEXT_DEFAULT_MAX_TOKENS` default raised `2000 → 3000`; Zod schema unchanged (env-overridable).
4. - [x] `.env.example` and `docs/context-management.md` updated to the new default and the floor behavior.
5. - [x] Unit tests (both backends): (a) an oversized sole hit is returned; (b) an oversized top hit followed by smaller hits returns the top hit and stops; (c) normal multi-hit budgeting unchanged. Trace assertions for `includedInResult` / `truncatedByTokenBudget`.
6. - [x] `npm run build`, `npm run lint`, `npm run test` pass with no regressions.

## Dependencies and References

- Sibling of [#55](55-bootstrap-getall-recency-ordering.md) and [#56](56-bootstrap-budget-sizing.md) under epic #49; independent of both (search path, not bootstrap).
- Code: `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` (`search`), `apps/mcp-server/src/context-store/in-memory-store.ts` (`search`), `apps/mcp-server/src/config/context.config.ts`, `apps/mcp-server/src/mcp/mcp.service.ts` (search handler).
- Docs: `docs/context-management.md`.
- Origin: live-index analysis during [#56](56-bootstrap-budget-sizing.md).

## Out of Scope

- Switching search to bin-packing / skip-and-continue (ranked-prefix semantics are intentional).
- Bootstrap budget sizing — [#56](56-bootstrap-budget-sizing.md).
- Per-record write-time size caps or warnings.
- Query-aware budget adaptation or relevance-threshold cutoffs.
- Stale-record cleanup in the store.

## Implementation Notes

**Status:** Complete
**Date:** 2026-06-16
**PR:** #62

### Files Created/Modified

| File | Change |
|------|--------|
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` | Added `isTopHit` floor: first ranked hit admitted even when exceeding `tokenBudget`, then `budgetExhausted` set. `includedInResult` trace field updated from `fits` to `include`. |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Same floor logic adapted for decremental `tokenBudget` pattern. |
| `apps/mcp-server/src/config/context.config.ts` | Default `CONTEXT_DEFAULT_MAX_TOKENS` changed `2000` → `3000`. |
| `apps/mcp-server/src/config/context.config.spec.ts` | Default assertion updated to `3000`. |
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | 3 new tests in `describe('top-hit floor (#61)')`: oversized sole hit, oversized top hit + followers, normal multi-hit preserved. All include trace assertions. |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | 3 new tests mirroring the OpenSearch suite for the InMemory backend. |
| `.env.example` | `CONTEXT_DEFAULT_MAX_TOKENS=3000` |
| `docs/context-management.md` | Search mode table, hybrid search §4, and `context_summarize` budget calc all updated with top-hit floor semantics and new 3000 default. |

### Deviations from Ticket Spec

None. Implementation follows the ticket's proposed code shape exactly.

### Verification

- `npm run build` — 3 webpack compilations, 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 854 tests passed across 48 suites (848 baseline + 6 new)