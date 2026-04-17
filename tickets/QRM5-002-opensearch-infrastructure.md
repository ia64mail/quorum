# QRM5-002: OpenSearch Infrastructure

## Summary

Add an OpenSearch Docker container to the Quorum stack and create the NestJS infrastructure to manage it: a config factory with Zod validation, an index setup service that creates the hybrid-search index mapping and search pipeline on startup, a module to wire everything together, and the necessary `docker-compose.yml` additions. This ticket delivers the storage and search engine that `OpenSearchStore` (QRM5-005) will build on.

## Problem Statement

The Context Store currently uses an `InMemoryStore` backed by a `Map<string, ContextItem>` with file persistence to `quorum.context`. Search is case-insensitive AND-substring matching on `JSON.stringify(value)` — a strategy that fails for semantic intent (see QRM5-000-roadmap Problem section for evidence from QRM4 session reports: 7 consecutive multi-word query misses, 62% of tool calls spent on file reads, AND-semantics too strict for synonym/inflection variation).

OpenSearch provides both BM25 full-text search (Lucene-grade) and k-NN vector search (HNSW via Faiss) with declarative hybrid fusion via search pipelines. Before the `OpenSearchStore` can be implemented, the infrastructure must exist: the container must be running, the index mapping must be created with the correct field types, and the hybrid search pipeline must be registered.

**Why this ticket exists as a separate unit:** Infrastructure setup (Docker container, index creation, pipeline registration, health checks) is a distinct concern from the store implementation. Separating them keeps QRM5-002 independently testable and allows QRM5-005 to focus purely on the `ContextStore` contract implementation.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D2 (Unified Hybrid Store):** OpenSearch serves as both the primary Context Store backend and the hybrid search engine — no separate `EmbeddingIndex`, no sync problem between parallel stores.
- **D8 (Hybrid Search Pipeline):** A normalization-processor pipeline combines BM25 and k-NN scores with configurable weights (starting at 0.3 BM25 / 0.7 vector). The pipeline is created programmatically on startup, not via OpenSearch Dashboards.
- **D9 (Backward Compatibility):** `InMemoryStore` remains for unit tests and local dev without Docker. The swap is config-driven (`useClass` in the module provider).

### How this fits the existing architecture

The MCP Server container (`apps/mcp-server/`) currently houses the Context Store module (`apps/mcp-server/src/context-store/`). OpenSearch infrastructure lives in the same app since the MCP Server is the sole consumer. The new config factory follows the established pattern in `apps/mcp-server/src/config/` (Zod-validated `registerAs` factories, injected via `@Inject(config.KEY)` with `ConfigType<typeof config>`).

The OpenSearch container joins the existing `quorum-net` Docker network alongside `mcp-server`, `terminal`, and the agent containers. The MCP server gains a `depends_on` relationship on OpenSearch health.

### Index mapping rationale

The index mapping is designed around the `ContextItem` type (`libs/common/src/context-store/context-store.types.ts`) plus two search-specific fields:

| Field | OpenSearch Type | Purpose |
|-------|----------------|---------|
| `key` | `keyword` | Exact-match lookups (composite key document ID) |
| `scope` | `keyword` | Scope filtering in queries |
| `id` | `keyword` | correlationId/agentId filtering |
| `value` | `object` (enabled: false) | Raw payload — stored, NOT indexed (searched via `embeddingText` instead) |
| `createdBy` | `keyword` | Audit filtering |
| `createdAt` | `long` | Epoch-ms timestamp |
| `expiresAt` | `long` | TTL enforcement via range filter |
| `embeddingText` | `text` (standard analyzer) | BM25 full-text search target |
| `embedding` | `knn_vector` (1024d, HNSW, Faiss, cosine) | k-NN vector search target |

The `value` field is stored with `"enabled": false` because the raw JSON payload is returned to agents but never searched through directly — search operates on the `embeddingText` rendering instead.

### Docker container decisions

- **Single-node** OpenSearch — sufficient for local dev (cluster mode for cloud is a future deployment concern, out of scope per QRM5 exclusions).
- **Security plugin disabled** (`DISABLE_SECURITY_PLUGIN=true`) — eliminates TLS and auth complexity for local dev. The container is only reachable within the Docker network.
- **Named volume** (`opensearch-data`) for index persistence across container restarts.
- **Health check** via OpenSearch cluster health API (`/_cluster/health`).
- **Memory limits** — OpenSearch defaults to 512MB JVM heap; constrained via `OPENSEARCH_JAVA_OPTS: -Xms512m -Xmx512m` to prevent unbounded growth on dev machines.

