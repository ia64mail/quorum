# QRM5-003: Ollama Embedding Service

## Summary

Add an Ollama Docker container with `mxbai-embed-large` pre-pulled via init container, and create the NestJS embedding layer: a config factory, an HTTP client service wrapping the Ollama embed API, and a higher-level embedding service handling asymmetric document/query prefixing. This ticket delivers the local inference engine that `OpenSearchStore` (QRM5-005) and the async embedding pipeline (QRM5-006) depend on.

## Problem Statement

The QRM5 hybrid search design requires vector embeddings for k-NN similarity scoring (the 0.7-weighted leg of the hybrid pipeline). Without a local embedding service, records can only be BM25-searched — losing the semantic intent matching that motivated the entire milestone.

**Why local inference (not API):**
- Full data privacy — no context records sent to external services
- Zero marginal cost — no per-token billing
- Predictable latency — ~150–300ms on CPU, no network variability
- Deployment via Docker — same `docker compose up` workflow

**Why `mxbai-embed-large`:**
- Top of open-source MTEB leaderboard for its parameter class (~64.7 average)
- 1024 dimensions — rich representation for technical content
- Acceptable footprint (670MB model, ~4KB per record vector)

**Why this ticket exists as a separate unit:** The embedding infrastructure (Docker container, HTTP client, asymmetric prefixing logic) is a distinct concern from the OpenSearch store that consumes it and the pipeline that orchestrates it. Separating them keeps QRM5-003 independently testable and allows QRM5-005/006 to focus on their respective contracts.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D3 (Embedding Model):** `mxbai-embed-large` via local Ollama. Asymmetric embedding: documents embed as-is, queries prepend `"Represent this sentence for searching relevant passages: "`.
- **D7 (One Record, One Embedding):** No sub-chunking. Truncation at model max sequence length. Token estimation uses `text.length / 3` (BERT WordPiece conservative ratio).

### How this fits the existing architecture

The MCP Server container (`apps/mcp-server/`) is the sole consumer of the embedding service. The new `embedding/` module directory sits alongside `context-store/` within the mcp-server app. The config factory follows the established pattern in `apps/mcp-server/src/config/` — Zod-validated `registerAs` factories matching `opensearchConfig` and `brokerConfig`.

The Ollama container joins the existing `quorum-net` Docker network. A separate `ollama-init` init container handles the one-time model pull so the runtime container starts with the model already available.

### Established patterns from QRM5-002

This ticket follows patterns established by QRM5-002 (OpenSearch Infrastructure):

- **Config factory:** `registerAs('embedding', () => schema.parse({...}))` with Zod, `||` for env var defaults (not `??`), `z.string().min(1)` for strings, `z.coerce.number().int().min(1)` for integers
- **Config spec:** save/restore `process.env`, test defaults, env var overrides per field, empty string fallback
- **Service testing:** Direct constructor instantiation with mock config, `jest.mock()` for external dependencies, `jest.clearAllMocks()` in `beforeEach`
- **Module wiring:** `ConfigModule.forFeature(embeddingConfig)`, providers + exports
- **Registration:** Add to `McpServerConfigModule` `load` array + barrel export in `apps/mcp-server/src/config/index.ts`
- **Error handling:** Graceful degradation — log errors, never throw to callers
- **Logging:** `new Logger(ClassName.name)`

## Implementation Details

### 1. Docker Compose additions (`docker-compose.yml`)

Add two services for Ollama: an init container that pulls the model, and the runtime container.

**`ollama-init` service (init container):**
- **Image:** `ollama/ollama:latest`
- **Purpose:** Starts Ollama server, pulls `mxbai-embed-large` into the shared volume, then exits
- **Entrypoint override:** A shell script that runs `ollama serve &`, waits for readiness, executes `ollama pull mxbai-embed-large`, then exits. The `&` backgrounds the server so the pull can run against it.
- **Volume:** `ollama-data` named volume mounted at `/root/.ollama` — this is where Ollama stores downloaded models
- **Network:** `quorum-net` (not strictly required since it exits, but consistent)
- **No health check needed** — this container exits on completion

The init container pattern avoids the race condition where the runtime container starts before the model is available. The volume persists the model across restarts so the pull only happens on first run (subsequent pulls are no-ops).

