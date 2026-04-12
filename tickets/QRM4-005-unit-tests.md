# QRM4-005: Unit Tests

## Summary

Comprehensive unit tests for the three new QRM4 components: `BootstrapContextService` assembly logic, `MessageBroker` bootstrap integration, and `InvocationHandler.buildPrompt()` bootstrap rendering. This ticket covers the test file creation and test extension specified in the QRM4-000 roadmap.

## Problem Statement

QRM4-002, QRM4-003, and QRM4-004 delivered the bootstrap context injection pipeline — assembly, broker integration, and prompt rendering — but no dedicated test coverage was added for the new behavior. The existing test suites (`message-broker.service.spec.ts`, `invocation-handler.service.spec.ts`) mock the bootstrap service to `null` or don't exercise bootstrap-specific paths. Without tests:

1. Regressions in budget calculation, item selection, or prompt formatting will go undetected
2. Edge cases (empty store, disabled toggle, budget overflow, single-scope results) are unverified
3. The non-fatal error handling in the broker's bootstrap integration is untested

The `BootstrapContextService` has no test file at all (`bootstrap-context.service.spec.ts` does not exist).

## Design Context

**Components under test and their locations:**

| Component | File | Test File |
|-----------|------|-----------|
| `BootstrapContextService` | `apps/mcp-server/src/messaging/bootstrap-context.service.ts` | `apps/mcp-server/src/messaging/bootstrap-context.service.spec.ts` (**new**) |
| `MessageBroker` bootstrap integration | `apps/mcp-server/src/messaging/message-broker.service.ts` | `apps/mcp-server/src/messaging/message-broker.service.spec.ts` (**extend**) |
| `InvocationHandler.buildPrompt()` | `apps/agent/src/connection/invocation-handler.service.ts` | `apps/agent/src/connection/invocation-handler.service.spec.ts` (**extend**) |

**Testing conventions** (from `quorum.md` and existing test files):
- NestJS `Test.createTestingModule()` for service instantiation with mock providers
- Save/restore `process.env` pattern for env var tests (see `broker.config.spec.ts`)
- `jest.fn()` mocks for dependencies; reset in `beforeEach`
- Prompt verification via inspecting the `prompt` argument passed to `mockExecute`
- `MockConnection` from `apps/mcp-server/src/registry/mock-connection.ts` for broker tests

**Key implementation details informing test design:**
- `BootstrapContextService.assemble()` uses a greedy `applyBudget()` that `continue`s past oversized items (bin-packing), not `break`ing at the first that doesn't fit
- `applyBudget()` reverses `Object.entries()` to prefer newer items (later in insertion order)
- Token estimation: `Math.ceil(JSON.stringify(value).length / 4)`
- Budget reclamation: unused project budget flows to conversation budget
- Broker's bootstrap call is wrapped in try/catch — failure logged as warning, delivery proceeds without bootstrap context
- `renderBootstrapContext()` omits `meta` from prompt output, omits empty subsections, returns `null` for absent/empty bootstrap context

## Implementation Details

### 1. New file: `bootstrap-context.service.spec.ts`

Create `apps/mcp-server/src/messaging/bootstrap-context.service.spec.ts` with the following test structure. Use `Test.createTestingModule()` with mock `ContextStore` and mock `McpServerConfigService`.

**Mock setup:**
- `mockContextStore` with `getAll: jest.fn()` — control return values per scope per test
- `mockConfig` with `bootstrap: { enabled, maxTokens, projectRatio }` — defaults to `{ enabled: true, maxTokens: 1000, projectRatio: 0.6 }`
- Inject `ContextStore` via `{ provide: ContextStore, useValue: mockContextStore }` (the abstract class is the DI token, matching how the real module wires it)

**Test cases — organized by `describe` block:**

**`describe('disabled toggle')`**
- When `config.bootstrap.enabled` is `false`, `assemble()` returns `null` regardless of store contents
- `ContextStore.getAll()` is never called when disabled

**`describe('empty store')`**
- When both project and conversation scopes return `{}`, `assemble()` returns `null`
- When project returns `{}` and no `correlationId` is provided, returns `null`

**`describe('project-only context')`**
- When project has items and no `correlationId`, returns `BootstrapContext` with populated `project`, empty `conversation`, and `scopesQueried: ['project']`
- `getAll(ContextScope.conversation, ...)` is never called when `correlationId` is absent

**`describe('conversation-only context')`**
- When project returns `{}` but conversation has items (with `correlationId`), returns `BootstrapContext` with empty `project`, populated `conversation`, and `scopesQueried: ['project', 'conversation']`
- Note: project scope is _always_ queried per the implementation, even if it returns empty

**`describe('mixed context')`**
- When both scopes have items, both appear in the result
- `meta.itemCount` equals the sum of project + conversation items selected
- `meta.scopesQueried` includes both scopes

