# QRM4-002: Bootstrap Context Assembly Service

## Summary

Create a `BootstrapContextService` in `apps/mcp-server/src/messaging/` that queries the Context Store for project-scope and conversation-scope items and assembles them into a `BootstrapContext` object within a configurable token budget. Add a `bootstrapConfig` factory for the three governing environment variables (`BOOTSTRAP_ENABLED`, `BOOTSTRAP_MAX_TOKENS`, `BOOTSTRAP_PROJECT_RATIO`).

## Problem Statement

The Message Broker currently delivers invocations with no context from the Context Store (see the TODO at `message-broker.service.ts:64-70`). Each target agent starts blind and must spend turns querying the store manually. QRM4-001 added the `BootstrapContext` / `BootstrapContextMeta` types and the `bootstrapContext` field on `InvokeRequest` — but nothing populates them yet.

This ticket creates the assembly logic that:

1. Retrieves project-scope and conversation-scope items from the Context Store
2. Fits them within a token budget using a configurable project/conversation split
3. Returns a ready-to-attach `BootstrapContext` object (or `null` when there is nothing to inject)

Without this service, the broker integration ticket (QRM4-003) has no assembly logic to call, and agents continue to start every invocation without prior decisions.

## Design Context

The `BootstrapContext` interface (from QRM4-001) structures the injected data:

```typescript
interface BootstrapContext {
  project: Record<string, unknown>;
  conversation: Record<string, unknown>;
  meta: BootstrapContextMeta;
}
```

The `ContextStore` abstract class (`libs/common/src/context-store/context-store.abstract.ts`) provides `getAll(scope, id?)` returning `Record<string, unknown>` — a flat key→value map of all live items in a scope. This is the primary query method for assembly.

The existing token estimation convention is `Math.ceil(JSON.stringify(value).length / 4)`, used throughout the Context Store (`InMemoryStore.estimateTokens()`). The service must use the same formula for consistency.

