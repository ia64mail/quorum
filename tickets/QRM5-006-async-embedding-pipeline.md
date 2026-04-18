# QRM5-006: Async Embedding Pipeline

## Summary

Implement a background service that computes embeddings for newly written Context Store records and updates OpenSearch with the vector. The pipeline bridges the write-time gap — `OpenSearchStore.set()` indexes documents with `embeddingText` for immediate BM25 search, and this pipeline asynchronously computes the embedding vector via Ollama to enable hybrid search (BM25 + k-NN) within ~150–300ms of the write. On startup, it backfills embeddings for any documents that lack them (e.g., after a container restart while Ollama was down).

## Problem Statement

`OpenSearchStore.set()` (QRM5-005) intentionally does NOT compute the embedding vector during the write path. This is a deliberate design choice: embedding computation takes ~150–300ms per record via Ollama, and blocking the write path would add unacceptable latency to every `context_store` MCP tool call. Instead, `set()` indexes the record with `embeddingText` (making it immediately BM25-searchable) and defers vector computation to an async pipeline.

Without this pipeline:
- Records are only BM25-searchable, never hybrid-searchable — the 0.7-weighted k-NN leg of the hybrid pipeline has no vectors to work with
- The hybrid search design (D8) is effectively reduced to BM25-only permanently
- The full value of the Ollama embedding infrastructure (QRM5-003) is unrealized

The pipeline also addresses the cold-start problem: when the MCP server restarts and Ollama was previously unavailable, some records may exist without embeddings. The startup backfill ensures all records eventually receive vectors.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D2 (Unified Hybrid Store):** OpenSearch is the single storage backend. The pipeline reads `embeddingText` from and writes `embedding` vectors back to the same index — no sync problem between separate stores.
- **D7 (One Record, One Embedding):** No sub-chunking. The pipeline computes one vector per record from the pre-rendered `embeddingText` field.
- **D3 (Embedding Model):** `mxbai-embed-large` via Ollama. The pipeline uses `EmbeddingService.embedDocument()` which passes text as-is (no query prefix) — document-side of the asymmetric embedding.

### How this fits the write path

From the roadmap's Write Path:
```
set(params: SetParams)
  │
  ├─ sync ─── build ContextItem from params
  ├─ sync ─── compute embeddingText via toEmbeddingText(item)
  ├─ sync ─── index to OpenSearch: { ...item, embeddingText }  [refresh=true]
  │            → BM25-searchable immediately
  ├─ sync ─── emit 'context.change' event
  │
  └─ async ── enqueue embedding computation → Ollama          ← THIS TICKET
                 on completion: partial update OpenSearch doc with embedding vector
                 → hybrid search active for this record
```

The pipeline subscribes to `'context.change'` events (emitted by `OpenSearchStore.set()`) and triggers async embedding for each `set` action. This is the established NestJS event-driven pattern — `@OnEvent('context.change')` — documented in the codebase since QRM1-002 but not yet implemented by any consumer. The pipeline is the first real subscriber.

### Integration surface from completed tickets

**From QRM5-005 (OpenSearchStore):**
- Emits `ChangeEvent` with `{ scope, key, id, action: 'set' }` on every `set()` call via `EventEmitter2`
- Documents are indexed with `embeddingText` field (from `toEmbeddingText()`) but without `embedding` vector
- Document `_id` is the composite key: `CompositeKeyBuilder.build(scope, key, id)`
- `ContextStoreModule.forRoot()` is the DynamicModule that wires the opensearch branch (imports `OpenSearchModule`, `EmbeddingModule`, `EventEmitterModule`)

**From QRM5-003 (Ollama Embedding Service):**
- `EmbeddingService.embedDocument(text)` → `Promise<number[] | null>` — embeds text as-is (document-side asymmetry), returns `null` on failure (graceful degradation)
- `EmbeddingService.isAvailable()` → `Promise<boolean>` — Ollama health check for circuit-breaker pattern

**From QRM5-002 (OpenSearch Infrastructure):**
- `OpenSearchSetupService.getClient()` → OpenSearch `Client` instance
- Index `quorum-context` with `embedding` field: `knn_vector`, 1024 dimensions, HNSW/Faiss/cosine
- Partial document updates supported via `client.update({ id, body: { doc: { embedding: vector } } })`

## Implementation Details

### 1. Pipeline service (`apps/mcp-server/src/embedding/embedding-pipeline.service.ts`)

An `@Injectable()` service implementing `OnModuleInit`. This is the core deliverable.

