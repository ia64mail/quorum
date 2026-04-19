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

## Chosen Approach: Periodic Backfill Sweep

**Decision:** Option A — periodic backfill sweep. This was selected over two alternatives (see Excluded Approaches below) because it is the smallest change, reuses the existing `backfill()` method with zero modification, and subsumes failure modes beyond Ollama outages (e.g., transient OpenSearch unavailability during the partial-update step in `processItem()`).

### How it works

Run `backfill()` on a recurring timer. The backfill query is already idempotent and bounded (`size: 10000`). When Ollama is up, abandoned records are drained within one sweep cycle. When Ollama is still down, `embedDocument()` returns null for each item, each item enters the retry ladder, hits abandon, and the next sweep picks it up again — a self-healing loop.

### Implementation steps

1. **Add a `setInterval` timer in `onModuleInit()`** — invoke `backfill()` every **60 seconds** (60 000 ms). Use a plain `setInterval` rather than `@Interval` from `@nestjs/schedule` to avoid adding a new dependency; the pipeline already has lifecycle hooks.

2. **Store the interval handle** — add a private `backfillInterval: ReturnType<typeof setInterval> | null = null` field. Assign in `onModuleInit()` after the initial `backfill()` call completes.

3. **Clear the timer in `onModuleDestroy()`** — implement `OnModuleDestroy`, clear the interval handle to prevent leaks during testing and graceful shutdown.

4. **Add a concurrency guard** — add a private `sweeping = false` flag. Wrap the periodic `backfill()` call: if `sweeping` is true, skip silently. Set `sweeping = true` before calling `backfill()`, reset in a `finally` block. This prevents re-entrant sweeps if a previous cycle takes longer than 60s (unlikely, but defensive). Do NOT reuse the `processing` flag — it guards the drain loop, which is a different concern.

5. **Log level discipline** — the existing `backfill()` already logs `'No documents need embedding backfill'` at `debug` level. No change needed for the quiet-when-healthy requirement.

### Files to modify

| File | Change |
|------|--------|
| `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` | Add `backfillInterval` field, `sweeping` guard, `setInterval` in `onModuleInit`, `clearInterval` in `onModuleDestroy` (implement `OnModuleDestroy`) |
| `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | Add unit tests for sweep recovery and concurrency guard |

### Tests

- **Unit test — sweep recovery:** Abandon an item via the retry ladder, then call `backfill()` a second time. Assert the record is re-enqueued and successfully embedded. This proves the periodic sweep is the recovery path.
- **Unit test — concurrency guard:** Trigger two `backfill()` invocations concurrently. Assert only one executes (no double-enqueue of the same record).
- **Unit test — no-op when clean:** Call `backfill()` when no records lack embeddings. Assert no enqueue calls and a `debug`-level log.
- **Optional integration:** Extend Scenario 5 in the QRM5-008 runbook to observe automatic recovery without mcp-server restart.

## Excluded Approaches

### Option B — Ollama availability edge listener (rejected)

Would poll `embeddingService.isAvailable()` every 30s and trigger `backfill()` on a false→true transition. **Rejected because:**
- More code than Option A (state machine for the edge detection, new polling timer, availability tracking).
- Only covers Ollama outages. Does NOT recover records that failed due to transient OpenSearch errors during the `client.update()` partial-update step — those records would remain stuck until restart. Option A's backfill query catches any record missing an embedding, regardless of the failure cause.
- No benefit in the common case (Ollama always up) — same overhead as Option A but more moving parts.

### Option C — Unbounded retry with longer backoff (rejected)

Would remove `MAX_RETRIES` and keep items in the queue indefinitely with a capped backoff (60s). **Rejected because:**
- The in-memory queue grows without bound during extended outages, creating memory pressure for a problem that is better solved at the query level.
- Items in the queue are NOT recovered across mcp-server restarts — the startup `backfill()` handles that case, making the unbounded queue redundant for the restart scenario.
- Keeps failed items hot in memory even when the fix (Ollama recovery) is minutes away. The periodic sweep is more resource-efficient: it queries OpenSearch only every 60s and only for the gap records.

## Acceptance Criteria

- [ ] A `setInterval`-based periodic sweep calls `backfill()` every 60 seconds after module init
- [ ] After a record is abandoned by the retry ladder, the next periodic sweep (within ≤ 60s) re-queues and successfully embeds it without mcp-server restart
- [ ] A `sweeping` concurrency guard prevents re-entrant `backfill()` calls from the timer; the guard is separate from the `processing` flag
- [ ] The interval handle is cleared in `onModuleDestroy()` — no leaked timers during test teardown or graceful shutdown
- [ ] No duplicate embed work on records that already have an `embedding` vector (backfill query already enforces this, but verify in test)
- [ ] Sweep does not spam logs when no abandoned records exist (`debug` level for "No documents need embedding backfill")
- [ ] Unit tests cover: (1) sweep recovers abandoned records; (2) sweep is idempotent under concurrent invocation; (3) sweep is a no-op when index is empty
- [ ] Runbook Scenario 5 (QRM5-008) updated to expect automatic recovery, and the follow-up run confirms it
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass

## Dependencies and References

- **Surfaced by:** [QRM5-008](QRM5-008-tests.md) Run 1, Scenario 5 (2026-04-18)
- **Depends on:** QRM5-006 (embedding pipeline) — unchanged contract
- **Related:** QRM5-009 (activated the backend — this bug only matters in production)

**Key files:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/embedding/embedding-pipeline.service.ts` | Primary fix site — add periodic sweep timer, `sweeping` guard, `onModuleDestroy` |
| `apps/mcp-server/src/embedding/embedding-pipeline.service.spec.ts` | Extend tests — sweep recovery, concurrency guard, no-op when clean |
| `apps/mcp-server/src/health/health.service.ts` | Observational — confirms Ollama state during repro |
| `docs/context-store.md` | Update graceful-degradation table to reflect automatic recovery after fix |