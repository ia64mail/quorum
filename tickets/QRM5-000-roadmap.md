# QRM5 Roadmap — Semantic Search Foundation

## Goal

Replace the Context Store's substring-matching search with **hybrid search** — BM25 full-text + k-NN vector similarity — backed by OpenSearch as a unified storage and retrieval engine. Agents gain intent-based context discovery from their first invocation, without changes to the MCP tool contract. This milestone lays the infrastructure for the Knowledge Base (Phase B) by establishing the embedding pipeline, hybrid scoring, and local inference stack.

## Problem

The Context Store currently uses case-insensitive AND-substring matching on `JSON.stringify(value)`. This fails for semantic intent — an agent searching for "how do agents receive context on startup" won't match records about bootstrap context injection because no single record contains all those substrings.

**Evidence from QRM4 session reports (12 runs, 15 days, 54 commits):**

| Symptom | Evidence | Impact |
|---------|----------|--------|
| **Search misses** | 7 consecutive multi-word queries returned 0 results (Run 10) | Agents fall back to brute-force file reads |
| **Redundant discovery** | Developer read 21 files in Run 5 (62% of tool calls) to understand patterns | Token waste + turns consumed before novel work begins |
| **AND-semantics too strict** | `"SYSTEM_PREAMBLE modifications"` fails because "modifications" ≠ "modified" | Agents must guess exact substrings stored by other agents |
| **Stale accumulation** | `qrm4-status-report` went stale across runs 5–10; no agent updated it | No maintenance lifecycle for stored records |
| **Context growth** | 9 items (Run 6) → 47 items (Run 12), ~5 items per ticket cycle | Substring search degrades as corpus grows |

The gap: agents produce knowledge during work but cannot find it later. Hybrid search solves the retrieval problem; the Knowledge Base (Phase B) solves the quality problem.

## Research Summary

### Framework Evaluation

Seven existing frameworks were evaluated against Quorum's requirements: Mem0, LangGraph, LlamaIndex, Cognee, Graphiti, Letta, CrewAI Memory. **None satisfies the requirements.** Blockers:

1. **Language wall** — every framework with meaningful KB capabilities is Python-first; TypeScript packages are thin API clients requiring a Python sidecar
2. **Abstraction mismatch** — frameworks solve adjacent problems (conversational memory, document RAG, temporal facts) but none addresses multi-dimensional classification with background LLM curation
3. **Storage assumptions** — all frameworks own their storage layer; none operates as a derived view on an existing store

**Decision:** Build custom within NestJS, phased across milestones.

### Design Ideas Borrowed

| Source | Idea | Quorum Application |
|--------|------|--------------------|
| **Graphiti** | Temporal provenance (`valid_at`/`invalid_at`, episode tracing) | KB entries carry temporal validity; staleness detection via code change signals |
| **Cognee** | Dual representation (graph structure + vector embeddings) | Three classification dimensions as typed edges; vector embeddings for intent-based retrieval |
| **LlamaIndex** | Composable ingestion pipeline (parse → extract → classify → embed → store) | Clean architecture for the KB extraction pipeline in Phase B |

### Multi-Milestone Phasing

| Phase | Milestone | Scope |
|-------|-----------|-------|
| **A** | **QRM5 (this milestone)** | Hybrid search infrastructure — OpenSearch, embedding pipeline, unified store |
| **B** | QRM6+ | Knowledge Base extraction pipeline — dimensional taxonomy, LLM transformation, provenance |
| **C** | QRM7+ | Background maintenance — summarization, deduplication, staleness detection, taxonomy alignment |

QRM5 delivers the retrieval infrastructure that Phases B and C build upon.

## Design Decisions

All design decisions are resolved. This section consolidates findings from pre-planning research and clarification sessions.

### D1: Context Store `value` Type — Keep `unknown`

The Context Store serves dual purposes: operational coordination (structured JSON) and knowledge capture (natural language). Forcing everything to string would break `context_summarize` (`{preserved, summary}` objects), status records, config snapshots, and agent-to-agent payloads. The embedding layer handles type heterogeneity at indexing time via the embedding text renderer (see D6).

### D2: Storage Backend — OpenSearch (Unified Hybrid Store)

**Decision:** Replace `InMemoryStore` with `OpenSearchStore` backed by an OpenSearch container. OpenSearch serves as both the primary Context Store backend and the hybrid search engine.

**Rationale — why a unified store, not a separate EmbeddingIndex:**

An earlier design proposed a separate `EmbeddingIndex` subscribing to `context.change` events, maintaining a vector store alongside the existing `Map<string, ContextItem>`. This was rejected in favor of a unified store because:

- **No sync problem** — one store, one truth, one persistence layer
- **No event subscription wiring** — the store itself manages both text and vector indexing
- **Hybrid search is native** — OpenSearch combines BM25 and k-NN scores declaratively via search pipelines, not application code
- **Graceful degradation is built in** — records without vectors yet still match via BM25
- **Cloud scaling is straightforward** — local Docker for dev → AWS OpenSearch Service for production, same API