**Constructor dependencies:**
- `OpenSearchSetupService` — inject to access the OpenSearch client via `getClient()` for partial document updates and backfill queries
- `EmbeddingService` — inject for `embedDocument()` and `isAvailable()`
- `@Inject(opensearchConfig.KEY) config` — inject for the index name

Store the `Client` reference from `setupService.getClient()` during construction (same pattern as `OpenSearchStore`).

**Internal queue:**

A simple in-memory queue with sequential drain processing. Context stores are low-throughput (agents write 5–50 records per session), so a lightweight queue is sufficient — no need for a dedicated job framework.

```typescript
interface QueueItem {
  compositeKey: string;
  retryCount: number;
}

private readonly queue: QueueItem[] = [];
private processing = false;
```

The `processing` flag prevents concurrent drain cycles. When an item is enqueued, if no drain cycle is running, one starts. The drain loop processes items sequentially — dequeue, embed, update, next — until the queue is empty.

**Event handler:**

```typescript
@OnEvent('context.change')
handleContextChange(event: ChangeEvent): void {
  if (event.action !== 'set') return;
  const compositeKey = CompositeKeyBuilder.build(event.scope, event.key, event.id);
  this.enqueue(compositeKey);
}
```

Only react to `'set'` events — `'expire'` and `'delete'` events don't need embedding. The `ChangeEvent` type is imported from `@app/common`.

**Enqueue + drain:**

```typescript
private enqueue(compositeKey: string, retryCount = 0): void {
  this.queue.push({ compositeKey, retryCount });
  void this.drain();
}
```

The `drain()` method:
1. If already processing, return (the active loop will pick up new items)
2. Set `processing = true`
3. While queue is not empty:
   a. Shift an item from the front
   b. Call `processItem(item)`
4. Set `processing = false`

**Process item:**

For each queue item:
1. **Fetch the `embeddingText`** from OpenSearch: `client.get({ index, id: compositeKey, _source_includes: ['embeddingText'] })`. This retrieves only the `embeddingText` field — the pre-rendered text produced by `toEmbeddingText()` during `set()`.
2. **Compute the embedding**: `this.embeddingService.embedDocument(embeddingText)` — returns `number[] | null`
3. **If embedding is null (Ollama failure):** apply retry logic (see below)
4. **Partial-update the OpenSearch document**: `client.update({ index, id: compositeKey, body: { doc: { embedding: vector } } })`. This updates only the `embedding` field without reindexing the full document.
5. **Log success**: `this.logger.debug(`Embedded document [${compositeKey}]`)`

**Error handling and retry:**

- If `embedDocument()` returns `null` OR if the OpenSearch fetch/update throws:
  - If `item.retryCount < MAX_RETRIES` (constant = 3): re-enqueue with `retryCount + 1` after a delay
  - Delay uses exponential backoff: `Math.min(1000 * 2 ** retryCount, 8000)` ms (1s → 2s → 4s → max 8s)
  - Use `setTimeout` to schedule the re-enqueue — the drain loop continues processing other items in the meantime
  - If `item.retryCount >= MAX_RETRIES`: log a warning and abandon the item. The record remains BM25-searchable; the embedding can be recovered via the backfill mechanism on the next startup.

- If the OpenSearch `get` returns 404 (document was deleted between `set` and pipeline processing): log at debug level and skip — no error, no retry.

**Graceful degradation:**
- Before starting the drain loop (or at the top of `processItem`), check `EmbeddingService.isAvailable()`. If Ollama is down, log a warning once and pause the drain loop. Items remain in the queue. The next `'context.change'` event will trigger another `drain()` attempt.
- Alternatively, rely on `embedDocument()` returning `null` for each failed item and the retry mechanism to handle temporary unavailability. The simpler approach is recommended: just let `embedDocument()` return null and trigger retry/abandon logic naturally.

### 2. Startup backfill (`onModuleInit`)

On startup, query OpenSearch for documents that have `embeddingText` but lack `embedding`:

```typescript
async onModuleInit(): Promise<void> {
  await this.backfill();
}
```

**Backfill query:**

```typescript
const response = await this.client.search({
  index: this.config.index,
  body: {
    query: {
      bool: {
        must: { exists: { field: 'embeddingText' } },
        must_not: { exists: { field: 'embedding' } },
      },
    },
    size: 10000,   // Context stores are small
    _source: false, // Only need _id, not the full document
  },
});
```

For each hit, extract the `_id` (which is the composite key) and enqueue it. The drain loop then processes them sequentially using the same `processItem` flow.

**Why `_source: false`:** The backfill only needs document IDs. The `processItem` method fetches `embeddingText` individually per document, which is slightly less efficient than batch-fetching but reuses the exact same code path as event-driven embedding — keeping the logic unified and testable.

