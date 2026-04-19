# QRM5-008: QRM5 Smoke Test Runbook (Live Orchestration)

## Summary

Validate the live QRM5 hybrid search stack end-to-end through a scenario-driven smoke test runbook executed by a Claude Code orchestrator against the running Docker system. The primary deliverable is a sequence of scenarios that exercise every QRM5 surface — OpenSearch backend activation, embedding pipeline, hybrid search, graceful degradation, migration, agent text-first writes — verified via HTTP probes, OpenSearch inspection, and `docker compose logs` monitoring. No new automated tests are written; per-ticket unit tests remain the automated layer.

## Problem Statement

The QRM5 hybrid search stack is fully implemented and activated (QRM5-002 through QRM5-007 shipped; QRM5-009 flipped the backend and upgraded `/health`). The automated test suite stands at **49+ suites / 745 tests**, with QRM5-specific specs for every new component — but automated tests exist only at the unit level. No test verifies that `OpenSearchStore.set()` → event → `EmbeddingPipelineService` → `EmbeddingService.embedDocument()` → OpenSearch partial-update works against a **real** OpenSearch + Ollama stack, under real Docker networking, with real NestJS module wiring.

Initial drafts of this ticket proposed two work streams: (1) a coverage audit across all QRM5 specs with gap-fill tests, and (2) an in-process integration test using a mocked OpenSearch client. Both are deferred (see below). Instead, this ticket adopts the **QRM1-013 pattern**: a scenario-driven runbook that a Claude Code agent can execute against the live containers, observing real behavior in real logs. This matches how the system is actually operated and delivers higher-confidence validation than a mocked integration test, at the cost of determinism in a few LLM-driven scenarios.

## Design Context

### Deferred work streams

**Part 1 — Coverage Audit (deferred).** Systematic per-file audit of the 11 QRM5 spec files against their sources. Deferred: the individual tickets already delivered ~200 QRM5-specific tests with deliberate coverage. A broad audit has diminishing returns relative to a live smoke test that would catch the kinds of defects unit tests miss (networking, module composition, event wiring, real OpenSearch/Ollama protocol quirks).

**Part 2 — In-process Integration Test (deferred).** An `opensearch-integration.spec.ts` spec that mocks `@opensearch-project/opensearch` Client and `global.fetch` while exercising real `OpenSearchStore`, `EmbeddingPipelineService`, `EmbeddingService`, `OllamaClient`, `OpenSearchSetupService`, and real `EventEmitter2` wiring. Deferred: the mock faithfulness required (BM25 scoring approximation, k-NN scoring, pipeline semantics) is significant engineering in itself, and the failure modes it could surface are largely a subset of what the live runbook surfaces. Revisit if CI needs a pre-merge integration gate that doesn't depend on Docker.

### What already exists (baseline)