**Why OpenSearch over alternatives:**

| Criterion | OpenSearch | pgvector + tsvector | Qdrant | Weaviate |
|-----------|-----------|-------------------|--------|----------|
| BM25 quality | Native Lucene — gold standard | PostgreSQL tsvector — solid, not Lucene-grade | Sparse vectors (newer, less proven) | Native Lucene |
| Vector k-NN | Faiss / nmslib / HNSW | HNSW via pgvector | Native HNSW | Native HNSW |
| Hybrid fusion | **Declarative search pipeline** | Manual SQL (CTE/subquery) | `prefetch` + fusion (newer API) | Native `alpha` blending |
| Cloud managed | AWS OpenSearch Service | Every provider (RDS, Cloud SQL) | Qdrant Cloud | Weaviate Cloud |
| NestJS integration | HTTP client, injectable | TypeORM/Prisma — excellent | REST client | REST client |

OpenSearch wins on hybrid search maturity: the normalization-processor pipeline lets you define BM25/vector weight tuning as configuration rather than code. Given that tuning the balance will be iterative, having it declarative is worth the operational footprint.

**`InMemoryStore` is preserved** as the zero-dependency backend for unit tests and local dev without Docker.

### D3: Embedding Model — `mxbai-embed-large` via Local Ollama

**Decision:** Use `mxbai-embed-large` (1024 dimensions, 335M parameters, 670MB) running in a local Ollama container.

**Why local over API:**
- Full data privacy — no context records sent to external services
- Zero marginal cost — no per-token billing
- Predictable latency — ~150–300ms on CPU, no network variability
- Deployment via Docker — same `docker compose up` workflow

**Why `mxbai-embed-large`:**
- Top of the open-source MTEB leaderboard for its parameter class (~64.7 average)
- 1024 dimensions provide rich representation for nuanced technical content
- Disk/memory footprint is acceptable (670MB model, ~4KB per record vector)

**Why not a code-specific model (Voyage `voyage-code-3`, CodeSage, UniXcoder):**

Code embedding models are optimized for code syntax and structure — camelCase tokenization, control flow patterns, function signature matching. They excel at natural-language → code-snippet retrieval and code → code similarity.

Quorum's embedding targets are **natural language about code**, not code itself:
- Agent implementation results: `"Added ### Commit Messages subsection under ## Codebase Conventions..."`
- Design decisions: `"Bootstrap context injection — non-fatal assembly, 1000-token default budget"`
- KB entries (Phase B): `"bootstrap-context.service.ts — implements greedy bin-packing with reverse insertion order"`

Agent queries are also natural language: `"how do agents receive context on startup"`, `"NestJS module wiring conventions"`. A general-purpose model trained on diverse text (including technical writing) is the right tool. If raw source code indexing becomes a future requirement, a second model can be added — OpenSearch supports multiple k-NN fields per index.

**Asymmetric embedding:** `mxbai-embed-large` uses instruction-based asymmetry:
- **Document** (stored passage): embed as-is, no prefix
- **Query** (search input): prepend `"Represent this sentence for searching relevant passages: "` before embedding

The embedding service must wire this distinction from the start — it affects retrieval quality significantly.

### D4: Knowledge Base Format — Markdown from the Start (Phase B Forward Reference)

When the Knowledge Base is built in Phase B, KB entry values will be `string` (markdown text), not `unknown`. Markdown embeds cleanly, injects directly into bootstrap context, and is the native format for LLM consumption. This decision does not affect QRM5 implementation but informs the embedding text renderer design — the renderer must handle `unknown` values well now, knowing that Phase B values will be clean markdown.

### D5: Agent Prompt Guidelines — Encourage Descriptive Text

Update agent role prompts to prefer natural-language text values for knowledge/decision records while keeping JSON acceptable for operational status records. This is a prompt-level change — agents are free to store JSON for operational records, but knowledge records should be written as readable text.

Embedding models produce dramatically better vectors for prose than for JSON:

| Payload style | Embedding quality |
|---------------|-------------------|
| `{"status": "complete", "commit": "da92f8a"}` | Poor — syntax tokens, not meaning |
| `"Implementation complete. Commit da92f8a."` | Good — semantic intent is explicit |

As agents adopt text-first values, embedding quality improves organically.

### D6: Embedding Text Renderer — Deterministic `toEmbeddingText()`

A template-based renderer converts `ContextItem` (with `unknown` value) into natural-language text suitable for embedding. The item key leads the text, giving the embedding model the topic context.

**Algorithm:**

```typescript
function toEmbeddingText(item: ContextItem): string {
  const header = item.key;
  if (typeof item.value === 'string') return `${header}\n\n${item.value}`;
  return `${header}\n\n${renderValue(item.value, 0)}`;
}
```

