# QRM5-BUG-004: Embedding Pipeline Abandons Records After Short Backoff, No Recovery Until Restart

## Summary

When `EmbeddingPipelineService` hits an Ollama failure, it retries 3 times with exponential backoff (1s → 2s → 4s, total ~7s) and then permanently abandons the record. Abandoned records never get re-embedded for the lifetime of the mcp-server process — the only recovery path is `onModuleInit()` backfill, which runs once at startup. In practice this means any Ollama outage longer than ~7s leaves affected records stuck with `embeddingText` but no `embedding` vector, demoted to BM25-only matching, until someone restarts mcp-server.

## Problem Statement

Reproduced during QRM5-008 smoke test Scenario 5 on 2026-04-18:

1. Ollama stopped via `docker compose stop ollama`.
2. Architect wrote `degraded-write-smoke` at project scope — succeeded, BM25-indexed.
3. `EmbeddingPipelineService` enqueued the record, retried 3× with 1/2/4s backoff, logged `Abandoned embedding for [project:_:degraded-write-smoke] after 3 retries` at 00:37:06.
4. Ollama restarted at ~00:38, `/health` reported `ollama: up` immediately.
5. Record remained with `has_embedding: false` for the next several minutes — no retry, no re-queue, no backfill.
6. Only `docker compose restart mcp-server` (triggering startup `backfill()`) produced `Backfilling embeddings for 1 document(s)` → `Embedded document [project:_:degraded-write-smoke]`.

**Impact:** graceful degradation is advertised by the QRM5 design (`docs/context-store.md`, runbook Scenario 5 expectations) as "BM25 immediately, hybrid once the vector arrives." With this bug, the "once the vector arrives" promise only holds if Ollama's outage is shorter than the retry budget. A typical Ollama restart (model reload, container update) takes 10–30s, well beyond the 7s ceiling. Those records silently lose hybrid-search quality until someone notices and restarts mcp-server.

**Same class of issue as QRM1-BUG-002** (silent acceptance of a rejection), inverted: there the agent never knew registration had failed; here the pipeline never re-attempts work it knows failed.

## Design Context

### Current retry logic

`apps/mcp-server/src/embedding/embedding-pipeline.service.ts`:

| Constant | Value | Effect |
|----------|-------|--------|
| `MAX_RETRIES` (line 12) | 3 | Retry count before abandoning |
| `MAX_BACKOFF_MS` (line 15) | 8000 | Cap on delay per retry |
| Backoff formula (line 178) | `1000 * 2 ** retryCount` | 1s, 2s, 4s, 8s, 8s, ... |
| Total budget | ~7s | 1+2+4 before abandon |

On abandon (line 171–176), the item is dropped from the queue and never seen again. There is no dead-letter list, no timer that re-sweeps, and no listener for Ollama availability recovery.

### Existing recovery surface

`backfill()` (line 188) does exactly the right thing — queries for `embeddingText exists AND embedding not exists`, enqueues each `_id`. It's just only called from `onModuleInit()` (line 64). A periodic invocation, or one triggered by an availability edge, would close the gap.

### Why the budget is this short

The constants pre-date the hybrid search activation. The assumption encoded is "Ollama flakes momentarily during a single embed call" — not "Ollama can be down for a sustained period." QRM5-009 activated the backend into production use; the runbook smoke test is the first exercise of the sustained-outage path.

## Implementation Details

Multiple viable fixes; pick one. Preferred: option A (periodic backfill) because it is the smallest change and subsumes the other failure modes (including transient OpenSearch unavailability during the partial-update step).

### Option A — Periodic backfill sweep (preferred)

Run `backfill()` on a timer (`@Interval` from `@nestjs/schedule`, or a plain `setInterval` in `onModuleInit`). Interval: 60–120s. The backfill query is already idempotent and bounded (`size: 10000`). When Ollama is up, abandoned records are drained within one sweep. When Ollama is still down, `embedDocument()` returns null, each item enters the retry ladder, hits abandon, and the next sweep picks it up again.

Gotcha: make sure the sweep doesn't re-enter while a previous sweep is still draining — guard with the existing `processing` flag or a dedicated `sweeping` flag.

**Files:** `embedding-pipeline.service.ts` (add `backfillIntervalHandle`, start in `onModuleInit`, clear in `onModuleDestroy`), add `@nestjs/schedule` dependency if not already present (check `package.json`).

### Option B — Ollama availability edge listener

Add a polling check (every 30s) on `embeddingService.isAvailable()`. When it transitions from false → true, call `backfill()` once. Lighter overhead when healthy, more code than option A. No benefit when Ollama is always up but OpenSearch update calls are flaky.

### Option C — Unbounded retry with longer backoff

Remove `MAX_RETRIES`, cap backoff at a larger value (60s), keep items in the queue forever. Simplest change, but the in-memory queue now grows without bound during extended outages, and items aren't recovered across mcp-server restarts (the startup backfill already handles that case). **Not preferred.**

### Tests

- Unit test: abandoned items are picked up by a second `backfill()` call (proves the sweep is the recovery path).
- Unit test: concurrent `backfill()` invocations don't double-enqueue the same record (concurrency guard).
- Optional — integration: extend the Scenario 5 runbook to observe automatic recovery without mcp-server restart.

## Acceptance Criteria

- [ ] After a record is abandoned by the retry ladder, a subsequent sweep (within ≤ 2 minutes of Ollama recovery) re-queues and successfully embeds it without mcp-server restart
- [ ] No duplicate embed work on records that already have an `embedding` vector (backfill query already enforces this, but verify in test)
- [ ] Sweep/re-check does not spam logs when no abandoned records exist (`debug` level for "no documents need backfill")
- [ ] Unit tests cover: sweep recovers abandoned records; sweep is idempotent under concurrent invocation; sweep is a no-op when index is empty
- [ ] Runbook Scenario 5 (QRM5-008) updated to expect automatic recovery, and the follow-up run confirms it
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass

## Dependencies and References

- **Surfaced by:** [QRM5-008](QRM5-008-tests.md) Run 1, Scenario 5 (2026-04-18)
- **Depends on:** QRM5-006 (embedding pipeline) — unchanged contract
- **Related:** QRM5-009 (activated the backend — this bug only matters in production)

**Key files:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` | Primary fix site — add periodic sweep |
| `apps/mcp-server/src/embedding/embedding.service.ts` | `isAvailable()` for option B |
| `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | Extend tests |
| `apps/mcp-server/src/health/health.service.ts` | Observational — confirms Ollama state during repro |
| `docs/context-store.md` | Update graceful-degradation table to reflect automatic recovery after fix |