**`ollama` runtime service:**
- **Image:** `ollama/ollama:latest`
- **Volume:** `ollama-data` named volume at `/root/.ollama` (same volume as init)
- **Depends on:** `ollama-init` with `condition: service_completed_successfully`
- **Health check:** `curl -sf http://localhost:11434/api/tags || exit 1` — verifies Ollama is running and responsive. The `/api/tags` endpoint returns the list of available models, confirming both the server and model readiness.
- **Network:** `quorum-net`
- **No port exposure to host** — only accessible within Docker network

**`mcp-server` service updates:**
- Add `depends_on: ollama: condition: service_healthy` (alongside existing `opensearch` dependency)
- Add environment variables: `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` with defaults

**`ollama-data` named volume** added to the `volumes:` section.

**Init container entrypoint pattern:**

```yaml
entrypoint: ["/bin/sh", "-c", "ollama serve & sleep 2 && ollama pull mxbai-embed-large && echo 'Model pull complete'"]
```

The `sleep 2` gives the server time to initialize before the pull command. The container exits naturally when the script completes. If the model is already present in the volume, `ollama pull` is a fast no-op.

### 2. Embedding config factory (`apps/mcp-server/src/config/embedding.config.ts`)

Follow the `opensearchConfig` pattern exactly:

```typescript
// Zod schema + registerAs('embedding', ...)
// Fields: ollamaBaseUrl (string URL), model (string), dimensions (number)
```

- **`ollamaBaseUrl`** — `OLLAMA_BASE_URL` env var, default `http://ollama:11434`
- **`model`** — `EMBEDDING_MODEL` env var, default `mxbai-embed-large`
- **`dimensions`** — `EMBEDDING_DIMENSIONS` env var, default `1024`. Use `parseInt(..., 10)` with `z.number().int().min(1)` following the `brokerConfig` pattern for numeric env vars.

Register in `McpServerConfigModule` and export from the config barrel.

### 3. Ollama client service (`apps/mcp-server/src/embedding/ollama-client.service.ts`)

An `@Injectable()` service that wraps the Ollama HTTP API. This is the low-level transport layer — it knows about HTTP and the Ollama API shape, but nothing about embedding semantics.

**API calls:**
- **`embed(text: string): Promise<number[]>`** — calls `POST {baseUrl}/api/embed` with body `{ model, input: text }`. Returns the embedding vector from the response (`response.embeddings[0]`). The Ollama `/api/embed` endpoint accepts a `model` field and an `input` field (string or array of strings). For single-input embedding, pass a string.
- **`isHealthy(): Promise<boolean>`** — calls `GET {baseUrl}/api/tags`. Returns `true` if the response is OK, `false` otherwise. This is used for health checks and graceful degradation.

**HTTP client:** Use the global `fetch` (Node.js built-in). The codebase uses `undici` for long-running agent calls that need custom timeouts, but Ollama embedding calls are short (~150–300ms) and don't require a custom dispatcher. Standard `fetch` with a reasonable `AbortSignal.timeout()` (e.g., 30 seconds) is sufficient.

**Error handling:**
- Network errors (Ollama unreachable): catch and return a typed error result or throw a descriptive error. The caller (`EmbeddingService`) decides whether to propagate or degrade.
- Malformed response (missing `embeddings` field, wrong array length): throw a descriptive error.
- Validate that the returned vector has the expected number of dimensions (from config).

**Constructor injection:** `@Inject(embeddingConfig.KEY) private readonly config: ConfigType<typeof embeddingConfig>`

### 4. Embedding service (`apps/mcp-server/src/embedding/embedding.service.ts`)

An `@Injectable()` service providing the higher-level embedding API. This is the interface that downstream consumers (`OpenSearchStore`, `EmbeddingPipeline`) interact with. It handles the asymmetric embedding logic specified in design decision D3.

**Public API:**
- **`embedDocument(text: string): Promise<number[]>`** — embeds text as-is (no prefix). Used when indexing context records.
- **`embedQuery(text: string): Promise<number[]>`** — prepends the instruction prefix before embedding. Used when searching.
- **`isAvailable(): Promise<boolean>`** — delegates to `OllamaClient.isHealthy()`. Used by consumers to check if embedding is available before attempting it.

