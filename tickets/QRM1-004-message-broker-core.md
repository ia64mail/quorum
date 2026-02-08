# QRM1-004: Message Broker — Core Routing and Safeguards

## Summary

Implement the Message Broker and Agent Registry as NestJS services inside the MCP Server application. Define shared messaging types (`AgentRole`, `InvokeRequest`, `InvokeResponse`) in `libs/common/`. The broker routes invoke requests between registered agent connections with three safeguards: circular call prevention, call depth limiting, and role-based timeouts. All tunable parameters consumed via `McpServerConfigService` following the per-app configuration pattern established in QRM1-003.

## Problem Statement

The MCP Server has configuration infrastructure (`broker.maxCallDepth`, `broker.defaultTimeoutMs` from QRM1-003) and a Context Store (QRM1-002), but no messaging capability. The core value proposition of Quorum — agents communicating with each other — requires a routing engine that can deliver invoke requests between registered agents.

Without safeguards, inter-agent communication is dangerous:
- **Circular calls** (A invokes B, B invokes A) deadlock both agents permanently
- **Unbounded delegation** (A→B→C→D→E→F→...) exhausts resources and produces untrackable chains
- **Hung agents** (target never responds) block the caller indefinitely

Additionally, no shared type definitions exist for agent roles or messaging contracts. Without canonical types in `libs/common/`, each future component (MCP tool registration, agent-side handler, transport layer) would define its own incompatible versions. Establishing these types now — alongside the service that consumes them — prevents divergence.

Risks of not doing this now:
- Every subsequent messaging ticket (MCP tools, WebSocket transport, agent handler) would need to define ad-hoc types and routing logic
- Safeguards added retroactively are harder to test in isolation — they should be designed into the broker from the start
- The existing `broker.*` config values from QRM1-003 have no consumer — this ticket closes that loop

## Design Context

### What the Docs Prescribe

`docs/message-broker.md` defines the full broker design: interfaces, routing logic, safeguards, transport, and availability handling. `docs/agent-messaging.md` describes the bidirectional MCP architecture that motivates the broker's existence. This ticket implements the **routing core and safeguards** — the internal services that will later be wired to MCP tools and WebSocket transport.

### Scope Boundary

This ticket implements in-process services with abstract connection interfaces. Transport (WebSocket delivery), MCP tool registration (`invoke_agent`), and agent-side handlers are explicitly out of scope — they depend on this foundation but involve separate concerns (MCP SDK integration, network transport, Claude Code CLI wrapping).

| In scope | Out of scope |
|----------|-------------|
| Shared types: `AgentRole`, `InvokeRequest`, `InvokeResponse` | MCP `invoke_agent` tool registration |
| `AgentConnection` abstraction | WebSocket transport / concrete connection impl |
| `AgentRegistry` service | Agent-side `AgentHandler` |
| `MessageBroker` service with all safeguards | Context Store integration with broker |
| Unit tests with mock connections | End-to-end integration tests |

### Configuration Integration

The `McpServerConfigService` (QRM1-003) already provides:
- `config.broker.maxCallDepth` — depth limit (default: 5)
- `config.broker.defaultTimeoutMs` — fallback timeout (default: 300,000ms)

The broker consumes these directly — no new config factories or env vars needed. This validates QRM1-003's forward-looking design.

**Role-based timeouts** (`docs/message-broker.md` lines 174–181) are code constants, not env vars. These are architectural design decisions (an architect review takes longer than a product owner clarification) that don't vary between deployment environments. The `config.broker.defaultTimeoutMs` serves as the fallback for any role not explicitly listed. If per-role configurability is needed later, the constants can be migrated to config without changing the broker's API.

### Where Types Live

Following the established convention: shared contracts in `libs/common/`, concrete implementations in the consuming app.

