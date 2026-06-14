# #55: Bootstrap context ignores recency — OpenSearchStore.getAll returns unsorted results

## Summary

`BootstrapContextService` selects which Context Store records to inject into every agent invocation under the assumption that `getAll()` returns items in insertion order, so that reversing them prefers the newest. That assumption holds only for the dev/test `InMemoryStore` backend. The production `OpenSearchStore.getAll()` issues a filter-only query with **no sort clause**, so item order is Lucene-internal and arbitrary — the "prefer newer" heuristic is meaningless in every production deployment. Fix: make `getAll()` return items sorted by `createdAt` ascending, restoring the insertion-order contract for both backends.

## Problem Statement

Every agent invocation receives a bootstrap context block ("## Prior Decisions") assembled by `BootstrapContextService.assemble()`. The selection step is documented in the code as recency-based:

```ts
// apps/mcp-server/src/messaging/bootstrap-context.service.ts (applyBudget)
// Reverse entry order to prefer newer items (later in Map insertion order)
const entries = Object.entries(items).reverse();
```

"Later in Map insertion order" is an `InMemoryStore` property. The production backend is OpenSearch (`CONTEXT_STORE_BACKEND=opensearch`), where `getAll` builds the result map from raw search hits:

```ts
// apps/mcp-server/src/context-store/opensearch/opensearch-store.ts (getAll)
const response = await this.client.search({
  index: this.osConfig.index,
  body: {
    query: { bool: { filter: filters } },
    size: 10000,
    _source: { excludes: ['embedding', 'embeddingText'] },
  },
});
```

A filter-only query returns constant-score hits in internal `_doc` order — correlated with insertion for an append-only index, but scrambled by segment merges and never contractual. The net effect is that bootstrap composition is **arbitrary and quasi-static**, not recency-driven.

### Evidence — QRM8 reference session (2026-05-24 → 05-27)

Observed across the full session (logs `mcp-server-20260524T003426.jsonl`, role JSONLs; bootstrap item text recovered from the `=== Initial prompt ===` debug lines in the agent logs):

- All **34** bootstrap assemblies in the session injected a near-identical item set: 3–4 items, 549–598 tokens, against a project scope holding **~110 records** at the time (117 by 2026-06-11).
- The recurring 4-item set was, verbatim by key:
  - `29-project-notes` (~428 tok, written 2026-05-23) — genuinely relevant, but present by luck of index order, not selection;
  - `two-tier-billing-docs` (~120 tok, 2026-05-14) — content fully duplicated in `docs/system-design.md` (the record itself says so);
  - `qrm6-rerun-elicit-A` (~12 tok, 2026-05-02) — the literal string `"QRM6 elicitation round-trip RERUN verified"`;
  - `elicitation-test-A` (~10 tok, 2026-04-25) — `"QRM6 elicitation round-trip verified"`.
