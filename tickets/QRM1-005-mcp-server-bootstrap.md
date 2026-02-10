# QRM1-005: MCP Server Bootstrap — SDK Integration, Tools & Resources

## Summary

Wire the `@modelcontextprotocol/sdk` `McpServer` into the NestJS `mcp-server` application. Set up Streamable HTTP transport, register the `invoke_agent` tool (routing through `MessageBroker`), four context management tools (`context_store`, `context_query`, `context_summarize`, `context_stats`) routing through `ContextStore`, and two context resources (`context://project`, `context://conversation/{correlationId}`). This transforms the mcp-server from a NestJS app with internal services into an operational MCP server that clients can connect to.

## Problem Statement

The mcp-server application has all supporting infrastructure — `MessageBroker` for routing inter-agent calls (QRM1-004), `ContextStore` for shared context persistence (QRM1-002), and typed configuration (QRM1-003) — but no MCP protocol surface. The `@modelcontextprotocol/sdk` package is installed (QRM1-001) and unused. No client (terminal moderator, agent container) can connect or communicate.

Without the MCP protocol layer:
- The `invoke_agent` concept exists only as internal types and broker routing — no client can actually call it
- Context tools (`context_store`, `context_query`, etc.) exist only in design docs — agents can't store or query shared decisions
- No transport means no client can connect to the server
- The existing NestJS placeholder controller (`GET /` → "Hello World!") and service serve no purpose in the MCP architecture

The mcp-server is the communication backbone per `docs/system-design.md`. Until it speaks MCP protocol, no inter-agent collaboration is possible. This ticket closes the gap between internal services and the external protocol surface.

## Design Context

### What the Docs Prescribe

`docs/agent-messaging.md` defines the `invoke_agent` tool schema and bidirectional communication patterns. `docs/context-management.md` defines four context tools and two context resources with full Zod schemas. `docs/message-broker.md` describes the broker's routing core and transport expectations. `docs/system-design.md` positions the MCP Server as the central hub connecting all agents via MCP Protocol.

### Transport Choice

The design docs reference WebSocket (`docs/message-broker.md` line 206), but `@modelcontextprotocol/sdk` has since standardized on **Streamable HTTP** as the recommended server transport. Streamable HTTP supports both request-response and server-initiated streaming over standard HTTP with built-in session management. This is preferred over raw WebSocket for this ticket because:

1. **NestJS-native** — works with Express/Fastify under the hood, no WebSocket gateway setup needed
2. **Session-aware** — tracks connected clients via session IDs without manual connection management
3. **SDK-idiomatic** — `Client` from the SDK supports `StreamableHTTPClientTransport` natively
4. **Bidirectional** — agents keep a GET connection open (SSE) for server-initiated messages (future task delivery)

The three HTTP routes (`POST /mcp`, `GET /mcp`, `DELETE /mcp`) map cleanly to a NestJS controller. Stateless requests (tool calls, resource reads) arrive as POST; long-lived SSE streams for server push use GET; session cleanup uses DELETE.

### Scope Boundary

This ticket wires existing services to MCP protocol. It creates the MCP surface but does not implement the agent-side client or concrete transport delivery.

| In scope | Out of scope |
|----------|-------------|
| `McpServer` instance creation + NestJS lifecycle integration | Concrete `AgentConnection` implementation (transport-specific delivery to agents) |
| Streamable HTTP transport endpoint (`/mcp`) | Agent-side MCP client connection logic |
| `invoke_agent` tool → `MessageBroker` routing | Agent handler implementation (Claude Code CLI wrapping) |
| 4 context tools → `ContextStore` | LLM-powered summarization (`context_summarize` uses POC truncation) |
| 2 context resources → `ContextStore` | Resource subscription change notifications |
| Replace placeholder controller/service with MCP implementation | Docker/deployment changes |
| `callerRole` parameter workaround for SDK identity limitation | End-to-end multi-agent integration tests |

### NestJS Integration Pattern

The MCP SDK's `McpServer` is not a NestJS primitive — it's a standalone class with its own tool/resource registration API. The integration pattern:

