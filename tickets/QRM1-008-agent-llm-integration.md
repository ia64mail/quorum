# QRM1-008: Agent LLM Integration — Anthropic SDK, Agentic Tool Loop & Invocation Processing

## Summary

Replace the `InvocationHandler` stub (QRM1-007) with a complete agentic processing loop. When an agent receives an invocation, it builds a message array from the request, calls the Anthropic `messages.create()` API with MCP tool definitions discovered from the server, executes any tool calls via `McpClientService`, and loops until a final text response — which becomes the `InvokeResponse.result`. This is the core intelligence layer that makes agents functional participants rather than echo endpoints.

## Problem Statement

The agent infrastructure from QRM1-007 is fully wired — agents connect, register, and receive invocations — but `InvocationHandler.handle()` is a stub that returns `[{role}] Acknowledged: "{action}"` without any processing:

- **No LLM integration** — `@anthropic-ai/sdk` is installed (QRM1-001) and `anthropicConfig` exists (QRM1-003), but no code instantiates the `Anthropic` client or calls `messages.create()`.
- **No tool execution** — `McpClientService.callTool()` is exposed (QRM1-007) but nothing uses it. Agents can't invoke other agents, store context, or query information mid-task.
- **No tool discovery** — the MCP server registers 7 tools, but agents don't know what's available. No `listTools()` call, no schema conversion to Anthropic's tool format.
- **No message construction** — `InvokeRequest.action` and `context` aren't transformed into a messages array. There's no system prompt, no user message formatting, no conversation management.
- **No error boundary** — API failures (rate limits, auth errors, model overload) would crash the handler rather than producing a graceful `{ success: false, error: '...' }` response.

Without LLM integration, the multi-agent system is plumbing without intelligence. The broker routes invocations, HTTP delivers them, but no agent actually *thinks*. This is the critical gap between infrastructure (QRM1-001–007) and functional agents (QRM1-009+).

## Design Context

### Agentic Tool Loop

The standard Anthropic tool-use pattern: send messages with tool definitions → receive response → if `stop_reason === 'tool_use'`, execute tools and feed results back → repeat until the model produces a final text response (`stop_reason === 'end_turn'`).

In Quorum's case, the tools are MCP tools exposed by the server. The loop bridges two protocols: the agent speaks Anthropic Messages API to the LLM, and MCP tool protocol to the server. The handler translates between them.

```
InvokeRequest arrives
  → Build system prompt (placeholder) + user message (from request)
  → Fetch Anthropic-formatted tool definitions (cached from MCP listTools)
  → Loop:
      → messages.create({ system, messages, tools })
      → If stop_reason ≠ 'tool_use': extract text → return InvokeResponse
      → For each tool_use block:
          → Augment args (callerRole, correlationId, depth)
          → McpClientService.callTool(name, args)
          → Build tool_result message
      → Append assistant + tool_result messages → continue loop
```

The maximum loop iterations are bounded by a code constant (`MAX_TOOL_ROUNDS = 10`). This prevents runaway loops if the LLM keeps requesting tool calls without converging on a text response. This is a code constant, not config — loop behaviour doesn't vary between deployment environments in the POC.

### Dynamic Tool Discovery

Rather than hardcoding MCP tool schemas in the agent, we use the MCP protocol's `listTools()` to discover available tools after connecting. This:

1. **Eliminates duplication** — tool schemas are defined once in `McpService.onModuleInit()`, not copied to the agent.
2. **Adapts automatically** — if the server adds or removes tools, agents pick them up on next connection.
3. **Uses the protocol as designed** — MCP's tool discovery is exactly this use case.

The tool list is fetched once during `connectAndRegister()` and cached in `McpClientService`. Tools don't change at runtime (they're registered in `onModuleInit`), so the cache is always fresh. Reconnection re-fetches to handle server restarts that might change the tool set.

The cached MCP tool definitions are converted to Anthropic's tool format by a pure mapper function. The conversion is structurally trivial (`inputSchema` → `input_schema`), but the mapper also:

- **Filters infrastructure tools** — `register_agent` and `unregister_agent` are agent-lifecycle tools, not callable by the LLM during task processing.
- **Strips auto-injected parameters from `invoke_agent`** — `callerRole`, `correlationId`, and `depth` are removed from the schema exposed to the LLM because the handler injects them automatically at execution time.

### Parameter Augmentation

When the LLM calls `invoke_agent`, certain parameters must be set by the agent, not the LLM:

| Parameter | Source | Reason |
|-----------|--------|--------|
| `callerRole` | `config.agent.role` | Agent identity is a system property, not an LLM choice |
| `correlationId` | `request.correlationId` | Preserves the call chain for safeguards and tracing |
| `depth` | `request.depth + 1` | Increments per hop for the broker's depth limit |

Similarly, for `context_*` tools, `correlationId` defaults to the current request's correlation ID if the LLM doesn't provide one. This ensures context operations stay within the correct conversation scope without requiring the LLM to track correlation IDs.

This augmentation happens at tool execution time in the handler, not in the schema mapper. The mapper is a pure structural conversion; the handler adds runtime context.

### System Prompt Placeholder

QRM1-009 introduces role-specific prompts that define each agent's identity, responsibilities, communication style, and constraints. For QRM1-008, a minimal placeholder prompt establishes the pattern without premature role specialization:

```
You are a {role} agent in the Quorum multi-agent system.
You received a task from the {caller} agent. Process it and respond with your result.
Use the available tools when needed to complete the task.
```

The placeholder is a code constant in the handler. QRM1-009 replaces it with injectable, role-specific prompts loaded from configuration.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `AnthropicService` wrapping `@anthropic-ai/sdk` | Role-specific system prompts (QRM1-009) |
| MCP tool discovery (`listTools()`) and caching | Streaming responses (moderator concern, QRM1-010) |
| MCP → Anthropic tool schema conversion + filtering | Context bootstrapping in broker (TODO in `MessageBroker`) |
| Agentic loop with tool execution | Conversation history persistence across invocations |
| `anthropicConfig.maxTokens` env var | Token counting / budget management |
| Parameter augmentation for `invoke_agent` and `context_*` | Agent-to-agent callback URL discovery |
| Error handling: API failures, max rounds, tool errors | Retry on rate-limit (deferred to Anthropic SDK built-in retry) |

## Implementation Details

### 1. Anthropic Config Update — `libs/common/src/config/anthropic.config.ts`

Add `maxTokens` to the Zod schema. Source: `ANTHROPIC_MAX_TOKENS` env var, default `4096`. This is the `max_tokens` parameter for `messages.create()` — the upper bound on response length per API call. 4096 tokens is sufficient for detailed agent responses in the POC while keeping costs predictable.

Parse with `parseInt()` before Zod validation (same pattern as `app.config.ts` uses for `PORT`):

```typescript
maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096', 10),
```

This also means updating `anthropic.config.spec.ts` for the new field and any consumers that reference the config type (currently: `AgentConfigService`, `McpServerConfigService`, `TerminalConfigService`).

### 2. AnthropicService — `apps/agent/src/llm/anthropic.service.ts`

Injectable service wrapping the `@anthropic-ai/sdk` client. Centralizes SDK instantiation, auto-applies `model` and `maxTokens` from config, and provides a single `chat()` method.

Constructor injects `AgentConfigService`, creates `new Anthropic({ apiKey: config.anthropic.apiKey })`.

**`chat(params)` method**: accepts `system` (string), `messages` (Anthropic `MessageParam[]`), and optional `tools` (Anthropic `Tool[]`). Calls `this.client.messages.create()` with model and maxTokens from config. Returns the raw `Message` response — the handler interprets `stop_reason` and content blocks.

The service is deliberately thin. It doesn't manage conversation state, retry on errors, or interpret responses. It's a configured client accessor — the intelligence lives in the handler. This keeps the service testable (mock the SDK client) and the handler testable (mock the service).

