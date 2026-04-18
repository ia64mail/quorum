# QRM5-008: Comprehensive Test Coverage for QRM5 Components

## Summary

Audit and complete test coverage for all QRM5 components — the embedding text renderer, Ollama client, embedding service, embedding pipeline, OpenSearch store, setup service, migration service, and configuration factories. Unit tests for each component already exist from their respective implementation tickets (QRM5-002 through QRM5-007). This ticket validates coverage completeness, fills any gaps found during audit, and adds an end-to-end integration test that exercises the full write → BM25 search → hybrid search lifecycle across the real component stack.

## Problem Statement

Each QRM5 ticket delivered its own unit tests alongside the implementation (the project convention). The test suite currently stands at **49 suites / 737 tests**, including QRM5-specific specs for every new component. However, no ticket was responsible for:

1. **Cross-component integration testing.** Each unit test mocks its dependencies. No test verifies that `OpenSearchStore.set()` → `EmbeddingPipelineService` event subscription → `EmbeddingService.embedDocument()` → OpenSearch partial-update actually works as a connected pipeline. The hybrid search path (BM25 + k-NN) has never been tested with a real OpenSearch instance.

2. **Coverage audit across the QRM5 boundary.** Individual ticket authors tested what they built, but edge cases at component boundaries — the handoff between `set()` event emission and pipeline consumption, the interaction between migration indexing and pipeline backfill, the search fallback when `EmbeddingService.isAvailable()` returns false mid-operation — may have gaps that only appear when reviewing the full surface.

3. **InMemoryStore regression verification.** The abstract `ContextStore` contract hasn't changed, and `InMemoryStore` wasn't modified, but verifying that existing InMemoryStore tests still pass against the unchanged contract confirms backward compatibility.

Without this ticket, the team has confidence in individual components but not in the assembled system. The integration test is the capstone that validates the QRM5 design promise: write a record, search it immediately via BM25, then search it via hybrid scoring once the embedding arrives.

## Design Context

### What already exists (baseline from QRM5-002 through QRM5-007)