1. **`McpService`** (`@Injectable()`, implements `OnModuleInit`) — wraps the `McpServer` instance. Registers all tools and resources during `onModuleInit()`. Injects `MessageBroker`, `ContextStore`, `McpServerConfigService`.

2. **`McpController`** — NestJS controller handling `POST/GET/DELETE /mcp`. Manages session-to-transport mapping. Delegates HTTP request/response handling to `StreamableHTTPServerTransport` from the SDK.

3. **`McpModule`** — imports `MessagingModule` and `ContextStoreModule`; provides `McpService`; declares `McpController`.

The existing placeholder `McpServerController` and `McpServerService` (scaffold artifacts) are removed — their functionality is entirely replaced by the MCP protocol implementation.

### Agent Identity (SDK Limitation)

The MCP SDK does not expose client identity in tool handlers (`docs/context-management.md`, SDK Limitations section). Two approaches exist:

1. **Explicit `callerRole` parameter** — agents self-identify on every tool call. Simple, suitable for POC.
2. **Session-based identity** — record agent role at connection time in session metadata. More secure, requires transport-level tracking.

This ticket uses approach 1. The `invoke_agent` tool accepts a `callerRole` parameter and trusts it. Context tools accept an `agentRole` parameter for attribution. This matches the workaround pattern documented in `docs/context-management.md`. Session-based identity is a future enhancement.

## Implementation Details

### 1. McpService — `apps/mcp-server/src/mcp/mcp.service.ts`

The core service wrapping `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.

**Constructor injections:**
- `MessageBroker` — for `invoke_agent` routing
- `ContextStore` — for context tools and resources
- `McpServerConfigService` — for `context.defaultMaxTokens`, `context.tokenCharRatio`

Creates the `McpServer` instance:

```typescript
new McpServer({ name: 'quorum', version: '0.1.0' })
```

Implements `OnModuleInit`. In `onModuleInit()`, calls private registration methods for each tool and resource (sections 3–5 below). This ensures all tools/resources are registered before any client connects.

Exposes a `connect(transport)` method that delegates to `this.server.connect(transport)` — used by the controller when new sessions start.

### 2. Transport — `apps/mcp-server/src/mcp/mcp.controller.ts`

NestJS controller at route path `/mcp` managing Streamable HTTP transport.

**Session management:** `Map<string, StreamableHTTPServerTransport>` maps session IDs to active transports.

**`POST /mcp`** — handles incoming MCP protocol messages (tool calls, resource reads):
- If the request includes a valid session ID header (`mcp-session-id`), delegate to the existing transport's `handleRequest()`.
- If no session ID, create a new `StreamableHTTPServerTransport`, call `mcpService.connect(transport)`, store by session ID, then handle the request.
- Return appropriate MCP protocol response.

**`GET /mcp`** — opens an SSE stream for server-initiated messages:
- Requires valid session ID header.
- Delegates to the transport's SSE handling.
- Connection stays open for server push (future agent task delivery).

**`DELETE /mcp`** — cleans up a session:
- Closes the transport, removes from the session map.

Uses `@Req()` and `@Res()` to pass the raw Express request/response to the SDK transport, since the MCP protocol handling is opaque to NestJS.

**Session cleanup:** For the POC, sessions are cleaned up on explicit DELETE. A `// TODO:` comment documents the need for idle timeout cleanup in production.

### 3. Tool: `invoke_agent`

Registered via `this.server.tool()` in `McpService.onModuleInit()`.

**Schema:**

```typescript
{
  callerRole: z.nativeEnum(AgentRole),
  target: z.enum(DEPLOYABLE_AGENT_ROLES),
  action: z.string().describe('What you need the agent to do'),
  context: z.record(z.any()).optional().describe('Relevant context to pass'),
  wait: z.boolean().default(true).describe('Wait for response or fire-and-forget'),
  correlationId: z.string().uuid().optional().describe('Omit for top-level calls; pass through for nested'),
  depth: z.number().int().min(0).default(0).describe('Current call depth; 0 for top-level'),
}
```