**Startup guard:** If OpenSearch or Ollama is unavailable at startup, log a warning and skip the backfill — the system starts in BM25-only mode. The backfill will run on the next restart when both services are available, or records will be embedded as they're next written (via the event-driven path).

### 3. Module wiring (`apps/mcp-server/src/context-store/context-store.module.ts`)

The `EmbeddingPipelineService` is provided in `ContextStoreModule.forRoot()` (opensearch branch) rather than in `EmbeddingModule`. This avoids coupling `EmbeddingModule` to `OpenSearchModule` — the embedding module stays focused on pure embedding (compute vectors from text) while the pipeline's orchestration concern (listen to events, fetch from OpenSearch, update OpenSearch) is wired at the integration layer.

Update the opensearch branch:

```typescript
if (backend === 'opensearch') {
  return {
    module: ContextStoreModule,
    imports: [
      EventEmitterModule.forRoot(),
      OpenSearchModule,
      EmbeddingModule,
    ],
    providers: [
      { provide: ContextStore, useClass: OpenSearchStore },
      EmbeddingPipelineService,  // ← added
    ],
    exports: [ContextStore],
  };
}
```

The pipeline has access to `OpenSearchSetupService` (from `OpenSearchModule`), `EmbeddingService` (from `EmbeddingModule`), and `EventEmitter2` (from `EventEmitterModule`) via the module's imports. The `opensearchConfig` is also available because `OpenSearchModule` imports `ConfigModule.forFeature(opensearchConfig)`.

**Note:** The roadmap suggests wiring the pipeline in `EmbeddingModule` (`apps/mcp-server/src/embedding/embedding.module.ts`). This ticket deviates because `EmbeddingModule` would need to import `OpenSearchModule` to provide the pipeline with a client — coupling the pure embedding layer to a specific storage backend. Wiring at `ContextStoreModule` (which already imports both) is architecturally cleaner and avoids the circular import concern. The file location (`embedding/embedding-pipeline.service.ts`) matches the roadmap — only the wiring point changes.

### 4. Testing strategy

All tests mock the OpenSearch client, `EmbeddingService`, and timer functions. No real OpenSearch, Ollama, or async delays in unit tests.

**`embedding-pipeline.service.spec.ts`:**

Test categories:

**Event handling:**
- Calls `enqueue` on `'context.change'` event with action `'set'`
- Ignores events with action `'expire'`
- Ignores events with action `'delete'`
- Builds correct composite key from event scope/key/id

**Processing:**
- Fetches `embeddingText` from OpenSearch by composite key
- Calls `EmbeddingService.embedDocument()` with the fetched text
- Partial-updates OpenSearch document with the embedding vector
- Skips documents that no longer exist in OpenSearch (404 on get)
- Processes queue items sequentially (not concurrently)

**Retry and error handling:**
- Re-enqueues with incremented `retryCount` when `embedDocument()` returns null
- Re-enqueues when OpenSearch update fails
- Abandons item after `MAX_RETRIES` (3) attempts with a warning log
- Uses exponential backoff delay for retries (mock `setTimeout` or use `jest.useFakeTimers()`)

**Startup backfill:**
- Queries OpenSearch for documents without `embedding` field on init
- Enqueues found document IDs for processing
- Handles empty result set (no documents need backfill)
- Handles OpenSearch unavailability at startup gracefully (logs warning, skips backfill)

**Graceful degradation:**
- Handles `EmbeddingService.embedDocument()` returning null (Ollama unavailable)
- Handles OpenSearch client errors during get/update

**Mocking approach:**
- Mock `OpenSearchSetupService.getClient()` to return a mock `Client` with `.get()`, `.update()`, `.search()` methods
- Mock `EmbeddingService` with `embedDocument()` and `isAvailable()`
- Use `jest.useFakeTimers()` for retry backoff delays
- Inject mock `opensearchConfig` with `index: 'test-index'`

### Key implementation conventions to follow

Based on QRM5-002, QRM5-003, QRM5-005, and broader codebase patterns:

- **Client access:** `this.setupService.getClient()` — call in constructor, store as `private readonly client: Client` (same pattern as `OpenSearchStore`)
- **Config injection:** `@Inject(opensearchConfig.KEY) private readonly config: ConfigType<typeof opensearchConfig>` — reuse the same config, only need `config.index` for the index name
- **Event subscription:** `@OnEvent('context.change')` decorator on a public method. Import `OnEvent` from `@nestjs/event-emitter`. Import `ChangeEvent` from `@app/common`.
- **Composite keys:** Use `CompositeKeyBuilder.build()` from `@app/common` — same utility used by `OpenSearchStore`
- **Error handling:** Graceful degradation. Log errors, never throw to callers. Failed items retry or are abandoned gracefully.
- **Logging:** `new Logger(EmbeddingPipelineService.name)`. Log at `debug` level for per-record operations, `warn` for degradation events, `error` for persistent failures, `log` for startup/backfill summary.
- **No `.js` extensions** in imports (webpack handles resolution)
- **`import type`** for type-only imports in decorated constructors (e.g., `ConfigType`)