The roadmap specifies three configuration values:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOTSTRAP_ENABLED` | `true` | Master toggle — when `false`, the service short-circuits to `null` |
| `BOOTSTRAP_MAX_TOKENS` | `1000` | Total token budget for the assembled payload |
| `BOOTSTRAP_PROJECT_RATIO` | `0.6` | Fraction of the total budget allocated to project-scope items |

These follow the existing config factory pattern (`registerAs` + Zod schema + env var parsing) established by `broker.config.ts` and `context.config.ts`.

## Implementation Details

### 1. Config factory — `apps/mcp-server/src/config/bootstrap.config.ts`

Create a new `registerAs('bootstrap', ...)` factory following the exact pattern of `broker.config.ts`:

- **Zod schema** with three fields:
  - `enabled`: `z.boolean()` — parsed from `BOOTSTRAP_ENABLED` string (`'true'`/`'false'`), default `true`
  - `maxTokens`: `z.number().int().min(1)` — parsed from `BOOTSTRAP_MAX_TOKENS`, default `1000`
  - `projectRatio`: `z.number().min(0).max(1)` — parsed from `BOOTSTRAP_PROJECT_RATIO`, default `0.6`
- Export as `bootstrapConfig`

**Env var parsing notes:**
- `enabled` needs string-to-boolean coercion: `process.env.BOOTSTRAP_ENABLED !== 'false'` (default `true` — any value other than the literal string `'false'` means enabled). This matches the roadmap's "enabled by default" requirement.
- `maxTokens` and `projectRatio` use `parseInt`/`parseFloat` like existing configs.

### 2. Config integration

Wire the new config into the existing config infrastructure:

- **`mcp-server-config.module.ts`**: Add `bootstrapConfig` to the `ConfigModule.forRoot({ load: [...] })` array
- **`mcp-server-config.service.ts`**: Inject `bootstrapConfig` via `@Inject(bootstrapConfig.KEY)` and expose as `public readonly bootstrap` property, following the exact pattern of existing `broker` and `context` properties. Use `import type { ConfigType } from '@nestjs/config'` for the type annotation.
- **`config/index.ts`**: Add `export { bootstrapConfig } from './bootstrap.config'` to the barrel

### 3. Service — `apps/mcp-server/src/messaging/bootstrap-context.service.ts`

Create an `@Injectable()` service with one public method:

```typescript
async assemble(correlationId?: string): Promise<BootstrapContext | null>
```

**Constructor dependencies:**
- `ContextStore` — injected via `@Inject(ContextStore)` (the abstract class is the DI token, see `context-store.module.ts`)
- `McpServerConfigService` — for reading `this.config.bootstrap.*` values

**Algorithm:**

1. **Check enabled** — if `this.config.bootstrap.enabled` is `false`, return `null` immediately
2. **Calculate budgets** — `projectBudget = Math.floor(maxTokens * projectRatio)`, `conversationBudget = maxTokens - projectBudget`
3. **Fetch project items** — call `this.contextStore.getAll(ContextScope.project)`. Always queried.
4. **Fetch conversation items** — if `correlationId` is defined, call `this.contextStore.getAll(ContextScope.conversation, correlationId)`. Otherwise skip (empty record).
5. **Apply budget to project items** — iterate entries, estimate tokens per item (`Math.ceil(JSON.stringify(value).length / 4)`), accumulate until budget exhausted. Prefer newer items — since `getAll()` returns items in Map insertion order (older first), reverse the entries before iterating so that the most recently stored items are selected first when budget is tight.
6. **Reclaim unused project budget** — if project items consumed fewer tokens than `projectBudget`, add the surplus to `conversationBudget`
7. **Apply budget to conversation items** — same approach as step 5 (reverse, iterate, accumulate)
8. **Check emptiness** — if both `project` and `conversation` records are empty, return `null` (no context to inject)
9. **Build metadata** — count items, sum estimated tokens, record which scopes were queried
10. **Return** the assembled `BootstrapContext`

**Key design decisions:**

- **`getAll()` over `search()`**: The roadmap says to use `getAll()`, which returns `Record<string, unknown>` (values only, no `createdAt` metadata). For recency ordering, we reverse entry order as a proxy — items stored later in the session appear later in the Map, so reversing gives a most-recent-first traversal. This is an intentional simplification; exact `createdAt` sorting would require a different `ContextStore` API.
- **Budget reclamation**: If project context uses only 200 of its 600-token budget, the remaining 400 flows to conversation context (total cap stays at `maxTokens`). This maximizes payload usefulness without exceeding the overall budget.
- **Returns `null` not empty**: When there's nothing to inject, return `null` so the broker can skip the field entirely. This keeps `InvokeRequest.bootstrapContext` absent (not present-but-empty), preserving backward compatibility.
- **Logger**: Use `new Logger(BootstrapContextService.name)` and log at DEBUG level when assembly completes (items injected, tokens consumed, scopes queried). Include `correlationId` in log messages.

### 4. Module wiring — `apps/mcp-server/src/messaging/messaging.module.ts`

The `MessagingModule` currently imports only `RegistryModule`. To give the service access to `ContextStore`:

- Add `ContextStoreModule` to the `imports` array (from `apps/mcp-server/src/context-store/context-store.module.ts` — exports `ContextStore`)
- Add `BootstrapContextService` to the `providers` and `exports` arrays (QRM4-003 will need it from outside the module)

### 5. Barrel export — `apps/mcp-server/src/messaging/index.ts`

Add `BootstrapContextService` to the barrel export so QRM4-003 can import it cleanly.

### 6. Extracting the token estimation helper

The token estimation formula `Math.ceil(JSON.stringify(value).length / 4)` is currently a private method in `InMemoryStore`. The `BootstrapContextService` needs the same formula. Rather than duplicating it, define it as a private method within the service (same formula, same convention). Extracting to a shared utility is a future cleanup — it's out of scope here since the formula is trivial and duplication of a one-liner is preferable to cross-module coupling.

## Acceptance Criteria

- [ ] `apps/mcp-server/src/config/bootstrap.config.ts` exists with a `bootstrapConfig` factory exporting `enabled` (boolean, default `true`), `maxTokens` (int ≥ 1, default `1000`), and `projectRatio` (number 0–1, default `0.6`)
- [ ] `bootstrapConfig` is loaded in `McpServerConfigModule`, injected and exposed in `McpServerConfigService`, and exported from `config/index.ts`
- [ ] `apps/mcp-server/src/messaging/bootstrap-context.service.ts` exists with an `@Injectable()` class that has an `assemble(correlationId?: string): Promise<BootstrapContext | null>` method
- [ ] `assemble()` returns `null` when `BOOTSTRAP_ENABLED=false`
- [ ] `assemble()` returns `null` when both project and conversation scopes are empty
- [ ] `assemble()` calls `ContextStore.getAll(ContextScope.project)` always, and `getAll(ContextScope.conversation, correlationId)` only when `correlationId` is provided
- [ ] Token budgeting respects `BOOTSTRAP_MAX_TOKENS` with the project/conversation split from `BOOTSTRAP_PROJECT_RATIO`
- [ ] Unused project budget flows to conversation budget (budget reclamation)
- [ ] When budget is tight, newer items (later in insertion order) are preferred over older ones
- [ ] Returned `BootstrapContext.meta` accurately reports `itemCount`, `estimatedTokens`, and `scopesQueried`
- [ ] `BootstrapContextService` is provided and exported from `MessagingModule`
- [ ] `MessagingModule` imports `ContextStoreModule`
- [ ] `BootstrapContextService` is exported from `apps/mcp-server/src/messaging/index.ts`
- [ ] `npm run build` passes with zero errors
- [ ] `npm run lint` passes with zero errors, zero warnings

## Dependencies and References

**Prerequisites:**
- **QRM4-001** (✅ Complete) — `BootstrapContext`, `BootstrapContextMeta` interfaces, `bootstrapContext` field on `InvokeRequest`

**Blocks:**
- **QRM4-003** (Message Broker Integration) — needs `BootstrapContextService.assemble()` to call before delivery
- **QRM4-005** (Unit Tests) — needs the service to exist before writing tests for it

**Key file references:**

| File | Relevance |
|------|-----------|
| `libs/common/src/messaging/invoke.types.ts` | `BootstrapContext`, `BootstrapContextMeta` — the return type |
| `libs/common/src/context-store/context-store.abstract.ts` | `ContextStore.getAll()` — the query method |
| `libs/common/src/context-store/context-store.types.ts` | `ContextScope` enum, `ContextItem` type |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Concrete `getAll()` implementation, `estimateTokens()` convention |
| `apps/mcp-server/src/context-store/context-store.module.ts` | `ContextStoreModule` — provides `ContextStore` DI token |
| `apps/mcp-server/src/config/broker.config.ts` | Config factory pattern to follow |
| `apps/mcp-server/src/config/broker.config.spec.ts` | Config factory test pattern to follow |
| `apps/mcp-server/src/config/mcp-server-config.service.ts` | Config service injection pattern |
| `apps/mcp-server/src/config/mcp-server-config.module.ts` | Config module load array |
| `apps/mcp-server/src/messaging/messaging.module.ts` | Module to modify — add imports/providers/exports |
| `apps/mcp-server/src/messaging/index.ts` | Barrel export to update |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | The consumer (QRM4-003) — shows how config and services are injected |
| `tickets/QRM4-000-roadmap.md` | Roadmap — full subtask description and design decisions |
| `tickets/QRM4-001-extend-invoke-request-bootstrap-context.md` | Predecessor ticket |
| `docs/message-broker.md` | Broker architecture and context integration section |
| `docs/context-management.md` | Pull-based context model, usage patterns |