- The two elicitation strings are month-old QRM6 connectivity-test residue with zero relevance to any task; they rode along in **every one of the 34 bootstraps**.
- Records written *during* the session (e.g. `31-project-notes`, `14-project-notes`, `16-project-notes`, `11-design-notes`) never displaced anything in subsequent bootstraps. (For `31-project-notes` specifically the budget is the additional blocker — see [#56](56-bootstrap-budget-sizing.md) — but the ordering bug means even small fresh records have no preference over stale small ones.)

Risk of not fixing: the bootstrap channel — the only context an agent receives without asking — systematically delivers stale, arbitrary knowledge while the freshest project decisions are invisible, and any future budget increase ([#56](56-bootstrap-budget-sizing.md)) would simply admit *more* arbitrary records.

## Design Context

`docs/context-management.md` describes bootstrap injection as delivering recent project decisions; `docs/context-store.md` documents the OpenSearch backend. The intent of `applyBudget`'s `.reverse()` is correct — the contract it relies on (`getAll` returns oldest→newest) is simply unimplemented on one backend. The documents (`createdAt` epoch-millis field) already carry everything needed to sort.

## Implementation Details

Restore the insertion-order contract at the store boundary rather than re-sorting in the consumer:

1. **`OpenSearchStore.getAll()`** — add a sort clause to the search body:

   ```ts
   sort: [{ createdAt: 'asc' }],
   ```

   Ascending order matches `InMemoryStore`'s Map insertion order, so `applyBudget`'s existing `.reverse()` ("newest first") becomes correct unchanged. JS objects preserve string-key insertion order, so the `Record<string, unknown>` return type carries the ordering faithfully.

2. **Document the contract** — add a doc comment on the `ContextStore.getAll` abstraction stating that implementations must return items in `createdAt` ascending order, so future backends don't regress the same way.

3. **No change to `BootstrapContextService`** — its logic is correct once the contract holds.

Why not sort descending and drop the `.reverse()`: that would change the `getAll` contract for every consumer (including `context_query mode=get-all` reads) and touch two files for the same outcome; ascending is the minimal, semantically-honest fix.

Note: `createdAt` must be mapped as a numeric/date field for the sort to work — it is stored as epoch millis today; verify the index mapping doesn't treat it as `text` (a sort on an unmapped/text field throws, which would surface immediately in the existing `getAll` error path).

## Acceptance Criteria

1. - [x] `OpenSearchStore.getAll()` includes `sort: [{ createdAt: 'asc' }]` in the search body.
2. - [x] `ContextStore.getAll` contract documented: items returned in `createdAt` ascending order.
3. - [x] Unit test: `OpenSearchStore.getAll` passes the sort clause to the client (assert on the mocked client's request body).
4. - [x] Unit test (or existing-test audit): `BootstrapContextService` selects the newest items when `getAll` returns oldest→newest and the budget forces a cut.
5. - [x] `npm run build`, `npm run lint`, `npm run test` pass with no regressions.
6. - [ ] Manual verification on the live `quorum-context` index: a bootstrap assembly after the fix injects the most recent small-enough project records instead of the static QRM6-era set.

## Dependencies and References

- **Blocks** [#56](56-bootstrap-budget-sizing.md) (bootstrap budget increase) — raising the budget without this fix admits more records in arbitrary order.
- Code: `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` (`getAll`), `apps/mcp-server/src/messaging/bootstrap-context.service.ts` (`applyBudget`).
- Docs: `docs/context-store.md`, `docs/context-management.md`.
- Origin: QRM8 per-ticket context audit of the 2026-05-24 reference session (finding B1).

## Out of Scope

- Budget sizing and ratio changes — [#56](56-bootstrap-budget-sizing.md).
- Query-aware / task-relevant bootstrap selection (bootstrap is assembled before the task is known to the store; any relevance ranking is a larger design change).
- Cleanup of stale store records (`elicitation-test-A`, `qrm6-rerun-elicit-A`) — worth doing, but data hygiene, not code.

## Implementation Notes

**Status:** Complete

**Date:** 2026-06-13

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` | Modified | `getAll()` search body gains `sort: [{ createdAt: 'asc' }]` (oldest-first), with a comment pointing at the contract and #55. |
| `libs/common/src/context-store/context-store.abstract.ts` | Modified | `getAll` JSDoc now states the ordering contract (items returned `createdAt` ascending; callers `.reverse()` to prefer newest). |
| `docs/context-store.md` | Modified | OpenSearch behavior table `getAll()` row notes the createdAt-ascending sort and the ordering contract. |
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | Modified | New test asserts `getAll` passes `sort: [{ createdAt: 'asc' }]` to the client request body. |

### Deviations from Ticket Spec

None. Implemented exactly as specified — single-line sort addition on the store boundary, no change to `BootstrapContextService`. AC #4 was satisfied by audit: the existing `bootstrap-context.service.spec.ts` "item recency ordering" test already exercises newest-preference over an oldest→newest input under a tight budget, which is exactly the behavior this fix restores at the backend boundary.

### Verification

- `npm run build` — compiles successfully (3 webpack bundles)
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 840 tests passing (1 new + 839 existing), 47 suites
- AC #6 (live-index manual verification) left unchecked — requires a running OpenSearch/Ollama deployment, deferred to runtime smoke verification.