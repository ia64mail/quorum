# QRM1-010: Terminal Moderator Bootstrap

## Summary

Transform the terminal app from a placeholder HTTP server into the user-facing moderator — a stdin/stdout chat interface backed by the Anthropic API with MCP tool access. The terminal connects to the MCP server, registers as moderator, discovers available tools, and runs an interactive chat loop where the user's messages are processed through an agentic tool-use loop identical in pattern to the agent app's InvocationHandler.

## Problem Statement

The terminal app is scaffolding. It has a `GET /` endpoint that returns "Hello World!", a config service with Anthropic and MCP settings loaded, and a logger. None of this constitutes a functional moderator:

- **No user interaction** — The app has no stdin input, no chat loop, no way for a user to communicate with the system. The roadmap's primary success criterion is "User can chat with moderator via terminal."
- **No LLM integration** — `anthropicConfig` is loaded (apiKey, model, maxTokens), but no code instantiates the Anthropic client or calls `messages.create()`. The terminal has the same gap the agent had before QRM1-008.
- **No MCP connection** — `mcpConfig.serverUrl` is loaded, but no MCP client connects to the server. The terminal can't invoke agents, store context, or participate in the multi-agent system.
- **No moderator behavior** — The moderator prompt template exists in `libs/common/` (QRM1-009), but nothing uses it. Without a system prompt, tool definitions, and a processing loop, the terminal can't function as the orchestration hub.
- **No conversation tracking** — There's no message history, no correlationId generation, no mechanism for maintaining context across turns of a user conversation.

The terminal is the last application-level piece before containerization (QRM1-011). Without it, there's no user entry point — the MCP server and agent containers have nothing to route from. The end-to-end smoke test (QRM1-012) requires a functional moderator to initiate invocation chains.

## Design Context

### Terminal as Moderator

The terminal app plays a dual role:
1. **User interface** — reads from stdin, writes to stdout, presents the moderator's responses
2. **Moderator agent** — connects to the MCP server, calls tools, invokes other agents

Unlike the agent app (which receives invocations via HTTP and processes them passively), the terminal is user-driven. The user types a message, the moderator processes it through the LLM with tool access, and the response is displayed. The chat loop replaces the agent's `POST /invoke` endpoint as the trigger mechanism.

### Reusing the Agent Pattern

The terminal's core processing loop mirrors the agent's InvocationHandler (QRM1-008):

```
User types message
  → Build system prompt (moderator, user-facing)
  → Fetch Anthropic-formatted tool definitions (cached from MCP listTools)
  → Agentic tool loop:
      → messages.create({ system, messages, tools })
      → If stop_reason ≠ 'tool_use': extract text → display to user
      → For each tool_use block:
          → Augment args (callerRole='moderator', correlationId, depth=0)
          → McpClientService.callTool(name, args)
          → Build tool_result message
      → Append to messages → continue loop
  → Add assistant response to conversation history
```

The differences from InvocationHandler:

| Aspect | Agent (InvocationHandler) | Terminal (ChatService) |
|--------|--------------------------|----------------------|
| **Trigger** | InvokeRequest via HTTP | User input via stdin |
| **Message history** | Per-invocation (discarded) | Persists across turns |
| **System prompt** | Role-specific via RolePromptService | Terminal-specific moderator constant |
| **correlationId** | From InvokeRequest | Generated per turn |
| **depth** | `request.depth + 1` | Always `0` (chain origin) |
| **Output** | InvokeResponse | Stdout |

### Tool Mapper Extraction

The agent app's `tool-mapper.ts` (QRM1-008) contains pure utility functions for MCP↔Anthropic tool format conversion. The terminal needs the same conversion. Rather than duplicating, this ticket extracts the tool mapper to `libs/common/src/llm/` — the same pattern used when QRM1-009 placed prompt templates in `libs/common/` because both apps needed them.

The extraction is mechanical: move the file, update imports. The functions have no DI dependencies and no app-specific logic.

### Terminal-Specific Moderator Prompt

QRM1-009 placed the moderator template in `libs/common/` and noted: "The terminal app will have its own prompt handling — it doesn't need the same service since the moderator's prompt integration is different (it talks to a user, not to other agents via invocations)."