- **`AgentRole` enum** → `libs/common/` — used by all three apps (agent self-identifies, terminal's moderator is a caller, mcp-server routes by role)
- **`InvokeRequest` / `InvokeResponse`** → `libs/common/` — both the agent app (caller/receiver) and mcp-server (router) reference these
- **`AgentConnection` abstract class** → `apps/mcp-server/` — internal to the server; the agent app doesn't implement this directly (it receives messages via transport, not by subclassing)
- **`AgentRegistry`, `MessageBroker`** → `apps/mcp-server/` — server-internal services

## Implementation Details

### 1. Shared Messaging Types — `libs/common/src/messaging/`

**`agent-role.enum.ts`** — canonical enum of all messaging participants:

```typescript
enum AgentRole {
  moderator    = 'moderator',
  architect    = 'architect',
  teamlead     = 'teamlead',
  developer    = 'developer',
  qa           = 'qa',
  productowner = 'productowner',
}
```

Six roles, not five. The moderator is included because it's a valid `caller` in `InvokeRequest` — the Terminal App's LLM initiates agent delegations. It's never a valid *target* (the moderator doesn't register as an agent handler). The five deployable agent roles are a subset, not the full set.

**`invoke.types.ts`** — request/response contracts matching `docs/message-broker.md`:

`InvokeRequest` fields:
- `correlationId: string` — traces the entire call chain (UUID, generated by the originator)
- `parentRequestId?: string` — immediate caller's request ID (for nested call debugging)
- `caller: AgentRole` — who's sending
- `target: AgentRole` — who should receive
- `action: string` — what the target should do (natural language task description)
- `context?: Record<string, unknown>` — optional key-value payload (not full conversation)
- `wait: boolean` — synchronous (true) or fire-and-forget (false)
- `depth: number` — current call depth (0-based, incremented at each hop)

`InvokeResponse` fields:
- `success: boolean`
- `result?: string` — present on success
- `error?: string` — present on failure

These are plain interfaces (not classes) — they're data shapes, not DI tokens.

Barrel-exported via `libs/common/src/messaging/index.ts` and re-exported from `libs/common/src/index.ts`.

### 2. Update `agent.config.ts` to Use Shared Enum

The existing `apps/agent/src/config/agent.config.ts` has an inline Zod enum:

```typescript
z.enum(['architect', 'teamlead', 'developer', 'qa', 'productowner'])
```

Replace with `z.nativeEnum(AgentRole)` filtered to the five deployable roles. This keeps the agent config and messaging types synchronized. The validation still rejects `moderator` as an agent role (moderator is the Terminal App, not an agent container) — use Zod's `.exclude()` or a refined check.

Alternatively, define a `DEPLOYABLE_AGENT_ROLES` subset derived from the enum and use that in the Zod schema. This communicates the distinction explicitly in code.

### 3. Agent Connection Abstraction — `apps/mcp-server/src/registry/`

**`agent-connection.abstract.ts`** — what the broker sees of a connected agent:

```typescript
abstract class AgentConnection {
  abstract readonly role: AgentRole;
  abstract isConnected(): boolean;
  abstract handle(request: InvokeRequest, timeout: number): Promise<InvokeResponse>;
}
```

Abstract class (not interface) for two reasons:
1. Runtime value available for `instanceof` checks in the registry and broker
2. Consistent with the `ContextStore` abstract class pattern from QRM1-002

The concrete implementation (wrapping a WebSocket connection, sending the request over the wire, awaiting the response) comes in a future transport ticket. For this ticket, all tests use mock implementations.

### 4. Agent Registry — `apps/mcp-server/src/registry/`

**`AgentRegistry`** — `@Injectable()` service backed by `Map<AgentRole, AgentConnection>`:

| Method | Behavior |
|--------|----------|
| `register(connection)` | Stores by `connection.role`. Overwrites if role already registered (reconnection). Logs registration. |
| `unregister(role)` | Removes from map. Logs unregistration. |
| `get(role)` | Returns `AgentConnection \| undefined`. |
| `getAll()` | Returns all registered connections. |
| `isAvailable(role)` | Returns `true` only if registered **and** `isConnected()` returns true. |

One connection per role. The `docs/system-design.md` Docker Compose config shows one container per role (with developer using `replicas` for scaling). Multiple developers are a future concern — for now, one registration per role.

**`RegistryModule`** — provides and exports `AgentRegistry`. No imports needed (no dependencies on other modules).

### 5. Message Broker — `apps/mcp-server/src/messaging/`

**`MessageBroker`** — `@Injectable()` service. Core injections:
- `AgentRegistry` — agent lookup
- `McpServerConfigService` — `broker.maxCallDepth`, `broker.defaultTimeoutMs`

Core method: `async invoke(request: InvokeRequest): Promise<InvokeResponse>`

The invoke method applies safeguards in order of cost (cheapest first):