**`describe('budget enforcement')`**
- With a tight `maxTokens` (e.g., 50) and items that total more than the budget, only a subset of items is selected
- Total `meta.estimatedTokens` does not exceed `maxTokens`
- Verify the greedy bin-packing: an item that doesn't fit is skipped, but a smaller subsequent item can still be selected (this tests the `continue` vs `break` behavior)

**`describe('budget splitting')`**
- With `projectRatio: 0.6` and `maxTokens: 100`, project gets 60 tokens, conversation gets 40
- Verify by providing items of known size (use `Math.ceil(JSON.stringify(value).length / 4)` to pre-calculate token counts)

**`describe('budget reclamation')`**
- When project items consume fewer tokens than their allocation, the surplus flows to conversation budget
- Example: `maxTokens: 100`, `projectRatio: 0.6` → project budget 60, but project items use only 20 → conversation budget becomes 80 (40 + 40 surplus)
- Provide conversation items that would exceed the base 40-token conversation budget but fit within the reclaimed 80-token budget

**`describe('item recency ordering')`**
- When budget is tight, items later in the `getAll()` return (newer in insertion order) are preferred over earlier ones (older)
- Provide an ordered map where older items and newer items together exceed budget, verify that the newer items are selected
- Verify by checking which keys appear in the result

**`describe('metadata accuracy')`**
- `meta.itemCount` matches the actual number of keys in `project` + `conversation`
- `meta.estimatedTokens` matches the sum of `Math.ceil(JSON.stringify(value).length / 4)` for each selected item
- `meta.scopesQueried` is `['project']` without `correlationId`, `['project', 'conversation']` with `correlationId`

### 2. Extend: `message-broker.service.spec.ts`

Add a new `describe('bootstrap context integration')` block to the existing test file. The existing mock (`mockBootstrapService`) and provider wiring are already in place from QRM4-003.

**Test cases:**

**`'should attach bootstrap context to request when assemble returns non-null'`**
- Configure `mockBootstrapService.assemble.mockResolvedValue(...)` with a valid `BootstrapContext` object
- Use `MockConnection.handleFn` to capture the `request` argument and verify `request.bootstrapContext` is set
- Verify `assemble()` was called with the correct `correlationId`

**`'should not set bootstrapContext when assemble returns null'`**
- `assemble` returns `null` (the default mock behavior)
- Verify via `handleFn` that `request.bootstrapContext` is `undefined`

**`'should deliver without bootstrap context when assemble throws'`**
- Configure `mockBootstrapService.assemble.mockRejectedValue(new Error('store down'))`
- Verify the invocation still succeeds (non-fatal)
- Verify `request.bootstrapContext` is `undefined` on the delivered request

**`'should not call assemble when safeguard rejects (depth exceeded)'`**
- Invoke with `depth >= maxCallDepth`
- Verify `mockBootstrapService.assemble` was never called

**`'should not call assemble when safeguard rejects (agent not registered)'`**
- Invoke targeting an unregistered agent
- Verify `assemble` was never called

### 3. Extend: `invocation-handler.service.spec.ts`

Add a new `describe('bootstrap context rendering')` block. The existing mock setup passes requests through `handler.handle()` → `buildPrompt()` → `mockExecute`, so bootstrap rendering is verifiable via `mockExecute.mock.calls[0][0].prompt`.

**Test cases:**

**`'should render project context before Task line when bootstrapContext is present'`**
- Provide `baseRequest` with `bootstrapContext: { project: { 'tech-stack': 'NestJS' }, conversation: {}, meta: { ... } }`
- Verify prompt contains `## Prior Decisions`, `### Project Context`, `- tech-stack: "NestJS"`, and that these appear before `Task:`

**`'should render conversation context when present'`**
- Provide both project and conversation items
- Verify prompt contains both `### Project Context` and `### Conversation Context` subsections

**`'should omit project subsection when project scope is empty'`**
- `bootstrapContext.project` is `{}`, `conversation` has items
- Verify prompt contains `### Conversation Context` but not `### Project Context`

**`'should omit conversation subsection when conversation scope is empty'`**
- `bootstrapContext.conversation` is `{}`, `project` has items
- Verify prompt contains `### Project Context` but not `### Conversation Context`

**`'should not render meta into prompt'`**
- Provide bootstrap context with `meta: { itemCount: 5, estimatedTokens: 200, scopesQueried: ['project', 'conversation'] }`
- Verify prompt does not contain `itemCount`, `estimatedTokens`, or `scopesQueried`

**`'should produce unchanged prompt when bootstrapContext is absent'`**
- Use `baseRequest` (no `bootstrapContext` field)
- Verify prompt starts with `Task:` (no `## Prior Decisions` header)
- This confirms backward compatibility