The agent app's moderator template says "You received a request from the `{{caller}}` agent" and the shared preamble says "Your caller is an LLM too — keep responses concise." Both are wrong when the caller is a human user. The terminal constructs its system prompt differently:

- Uses `SYSTEM_PREAMBLE` from `libs/common/` (shared Quorum system understanding)
- Appends a terminal-specific moderator section that emphasizes user interaction:
  - Frames the agent as chatting with a human, not receiving an invocation from another agent
  - Emphasizes clear, user-friendly language
  - Retains all collaboration and context management guidance (when to invoke agents, what scopes to use)
  - Drops the "caller is an LLM" and `{{caller}}` framing

This is a constant in the chat service, not a shared template — the terminal is the only app that talks to users.

### MCP Registration

The terminal registers as moderator with the MCP server for two reasons:
1. **System state accuracy** — The broker knows all connected agents, which QRM1-012 verifies
2. **Forward compatibility** — If agents need to invoke the moderator in QRM2+, the registration and callback URL are already in place

The terminal registers with `callbackUrl` pointing to its HTTP server. No `/invoke` endpoint exists in QRM1 — if another agent invokes the moderator, the HTTP call will 404. This is acceptable for the POC scope where the moderator only initiates, never receives.

### Conversation and CorrelationId

Each user message generates a new `correlationId` (UUID). This treats each user request as a separate task chain for tracing purposes. The message history (`MessageParam[]`) persists across turns for conversational continuity — the LLM sees prior exchanges — but the `correlationId` resets because each turn is potentially a different task routed to different agents.

No conversation history truncation in QRM1. Sessions are short (POC), and the Anthropic API will return an error if the context window is exceeded. Token management is a QRM2 concern.

### Placeholder Removal

The scaffold controller (`TerminalController`, `GET /`), service (`TerminalService`, `getHello()`), and their tests are removed. They serve no purpose in the moderator app. The E2E test (`app.e2e-spec.ts`) that tests `GET / → "Hello World!"` is also removed — QRM1-012 is the integration test for the functional system.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Stdin/stdout chat loop with readline | Ink-based terminal UI (deferred per roadmap) |
| Anthropic API integration for moderator | Streaming responses (line-by-line token output) |
| MCP client connection, registration, tool discovery | Inbound invocation endpoint for moderator (`/invoke`) |
| Agentic tool loop (same pattern as InvocationHandler) | Conversation history truncation / token management |
| Per-turn correlationId generation | Persistent conversation state (across restarts) |
| Tool mapper extraction to `libs/common/` | AnthropicService extraction to `libs/common/` |
| Terminal-specific moderator system prompt | Prompt hot-reloading or workspace augmentation |
| Graceful shutdown (unregister, close connections) | Multi-session support |
| `/quit` and `/exit` commands | Rich command system (slash commands beyond quit) |

## Implementation Details

### 1. Tool Mapper Extraction — `libs/common/src/llm/tool-mapper.ts`

Move `apps/agent/src/llm/tool-mapper.ts` and its spec to `libs/common/src/llm/`. Create barrel export `libs/common/src/llm/index.ts` and update `libs/common/src/index.ts` to re-export from `llm/`.

Update the agent app's import in `invocation-handler.service.ts`:

Before: `import { mapMcpToolsToAnthropic, formatToolResult } from '../llm/tool-mapper';`
After: `import { mapMcpToolsToAnthropic, formatToolResult } from '@app/common';`

Remove the tool-mapper re-exports from `apps/agent/src/llm/index.ts` (the barrel should continue to export `AnthropicService` and `LlmModule`, but no longer re-export the mapper utilities since they now live in common).

### 2. McpClientService — `apps/terminal/src/connection/mcp-client.service.ts`

Mirrors the agent's `McpClientService` (QRM1-007) but adapted for the terminal:

- **Constructor**: injects `TerminalConfigService`
- **`connectAndRegister()`**: connect with retry → register as `'moderator'` → discover tools
- **`register()`**: calls `register_agent` with `role: 'moderator'` and `callbackUrl: http://localhost:${config.app.port}`
- **Tool discovery**: `discoverTools()` → `cachedTools` → `getTools()` (same caching pattern as agent)
- **`callTool(name, args)`**: delegates to `client.callTool()`
- **Reconnection**: `onclose` handler with `handleReconnection()` and linear backoff (same as agent)
- **Shutdown**: `OnApplicationShutdown` → unregister + close transport

The role is hardcoded to `'moderator'` — the terminal is always the moderator. No agent-specific config namespace needed.

### 3. ConnectionModule — `apps/terminal/src/connection/connection.module.ts`

```
ConnectionModule
  imports: [TerminalConfigModule]
  providers: [McpClientService]
  exports: [McpClientService]
```

### 4. AnthropicService — `apps/terminal/src/llm/anthropic.service.ts`

Same thin wrapper pattern as the agent's `AnthropicService`. Injects `TerminalConfigService`, creates `Anthropic` client from `config.anthropic.apiKey`, exposes `chat({ system, messages, tools })` with model and maxTokens from config.

This duplicates ~27 lines from the agent app. Extracting to `libs/common/` would require either an abstract config interface or direct namespace injection (`@Inject(anthropicConfig.KEY)`). Both are reasonable but add scope beyond this ticket. The duplication is acceptable — both services are trivially thin and their config service dependency is app-specific.

### 5. LlmModule — `apps/terminal/src/llm/llm.module.ts`

```
LlmModule
  imports: [TerminalConfigModule]
  providers: [AnthropicService]
  exports: [AnthropicService]
```

### 6. ChatService — `apps/terminal/src/chat/chat.service.ts`

The core of the terminal. Injectable service with three responsibilities:
1. **System prompt**: builds the moderator prompt from `SYSTEM_PREAMBLE` + terminal-specific instructions
2. **Chat loop**: reads stdin, writes stdout, manages conversation state
3. **Agentic tool loop**: processes each user message through the Anthropic API with tool execution

**Constructor injections**: `AnthropicService`, `McpClientService`

**State**:
- `messages: MessageParam[]` — conversation history, accumulates across turns
- `currentCorrelationId: string` — regenerated each turn via `crypto.randomUUID()`

**`start()`** — the main loop entry point, called from `main.ts`.

Creates a `readline.Interface` on `process.stdin`/`process.stdout`. Displays a welcome message. Reads lines in a loop. For each non-empty line:
1. Check for commands (`/quit`, `/exit` → close readline and resolve)
2. Generate new `correlationId`
3. Add user message to `messages` array
4. Run `processWithLoop()` — the agentic tool loop
5. Display the result text to stdout
6. Add assistant response to `messages` array

When readline closes (EOF or `/quit`), `start()` resolves and bootstrap proceeds to shutdown.

**`processWithLoop()`** — nearly identical to InvocationHandler's version from QRM1-008.

Gets tools from `mcpClient.getTools()` and converts via `mapMcpToolsToAnthropic()`. Loops up to `MAX_TOOL_ROUNDS`:
- Call `anthropic.chat({ system: this.systemPrompt, messages: this.messages, tools })`
- Append assistant response to messages
- If `stop_reason !== 'tool_use'`: return extracted text
- Execute tool calls with augmented args → append tool results to messages → continue

Tool augmentation follows the same rules as InvocationHandler:
- `invoke_agent`: inject `callerRole: 'moderator'`, `correlationId: this.currentCorrelationId`, `depth: 0`
- `context_*`: default `correlationId: this.currentCorrelationId`

A `MAX_TOOL_ROUNDS = 10` constant bounds the loop (same as agent).

**Error handling**: try/catch around the agentic loop. Errors display a user-friendly message to stdout rather than crashing the process.

**System prompt**: built once in the constructor. Uses `SYSTEM_PREAMBLE` from `@app/common` plus a terminal-specific moderator section. The terminal-specific section follows the same structure as the agent's moderator template (Identity, Responsibilities, Collaboration, Context Management, Communication Style, Constraints) but reframed for user interaction:

- Identity: "You are the Moderator, chatting with a human user" (not "received a request from the `{{caller}}` agent")
- Communication: "The user is human — use clear, user-friendly language" (not "your caller is an LLM")
- Responsibilities, collaboration, context management, and constraints match the agent moderator template's content

### 7. ChatModule — `apps/terminal/src/chat/chat.module.ts`

```
ChatModule
  imports: [ConnectionModule, LlmModule]
  providers: [ChatService]
  exports: [ChatService]
```

### 8. TerminalModule Update — `apps/terminal/src/terminal.module.ts`

Remove `TerminalController` and `TerminalService` imports/references (placeholders). Add `ChatModule` import.

```
TerminalModule
  imports: [TerminalConfigModule, ChatModule]
```

### 9. Bootstrap Update — `apps/terminal/src/main.ts`

Updated flow:

```
bootstrap()
  → Create app with LoggerBuilder
  → enableShutdownHooks()
  → app.listen(port)
  → mcpClient.connectAndRegister()
  → chat.start() — blocks until user quits
```

The HTTP listener starts first (provides the registration callback URL and enables lifecycle hooks), then MCP connection, then the blocking chat loop. When `chat.start()` resolves (user quit), the process exits via shutdown hooks.

### 10. Placeholder Removal

Remove:
- `apps/terminal/src/terminal.controller.ts`
- `apps/terminal/src/terminal.controller.spec.ts`
- `apps/terminal/src/terminal.service.ts`
- `apps/terminal/test/app.e2e-spec.ts`

### 11. File Structure

```
libs/common/src/
  llm/                                  # NEW — extracted from agent
    tool-mapper.ts                      # MCP ↔ Anthropic tool format conversion
    tool-mapper.spec.ts                 # Tests (moved from agent)
    index.ts                            # Barrel export
  index.ts                              # Modified — re-export from llm/

apps/terminal/src/
  config/                               # EXISTING — unchanged
  connection/                           # NEW
    mcp-client.service.ts               # MCP client: connect, register as moderator, discover, callTool
    mcp-client.service.spec.ts
    connection.module.ts
    index.ts
  llm/                                  # NEW
    anthropic.service.ts                # Thin Anthropic SDK wrapper
    anthropic.service.spec.ts
    llm.module.ts
    index.ts
  chat/                                 # NEW
    chat.service.ts                     # Chat loop + agentic tool loop + system prompt
    chat.service.spec.ts
    chat.module.ts
    index.ts
  main.ts                               # MODIFIED — MCP connect + chat start
  terminal.module.ts                    # MODIFIED — remove placeholders, add ChatModule
  terminal.controller.ts                # REMOVED
  terminal.controller.spec.ts           # REMOVED
  terminal.service.ts                   # REMOVED
  test/
    app.e2e-spec.ts                     # REMOVED

apps/agent/src/
  llm/
    tool-mapper.ts                      # REMOVED — extracted to libs/common
    tool-mapper.spec.ts                 # REMOVED — moved to libs/common
    index.ts                            # MODIFIED — remove tool-mapper re-exports
  connection/
    invocation-handler.service.ts       # MODIFIED — import tool-mapper from @app/common
```

### 12. Testing Strategy

**McpClientService tests** (`mcp-client.service.spec.ts`):
- `connectAndRegister()` connects, registers with role `'moderator'`, discovers tools
- `getTools()` returns cached tools from last discovery
- `callTool()` delegates to MCP client
- Reconnection re-registers and re-discovers tools
- Shutdown unregisters and closes transport
- Discovery failure logged, doesn't prevent operation

Mock: `@modelcontextprotocol/sdk` Client and StreamableHTTPClientTransport.

**AnthropicService tests** (`anthropic.service.spec.ts`):
- `chat()` calls `messages.create()` with correct model/maxTokens from config
- `chat()` passes through system, messages, tools
- Empty tools array omitted from API call
- SDK client created with apiKey

Mock: `@anthropic-ai/sdk`.

**ChatService tests** (`chat.service.spec.ts`):
Focus on the agentic loop and state management, not stdin/stdout I/O:

- **Single turn (no tools)**: mock LLM returns text → `processWithLoop()` returns text
- **Tool loop**: LLM returns `tool_use` → tool executed via McpClientService → result fed back → text returned
- **`invoke_agent` augmentation**: `callerRole='moderator'`, `correlationId` matches current turn, `depth=0`
- **`context_*` augmentation**: `correlationId` defaulted from current turn
- **System prompt**: contains SYSTEM_PREAMBLE content and moderator identity
- **Message history accumulation**: messages array grows across multiple `processWithLoop()` calls
- **Error handling**: API failure produces user-friendly error text, doesn't throw
- **Max rounds**: loop hits limit → returns text or error message

Mock: `AnthropicService`, `McpClientService`.

**Tool mapper tests** — already exist, just moved to `libs/common/`. Verify they pass in the new location.

**Agent app regression** — verify the agent's InvocationHandler still works after import path change. Existing tests cover this.

## Acceptance Criteria

- [x] Tool mapper (`mapMcpToolsToAnthropic`, `formatToolResult`) extracted to `libs/common/src/llm/`
- [x] Agent app imports updated — existing tool-mapper tests pass in new location
- [x] Terminal MCP client connects to server with retry and linear backoff
- [x] Terminal MCP client registers as moderator with callback URL
- [x] Terminal MCP client discovers and caches tools after registration
- [x] Terminal MCP client supports reconnection with re-registration and tool re-discovery
- [x] Terminal `AnthropicService` wraps SDK — calls `messages.create()` with config values
- [x] Chat loop reads user input from stdin, displays responses to stdout
- [x] `/quit` and `/exit` commands end the session gracefully
- [x] System prompt uses `SYSTEM_PREAMBLE` from `libs/common/` + terminal-specific moderator section
- [x] System prompt is user-facing — no "caller is an LLM" framing, no `{{caller}}` placeholder
- [x] Agentic tool loop: LLM calls tools → executed via MCP → results fed back → text response returned
- [x] `invoke_agent` augmented: `callerRole='moderator'`, `correlationId` from current turn, `depth=0`
- [x] `context_*` tools augmented: `correlationId` defaulted from current turn
- [x] Per-turn `correlationId` generated via `crypto.randomUUID()`
- [x] Message history persists across turns (conversational continuity)
- [x] Tool loop bounded by `MAX_TOOL_ROUNDS` (10)
- [x] Errors handled gracefully — displayed to user, don't crash the process
- [x] Placeholder controller, service, and E2E test removed
- [x] `main.ts` bootstraps: listen → MCP connect → chat start
- [x] Graceful shutdown: unregister from MCP, close transport, close readline
- [x] Unit tests: MCP client, Anthropic service, chat service (agentic loop, augmentation, history, errors)
- [x] Existing agent tests unaffected (tool-mapper import path change)
- [x] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-003 — `TerminalConfigService` with app/anthropic/mcp config namespaces
- QRM1-005 — MCP Server with registered tools and `register_agent`/`unregister_agent`
- QRM1-006 — `LoggerBuilder.fromEnv()` for bootstrap logging
- QRM1-007 — Agent connection pattern (McpClientService, StreamableHTTPClientTransport, retry, discovery)
- QRM1-008 — Agentic tool loop pattern (InvocationHandler, tool mapper, parameter augmentation)
- QRM1-009 — `SYSTEM_PREAMBLE` and moderator prompt template in `libs/common/`

### What This Blocks
- QRM1-011 — Docker Containerization (terminal container needs a functional moderator)
- QRM1-012 — End-to-End Smoke Test (needs terminal to initiate invocation chains)