| Component | Spec file | Tests |
|-----------|-----------|-------|
| `toEmbeddingText()` | `libs/common/src/context-store/to-embedding-text.spec.ts` | ~40 |
| `OllamaClient` | `apps/mcp-server/src/embedding/ollama-client.service.spec.ts` | 10 |
| `EmbeddingService` | `apps/mcp-server/src/embedding/embedding.service.spec.ts` | 8 |
| `EmbeddingPipelineService` | `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | 19 |
| `OpenSearchStore` | `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | ~35 |
| `OpenSearchSetupService` | `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.spec.ts` | 8 |
| `MigrationService` | `apps/mcp-server/src/context-store/opensearch/migration.service.spec.ts` | 16 |
| `opensearchConfig` | `apps/mcp-server/src/config/opensearch.config.spec.ts` | 6 |
| `embeddingConfig` | `apps/mcp-server/src/config/embedding.config.spec.ts` | 7 |
| `contextStoreConfig` | `apps/mcp-server/src/config/context-store.config.spec.ts` | 6 |
| `InMemoryStore` | `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | ~45 |
| `HealthService` (QRM5-009) | `apps/mcp-server/src/health/health.controller.spec.ts` | 9 |

**Total QRM5-related automated tests already in the suite: ~200 across 12 spec files.** This runbook layers live validation on top of that baseline — it does **not** replace it.

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

### Part 1: Coverage Audit — **Deferred**

Systematic review of each QRM5 spec file against its source, filling any gaps found. Not implemented. Rationale: individual tickets delivered ~200 QRM5-specific tests with deliberate coverage; incremental audit value is low relative to the runbook's real-environment validation. Revisit if a specific bug surfaces that a unit test should have caught.

### Part 2: In-process Integration Test — **Deferred**

An `opensearch-integration.spec.ts` spec with mocked OpenSearch Client + mocked `fetch` exercising the real service stack. Not implemented. Rationale: mock faithfulness is a significant engineering lift (hybrid query semantics, k-NN approximation, async pipeline timing) and duplicates coverage of the live runbook below. Revisit if CI needs a pre-merge integration gate that must run without Docker.

### Part 3: Live Smoke Test Runbook

The primary deliverable. This runbook is executed by a Claude Code orchestrator against the running Docker stack — it combines HTTP probes, OpenSearch inspection, `docker compose exec` calls to agents, and `docker compose logs` monitoring to verify every QRM5 surface in a real environment.

**Structure.** The runbook follows the QRM1-013 pattern: numbered scenarios with preconditions, commands, expected outputs, and a final result table. Each run is appended below the runbook as a dated section recording pre-run fixes, per-scenario outcomes, and any bugs found (each bug opens its own `QRM5-BUG-NNN` ticket).

**Execution model.** An orchestrating Claude Code agent runs scenarios sequentially, captures outputs, compares against expectations, and writes a run summary. Deterministic scenarios (HTTP probes, OpenSearch index inspection, log greps) have strict pass/fail criteria. Live-LLM scenarios (agent-driven writes and searches) require Claude Code to interpret agent responses but still check concrete side effects in OpenSearch and logs rather than relying solely on agent self-report.

**Scope vs QRM1-013.** QRM1-013 validated connectivity (registration, invocation, safeguards, basic context relay). This runbook assumes those still pass and focuses only on QRM5-specific behavior: OpenSearch activation, embedding pipeline, hybrid search, graceful degradation, migration, text-first agent writes, health dependency reporting.

#### Scenarios

**Scenario 1: Backend activation & dependency health (deterministic)**

Verify `CONTEXT_STORE_BACKEND=opensearch` is active and `/health` reports both dependencies up.

```bash
docker compose exec mcp-server printenv CONTEXT_STORE_BACKEND
curl -s http://localhost:3000/health | jq .
```

**Expected:**
- `CONTEXT_STORE_BACKEND=opensearch`
- Health body: `{ "status": "ok", "dependencies": { "opensearch": "up", "ollama": "up" } }`

**Scenario 2: OpenSearch index & pipeline provisioned (deterministic)**

Verify `OpenSearchSetupService.onModuleInit()` created the index and hybrid-search pipeline.

```bash
curl -s http://localhost:9200/quorum-context | jq '.["quorum-context"].mappings.properties | keys'
curl -s http://localhost:9200/_search/pipeline/hybrid-search | jq .
```

**Expected:**
- Mapping properties include `scope`, `scopeId`, `compositeKey`, `value`, `embedding`, `embeddingText`, `tokenCount`, `expiresAt`, `updatedAt`
- `embedding` field is `knn_vector` with the configured dimensions (default 1024)
- Pipeline exists with `normalization-processor` using BM25 weight 0.3 + k-NN weight 0.7

**Scenario 3: Migration from `quorum.context` (deterministic, post-startup)**

Verify one-time migration ran on first opensearch-backend startup.

```bash
docker compose logs mcp-server 2>&1 | grep -iE "migration|migrated|quorum\.context"
curl -s "http://localhost:9200/quorum-context/_count" | jq .
```

**Expected:**
- Logs show either `migrated N records` with N matching the pre-existing `quorum.context` entry count, OR `skipped migration: index already populated` / `no quorum.context file` when applicable
- Non-empty migration runs result in a count matching the pre-existing entries; subsequent starts are idempotent (no duplicate imports)

**Scenario 4: Write → BM25 → embedding → hybrid search (live LLM, capstone)**

The core QRM5 promise. Validates write-path indexing, async embedding pipeline, and hybrid search rank.

Step 1 — Ask architect to write a descriptive context record:

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'qrm5-smoke-004',
      caller: 'moderator',
      target: 'architect',
      action: \"Write a context record at project scope with key 'auth-decision' and value describing that the team chose JWT with 15-minute access tokens and 7-day refresh tokens for the user authentication system, because session storage added operational overhead. Confirm the write.\",
      wait: true, depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
"
```

Step 2 — Immediately inspect OpenSearch (BM25-indexed, likely no embedding yet):

```bash
curl -s "http://localhost:9200/quorum-context/_search?q=compositeKey:*auth-decision*" \
  | jq '.hits.hits[0]._source | { compositeKey, embeddingText: (.embeddingText[0:80]), has_embedding: (.embedding != null) }'
```

Step 3 — Wait for embedding pipeline drain, then re-inspect:

```bash
sleep 3
docker compose logs mcp-server --since 30s 2>&1 | grep -iE "embedding|pipeline"
curl -s "http://localhost:9200/quorum-context/_search?q=compositeKey:*auth-decision*" \
  | jq '.hits.hits[0]._source | { has_embedding: (.embedding != null), embedding_dims: (.embedding | length) }'
```

Step 4 — Ask developer to semantically search (no literal key match in the query):

```bash
docker compose exec mcp-server node -e "
  fetch('http://developer:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'qrm5-smoke-004',
      caller: 'moderator',
      target: 'developer',
      action: \"Use the context_query tool in search mode at project scope to find 'how are user sessions handled'. Return the top result's compositeKey and a brief summary of its value.\",
      wait: true, depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
"
```

**Expected:**
- Step 1: `success: true`, architect reports write confirmed
- Step 2: record present in OpenSearch; `embeddingText` populated; `has_embedding` is `false` OR `true` (timing-dependent)
- Step 3: logs show `EmbeddingPipelineService` processed the record; `has_embedding: true`; `embedding_dims: 1024` (or configured dim)
- Step 4: developer returns `project::auth-decision` (or equivalent composite key) even though the search query used different wording — this is the hybrid semantic match working

**Scenario 5: Graceful degradation — Ollama down (deterministic + live LLM)**

Verify writes still succeed with BM25-only indexing when Ollama is unreachable, `/health` reports it, and recovery backfills vectors.

Step 1 — Stop Ollama:

```bash
docker compose stop ollama
sleep 2
curl -s http://localhost:3000/health | jq .
```

**Expected:** `dependencies.ollama: "down"`, `status: "ok"`, HTTP 200 (liveness preserved — no restart loop).

Step 2 — Write a record while Ollama is down:

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'qrm5-smoke-005',
      caller: 'moderator',
      target: 'architect',
      action: \"Write a context record at project scope with key 'degraded-write' and value 'Written while Ollama is down to verify BM25 still works'. Confirm the write.\",
      wait: true, depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
"
curl -s "http://localhost:9200/quorum-context/_search?q=compositeKey:*degraded-write*" \
  | jq '.hits.hits[0]._source | { has_embedding: (.embedding != null) }'
```

**Expected:** Write succeeds, record present, `has_embedding: false`.

Step 3 — Restart Ollama and verify backfill:

```bash
docker compose start ollama
# wait for ollama healthy + embedding pipeline backfill cycle
sleep 15
curl -s http://localhost:3000/health | jq .
curl -s "http://localhost:9200/quorum-context/_search?q=compositeKey:*degraded-write*" \
  | jq '.hits.hits[0]._source | { has_embedding: (.embedding != null) }'
