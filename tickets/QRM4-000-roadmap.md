# QRM4 Roadmap — Bootstrap Context Injection

## Goal

When the Message Broker delivers an invocation to an agent, automatically query the Context Store for relevant project and conversation decisions and attach them to the request. Agents currently start each invocation blind — they receive only `action` and optional caller-provided `context`, then must manually query the Context Store for background. This milestone makes agents **context-aware from the first token** by injecting bootstrap context at the broker level.

This is the first milestone implemented by the Quorum agent system itself, serving as a real-world dogfooding test of the multi-agent collaboration workflow.

## Problem

Today's invocation flow (from `apps/mcp-server/src/messaging/message-broker.service.ts:64-70` TODO):

```
Moderator → invoke_agent(developer, "implement auth endpoint")
  → Broker delivers: { action: "implement auth endpoint", context: {} }
    → Developer starts with NO knowledge of prior decisions
      → Developer must call context_query to discover: JWT pattern, REST style, etc.
```

This wastes agent turns, burns tokens on discovery queries, and risks agents making decisions that contradict prior context they never saw. The existing TODO in the broker explicitly describes this gap.

## Success Criteria

- The Message Broker queries project-scope and conversation-scope context before delivering invocations
- Retrieved context is attached to `InvokeRequest` in a dedicated `bootstrapContext` field (separate from caller-provided `context`)
- Agents receive bootstrap context in their prompt without any code changes on their side (the `InvocationHandler.buildPrompt()` method renders it)
- Bootstrap context respects a configurable token budget (prevents oversized payloads)
- Project-scope context (architectural decisions, tech stack) is always included
- Conversation-scope context is included when a `correlationId` is present
- The feature is configurable and can be disabled (env var toggle)
- Existing behavior is preserved when bootstrap context is empty or disabled
- Unit tests cover broker context assembly, budget enforcement, and edge cases
- E2E validation: an invocation arrives at an agent with bootstrap context populated

## Scope Exclusions

- Changes to the Context Store search algorithm (substring matching remains — OpenSearch is a future milestone)
- Embedding or vector search
- Agent-scope context injection (private working memory stays private)
- Changes to how agents write context (only reading is affected)
- Prompt template changes beyond rendering the new `bootstrapContext` field
- Context Store performance optimization

---

## Milestone Scope

### QRM4-001 — Extend InvokeRequest with bootstrapContext Field

Add a `bootstrapContext` field to the `InvokeRequest` interface in `libs/common/src/messaging/invoke.types.ts` and define the `BootstrapContext` type that structures the injected data.

**Key decisions:**
- `bootstrapContext` is optional (backward-compatible — existing requests without it continue to work)
- Structured type separating project-scope items from conversation-scope items, each as `Record<string, unknown>`
- Include metadata: number of items, estimated tokens consumed, scopes queried
- The field is set by the broker, not by callers — callers continue to use `context` for explicit payloads

**Touches:**
- `libs/common/src/messaging/invoke.types.ts` — new interface + field
- `libs/common/src/messaging/index.ts` — barrel export

**Depends on:** —

### QRM4-002 — Bootstrap Context Assembly Service

Create a `BootstrapContextService` in `apps/mcp-server/src/messaging/` that queries the Context Store and assembles a `BootstrapContext` object within a token budget.

**Key decisions:**
- Query strategy: fetch project-scope `getAll()` first (always), then conversation-scope `getAll()` if `correlationId` is present
- Token budgeting: project context gets priority allocation (configurable split, e.g. 60/40 project/conversation)
- Item selection: when budget is exceeded, prefer newer items (`createdAt` descending) — most recent decisions are most relevant
- Token estimation: reuse existing `Math.ceil(JSON.stringify(value).length / 4)` convention
- Returns `null` when no context exists (broker skips injection)

**Configuration (env vars):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOTSTRAP_ENABLED` | `true` | Master toggle for the feature |
| `BOOTSTRAP_MAX_TOKENS` | `1000` | Total token budget for bootstrap context |
| `BOOTSTRAP_PROJECT_RATIO` | `0.6` | Fraction of budget allocated to project-scope items |

**Touches:**
- `apps/mcp-server/src/messaging/bootstrap-context.service.ts` — new service
- `apps/mcp-server/src/config/` — config factory additions for bootstrap settings
- `apps/mcp-server/src/messaging/messaging.module.ts` — wire service

**Depends on:** QRM4-001

### QRM4-003 — Message Broker Integration

Inject `BootstrapContextService` into `MessageBroker` and call it before delivering invocations. Replace the TODO at `message-broker.service.ts:64-70` with the actual implementation.

**Key decisions:**
- Bootstrap query happens after safeguard checks pass (no wasted queries on rejected invocations)
- Bootstrap failure is non-fatal — if the Context Store query throws, log a warning and deliver without bootstrap context
- The assembled `BootstrapContext` is attached to `request.bootstrapContext` before calling `agent.handle()`
- When `BOOTSTRAP_ENABLED=false`, skip the query entirely (zero overhead)
- Log the bootstrap result at DEBUG level: items injected, tokens consumed, scopes queried

**Touches:**
- `apps/mcp-server/src/messaging/message-broker.service.ts` — inject service, call before delivery
- `apps/mcp-server/src/messaging/messaging.module.ts` — import ContextStoreModule if not already

**Depends on:** QRM4-002

### QRM4-004 — Agent-Side Prompt Rendering

Update `InvocationHandler.buildPrompt()` in `apps/agent/src/connection/invocation-handler.service.ts` to render bootstrap context into the agent's prompt when present.

**Key decisions:**
- Bootstrap context is rendered as a clearly delineated section in the prompt (e.g., `## Prior Decisions` with project and conversation subsections)
- Placed before the task action so the agent reads context first, then the task
- The rendering is simple: key-value pairs, no complex formatting — agents are LLMs, they parse natural text well
- When `bootstrapContext` is absent or empty, prompt format is unchanged (backward-compatible)
- No changes to system prompts or prompt templates — bootstrap context is part of the user prompt