**`'should produce unchanged prompt when bootstrapContext has empty scopes'`**
- Provide `bootstrapContext: { project: {}, conversation: {}, meta: { itemCount: 0, estimatedTokens: 0, scopesQueried: ['project'] } }`
- Verify prompt starts with `Task:` (renderBootstrapContext returns null for empty scopes)

**`'should JSON-stringify complex values'`**
- Provide a project item with an object value: `{ 'auth-pattern': { type: 'JWT', expiry: '24h' } }`
- Verify prompt contains the JSON-stringified form: `- auth-pattern: {"type":"JWT","expiry":"24h"}`

## Acceptance Criteria

- [x] `apps/mcp-server/src/messaging/bootstrap-context.service.spec.ts` exists as a new file with comprehensive test coverage
- [x] `BootstrapContextService` tests cover: disabled toggle, empty store, project-only, conversation-only, mixed context, budget enforcement (greedy bin-packing), budget splitting, budget reclamation, item recency ordering, and metadata accuracy
- [x] `apps/mcp-server/src/messaging/message-broker.service.spec.ts` extended with a `bootstrap context integration` describe block
- [x] Broker tests cover: bootstrap context attached on delivery, not set when null, non-fatal on assemble error, skipped on safeguard rejection (depth + unregistered agent)
- [x] `apps/agent/src/connection/invocation-handler.service.spec.ts` extended with a `bootstrap context rendering` describe block
- [x] Prompt rendering tests cover: project context present, conversation context present, empty project omitted, empty conversation omitted, meta not rendered, absent bootstrapContext unchanged, empty scopes unchanged, complex value JSON-stringification
- [x] All new tests pass: `npm run test`
- [x] No existing tests regressed: total test count increases, zero failures
- [x] `npm run build` passes with zero errors
- [x] `npm run lint` passes with zero errors, zero warnings

## Implementation Notes

**Status**: ✅ Complete — accepted in code review

**Files modified:**
| File | Change |
|------|--------|
| `apps/mcp-server/src/messaging/bootstrap-context.service.spec.ts` | **New** — 18 tests across 10 describe blocks |
| `apps/mcp-server/src/messaging/message-broker.service.spec.ts` | **Extended** — 5 new tests in `bootstrap context integration` describe block |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | **Extended** — 8 new tests in `bootstrap context rendering` describe block |

**Test counts:** +31 new tests (480 → 511 total), 39 suites, 0 failures

**Deviations:**
- Added `mockClear()` in broker safeguard-rejection tests — the existing `beforeEach` resets mock return values but not call counts, so explicit clearing was needed for `not.toHaveBeenCalled()` assertions.

**Verification results:**
- `npm run build`: ✅ All 4 apps compiled successfully
- `npm run lint`: ✅ 0 errors, 0 warnings
- `npm run test`: ✅ 511 passed, 0 failed, 39 suites

## Dependencies and References

**Prerequisites:**
- **QRM4-001** (✅ Complete) — `BootstrapContext`, `BootstrapContextMeta` types
- **QRM4-002** (✅ Complete) — `BootstrapContextService` with `assemble()` method
- **QRM4-003** (✅ Complete) — Broker integration, mock provider already in broker spec
- **QRM4-004** (✅ Complete) — `buildPrompt()` / `renderBootstrapContext()` in invocation handler

**Blocks:**
- None — QRM4-005 is a leaf node in the dependency graph

**Key file references:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/messaging/bootstrap-context.service.ts` | Primary test target — `assemble()`, `applyBudget()`, `estimateTokens()` |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | Test target — bootstrap call at lines 71–84 |
| `apps/agent/src/connection/invocation-handler.service.ts` | Test target — `buildPrompt()`, `renderBootstrapContext()` |
| `apps/mcp-server/src/messaging/message-broker.service.spec.ts` | Extend — add bootstrap integration tests |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Extend — add bootstrap rendering tests |
| `apps/mcp-server/src/config/broker.config.spec.ts` | Pattern reference — env var test save/restore pattern |
| `apps/mcp-server/src/registry/mock-connection.ts` | `MockConnection` — used in broker tests to capture delivered requests |
| `libs/common/src/messaging/invoke.types.ts` | `BootstrapContext`, `BootstrapContextMeta` — types for test fixtures |
| `libs/common/src/context-store/context-store.abstract.ts` | `ContextStore` — DI token for mock in bootstrap service tests |
| `libs/common/src/context-store/context-store.types.ts` | `ContextScope` enum — used in mock `getAll()` assertions |
| `tickets/QRM4-000-roadmap.md` | Roadmap — QRM4-005 subtask description |
| `tickets/QRM4-002-bootstrap-context-assembly-service.md` | Assembly service design — greedy bin-packing, budget reclamation |
| `tickets/QRM4-003-message-broker-integration.md` | Broker integration — non-fatal error handling, mock setup |
| `tickets/QRM4-004-agent-side-prompt-rendering.md` | Prompt rendering — format spec, subsection omission rules |