`renderValue()` walks the JSON structure recursively:
- **Strings, numbers, booleans** → inline as text
- **Arrays** → bulleted lists with indentation
- **Objects** → `"label: value"` lines, with camelCase/snake_case keys converted to space-separated labels
- **Short values** inline on the same line; complex values block-indent on the next line

**Example — real QRM4 record:**

Input (structured JSON):
```json
{
  "key": "QRM4-BUG-015-part0-part1-alignment",
  "value": {
    "status": "complete",
    "commit": "caba7e4",
    "changes": [
      {"file": "quorum.md", "change": "Added ### Commit Messages subsection..."},
      {"file": "libs/common/src/prompts/role-prompt-templates.ts", "change": "Updated ## Git Discipline..."}
    ],
    "verification": "build OK, lint OK, 39 suites 537 tests all pass"
  }
}
```

Output (~180 embedding tokens):
```
QRM4-BUG-015-part0-part1-alignment

status: complete
commit: caba7e4
changes:
  - file: quorum.md
    change: Added ### Commit Messages subsection under ## Codebase Conventions
    with QRMX-NNN prefix convention, bug ticket format, no-ticket format, and examples
  - file: libs/common/src/prompts/role-prompt-templates.ts
    change: Updated ## Git Discipline in SYSTEM_PREAMBLE: changed format from
    <role>(<ticket>): <what changed> to QRMX-NNN: <concise description>
verification: build OK, lint OK, 39 suites 537 tests all pass
```

**Why not LLM summarization?** At ~50 records per milestone, the quality delta doesn't justify the latency and cost. The deterministic renderer gets ~85% of embedding quality. Phase B's KB extraction pipeline will produce LLM-transformed text — embedding quality improves for free when that arrives.

### D7: One Record, One Embedding (No Sub-Chunking)

Context Store records are already semantic units — each captures one discrete decision, result, or observation. At ~180 embedding tokens per record (well within the 128–512 token sweet spot), sub-chunking would produce fragments too small for meaningful embeddings that lose parent context.

**Truncation:** Truncate at the model's max sequence length (512 tokens for `mxbai-embed-large`). This parameter is configurable alongside `EMBEDDING_MODEL`. Token estimation for BERT WordPiece should use a conservative `text.length / 3` ratio rather than the Claude-oriented `text.length / 4` used elsewhere in the codebase. Key information is front-loaded by the renderer, so truncation loses tail detail, not topic context.

> **Note for the architect:** The 512-token max sequence length is based on `mxbai-embed-large-v1` using standard BERT positional encoding. Verify empirically during QRM5-003 implementation: call Ollama `GET /api/show` for model metadata, and test whether a 600-token input produces a different embedding than its 512-token truncation. Some extended-position BERT variants support 2048 or 8192 tokens — if the actual limit is higher, adjust `EMBEDDING_MAX_TOKENS` accordingly.

### D8: Hybrid Search Pipeline — Weighted BM25 + k-NN

OpenSearch's search pipeline combines BM25 text scores and k-NN vector scores declaratively:

```json
{
  "description": "Quorum hybrid search",
  "phase_results_processors": [{
    "normalization-processor": {
      "normalization": { "technique": "min_max" },
      "combination": {
        "technique": "arithmetic_mean",
        "parameters": { "weights": [0.3, 0.7] }
      }
    }
  }]
}
```

- **BM25 leg** (weight 0.3): matches on `embeddingText` field using Lucene analyzer
- **k-NN leg** (weight 0.7): cosine similarity on `embedding` field
- **Normalization**: min-max scales both score distributions to [0,1] before combining
- **Starting weights**: 0.3 BM25 / 0.7 vector. Tunable via pipeline configuration without code changes.

