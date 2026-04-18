# QRM5-007: Data Migration & Agent Prompt Guidelines

## Summary

Two complementary concerns that complete the InMemoryStore-to-OpenSearch transition: (1) a one-time migration service that imports existing `quorum.context` records into OpenSearch on first startup, and (2) agent prompt updates that encourage natural-language text values for knowledge records to improve embedding quality. Together they ensure existing data carries forward and future data embeds well.

## Problem Statement

**Migration:** When the system switches from `InMemoryStore` to `OpenSearchStore`, all previously accumulated context is stranded in the `quorum.context` JSON file. Without migration, agents lose access to project-scope decisions, architectural notes, and implementation records from prior sessions. The migration must be automatic (no manual intervention), idempotent (safe to re-run), and non-destructive (preserve the original file as backup).

**Prompt guidelines:** Embedding models produce dramatically better vectors for natural-language prose than for raw JSON structures. QRM4 session reports show that agents predominantly store structured JSON values (`{"status": "complete", "commit": "da92f8a", ...}`), which tokenize into syntax characters rather than semantic content. Guiding agents toward text-first values for knowledge/decision records improves embedding quality organically — no infrastructure changes needed, just better input data.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D5 (Agent Prompt Guidelines):** Update agent role prompts to prefer natural-language text values for knowledge/decision records while keeping JSON acceptable for operational status records. This is a prompt-level change — agents are free to store JSON for operational records, but knowledge records should be written as readable text.
- **D9 (Backward Compatibility):** Existing `quorum.context` records are imported into OpenSearch on first startup via a one-time migration. The `quorum.context` file is preserved (not deleted) as a backup. Migration is idempotent — if records already exist in OpenSearch, skip.
- **D6 (Embedding Text Renderer):** The migration uses `toEmbeddingText()` to render each imported record's `embeddingText` field, the same renderer used by `OpenSearchStore.set()` during normal writes.

### How this fits the existing architecture

**Migration service** lives at `apps/mcp-server/src/context-store/opensearch/migration.service.ts`, alongside `OpenSearchStore` and `OpenSearchSetupService`. It runs as an `OnModuleInit` service in the opensearch branch of `ContextStoreModule.forRoot()`. It reads the `quorum.context` file (same path as `contextStoreConfig.contextStorePath`), indexes records into OpenSearch, and relies on the `EmbeddingPipelineService`'s startup backfill (QRM5-006) to compute embedding vectors for the imported records.

**Prompt guidelines** modify `libs/common/src/prompts/role-prompt-templates.ts`. The guidance goes into the SYSTEM_PREAMBLE's shared context section (applies to all agents) with a concise text-first guideline and embedding quality rationale.

### Integration surface from completed tickets

**From QRM5-005 (OpenSearchStore):**
- `OpenSearchStore` indexes documents with `embeddingText` field and composite key as `_id`
- `ContextStoreModule.forRoot()` opensearch branch is the wiring point for the migration service
- `contextStoreConfig` provides `contextStorePath` (path to `quorum.context` file) and `backend` field

**From QRM5-006 (EmbeddingPipelineService):**
- `onModuleInit()` backfill queries OpenSearch for documents without `embedding` field and enqueues them
- Migrated records (indexed without `embedding`) are automatically picked up by this backfill
- No explicit coordination needed — the pipeline's existing backfill mechanism handles imported records

**From QRM5-002 (OpenSearchSetupService):**
- `getClient()` provides the OpenSearch `Client` instance
- Index and pipeline are guaranteed to exist before migration runs (both created in `OpenSearchSetupService.onModuleInit()`)

**From QRM5-004 (toEmbeddingText):**
- `toEmbeddingText(item: ContextItem)` renders the `embeddingText` field for each migrated record

## Implementation Details

### Part 1: Migration Service

#### 1.1 Service class (`apps/mcp-server/src/context-store/opensearch/migration.service.ts`)

An `@Injectable()` service implementing `OnModuleInit`. Runs once on startup in the opensearch backend configuration.

**Constructor dependencies:**
- `OpenSearchSetupService` — inject to access the OpenSearch client via `getClient()`
- `@Inject(opensearchConfig.KEY) config` — inject for the index name
- `@Inject(contextStoreConfig.KEY) csConfig` — inject for `contextStorePath` (path to `quorum.context` file)

Store the `Client` reference from `setupService.getClient()` during construction (same pattern as `OpenSearchStore` and `EmbeddingPipelineService`).

#### 1.2 Migration flow (`onModuleInit`)

The `onModuleInit()` method orchestrates the one-time import:

