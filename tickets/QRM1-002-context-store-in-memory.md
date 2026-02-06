# QRM1-002: Context Store — Abstract Class & InMemoryStore Implementation

## Summary

Implement the Context Store subsystem for the MCP Server: an abstract `ContextStore` base class defining the storage contract, a concrete `InMemoryStore` implementation using `Map` for the POC phase, supporting types (`ContextItem`, `SetParams`, `ContextStats`), and a NestJS module wired for dependency injection so the backing store can be swapped to OpenSearch (or PostgreSQL+pgvector) later by changing a single provider binding.

## Problem Statement

The Context Store is the persistence layer behind all four context MCP tools (`context_store`, `context_query`, `context_summarize`, `context_stats`) and both context MCP resources (`context://project`, `context://conversation/{id}`). Without it, no context management functionality can be implemented — agents have no way to record decisions or query shared context.

The system design (`docs/context-store.md`) specifies a phased backend evolution:

```
Phase 1 (POC)          Phase 2 (MVP)              Phase 3 (Production)
────────────────────────────────────────────────────────────────────────
InMemoryStore     →    PostgreSQL + pgvector  →   OpenSearchStore
```

This ticket covers Phase 1. The critical requirement is that the abstract class and NestJS DI wiring are designed so that replacing `InMemoryStore` with `OpenSearchStore` later requires **changing one provider binding** — no consumers (MCP tools, resources, Message Broker) should need modification.

## Design Context

### Where Context Store Fits

The Context Store is a component inside the MCP Server container (`apps/mcp-server/`). It is consumed by:

1. **MCP Tools** — `context_store`, `context_query`, `context_summarize`, `context_stats` call the store's methods directly
2. **MCP Resources** — `context://project` and `context://conversation/{id}` read from the store
3. **Message Broker** — fetches bootstrap context for agent invocations via `search()`

```
MCP Tools ──→ ContextStore (abstract) ←── InMemoryStore (concrete)
MCP Resources ──→        ↑
Message Broker ──→       │
                         └── Later: OpenSearchStore (concrete)
```

All consumers depend on the abstract class — never the concrete implementation.

### Interface from Design Docs

`docs/context-store.md` defines the core interface:

```typescript
abstract class ContextStore {
  abstract set(params: SetParams): Promise<void>;
  abstract get(scope: string, key: string, id?: string): Promise<unknown | undefined>;
  abstract getAll(scope: string, id?: string): Promise<Record<string, unknown>>;
  abstract search(scope: string, query: string, id?: string, maxTokens?: number): Promise<ContextItem[]>;
  abstract getStats(scope?: string, id?: string): Promise<ContextStats>;
}
```

Implemented as a TypeScript abstract class because NestJS DI requires a runtime value as the injection token — abstract classes serve as both the type contract (compile-time) and the DI token (runtime), enabling `@Inject(ContextStore)`. Change events are handled via NestJS `@nestjs/event-emitter` (see section 2 below).

## Implementation Details

### 1. Module & File Structure