Records without embeddings (async pipeline hasn't delivered yet) still participate in the BM25 leg. This is the "partially available right away" behavior.

### D9: Backward Compatibility — InMemoryStore for Tests, Migration for Existing Data

- `InMemoryStore` remains in the codebase as the zero-dependency backend for unit tests and local dev without Docker
- Existing `quorum.context` records are imported into OpenSearch on first startup via a one-time migration
- The `ContextStore` abstract class is unchanged — `OpenSearchStore` implements the same contract
- All MCP tools (`context_store`, `context_query`, `context_summarize`, `context_stats`) work without changes
- Module wiring swaps `useClass: InMemoryStore` → `useClass: OpenSearchStore` based on configuration

## Technical Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────┐
│  MCP Server                                               │
│                                                           │
│  ┌─────────────────┐     ┌──────────────────────────────┐ │
│  │ OpenSearchStore  │────▶│  OpenSearch container         │ │
│  │ (implements      │     │  • BM25 on embeddingText      │ │
│  │  ContextStore)   │     │  • k-NN on embedding (HNSW)   │ │
│  └────────┬─────────┘     │  • hybrid-search pipeline     │ │
│           │               └──────────────────────────────┘ │
│           │ async enqueue                                  │
│  ┌────────▼─────────┐     ┌──────────────────────────────┐ │
│  │ EmbeddingPipeline │────▶│  Ollama container             │ │
│  │                   │     │  mxbai-embed-large (1024d)    │ │
│  └───────────────────┘     └──────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

`OpenSearchStore` replaces `InMemoryStore` as the production `ContextStore` implementation. No `Map`, no `quorum.context` file — OpenSearch handles storage, indexing, search, and persistence natively.

### OpenSearch Index Mapping

```json
{
  "mappings": {
    "properties": {
      "key":           { "type": "keyword" },
      "scope":         { "type": "keyword" },
      "id":            { "type": "keyword" },
      "value":         { "type": "object", "enabled": false },
      "createdBy":     { "type": "keyword" },
      "createdAt":     { "type": "long" },
      "expiresAt":     { "type": "long" },
      "embeddingText": { "type": "text", "analyzer": "standard" },
      "embedding":     {
        "type": "knn_vector",
        "dimension": 1024,
        "method": {
          "name": "hnsw",
          "space_type": "cosinesimil",
          "engine": "faiss"
        }
      }
    }
  },
  "settings": {
    "index.knn": true,
    "index.knn.space_type": "cosinesimil"
  }
}
```

Key design points:
- `value` is stored but **not indexed** (`"enabled": false`) — it's the raw payload returned to agents, not searched through
- `embeddingText` is the BM25 target — Lucene standard analyzer tokenizes it for full-text search
- `embedding` is the k-NN target — 1024-dimensional vector, HNSW index via Faiss, cosine similarity
- `scope` + `id` + `expiresAt` are keyword/long fields used for scope filtering and TTL enforcement
- Document ID is the composite key (`${scope}:${id ?? '_'}:${key}`)

### Write Path

```
set(params: SetParams)
  │
  ├─ sync ─── build ContextItem from params
  ├─ sync ─── compute embeddingText via toEmbeddingText(item)
  ├─ sync ─── index to OpenSearch: { ...item, embeddingText }  [refresh=true]
  │            → BM25-searchable immediately
  ├─ sync ─── emit 'context.change' event
  │
  └─ async ── enqueue embedding computation → Ollama
                 on completion: partial update OpenSearch doc with embedding vector
                 → hybrid search active for this record
```

`refresh=true` on the index call makes the record BM25-searchable within the same request cycle. The async embedding update arrives in ~150–300ms; subsequent searches include the vector leg.

### Search Path — Hybrid Query

```
search(scope, query, id?, maxTokens?)
  │
  ├─ embed query via Ollama (inputType: 'query', with instruction prefix)
  │
  ├─ send hybrid query to OpenSearch:
  │   ├─ BM25 leg: match on embeddingText field
  │   ├─ k-NN leg: cosine similarity on embedding field
  │   ├─ scope filter: bool filter on scope + id + expiresAt
  │   └─ search_pipeline: 'hybrid-search' (normalization + weighted combination)
  │
  ├─ receive ranked results (hybrid scores)
  │
  └─ apply token budget, return ContextItem[]
```

When the Ollama container is unavailable, the search falls back to BM25-only mode (no k-NN leg). This is still a significant upgrade over the current substring matching.

### TTL Expiration

Two complementary mechanisms:
- **Query-time filter**: every search/get query includes `{ range: { expiresAt: { gte: Date.now() } } }` (or no `expiresAt` set), filtering out expired records at read time — matches current lazy-expiry behavior
- **Periodic cleanup**: a scheduled task deletes expired documents from the index to prevent unbounded growth

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| OpenSearch up, Ollama up | Full hybrid search (BM25 + vector) |
| OpenSearch up, Ollama down | BM25-only search (still better than substring matching) |
| OpenSearch down | System unavailable — same as current InMemoryStore data loss on crash |
| Record just written (no vector yet) | BM25 match only for that record; hybrid for records with vectors |

## Success Criteria

- The Context Store uses OpenSearch as its production storage backend
- `search()` returns results ranked by hybrid BM25 + vector scoring
- Records are BM25-searchable immediately on write (`refresh=true`)
- Embedding vectors are computed asynchronously via local Ollama and available within ~300ms
- Existing MCP tools (`context_store`, `context_query`, `context_summarize`, `context_stats`) work without interface changes
- Agent session resume enables conversational continuity across sequential invocations to the same role
- Hybrid search outperforms substring matching on natural-language queries (measured against QRM4 session report examples)
- The system degrades gracefully when Ollama is unavailable (BM25-only mode)
- `InMemoryStore` remains available for tests and local dev without Docker
- Existing `quorum.context` records are migrated on first OpenSearch startup

## Scope Exclusions

- **Knowledge Base extraction pipeline** (Phase B) — no LLM-based transformation of context records into classified KB entries
- **Background KB maintenance** (Phase C) — no summarization, deduplication, or staleness detection
- **Multi-dimensional indexing** — no by-file / by-feature / by-concept classification (Phase B)
- **Changes to the `ContextStore` abstract class** — the abstract contract remains unchanged
- **Agent-scope context search** — private working memory stays private; hybrid search operates on project and conversation scopes
- **Raw source code indexing** — agents search knowledge about code, not code itself
- **Production cloud deployment** — local Docker only; AWS OpenSearch Service is a future deployment target

---

## Milestone Scope

### QRM5-001 — Agent Session Resume via Moderator-Driven Session Routing

Enable Claude Code SDK session persistence for all agents and let the moderator decide whether follow-up invocations should resume an existing session or start fresh. Agents report their session ID in responses; the moderator tracks session IDs and passes them on follow-up invocations when conversational continuity is beneficial.

This is adjacent to — not part of — the hybrid search infrastructure, but correlates at the efficiency level: session resume reduces redundant context discovery, and hybrid search reduces redundant context queries. Together they address the two main bottlenecks identified in QRM4 session reports.

**Key decisions:**
- Moderator-driven routing (not heuristic-based) — the moderator has full conversation context to judge whether continuity or a clean slate serves the next task
- `persistSession: true` on all agent SDK calls; `resume` parameter plumbed through `InvokeRequest` → `invoke_agent` tool → `ClaudeCodeService`
- Session IDs returned in `InvokeResponse` and tracked by the moderator
- Graceful fallback: if a persisted session is missing (container restart), fall back to fresh session

**Touches:**
- `libs/common/src/messaging/invoke.types.ts` — add `sessionId` to `InvokeRequest` and `InvokeResponse`
- `apps/agent/src/llm/claude-code.service.ts` — `persistSession: true`, pass `resume` param
- `apps/agent/src/llm/claude-code.types.ts` — add `resume` to `ExecuteParams`
- `apps/agent/src/connection/invocation-handler.service.ts` — forward `sessionId` both directions
- `apps/mcp-server/src/mcp/mcp.service.ts` — add `sessionId` to `invoke_agent` tool schema
- `apps/terminal/src/chat/chat.service.ts` — moderator-side session tracking

**Depends on:** —

### QRM5-002 — OpenSearch Infrastructure

Add OpenSearch as a Docker container with the index mapping, hybrid search pipeline, and NestJS configuration.

**Key decisions:**
- Single-node OpenSearch (sufficient for local dev; cluster mode for cloud)
- Disable security plugin for local dev (`DISABLE_SECURITY_PLUGIN=true`) to simplify setup
- Index created on module init with the mapping from the Technical Architecture section
- Hybrid search pipeline created programmatically on startup
- Health check via OpenSearch cluster health API
- NestJS config factory with Zod validation for connection parameters

**Configuration (env vars):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENSEARCH_NODE` | `http://opensearch:9200` | OpenSearch connection URL |
| `OPENSEARCH_INDEX` | `quorum-context` | Index name |
| `OPENSEARCH_USERNAME` | `admin` | Auth username (when security enabled) |
| `OPENSEARCH_PASSWORD` | `admin` | Auth password (when security enabled) |

**Touches:**
- `docker-compose.yml` — add OpenSearch service with health check, volume, and environment
- `apps/mcp-server/src/config/opensearch.config.ts` — new config factory
- `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` — index and pipeline creation on init
- `apps/mcp-server/src/context-store/opensearch/opensearch.module.ts` — module wiring

**Depends on:** —

### QRM5-003 — Ollama Embedding Service

Add Ollama as a Docker container with `mxbai-embed-large` and create the NestJS embedding service.

**Key decisions:**
- Ollama model pre-pulled via **init container** (`ollama-init` service in docker-compose): starts `ollama serve`, pulls `mxbai-embed-large` into shared `ollama-data` volume, then exits. Runtime `ollama` container depends on `ollama-init` with `condition: service_completed_successfully` and uses stock entrypoint.
- `OllamaClient` service — HTTP client wrapping `POST /api/embed`
- `EmbeddingService` — higher-level service handling asymmetric embedding (document vs query prefix)
- Health check: `GET /api/tags` verifies Ollama is running; model availability checked on init
- The service exposes `embedDocument(text: string): Promise<number[]>` and `embedQuery(text: string): Promise<number[]>` — the query method prepends the instruction prefix for `mxbai-embed-large`

**Embedding asymmetry for `mxbai-embed-large`:**
- Document: embed text as-is
- Query: prepend `"Represent this sentence for searching relevant passages: "` before embedding

**Configuration (env vars):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama API endpoint |
| `EMBEDDING_MODEL` | `mxbai-embed-large` | Model name for embedding |
| `EMBEDDING_DIMENSIONS` | `1024` | Vector dimensions (must match index mapping) |

**Touches:**
- `docker-compose.yml` — add Ollama service with volume for model storage, health check
- `apps/mcp-server/src/config/embedding.config.ts` — new config factory
- `apps/mcp-server/src/embedding/ollama-client.service.ts` — HTTP client
- `apps/mcp-server/src/embedding/embedding.service.ts` — document/query embedding with prefix handling
- `apps/mcp-server/src/embedding/embedding.module.ts` — module wiring

> **Note:** Ollama auto-detects NVIDIA GPUs and uses CUDA with no code or config changes. To enable GPU acceleration, add `runtime: nvidia` and `NVIDIA_VISIBLE_DEVICES` to the Ollama service in docker-compose (requires NVIDIA Container Toolkit on the host). Not required for QRM5 — CPU inference at ~150–300ms per embedding is sufficient for the async pipeline — but available as a drop-in optimization if bulk workloads grow.

**Depends on:** —

### QRM5-004 — Embedding Text Renderer

Implement `toEmbeddingText()` in `libs/common` as a shared utility. This function converts a `ContextItem` with an `unknown` value into natural-language text suitable for embedding.

**Key decisions:**
- Lives in `libs/common` (not in the MCP server) because Phase B's KB extraction pipeline will also use it
- Deterministic, no LLM dependency — pure string transformation
- Key-prefixed output: the item key leads the text, providing topic context to the embedding model
- Recursive JSON-to-text rendering: objects become `"label: value"` lines, arrays become bullet lists, camelCase/snake_case keys become space-separated labels
- Truncation at ~500 embedding tokens for oversized records (front-loaded key information preserved)
- Comprehensive tests: string values, objects, nested arrays, edge cases (null, empty, deeply nested)

**Touches:**
- `libs/common/src/context-store/to-embedding-text.ts` — renderer implementation
- `libs/common/src/context-store/to-embedding-text.spec.ts` — tests
- `libs/common/src/context-store/index.ts` — barrel export

**Depends on:** —

### QRM5-005 — OpenSearchStore: Hybrid Context Store

New `ContextStore` implementation backed by OpenSearch. Implements the same abstract class contract — `set()`, `get()`, `getAll()`, `search()`, `getStats()` — with hybrid search replacing substring matching.

**Key decisions:**
- Uses `@opensearch-project/opensearch` client
- Document ID = composite key (same `CompositeKeyBuilder` scheme)
- `set()`: indexes with `embeddingText` immediately (`refresh=true`), enqueues async embedding
- `get()`: exact lookup by composite key with lazy TTL check
- `getAll()`: prefix-filtered query on `scope` + `id` fields with TTL filter
- `search()`: hybrid query — BM25 on `embeddingText` + k-NN on `embedding`, combined via `hybrid-search` pipeline, with scope/TTL filter and token budget
- `getStats()`: aggregation query counting live items and estimating tokens
- Emits `'context.change'` events (same `EventEmitter2` pattern as `InMemoryStore`)
- When Ollama is unavailable, `search()` falls back to BM25-only query (no k-NN leg)
- TTL enforcement: query-time range filter on `expiresAt` + periodic cleanup of expired docs

**Touches:**
- `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` — store implementation
- `apps/mcp-server/src/context-store/context-store.module.ts` — conditional `useClass` based on config
- `apps/mcp-server/src/config/context-store.config.ts` — extend with backend selection

**Depends on:** QRM5-002, QRM5-003, QRM5-004

### QRM5-006 — Async Embedding Pipeline

Background service that computes embeddings for newly written Context Store records and updates OpenSearch with the vector.

**Key decisions:**
- `EmbeddingPipeline` service with an internal queue
- On enqueue: compute embedding via `EmbeddingService.embedDocument()`, then partial-update the OpenSearch document with the vector
- Bulk backfill on startup: query OpenSearch for documents without `embedding` field, batch-embed via Ollama, update
- Graceful degradation: if Ollama is unavailable, log warning and skip — records remain BM25-searchable
- Error handling: failed embeddings are re-enqueued with exponential backoff (max 3 retries), then abandoned with a warning
- Batch size: configurable, default 32 records per Ollama API call for bulk operations

**Touches:**
- `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` — pipeline implementation
- `apps/mcp-server/src/embedding/embedding.module.ts` — wire pipeline service

**Depends on:** QRM5-003, QRM5-005

### QRM5-007 — Data Migration & Agent Prompt Guidelines

Two concerns bundled: import existing data into OpenSearch and update agent prompts for text-first values.

**Migration:**
- On first startup, if `quorum.context` file exists and OpenSearch index is empty, import all records
- Each record is indexed with computed `embeddingText`; embedding vectors are computed via the bulk backfill path (QRM5-006)
- After successful import, the `quorum.context` file is preserved (not deleted) as a backup
- Migration is idempotent — if records already exist in OpenSearch, skip

**Prompt guidelines:**
- Update role prompts (developer, architect, teamlead) with guidance in the `context_store` usage section
- Knowledge/decision records should be written as natural-language text
- Operational status records (structured JSON) remain acceptable
- Include examples of good vs poor embedding quality payloads

**Touches:**
- `apps/mcp-server/src/context-store/opensearch/migration.service.ts` — one-time import logic
- `libs/common/src/prompts/role-prompt-templates.ts` — add text-first guideline to relevant role templates

**Depends on:** QRM5-005, QRM5-006

### QRM5-008 — Tests

Comprehensive test coverage for all new components.

**Test coverage:**

| Component | Key test scenarios |
|-----------|-------------------|
| `toEmbeddingText()` | String values, objects, nested arrays, null/empty, camelCase key conversion, truncation at 500 tokens |
| `OllamaClient` | Successful embed, connection failure, timeout, malformed response |
| `EmbeddingService` | Document vs query prefix, dimension validation |
| `EmbeddingPipeline` | Enqueue + drain, bulk backfill, Ollama unavailable (graceful skip), retry on failure |
| `OpenSearchStore.set()` | Index with embeddingText, refresh behavior, TTL conversion, change event emission |
| `OpenSearchStore.get()` | Exact lookup, lazy TTL expiration, missing key |
| `OpenSearchStore.getAll()` | Scope filtering, TTL filtering, empty scope |
| `OpenSearchStore.search()` | Hybrid query construction, BM25-only fallback, token budget enforcement, scope filtering |
| `OpenSearchStore.getStats()` | Item count, token estimation, scope filtering |
| `Migration` | Import from quorum.context, idempotent re-run, empty file, missing file |
| Integration | End-to-end: write record → verify BM25 searchable → verify hybrid searchable after embedding |

**Testing strategy:**
- Unit tests mock the OpenSearch client and Ollama HTTP client
- Integration tests use a real OpenSearch container (testcontainers or docker-compose test profile)
- `InMemoryStore` tests remain unchanged — they validate the abstract contract independently

**Touches:**
- `libs/common/src/context-store/to-embedding-text.spec.ts`
- `apps/mcp-server/src/embedding/*.spec.ts`
- `apps/mcp-server/src/context-store/opensearch/*.spec.ts`
- `apps/mcp-server/src/context-store/in-memory-store.spec.ts` — verify unchanged behavior

**Depends on:** QRM5-004, QRM5-005, QRM5-006, QRM5-007

### QRM5-009 — Configuration & Documentation

Docker Compose updates, environment variable documentation, and system documentation reflecting the new architecture.

**Touches:**
- `docker-compose.yml` — OpenSearch + Ollama services, volumes, health checks, MCP server environment additions
- `docs/context-store.md` — update to reflect OpenSearch backend, hybrid search, embedding pipeline; move OpenSearch from "Future Enhancements" to the main architecture section
- `docs/context-management.md` — update search behavior description (hybrid replaces substring)
- `docs/system-design.md` — update container diagram and context management section

**Depends on:** QRM5-005, QRM5-006

---

## Dependency Graph

```
QRM5-001 (Session Resume) ─── independent track, no dependencies ───────────────────────┐
                                                                                         │
QRM5-002 (OpenSearch Infra) ──┐                                                          │
QRM5-003 (Ollama Service)  ───┼─→ QRM5-005 (OpenSearchStore) ──→ QRM5-006 (Pipeline) ──┐│
QRM5-004 (Text Renderer)   ──┘                                                          ││
                                                                                         ││
                                  QRM5-007 (Migration + Prompts) ←── QRM5-005 + QRM5-006 ││
                                                                                         ││
                                  QRM5-008 (Tests) ←── QRM5-004 + QRM5-005 + QRM5-006   ││
                                                        + QRM5-007                       ││
                                                                                         ││
                                  QRM5-009 (Config + Docs) ←── QRM5-005 + QRM5-006 ─────┘│
                                                                                          │
                            All tickets ──────────────────────────────────────────────────┘
```

**Parallel tracks:**
- QRM5-001 (session resume) is fully independent — can start immediately and run in parallel with all other work
- QRM5-002 (OpenSearch), QRM5-003 (Ollama), and QRM5-004 (text renderer) have no interdependencies — all three can start simultaneously
- QRM5-005 (store implementation) is the critical path — it depends on QRM5-002, QRM5-003, and QRM5-004
- QRM5-006 (pipeline) depends on QRM5-003 and QRM5-005
- QRM5-007, QRM5-008, QRM5-009 run after the core implementation is stable

## Implementation Notes for Agents

### Existing Code References

| Component | File | Purpose |
|-----------|------|---------|
| `ContextStore` abstract class | `libs/common/src/context-store/context-store.abstract.ts` | Contract all backends implement |
| `ContextItem`, `SetParams`, `ChangeEvent` types | `libs/common/src/context-store/context-store.types.ts` | Core type definitions |
| `CompositeKeyBuilder` | `libs/common/src/context-store/composite-key-builder.ts` | Scope-aware key construction |
| `InMemoryStore` | `apps/mcp-server/src/context-store/in-memory-store.ts` | Current backend (reference implementation) |
| `ContextStoreModule` | `apps/mcp-server/src/context-store/context-store.module.ts` | Module wiring (`useClass` swap point) |
| `contextStoreConfig` | `apps/mcp-server/src/config/context-store.config.ts` | File persistence config |
| MCP tool handlers | `apps/mcp-server/src/mcp/mcp.service.ts` | `context_store`, `context_query`, `context_summarize`, `context_stats` |
| Role prompt templates | `libs/common/src/prompts/role-prompt-templates.ts` | System preamble + per-role prompts |
| `invoke_agent` tool schema | `apps/mcp-server/src/mcp/mcp.service.ts` | Tool registration (add `sessionId` param) |
| `InvokeRequest` / `InvokeResponse` | `libs/common/src/messaging/invoke.types.ts` | Messaging types (add `sessionId` field) |
| `ClaudeCodeService` | `apps/agent/src/llm/claude-code.service.ts` | SDK wrapper (`persistSession` flag at line ~39) |
| `ExecuteParams` / `ExecuteResult` | `apps/agent/src/llm/claude-code.types.ts` | SDK call types (add `resume` param) |
| `InvocationHandler` | `apps/agent/src/connection/invocation-handler.service.ts` | Request → SDK → response mapping |
| Docker Compose | `docker-compose.yml` | Container definitions |

### Codebase Conventions

- **NestJS module pattern**: `@Injectable()` services, wired in `*.module.ts` providers/exports
- **Config**: `registerAs` factories with Zod validation, inject via `@Inject(config.KEY)` with `ConfigType<typeof config>`
- **Testing**: `Test.createTestingModule()`, save/restore `process.env` for env var tests
- **Imports**: No `.js` extensions (webpack handles it), `import type` for type-only imports in decorated constructors
- **Error handling**: Services return error values or degrade gracefully, never throw to callers
- **Logging**: `new Logger(ClassName.name)`, include correlationId in messages
- **Barrel exports**: Named exports from `index.ts` files
- **Event emission**: `EventEmitter2` via `EventEmitterModule.forRoot()`, listeners use `@OnEvent('context.change')`

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| OpenSearch container adds ~512MB–1GB RAM | Low | Acceptable for dev; production uses managed service |
| Ollama model download on first start (~670MB) | Low | One-time; volume persists model across restarts |
| OpenSearch unavailability breaks Context Store | Medium | Health check + restart policy; InMemoryStore as fallback config option |
| Embedding quality for JSON values | Low | `toEmbeddingText()` renderer + D5 prompt guidelines mitigate; Phase B KB entries will be pure markdown |
| Hybrid weight tuning (0.3/0.7 starting point) | Low | Tunable via pipeline config without code changes; measure against QRM4 session report queries |

## Phase B/C Forward References

QRM5 is designed to support subsequent phases without rework:

| Future Capability | QRM5 Foundation |
|-------------------|-----------------|
| KB entries (Phase B) | OpenSearch index can hold KB entries alongside context records (same or separate index); `toEmbeddingText()` handles markdown values cleanly |
| Multi-dimensional classification (Phase B) | OpenSearch supports additional keyword fields for dimension tags (by-file, by-feature, by-concept) — additive mapping change |
| LLM extraction pipeline (Phase B) | `EmbeddingService` and `EmbeddingPipeline` are reusable for KB entry embedding |
| Background maintenance (Phase C) | OpenSearch's update-by-query enables bulk staleness detection and cleanup |
| `knowledge_query` MCP tool (Phase B) | Hybrid search infrastructure is shared; KB queries use the same pipeline with different index/filters |
| Provenance metadata (Phase B) | OpenSearch document structure is extensible — add fields to the mapping without migration |

## References

- [docs/knowledge-management.md](../docs/knowledge-management.md) — Knowledge management vision (three domains, lifecycle, KB concept)
- [docs/context-store.md](../docs/context-store.md) — Current Context Store implementation (InMemoryStore, abstract class, file persistence)
- [docs/context-management.md](../docs/context-management.md) — MCP API for context sharing, bootstrap context injection
- [docs/system-design.md](../docs/system-design.md) — Overall architecture, containers, deployment
- [QRM5-001-agent-session-resume.md](QRM5-001-agent-session-resume.md) — Full design for agent session resume (moved from pre-planning)

---

*Pre-planning artifacts consolidated into this roadmap: `tickets/tmp/research-knowledge-management-analysis.md` (research analysis), `tickets/tmp/QRM5-semantic-search-design-decisions.md` (design decisions draft). These tmp files are superseded by this document.*