**Safeguard 1 — Depth limit** (O(1) check):
Compare `request.depth` against `this.config.broker.maxCallDepth`. If `depth >= maxCallDepth`, return error immediately. No registry lookup, no chain tracking — just a number comparison.

**Safeguard 2 — Circular call prevention** (O(1) amortized):
Internal state: `Map<string, Set<AgentRole>>` keyed by `correlationId`. Before delivery, check if `request.target` is already in the active set for this correlationId. If yes, return error with the chain visualization (e.g., `"Circular call: architect → developer → architect"`). Add `request.caller` to the set before delivery, remove in a `finally` block. Clean up the correlationId entry when the set is empty.

**Safeguard 3 — Agent availability** (O(1) lookup):
Call `registry.get(request.target)`. If undefined, return error: `"Agent {role} not registered"`. If registered but `!agent.isConnected()`, return error: `"Agent {role} not connected"`. No queueing for disconnected agents in this ticket — both sync and async calls fail immediately. Queueing is a future enhancement noted in `docs/message-broker.md`.

**Safeguard 4 — Timeout** (wraps delivery):
Look up the per-role timeout from constants, falling back to `this.config.broker.defaultTimeoutMs`. Wrap `agent.handle(request, timeout)` with `Promise.race` against a rejection timer. On timeout, return error: `"Agent {role} timed out after {ms}ms"`. Clean up the timer on normal completion.

**Role-based timeout constants** — `role-timeouts.ts`:

```typescript
const ROLE_TIMEOUTS: Partial<Record<AgentRole, number>> = {
  architect:    5 * 60_000,
  teamlead:     10 * 60_000,
  developer:    30 * 60_000,
  qa:           15 * 60_000,
  productowner: 2 * 60_000,
};
```

`Partial` because moderator has no timeout (never a target). The broker resolves timeout via: `ROLE_TIMEOUTS[role] ?? config.broker.defaultTimeoutMs`.

**Context Store bootstrap TODO:** The broker's `invoke()` method is the future integration point for pre-fetching bootstrap context from the Context Store before delivery. As described in `docs/context-store.md` (Integration with Message Broker section), the broker should eventually query `contextStore.search("conversation", "decisions", request.correlationId, 500)` and attach the results as `bootstrapContext` on the request — so the receiving agent starts with recent conversation decisions without needing to query for everything itself. This is the pull-based context model from `docs/context-management.md` Pattern 2 (Task Handoff). Leave a `// TODO:` comment at the delivery point (just before calling `agent.handle()`) describing this integration: what it does, where the design lives, and that it requires injecting `ContextStore` and extending `InvokeRequest` with a `bootstrapContext` field.

**Logging:** NestJS `Logger` with `MessageBroker` context. Every invoke logs: correlationId, caller, target, depth. Errors log the rejection reason. This matches the observability section in `docs/message-broker.md`.

**`MessagingModule`** — imports `RegistryModule`, provides and exports `MessageBroker`.

### 6. Module Integration

`McpServerModule` imports `MessagingModule` (which transitively imports `RegistryModule`). The registry and broker are now available throughout the mcp-server app for future MCP tool registration.

### 7. File Structure

```
libs/common/src/
  messaging/
    agent-role.enum.ts              # AgentRole enum — 6 messaging participants
    invoke.types.ts                 # InvokeRequest, InvokeResponse interfaces
    index.ts                        # Barrel export
  index.ts                          # Updated — adds messaging re-export

apps/agent/src/
  config/
    agent.config.ts                 # Modified — uses AgentRole from @app/common

apps/mcp-server/src/
  registry/
    agent-connection.abstract.ts    # Abstract class — role, isConnected, handle
    agent-registry.service.ts       # Map-based registry — register/unregister/get
    registry.module.ts              # Provides + exports AgentRegistry
    index.ts                        # Barrel export
  messaging/
    message-broker.service.ts       # Routing core — invoke() with 4 safeguards
    role-timeouts.ts                # Per-role timeout constants
    messaging.module.ts             # Imports RegistryModule, exports MessageBroker
    index.ts                        # Barrel export
  mcp-server.module.ts              # Modified — imports MessagingModule
```

### 8. Testing Strategy

