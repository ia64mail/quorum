# QRM7-016: Context Store Search Observability

**Status:** Done (2026-05-15)

## Summary

Add a dedicated structured log stream `/app/logs/context-search-{startupTimestamp}.jsonl` that captures every `context_query mode=search` invocation in full detail — the verbatim query, scope/id filters, engine choice (hybrid vs BM25-only), top results with scores and snippets, and token-budget truncation flag. The existing one-line debug entry in the main MCP log is replaced with a **breadcrumb** that carries a `queryId` UUID linking back to the detailed record. Purpose: make context-search quality auditable offline without wading through MCP plumbing in the main log, and enable feeding the stream directly into a relevance-eval script later.

## Problem Statement

Today the only artifact of a context search is a single debug line in `mcp-server-*.jsonl`:

```
context_query: scope=conversation mode=search id=abc-123 query="auth token strategy" → 5 item(s)
```

That tells us a search happened. It does **not** tell us:

- Which items came back (keys, scores, snippets).
- Whether hybrid BM25+k-NN or BM25-only fired (the embedding service can silently fall back when Ollama is unreachable; see `opensearch-store.ts:211-260`).
- How OpenSearch ranked the hits (the `_score` values are dropped before `ContextItem[]` is returned).
- Whether the token budget truncated lower-ranked hits that might have been more semantically relevant.
- How long the query took, and whether it errored.

Without this, **search quality is impossible to evaluate**. Two failure modes go unnoticed today:

1. **Silent fallback to BM25-only** — if the embedding sidecar is degraded, hybrid search downgrades transparently. Quality drops; nothing in the logs flags it.
2. **Bad relevance** — agents complain about missing context, but we can't reconstruct what the query saw vs what was in the store without ad-hoc OpenSearch poking.

The cost of capturing this is small (one log record per search; ~5–10 search calls per agent turn) and the analysis payoff is high while we iterate on OpenSearch tuning, embedding model choice, and prompt-side query phrasing.

## Design Context

The choice of a **separate stream** (vs. enriching the existing MCP log line) is deliberate:

- The analysis workflow is "dump all search records → eyeball relevance / score distribution / engine choice." That's painful when interleaved with `register_agent`, `invoke_agent`, session lifecycle, and SSE keepalive plumbing in the main log.
- The stream is dense per record (~1 KB with 10 hits and snippets) but low frequency (~5–10/agent turn). A separate file stays small while the main MCP log compresses well.
- Feeds cleanly into a future relevance-eval script: `jq -c '.results[] | {score, key}' context-search-*.jsonl` works out of the box.

The **breadcrumb** in the main MCP log preserves correlationId-based tracing: from any `invoke_agent` call, an operator can follow `correlationId` → `context_query` breadcrumbs (with `queryId`) → detailed records in the trace file.

The trace stream is observability, not protocol — agents and the moderator never see it. No MCP tool changes. No client-side work. Pure server-side instrumentation.

## Implementation Details

### Trace record schema

One JSONL record per `context_query mode=search` invocation. Fields:

| Field | Type | Notes |
|-------|------|-------|
| `timestamp` | ISO 8601 string | Wall-clock at search start |
| `queryId` | string | UUID v4, also emitted in the main-log breadcrumb |
| `correlationId` | string \| null | Session correlationId; `null` for project-scope searches |
| `callerRole` | string | Resolved from session state (`McpService.sessionStates`) |
| `scope` | `"project"` \| `"conversation"` \| `"agent"` | |
| `id` | string \| null | `correlationId` for non-project; `null` for project |
| `queryText` | string | Verbatim query argument; never truncated |
| `maxTokens` | number | Effective budget (explicit arg, else `config.context.defaultMaxTokens`) |
| `engine` | `"hybrid"` \| `"bm25-only"` \| `"memory"` | Hybrid only fires when embedding service returns a vector |
| `durationMs` | number | OpenSearch round-trip time |
| `hitCountRaw` | number | Hits returned by OpenSearch before token-budget truncation |
| `hitCountReturned` | number | Hits actually included in the `ContextItem[]` returned to caller |
| `truncatedByTokenBudget` | boolean | `true` iff `hitCountReturned < hitCountRaw` |
| `results` | `Hit[]` | Top hits, ordered by score descending; one entry per raw hit |
| `errorMessage` | string \| null | OpenSearch / embedding-service failure surface; `null` on success |

`Hit` shape:

| Field | Notes |
|-------|-------|
| `key` | `ContextItem.key` |
| `score` | OpenSearch `_score` (BM25, k-NN, or hybrid fused) |
| `snippet` | First 200 chars of `JSON.stringify(value)` — enough to eyeball relevance without exploding the file |
| `tokensEstimate` | Same estimator used by `OpenSearchStore` to enforce the budget |
| `includedInResult` | `true` if this hit landed in the caller's returned `ContextItem[]`; `false` if cut by the budget |