**Handler logic:**
1. Generate `correlationId` via `randomUUID()` if not provided (top-level call).
2. Construct `InvokeRequest` from tool arguments: `{ correlationId, caller: callerRole, target, action, context, wait, depth }`.
3. Call `this.messageBroker.invoke(request)`.
4. Return `InvokeResponse` as MCP tool result: `{ content: [{ type: 'text', text: JSON.stringify(response) }] }`.
5. Log with correlationId, caller, target, depth.

`callerRole` accepts all `AgentRole` values (including `moderator`) because the terminal moderator is a valid caller. `target` accepts only `DEPLOYABLE_AGENT_ROLES` (excludes `moderator`) because the moderator is never a target — it's the terminal app, not a registered agent.

The `parentRequestId` field on `InvokeRequest` is populated from `correlationId` when `depth > 0` — the caller's correlationId serves as the parent reference for nested call tracing.

### 4. Tools: Context Management

All four registered via `this.server.tool()` in `McpService.onModuleInit()`.

**`context_store`** — write context for other agents:

Schema:
- `agentRole: z.nativeEnum(AgentRole)` — self-identification
- `scope: z.nativeEnum(ContextScope)`
- `key: z.string().min(1)`
- `value: z.any()` — the data to store
- `correlationId: z.string().optional()` — required for `conversation` scope
- `ttl: z.number().int().positive().optional()` — auto-expire in milliseconds

Handler validates that `correlationId` is present when `scope === 'conversation'`. Calls `contextStore.set({ scope, key, value, id: correlationId, createdBy: agentRole, ttl })`. Returns confirmation: `"Stored {key} in {scope} scope"`.

**`context_query`** — read context with token budget:

Schema:
- `scope: z.nativeEnum(ContextScope)`
- `query: z.string().optional()` — natural language search query
- `keys: z.array(z.string()).optional()` — specific keys to retrieve
- `correlationId: z.string().optional()` — required for `conversation` scope
- `maxTokens: z.number().int().positive().optional()` — defaults to `config.context.defaultMaxTokens`

Handler dispatches three modes:
1. **Keys mode** (if `keys` provided): call `contextStore.get(scope, key, correlationId)` for each key, assemble into `Record<string, unknown>`. Drop keys returning `undefined`.
2. **Search mode** (if `query` provided): call `contextStore.search(scope, query, correlationId, maxTokens)`.
3. **Get-all mode** (neither): call `contextStore.getAll(scope, correlationId)`.

Returns `JSON.stringify(result)` as text content.

**`context_summarize`** — compress verbose context (POC heuristic):

Schema:
- `correlationId: z.string()`
- `targetTokens: z.number().int().positive().default(500)`
- `preserveKeys: z.array(z.string()).optional()`

Handler POC strategy:
1. Call `contextStore.getAll(ContextScope.conversation, correlationId)` to get all items.
2. Separate items whose keys are in `preserveKeys` (kept verbatim) from the rest.
3. Calculate token budget for non-preserved: `targetTokens - estimateTokens(preservedItems)`. Use `config.context.tokenCharRatio` for estimation.
4. Sort non-preserved items by key (stable ordering). Accumulate newest-first until budget exhausted (or oldest-first if `createdAt` metadata is available from the store items — but `getAll()` returns `Record<string, unknown>`, not full `ContextItem`s with timestamps).
5. Combine preserved + surviving non-preserved into a summary object.
6. Store back via `contextStore.set({ scope: ContextScope.conversation, key: '_summary', value: summary, id: correlationId })`.
7. Return token count of the stored summary.

Because `getAll()` returns values without timestamps, the POC truncation simply drops items from the record until the budget fits (iterating keys in insertion order). A `// TODO:` comment documents the future path: inject LLM for semantic summarization, use `search()` instead of `getAll()` for ranked results.

**`context_stats`** — visibility into context usage:

Schema:
- `scope: z.nativeEnum(ContextScope).optional()`
- `correlationId: z.string().optional()`

Handler calls `contextStore.getStats(scope, correlationId)`. Returns `JSON.stringify(stats, null, 2)` as text content.

### 5. Resources: Context Access

Both registered in `McpService.onModuleInit()`.

**`context://project`** — static resource:

Registered via `server.resource()` with URI `context://project`. Handler calls `contextStore.getAll(ContextScope.project)`, returns JSON text content.

