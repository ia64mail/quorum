# QRM5-005: OpenSearchStore — Hybrid Context Store

## Summary

Implement `OpenSearchStore`, a new `ContextStore` backend that replaces `InMemoryStore` for production use. The store implements the same abstract class contract — `set()`, `get()`, `getAll()`, `search()`, `getStats()` — backed by OpenSearch for persistence, BM25 full-text search, and k-NN vector similarity. This is the core deliverable of the QRM5 milestone: the store that makes hybrid search available to all agents through the existing MCP tool contract with zero interface changes.

## Problem Statement

The current `InMemoryStore` has two fundamental limitations:

1. **Search quality** — case-insensitive AND-substring matching on `JSON.stringify(value)` fails for semantic intent. An agent searching "how do agents receive context on startup" won't match records about bootstrap context injection because no single record contains all those substrings. Evidence from QRM4 session reports: 7 consecutive multi-word query misses (Run 10), 62% of tool calls spent on file reads (Run 5), AND-semantics too strict for synonym/inflection variation.

2. **Persistence** — `InMemoryStore` is backed by a `Map<string, ContextItem>` with file-based persistence to `quorum.context`. This is fragile — data can be lost on crash, there's no indexing, and search degrades linearly with corpus size.

`OpenSearchStore` solves both: OpenSearch provides BM25 full-text search (Lucene-grade) and k-NN vector search (HNSW via Faiss) with declarative hybrid fusion via the `hybrid-search` pipeline created by QRM5-002. Records are BM25-searchable immediately on write; vector embeddings are computed asynchronously by the embedding pipeline (QRM5-006) and make records hybrid-searchable within ~300ms.