Out of scope for this ticket: capturing the raw OpenSearch query body (vector dims explode the record) and per-leg BM25 / k-NN sub-scores (the fused `_score` is what we have today; the SDK doesn't expose pre-fusion scores cleanly).

### Capture path

`ContextStore.search()` currently returns `Promise<ContextItem[]>`. Extend the abstract method with an **optional trace callback**:

```ts
abstract search(
  scope: ContextScope,
  query: string,
  id?: string,
  maxTokens?: number,
  onTrace?: (trace: SearchTrace) => void,
): Promise<ContextItem[]>;
```

`SearchTrace` is the backend-shaped subset of the schema above (engine, hits with score/snippet, raw vs returned counts, durationMs, errorMessage). The McpService layer wraps it with the session/correlation/queryId fields and emits the record.

Callback rather than a return-type change because:

- Most consumers (agents calling `context_query`) don't need the trace — keeping the public return type `ContextItem[]` avoids touching them.
- The callback can be called inside `try`/`finally` so the trace lands even on partial OpenSearch errors.
- The InMemoryStore path can pass a degenerate trace (`engine="memory"`, scores omitted) without forcing the OpenSearch fields to be optional everywhere.

### Breadcrumb in the main MCP log

Replace the existing debug line at `mcp.service.ts:669-672`:

```ts
this.logger.debug(
  `context_query: scope=${scope} mode=search ` +
    `id=${id ?? '_'} queryId=${queryId} query="${args.query ?? ''}" ` +
    `engine=${engine} → ${items.length} items (top_score=${topScore?.toFixed(2) ?? '_'})`,
);
```

`queryId`, `engine`, and `topScore` come from the trace callback. The breadcrumb stays a single line so it doesn't dominate the main MCP log.

### Trace logger service

New `ContextSearchTraceLogger` under `apps/mcp-server/src/observability/`. Owns its own winston file transport at `${LOG_JSON_DIR}/context-search-{startupTimestamp}.jsonl` using the same JSONL shape as `QuorumLogger` for grep-compat (`timestamp`, `level=info`, `context=ContextSearchTrace`, `message=<queryId>`, `extra=<full schema above>`). One instance, started in `onModuleInit`. Lifetime tied to the mcp-server container, same as other logs in `/app/logs/`.

Implementation hint: lift the JSON-format and file-transport setup from `LoggerBuilder.build()` into a small helper; do not extend `QuorumLogger` itself — this stream is intentionally separate from the general logger so its records are uncorrelated with NestJS log levels.

### Modes not covered

- `mode=keys` — deterministic lookup, no relevance to evaluate. Existing debug breadcrumb stays.
- `mode=get-all` — bulk return, no scoring. Existing debug breadcrumb stays.

`context_summarize` is also out of scope for this ticket — it has its own observability story.

### Touches

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/context-store/context-store.abstract.ts` | Modified | Add `onTrace?` parameter to `search()`; export `SearchTrace` type |
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` | Modified | Populate trace inside `search()`; capture engine choice, raw hit count, scores, durationMs, errorMessage |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Modified | Populate degenerate trace (`engine="memory"`); keeps spec parity even though production runs OpenSearch |
| `apps/mcp-server/src/observability/context-search-trace-logger.service.ts` | Created | New service; owns the JSONL file transport |
| `apps/mcp-server/src/observability/observability.module.ts` | Created | Exports `ContextSearchTraceLogger` |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Modified | Inject `ContextSearchTraceLogger`; generate `queryId`; emit trace + breadcrumb |
| `apps/mcp-server/src/mcp/mcp.module.ts` | Modified | Import `ObservabilityModule` |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | Modified | Cover trace callback for in-memory path |
| `apps/mcp-server/src/context-store/opensearch/opensearch-store.spec.ts` | Modified | Cover hybrid + bm25-only + error trace emission |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | Modified | Cover breadcrumb format + trace logger invocation |
| `docs/context-store.md` | Modified | Document the new stream and how to read it |
| `tools/session-report/SESSION-REPORT.md` | Modified | Note the new artifact alongside existing JSONL streams |

`parse-logs.mjs` is left untouched for now — its current report shape doesn't need search-quality data, and the new stream is consumed by ad-hoc analysis. A future ticket can fold it in.

### Sequencing

Independent. No dependencies on open QRM7 tickets. Land alongside or after QRM7-006 (test gap-fill) since both touch mcp-server spec files.

## Acceptance Criteria

- [x] Every `context_query mode=search` call produces one record in `/app/logs/context-search-{startupTimestamp}.jsonl` matching the schema above
- [x] Main MCP log breadcrumb includes `queryId`, `engine`, and `top_score`
- [x] Trace distinguishes `engine=hybrid` from `engine=bm25-only`
- [x] Trace records `truncatedByTokenBudget=true` when the token budget cuts hits
- [x] Trace records `errorMessage` and `engine=null` (or the closest valid value) when OpenSearch throws
- [x] InMemoryStore path emits a degenerate trace (`engine=memory`) for parity
- [x] No behavioral change to `context_query` from the caller's perspective (same `ContextItem[]` returned, same return-type shape)
- [x] Unit tests cover hybrid trace, BM25-only trace, error trace, and InMemoryStore trace
- [x] `docs/context-store.md` and `tools/session-report/SESSION-REPORT.md` document the new stream
- [x] `npm run lint` clean, `npm run test` passes (new tests + no regression in the 760-test baseline)

## Dependencies and References

**Depends on:** —

**Blocks:** —

**References:**

- `apps/mcp-server/src/mcp/mcp.service.ts:608-689` — `registerContextQueryTool` (breadcrumb + trace emission site)
- `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts:196-285` — `OpenSearchStore.search()` (engine choice, hit iteration, token-budget truncation site)
- `apps/mcp-server/src/context-store/in-memory-store.ts:187+` — `InMemoryStore.search()` (degenerate trace site)
- `libs/common/src/context-store/context-store.abstract.ts:81-86` — `search()` signature (extend with `onTrace?`)
- `libs/common/src/logger/logger.builder.ts:108-138` — JSONL file-transport pattern to mirror in the trace logger
- [docs/context-store.md](../docs/context-store.md) — context store concepts and current API
- [docs/context-management.md](../docs/context-management.md) — three-scope model and tool surface