**`context://conversation/{correlationId}`** — parameterized resource template:

Registered via `server.resource()` with a `ResourceTemplate` from the SDK. The URI template `context://conversation/{correlationId}` extracts the correlationId parameter. Handler calls `contextStore.getAll(ContextScope.conversation, correlationId)`, returns JSON text content.

Both resources return `{ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] }`.

Resource subscriptions (server pushing `notifications/resources/updated` when context changes) are deferred — they require wiring `ContextStore` change events (via `@OnEvent('context.change')`) to the MCP notification API, which is a concern for a separate ticket after the basic protocol surface works.

### 6. Module Wiring

**`McpModule`** (`apps/mcp-server/src/mcp/mcp.module.ts`):
- Imports: `MessagingModule`, `ContextStoreModule`
- Providers: `McpService`
- Controllers: `McpController`
- Exports: `McpService`

**`McpServerModule`** (root — `apps/mcp-server/src/mcp-server.module.ts`):
- Updated imports: replace `MessagingModule` with `McpModule` (which transitively imports `MessagingModule` and `ContextStoreModule`)
- Remove: `McpServerController`, `McpServerService` declarations
- Keep: `McpServerConfigModule` (configuration still loaded at root level)

The placeholder files `mcp-server.controller.ts` and `mcp-server.service.ts` are deleted. Their test files (`mcp-server.controller.spec.ts`, `mcp-server.service.spec.ts`) are also removed if they exist.

### 7. File Structure

```
apps/mcp-server/src/
  mcp/
    mcp.service.ts                 # McpServer wrapper, tool/resource registration
    mcp.service.spec.ts            # Unit tests for tool handlers, resource handlers
    mcp.controller.ts              # POST/GET/DELETE /mcp transport endpoint
    mcp.controller.spec.ts         # Transport endpoint tests
    mcp.module.ts                  # Imports MessagingModule + ContextStoreModule
    index.ts                       # Barrel export
  mcp-server.module.ts             # Updated — imports McpModule, removes placeholders
  main.ts                          # Unchanged

  # Removed:
  mcp-server.controller.ts         # Placeholder — replaced by mcp/mcp.controller.ts
  mcp-server.service.ts            # Placeholder — replaced by mcp/mcp.service.ts
  mcp-server.controller.spec.ts    # Removed with its source (if exists)
  mcp-server.service.spec.ts       # Removed with its source (if exists)
```

### 8. Testing Strategy

**McpService tests** (`mcp.service.spec.ts`):