| Component | Spec file | Tests | Coverage notes |
|-----------|-----------|-------|----------------|
| `toEmbeddingText()` | `libs/common/src/context-store/to-embedding-text.spec.ts` | ~40 | String, object, nested array, null/empty, camelCase conversion, truncation, roadmap example |
| `OllamaClient` | `apps/mcp-server/src/embedding/ollama-client.service.spec.ts` | 10 | Success, connection failure, non-OK HTTP, malformed response (missing/empty embeddings), dimension mismatch, config override, health check (up/down/non-OK) |
| `EmbeddingService` | `apps/mcp-server/src/embedding/embedding.service.spec.ts` | 8 | Document embed, query prefix, error → null, isAvailable delegation |
| `EmbeddingPipelineService` | `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | 19 | Event filtering (set/expire/delete), fetch→embed→update, 404 skip, retry with backoff, max retries abandon, backfill (found/empty/unavailable), drain safety |
| `OpenSearchStore` | `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | ~35 | set (index, embeddingText, TTL, events, error), get (value, 404 paths, lazy expiry), getAll (scope/id filter, error), search (hybrid, BM25 fallback, budget, scope), getStats (count, tokens, scope) |
| `OpenSearchSetupService` | `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.spec.ts` | 8 | Index creation, pipeline creation, idempotency (already exists), connection failure, getClient |
| `MigrationService` | `apps/mcp-server/src/context-store/opensearch/migration.service.spec.ts` | 16 | Import records, embeddingText computation, id conventions, idempotent skip, file scenarios (ENOENT, empty, whitespace, malformed JSON, non-array), TTL filtering, error handling (partial failure, OpenSearch unavailable, permission error) |
| `opensearchConfig` | `apps/mcp-server/src/config/opensearch.config.spec.ts` | 6 | Defaults, env overrides (node, index, username, password), empty fallback |
| `embeddingConfig` | `apps/mcp-server/src/config/embedding.config.spec.ts` | 7 | Defaults, env overrides (url, model, dimensions), empty fallback, non-numeric/zero dimensions throw |
| `contextStoreConfig` | `apps/mcp-server/src/config/context-store.config.spec.ts` | 6 | Default backend, opensearch override, invalid backend reject, path overrides, MCP_WORKSPACE_DIR |
| `InMemoryStore` | `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | ~45 | Full contract coverage (set, get, getAll, search, getStats), scope/id isolation, TTL, events, file persistence |

**Total QRM5-related tests already in the suite: ~200 across 11 spec files.**

### What this ticket adds

1. **Coverage audit** — systematic review of each spec file against its source to identify untested branches, error paths, or edge cases
2. **Gap-fill tests** — any additional unit tests identified during the audit
3. **Integration test** — an end-to-end test using real (or realistically composed) NestJS modules that validates the full lifecycle without mocking inter-component boundaries

### Integration test architecture

The integration test exercises the connected pipeline **without** requiring external Docker containers (OpenSearch, Ollama). Instead, it uses the NestJS testing module with carefully layered mocking:

- **OpenSearch client** — mocked at the `@opensearch-project/opensearch` `Client` level with an in-memory document store that supports `index`, `get`, `search`, `update`, `count`, and `delete` operations. This validates the real `OpenSearchStore`, `EmbeddingPipelineService`, and `MigrationService` code paths while controlling the storage layer.
- **Ollama** — mocked at the `global.fetch` level (same pattern as `ollama-client.service.spec.ts`) to return deterministic vectors. This validates that `OllamaClient` → `EmbeddingService` → `EmbeddingPipelineService` correctly flows the vector into the OpenSearch document.
- **Everything else is real** — `OpenSearchStore`, `EmbeddingPipelineService`, `EmbeddingService`, `OllamaClient`, `OpenSearchSetupService`, `toEmbeddingText()`, `CompositeKeyBuilder`, `EventEmitter2` event wiring.

This approach tests the real NestJS dependency injection, real event emission/subscription, and real method calls between components — the only fakes are the external I/O boundaries (HTTP to Ollama, TCP to OpenSearch).

## Implementation Details

### Part 1: Coverage Audit

Review each spec file against its source implementation. For each component, verify:

1. **All public methods have tests** — every method signature in the class should have at least one happy-path and one error-path test
2. **Constructor/init behavior is tested** — `onModuleInit()` lifecycle hooks, config injection validation
3. **Error branches are covered** — every `catch` block, every graceful degradation return, every conditional error path
4. **Edge cases at boundaries** — empty inputs, null/undefined values, concurrent operations where applicable

Document any gaps found and add tests for them. Expected gaps are small given the thoroughness of individual ticket implementations, but the audit ensures nothing slipped through.

**Specific areas to scrutinize:**

- `OpenSearchStore.search()` — does the test verify the exact hybrid query structure sent to OpenSearch (BM25 leg + k-NN leg + scope filter + TTL filter + pipeline reference)? Does it test the case where `embedQuery` returns null mid-search (not just when `isAvailable` is false)?
- `EmbeddingPipelineService` — is the `processing` flag race condition tested? (Two rapid `enqueue` calls should not start two concurrent drain loops)
- `MigrationService` — does the test verify that `toEmbeddingText` is called with the correct `ContextItem` shape for each record type (project with no id, conversation with id)?
- `OllamaClient` — is the timeout behavior on `isHealthy()` tested? (The implementation uses `AbortSignal.timeout(5000)`)

### Part 2: Integration Test

**File:** `apps/mcp-server/src/context-store/opensearch/opensearch-integration.spec.ts`

This is the capstone test for QRM5. It validates the end-to-end lifecycle that no unit test covers.

#### Mock OpenSearch Client

Build a lightweight in-memory mock that implements the subset of the OpenSearch `Client` API used by the QRM5 components:

```typescript
// Conceptual shape — not full implementation
class MockOpenSearchClient {
  private docs = new Map<string, Record<string, unknown>>();

  async index({ index, id, body, refresh }) { /* store doc */ }
  async get({ id, _source_includes }) { /* retrieve doc */ }
  async update({ id, body: { doc } }) { /* merge partial update */ }
  async search({ body }) { /* filter + simple text matching */ }
  async count({ index }) { /* return doc count */ }
  async delete({ id }) { /* remove doc */ }

