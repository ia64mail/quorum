# QRM2-003: MCP Orchestration Tool Bridge

## Summary

Create an adapter layer that exposes the five MCP orchestration tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) as in-process Claude Code custom tools via the SDK's `createSdkMcpServer()`. Each tool proxies back to `McpClientService.callTool()` with auto-augmented parameters (correlationId, callerRole, depth) captured from the active `InvokeRequest`. This gives Claude Code sessions access to Quorum's inter-agent communication and shared context — without the agent LLM having to know about request plumbing.

## Problem Statement

QRM2-002 gave agents a Claude Code runtime with built-in tool capabilities (Read, Edit, Bash, Grep, etc.). But these sessions are isolated — they can operate on the workspace filesystem but have no way to reach the MCP server. An agent running inside a Claude Code session cannot:

- **Invoke other agents.** The developer agent can't ask the architect for a design clarification or the team lead for task scope because `invoke_agent` isn't available as a Claude Code tool.
- **Read or write shared context.** Decisions stored via `context_store` by one agent are invisible to Claude Code sessions of other agents — the `context_query`/`context_store`/`context_summarize`/`context_stats` tools don't exist in the CC tool namespace.
- **Participate in orchestrated workflows.** The entire collaboration model — moderator delegates to team lead, team lead creates tickets, developer requests reviews — depends on agents calling MCP tools mid-task. Without the bridge, Claude Code agents are capable coders but deaf to the team.

The bridge closes this gap. It translates between two worlds: the SDK's in-process `SdkMcpToolDefinition` format and the remote MCP server's tool protocol, using `McpClientService` as the transport layer.

## Design Context

### In-Process MCP Server Pattern

The Claude Code SDK supports custom tools via `createSdkMcpServer()`, which creates an in-process `McpServer` instance. This server lives inside the NestJS agent process and is passed to `query()` through the `mcpServers` option. The SDK's Claude Code subprocess discovers these tools via in-process MCP transport — no network round-trip.

```
NestJS Agent Process                         Claude Code Subprocess
┌──────────────────────────────────┐        ┌──────────────────────┐
│ InvocationHandler                │        │ Claude Code Runtime  │
│   └→ ClaudeCodeService.execute() │        │   LLM + built-in    │
│        mcpServers: {             │        │   tools (Read, Edit, │
│          "quorum": bridgeServer ←──IPC───→│   Bash, Grep, ...)   │
│        }                         │        │                      │
│                                  │        │   + Custom tools:    │
│ McpToolBridgeService             │        │     invoke_agent     │
│   └→ McpClientService.callTool()─── HTTP ──→ MCP Server         │
│        (remote)                  │        │     context_store    │
└──────────────────────────────────┘        │     context_query    │
                                            │     ...              │
                                            └──────────────────────┘
```

The bridge is the adapter between these two layers: it implements `SdkMcpToolDefinition` handlers that delegate to the remote MCP server via `McpClientService`.

### Parameter Auto-Augmentation

The current `InvocationHandler.augmentArgs()` pattern silently injects request-scoped parameters before forwarding tool calls to the MCP server. The bridge must replicate this behavior so that Claude Code's LLM never needs to provide plumbing parameters like `callerRole` or `depth`:

| Tool | Auto-injected | Agent provides |
|------|---------------|----------------|
| `invoke_agent` | `callerRole`, `correlationId`, `depth` (always overridden) | `target`, `action`, `context`, `wait` |
| `context_store` | `correlationId` (default, agent can override) | `scope`, `key`, `value`, `agentRole`, `ttl` |
| `context_query` | `correlationId` (default, agent can override) | `scope`, `mode`, `keys`, `query`, `maxTokens` |
| `context_summarize` | `correlationId` (default, agent can override) | `maxTokens`, `preserveKeys` |
| `context_stats` | *(none)* | `scope`, `correlationId` |

For `invoke_agent`, auto-params are spread *after* the agent's args (always override). For `context_*` tools, `correlationId` is spread *before* (default that the agent can override when querying a different conversation's context). This matches the existing `augmentArgs` semantics.

### SDK Tool Definition API

The SDK provides a `tool()` helper and `SdkMcpToolDefinition<Schema>` type:

```typescript
type SdkMcpToolDefinition<Schema> = {
  name: string;
  description: string;
  inputSchema: Schema;          // Zod raw shape (not z.object(), just the shape)
  annotations?: ToolAnnotations;
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

Handlers return `CallToolResult` from `@modelcontextprotocol/sdk/types.js` — the same `{ content: [{ type: "text", text: "..." }], isError?: boolean }` shape that `McpClientService.callTool()` already returns from the remote MCP server. This means the bridge handlers can pass through MCP results with minimal transformation.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `McpToolBridgeService` with `createBridge()` method | Role permission profiles (QRM2-004) |
| 5 orchestration tool definitions as `SdkMcpToolDefinition` | InvocationHandler migration (QRM2-005) |
| Parameter auto-augmentation from `InvokeRequest` | Prompt template updates (QRM2-006) |
| Resolve `TODO(QRM2-003)` in `claude-code.types.ts` | Terminal app changes (QRM2-007) |
| Unit tests for bridge service | |

## Implementation Details

### McpToolBridgeService

Location: `apps/agent/src/llm/mcp-tool-bridge.service.ts`

Injectable NestJS service that creates request-scoped in-process MCP servers.

**Constructor dependencies:**
- `McpClientService` — proxies tool calls to the remote MCP server
- `AgentConfigService` — provides `agent.role` for `callerRole` injection

**Primary method: `createBridge(request: InvokeRequest): Record<string, McpSdkServerConfigWithInstance>`**

Creates a new in-process MCP server for each invocation. The server is not long-lived — it captures the `InvokeRequest`'s `correlationId`, `caller`, and `depth` in handler closures, scoping it to a single Claude Code session. Returns a map with a single entry keyed `"quorum"` (the logical MCP server name), suitable for passing directly to `ExecuteParams.mcpServers`.

The method:

1. Builds the five `SdkMcpToolDefinition` objects using the SDK's `tool()` helper. Each definition specifies a Zod schema (agent-facing, with auto-params stripped) and a handler closure that:
   - Merges auto-augmented parameters with the agent's args (respecting override semantics)
   - Calls `McpClientService.callTool(name, augmentedArgs)`
   - Returns the MCP result directly (it's already `CallToolResult`-shaped)

2. Calls `createSdkMcpServer({ name: 'quorum', tools: [...] })` with the tool definitions.

3. Returns `{ quorum: serverConfig }`.

### Tool Definitions

Each tool's bridge definition mirrors the server-side schema from `McpService` but strips auto-injected parameters from the `inputSchema`. The descriptions should be identical to the server-side ones — they're what Claude Code's LLM sees when deciding which tool to use.

**`invoke_agent`** — The agent provides `target`, `action`, `context`, `wait`. The handler injects `callerRole` (from config), `correlationId` (from request), and `depth` (request.depth + 1) with override semantics (injected params always win).

**`context_store`** — The agent provides `scope`, `key`, `value`, `agentRole`, `ttl`, and optionally `correlationId`. The handler injects `correlationId` as a default (agent's value wins if provided).

**`context_query`** — The agent provides `scope`, `mode`, `keys`, `query`, `maxTokens`, and optionally `correlationId`. Same default injection.

**`context_summarize`** — The agent provides `maxTokens`, `preserveKeys`, and optionally `correlationId`. Default injection. Note: on the server side, `correlationId` is required — the default injection ensures it's always present.

**`context_stats`** — No auto-injection. The agent provides `scope` and `correlationId`, both optional. Passed through unchanged.

### Error Handling

Tool handler errors should be caught and returned as `CallToolResult` with `isError: true` rather than throwing — a thrown exception from an in-process MCP tool would crash the Claude Code session. Common failure modes:

- `McpClientService.callTool()` throws (network error, MCP server down) — catch and return error result
- MCP server returns `isError: true` (validation failure, agent unavailable) — pass through as-is

### Type Refinement

Resolve the `TODO(QRM2-003)` in `claude-code.types.ts`: change the `mcpServers` field type from `McpServerConfig` to `McpSdkServerConfigWithInstance`. In Quorum's architecture, agents always use in-process MCP servers created by the bridge — the stdio/SSE/HTTP server config variants are not applicable. Narrowing the type makes this explicit and provides better IDE assistance.

### Module Wiring

Add `McpToolBridgeService` to `LlmModule`'s providers and exports. It depends on `McpClientService` (from `ConnectionModule`) and `AgentConfigService` (from `AgentConfigModule`). Since `ConnectionModule` already imports `LlmModule`, and `McpToolBridgeService` needs `McpClientService` from `ConnectionModule`, this creates a circular dependency.

Resolution: move `McpToolBridgeService` to `ConnectionModule` instead of `LlmModule`. `ConnectionModule` already imports `LlmModule` and owns `McpClientService` — the bridge is the adapter between MCP client connectivity and the LLM layer. Export it from `ConnectionModule` so `InvocationHandler` (QRM2-005) can use it.

Alternatively, inject `McpClientService` via `forwardRef` if keeping it in `LlmModule` is preferred. The ticket implementor should choose based on what feels more natural — the bridge conceptually bridges both modules.

### Testing Strategy

Unit tests mock `McpClientService.callTool()` and verify parameter augmentation and result passthrough.

**Test cases:**

- **`invoke_agent` augmentation:** Call the bridge tool with `{ target: 'architect', action: 'review' }`. Verify `McpClientService.callTool` receives `{ target: 'architect', action: 'review', callerRole: 'developer', correlationId: '<from-request>', depth: 2 }` (given request.depth = 1).
- **`context_store` default injection:** Call with `{ scope: 'conversation', key: 'k', value: 'v' }` (no correlationId). Verify `callTool` receives `correlationId` from the request. Then call with explicit `correlationId: 'override'` — verify the override wins.
- **`context_query` passthrough:** Verify all mode variants (`keys`, `search`, `get-all`) forward correctly with auto-injected correlationId.
- **`context_summarize` correlationId default:** Call with no `correlationId`. Verify the request's correlationId is used.
- **`context_stats` no injection:** Verify args passed through unchanged.
- **Error handling:** Mock `callTool` to throw. Verify the handler returns `{ content: [{ type: 'text', text: '...' }], isError: true }` instead of propagating the exception.
- **Result passthrough:** Mock `callTool` to return `{ content: [{ type: 'text', text: 'ok' }] }`. Verify the bridge returns it unchanged.
- **Bridge shape:** Verify `createBridge()` returns `{ quorum: { type: 'sdk', name: 'quorum', instance: McpServer } }`.

### File Structure

```
apps/agent/src/
  llm/
    claude-code.types.ts             # MODIFIED — mcpServers type → McpSdkServerConfigWithInstance
    index.ts                         # MODIFIED — re-export McpToolBridgeService
  connection/
    mcp-tool-bridge.service.ts       # NEW — bridge service with createBridge()
    mcp-tool-bridge.service.spec.ts  # NEW — unit tests
    connection.module.ts             # MODIFIED — add McpToolBridgeService to providers/exports
    index.ts                         # MODIFIED — re-export McpToolBridgeService
