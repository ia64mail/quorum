# QRM5-BUG-006: ContextStoreModule forRoot() Called Twice — Every Provider Duplicated

## Summary

`ContextStoreModule.forRoot()` is invoked in two places in the mcp-server module graph. NestJS deduplicates dynamic modules by the returned descriptor's reference identity, so each call registers a fresh module and every provider inside it (`OpenSearchStore`, `MigrationService`, `EmbeddingPipelineService`, the `ContextStore` token binding) is instantiated twice. The most visible symptom is every log line from these providers appearing twice in `docker compose logs mcp-server`, but the underlying defect also means every `context.change` event is handled twice, the periodic backfill sweep runs twice, and migration is attempted twice at startup (it's idempotent, so it skips on the second pass).

## Problem Statement

Observed during QRM5-008 Run 2 (2026-04-19) while inspecting embedding pipeline logs:

```
mcp-server-1  | [Nest] 1  - 04/20/2026, 12:38:39 AM   DEBUG [EmbeddingPipelineService] No documents need embedding backfill
mcp-server-1  | [Nest] 1  - 04/20/2026, 12:38:39 AM   DEBUG [EmbeddingPipelineService] No documents need embedding backfill
```

Every log line from the Context Store / embedding pipeline prints twice, exactly within the same second. The same pattern appeared on `Embedded document [project:_:run2-auth-decision]` and on `Index already contains 90 records — skipping migration`.

**Root cause located:**

- `apps/mcp-server/src/mcp/mcp.module.ts:9` — `imports: [MessagingModule, ContextStoreModule.forRoot(), RegistryModule]`
- `apps/mcp-server/src/messaging/messaging.module.ts:8` — `imports: [RegistryModule, ContextStoreModule.forRoot()]`

NestJS considers two dynamic modules the same only if `.forRoot()` returns the same object reference. Here each call builds a fresh descriptor, so both branches of the import tree end up with separate `ContextStoreModule` registrations. Since both descriptors list `EmbeddingPipelineService` (and `OpenSearchStore`, `MigrationService`) as providers, those classes are instantiated twice.

**Impact:**

1. **Doubled event handling.** Both `EmbeddingPipelineService` instances subscribe to `context.change`, so every write is embedded twice. The OpenSearch partial-update is idempotent, but Ollama is invoked redundantly — double the embedding latency, double the token/compute cost per write.
2. **Doubled periodic sweep.** Two 60s `setInterval` timers run the backfill query in parallel. Harmless today (query is idempotent, `sweeping` guard prevents overlap *per instance*) but fragile.
3. **Doubled `ContextStore` binding.** Two `OpenSearchStore` instances both talk to the same index. Consumers of `ContextStore` may receive either — the one resolved depends on which module branch the consumer imports from.
4. **Migration ran "twice" at startup** — second call hits the idempotent `Index already contains N records — skipping migration` branch, so it's observable in logs but harmless operationally.
5. **Log noise** — every diagnostic line is printed twice, which inflates `logs/*.jsonl` volume and makes `grep` counts misleading.

## Design Context

### Why `forRoot()` doesn't dedupe

NestJS dynamic module deduplication (`@Module({...})` imports array) uses referential equality on the `DynamicModule` descriptor, not structural equality on `module`/`providers`. The only built-in sharing mechanism for dynamic modules is `@Global()` combined with a single `forRoot()` call at the root. `forRoot()` returning a new literal each call is the standard footgun.

### Why `ContextStoreModule` uses `DynamicModule`

From the class header comment (`context-store.module.ts:13–22`), it resolves the backend (`inmemory` vs `opensearch`) at module-composition time, before DI is available. That's a valid reason for `forRoot()` — the bug is the downstream fan-out.

### Current consumers

Two consumers need the `ContextStore` token:

- `McpService` inside `McpModule` — reads/writes context for tool calls.
- `MessageBroker` / `BootstrapContextService` inside `MessagingModule` — emits and consumes bootstrap snapshots.