  // Test helpers
  getDocument(id: string) { /* direct access for assertions */ }
}
```

The mock doesn't need to implement real BM25 scoring or k-NN — it needs to store and retrieve documents faithfully so the real service code can execute its full path. Search can use simple substring matching for verification purposes.

#### Mock Ollama via fetch

Use the same `global.fetch` mock pattern established in `ollama-client.service.spec.ts`. Return a deterministic 1024-dimensional vector for any embed request. The `/api/tags` health check returns OK.

#### Test scenarios

**Scenario 1: Write → immediate BM25 search → hybrid search after embedding**

This is the core QRM5 promise. Steps:
1. Write a record via `OpenSearchStore.set()` with a descriptive text value
2. Immediately call `OpenSearchStore.search()` — verify the record is found (it has `embeddingText` but no `embedding` yet, so BM25-only match)
3. Wait for the `EmbeddingPipelineService` drain to complete (the `'context.change'` event triggers async embedding)
4. Verify the OpenSearch document now has an `embedding` field (the partial update landed)
5. Call `OpenSearchStore.search()` again — verify the record is found and the hybrid search path was used (the query included both BM25 and k-NN legs)

**Scenario 2: Write with Ollama unavailable → BM25-only → Ollama recovers → backfill fills vectors**

Tests the graceful degradation path:
1. Configure the fetch mock to reject Ollama requests (simulate container down)
2. Write a record via `set()` — should succeed (BM25-indexed)
3. Search — should find via BM25 only
4. Verify no `embedding` field on the document (pipeline retries exhausted or Ollama unavailable)
5. Restore the fetch mock to succeed
6. Trigger backfill (or allow retry to succeed) — verify the embedding vector appears

**Scenario 3: Multiple records, scope isolation, token budget**

Validates that the full pipeline respects the ContextStore contract:
1. Write 3 records: one project-scope, one conversation-scope, one with TTL
2. Let embeddings complete for all
3. Search project scope — should only return project records
4. Search conversation scope with specific id — should only return that conversation's records
5. Search with a small `maxTokens` budget — should truncate results
6. Advance time past TTL — expired record should not appear in search

**Scenario 4: Migration integration**

If feasible within the mock setup:
1. Prepare a mock `quorum.context` file content (mock `fs/promises.readFile`)
2. Configure the mock OpenSearch client to return `count: 0` (empty index)
3. Init the `MigrationService` — verify records are indexed into the mock client
4. Verify `EmbeddingPipelineService` backfill picks up the migrated records (they have `embeddingText` but no `embedding`)
5. After backfill, verify migrated records have embedding vectors

#### NestJS Test Module Setup

```typescript
const module = await Test.createTestingModule({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule.forFeature(opensearchConfig),
    ConfigModule.forFeature(embeddingConfig),
    ConfigModule.forFeature(contextStoreConfig),
  ],
  providers: [
    OpenSearchSetupService,  // real, but Client mock injected via jest.mock
    OpenSearchStore,
    EmbeddingPipelineService,
    OllamaClient,            // real, but fetch is mocked at global level
    EmbeddingService,
    { provide: EventEmitter2, useValue: new EventEmitter2() },
  ],
}).compile();
```

The exact wiring may need adjustment — `OpenSearchSetupService` creates the `Client` in its constructor, so the `@opensearch-project/opensearch` module must be jest-mocked before the test module compiles. Follow the pattern established in `opensearch-store.spec.ts` for the `jest.mock('@opensearch-project/opensearch')` setup.

#### Async timing

The integration test must handle the async nature of the embedding pipeline. Options:
- **Fake timers + flushPromises** — same pattern as `embedding-pipeline.service.spec.ts`. Use `jest.useFakeTimers()`, trigger actions, then `await flushPromises()` to let the drain loop complete.
- **Poll with timeout** — if fake timers create too much complexity with the full module stack, poll the mock OpenSearch client for the expected state with a short timeout.

The fake timers approach is preferred for determinism. The existing pipeline spec already demonstrates this pattern works well.

### Part 3: InMemoryStore Regression Verification

No new tests needed — the existing `in-memory-store.spec.ts` (45+ tests) validates the ContextStore abstract contract independently. This ticket simply verifies those tests still pass, confirming that the QRM5 changes to `ContextStoreModule` (conditional backend selection) and the addition of `OpenSearchStore` didn't break the inmemory path.

Run `npm run test -- --testPathPattern=in-memory-store` and confirm all tests pass. Record the count in Implementation Notes.

## Acceptance Criteria

- [ ] Coverage audit completed for all 11 QRM5 spec files — each reviewed against its source, gaps documented
- [ ] Any gap-fill tests added (or explicitly documented as "no gaps found" if audit is clean)
- [ ] Integration test file exists at `apps/mcp-server/src/context-store/opensearch/opensearch-integration.spec.ts`
- [ ] Integration test Scenario 1: write → BM25 search → embedding completes → hybrid search — passes
- [ ] Integration test Scenario 2: Ollama unavailable → BM25 fallback → recovery → vectors appear — passes
- [ ] Integration test Scenario 3: multi-record scope isolation and token budget — passes
- [ ] Integration test Scenario 4: migration → backfill → vectors — passes (or documented as deferred if mock complexity is prohibitive)
- [ ] InMemoryStore regression: existing 45+ tests pass unchanged
- [ ] All existing QRM5 unit tests remain green (no regressions from audit changes)
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] `npm run test` passes — all suites, all tests (baseline: 49 suites, 737 tests)

## Dependencies and References

- **Depends on:**
  - QRM5-004 (Text Renderer) ✅ — `toEmbeddingText()` and its tests
  - QRM5-005 (OpenSearchStore) ✅ — store implementation and its tests
  - QRM5-006 (Async Embedding Pipeline) ✅ — pipeline implementation and its tests
  - QRM5-007 (Data Migration & Agent Prompt Guidelines) ✅ — migration service and its tests
  - All QRM5 unit test specs from QRM5-002 through QRM5-007 must be committed before this ticket starts
- **Blocks:** Nothing — this is the final validation ticket before QRM5-009 (Config & Docs)
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files (test specs to audit):**

| Spec file | Source file |
|-----------|------------|
| `libs/common/src/context-store/to-embedding-text.spec.ts` | `libs/common/src/context-store/to-embedding-text.ts` |
| `apps/mcp-server/src/embedding/ollama-client.service.spec.ts` | `apps/mcp-server/src/embedding/ollama-client.service.ts` |
| `apps/mcp-server/src/embedding/embedding.service.spec.ts` | `apps/mcp-server/src/embedding/embedding.service.ts` |
| `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` |
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.spec.ts` | `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` |
| `apps/mcp-server/src/context-store/opensearch/migration.service.spec.ts` | `apps/mcp-server/src/context-store/opensearch/migration.service.ts` |
| `apps/mcp-server/src/config/opensearch.config.spec.ts` | `apps/mcp-server/src/config/opensearch.config.ts` |
| `apps/mcp-server/src/config/embedding.config.spec.ts` | `apps/mcp-server/src/config/embedding.config.ts` |
| `apps/mcp-server/src/config/context-store.config.spec.ts` | `apps/mcp-server/src/config/context-store.config.ts` |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | `apps/mcp-server/src/context-store/in-memory-store.ts` |

**Testing patterns reference:**
- NestJS test module: `in-memory-store.spec.ts` (full `Test.createTestingModule` with `EventEmitterModule`)
- Manual mock objects: `opensearch-store.spec.ts` (mock OpenSearch client, EmbeddingService, SetupService)
- `global.fetch` mocking: `ollama-client.service.spec.ts` (save/restore original, mock per-test)
- Fake timers + flushPromises: `embedding-pipeline.service.spec.ts` (async queue drain, retry backoff)
- Date.now() spying: `opensearch-store.spec.ts`, `in-memory-store.spec.ts` (TTL expiration)
- Environment variable save/restore: all config spec files
- `jest.mock()` with module replacement: `migration.service.spec.ts` (fs/promises, @app/common)
