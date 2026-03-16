# QRM2-BUG-006: Context Store Project-Scope Key Mismatch

## Summary

Project-scope context items are stored with the invocation's `correlationId` baked into the composite key, but all read operations (get, getAll, search, getStats) build keys with `_` as the id placeholder for project scope. This makes project-scope data unreachable through normal queries despite being present in the store.

## Problem Statement

When an agent calls `context_store` with `scope: "project"`, the MCP tool handler passes `correlationId` as the `id` parameter to `InMemoryStore.set()`. The composite key becomes:

```
project:{correlationId}:keyname     ← what gets stored
```

But all read paths build the composite key as:

```
project:_:keyname                   ← what gets queried
```

The result: project-scope items are written successfully but can never be read back — they're orphaned in the store. The only way to detect them is `getStats()` with no scope filter (which iterates all entries without prefix matching).

### Observed behavior (E2E, 2026-03-15)

1. Architect stored `context-persistence-test` at project scope → success
2. Moderator queried same key at project scope → not found
3. `getStats()` with no scope → 2 items, ~111 tokens (data exists)
4. `getStats("project")` → 0 items (prefix `project:_:` doesn't match)
5. Persisted file (`quorum.context`) confirms keys contain correlationIds:
   - `project:b723d835-...:context-persistence-test`
   - `project:07666da2-...:context-persistence-test`

### Root cause

Two cooperating defects:

1. **`mcp.service.ts` — `context_store` tool handler**: Passes `args.correlationId` as `id` unconditionally, including for project scope where `id` should be `undefined`.
2. **`InMemoryStore.compositeKey()`**: Accepts any `id` without validating against scope rules. Project scope should never include an id — it's meant to be globally accessible.

Neither layer enforces the invariant that **project-scope keys must not contain an id**.

## Design Context

The Context Store defines three scopes with different keying semantics (see `docs/context-management.md`):

| Scope | Key format | `id` meaning |
|-------|-----------|--------------|
| **project** | `project:_:key` | None — global |
| **conversation** | `conversation:{correlationId}:key` | correlationId |
| **agent** | `agent:{agentId}:key` | agentId |

The composite key format `${scope}:${id ?? '_'}:${key}` lives as a private method in `InMemoryStore`. Future backends (PostgreSQL, OpenSearch) will need the same keying logic, making this a candidate for shared infrastructure.

## Implementation Details

### Approach: Extract a shared `CompositeKeyBuilder`

Create a small utility in `libs/common/src/context-store/` that centralizes composite key construction with scope-aware rules. This fixes the immediate bug while providing defense-in-depth against similar misuse in future backends.

**Key rules enforced by the builder:**
- **Project scope**: `id` is always stripped → `project:_:key`
- **Conversation scope**: `id` required (throw if missing) → `conversation:{id}:key`
- **Agent scope**: `id` required (throw if missing) → `agent:{id}:key`

The builder should expose:
- `build(scope, key, id?)` — constructs composite key with scope rules
- `parse(compositeKey)` — decomposes back to `{ scope, id, key }` (useful for debugging/logging)

### Changes required

1. **`libs/common/src/context-store/composite-key-builder.ts`** — New utility with `build()` and `parse()` methods, plus unit tests
2. **`libs/common/src/context-store/index.ts`** — Re-export the builder
3. **`apps/mcp-server/src/context-store/in-memory-store.ts`** — Replace private `compositeKey()` with imported builder
4. **`apps/mcp-server/src/mcp/mcp.service.ts`** — Fix `context_store` tool handler: don't pass `id` for project scope (belt-and-suspenders with the builder)

### Why not just fix the tool handler?

Fixing only the tool handler (`mcp.service.ts`) would resolve the immediate symptom but leave `compositeKey()` as a footgun for future backends and callers. The builder approach:
- Prevents the same class of bug in OpenSearchStore or PostgreSQL backends
- Makes the key format testable independently of any storage backend
- Documents the scope→key invariants in code rather than just convention

## Acceptance Criteria

- [x] Project-scope items stored without `id` in composite key (`project:_:key`)
- [x] Project-scope items retrievable via `get()`, `getAll()`, `getStats()`, and `search()`
- [x] Conversation/agent scope items still require and use `id`
- [x] `CompositeKeyBuilder` lives in `libs/common` and is reusable by future backends
- [x] `CompositeKeyBuilder` has unit tests covering all scope rules and edge cases
- [x] Existing `InMemoryStore` tests pass (no regressions)
- [x] New tests verify the fixed tool handler behavior

## Dependencies and References

- **Introduced by**: QRM2-011 (context store file persistence) — the persistence itself works; the bug is in key construction
- **Related docs**: `docs/context-management.md` (scope definitions), `docs/context-store.md` (composite key format)
- **Affected files**: `apps/mcp-server/src/mcp/mcp.service.ts`, `apps/mcp-server/src/context-store/in-memory-store.ts`

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-15

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/context-store/composite-key-builder.ts` | Created | Static `build()` and `parse()` methods with scope-aware key rules |
| `libs/common/src/context-store/composite-key-builder.spec.ts` | Created | 10 tests covering build rules, parse roundtrips, error cases |
| `libs/common/src/context-store/index.ts` | Modified | Re-export `CompositeKeyBuilder` |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Modified | Replaced inline `compositeKey()` with `CompositeKeyBuilder.build()` |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | Modified | Updated 3 tests that relied on the old lenient behavior (no-id for conversation/agent) |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Modified | Fixed `context_store`, `context_query`, and `context_stats` handlers to strip `id` for project scope |

### Deviations from Ticket Spec

- **Also fixed `context_query` and `context_stats` read handlers.** The ticket only called out `context_store` (write path), but the read handlers in `context_query` and `context_stats` had the same pattern of passing `args.correlationId` without scope-checking. While reads were less likely to hit the bug (project-scope reads rarely have a correlationId), fixing them provides consistency and prevents future issues.

### Verification

- `npm run build` — all 4 apps compile successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 441 tests passing (10 new + 431 existing)