Both need to resolve the same `ContextStore` instance. Today they resolve different instances backed by the same index — functionally okay by accident (OpenSearch is shared state), but fragile.

## Chosen Approach

**Call `forRoot()` once in the app root (`McpServerModule`) and mark the returned dynamic module as `global: true`, so the `ContextStore` token is visible to every module that needs to inject it without re-importing.**

### Changes

1. **`apps/mcp-server/src/context-store/context-store.module.ts`** — both branches of `forRoot()` now return `{ ..., global: true, ... }`. Exporting `ContextStore` from a global dynamic module makes it injectable anywhere without downstream `imports:` entries.
2. **`apps/mcp-server/src/mcp-server.module.ts`** — add `ContextStoreModule.forRoot()` to the root `imports`. This is the single source of truth for module composition.
3. **`apps/mcp-server/src/mcp/mcp.module.ts`** — remove `ContextStoreModule` from imports entirely. `McpService` continues to inject `ContextStore` via the global registration.
4. **`apps/mcp-server/src/messaging/messaging.module.ts`** — same. `BootstrapContextService` inject path resolves through the global registration.

### Why `global: true`

First attempt tried importing `ContextStoreModule` as a type (no `forRoot()`). That fails because the class body is `@Module({})` (empty) — providers and exports only exist on the dynamic descriptor returned by `forRoot()`. Downstream modules resolving `ContextStore` got a `Nest can't resolve dependencies of BootstrapContextService` error at bootstrap. Marking the forRoot-returned module `global: true` is the standard Nest pattern for shared singletons provided once at the root.

### Why not memoize `forRoot()`

Memoizing the descriptor inside `ContextStoreModule` would also fix the symptom. Rejected because:

- It hides the real coupling — downstream modules would keep calling `forRoot()` as if they owned the configuration.
- It makes test setup awkward (the memoized instance leaks across `Test.createTestingModule()` calls).
- The standard NestJS pattern (call once at root) is simpler and makes ownership explicit.

### Verification

- **Log line appears once** — `docker compose logs mcp-server --since 1m | grep "No documents need embedding backfill"` should show one entry per minute, not two.
- **Single provider instance** — add a temporary `console.log('[embed] ctor')` in `EmbeddingPipelineService` constructor, rebuild, confirm one log line at startup.
- **Existing specs still pass** — `npm run test` must remain green; no spec currently asserts instance count, but module composition tests and the `ContextStoreModule.forRoot()` unit tests should not need changes since the module still works with or without direct `forRoot()` calls downstream.
- **Run 2 smoke test artifacts** — re-run Scenario 4 abbreviated (write + inspect logs); confirm `Embedded document [...]` appears once, not twice.

## Acceptance Criteria

- [ ] `ContextStoreModule.forRoot()` invoked in exactly one place (`McpServerModule`).
- [ ] `mcp.module.ts` and `messaging.module.ts` import `ContextStoreModule` as a plain type.
- [ ] Duplicate log lines gone — verified by grepping live logs after a fresh `./scripts/start.sh -d`.
- [ ] Embedding pipeline processes each write once — verified via a single `Embedded document [...]` log per write.
- [ ] `npm run lint` and `npm run test` green.

## Dependencies and References

- **Discovered during:** [QRM5-008 Run 2](QRM5-008-tests.md) — observed while inspecting log correlation for Scenarios 4/5/7.
- **Related:** [QRM5-BUG-004](QRM5-BUG-004-embedding-pipeline-abandons-records.md) — the periodic backfill sweep runs twice today; fixing this ticket collapses it to one timer.
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone stabilization.

**Source references:**

- `apps/mcp-server/src/context-store/context-store.module.ts:24–54` — `forRoot()` returning fresh descriptor each call.
- `apps/mcp-server/src/mcp/mcp.module.ts:9` — first `forRoot()` invocation.
- `apps/mcp-server/src/messaging/messaging.module.ts:8` — second `forRoot()` invocation.
- `apps/mcp-server/src/mcp-server.module.ts:12–19` — root module where the consolidated invocation will live.