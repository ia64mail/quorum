# QRM4-003: Message Broker Integration

## Summary

Inject `BootstrapContextService` into `MessageBroker` and call it before delivering invocations, replacing the TODO at `message-broker.service.ts:64-70`. This connects the assembly logic (QRM4-002) to the actual invocation flow so that agents receive bootstrap context automatically.

## Problem Statement

The `MessageBroker.invoke()` method contains a TODO comment (lines 64-70) marking the exact integration point for bootstrap context injection. Despite QRM4-001 (types) and QRM4-002 (assembly service) being complete, no code currently populates `request.bootstrapContext` — agents still start every invocation blind.

This ticket is the critical bridge: it calls `BootstrapContextService.assemble()` during invocation delivery and attaches the result to the request. Without this, the assembly service exists but is never invoked, and the `bootstrapContext` field on `InvokeRequest` remains permanently empty.

## Design Context

The `MessageBroker` (in `apps/mcp-server/src/messaging/message-broker.service.ts`) currently:

1. Runs four safeguard checks (depth limit, circular call prevention, agent availability, agent connected)
2. Tracks the caller in the chain
3. Delivers via `deliverWithTimeout(agent.handle(request, timeout), ...)`

The TODO at lines 64-70 sits between chain tracking (line 57) and delivery (line 71). The roadmap (QRM4-000) specifies:

- Bootstrap query happens **after safeguard checks pass** — no wasted queries on rejected invocations
- Bootstrap failure is **non-fatal** — if the query throws, log a warning and deliver without bootstrap context
- When `BOOTSTRAP_ENABLED=false`, skip entirely (zero overhead — the service already short-circuits to `null`)
- Log at DEBUG level: items injected, tokens consumed, scopes queried

The `BootstrapContextService` (from QRM4-002) is already provided and exported from `MessagingModule`. The `ContextStoreModule` is already imported into `MessagingModule`. The only remaining work is constructor injection into `MessageBroker` and the invocation-time call.

## Implementation Details

### 1. Inject `BootstrapContextService` into `MessageBroker`

Add `BootstrapContextService` as a constructor dependency in `apps/mcp-server/src/messaging/message-broker.service.ts`:

```typescript
constructor(
  private readonly registry: AgentRegistry,
  private readonly config: McpServerConfigService,
  private readonly bootstrapContext: BootstrapContextService,
) {}
```

Add the import at the top of the file:

```typescript
import { BootstrapContextService } from './bootstrap-context.service';
```

No module wiring changes needed — `BootstrapContextService` is already in `MessagingModule.providers` (added by QRM4-002).

### 2. Replace the TODO with the bootstrap call

Remove the TODO comment block at lines 64-70 and replace it with:

```typescript
// Assemble bootstrap context (non-fatal — deliver without on failure)
let bootstrapResult: BootstrapContext | null = null;
try {
  bootstrapResult = await this.bootstrapContext.assemble(correlationId);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  this.logger.warn(
    `Bootstrap context assembly failed — proceeding without: ${message} [correlationId=${correlationId}]`,
  );
}

if (bootstrapResult) {
  request.bootstrapContext = bootstrapResult;
}
```

**Key design decisions reflected in this code:**

- **Non-fatal try/catch**: If `ContextStore.getAll()` or any step in assembly throws, the broker logs a warning and delivers the request without bootstrap context. The invocation is not blocked by a context store failure. This follows the codebase's error-handling convention — services return error values or null, and the broker absorbs exceptions.
- **Direct mutation of `request`**: The roadmap specifies "attached to `request.bootstrapContext`". The request object is consumed only by the subsequent `agent.handle()` call and is not reused afterward, so mutation is safe and avoids an unnecessary object spread.
- **Conditional assignment**: Only set `request.bootstrapContext` when the result is non-null. This preserves backward compatibility — when the Context Store is empty or bootstrap is disabled, the field remains `undefined` (absent), not `null`.
- **No additional logging**: `BootstrapContextService.assemble()` already logs at DEBUG level with item count, token usage, and scopes queried. The broker only needs to log the warning path (assembly failure). The existing completion log (`Completed: correlationId=... target=... success=...`) remains unchanged.

### 3. Add `BootstrapContext` type import

The `bootstrapResult` variable needs the `BootstrapContext` type. Add it to the existing `import type` statement:

```typescript
import type { AgentRole, BootstrapContext, InvokeRequest, InvokeResponse } from '@app/common';
```