### 3. MCP Tool Discovery — `apps/agent/src/connection/mcp-client.service.ts`

Add tool caching to `McpClientService`:

**New state**: `private cachedTools: Tool[]` (MCP SDK `Tool` type).

**`discoverTools()` private method**: calls `this.client.listTools()`, stores `result.tools` in `cachedTools`, logs the count. Called from `connectAndRegister()` after registration and from `handleReconnection()` after re-registration.

**`getTools()` public method**: returns `cachedTools`. Synchronous getter — tools are pre-fetched during connection setup, so no async needed at invocation time.

Updated `connectAndRegister()` flow: `connectWithRetry()` → `register()` → `discoverTools()`.

If `discoverTools()` fails (network issue, server error), log a warning but don't prevent the agent from operating. The agent proceeds with an empty tool list — it can still respond to invocations, just without tool use. A subsequent reconnection will retry discovery.

### 4. Tool Mapper — `apps/agent/src/llm/tool-mapper.ts`

Pure utility functions (not a service, no DI) for converting between MCP and Anthropic tool formats.

**`mapMcpToolsToAnthropic(mcpTools, exclude?)`**: takes the MCP `Tool[]` from `getTools()`, filters out excluded tool names (default: `['register_agent', 'unregister_agent']`), and converts each to Anthropic's tool format. The conversion renames `inputSchema` → `input_schema` and ensures `description` defaults to empty string if absent.

For `invoke_agent`, the mapper also strips `callerRole`, `correlationId`, and `depth` from the schema's `properties` and `required` arrays. These parameters are auto-injected by the handler — the LLM should only decide `target`, `action`, `context`, and `wait`.

**`formatToolResult(mcpResult)`**: extracts text content from an MCP `CallToolResult`, joining all `text`-type content blocks with newlines. Returns an object with `text` (string) and `isError` (boolean) for constructing the Anthropic `tool_result` message.

### 5. InvocationHandler Rewrite — `apps/agent/src/connection/invocation-handler.service.ts`

Replace the stub body with the full agentic loop. New constructor injections: `AnthropicService`, `McpClientService` (in addition to existing `AgentConfigService`).

**`handle(request)`** — the main processing method:

1. **Log invocation** with correlationId, caller, action, depth (preserved from stub).
2. **Get tool definitions**: call `mcpClient.getTools()`, pass through `mapMcpToolsToAnthropic()` with infrastructure tools excluded.
3. **Build system prompt**: placeholder template with role and caller substitution.
4. **Build initial user message**: format `request.action` as the task. Include `request.context` as JSON-formatted additional context if present.
5. **Agentic loop** (up to `MAX_TOOL_ROUNDS` iterations):
   - Call `anthropic.chat({ system, messages, tools })`.
   - Append the assistant response to the messages array.
   - If `stop_reason !== 'tool_use'`: extract text from content blocks → return `{ success: true, result: text }`.
   - Extract `tool_use` blocks from the response content. For each block, augment the args (inject `callerRole`, `correlationId`, `depth` for `invoke_agent`; default `correlationId` for `context_*`). Call `mcpClient.callTool(name, augmentedArgs)`. Build `tool_result` entries using `formatToolResult()`.
   - Append tool results as a user message. Continue loop.
6. **Max rounds exceeded**: extract any text accumulated in the last assistant message. Return it with a note about the loop limit, or return a descriptive error if no text was generated.

**Error boundary**: the entire `handle()` body is wrapped in try/catch. Any error — API failure, unexpected SDK behaviour — produces `{ success: false, error: 'LLM processing failed: {message}' }`. The handler never throws; this maintains the contract that `InvokeResponse` always resolves.

**Tool execution**: tool calls within a single LLM response are executed in parallel (`Promise.all`). They're conceptually independent — the LLM decided to call all of them before seeing any results. Individual tool failures don't abort the loop; they produce `is_error: true` tool results that the LLM can interpret and recover from.