**Touches:**
- `apps/agent/src/connection/invocation-handler.service.ts` — modify `buildPrompt()`

**Depends on:** QRM4-001

### QRM4-005 — Unit Tests

Comprehensive unit tests for the new components and integration points.

**Test coverage:**
- `BootstrapContextService`: empty store, project-only, conversation-only, mixed, budget enforcement, budget splitting, item recency ordering, `correlationId` absent, disabled toggle
- `MessageBroker` integration: bootstrap context attached on delivery, non-fatal on error, skipped when disabled, skipped on safeguard rejection
- `InvocationHandler.buildPrompt()`: with bootstrap context, without, empty project, empty conversation, both scopes

**Touches:**
- `apps/mcp-server/src/messaging/bootstrap-context.service.spec.ts` — new
- `apps/mcp-server/src/messaging/message-broker.service.spec.ts` — extend existing
- `apps/agent/src/connection/invocation-handler.service.spec.ts` — extend existing

**Depends on:** QRM4-002, QRM4-003, QRM4-004

### QRM4-006 — Configuration & Documentation

Add environment variables to docker-compose.yml, update system documentation to reflect the new bootstrap context flow.

**Touches:**
- `docker-compose.yml` — add `BOOTSTRAP_*` env vars to MCP server service
- `docs/message-broker.md` — document bootstrap context injection in the "Context Integration" section
- `docs/context-management.md` — add "Pattern 4: Bootstrap Context Injection" usage pattern
- `docs/system-design.md` — update "Future Considerations" to mark this as implemented

**Depends on:** QRM4-003

---

## Dependency Graph

```
QRM4-001 (Types) ──→ QRM4-002 (Assembly Service) ──→ QRM4-003 (Broker Integration) ──→ QRM4-006 (Config & Docs)
             │                                                                    │
             └──────→ QRM4-004 (Agent Prompt) ──────────────────────────────────────┘
                                                                                  │
QRM4-005 (Tests) ←── QRM4-002 + QRM4-003 + QRM4-004 ─────────────────────────────┘
```

**Parallel tracks:** QRM4-002 (assembly service) and QRM4-004 (agent prompt rendering) can start simultaneously once QRM4-001 lands. QRM4-005 (tests) runs after the implementation tickets are complete. QRM4-006 (docs) runs after QRM4-003.

## Implementation Notes for Agents

### Existing Code References

| Component | File | Key Lines |
|-----------|------|-----------|
| TODO to implement | `apps/mcp-server/src/messaging/message-broker.service.ts` | 64-70 |
| `InvokeRequest` interface | `libs/common/src/messaging/invoke.types.ts` | 12-29 |
| `invoke_agent` tool handler | `apps/mcp-server/src/mcp/mcp.service.ts` | 83-149 |
| `InvocationHandler.buildPrompt()` | `apps/agent/src/connection/invocation-handler.service.ts` | 88-94 |
| `InMemoryStore.search()` | `apps/mcp-server/src/context-store/in-memory-store.ts` | 187-221 |
| `InMemoryStore.getAll()` | `apps/mcp-server/src/context-store/in-memory-store.ts` | ~160-185 |
| MCP server config | `apps/mcp-server/src/config/` | Config factories |
| Messaging module | `apps/mcp-server/src/messaging/messaging.module.ts` | Module wiring |
| `ContextStore` abstract | `libs/common/src/context-store/context-store.abstract.ts` | Abstract class |
| `ContextStoreModule` | `apps/mcp-server/src/context-store/context-store.module.ts` | Module export |

### Codebase Conventions

- **NestJS module pattern**: Services are `@Injectable()`, wired in `*.module.ts` providers/exports
- **Config**: Use `registerAs` factories with Zod validation, inject via `@Inject(config.KEY)` with `ConfigType<typeof config>`
- **Testing**: `Test.createTestingModule()` for NestJS integration tests, save/restore `process.env` for env var tests
- **Imports**: No `.js` extensions (webpack handles it), use `import type` for type-only imports in decorated constructors
- **Error handling**: Services return error values, never throw to callers — broker already follows this pattern
- **Logging**: Use `new Logger(ClassName.name)`, log correlationId in all messages

### Risk Assessment

This is a **low-risk, additive** change:
- No existing behavior is modified when bootstrap context is empty or disabled
- The `bootstrapContext` field is optional on `InvokeRequest` — all existing code continues to work
- Bootstrap query failure is non-fatal (degraded to warning)
- Token budget prevents payload bloat
- All changes are in the MCP server and agent app — no protocol changes, no Docker image changes