docker compose logs mcp-server --since 60s 2>&1 | grep -iE "backfill|embedding"
```

**Expected:** `dependencies.ollama: "up"`, `has_embedding: true`, logs show backfill of the previously-missing record.

**Scenario 6: Scope isolation & token budget (live LLM)**

Verify hybrid search honors scope filters and `maxTokens` budget.

Step 1 — Write records across scopes:

```bash
# project-scope record via architect
# conversation-scope record via architect (use a specific conversationId)
# conversation-scope record via architect in a different conversation
```

(Compose three invocations analogous to Scenario 4 Step 1 with varied scope/id and long-ish values.)

Step 2 — Search with `maxTokens: 200`:

```bash
docker compose exec mcp-server node -e "
  fetch('http://developer:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'qrm5-smoke-006',
      caller: 'moderator',
      target: 'developer',
      action: \"Call context_query in search mode at conversation scope with conversationId 'conv-A' and maxTokens 200. Return the compositeKeys and total token count.\",
      wait: true, depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
"
```

**Expected:** Only conversation `conv-A` records returned (no project or conv-B leakage); cumulative tokens ≤ 200.

**Scenario 7: Agent text-first context writes (live LLM, prompt verification)**

Verify that QRM5-007 prompt guidelines take effect — agents write descriptive prose, not JSON blobs.

```bash
docker compose exec mcp-server node -e "
  fetch('http://teamlead:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'qrm5-smoke-007',
      caller: 'moderator',
      target: 'teamlead',
      action: \"Record a project-scope context entry summarizing the QRM5 test strategy and confirm the write.\",
      wait: true, depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
"
curl -s "http://localhost:9200/quorum-context/_search?q=scope:project&size=5" \
  | jq '.hits.hits[]._source | { compositeKey, valuePreview: (.value | tostring | .[0:120]) }'
```

**Expected:** `value` fields are natural-language prose (not JSON-stringified objects), `embeddingText` is descriptive. If JSON blobs appear, file `QRM5-BUG-NNN` — prompt guidelines insufficient.

**Scenario 8: Log correlation across pipeline (deterministic, post-hoc)**

After scenarios 4–7, verify correlation IDs and record IDs appear across services.

```bash
docker compose logs 2>&1 | grep qrm5-smoke-004
docker compose logs mcp-server 2>&1 | grep -iE "auth-decision|degraded-write" | head -20
```

**Expected:** `qrm5-smoke-004` appears in `InvocationHandler` (architect + developer) and `MessageBroker` (mcp-server). Record composite keys appear in `OpenSearchStore.set()` and `EmbeddingPipelineService` processing logs.

#### Teardown

```bash
# Restore any stopped containers from Scenario 5 (safety net in case of early abort)
docker compose start ollama
# Optionally reset the index between runs
curl -s -X DELETE http://localhost:9200/quorum-context
docker compose restart mcp-server  # triggers fresh setup + migration
```

#### Result Summary Template

| Scenario | Type | Pass Criteria |
|----------|------|---------------|
| 1. Backend & Health | Deterministic | `opensearch` backend; both deps `up` |
| 2. Index & Pipeline | Deterministic | Index exists with k-NN mapping; hybrid pipeline with 0.3/0.7 weights |
| 3. Migration | Deterministic | Logs show migration decision; count matches expectation |
| 4. Write → Hybrid Search | Live LLM | Embedding populated; semantic search returns record written with different wording |
| 5. Graceful Degradation | Live LLM + Deterministic | Write succeeds without Ollama; `/health` reflects state; backfill on recovery |
| 6. Scope & Budget | Live LLM | Scope isolation honored; token budget enforced |
| 7. Text-first Writes | Live LLM | `value` and `embeddingText` are descriptive prose |
| 8. Log Correlation | Deterministic | Correlation IDs across services; record keys in pipeline logs |

## Acceptance Criteria

- [ ] Part 1 (Coverage Audit) explicitly documented as deferred with rationale in this ticket
- [ ] Part 2 (In-process Integration Test) explicitly documented as deferred with rationale in this ticket
- [ ] Part 3 runbook committed in this ticket with 8 scenarios (backend & health, index & pipeline, migration, write→hybrid search, graceful degradation, scope & budget, text-first writes, log correlation)
- [ ] At least one full run of the runbook executed by a Claude Code orchestrator against the live stack; results appended as a dated run section below the runbook
- [ ] Scenarios 1, 2, 3, 8 (deterministic) pass on the recorded run
- [ ] Scenarios 4, 5, 6, 7 (live LLM) pass on the recorded run, or their failures are filed as `QRM5-BUG-NNN` tickets
- [ ] Any failing scenario or bug discovered has a follow-up ticket opened and linked from the run section

## Dependencies and References

- **Depends on:**
  - QRM5-002..007 (full stack implementation) ✅
  - QRM5-009 (OpenSearch activation + health endpoint) ✅ — scenarios 1 and 5 depend on the upgraded `/health` dependency reporting
  - QRM1-013 (connectivity smoke test) ✅ — the format this runbook follows; basic connectivity is assumed passing
- **Blocks:** Nothing — QRM5-009 already activated the backend. This runbook is post-hoc live validation.
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Reference runbook:** [QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — QRM1 connectivity scenarios + run log format. This ticket's runbook mirrors that structure (numbered scenarios, result table, dated run sections with pre-run fixes and bugs filed).

**Key surfaces exercised:**

| Surface | Scenarios | Source |
|---------|-----------|--------|
| OpenSearch backend activation | 1, 2 | `docker-compose.yml`, `context-store.module.ts` |
| Health endpoint dependency reporting | 1, 5 | `apps/mcp-server/src/health/health.service.ts` |
| Index + hybrid-search pipeline provisioning | 2 | `opensearch-setup.service.ts` |
| Migration from `quorum.context` | 3 | `migration.service.ts` |
| Write path (index + embeddingText + event) | 4, 5, 6, 7 | `opensearch-store.ts` |
| Async embedding pipeline (drain + backfill) | 4, 5 | `embedding-pipeline.service.ts`, `embedding.service.ts`, `ollama-client.service.ts` |
| Hybrid search (BM25 + k-NN) ranking | 4, 6 | `opensearch-store.ts` search path |
| Graceful degradation (Ollama down) | 5 | `opensearch-store.ts`, `embedding.service.isAvailable()` |
| Scope isolation + token budget | 6 | `opensearch-store.ts` search filters |
| Text-first prompt guidelines | 7 | `libs/common/src/prompts/role-prompt-templates.ts` |
| Correlation ID propagation | 8 | `InvocationHandler`, `MessageBroker`, `OpenSearchStore`, `EmbeddingPipelineService` loggers |