Mock `MessageBroker` and `ContextStore` via NestJS `Test.createTestingModule()`. Test tool and resource handlers by calling the registered handler functions directly (extracted as private methods on the service, testable via the service instance or via the `McpServer`'s internal handler dispatch).

Tool handler tests:
- **`invoke_agent` happy path**: handler constructs correct `InvokeRequest`, routes to broker, returns response as JSON text content
- **`invoke_agent` generates correlationId**: when `correlationId` omitted, handler generates a UUID
- **`invoke_agent` passes through correlationId**: when provided, it's forwarded to the broker
- **`invoke_agent` broker error**: when broker returns `{ success: false, error: '...' }`, handler returns the error in MCP text content
- **`context_store`**: calls `contextStore.set()` with correct params including `id: correlationId`, `createdBy: agentRole`
- **`context_store` validates correlationId for conversation scope**: rejects if `scope === conversation` and no correlationId
- **`context_query` keys mode**: calls `get()` for each key, assembles result
- **`context_query` search mode**: calls `search()` with query and maxTokens
- **`context_query` get-all mode**: calls `getAll()` when no keys or query
- **`context_query` default maxTokens**: uses `config.context.defaultMaxTokens` when not specified
- **`context_summarize`**: stores truncated summary as `_summary` key
- **`context_stats`**: calls `getStats()` and returns formatted JSON

Resource handler tests:
- **`context://project`**: calls `getAll(ContextScope.project)`, returns JSON
- **`context://conversation/{id}`**: extracts correlationId, calls `getAll(ContextScope.conversation, id)`, returns JSON

**McpController tests** (`mcp.controller.spec.ts`):
- POST with no session ID creates new transport and session
- POST with existing session ID reuses transport
- GET with valid session ID opens SSE stream
- DELETE cleans up session and transport
- POST/GET with invalid session ID returns error

Use `supertest` or mock `Request`/`Response` objects for HTTP-level testing.

## Acceptance Criteria

- [ ] `McpServer` instance created from `@modelcontextprotocol/sdk` with metadata `{ name: 'quorum', version: '0.1.0' }`
- [ ] `McpService` implements `OnModuleInit`, registers all tools and resources during initialization
- [ ] Streamable HTTP transport endpoint at `/mcp` (POST, GET, DELETE)
- [ ] Session management via `Map<string, StreamableHTTPServerTransport>` with proper lifecycle
- [ ] `invoke_agent` tool registered with `callerRole`, `target`, `action`, `context`, `wait`, `correlationId`, `depth` parameters
- [ ] `invoke_agent` generates `correlationId` (UUID) for top-level calls, passes through for nested
- [ ] `invoke_agent` routes through `MessageBroker.invoke()` and returns response as MCP text content
- [ ] `context_store` tool validates `correlationId` presence for conversation scope
- [ ] `context_store` routes to `ContextStore.set()` with correct parameter mapping
- [ ] `context_query` supports three modes: keys lookup, search query, get-all
- [ ] `context_query` defaults `maxTokens` to `config.context.defaultMaxTokens`
- [ ] `context_summarize` implements POC truncation strategy (not LLM-based)
- [ ] `context_summarize` stores result as `_summary` key in conversation scope
- [ ] `context_stats` routes to `ContextStore.getStats()` and returns formatted JSON
- [ ] `context://project` resource returns project-scope context as JSON
- [ ] `context://conversation/{correlationId}` resource template returns conversation-scope context as JSON
- [ ] Placeholder `McpServerController` and `McpServerService` removed
- [ ] `McpModule` created, imports `MessagingModule` + `ContextStoreModule`, exports `McpService`
- [ ] `McpServerModule` updated to import `McpModule` instead of `MessagingModule`
- [ ] Zod schemas use shared types from `@app/common` (`AgentRole`, `DEPLOYABLE_AGENT_ROLES`, `ContextScope`)
- [ ] NestJS `Logger` used with correlationId in tool handlers
- [ ] `// TODO:` comments for: session idle timeout cleanup, LLM-based summarization, resource subscription notifications
- [ ] Unit tests cover all tool handlers, resource handlers, and controller transport management
- [ ] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-001 — `@modelcontextprotocol/sdk` (`^1.26.0`) installed
- QRM1-002 — `ContextStore` implemented (`InMemoryStore`, abstract class, `ContextStoreModule`)
- QRM1-003 — Configuration management (`McpServerConfigService` with `context.defaultMaxTokens`, `context.tokenCharRatio`)
- QRM1-004 — Message Broker implemented (`MessageBroker`, `AgentRegistry`, shared types: `AgentRole`, `InvokeRequest`, `InvokeResponse`, `DEPLOYABLE_AGENT_ROLES`)

### What This Blocks
- Agent-side MCP client connection — agents need a running MCP server with registered tools to connect to
- Terminal app moderator — needs `invoke_agent` tool available on the server
- Concrete `AgentConnection` implementation — needs the server's transport and session model to deliver tasks to agents
- Resource subscriptions — needs the protocol surface to exist before wiring change events to MCP notifications
- End-to-end integration testing — needs all pieces connected through the protocol

### References
- [docs/agent-messaging.md](../docs/agent-messaging.md) — `invoke_agent` tool schema, bidirectional MCP patterns
- [docs/context-management.md](../docs/context-management.md) — Context tools/resources API, SDK limitations, agent identity workaround
- [docs/context-store.md](../docs/context-store.md) — ContextStore interface, broker integration point
- [docs/message-broker.md](../docs/message-broker.md) — Broker routing core, transport section
- [docs/system-design.md](../docs/system-design.md) — MCP Server container, network communication, monorepo structure
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP TypeScript SDK (McpServer, StreamableHTTPServerTransport, ResourceTemplate)