## Implementation Details

### 1. Docker Compose additions (`docker-compose.yml`)

Add an `opensearch` service to the existing Docker Compose file. Key points:

- **Image:** `opensearchproject/opensearch:2` (latest 2.x). Pin to major version for stability; minor updates are non-breaking.
- **Environment:** Disable security plugin, set single-node discovery, constrain JVM heap.
- **Health check:** `curl -sf http://localhost:9200/_cluster/health` with retries — confirms OpenSearch is accepting requests and the cluster status is known.
- **Volume:** `opensearch-data` named volume mounted at `/usr/share/opensearch/data`.
- **Network:** Join `quorum-net`.
- **No port exposure to host** — only accessible within Docker network. If developers need direct access for debugging, they can add a port mapping locally.

The `mcp-server` service gains:
- `depends_on: opensearch: condition: service_healthy` — ensures OpenSearch is ready before the MCP server starts.
- New environment variables: `OPENSEARCH_NODE`, `OPENSEARCH_INDEX`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` (with defaults matching the roadmap table).

### 2. OpenSearch config factory (`apps/mcp-server/src/config/opensearch.config.ts`)

Follow the established config pattern (`brokerConfig`, `bootstrapConfig`):

```typescript
// Zod schema + registerAs('opensearch', ...)
// Fields: node (string URL), index (string), username (string), password (string)
```

- **`node`** — `OPENSEARCH_NODE` env var, default `http://opensearch:9200`
- **`index`** — `OPENSEARCH_INDEX` env var, default `quorum-context`
- **`username`** — `OPENSEARCH_USERNAME` env var, default `admin`
- **`password`** — `OPENSEARCH_PASSWORD` env var, default `admin`

All four fields are required strings validated by Zod. The config factory is registered in `McpServerConfigModule` (`apps/mcp-server/src/config/mcp-server-config.module.ts`) alongside existing configs and exported from the config barrel (`apps/mcp-server/src/config/index.ts`).

### 3. OpenSearch setup service (`apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts`)

An `@Injectable()` service implementing `OnModuleInit`. On application startup it:

1. **Creates the OpenSearch client** — using the `@opensearch-project/opensearch` package, configured from the injected `opensearchConfig`.
2. **Creates the index (if not exists)** — sends a `PUT /{index}` request with the full mapping and settings from the roadmap's Technical Architecture section (knn_vector 1024d, HNSW/Faiss/cosinesimil, text field with standard analyzer, etc.). If the index already exists (409 response or `resource_already_exists_exception`), log and skip — this makes startup idempotent.
3. **Creates the hybrid search pipeline (if not exists)** — sends a `PUT /_search/pipeline/hybrid-search` request with the normalization-processor configuration from design decision D8 (min-max normalization, arithmetic_mean combination, weights [0.3, 0.7]). Pipeline creation is idempotent in OpenSearch (PUT overwrites).

The setup service exposes the initialized `Client` instance for injection by downstream services (`OpenSearchStore` in QRM5-005). It should provide a `getClient()` method or be the client provider itself.

**Error handling:** If OpenSearch is unreachable during `onModuleInit`, the service logs an error but does NOT throw — the application starts in a degraded state. This aligns with the graceful degradation table in the roadmap (OpenSearch down → system unavailable for context operations, but the container itself stays up for health monitoring).

### 4. OpenSearch module (`apps/mcp-server/src/context-store/opensearch/opensearch.module.ts`)

A NestJS module that:
- Imports `ConfigModule` (for the opensearch config factory)
- Provides `OpenSearchSetupService`
- Exports `OpenSearchSetupService` (so `ContextStoreModule` and future `EmbeddingModule` can access the client)

