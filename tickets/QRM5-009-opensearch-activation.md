# QRM5-009: OpenSearch Activation — Live Backend Switch & Documentation

## Summary

Activate OpenSearch as the production Context Store backend by setting `CONTEXT_STORE_BACKEND=opensearch` in docker-compose.yml, upgrade the MCP server health endpoint to report dependency status, and update all system documentation to reflect the new architecture. This is the capstone ticket for the QRM5 hybrid search infrastructure: all implementation is complete (QRM5-002 through QRM5-007), and this ticket makes it live.

## Problem Statement

The entire QRM5 hybrid search stack is implemented but dormant. OpenSearch and Ollama containers are running, the `OpenSearchStore` is fully wired with conditional module loading, migration handles the `quorum.context` import, and the embedding pipeline backfills vectors on startup. But `CONTEXT_STORE_BACKEND` defaults to `'inmemory'`, so agents still use substring matching.

Meanwhile, system documentation (`docs/context-store.md`, `docs/context-management.md`, `docs/system-design.md`) still describes the `InMemoryStore` as the current backend, with OpenSearch listed under "Future Enhancements." The architecture diagrams don't show the OpenSearch or Ollama containers.

Additionally, the MCP server health endpoint (`GET /health`) is a trivial stub returning `{ status: 'ok' }` unconditionally. With OpenSearch as the live backend, dependency health becomes operationally relevant — a broken OpenSearch connection means silent context failures with no visibility.

## Design Context

### What's already implemented (prerequisite tickets)

| Component | Ticket | Status |
|-----------|--------|--------|
| OpenSearch container + index + pipeline | QRM5-002 | Complete |
| Ollama container + embedding service | QRM5-003 | Complete |
| `toEmbeddingText()` renderer | QRM5-004 | Complete |
| `OpenSearchStore` (hybrid search) | QRM5-005 | Complete |
| `EmbeddingPipelineService` (async vectors) | QRM5-006 | Complete |
| Migration from `quorum.context` + prompt guidelines | QRM5-007 | Complete |

### Startup sequence (already correct)

Docker dependency chain ensures correct ordering:
1. `opensearch` starts → health check passes (`_cluster/health`)
2. `ollama-init` pulls model → `ollama` starts → health check passes (`ollama list`)
3. `mcp-server` starts (depends on both with `condition: service_healthy`)
4. `OpenSearchSetupService.onModuleInit()` — creates index + hybrid-search pipeline (idempotent)
5. `MigrationService.onModuleInit()` — imports `quorum.context` records if index is empty
6. `EmbeddingPipelineService.onModuleInit()` — backfills vectors for any documents missing embeddings

### Graceful degradation (already implemented)

| Scenario | Behavior |
|----------|----------|
| OpenSearch up, Ollama up | Full hybrid search (BM25 + vector) |
| OpenSearch up, Ollama down | BM25-only search — `EmbeddingService.embedQuery()` returns null, search omits k-NN leg |
| Record just written (no vector yet) | BM25 match only for that record; hybrid for records with vectors |
| OpenSearch error on any operation | `OpenSearchStore` catches error, logs, returns empty/undefined — no throws to callers |

## Implementation Details

### 1. Environment variable flip (`docker-compose.yml`)

Add `CONTEXT_STORE_BACKEND: opensearch` to the mcp-server service environment block:

```yaml
# Context Store backend (QRM5-009)
CONTEXT_STORE_BACKEND: opensearch
```

This single line activates the entire QRM5 stack. `ContextStoreModule.forRoot()` reads this env var directly (not through config factory — module composition happens before DI resolution, per architect C2 documented in the module) and wires `OpenSearchStore` as the `ContextStore` provider, along with `MigrationService` and `EmbeddingPipelineService`.

The env var is read at two levels (both already implemented):
- `context-store.module.ts` line 26 — module composition (`process.env.CONTEXT_STORE_BACKEND`)
- `context-store.config.ts` line 15 — config factory for runtime access (`backend` field)

### 2. Health endpoint upgrade (`apps/mcp-server/src/health/`)

The current health controller is a trivial stub:

```typescript
@Get()
check(): { status: string } {
  return { status: 'ok' };
}
```

Upgrade to report dependency health while keeping the endpoint as a **liveness check** (always returns 200 for Docker restart stability). When OpenSearch is the active backend, include connectivity status in the response body.

**Design constraints:**
- **Must return HTTP 200 for liveness.** Docker's health check hits `/health` and uses it for restart decisions and `depends_on` ordering. Returning 500 when OpenSearch is temporarily unavailable would cause a restart loop (mcp-server restarts, OpenSearch still down, repeat). The MCP server process itself is healthy — it just can't reach a dependency.
- **Report dependency status in the response body.** Callers (monitoring, debugging) can inspect the JSON to see if dependencies are reachable. Pattern: `{ status: 'ok', dependencies: { opensearch: 'up'|'down', ollama: 'up'|'down' } }`.
- **Conditional dependencies.** When `CONTEXT_STORE_BACKEND=inmemory`, no dependency checks are performed (no OpenSearch to check). When `opensearch`, check both OpenSearch cluster health and Ollama availability.

**Implementation approach:**

Inject `ContextStore` and optionally `EmbeddingService` into the health controller (or a new `HealthService`). Since `ContextStore` is abstract and the concrete class depends on config, the health check should be backend-aware:

- **inmemory backend:** Return `{ status: 'ok' }` (current behavior, no dependencies)
- **opensearch backend:** Ping OpenSearch cluster health (`GET /_cluster/health`), check `EmbeddingService.isAvailable()`, return status per dependency

The OpenSearch check can use the client from `OpenSearchSetupService.getClient()`. The `EmbeddingService` already exposes `isAvailable()` which delegates to `OllamaClient.isHealthy()`.

**Touches:**
- `apps/mcp-server/src/health/health.controller.ts` — inject dependencies, add status reporting
- `apps/mcp-server/src/health/health.module.ts` — import required modules
- `apps/mcp-server/src/health/health.controller.spec.ts` — update tests

### 3. Documentation updates

#### 3a. `docs/context-store.md`

This is the most significant documentation update. Current state: InMemoryStore is described as the only backend, OpenSearch is listed under "Future Enhancements."

**Changes required:**
- **Architecture diagram** — Update the mermaid diagram to show `ContextStore` → `InMemoryStore` | `OpenSearchStore` → `OpenSearch container`, with `EmbeddingPipeline` → `Ollama container`
- **Add OpenSearchStore section** after the InMemoryStore section, covering:
  - Behavior table (set, get, getAll, search, getStats) — same contract, hybrid search semantics
  - Write path: index with `embeddingText` (BM25-immediate), async embedding (hybrid within ~300ms)
  - Search path: hybrid query via `hybrid-search` pipeline (BM25 0.3 + k-NN 0.7), BM25-only fallback
  - TTL: query-time filter + periodic cleanup
  - Graceful degradation table
- **Module wiring section** — Update to show `ContextStoreModule.forRoot()` dynamic module with conditional `useClass`, explain that `CONTEXT_STORE_BACKEND` env var controls the swap, note the direct `process.env` read at module composition time
- **Configuration section** — Add OpenSearch and embedding config tables alongside existing contextStoreConfig:
  - `CONTEXT_STORE_BACKEND` — `inmemory` (default) or `opensearch`
  - `OPENSEARCH_NODE`, `OPENSEARCH_INDEX`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`
  - `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`
- **Future Enhancements** — Remove "OpenSearch backend" and "Embedding on write" (they're now current). Keep remaining items (LLM summarization, resource update notifications, role-based access). Add Phase B/C forward references.

#### 3b. `docs/context-management.md`

Update the search behavior description. Currently describes keyword/substring matching in the MCP tools section.

**Changes required:**
- Update the `context_query` tool's `search` mode description: hybrid BM25 + vector search replaces substring matching
- Note that results are ranked by relevance (not just filtered by presence)
- Mention graceful degradation: BM25-only when Ollama unavailable, still better than substring matching

#### 3c. `docs/system-design.md`

Update the architecture overview to reflect the new containers.

**Changes required:**
- **Architecture diagram** — Add OpenSearch and Ollama containers to the mermaid graph, showing them connected to the MCP Server
- **Container Components table** — Add entries for OpenSearch and Ollama (can be brief; link to `docs/context-store.md` for details)
- **Context Management section** — Update to reference hybrid search, note that the backend is configurable

## Acceptance Criteria

- [x] `CONTEXT_STORE_BACKEND: opensearch` is set in `docker-compose.yml` mcp-server environment
- [ ] Health endpoint reports dependency status (OpenSearch connectivity, Ollama availability) in the response body when opensearch backend is active
- [ ] Health endpoint returns HTTP 200 always (liveness — no restart loops)
- [ ] Health endpoint behaves as before (`{ status: 'ok' }`) when `CONTEXT_STORE_BACKEND=inmemory`
- [ ] Health endpoint spec updated with tests for both backends
- [ ] `docs/context-store.md` updated: OpenSearchStore section, module wiring, configuration, architecture diagram; OpenSearch removed from "Future Enhancements"
- [ ] `docs/context-management.md` updated: search behavior describes hybrid search
- [ ] `docs/system-design.md` updated: architecture diagram includes OpenSearch and Ollama containers
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (existing tests unaffected)

## Dependencies and References

### Prerequisites (all complete)
- **QRM5-002** — OpenSearch infrastructure (container, index, pipeline)
- **QRM5-003** — Ollama embedding service (container, client, service)
- **QRM5-004** — Embedding text renderer (`toEmbeddingText()`)
- **QRM5-005** — OpenSearchStore implementation (hybrid search)
- **QRM5-006** — Async embedding pipeline (background vectorization)
- **QRM5-007** — Data migration + agent prompt guidelines

### Key files
- `docker-compose.yml` — Container definitions, env vars
- `apps/mcp-server/src/context-store/context-store.module.ts` — Dynamic module (swap point)
- `apps/mcp-server/src/config/context-store.config.ts` — Backend selection config
- `apps/mcp-server/src/health/health.controller.ts` — Health endpoint
- `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` — Store implementation
- `apps/mcp-server/src/embedding/embedding.service.ts` — `isAvailable()` for health check
- `docs/context-store.md` — Primary doc update
- `docs/context-management.md` — Search behavior update
- `docs/system-design.md` — Architecture diagram update

### Deferred
- **QRM5-008** (Tests) — Comprehensive test audit deferred; existing per-ticket tests remain