1. **Check if OpenSearch index has existing records** — use the count API: `client.count({ index })`. If `count > 0`, the migration has already run (or records were written by normal operations). Log `"Index already contains N records — skipping migration"` and return. This is the idempotency guard.

2. **Read the `quorum.context` file** — use `readFile(this.csConfig.contextStorePath, 'utf-8')`. If the file doesn't exist (`ENOENT`), log `"No quorum.context file found — nothing to migrate"` and return. If the file is empty or unparseable, log a warning and return.

3. **Parse the file** — the file format is a JSON array of `[compositeKey, ContextItem]` tuples, as written by `InMemoryStore.onModuleDestroy()`:
   ```typescript
   const entries = JSON.parse(raw) as [string, ContextItem][];
   ```

4. **Filter expired records** — skip entries where `item.expiresAt !== undefined && Date.now() >= item.expiresAt`. Match the same TTL check used by `InMemoryStore.onModuleInit()`.

5. **Index each record into OpenSearch** — for each valid `[compositeKey, item]` pair:
   - Compute `embeddingText` via `toEmbeddingText(item)` (import from `@app/common`)
   - Ensure the `id` field defaults to `'_'` when undefined (matching `OpenSearchStore`'s C1 convention — project-scope records store `id: '_'` so OpenSearch `term` queries work correctly)
   - Index to OpenSearch:
     ```typescript
     client.index({
       index: this.config.index,
       id: compositeKey,
       body: { ...item, id: item.id ?? '_', embeddingText },
       refresh: true,
     })
     ```
   - Do NOT set the `embedding` field — the `EmbeddingPipelineService`'s startup backfill will detect these documents (they have `embeddingText` but no `embedding`) and compute vectors automatically.

6. **Log the result** — `"Migrated N records from quorum.context into OpenSearch"`.

7. **Preserve the original file** — do NOT delete `quorum.context`. It serves as a backup. The roadmap explicitly states: "After successful import, the `quorum.context` file is preserved (not deleted) as a backup."

**Error handling:**
- Wrap the entire migration in a try/catch. Log errors but do not throw — the system should start even if migration fails (records can be migrated manually or on next restart).
- If individual records fail to index, log a warning per record and continue with remaining records. Report the count of successful vs failed imports.
- If OpenSearch is unavailable (count API throws), log a warning and skip migration entirely — it will retry on next startup.

#### 1.3 Module wiring

Add `MigrationService` to the opensearch branch of `ContextStoreModule.forRoot()`:

```typescript
if (backend === 'opensearch') {
  return {
    module: ContextStoreModule,
    imports: [
      EventEmitterModule.forRoot(),
      OpenSearchModule,
      EmbeddingModule,
      ConfigModule.forFeature(contextStoreConfig),  // needed for contextStorePath
    ],
    providers: [
      { provide: ContextStore, useClass: OpenSearchStore },
      EmbeddingPipelineService,
      MigrationService,  // ← added
    ],
    exports: [ContextStore],
  };
}
```

**Important:** The opensearch branch currently does not import `ConfigModule.forFeature(contextStoreConfig)` because `OpenSearchStore` injects `opensearchConfig` (provided by `OpenSearchModule`), not `contextStoreConfig`. The `MigrationService` needs `contextStoreConfig` for the file path — add the `ConfigModule.forFeature(contextStoreConfig)` import to the opensearch branch.

#### 1.4 NestJS `onModuleInit` ordering

NestJS calls `onModuleInit()` on providers in the order they are listed in the module's `providers` array, after all imports have initialized. The current opensearch branch provider order is:
1. `OpenSearchSetupService` (from `OpenSearchModule` import) — creates index + pipeline
2. `OpenSearchStore` — the store provider
3. `EmbeddingPipelineService` — backfill on init
4. `MigrationService` — migration on init

The migration service must run **before** the embedding pipeline's backfill so that imported records are present in OpenSearch when the pipeline queries for documents without embeddings. NestJS processes `imports` before `providers`, and among providers, the order follows the `providers` array. Since `EmbeddingPipelineService` and `MigrationService` are both in `providers`, place `MigrationService` **before** `EmbeddingPipelineService` in the array:

```typescript
providers: [
  { provide: ContextStore, useClass: OpenSearchStore },
  MigrationService,            // ← before pipeline
  EmbeddingPipelineService,
],
```

This ensures: OpenSearchSetupService.onModuleInit() → MigrationService.onModuleInit() → EmbeddingPipelineService.onModuleInit() (backfill finds migrated records).

**Verification note:** The developer should verify this ordering empirically by checking NestJS `onModuleInit` documentation and/or adding a debug log to confirm the sequence during local testing. If NestJS does not guarantee provider-order initialization, the migration can be made a dependency of the pipeline via explicit injection (inject `MigrationService` into `EmbeddingPipelineService` — NestJS resolves dependencies before dependents).

#### 1.5 Testing strategy (`migration.service.spec.ts`)

All tests mock the OpenSearch client, file system (`readFile`), and `toEmbeddingText`. No real OpenSearch, no real filesystem.

**Test categories:**

**Successful migration:**
- Reads `quorum.context` file from configured path
- Indexes all non-expired records with correct composite keys and `embeddingText`
- Sets `id` to `'_'` for project-scope records (matching OpenSearchStore C1 convention)
- Logs the count of migrated records
- Does NOT set `embedding` field on indexed documents

**Idempotent skip:**
- Skips migration when OpenSearch index already has records (count > 0)
- Logs the skip reason with existing record count

**File scenarios:**
- Handles missing `quorum.context` file (`ENOENT`) gracefully — logs and returns
- Handles empty file — logs warning and returns
- Handles malformed JSON — logs warning and returns

**TTL filtering:**
- Skips records where `expiresAt` is in the past
- Imports records where `expiresAt` is in the future
- Imports records with no `expiresAt` (no expiry)

**Error handling:**
- Continues indexing remaining records when individual index calls fail
- Reports successful/failed counts
- Handles OpenSearch unavailability at startup (count API throws) — skips migration

**Mocking approach:**
- Mock `OpenSearchSetupService.getClient()` to return a mock `Client` with `.count()` and `.index()` methods
- Mock `readFile` from `node:fs/promises`
- Mock `toEmbeddingText` from `@app/common`
- Inject mock configs for `opensearchConfig` (index name) and `contextStoreConfig` (file path)

### Part 2: Agent Prompt Guidelines

#### 2.1 SYSTEM_PREAMBLE update (`libs/common/src/prompts/role-prompt-templates.ts`)

Add a concise text-first guideline to the `## Shared Context — Pull, Don't Push` section in SYSTEM_PREAMBLE. This location is cross-cutting — all agents see it, and it's adjacent to the `context_store` tool description where the guidance is most actionable.

Insert after the existing `context_store` description (after the bullet points for project/conversation/agent scope) and before the `context_query` bullet:

```
**Writing effective context values:**
- **Knowledge and decision records** (design decisions, implementation results, findings) — write as natural-language text. Prose embeds well for semantic search; JSON syntax tokens do not.
  - Good: `"Bootstrap context uses greedy bin-packing with reverse insertion order. The 1000-token default budget is configurable via BOOTSTRAP_CONTEXT_BUDGET."`
  - Poor: `{"approach": "greedy bin-packing", "order": "reverse insertion", "budget": 1000}`
- **Operational status records** (progress checkpoints, structured metadata) — JSON is acceptable when the structure serves the consumer.
```

This is deliberately brief — agents receive this on every invocation, so verbosity has a token cost. The two examples (good vs poor) illustrate the principle concretely without belaboring it.

#### 2.2 Per-role Context Management reinforcement

The SYSTEM_PREAMBLE addition covers all agents generically. For the three roles that produce the most knowledge records, add a one-line reinforcement in their `## Context Management` section:

**Developer** (`[AgentRole.developer]`): In the existing bullet `- **Store** implementation decisions in **conversation** scope so reviewers and downstream agents understand your approach`, add after it:
```
- Write knowledge values as natural-language text — prose produces better search results than JSON structures (see shared context guidelines above)
```

**Architect** (`[AgentRole.architect]`): In the existing bullet `- Always store decisions — developers pull your decisions from context rather than receiving them inline`, add after it:
```
- Write decision values as natural-language text describing what was decided and why — prose embeds better for semantic search than structured JSON
```

**Team Lead** (`[AgentRole.teamlead]`): In the existing bullet `- Record task dependencies explicitly in context so other agents understand execution order`, add after it:
```
- Prefer natural-language text for knowledge values — structured JSON is fine for status tracking, but decisions and findings should be readable prose
```

### Key implementation conventions to follow

Based on QRM5-002, QRM5-005, QRM5-006, and broader codebase patterns:

- **Client access:** `this.setupService.getClient()` — call in constructor, store as `private readonly client: Client` (same pattern as `OpenSearchStore` and `EmbeddingPipelineService`)
- **Config injection:** Two configs injected — `opensearchConfig.KEY` for index name, `contextStoreConfig.KEY` for file path. Use distinct parameter names to avoid collision.
- **File I/O:** Import `readFile` from `node:fs/promises` — same import used by `InMemoryStore`
- **Error handling:** Graceful degradation. Log errors, never throw to callers. The system must start even if migration fails.
- **Logging:** `new Logger(MigrationService.name)`. Use `log` for summary, `warn` for skips/failures, `debug` for per-record operations.
- **No `.js` extensions** in imports (webpack handles resolution)
- **`import type`** for type-only imports in decorated constructors (e.g., `ConfigType`)
- **Prompt edits:** Keep additions minimal and concrete. Every token in SYSTEM_PREAMBLE is sent on every agent invocation — verbosity has real cost.

## Acceptance Criteria

### Migration
- [ ] `MigrationService` class exists at `apps/mcp-server/src/context-store/opensearch/migration.service.ts`
- [ ] Migration runs on startup via `OnModuleInit` only when `CONTEXT_STORE_BACKEND=opensearch`
- [ ] Migration checks if OpenSearch index is empty before importing (idempotency)
- [ ] Migration reads the `quorum.context` file from the configured `contextStorePath`
- [ ] Expired records (past `expiresAt`) are skipped during import
- [ ] Each imported record is indexed with `embeddingText` computed via `toEmbeddingText()`
- [ ] Project-scope records have `id` set to `'_'` (matching OpenSearchStore C1 convention)
- [ ] `embedding` vector is NOT set — deferred to `EmbeddingPipelineService` backfill
- [ ] `quorum.context` file is preserved (not deleted) after successful import
- [ ] Missing file (`ENOENT`) is handled gracefully — logs and returns
- [ ] Malformed/empty file is handled gracefully — logs warning and returns
- [ ] Individual index failures do not abort the migration — log warning, continue, report counts
- [ ] OpenSearch unavailability at startup is handled gracefully — logs warning, skips migration
- [ ] `MigrationService` is wired in `ContextStoreModule.forRoot()` opensearch branch, ordered before `EmbeddingPipelineService`
- [ ] `ConfigModule.forFeature(contextStoreConfig)` is added to opensearch branch imports
- [ ] Unit tests: successful migration, idempotent skip, ENOENT, empty file, malformed JSON, TTL filtering, partial failure, OpenSearch unavailability (8+)

### Prompt guidelines
- [ ] SYSTEM_PREAMBLE updated with text-first guideline in the shared context section, with good/poor examples
- [ ] Developer role prompt: one-line reinforcement added to Context Management section
- [ ] Architect role prompt: one-line reinforcement added to Context Management section
- [ ] Team Lead role prompt: one-line reinforcement added to Context Management section
- [ ] Prompt additions are concise (no more than ~100 words added to SYSTEM_PREAMBLE)

### General
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test` — baseline: 48 suites, 719 tests)

## Dependencies and References

- **Depends on:**
  - QRM5-005 (OpenSearchStore) ✅ — provides the store, module wiring, and `contextStoreConfig.backend`
  - QRM5-006 (Async Embedding Pipeline) ✅ — provides the startup backfill that computes embeddings for migrated records
- **Blocks:**
  - QRM5-008 (Tests) — migration tests are part of the comprehensive test coverage ticket
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` | Reference for OpenSearch client patterns, C1 convention (`id ?? '_'`), error handling |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Source of `quorum.context` file format — `onModuleDestroy()` writes `[compositeKey, ContextItem][]`, `onModuleInit()` reads it with TTL filtering |
| `apps/mcp-server/src/context-store/context-store.module.ts` | Wiring point — add `MigrationService` to opensearch branch providers |
| `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` | Startup backfill in `onModuleInit()` — computes embeddings for imported records |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` | `getClient()` for OpenSearch client access, initialization ordering reference |
| `apps/mcp-server/src/config/context-store.config.ts` | Provides `contextStorePath` — path to `quorum.context` file |
| `apps/mcp-server/src/config/opensearch.config.ts` | Provides `index` name for OpenSearch operations |
| `libs/common/src/context-store/to-embedding-text.ts` | `toEmbeddingText()` — renders `embeddingText` for each migrated record |
| `libs/common/src/context-store/context-store.types.ts` | `ContextItem` type — the shape of records in `quorum.context` |
| `libs/common/src/context-store/composite-key-builder.ts` | `CompositeKeyBuilder` — used by `InMemoryStore` to build composite keys stored in the file |
| `libs/common/src/prompts/role-prompt-templates.ts` | SYSTEM_PREAMBLE and per-role prompts — prompt guideline edit target |

**Architect review:** Not required. Both concerns are fully specified in the QRM5-000 roadmap — D5 (prompt guidelines), D9 (migration). The migration is a straightforward file-read → index-to-OpenSearch pipeline using established patterns from `InMemoryStore` (file format) and `OpenSearchStore` (indexing). The prompt changes are additive text — no structural changes to the template system. No new architectural decisions are needed.