**Asymmetric embedding for `mxbai-embed-large`:**
- Document: pass text directly to `OllamaClient.embed(text)`
- Query: pass `"Represent this sentence for searching relevant passages: " + text` to `OllamaClient.embed(prefixedText)`

The query prefix is a constant — store it as a `private readonly` class field or a module-level constant. This prefix is specific to `mxbai-embed-large` and is critical for retrieval quality.

**Error handling:** The service should not throw to callers. Use a try/catch pattern that logs the error and either returns `null` or re-throws in a way that the caller can handle gracefully. The `isAvailable()` check provides a circuit-breaker pattern for callers that want to skip embedding when Ollama is down.

### 5. Embedding module (`apps/mcp-server/src/embedding/embedding.module.ts`)

A NestJS module that:
- Imports `ConfigModule.forFeature(embeddingConfig)` (scoped config import, matching `OpenSearchModule` pattern)
- Provides `OllamaClient` and `EmbeddingService`
- Exports `EmbeddingService` (the public API; `OllamaClient` stays internal)

This module will be imported by `ContextStoreModule` when the OpenSearch backend is selected (in QRM5-005) and by the `EmbeddingPipeline` (in QRM5-006).

### 6. Config barrel and module registration

- Export `embeddingConfig` from `apps/mcp-server/src/config/index.ts`
- Add `embeddingConfig` to the `load` array in `McpServerConfigModule` (`apps/mcp-server/src/config/mcp-server-config.module.ts`)

### 7. Testing strategy

All tests follow QRM5-002 patterns: direct constructor instantiation, `jest.mock()` for externals, save/restore `process.env` for config tests.

**`embedding.config.spec.ts`** (following `opensearch.config.spec.ts` pattern):
- Returns defaults when no env vars set
- Overrides `ollamaBaseUrl` from `OLLAMA_BASE_URL`
- Overrides `model` from `EMBEDDING_MODEL`
- Overrides `dimensions` from `EMBEDDING_DIMENSIONS`
- Falls back to defaults for empty env vars
- Throws for non-numeric `EMBEDDING_DIMENSIONS` (like `brokerConfig` NaN test)

**`ollama-client.service.spec.ts`:**
- Successful embed returns vector of correct dimensions
- Passes correct model and input to Ollama API
- Returns `isHealthy() === true` when `/api/tags` succeeds
- Returns `isHealthy() === false` when Ollama is unreachable
- Throws/returns error on connection failure during embed
- Throws on malformed response (missing embeddings field)
- Throws on dimension mismatch (vector length ≠ configured dimensions)
- Respects configured `ollamaBaseUrl` (custom URL)

Mock `global.fetch` for all HTTP tests — do not make real HTTP calls.

**`embedding.service.spec.ts`:**
- `embedDocument()` calls client with text as-is (no prefix)
- `embedQuery()` prepends the instruction prefix to text
- `embedQuery()` uses exact prefix string: `"Represent this sentence for searching relevant passages: "`
- `isAvailable()` delegates to client health check
- Handles client errors gracefully (logs, returns null or propagates)

Mock `OllamaClient` — test the service in isolation from HTTP transport.

### Key implementation conventions to follow

Based on QRM5-002 and broader codebase analysis:

- **Config pattern:** `registerAs('embedding', () => schema.parse({...}))` with Zod, `||` for env var defaults
- **Config injection:** `@Inject(embeddingConfig.KEY) private readonly config: ConfigType<typeof embeddingConfig>`
- **Logging:** `new Logger(ClassName.name)` — include meaningful messages for health status, embedding failures
- **Error handling:** Degrade gracefully, never throw to callers. Log errors at appropriate levels.
- **No `.js` extensions** in imports (webpack handles resolution)
- **`import type`** for type-only imports used in decorated constructors
- **HTTP:** Use global `fetch` with `AbortSignal.timeout()` — not `@nestjs/axios` or raw `undici`

## Acceptance Criteria

- [ ] `docker-compose.yml` includes an `ollama-init` service that:
  - Uses `ollama/ollama:latest` image
  - Overrides entrypoint to start server, pull `mxbai-embed-large`, then exit
  - Mounts `ollama-data` named volume at `/root/.ollama`