### 6. LlmModule — `apps/agent/src/llm/llm.module.ts`

```
LlmModule
  imports: [AgentConfigModule]
  providers: [AnthropicService]
  exports: [AnthropicService]
```

Imported by `ConnectionModule` so that `InvocationHandler` can inject `AnthropicService`. `AgentConfigModule` is already global (QRM1-003), so the import is technically redundant but makes the dependency explicit.

### 7. File Structure

```
apps/agent/src/
  llm/
    anthropic.service.ts               # Wraps @anthropic-ai/sdk — config-driven chat()
    anthropic.service.spec.ts          # SDK mock tests: chat params, config propagation
    tool-mapper.ts                     # MCP → Anthropic tool conversion + filtering
    tool-mapper.spec.ts                # Mapping, filtering, parameter stripping tests
    llm.module.ts                      # Module providing AnthropicService
    index.ts                           # Barrel export
  connection/
    invocation-handler.service.ts      # Modified — agentic loop replaces stub
    invocation-handler.service.spec.ts # Rewritten — loop, tool execution, error handling tests
    mcp-client.service.ts              # Modified — discoverTools(), getTools(), cached tools
    mcp-client.service.spec.ts         # Modified — tool discovery and caching tests
    connection.module.ts               # Modified — imports LlmModule

libs/common/src/
  config/
    anthropic.config.ts                # Modified — add maxTokens field
    anthropic.config.spec.ts           # Modified — maxTokens default, override, validation tests
```

### 8. Testing Strategy

**AnthropicService tests** (`anthropic.service.spec.ts`):
- `chat()` calls `client.messages.create()` with correct model and maxTokens from config
- `chat()` passes through system, messages, and tools params
- SDK client created with apiKey from config

Mock `@anthropic-ai/sdk` — mock the constructor and `messages.create()`.

**Tool mapper tests** (`tool-mapper.spec.ts`):
- Converts MCP tool to Anthropic format (`inputSchema` → `input_schema`)
- Filters excluded tools (`register_agent`, `unregister_agent` not in output)
- Strips `callerRole`, `correlationId`, `depth` from `invoke_agent` schema
- Preserves all other tools unchanged
- Handles empty tool list
- `formatToolResult` extracts text content from MCP result
- `formatToolResult` preserves `isError` flag

**InvocationHandler tests** (`invocation-handler.service.spec.ts`) — rewritten:
- **Single turn (no tools)**: LLM returns text → handler returns success with text
- **Tool loop**: LLM returns `tool_use` → handler calls `McpClientService.callTool()` → feeds result back → LLM returns text
- **Multiple tool calls**: LLM returns 2+ `tool_use` blocks → all executed in parallel
- **`invoke_agent` augmentation**: `callerRole`, `correlationId`, `depth` injected correctly
- **`context_*` augmentation**: `correlationId` defaulted from request
- **Max rounds**: loop hits limit → returns accumulated text or error
- **API error**: `AnthropicService.chat()` throws → handler returns `{ success: false }`
- **Tool error**: `callTool()` throws → `tool_result` has `is_error: true`, loop continues
- **Empty context**: request without `context` field → user message omits context section
- **Empty tool list**: `getTools()` returns `[]` → chat called without tools, loop still works

Mocks: `AnthropicService`, `McpClientService` (with `getTools()` and `callTool()`), `AgentConfigService`.

**McpClientService tests** (additions to existing spec):
- `discoverTools()` called after register in `connectAndRegister()`
- `getTools()` returns cached tools from last discovery
- Reconnection re-discovers tools
- `discoverTools()` failure logged, doesn't prevent agent from operating

**Anthropic config tests** (additions to existing spec):
- `ANTHROPIC_MAX_TOKENS` parsed as integer
- Default maxTokens is 4096 when env var absent
- Invalid maxTokens (non-numeric, zero, negative) rejected by Zod

## Acceptance Criteria