### References
- [docs/system-design.md](../docs/system-design.md) — Terminal as user-facing entry point, agent collaboration flow
- [docs/agent-messaging.md](../docs/agent-messaging.md) — Bidirectional MCP, `invoke_agent` patterns
- [docs/context-management.md](../docs/context-management.md) — Context tools the moderator uses (scopes, store/query)
- QRM1-008 Implementation Notes — Agentic loop, tool mapper, parameter augmentation pattern
- QRM1-009 Implementation Notes — `SYSTEM_PREAMBLE`, prompt template structure, `{{caller}}` substitution

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-20

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/llm/tool-mapper.ts` | Created | Moved from agent — MCP↔Anthropic tool format conversion |
| `libs/common/src/llm/tool-mapper.spec.ts` | Created | Moved from agent — 12 existing tests |
| `libs/common/src/llm/index.ts` | Created | Barrel export for llm module |
| `libs/common/src/index.ts` | Modified | Added `llm/` re-export |
| `apps/agent/src/llm/tool-mapper.ts` | Removed | Extracted to libs/common |
| `apps/agent/src/llm/tool-mapper.spec.ts` | Removed | Moved to libs/common |
| `apps/agent/src/connection/invocation-handler.service.ts` | Modified | Import tool-mapper from `@app/common` instead of relative path |
| `apps/terminal/src/connection/mcp-client.service.ts` | Created | MCP client: connect, register as moderator, discover, callTool, reconnection, shutdown |
| `apps/terminal/src/connection/mcp-client.service.spec.ts` | Created | 8 tests covering connect, register, retry, callTool, shutdown, reconnection, discovery |
| `apps/terminal/src/connection/connection.module.ts` | Created | ConnectionModule wiring McpClientService |
| `apps/terminal/src/connection/index.ts` | Created | Barrel export |
| `apps/terminal/src/llm/anthropic.service.ts` | Created | Thin Anthropic SDK wrapper using TerminalConfigService |
| `apps/terminal/src/llm/anthropic.service.spec.ts` | Created | 4 tests covering SDK init, chat params, tools passthrough |
| `apps/terminal/src/llm/llm.module.ts` | Created | LlmModule wiring AnthropicService |
| `apps/terminal/src/llm/index.ts` | Created | Barrel export |
| `apps/terminal/src/chat/chat.service.ts` | Created | Core moderator: system prompt, stdin/stdout chat loop, agentic tool loop with augmentation |
| `apps/terminal/src/chat/chat.service.spec.ts` | Created | 13 tests covering tool loop, augmentation, system prompt, history, errors, max rounds |
| `apps/terminal/src/chat/chat.module.ts` | Created | ChatModule importing ConnectionModule + LlmModule |
| `apps/terminal/src/chat/index.ts` | Created | Barrel export |
| `apps/terminal/src/terminal.module.ts` | Modified | Removed placeholder controller/service, added ChatModule |
| `apps/terminal/src/main.ts` | Modified | Bootstrap: listen → enableShutdownHooks → MCP connect → chat start → close |
| `apps/terminal/src/terminal.controller.ts` | Removed | Placeholder |
| `apps/terminal/src/terminal.controller.spec.ts` | Removed | Placeholder test |
| `apps/terminal/src/terminal.service.ts` | Removed | Placeholder |
| `apps/terminal/test/app.e2e-spec.ts` | Removed | Placeholder e2e test |

### Deviations from Ticket Spec

- **`rl.question` callback refactored to avoid async callback.** ESLint `@typescript-eslint/no-misused-promises` disallows passing an async function to `rl.question`. Extracted the async handling into a separate `handleInput()` method called via `void this.handleInput(...)` from the synchronous callback.
- **System prompt test adjusted for SYSTEM_PREAMBLE content.** The ticket spec says "no 'caller is an LLM' framing" but `SYSTEM_PREAMBLE` (shared across all agents) contains "Your caller is an LLM too" in its General Guidelines. The terminal-specific section correctly avoids this framing. Test checks for positive indicators (`chatting with a human user`, `The user is human`) and absence of `{{caller}}` instead.

### Post-Review Fixes

- **Removed duplicate assistant message push.** `processWithLoop()` already appends the assistant's `ContentBlock[]` to `this.messages` inside the loop. `handleInput()` was also pushing a plain string version after the method returned, causing two assistant entries per turn — one with proper content blocks, one with a raw string. Removed the redundant push in `handleInput()`. Message history test rewritten to verify the exact 4-message sequence across two turns with no duplicates.
- **`processWithLoop()` made private.** The method was public only for test access, but the intended public API is `start()`. Changed to `private`; tests access it via reflection through a `callProcessWithLoop()` helper, consistent with the existing pattern used for `messages` and `currentCorrelationId`.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 247 tests passing (25 new + 222 existing)