- [ ] `docker-compose.yml` includes an `ollama` runtime service that:
  - Uses `ollama/ollama:latest` image
  - Depends on `ollama-init` with `condition: service_completed_successfully`
  - Mounts `ollama-data` named volume at `/root/.ollama`
  - Has health check via `GET /api/tags`
  - Is connected to `quorum-net`
- [ ] `mcp-server` service depends on `ollama` with `condition: service_healthy`
- [ ] `mcp-server` environment includes `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` with correct defaults
- [ ] `embeddingConfig` factory exists at `apps/mcp-server/src/config/embedding.config.ts` with Zod validation for all three fields (string URL, string model, numeric dimensions)
- [ ] `embeddingConfig` is registered in `McpServerConfigModule` and exported from the config barrel
- [ ] `OllamaClient` service exists at `apps/mcp-server/src/embedding/ollama-client.service.ts` with `embed()` and `isHealthy()` methods
- [ ] `OllamaClient.embed()` calls `POST /api/embed` with correct model and input fields
- [ ] `OllamaClient` validates response structure and dimension count
- [ ] `EmbeddingService` exists at `apps/mcp-server/src/embedding/embedding.service.ts` with `embedDocument()`, `embedQuery()`, and `isAvailable()` methods
- [ ] `embedDocument()` passes text as-is to the client (no prefix)
- [ ] `embedQuery()` prepends `"Represent this sentence for searching relevant passages: "` to the input text
- [ ] `EmbeddingService` handles Ollama unavailability gracefully (logs error, does not crash)
- [ ] `EmbeddingModule` at `apps/mcp-server/src/embedding/embedding.module.ts` wires both services, exports `EmbeddingService`
- [ ] `ollama-data` named volume is declared in `docker-compose.yml`
- [ ] Unit tests for `embeddingConfig` — defaults, env var overrides, empty string fallback, non-numeric dimensions rejection
- [ ] Unit tests for `OllamaClient` — successful embed, health check pass/fail, connection failure, malformed response, dimension mismatch
- [ ] Unit tests for `EmbeddingService` — document vs query prefix, availability check, graceful error handling
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test`)

## Dependencies and References

- **Depends on:** None — this ticket has no prerequisites and can start immediately
- **Blocks:** QRM5-005 (OpenSearchStore needs `EmbeddingService` for search query embedding), QRM5-006 (Async Embedding Pipeline needs `EmbeddingService` for document embedding)
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**

| File | Relevance |
|------|-----------|
| `docker-compose.yml` | Add Ollama services, update mcp-server depends_on and environment |
| `apps/mcp-server/src/config/opensearch.config.ts` | Reference pattern for config factory (string fields) |
| `apps/mcp-server/src/config/broker.config.ts` | Reference pattern for config factory (numeric fields with `parseInt`) |
| `apps/mcp-server/src/config/opensearch.config.spec.ts` | Reference pattern for config tests |
| `apps/mcp-server/src/config/broker.config.spec.ts` | Reference pattern for numeric config tests (NaN throws) |
| `apps/mcp-server/src/config/mcp-server-config.module.ts` | Register new config factory |
| `apps/mcp-server/src/config/index.ts` | Export new config factory |
| `apps/mcp-server/src/context-store/opensearch/opensearch.module.ts` | Reference pattern for module wiring (`ConfigModule.forFeature`) |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.spec.ts` | Reference pattern for service tests with mocked external deps |

**External references:**
- [Ollama API — Embeddings](https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings) — `POST /api/embed` request/response format
- [Ollama API — List Models](https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models) — `GET /api/tags` for health check
- [mxbai-embed-large on Ollama](https://ollama.com/library/mxbai-embed-large) — model details, asymmetric embedding instructions
- [Ollama Docker Hub](https://hub.docker.com/r/ollama/ollama) — container image, volume mount conventions

**Architect review:** Not required. All design decisions for this ticket are resolved in the QRM5-000 roadmap (D3 — model choice, asymmetric embedding, local inference). The implementation is infrastructure wiring and a thin HTTP client with no architectural ambiguity.