**Why this ticket is the critical path:** All downstream QRM5 tickets (QRM5-006 pipeline, QRM5-007 migration, QRM5-008 tests, QRM5-009 config/docs) depend on the store implementation. The three infrastructure tickets (QRM5-002, QRM5-003, QRM5-004) were sequenced to unblock this work.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D2 (Unified Hybrid Store):** OpenSearch serves as both the primary Context Store backend and the hybrid search engine — no separate `EmbeddingIndex`, no sync problem between parallel stores. `OpenSearchStore` replaces `InMemoryStore` in production; the swap is config-driven (`useClass` in the module provider).
- **D8 (Hybrid Search Pipeline):** The `hybrid-search` pipeline (created by QRM5-002's `OpenSearchSetupService`) combines BM25 and k-NN scores with weights [0.3 BM25, 0.7 vector]. The store's `search()` method references this pipeline by name.
- **D9 (Backward Compatibility):** `InMemoryStore` remains for unit tests and local dev without Docker. The `ContextStore` abstract class is unchanged — `OpenSearchStore` implements the same contract. All MCP tools work without changes.
- **D6 (Embedding Text Renderer):** The store's `set()` method calls `toEmbeddingText(item)` synchronously to produce the `embeddingText` field indexed into OpenSearch for BM25 search.
- **D7 (One Record, One Embedding):** No sub-chunking. One record → one `embeddingText` → one `embedding` vector.

### How this fits the existing architecture

The store lives at `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts`, alongside the existing `OpenSearchSetupService` and `OpenSearchModule` from QRM5-002. It extends `ContextStore` (the abstract class at `libs/common/src/context-store/context-store.abstract.ts`) and is wired via `useClass` in `ContextStoreModule`.

**Dependency injection chain:**
- `OpenSearchSetupService` (QRM5-002) provides the OpenSearch `Client` instance via `getClient()`
- `EmbeddingService` (QRM5-003) provides `embedQuery()` for search-time query embedding and `isAvailable()` for graceful degradation
- `toEmbeddingText()` (QRM5-004) is a pure function import from `@app/common` — no DI needed
- `CompositeKeyBuilder` (existing) provides the document ID scheme
- `EventEmitter2` emits `'context.change'` events (same pattern as `InMemoryStore`)

### Integration surface from completed tickets

**From QRM5-002 (OpenSearch Infrastructure):**
- `OpenSearchSetupService.getClient()` → returns `@opensearch-project/opensearch` `Client` instance
- Index `quorum-context` with mapping: `key` (keyword), `scope` (keyword), `id` (keyword), `value` (object, enabled:false), `createdBy` (keyword), `createdAt` (long), `expiresAt` (long), `embeddingText` (text, standard analyzer), `embedding` (knn_vector, 1024d, HNSW/Faiss/cosine)
- Pipeline `hybrid-search` with min-max normalization and arithmetic_mean combination (weights [0.3, 0.7])
- Config: `opensearchConfig.KEY` → `{ node, index, username, password }`

**From QRM5-003 (Ollama Embedding Service):**
- `EmbeddingService.embedQuery(text)` → `Promise<number[] | null>` — prepends mxbai-embed-large instruction prefix, returns null on failure
- `EmbeddingService.isAvailable()` → `Promise<boolean>` — checks Ollama health
- Import via `EmbeddingModule` which exports `EmbeddingService`

**From QRM5-004 (Text Renderer):**
- `toEmbeddingText(item: ContextItem)` → `string` — pure function, import from `@app/common`
- Produces the `embeddingText` field for BM25 indexing
- Truncates at 1500 chars (~500 BERT tokens) with `[truncated]` marker

## Implementation Details

### 1. Store class (`apps/mcp-server/src/context-store/opensearch/opensearch-store.ts`)

An `@Injectable()` class extending `ContextStore`. This is the primary deliverable.

**Constructor dependencies:**
- `OpenSearchSetupService` — inject to access the OpenSearch client via `getClient()`
- `EmbeddingService` — inject for search-time query embedding
- `EventEmitter2` — inject for `'context.change'` event emission
- `@Inject(opensearchConfig.KEY) config` — inject for index name

Store the `Client` reference from `setupService.getClient()` during construction and use it for all OpenSearch operations.

### 2. Method implementations

#### `set(params: SetParams): Promise<void>`

Write path (from roadmap §Write Path):

1. Build a `ContextItem` from `SetParams` — same field construction as `InMemoryStore.set()` (key, value, scope, id, createdBy, createdAt, expiresAt from ttl)
2. Compute `embeddingText` via `toEmbeddingText(item)` (synchronous, from `@app/common`)
3. Build the composite key via `CompositeKeyBuilder.build(scope, key, id)` — this is the OpenSearch document `_id`
4. Index the document to OpenSearch with `refresh: 'true'`:
   ```typescript
   client.index({
     index: this.config.index,
     id: compositeKey,
     body: { ...item, embeddingText },
     refresh: 'true',
   })
   ```
   `refresh: 'true'` makes the record BM25-searchable within the same request cycle
5. Emit `'context.change'` event with action `'set'` (same pattern as `InMemoryStore.emitChange()`)

**Note:** The `embedding` vector field is NOT set during `set()`. It is computed asynchronously by the Embedding Pipeline (QRM5-006) and partial-updated into the document later. Records are immediately BM25-searchable; they become hybrid-searchable once the vector arrives.

**Error handling:** Wrap the OpenSearch index call in try/catch. Log errors but do not throw — maintain the same graceful degradation pattern established in QRM5-002.

#### `get(scope: ContextScope, key: string, id?: string): Promise<unknown>`

1. Build composite key via `CompositeKeyBuilder.build(scope, key, id)`
2. Fetch the document by ID: `client.get({ index, id: compositeKey })`
3. If not found (404 / `response_exception`), return `undefined`
4. Extract the document `_source` and check TTL: if `expiresAt` is set and `Date.now() >= expiresAt`, lazily delete the document, emit `'context.change'` with action `'expire'`, and return `undefined`
5. Return `_source.value`

**Error handling:** Catch OpenSearch "not found" errors specifically (status 404 or `response_exception` with `not_found` reason). Other errors should be logged and propagated or degraded gracefully.

#### `getAll(scope: ContextScope, id?: string): Promise<Record<string, unknown>>`

1. Build the prefix filter: `scope` must match, `id` must match (or `_` for project scope)
2. Query OpenSearch with a `bool` filter:
   ```
   filter: [
     { term: { scope: scope } },
     { term: { id: id ?? '_' } },
     TTL filter (see below)
   ]
   ```
3. Use `scroll` or `size: 10000` (context stores are small, <1000 items per scope) to retrieve all matching documents
4. Build the result `Record<string, unknown>` mapping each item's `key` to its `value`

**TTL filter:** Include a `bool` should/must_not filter that matches documents where either `expiresAt` does not exist OR `expiresAt > Date.now()`:
```
{ bool: { should: [
  { bool: { must_not: { exists: { field: 'expiresAt' } } } },
  { range: { expiresAt: { gt: Date.now() } } }
] } }
```

#### `search(scope: ContextScope, query: string, id?: string, maxTokens?: number): Promise<ContextItem[]>`

This is the hybrid search implementation — the central feature of QRM5.

Search path (from roadmap §Search Path):

1. **Embed the query** via `EmbeddingService.embedQuery(query)` — returns `number[] | null`
2. **Build the hybrid query:**
   - If embedding is available (non-null): construct a hybrid query with both BM25 and k-NN legs
   - If embedding is null (Ollama unavailable): fall back to BM25-only query

**Hybrid query structure:**

```typescript
{
  _source: { excludes: ['embedding', 'embeddingText'] },
  query: {
    hybrid: {
      queries: [
        // BM25 leg
        {
          bool: {
            must: { match: { embeddingText: query } },
            filter: scopeAndTtlFilter
          }
        },
        // k-NN leg
        {
          knn: {
            embedding: {
              vector: queryEmbedding,
              k: resultSize,
              filter: scopeAndTtlFilter
            }
          }
        }
      ]
    }
  },
  search_pipeline: 'hybrid-search'
}
```

**BM25-only fallback:**

```typescript
{
  _source: { excludes: ['embedding', 'embeddingText'] },
  query: {
    bool: {
      must: { match: { embeddingText: query } },
      filter: scopeAndTtlFilter
    }
  }
}
```

3. **Scope + TTL filter** (shared between both legs):
   - `{ term: { scope: scope } }`
   - `{ term: { id: id ?? '_' } }` — scope identity filter
   - TTL filter: same `should` clause from `getAll()` (not expired OR no expiry)

4. **Token budget:** Iterate through results, accumulating `Math.ceil(JSON.stringify(hit._source.value).length / 4)` per item. Stop when the budget is exhausted. This matches `InMemoryStore`'s token estimation.

5. **Exclude large fields from results:** Use `_source: { excludes: ['embedding', 'embeddingText'] }` to avoid transferring the 1024-dim vector and rendered text back to the application — they're not needed in the response.

6. **Result mapping:** Map OpenSearch hits to `ContextItem` objects for the return type.

**Error handling:** If the OpenSearch query fails, log the error and return an empty array — same pattern as `InMemoryStore` returning empty results on failure.

#### `getStats(scope?: ContextScope, id?: string): Promise<ContextStats>`

1. Build a query filtering by scope/id/TTL (like `getAll` but using an aggregation)
2. Use OpenSearch `count` API for `itemCount`
3. For `estimatedTokens`, either:
   - Fetch all matching `value` fields and sum `Math.ceil(JSON.stringify(value).length / 4)` per item (consistent with `InMemoryStore`)
   - Or use a scripted metric aggregation in OpenSearch

The simpler approach (fetch values and sum client-side) is recommended for consistency with `InMemoryStore` and given the small corpus size. Use `_source: { includes: ['value'] }` to minimize transfer.

### 3. Context Store config extension (`apps/mcp-server/src/config/context-store.config.ts`)

Extend the existing `contextStoreConfig` with a `backend` field to control which implementation is used:

- **`backend`** — `CONTEXT_STORE_BACKEND` env var, default `'inmemory'`. Valid values: `'inmemory'`, `'opensearch'`.

The existing `contextStorePath` field remains for `InMemoryStore`. Add the `backend` field using Zod enum validation: `z.enum(['inmemory', 'opensearch'])`.

### 4. Conditional module wiring (`apps/mcp-server/src/context-store/context-store.module.ts`)

Update `ContextStoreModule` to conditionally select the `ContextStore` implementation based on `contextStoreConfig.backend`:

- When `backend === 'opensearch'`: import `OpenSearchModule` and `EmbeddingModule`, use `OpenSearchStore` as the `ContextStore` provider
- When `backend === 'inmemory'` (default): use `InMemoryStore` as today

The conditional wiring should use a dynamic module pattern or a factory provider:

```typescript
// Conceptual — exact pattern is implementation detail
{
  provide: ContextStore,
  useFactory: (config, ...) => config.backend === 'opensearch'
    ? new OpenSearchStore(...)
    : new InMemoryStore(...),
  inject: [contextStoreConfig.KEY, ...]
}
```

**Important:** When `backend === 'inmemory'`, the `OpenSearchModule` and `EmbeddingModule` should NOT be imported — no unnecessary connections to OpenSearch/Ollama containers. This may require a `DynamicModule` approach via `forRoot()` or conditional `imports` in a factory.

### 5. Event emission

Follow the same `EventEmitter2` pattern as `InMemoryStore`:
- `set()` → emit `{ scope, key, id, action: 'set' }` on `'context.change'`
- Lazy TTL expiry (in `get()`) → emit `{ scope, key, id, action: 'expire' }` on `'context.change'`
- Future: `delete()` (not currently in abstract class but the event type supports it)

The `ChangeEvent` type is already defined in `libs/common/src/context-store/context-store.types.ts`.

### 6. Testing strategy

All tests mock the OpenSearch client and `EmbeddingService` — no real OpenSearch or Ollama connections.

**`opensearch-store.spec.ts`:**

Test categories:

**`set()` tests:**
- Indexes document with correct composite key as `_id`
- Includes `embeddingText` from `toEmbeddingText()` in indexed document
- Sets `refresh: 'true'` on index call
- Constructs `ContextItem` correctly (createdAt, expiresAt from TTL, createdBy, scope, id)
- Emits `'context.change'` event with action `'set'`
- Handles OpenSearch index failure gracefully (logs, does not throw)

**`get()` tests:**
- Returns value for existing document
- Returns `undefined` for missing document (404)
- Lazily expires and deletes TTL-expired documents
- Emits `'context.change'` event with action `'expire'` on lazy expiry

**`getAll()` tests:**
- Returns all non-expired items for scope/id
- Filters by scope and id correctly
- Excludes expired items via TTL filter
- Returns empty record when no items match

**`search()` tests:**
- Sends hybrid query when embedding is available
- Falls back to BM25-only when `EmbeddingService.embedQuery()` returns null
- Includes scope and TTL filters in query
- Respects token budget (stops accumulating when exceeded)
- References `'hybrid-search'` pipeline in hybrid query
- Returns empty array on OpenSearch query failure
- Excludes `embedding` and `embeddingText` from result `_source`

**`getStats()` tests:**
- Returns correct item count and estimated tokens
- Filters by scope/id when provided
- Returns aggregate stats when no scope specified

**`context-store.config.spec.ts` updates:**
- Returns default backend `'inmemory'` when no env var set
- Overrides backend from `CONTEXT_STORE_BACKEND`
- Validates backend enum (rejects invalid values)

### Key implementation conventions to follow

Based on QRM5-002, QRM5-003, and broader codebase patterns:

- **Extends abstract class:** `class OpenSearchStore extends ContextStore` — not `implements`, extends. Match `InMemoryStore` pattern.
- **Config injection:** `@Inject(opensearchConfig.KEY) private readonly osConfig: ConfigType<typeof opensearchConfig>` — use a distinct name from `contextStoreConfig` injection to avoid naming collision
- **Client access:** `this.setupService.getClient()` — call in constructor, store as `private readonly client: Client`
- **Composite keys:** Use `CompositeKeyBuilder.build()` and `CompositeKeyBuilder.parse()` from `@app/common` — same as `InMemoryStore`
- **Token estimation:** `Math.ceil(JSON.stringify(value).length / 4)` — match `InMemoryStore.estimateTokens()` exactly
- **Event emission:** `this.eventEmitter.emit('context.change', event)` — same as `InMemoryStore.emitChange()`
- **Logging:** `new Logger(OpenSearchStore.name)` — meaningful messages for search mode (hybrid vs BM25-only), degradation events
- **Error handling:** Graceful degradation. Log errors, never throw to callers. Return sensible defaults (undefined, empty array, zero stats).
- **No `.js` extensions** in imports (webpack handles resolution)
- **`import type`** for type-only imports

## Acceptance Criteria

- [ ] `OpenSearchStore` class exists at `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts`
- [ ] `OpenSearchStore` extends `ContextStore` abstract class
- [ ] `set()` builds a `ContextItem`, computes `embeddingText` via `toEmbeddingText()`, indexes to OpenSearch with composite key as document `_id` and `refresh: 'true'`
- [ ] `set()` emits `'context.change'` event with action `'set'`
- [ ] `set()` does NOT compute or set the `embedding` vector (deferred to QRM5-006 pipeline)
- [ ] `get()` retrieves document by composite key, returns `undefined` for missing documents
- [ ] `get()` performs lazy TTL expiration — deletes expired documents and emits `'context.change'` with action `'expire'`
- [ ] `getAll()` queries OpenSearch with scope/id filter and TTL filter, returns `Record<string, unknown>`
- [ ] `search()` sends a hybrid query (BM25 + k-NN) through the `'hybrid-search'` pipeline when embedding is available
- [ ] `search()` falls back to BM25-only query when `EmbeddingService.embedQuery()` returns null
- [ ] `search()` includes scope, id, and TTL filters
- [ ] `search()` respects the `maxTokens` budget using `Math.ceil(JSON.stringify(value).length / 4)` estimation
- [ ] `search()` excludes `embedding` and `embeddingText` fields from returned `_source`
- [ ] `getStats()` returns correct `itemCount` and `estimatedTokens` with optional scope/id filter
- [ ] `contextStoreConfig` extended with `backend` field (`'inmemory'` | `'opensearch'`, default `'inmemory'`)
- [ ] `ContextStoreModule` conditionally wires `OpenSearchStore` or `InMemoryStore` based on `backend` config
- [ ] When `backend === 'inmemory'`, `OpenSearchModule` and `EmbeddingModule` are NOT imported
- [ ] `OpenSearchStore` handles OpenSearch failures gracefully (logs error, returns sensible defaults)
- [ ] Unit tests for `OpenSearchStore`: set (6+), get (4+), getAll (4+), search (7+), getStats (3+) — all with mocked OpenSearch client and EmbeddingService
- [ ] Unit tests for `contextStoreConfig` backend field (default, override, validation)
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test` — baseline: 45 suites, 662 tests)

## Dependencies and References

- **Depends on:**
  - QRM5-002 (OpenSearch Infrastructure) ✅ — provides `OpenSearchSetupService`, index mapping, hybrid pipeline
  - QRM5-003 (Ollama Embedding Service) ✅ — provides `EmbeddingService` for search-time query embedding
  - QRM5-004 (Embedding Text Renderer) ✅ — provides `toEmbeddingText()` for write-time text rendering
- **Blocks:**
  - QRM5-006 (Async Embedding Pipeline) — needs the store to enqueue embedding work
  - QRM5-007 (Data Migration & Agent Prompt Guidelines) — needs the store for migration target
  - QRM5-008 (Integration Tests) — needs the store for end-to-end test scenarios
  - QRM5-009 (Config & Docs) — needs the store for configuration documentation
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**

| File | Relevance |
|------|-----------|
| `libs/common/src/context-store/context-store.abstract.ts` | Abstract class to extend — `set()`, `get()`, `getAll()`, `search()`, `getStats()` |
| `libs/common/src/context-store/context-store.types.ts` | `ContextItem`, `SetParams`, `ContextStats`, `ChangeEvent`, `ContextScope` |
| `libs/common/src/context-store/composite-key-builder.ts` | `CompositeKeyBuilder.build()` / `.parse()` for document ID scheme |
| `libs/common/src/context-store/to-embedding-text.ts` | `toEmbeddingText(item)` — produces `embeddingText` field for BM25 indexing |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Reference implementation — match behavior for `set()`, `get()`, `getAll()`, `getStats()`, event emission, TTL handling |
| `apps/mcp-server/src/context-store/context-store.module.ts` | Module to update with conditional `useClass` wiring |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` | `getClient()` for OpenSearch `Client` access, `extractErrorType()` pattern |
| `apps/mcp-server/src/context-store/opensearch/opensearch.module.ts` | Module providing `OpenSearchSetupService` |
| `apps/mcp-server/src/embedding/embedding.service.ts` | `embedQuery()`, `embedDocument()`, `isAvailable()` |
| `apps/mcp-server/src/embedding/embedding.module.ts` | Module exporting `EmbeddingService` |
| `apps/mcp-server/src/config/context-store.config.ts` | Extend with `backend` field |
| `apps/mcp-server/src/config/opensearch.config.ts` | Config for index name (`config.index`) |

**External references:**
- [OpenSearch Index Document API](https://opensearch.org/docs/latest/api-reference/document-apis/index-document/) — `PUT /{index}/_doc/{id}` with `refresh=true`
- [OpenSearch Get Document API](https://opensearch.org/docs/latest/api-reference/document-apis/get-documents/) — `GET /{index}/_doc/{id}`
- [OpenSearch Search API](https://opensearch.org/docs/latest/api-reference/search/) — `POST /{index}/_search`
- [OpenSearch Hybrid Search](https://opensearch.org/docs/latest/search-plugins/hybrid-search/) — hybrid query combining BM25 + k-NN
- [OpenSearch Delete Document API](https://opensearch.org/docs/latest/api-reference/document-apis/delete-document/) — for lazy TTL expiration
- [`@opensearch-project/opensearch` npm client](https://www.npmjs.com/package/@opensearch-project/opensearch) — JavaScript client API

**Architect review:** Not required. All design decisions for this ticket are resolved in the QRM5-000 roadmap: D2 (unified hybrid store), D8 (hybrid search pipeline), D9 (backward compatibility), D6 (text renderer), D7 (one record one embedding). The implementation is a contract implementation over infrastructure that already exists — no new architectural decisions are needed. The store follows the established `InMemoryStore` behavioral contract exactly, with the search strategy being the only intentional divergence (hybrid vs substring), which is fully specified in the roadmap's Write Path and Search Path sections.