- [x] `AnthropicService` wraps `@anthropic-ai/sdk` — creates client from `anthropicConfig.apiKey`
- [x] `AnthropicService.chat()` calls `messages.create()` with model and maxTokens from config
- [x] `anthropicConfig` updated with `maxTokens` from `ANTHROPIC_MAX_TOKENS` (default: 4096)
- [x] `McpClientService.discoverTools()` fetches tool list after registration
- [x] `McpClientService.getTools()` returns cached MCP tool definitions
- [x] Tool cache refreshed on reconnection
- [x] `discoverTools()` failure does not prevent agent operation
- [x] `mapMcpToolsToAnthropic()` converts MCP tools to Anthropic format (`inputSchema` → `input_schema`)
- [x] Infrastructure tools (`register_agent`, `unregister_agent`) filtered from LLM-facing tool list
- [x] `invoke_agent` schema stripped of `callerRole`, `correlationId`, `depth` (auto-injected at execution)
- [x] `formatToolResult()` extracts text content and `isError` flag from MCP `CallToolResult`
- [x] `InvocationHandler.handle()` implements agentic loop: build messages → chat → tool execution → loop
- [x] Tool calls executed via `McpClientService.callTool()` with augmented args
- [x] `invoke_agent` calls augmented: `callerRole` from config, `correlationId` from request, `depth` incremented
- [x] `context_*` calls default `correlationId` from request if not provided by LLM
- [x] Multiple tool calls in a single response executed in parallel
- [x] Loop bounded by `MAX_TOOL_ROUNDS` (10) — returns text or error on exhaustion
- [x] `handle()` never throws — API errors, tool errors caught and returned as `{ success: false }`
- [x] Individual tool failures produce `is_error` tool results, don't abort the loop
- [x] Placeholder system prompt includes role and caller (replaced by QRM1-009)
- [x] User message includes `request.action` and formatted `request.context` when present
- [x] Text extracted from final assistant response as `InvokeResponse.result`
- [x] `LlmModule` provides `AnthropicService`, imported by `ConnectionModule`
- [x] All new code uses structured logging with `correlationId` where available
- [x] Unit tests cover: chat delegation, tool mapping, agentic loop, error handling, parameter augmentation
- [x] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-003 — `anthropicConfig` (apiKey, model) in `libs/common`, `AgentConfigService` aggregation
- QRM1-005 — MCP Server with registered tools (`invoke_agent`, `context_*`) discoverable via `listTools()`
- QRM1-007 — `McpClientService` (connected client, `callTool()`), `InvocationHandler` (stub to replace), `ConnectionModule` wiring