Place the abstract class and shared types in `libs/common/` (they define the contract used across modules). Place the concrete `InMemoryStore` and its NestJS module in `apps/mcp-server/` (it's an MCP Server-internal implementation detail).

```
libs/common/src/
  context-store/
    context-store.abstract.ts     # Abstract base class
    context-store.types.ts        # ContextItem, SetParams, ContextStats, ContextScope, ChangeEvent
    index.ts                      # Barrel export

apps/mcp-server/src/
  context-store/
    in-memory-store.ts            # InMemoryStore extends ContextStore
    in-memory-store.spec.ts       # Unit tests
    context-store.module.ts       # NestJS module with provider binding
    index.ts                      # Barrel export
```

### 2. Abstract Class Design

The abstract class is a pure storage contract — it declares the five storage methods as abstract with `Promise<T>` return types. All methods use `async` signatures uniformly; InMemoryStore operations are synchronous under the hood, but OpenSearchStore will be truly async, so the Promise-based contract avoids breaking changes on swap.

The `id` parameter in `get()`, `getAll()`, and `search()` corresponds to `correlationId` for conversation scope and `agentId` for agent scope. For project scope it's omitted (undefined). This maps to the composite key format `${scope}:${id}:${key}`.

#### Event Emission via `@nestjs/event-emitter`

Change events use NestJS's `@nestjs/event-emitter` package (official NestJS package, built on `eventemitter2`):

- **The abstract class has no event-related methods.** It is a pure storage contract.
- **Concrete stores inject `EventEmitter2`** and call `this.eventEmitter.emit('context.change', event)` on mutations (`set()`, lazy expiration).
- **Listeners subscribe via decorators** in any NestJS module — no reference to the store instance needed:

```typescript
// Any @Injectable() service in any module
@OnEvent('context.change')
handleContextChange(event: ChangeEvent) {
  // e.g., notify MCP resource subscribers
}
```

This is NestJS-idiomatic, fully decoupled, and means adding new listeners (future caching layer, audit logging, etc.) requires zero changes to the store or its module.

The `ContextStoreModule` imports `EventEmitterModule.forRoot()` (or the app root module does — only needs to be registered once globally).

### 3. Types

**`ContextScope`** — enum with three values: `project`, `conversation`, `agent`. Matches the three scopes from `docs/context-management.md`.

**`ContextItem`** — the stored unit. Fields:
- `key: string` — the item key within its scope
- `value: unknown` — the stored data (arbitrary JSON-serializable value)
- `scope: ContextScope`
- `id?: string` — correlationId or agentId depending on scope
- `createdBy?: string` — agent role that created it (for audit/debugging)
- `createdAt: Date`
- `expiresAt?: Date` — TTL expiration timestamp (undefined = no expiry)

**`SetParams`** — input to `set()`. Fields:
- `scope: ContextScope`
- `key: string`
- `value: unknown`
- `id?: string` — correlationId for conversation, agentId for agent scope
- `createdBy?: string`
- `ttl?: number` — seconds until expiration; store converts to `expiresAt` timestamp

**`ContextStats`** — output of `getStats()`. Fields:
- `itemCount: number`
- `estimatedTokens: number`

**`ChangeEvent`** — emitted on mutations via `EventEmitter2`. Fields:
- `scope: ContextScope`
- `key: string`
- `id?: string`
- `action: 'set' | 'delete' | 'expire'`

Listeners receive `ChangeEvent` directly via `@OnEvent('context.change')` decorated methods.

### 4. InMemoryStore Implementation

Backed by a single `Map<string, ContextItem>`.

**Composite key format:** `${scope}:${id ?? '_'}:${key}` — uses `_` as sentinel for project scope where there's no id. This ensures unique keys across scopes.

**TTL — lazy expiration on read:** When `get()` or `search()` encounters an item where `expiresAt < Date.now()`, it deletes the item and returns `undefined` / omits it. This keeps the POC simple and avoids timer lifecycle management. The design doc already specifies this approach for InMemoryStore.

**Search — substring matching:** `search()` iterates all items in the given scope, serializes each value with `JSON.stringify()`, and checks for case-insensitive substring match against the query. This is O(n) — acceptable for POC volumes. OpenSearchStore will replace this with BM25 + k-NN vector search.

**Token estimation:** `Math.ceil(JSON.stringify(value).length / 4)` as specified in `docs/context-store.md`. The `search()` method uses this to enforce the `maxTokens` budget — it accumulates items until the budget is exhausted, then stops.

**Event emission:** `InMemoryStore` receives `EventEmitter2` via constructor injection. On `set()`, it calls `this.eventEmitter.emit('context.change', changeEvent)` with action `set`. On lazy TTL expiration (during `get()`, `search()`, `getAll()`), it emits with action `expire`. The event name `context.change` follows NestJS event-emitter's dot-delimited convention, enabling wildcard subscriptions (`context.*`) if needed later.

**`getAll()`** iterates the Map, filters by scope (and id if provided), checks TTL, and returns a `Record<string, unknown>` of surviving items keyed by their context key (not composite key).

**`getStats()`** iterates and counts items + sums token estimates for the given scope/id filter. If no scope is provided, returns aggregate stats across all scopes.

### 5. NestJS Module Wiring

The `ContextStoreModule` registers two things:

1. **`EventEmitterModule.forRoot()`** — imported once (either here or in the app root module) to enable `@OnEvent()` decorators globally. Uses `eventemitter2` under the hood.
2. **Class provider** binding the abstract class to the concrete implementation:

```typescript
// Conceptual — the swap point
{
  provide: ContextStore,    // abstract class = DI token
  useClass: InMemoryStore,  // concrete implementation
}
```

To swap to OpenSearchStore later, only this `useClass` changes. All consumers inject `ContextStore` and are unaffected. The `EventEmitter2` injection into the concrete store is handled automatically by NestJS DI (it's provided by `EventEmitterModule`).

The module exports `ContextStore` so other modules (MCP tools module, Message Broker module) can import `ContextStoreModule` and inject the store.

### 6. Testing Strategy

Unit tests for `InMemoryStore` covering:
- **CRUD**: `set()` then `get()` returns the value; `get()` for missing key returns `undefined`
- **Scope isolation**: items stored in `project` scope don't appear in `conversation` scope queries
- **Id isolation**: items with different correlationIds in `conversation` scope don't cross-contaminate
- **TTL expiration**: `set()` with `ttl: 1`, mock `Date.now`, `get()` returns `undefined`
- **Search**: substring matching finds relevant items, respects scope filter, respects `maxTokens` budget
- **getAll**: returns all items for a scope, excludes expired items
- **getStats**: returns correct counts and token estimates
- **Events**: `EventEmitter2` emits `context.change` on `set()` and on lazy expiration (inject `EventEmitter2` in test, subscribe, assert)
- **Overwrite**: `set()` with same scope/id/key overwrites the previous value

Prefer mocking `Date.now()` via `jest.spyOn(Date, 'now')` over real delays for TTL tests.

## Acceptance Criteria

- [ ] Abstract `ContextStore` class in `libs/common/src/context-store/` with all methods from the design doc interface
- [ ] `ContextItem`, `SetParams`, `ContextStats`, `ContextScope`, `ChangeEvent` types in `libs/common/src/context-store/`
- [ ] `InMemoryStore` extends `ContextStore` in `apps/mcp-server/src/context-store/`
- [ ] Composite key format `${scope}:${id ?? '_'}:${key}` partitions data correctly
- [ ] Lazy TTL expiration on read
- [ ] Substring search with `maxTokens` budget enforcement
- [ ] Token estimation via `Math.ceil(JSON.stringify(value).length / 4)`
- [ ] `context.change` events emitted via `EventEmitter2` on `set()` and on lazy expiration
- [ ] `ContextStoreModule` provides `ContextStore` → `InMemoryStore` binding via NestJS DI
- [ ] `@nestjs/event-emitter` installed and `EventEmitterModule.forRoot()` registered
- [ ] Swapping to a different backend requires changing only the `useClass` value in the module
- [ ] Unit tests pass covering CRUD, scope isolation, TTL, search, stats, events
- [ ] Barrel exports from both `libs/common/` and `apps/mcp-server/` context-store directories

## Dependencies and References

### Prerequisites
- QRM1-001 — Core packages installed (NestJS, TypeScript, Jest available)

### What This Blocks
- MCP context tools implementation (`context_store`, `context_query`, `context_summarize`, `context_stats`)
- MCP context resources implementation (`context://project`, `context://conversation/{id}`)
- Message Broker bootstrap context integration

### References
- [docs/context-store.md](../docs/context-store.md) — Storage backend design, interface definition, InMemoryStore spec, OpenSearch schema
- [docs/context-management.md](../docs/context-management.md) — MCP tools/resources API that consumes the store
- [docs/message-broker.md](../docs/message-broker.md) — Message Broker's `search()` usage for bootstrap context
- [docs/system-design.md](../docs/system-design.md) — MCP Server container, monorepo structure, context scopes