### 4. Update existing tests

The existing test file (`apps/mcp-server/src/messaging/message-broker.service.spec.ts`) creates `MessageBroker` via `Test.createTestingModule()` with three providers: `AgentRegistry`, `MessageBroker`, and a mock `McpServerConfigService`. After injecting `BootstrapContextService` into the broker, all test modules will fail to compile without a provider for it.

Add a mock `BootstrapContextService` to the test setup:

```typescript
const mockBootstrapService = { assemble: jest.fn().mockResolvedValue(null) };
```

Add to the `providers` array in **every** `Test.createTestingModule()` call (there are two — the main `beforeEach` at line 32, and the timeout test at line 158):

```typescript
{ provide: BootstrapContextService, useValue: mockBootstrapService },
```

Also add to imports at the top of the test file:

```typescript
import { BootstrapContextService } from './bootstrap-context.service';
```

The mock returns `null` by default (bootstrap disabled/empty), so all existing tests continue to pass with the same behavior — the `bootstrapContext` field remains absent on requests.

Optionally reset the mock in `beforeEach` so per-test overrides don't leak:

```typescript
mockBootstrapService.assemble.mockResolvedValue(null);
```

**Important**: The mock for the `shortConfig` timeout test (line 158) also needs the provider. That test creates a separate `TestingModule` — the mock must be provided there too.

### 5. Verify integration

After the code changes:

1. `npm run build` — confirms the new dependency injection compiles (all 4 apps)
2. `npm run lint` — zero errors, zero warnings
3. `npm run test` — all existing tests pass with the mock provider added

## Acceptance Criteria

- [ ] `MessageBroker` constructor accepts `BootstrapContextService` as a dependency
- [ ] The TODO comment block at lines 64-70 of `message-broker.service.ts` is removed
- [ ] `BootstrapContextService.assemble(correlationId)` is called after safeguard checks pass and before `agent.handle()`
- [ ] Bootstrap assembly failure is non-fatal — caught, logged as a warning with `correlationId`, and delivery proceeds without bootstrap context
- [ ] `request.bootstrapContext` is set only when `assemble()` returns non-null
- [ ] When `assemble()` returns `null` (disabled or empty store), `request.bootstrapContext` remains `undefined` (backward-compatible)
- [ ] No module wiring changes needed (verified: `BootstrapContextService` is already in `MessagingModule.providers`)
- [ ] Existing tests in `message-broker.service.spec.ts` updated to provide a mock `BootstrapContextService` and continue to pass
- [ ] `npm run build` passes with zero errors
- [ ] `npm run lint` passes with zero errors, zero warnings
- [ ] `npm run test` passes with all existing tests still green

## Dependencies and References

**Prerequisites:**
- **QRM4-001** (✅ Complete) — `BootstrapContext` type, `bootstrapContext` field on `InvokeRequest`
- **QRM4-002** (✅ Complete) — `BootstrapContextService` with `assemble()` method, module wiring

**Blocks:**
- **QRM4-005** (Unit Tests) — needs the broker integration to exist before writing comprehensive test coverage for it
- **QRM4-006** (Configuration & Documentation) — needs the integration in place before documenting the complete flow

**Key file references:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/messaging/message-broker.service.ts` | **Primary target** — inject service, replace TODO, add assembly call |
| `apps/mcp-server/src/messaging/message-broker.service.spec.ts` | **Test update** — add mock provider to all test modules |
| `apps/mcp-server/src/messaging/bootstrap-context.service.ts` | The service being injected — `assemble(correlationId?)` returns `BootstrapContext \| null` |
| `apps/mcp-server/src/messaging/messaging.module.ts` | Already wired (QRM4-002) — no changes needed, but verify |
| `libs/common/src/messaging/invoke.types.ts` | `InvokeRequest.bootstrapContext`, `BootstrapContext` type |
| `apps/mcp-server/src/registry/mock-connection.ts` | `MockConnection.handleFn` receives the full `InvokeRequest` — the `bootstrapContext` field will be visible in nested handler tests |
| `tickets/QRM4-000-roadmap.md` | Roadmap — QRM4-003 subtask description |
| `tickets/QRM4-001-extend-invoke-request-bootstrap-context.md` | Predecessor — type foundation |
| `tickets/QRM4-002-bootstrap-context-assembly-service.md` | Predecessor — assembly service |
| `docs/message-broker.md` | Broker architecture reference |
