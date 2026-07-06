# #74: Bootstrap context at scale — getAll 10,000-doc cap × ascending sort silently drops the newest records

## Summary

`OpenSearchStore.getAll()` sorts results `createdAt` **ascending** (the [#55](55-bootstrap-getall-recency-ordering.md) recency contract) and caps every query at **`size: 10000`** ([QRM5-005](QRM5-005-opensearch-store.md), set for result-size safety). The two decisions interact: once any `(scope, id)` partition outgrows the cap, the query returns the **oldest** 10,000 documents — the newest records, the only ones the bootstrap briefing exists to deliver, are silently cut off, and `applyBudget`'s `.reverse()` then merely re-orders stale survivors. A secondary defect shares the surface symptom on the dev/test backend: `InMemoryStore.set()` on an existing composite key updates the item in place at its **original Map position**, so after any upsert the in-memory `getAll` iteration order no longer equals `createdAt` order. Both defects are latent at today's data volume and deterministic at scale.

## Problem Statement

### Primary — cap × sort truncation (OpenSearch backend)

The production `getAll` query (`apps/mcp-server/src/context-store/opensearch/opensearch-store.ts:171-183`) combines:

```ts
sort: [{ createdAt: 'asc' }],   // #55 — deliberate: callers .reverse() to prefer newest
size: 10000,                    // QRM5-005 — result-size safety cap
```

OpenSearch evaluates `sort` **before** `size` truncation, so at >10,000 documents in one `(scope, id)` partition the response window pins to the *oldest* end of the timeline. `BootstrapContextService.applyBudget` (`apps/mcp-server/src/messaging/bootstrap-context.service.ts:101-102`) then reverses the survivors to "prefer newer" — but the genuinely newest items were never fetched. The bootstrap channel — the only context an agent receives without asking — would deliver the archive instead of the news, with no error, no warning, and every test green.

- **Latent, not hypothetical.** The append-only project scope grows monotonically (~330 records as of the #65 audit, no compaction); a busy conversation partition or a long-lived deployment crosses 10,000 eventually. Nothing fires at the boundary — recency quality silently inverts.
- **`size: 10000` is also the `index.max_result_window` default** — the cap cannot simply be raised without hitting the same ceiling server-side.
- **`getStats()` (`opensearch-store.ts:366`) shares the same 10,000-doc window** and under-reports at the same threshold.

### Secondary — upsert breaks insertion order (InMemory backend)

#55 documented the `getAll` contract ("items returned `createdAt`-ascending") and implemented it **only on the OpenSearch side**, on the reasoning that `InMemoryStore`'s `Map` insertion order already satisfies it. That holds only for insert-only workloads: `InMemoryStore.set()` (`apps/mcp-server/src/context-store/in-memory-store.ts:143`) on an existing key overwrites the value (fresh `createdAt`) while the `Map` keeps the key's original position. One overwrite of an old key makes iteration order ≠ `createdAt` order, and the same "prefer newest" reversal misorders. Unlike the cap defect, this one does not need scale — a single upsert triggers it.

### Why this seam was never ticketed

The defect is an emergent property of four individually reasonable development cycles, none of which owns it:

1. **QRM1-002** — `InMemoryStore` iterates a `Map`; chronological ordering is an *accident* of insertion, never a designed promise.
2. **QRM4-002** — `BootstrapContextService` adds `.reverse()` to "prefer newer", silently depending on the accident.
3. **QRM5-005** — `OpenSearchStore` lands with `size: 10000` (arbitrary `_doc` order breaks the silent assumption; the cap is reasoned about only as result-size safety — "context stores are small").
4. **#55 / PR #57** — repairs the ordering deliberately: `sort: createdAt asc`, documented as a contract, comment left right beside the cap.

No ticket in the chain reasons about the cap-vs-truncation interaction; #55's own problem statement quotes `size: 10000` verbatim and never remarks on it. The bug lives in the *seam between* QRM5-005's cap and #55's ascending sort — owned by neither.

### Origin of this ticket

The seam was identified during preparation of Article #2 of the ticket-driven-development series and then used as the subject of a controlled experiment: **twelve Quorum fleet runs against this exact defect** on scrubbed replicas of this repository (2×2 design: ticket library present/absent × the `opensearch-store.ts:175` #55 comment present/absent; 3 runs per arm). The fleet shipped a contract-safe fix in 6 of 12 runs; every miss fixed the visible InMemory bug and shipped the cap defect in a clean, tested, confident diff. None of those experiment fixes was ever merged here — **the defect is still live on `49-stabilization`** — hence this ticket, which finally gives the seam an owner in the library. Experiment record: `tickets/tmp/articles/02-ticket-library/` (local scratch) and the published article ("The Ticket Library and the 'Unknown Unknown' Problem").

## Design Context

`docs/context-store.md` and `libs/common/src/context-store/context-store.abstract.ts` document the #55 contract: `getAll` returns items `createdAt`-ascending; callers `.reverse()` to prefer newest. Every consumer — `applyBudget`, `context_query mode=get-all`, the summarization path — is built against oldest-first.

**That contract is the trap for any naive fix.** The obvious one-liner — flip the sort to `desc` so the cap keeps the newest — cures the truncation and quietly regresses the system around it: the consumer's `.reverse()` would now *prefer the oldest* entries, the very symptom the fix targets. Whoever fixes this must reconcile the cap with the contract, not just move the window.

## Implementation Details

Two fix archetypes were validated by the experiment runs (both contract-aware; the second is the minimal one):

1. **Contract-preserving (recommended).** In `OpenSearchStore.getAll()` query `sort: [{ createdAt: 'desc' }]` with the cap — so truncation drops the *oldest* tail — then **reverse the hits in memory before building the result Record**, returning `createdAt`-ascending as documented. Public contract and every consumer untouched. Optional hardening seen in the deepest runs: a secondary `_id` sort key for same-millisecond determinism, a `logger.warn` when `hits.length === size` (cap reached), and hoisting `10000` into a named constant shared with `getStats`.
2. **Contract-redefining.** Flip to newest-first end-to-end: `desc` in both backends, remove the consumer `.reverse()`, rewrite the contract JSDoc/docs. Correct but touches every consumer; only worth it if newest-first is independently desirable.

For the secondary defect, either sort explicitly on read (`InMemoryStore.getAll()` sorts collected items by `createdAt` ascending) or restore write-recency on upsert (`delete` + `set` so a re-written key moves to the Map tail). Sorting on read is the more robust invariant — it holds regardless of future write paths.

In all cases: cover both backends (parity is part of the #55 contract), add regression tests for (a) cap-window recency under >cap document counts (mock the client; assert the query shape + internal reverse) and (b) in-memory upsert followed by `getAll` returning `createdAt`-ascending.

## Acceptance Criteria

1. - [ ] `OpenSearchStore.getAll()` returns the **newest** ≤10,000 items per partition while still returning them `createdAt`-ascending (contract preserved), or the contract is explicitly redefined everywhere in the same change.
2. - [ ] `InMemoryStore.getAll()` returns `createdAt`-ascending order even after upserts of existing keys.
3. - [ ] `getStats()` cap behavior reviewed; at minimum the shared `10000` window is named and its truncation documented.
4. - [ ] Unit tests pin the query shape (sort direction + size) and the post-fetch ordering on both backends.
5. - [ ] `npm run build`, `npm run lint`, `npm run test` pass with no regressions.

## Dependencies and References

- Direct ancestors of the seam: [QRM1-002](QRM1-002-context-store-in-memory.md) (accidental order) → [QRM4-002](QRM4-002-bootstrap-context-assembly-service.md) (`.reverse()` dependency) → [QRM5-005](QRM5-005-opensearch-store.md) (the cap) → [#55](55-bootstrap-getall-recency-ordering.md) (the ascending contract).
- [#56](56-bootstrap-budget-sizing.md) — bootstrap budget sizing (the consumer whose recency quality this defect inverts).
- [#70](70-bootstrap-task-aware-context-selection.md) — task-aware bootstrap selection (replaces the `getAll` + recency bin-pack on the primary path; see Resolution).
- Epic: [#49 QRM9 Stabilization](49-stabilization/49-stabilization.md), design-conclusion #4.
- Code: `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` (`getAll`, `getStats`), `apps/mcp-server/src/context-store/in-memory-store.ts` (`set`, `getAll`), `apps/mcp-server/src/messaging/bootstrap-context.service.ts` (`applyBudget`).

## Out of Scope

- Relevance-ranked bootstrap selection — [#70](70-bootstrap-task-aware-context-selection.md).
- Store compaction / data hygiene for the append-only project scope (reduces exposure but does not fix the seam).
- Pagination (`search_after` / PIT) for partitions legitimately larger than 10,000 — a valid deeper fix, but not required to restore recency correctness at the current design point.

## Resolution *(added at closure)*

**Status:** Closed without implementation — superseded by [#70](70-bootstrap-task-aware-context-selection.md)

**Date:** 2026-07-06

Reviewed against the existing chain (#55 → #56 → #70) before dispatching any fix work:

- **#70 dissolves the primary defect at its consumption site.** The bootstrap project-scope path — the one place where the cap × sort truncation has production consequences — stops flowing through `getAll` + recency bin-pack entirely: selection moves to `ContextStore.search()` (relevance-ranked, scope-filtered, token-budgeted), which never requests a 10,000-doc window. Fixing the `getAll` window ordering first would be immediately mooted work; the correct sequencing is to land #70 and let the recency path become the fallback it is specified to be.
- **What #70 does *not* cover (carried forward, not lost):**
  1. **The recency fallback path keeps the seam.** When `searchQuery` is absent or `search()` degrades, #70 falls back to `getAll` + recency — at >10,000 docs per partition that fallback still delivers the archive, not the news. Acceptable exposure: the fallback is the exception path, conversation partitions are `correlationId`-bounded (small), and the cap-window hardening (desc-fetch + internal reverse, warn-at-cap, named constant shared with `getStats`) remains available in this ticket's Implementation Details if the fallback is ever promoted back to a primary path.
  2. **The `InMemoryStore` upsert-ordering defect is untouched by #70** and needs no scale to trigger. It is a real contract violation on the dev/test backend (one upsert of an existing key breaks `createdAt`-ascending iteration). If it starts biting (flaky recency-dependent tests, misleading local-dev bootstraps), it warrants its own small standalone fix — sort-on-read in `InMemoryStore.getAll()` — referencing this ticket as the spec.
- **Why the ticket merges anyway:** the library is an implementation timeline, and this seam spent four development cycles (QRM1-002 → QRM4-002 → QRM5-005 → #55) plus twelve experiment runs un-owned. This record is the owner: the next investigation that lands on `sort: 'asc'` next to `size: 10000` — or on a `Map`-order assumption — should find the interaction, the trap, and the validated fix shapes in one keyword search, whatever has happened to #70 by then.

Acceptance criteria left unchecked deliberately — they describe the fix this ticket specifies, which was discharged to #70's approach rather than implemented here.