This module is imported by `ContextStoreModule` when the OpenSearch backend is selected (the conditional wiring itself is QRM5-005's responsibility — this ticket just provides the infrastructure module).

### 5. NPM dependency

Add `@opensearch-project/opensearch` (latest 2.x) to `package.json` dependencies. This is the official OpenSearch JavaScript client — a drop-in HTTP client wrapping the OpenSearch REST API.

### 6. Config barrel and module registration

- Export `opensearchConfig` from `apps/mcp-server/src/config/index.ts`
- Add `opensearchConfig` to the `load` array in `McpServerConfigModule`

### Key implementation conventions to follow

Based on codebase analysis:

- **Config pattern:** `registerAs('opensearch', () => schema.parse({...}))` with Zod, matching `brokerConfig`/`bootstrapConfig` structure
- **Config injection:** `@Inject(opensearchConfig.KEY) private readonly config: ConfigType<typeof opensearchConfig>`
- **Logging:** `new Logger(OpenSearchSetupService.name)` — include meaningful messages for index/pipeline creation status
- **Error handling:** Degrade gracefully, never throw to callers. Log errors at appropriate levels.
- **No `.js` extensions** in imports (webpack handles resolution)
- **`import type`** for type-only imports used in decorated constructors

## Acceptance Criteria

- [ ] `docker-compose.yml` includes an `opensearch` service with:
  - OpenSearch 2.x image
  - Security plugin disabled (`DISABLE_SECURITY_PLUGIN=true`)
  - Single-node discovery type
  - JVM heap constrained (`-Xms512m -Xmx512m`)
  - Named volume `opensearch-data` for index persistence
  - Health check via `/_cluster/health`
  - Connected to `quorum-net`
- [ ] `mcp-server` service depends on `opensearch` with `condition: service_healthy`
- [ ] `mcp-server` environment includes `OPENSEARCH_NODE`, `OPENSEARCH_INDEX`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` with correct defaults
- [ ] `opensearchConfig` factory exists at `apps/mcp-server/src/config/opensearch.config.ts` with Zod validation for all four fields
- [ ] `opensearchConfig` is registered in `McpServerConfigModule` and exported from the config barrel
- [ ] `OpenSearchSetupService` creates the `quorum-context` index on startup with the correct mapping (knn_vector 1024d HNSW/Faiss/cosine, text field with standard analyzer, keyword fields for scope/id/key, object field for value with enabled:false, long fields for timestamps)
- [ ] `OpenSearchSetupService` creates the `hybrid-search` pipeline on startup with min-max normalization and arithmetic_mean combination (weights 0.3/0.7)
- [ ] Index and pipeline creation are idempotent — re-running startup does not error
- [ ] `OpenSearchSetupService` exposes the OpenSearch client for downstream injection
- [ ] `OpenSearchModule` wires the setup service and exports it
- [ ] `@opensearch-project/opensearch` is added to `package.json` dependencies
- [ ] `OpenSearchSetupService` handles OpenSearch unavailability gracefully (logs error, does not crash the application)
- [ ] Unit tests for `opensearchConfig` (defaults, env var overrides, validation failures) following the `broker.config.spec.ts` pattern
- [ ] Unit tests for `OpenSearchSetupService` (index creation, pipeline creation, idempotent re-run, connection failure handling) with mocked OpenSearch client
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test`)

## Dependencies and References

- **Depends on:** None — this ticket has no prerequisites and can start immediately
- **Blocks:** QRM5-005 (OpenSearchStore) — needs the OpenSearch client and initialized index/pipeline
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**
| File | Relevance |
|------|-----------|
| `docker-compose.yml` | Add OpenSearch service, update mcp-server depends_on and environment |
| `apps/mcp-server/src/config/broker.config.ts` | Reference pattern for config factory |
| `apps/mcp-server/src/config/broker.config.spec.ts` | Reference pattern for config tests |
| `apps/mcp-server/src/config/mcp-server-config.module.ts` | Register new config factory |
| `apps/mcp-server/src/config/index.ts` | Export new config factory |
| `apps/mcp-server/src/context-store/context-store.module.ts` | Future import point for OpenSearchModule (QRM5-005) |
| `libs/common/src/context-store/context-store.types.ts` | `ContextItem` fields inform the index mapping |
| `scripts/start.sh` | No changes — existing script works with the added service |

**External references:**
- [OpenSearch Index APIs](https://opensearch.org/docs/latest/api-reference/index-apis/create-index/) — index creation with mappings
- [OpenSearch k-NN plugin](https://opensearch.org/docs/latest/search-plugins/knn/index/) — vector search configuration
- [OpenSearch Search Pipelines](https://opensearch.org/docs/latest/search-plugins/search-pipelines/index/) — hybrid search pipeline setup
- [OpenSearch Normalization Processor](https://opensearch.org/docs/latest/search-plugins/search-pipelines/normalization-processor/) — min-max normalization + weighted combination
- [`@opensearch-project/opensearch` npm package](https://www.npmjs.com/package/@opensearch-project/opensearch) — official JS client

**Architect review:** Not required. All design decisions for this ticket are resolved in the QRM5-000 roadmap (D2, D8, D9). The implementation is pure infrastructure wiring with no architectural ambiguity.