**Registry tests** (`agent-registry.service.spec.ts`):
- Register a mock connection, retrieve it by role
- `get()` returns `undefined` for unregistered role
- `unregister()` removes the connection
- `isAvailable()` returns `false` when connection exists but `isConnected()` is `false`
- `isAvailable()` returns `false` for unregistered role
- `getAll()` returns all registered connections
- Re-registering a role overwrites the previous connection

**Broker tests** (`message-broker.service.spec.ts`):
- **Happy path**: invoke routes to correct agent, returns its response
- **Depth limit**: request at `maxCallDepth` returns depth error
- **Circular call**: A→B→A pattern detected and rejected with chain in error message
- **Agent not found**: unregistered target returns "not registered" error
- **Agent disconnected**: registered but disconnected target returns "not connected" error
- **Timeout**: `agent.handle` exceeds timeout, broker returns timeout error
- **Chain cleanup**: call chain map is cleaned after completion (both success and failure paths)
- **Async (wait: false)**: still fails immediately if agent unavailable (no queueing)

Use mock `AgentConnection` implementations (extend abstract class, control `isConnected()` and `handle()` behavior). NestJS `Test.createTestingModule()` for proper DI wiring with `McpServerConfigService` (mocked or loaded with test env vars following the pattern from QRM1-003 tests).

## Acceptance Criteria

- [ ] `AgentRole` enum exported from `libs/common/src/messaging/` with all 6 roles (including moderator)
- [ ] `InvokeRequest` and `InvokeResponse` interfaces exported from `libs/common/src/messaging/`
- [ ] `libs/common/src/index.ts` barrel-exports the new messaging module
- [ ] `apps/agent/src/config/agent.config.ts` updated to reference the shared `AgentRole` enum
- [ ] `AgentConnection` abstract class in `apps/mcp-server/src/registry/` with `role`, `isConnected()`, `handle()`
- [ ] `AgentRegistry` service with `register`/`unregister`/`get`/`getAll`/`isAvailable`
- [ ] `RegistryModule` provides and exports `AgentRegistry`
- [ ] `MessageBroker` service injects `AgentRegistry` and `McpServerConfigService`
- [ ] Depth limit: rejects when `depth >= config.broker.maxCallDepth`
- [ ] Circular call prevention: tracks active chains per `correlationId`, rejects cycles with chain trace in error
- [ ] Role-based timeouts: per-role constants with `config.broker.defaultTimeoutMs` fallback via `Promise.race`
- [ ] Agent availability: fails immediately if target not registered or disconnected
- [ ] `MessagingModule` imports `RegistryModule`, exports `MessageBroker`
- [ ] `McpServerModule` imports `MessagingModule`
- [ ] All call chain tracking state is cleaned up in `finally` blocks (no leaks on error)
- [ ] NestJS `Logger` used with correlationId, caller, target, depth in log entries
- [ ] Unit tests cover: happy path, depth limit, circular call, not found, disconnected, timeout, chain cleanup
- [ ] `// TODO:` comment in `MessageBroker.invoke()` before `agent.handle()` documenting the future Context Store bootstrap integration (references `docs/context-store.md` and `docs/context-management.md` Pattern 2)
- [ ] No new env vars or config factories needed — existing `broker.*` config consumed via `McpServerConfigService`
- [ ] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-001 — Core packages installed (NestJS, Zod)
- QRM1-002 — Context Store implemented (module pattern, abstract class convention)
- QRM1-003 — Configuration management (`McpServerConfigService` with `broker.maxCallDepth`, `broker.defaultTimeoutMs`)

### What This Blocks
- MCP `invoke_agent` tool registration — needs the broker to route calls and shared types for the tool schema
- WebSocket transport implementation — needs `AgentConnection` abstraction to create the concrete implementation
- Agent-side handler — needs shared types (`InvokeRequest`, `InvokeResponse`, `AgentRole`)
- Context Store integration with broker — needs the broker to exist before wiring in bootstrap context

### References
- [docs/message-broker.md](../docs/message-broker.md) — Full broker design: interfaces, safeguards, transport, availability
- [docs/agent-messaging.md](../docs/agent-messaging.md) — Bidirectional MCP architecture, communication patterns, `invoke_agent` tool
- [docs/system-design.md](../docs/system-design.md) — MCP Server container, agent roles, Docker Compose config
- [docs/context-management.md](../docs/context-management.md) — Context passing patterns (future broker integration)