### What This Blocks
- QRM1-009 — Role Prompt System (replaces the placeholder system prompt with role-specific prompts)
- QRM1-010 — Terminal Moderator Bootstrap (same agentic loop pattern for the moderator's LLM integration)
- QRM1-012 — End-to-End Smoke Test (needs agents that actually process invocations with LLM reasoning)

### References
- [docs/agent-messaging.md](../docs/agent-messaging.md) — Dual-role agents, invocation handler concept
- [@anthropic-ai/sdk v0.73.0](https://github.com/anthropics/anthropic-sdk-typescript) — `Anthropic`, `messages.create()`, tool-use response handling
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — `Client.listTools()`, `CallToolResult` types
- [Anthropic Tool Use Guide](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) — Agentic loop pattern, `tool_result` format

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-15

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/config/anthropic.config.ts` | Modified | Added `maxTokens` field — `z.number().int().min(1)`, parsed from `ANTHROPIC_MAX_TOKENS` env var (default 4096) |
| `libs/common/src/config/anthropic.config.spec.ts` | Modified | 5 new tests: maxTokens default, env override, non-numeric rejection, zero rejection, negative rejection |
| `apps/agent/src/llm/anthropic.service.ts` | Created | Thin SDK wrapper — constructor creates `Anthropic` client from config apiKey, `chat()` delegates to `messages.create()` with model/maxTokens. Omits `tools` key when array is empty (Anthropic API rejects `tools: []`) |
| `apps/agent/src/llm/anthropic.service.spec.ts` | Created | 4 tests: SDK instantiation with apiKey, chat params delegation, tools passthrough, empty tools omission |
| `apps/agent/src/llm/tool-mapper.ts` | Created | Pure utility functions (no DI). `mapMcpToolsToAnthropic()` converts MCP→Anthropic format, filters infrastructure tools, strips auto-injected params from `invoke_agent`. `formatToolResult()` extracts text + isError from MCP `CallToolResult` |
| `apps/agent/src/llm/tool-mapper.spec.ts` | Created | 12 tests: conversion, filtering, param stripping, custom exclude list, empty input, missing description, formatToolResult text extraction/isError/empty/non-text/missing content |
| `apps/agent/src/llm/llm.module.ts` | Created | Provides `AnthropicService`, imports `AgentConfigModule` |
| `apps/agent/src/llm/index.ts` | Created | Barrel export for `AnthropicService` and `LlmModule` |
| `apps/agent/src/connection/invocation-handler.service.ts` | Modified | Replaced stub with full agentic loop. Injects `AnthropicService` + `McpClientService`. Implements `processWithLoop()` (up to `MAX_TOOL_ROUNDS=10`), `buildUserMessage()`, `extractText()`, `executeTool()`, `augmentArgs()` |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Rewritten | 15 tests across 6 describe blocks: single turn, tool loop, invoke_agent augmentation, context_* augmentation, max rounds, error handling, empty tools |
| `apps/agent/src/connection/mcp-client.service.ts` | Modified | Added `cachedTools: Tool[]`, `discoverTools()` (called after register + on reconnection), `getTools()` (returns defensive copy). Discovery failure logs warning, proceeds with empty list |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | Modified | 4 new tests in `tool discovery` block + updated existing connect/reconnect tests to include `mockListTools` |
| `apps/agent/src/connection/connection.module.ts` | Modified | Added `LlmModule` import |

### Deviations from Ticket Spec

- **`getTools()` returns a defensive copy.** The ticket describes `getTools()` as a "synchronous getter" returning `cachedTools`. Implementation returns `[...this.cachedTools]` instead of the direct reference. This prevents consumers from accidentally mutating the cache. Currently no consumer mutates the array (the mapper creates new arrays), but the shallow copy is cheap insurance against future bugs.

- **`callTool()` return type cast in handler.** The MCP SDK's `callTool()` returns a loosely-typed result. The handler casts it via `as { content?: Array<{ type: string; text?: string }>; isError?: boolean }` before passing to `formatToolResult()`. This is pragmatic — the MCP SDK guarantees this shape per the `CallToolResult` type, but the runtime return type is `unknown`. An alternative would be to accept `unknown` in `formatToolResult()` and validate internally, but that would add defensive code for a protocol-guaranteed contract.

### Review Notes

- **System prompt uses simple `.replace()`.** The placeholder template substitutes `{role}` and `{caller}` with string `.replace()`, which only replaces the first occurrence. Currently safe because both placeholders appear exactly once. QRM1-009 replaces this entirely with injectable role-specific prompts, so no hardening needed.

- **`AnthropicService.chat()` omits `tools` when empty.** The Anthropic API rejects `tools: []` with a validation error. The service conditionally spreads `{ tools }` only when the array has elements. This is a subtle SDK requirement not documented in the ticket but necessary for correct behavior — tested explicitly.

- **`context_*` augmentation uses spread order for override semantics.** For `invoke_agent`, system values override LLM values (`{...args, callerRole, ...}`). For `context_*`, LLM values override the default (`{correlationId, ...args}`). The asymmetry is intentional and matches the ticket spec — `callerRole`/`depth` are never LLM choices, but `correlationId` on context tools is a default that the LLM can override.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 183 tests passing (41 new/rewritten + 142 existing, 0 regressions)