# QRM4-BUG-014: Context Store Search Mode Non-Functional

## Summary

`InMemoryStore.search()` uses `String.includes()` to match the full query as a contiguous substring, which means any multi-word query (e.g., `"QRM4 milestone"`) fails unless that exact phrase appears verbatim in the serialized item. In practice, agents always use multi-word natural-language queries, resulting in a **0% hit rate** across Runs 9 and 10 (0/7 in Run 10 alone). Agents have organically worked around the failure by falling back to `get-all`, but this returns all items unfiltered — a pattern that will degrade as the store grows past 50+ items.

## Problem Statement

The `search()` method in `apps/mcp-server/src/context-store/in-memory-store.ts:211` performs matching with:

```typescript
const searchable = `${item.key} ${serialized}`.toLowerCase();
if (searchable.includes(lowerQuery)) { ... }
```

`String.includes()` treats the query as a single contiguous substring. This works for single-token queries like `"postgresql"` or `"QRM4-003"` (as demonstrated by the passing test suite), but fails for multi-word queries that agents actually issue in production.

### Observed failures (Run 10)

| Agent | Query | Expected Matches | Returned |
|-------|-------|-----------------|----------|
| moderator | `"QRM4 milestone"` | `qrm4-status-report`, several `QRM4-*` items | **0** |
| teamlead | `"QRM4 bootstrap context design architecture"` | `QRM4-003-design-notes`, `QRM4-004-design-notes`, etc. | **0** |
| teamlead | `"QRM4 bootstrap context configuration documentation architecture"` | Multiple design/impl items | **0** |
| teamlead | `"architecture decisions testing conventions"` | Project-scope architectural decisions | **0** |
| teamlead | `"QRM4-006 configuration documentation"` | `QRM4-006-task-breakdown` | **0** |

Every `mode=search` query in Runs 9 and 10 returned 0 results.

### Why the tests don't catch this

All existing tests in `in-memory-store.spec.ts` (lines 303-381) use **single-word queries**: `"postgresql"`, `"Use"`, `"nonexistent-query"`, `"QRM4-003"`. These are contiguous substrings that `includes()` matches correctly. There are no tests for multi-word queries, which is the only form agents use in practice.

### Impact trajectory

At 42 items (current), `get-all` returns manageable payloads. At 100+ items (projected after 5-6 more milestones), returning all items forces agents to spend significant context window space parsing irrelevant data. The search mode exists precisely to avoid this — but it has never worked for real queries.

## Design Context

The `search()` method is documented as performing "case-insensitive substring match on `JSON.stringify(value)`" (see `docs/context-store.md`). The implementation does match case-insensitively, but the substring semantics are wrong for keyword search. Standard keyword search splits the query into terms and checks that all terms appear somewhere in the document (AND semantics), not that the entire query appears as one contiguous string.

The `context_query` tool handler in `mcp.service.ts:332-348` passes the query through unchanged — the bug is entirely in the store's matching logic, not in the MCP layer.

## Implementation Details

### Fix: split query into whitespace-delimited terms with AND semantics

In `apps/mcp-server/src/context-store/in-memory-store.ts`, replace the single `includes()` call with a term-based match. Split the query on whitespace, then require every term to appear somewhere in the searchable text.

Current (line 211):
```typescript
if (searchable.includes(lowerQuery)) {
```

Fixed:
```typescript
const terms = lowerQuery.split(/\s+/).filter(Boolean);
if (terms.length > 0 && terms.every((term) => searchable.includes(term))) {
```

This preserves the existing behavior for single-word queries (the `terms` array has one element, `every` checks it with `includes`) while fixing multi-word queries. The `filter(Boolean)` handles edge cases like leading/trailing whitespace or double spaces.

**Empty query edge case:** If `query` is empty or whitespace-only, `terms` will be empty after filtering. `terms.every(...)` returns `true` for an empty array (vacuous truth), which would match everything. The `terms.length > 0` guard prevents this — an empty query returns no results, matching current behavior.

### Test additions

Add tests to `in-memory-store.spec.ts` in the existing `describe('search')` block:

1. **Multi-word query matches** — store items with keys like `qrm4-status-report` and values containing `"milestone"`, search for `"QRM4 milestone"`, expect matches
2. **All terms must match (AND semantics)** — search for `"QRM4 nonexistent"`, expect 0 results (the second term doesn't match)
3. **Terms across key and value** — store an item where one term matches the key and another matches the serialized value, verify both contribute to the match
4. **Whitespace handling** — queries with leading/trailing spaces or multiple spaces between terms should work identically to trimmed single-space queries
5. **Empty/whitespace-only query** — should return 0 results

### Files to modify

| File | Change |
|------|--------|
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Replace `includes(lowerQuery)` with term-based AND matching (~2 lines) |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | Add 5 test cases for multi-word search behavior |

## Acceptance Criteria

- [ ] `InMemoryStore.search()` splits multi-word queries into whitespace-delimited terms
- [ ] All terms must match somewhere in the searchable text (AND semantics)
- [ ] Single-word queries continue to work identically (no regression)
- [ ] Empty or whitespace-only queries return 0 results
- [ ] New test: multi-word query matches items where terms appear across key and value
- [ ] New test: partial term match (not all terms present) returns 0 results
- [ ] New test: whitespace variations (leading, trailing, multiple spaces) are handled
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` — all existing tests pass, no regressions

## Dependencies and References

- **Root cause location:** `apps/mcp-server/src/context-store/in-memory-store.ts:211`
- **MCP handler (no changes needed):** `apps/mcp-server/src/mcp/mcp.service.ts:332-348`
- **Existing tests:** `apps/mcp-server/src/context-store/in-memory-store.spec.ts:303-381`
- **Documentation:** `docs/context-store.md` — search method behavior description (accurate after fix)
- **Observed in:** Run 9 (BUG-012 session), Run 10 (`logs/sessions/2026-04-10-qrm4-run10.md`) — 0/7 search hit rate
- **Session report analysis:** Run 10 report, "Context Store Deep Dive → Search Mode Failure: 0/7 Hit Rate"
- **Future enhancement:** The `docs/context-store.md` roadmap lists OpenSearch backend with BM25 full-text search as a future enhancement. This fix addresses the POC-phase keyword search; the OpenSearch migration would replace it entirely with proper full-text + vector search.