```

## Acceptance Criteria

- [x] `McpToolBridgeService` exists with a `createBridge(request: InvokeRequest)` method
- [x] `createBridge()` returns `Record<string, McpSdkServerConfigWithInstance>` with a `"quorum"` key
- [x] Uses `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk` to create the in-process server
- [x] Five orchestration tools registered: `invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`
- [x] `invoke_agent` tool: agent provides `target`, `action`, `context`, `wait`; handler auto-injects `callerRole`, `correlationId`, `depth + 1` with override semantics
- [x] `context_store`/`context_query`/`context_summarize` tools: handler auto-injects `correlationId` as default (agent override wins)
- [x] `context_stats` tool: no parameter injection, passthrough only
- [x] All tool handlers proxy to `McpClientService.callTool()` and return `CallToolResult`
- [x] Tool handler exceptions caught and returned as `{ isError: true }` results
- [x] `TODO(QRM2-003)` in `claude-code.types.ts` resolved — `mcpServers` type narrowed to `McpSdkServerConfigWithInstance`
- [x] `McpToolBridgeService` wired into `ConnectionModule` (or `LlmModule` with circular dependency resolved)
- [x] Barrel exports updated
- [x] Unit tests cover: parameter augmentation for all 5 tools, override semantics, error handling, result passthrough, bridge shape
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` passes (all existing + new tests)

## Dependencies and References

### Prerequisites
- QRM2-002 — Claude Code SDK Service Layer (`ClaudeCodeService`, `ExecuteParams`, `McpServerConfig` types)
- QRM1-007 — Agent-to-Server Connection (`McpClientService.callTool()`)
- QRM1-005 — MCP Server Bootstrap (server-side tool definitions in `McpService`)