## Acceptance Criteria

- [ ] `EmbeddingPipelineService` class exists at `apps/mcp-server/src/embedding/embedding-pipeline.service.ts`
- [ ] Pipeline subscribes to `'context.change'` events via `@OnEvent('context.change')`
- [ ] Pipeline only processes events with action `'set'` — ignores `'expire'` and `'delete'`
- [ ] On `set` event: fetches `embeddingText` from OpenSearch by composite key, computes embedding via `EmbeddingService.embedDocument()`, partial-updates the OpenSearch document with the vector
- [ ] Queue processes items sequentially (not concurrently)
- [ ] Failed embeddings are re-enqueued with exponential backoff (1s → 2s → 4s → 8s max)
- [ ] Items are abandoned after 3 retries with a warning log
- [ ] Documents deleted between `set` and pipeline processing (404 on get) are skipped without error
- [ ] Startup backfill (`onModuleInit`): queries OpenSearch for documents without `embedding` field, enqueues them for processing
- [ ] Startup backfill handles OpenSearch unavailability gracefully (logs warning, skips)
- [ ] `EmbeddingPipelineService` is provided in `ContextStoreModule.forRoot()` opensearch branch — not in `EmbeddingModule`
- [ ] When backend is `'inmemory'`, the pipeline is NOT instantiated
- [ ] Unit tests for event handling: set/expire/delete filtering, composite key construction (4+)
- [ ] Unit tests for processing: fetch → embed → update flow, 404 skip, sequential processing (4+)
- [ ] Unit tests for retry: null embedding retry, update failure retry, max retries abandon, backoff delay (4+)
- [ ] Unit tests for backfill: documents found, empty result, OpenSearch error (3+)
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test` — baseline: 47 suites, 700 tests)

## Dependencies and References

- **Depends on:**
  - QRM5-003 (Ollama Embedding Service) ✅ — provides `EmbeddingService.embedDocument()` for vector computation
  - QRM5-005 (OpenSearchStore) ✅ — provides the event emission (`'context.change'`), the indexed documents with `embeddingText`, and the `ContextStoreModule.forRoot()` wiring point
- **Blocks:**
  - QRM5-007 (Data Migration & Agent Prompt Guidelines) — migration's bulk backfill path relies on the pipeline to compute embeddings for imported records
  - QRM5-008 (Tests) — integration test: write record → verify BM25 searchable → verify hybrid searchable after embedding
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` | Emits `'context.change'` events on `set()` — the trigger for the pipeline. Also a reference for OpenSearch client access and error handling patterns. |
| `apps/mcp-server/src/embedding/embedding.service.ts` | `embedDocument(text)` → `number[] \| null` — the core embedding API consumed by the pipeline |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` | `getClient()` — the OpenSearch client access pattern. Constructor injection model. |
| `apps/mcp-server/src/context-store/context-store.module.ts` | `ContextStoreModule.forRoot()` — the wiring point where the pipeline provider will be added |
| `apps/mcp-server/src/embedding/embedding.module.ts` | Exports `EmbeddingService` — imported by `ContextStoreModule` in opensearch branch |
| `apps/mcp-server/src/context-store/opensearch/opensearch.module.ts` | Exports `OpenSearchSetupService` — imported by `ContextStoreModule` in opensearch branch |
| `libs/common/src/context-store/context-store.types.ts` | `ChangeEvent` type — the event payload the pipeline subscribes to |
| `libs/common/src/context-store/composite-key-builder.ts` | `CompositeKeyBuilder.build()` — builds document `_id` from scope/key/id |
| `apps/mcp-server/src/config/opensearch.config.ts` | Config for `index` name — injected by the pipeline |

**External references:**
- [OpenSearch Update Document API](https://opensearch.org/docs/latest/api-reference/document-apis/update-document/) — `POST /{index}/_update/{id}` with `{ doc: { field: value } }` for partial updates
- [OpenSearch Get Document API](https://opensearch.org/docs/latest/api-reference/document-apis/get-documents/) — `GET /{index}/_doc/{id}` with `_source_includes` for selective field retrieval
- [NestJS Event Emitter](https://docs.nestjs.com/techniques/events) — `@OnEvent()` decorator for event subscription