### What This Blocks
- QRM2-005 — InvocationHandler Migration (needs bridge to inject orchestration tools into CC sessions)

### References
- SDK `createSdkMcpServer()` and `tool()`: `@anthropic-ai/claude-agent-sdk` — `sdk.d.ts:292-298, 2354-2356`
- `SdkMcpToolDefinition` type: `sdk.d.ts:1791-1797`
- Server-side tool schemas: `apps/mcp-server/src/mcp/mcp.service.ts`
- Current auto-augmentation: `apps/agent/src/connection/invocation-handler.service.ts:171-193`
- Tool-mapper (schema stripping reference): `libs/common/src/llm/tool-mapper.ts`
- `ExecuteParams.mcpServers` TODO: `apps/agent/src/llm/claude-code.types.ts:14`

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-02

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/agent/src/connection/mcp-tool-bridge.service.ts` | Created | `McpToolBridgeService` with `createBridge()` method. Five tool definitions using SDK `tool()` helper, each with Zod input schemas (auto-params stripped). Private `proxy()` method wraps `McpClientService.callTool()` with error handling. Static class constants for `ContextScope` and `AgentRole` enum values to avoid repetition |
| `apps/agent/src/connection/mcp-tool-bridge.service.spec.ts` | Created | 15 unit tests covering: bridge shape (quorum key, SDK config, 5 tools), `invoke_agent` augmentation + override, `context_store` default injection + override, `context_query` all 3 modes + override, `context_summarize` default + override, `context_stats` passthrough, error handling (catches thrown → `isError`), result passthrough (success + `isError`), request scoping across bridges |
| `apps/agent/src/connection/connection.module.ts` | Modified | Added `McpToolBridgeService` to `providers` and `exports` |
| `apps/agent/src/connection/index.ts` | Modified | Barrel re-export of `McpToolBridgeService` |
| `apps/agent/src/llm/claude-code.types.ts` | Modified | Resolved `TODO(QRM2-003)`: narrowed `mcpServers` type from `McpServerConfig` to `McpSdkServerConfigWithInstance`, updated doc comment |
| `package.json` | Modified | Changed `build` script to `nest build --all` (builds all apps/libs); added per-app `build:agent`, `build:mcp-server`, `build:terminal` scripts |

### Deviations from Ticket Spec

**Service placed in `ConnectionModule` (not `LlmModule`):** The ticket suggested `apps/agent/src/llm/mcp-tool-bridge.service.ts` as the primary location but recommended `ConnectionModule` as the resolution for the circular dependency. Implementation followed the `ConnectionModule` path — the bridge depends on `McpClientService` (owned by `ConnectionModule`) and adapts MCP connectivity for the LLM layer, making `ConnectionModule` the natural home.

**Augmentation uses `??` instead of spread-order:** The existing `augmentArgs` in `InvocationHandler` uses spread order for default injection (`{ correlationId: request.correlationId, ...args }` — agent args win by overwriting). The bridge uses `args.correlationId ?? request.correlationId` instead. Semantically equivalent: both let the agent override `correlationId` while providing the request's value as default. The `??` form is more explicit about intent.

**`context_stats` behavioral delta from existing `augmentArgs`:** The existing `augmentArgs` applies `correlationId` default injection to all `context_*` tools (via `toolName.startsWith('context_')`), including `context_stats`. The bridge treats `context_stats` as pure passthrough per the ticket spec (no auto-injection). This is intentional — the MCP server's `context_stats` tool has both parameters optional, and auto-injecting `correlationId` would silently filter stats to the current conversation when the agent may want global stats. **QRM2-005 should be aware of this behavioral change** when migrating `InvocationHandler` to use the bridge.

### Post-Review Fixes

- **Replaced hardcoded agent role strings with `AgentRole` enum:** The `context_store` tool's `agentRole` field originally used a hardcoded 6-element string array. Changed to `Object.values(AgentRole)` via a `private static readonly AGENT_ROLE_VALUES` class constant, matching how `invoke_agent` uses `DEPLOYABLE_AGENT_ROLES`. Prevents drift if roles change.
- **Extracted repeated `ContextScope` cast to class constant:** `Object.values(ContextScope) as [string, ...string[]]` appeared in 3 tool methods. Extracted to `private static readonly SCOPE_VALUES` for DRY.

### Verification

```
npm run build   → 4 apps compiled successfully
npm run lint    → clean
npm run test    → 286/286 passed (31 suites)
```