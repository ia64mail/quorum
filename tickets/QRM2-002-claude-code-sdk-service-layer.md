# QRM2-002: Claude Code SDK Service Layer

## Summary

Install `@anthropic-ai/claude-agent-sdk` and create a NestJS-compatible `ClaudeCodeService` that wraps the SDK's `query()` function. This service becomes the agent's new LLM engine — replacing the raw Anthropic SDK `messages.create()` loop with a fully agentic Claude Code session that manages tool discovery, execution, retry, and context internally. The service is designed to compose with the MCP tool bridge (QRM2-003) and role permission profiles (QRM2-004) before the InvocationHandler migration in QRM2-005.

## Problem Statement

The current agent intelligence layer is a two-piece assembly: `AnthropicService` wraps `@anthropic-ai/sdk`'s `messages.create()` to make a single LLM call, and `InvocationHandler` implements a hand-rolled 10-round tool loop around it — call LLM, extract `tool_use` blocks, execute tools via MCP, append results, repeat. This works, but it has fundamental limitations:

- **No built-in tools.** Agents can only use MCP-exposed tools (`invoke_agent`, `context_store`, etc.). They cannot read files, write code, run bash commands, search codebases, or make web requests. The capabilities that make Claude Code useful for development are entirely absent.
- **Brittle loop logic.** The hand-rolled loop (max 10 rounds, parallel execution, error accumulation, text extraction) duplicates orchestration that the Claude Code SDK handles natively — with better error recovery, context management, token budgeting, and checkpointing.
- **No workspace interaction.** QRM2-001 gave agents a full toolchain (git, bash, ripgrep) and a shared workspace at `/mnt/quorum/workspace`. But there's no mechanism for the LLM to use those tools. Agents are still brains in jars.

The Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`) solves all three. Its `query()` function runs a complete agentic session: system prompt configuration, tool loop with built-in tool execution (Read, Edit, Bash, Grep, Glob, Write, WebSearch, WebFetch), streaming output, session management, and abort control — in a single call. QRM2-002 wraps this in a NestJS service so the rest of the agent can consume it.

## Design Context

### SDK Execution Model

The SDK's `query()` spawns a Claude Code child process. This is fundamentally different from the current in-process `messages.create()` call — it's a managed subprocess with its own tool runtime:

```
NestJS Agent Process                    Claude Code Subprocess
┌──────────────────────┐               ┌──────────────────────┐
│ ClaudeCodeService    │               │ Claude Code Runtime  │
│   query() ──────────────────────────→│   LLM + tool loop    │
│   ← async generator ←───────────────│   Built-in tools     │
│                      │               │   (Read, Edit, Bash, │
│ In-process MCP srv   │←──tool call───│    Grep, Glob, ...)  │
│   (added in QRM2-003)│───result─────→│   Custom MCP tools   │
└──────────────────────┘               └──────────────────────┘
```

The NestJS process hosts `ClaudeCodeService` and any in-process MCP servers (added in QRM2-003 via `createSdkMcpServer()`). The Claude Code subprocess runs the LLM and built-in tools. Custom tools like `invoke_agent` are served back from the NestJS process through the MCP bridge.

### Streaming Input Mode

The SDK requires an `AsyncIterable<SDKUserMessage>` prompt (not a plain string) when in-process MCP servers are configured via `createSdkMcpServer()`. Since QRM2-003 will always inject orchestration tools through an in-process MCP server, `ClaudeCodeService.execute()` must use streaming input mode as its primary code path. The method transparently wraps the prompt string into a single-message async iterable.

### Permission Model

Agents run inside hardened containers (QRM2-001): non-root user, dropped capabilities, read-only rootfs, no privilege escalation. This makes `bypassPermissions` safe — Claude Code can execute tools freely because the container itself is the security boundary. No interactive permission prompts, no `canUseTool` callback. Tool-level access control is handled by `allowedTools`/`disallowedTools` in QRM2-004.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `ClaudeCodeService` with `execute()` method | MCP orchestration tool bridge (QRM2-003) |
| SDK installation and dependency setup | Role permission profiles (QRM2-004) |
| `ExecuteParams` / `ExecuteResult` type definitions | InvocationHandler migration (QRM2-005) |
| Working directory, system prompt, model config | Prompt template updates (QRM2-006) |
| Permission mode setup (`bypassPermissions`) | Terminal app changes (QRM2-007) |
| Output consumption and result extraction | |
| AbortController integration for graceful shutdown | |
| Unit tests for ClaudeCodeService | |

## Implementation Details

### Package Installation

Add `@anthropic-ai/claude-agent-sdk` to root `package.json` dependencies. The SDK bundles the Claude Code runtime — no separate CLI installation needed. The agent container's toolchain (git, bash, ripgrep from QRM2-001) provides the system binaries that Claude Code's built-in tools depend on.

Keep `@anthropic-ai/sdk` — the terminal app uses it directly, and the agent's existing `AnthropicService` stays until QRM2-005 completes the migration. The SDK also has a peer dependency on `zod ^4.0.0`, which the project already satisfies (`^4.3.6`).

### Type Definitions

Location: `apps/agent/src/llm/claude-code.types.ts`

Two interfaces define the service contract:

**`ExecuteParams`** — everything needed to run a Claude Code session:

```typescript
interface ExecuteParams {
  prompt: string;                                          // User/task message
  systemPrompt: string;                                    // Role-specific prompt
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;  // In-process MCP tools (QRM2-003)
  allowedTools?: string[];                                 // Tool whitelist (QRM2-004)
  disallowedTools?: string[];                              // Tool blacklist (QRM2-004)
  maxTurns?: number;                                       // Turn limit (default: 20)
  abortController?: AbortController;                       // External cancellation
}
```

**`ExecuteResult`** — discriminated union on `success`:

```typescript
type ExecuteResult =
  | {
      success: true;
      result: string;           // Final text output
      sessionId: string;        // For tracing
      durationMs: number;
      totalCostUsd: number;
      numTurns: number;
    }
  | {
      success: false;
      error: string;            // Joined error messages
      durationMs: number;
      totalCostUsd: number;
    };
```

The discriminated union gives callers type-safe access — `sessionId` and `numTurns` only exist on success, mirroring the SDK's own `SDKResultMessage` shape. `sessionId` is captured from the `SDKSystemMessage` init event for correlation with Claude Code's internal logs.

### ClaudeCodeService

Location: `apps/agent/src/llm/claude-code.service.ts`

Injectable NestJS service that wraps `query()` with sensible defaults for the Quorum agent context.

**Constructor dependencies:**
- `AgentConfigService` — workspace dir (`agent.workspaceDir`), model (`anthropic.model`), API key (`anthropic.apiKey`)
- `QuorumLogger` — structured logging with context `ClaudeCodeService`

**Primary method: `execute(params: ExecuteParams): Promise<ExecuteResult>`**

The method:

1. **Creates or adopts an AbortController.** If `params.abortController` is provided, use it. Otherwise create a new one. Register it in the active executions set (for graceful shutdown).

2. **Wraps the prompt as an async iterable.** Streaming input mode is required when `mcpServers` are provided (and will always be provided once QRM2-003 lands). The method creates a single-message async generator:

    ```typescript
    async function* promptIterable() {
      yield { type: 'user', message: { role: 'user', content: prompt } };
    }
    ```

    When no `mcpServers` are provided (QRM2-002 standalone usage, before QRM2-003), the plain string prompt path is also supported for simpler testing and early integration.

3. **Calls `query()` with merged options.** Params from the caller override defaults from config:

    | Option | Source | Rationale |
    |--------|--------|-----------|
    | `cwd` | `config.agent.workspaceDir` | `/mnt/quorum/workspace` — shared project directory |
    | `model` | `config.anthropic.model` | Same model config as current `AnthropicService` |
    | `systemPrompt` | `params.systemPrompt` | Role-specific, from `RolePromptService` |
    | `permissionMode` | `'bypassPermissions'` | Container is the security boundary (QRM2-001) |
    | `allowDangerouslySkipPermissions` | `true` | Required for `bypassPermissions` |
    | `persistSession` | `false` | No disk session persistence — avoids accumulating stale data on tmpfs |
    | `settingSources` | `[]` | No filesystem settings — prevents loading stray `.claude/` configs from workspace |
    | `env` | `{ ANTHROPIC_API_KEY: config.anthropic.apiKey }` | Explicit key passthrough |
    | `includePartialMessages` | `false` | Full messages only; streaming events not needed for result extraction |
    | `allowedTools` | `params.allowedTools` | Passthrough for QRM2-004 profiles |
    | `disallowedTools` | `params.disallowedTools` | Passthrough for QRM2-004 profiles |
    | `mcpServers` | `params.mcpServers` | Passthrough for QRM2-003 bridge |
    | `maxTurns` | `params.maxTurns ?? 20` | Default 20 replaces the hardcoded 10-round loop |
    | `abortController` | from step 1 | External cancellation or internal shutdown |

4. **Iterates the async generator.** Processes `SDKMessage` events:

    - **`SDKSystemMessage` (init):** Capture `session_id`. Log session start with role, model, cwd.
    - **`SDKAssistantMessage`:** Log at debug level — turn index, content preview (first 200 chars). Useful for post-mortem without overwhelming logs.
    - **`SDKResultMessage` (success):** Map to `ExecuteResult` with `success: true`. Extract `result`, `duration_ms`, `total_cost_usd`, `num_turns`.
    - **`SDKResultMessage` (error):** Map to `ExecuteResult` with `success: false`. Join `errors` array into a single string.
    - **All other messages:** Ignore. No streaming events emitted since `includePartialMessages: false`.

5. **Catches exceptions.** SDK process failures (spawn errors, unexpected subprocess exits, signal kills) throw from the generator. Catch and map to `{ success: false, error: ... }` with timing from `Date.now()` delta.

6. **Cleans up.** Remove the AbortController from the active executions set in a `finally` block.

### Graceful Shutdown

`ClaudeCodeService` implements `OnApplicationShutdown`:

- Maintains a `Set<AbortController>` of active executions — added on execute start, removed on execute end (in `finally`).
- `onApplicationShutdown()` iterates all active controllers and calls `abort()`. Logs a warning with the count if any were aborted.
- This ensures in-flight Claude Code subprocesses terminate cleanly when the agent container shuts down, rather than becoming orphaned processes.

### Module Wiring

Update `LlmModule` to provide `ClaudeCodeService` alongside the existing `AnthropicService`:

```typescript
@Module({
  imports: [AgentConfigModule],
  providers: [AnthropicService, ClaudeCodeService],
  exports: [AnthropicService, ClaudeCodeService],
})
export class LlmModule {}
```

Both services coexist until QRM2-005 migrates `InvocationHandler` to `ClaudeCodeService` and removes `AnthropicService`. `ConnectionModule` already imports `LlmModule`, so `ClaudeCodeService` will be injectable into `InvocationHandler` when the time comes.

Also update the barrel export (`apps/agent/src/llm/index.ts`) to re-export `ClaudeCodeService` and the types.

### Logging

All logs use the agent's `QuorumLogger` with context `ClaudeCodeService`:

| Event | Level | Key fields |
|-------|-------|------------|
| Session started | `log` | sessionId, role, model, cwd |
| Assistant message | `debug` | sessionId, turnIndex, contentPreview |
| Execution succeeded | `log` | sessionId, durationMs, numTurns, totalCostUsd |
| Execution failed (SDK result) | `warn` | sessionId, error, durationMs, totalCostUsd |
| Execution failed (exception) | `error` | error message, durationMs |
| Shutdown abort | `warn` | count of aborted sessions |

### Testing Strategy

Unit tests mock the SDK's `query()` function. Jest mocks `@anthropic-ai/claude-agent-sdk` to return controlled async generators that yield predetermined `SDKMessage` sequences.

**Test cases:**

- **Success path:** Generator yields `SDKSystemMessage` (init) → `SDKAssistantMessage` → `SDKResultMessage` (success). Verify `ExecuteResult` mapping — `success: true`, `result`, `sessionId`, `durationMs`, `totalCostUsd`, `numTurns`.
- **Error result:** Generator yields init → `SDKResultMessage` (error_max_turns). Verify `success: false`, joined `errors` string.
- **SDK exception:** Generator throws (simulating subprocess crash). Verify graceful `{ success: false, error: ... }` — no unhandled rejection.
- **Abort:** Create an `AbortController`, pass it in params, call `abort()` during iteration. Verify the generator terminates and cleanup runs.
- **Options passthrough:** Verify `cwd`, `model`, `permissionMode`, `env`, `persistSession`, `settingSources` are set correctly in the `query()` call. Assert `bypassPermissions` and `allowDangerouslySkipPermissions: true`.
- **MCP servers → streaming input:** When `mcpServers` provided, verify prompt is wrapped as `AsyncIterable`. When absent, verify string prompt is used.
- **Default maxTurns:** Verify 20 when not specified, overridable via params.
- **Graceful shutdown:** Register two active executions, call `onApplicationShutdown()`, verify both AbortControllers are aborted.

### File Structure

```
apps/agent/src/
  llm/
    claude-code.service.ts           # NEW — wraps query() with Quorum defaults
    claude-code.service.spec.ts      # NEW — unit tests (mocked SDK)
    claude-code.types.ts             # NEW — ExecuteParams, ExecuteResult
    anthropic.service.ts             # UNCHANGED — stays until QRM2-005
    anthropic.service.spec.ts        # UNCHANGED
    tool-mapper.ts                   # UNCHANGED
    tool-mapper.spec.ts              # UNCHANGED
    llm.module.ts                    # MODIFIED — add ClaudeCodeService to providers/exports
    index.ts                         # MODIFIED — re-export ClaudeCodeService + types

package.json                         # MODIFIED — add @anthropic-ai/claude-agent-sdk
```

## Acceptance Criteria

- [ ] `@anthropic-ai/claude-agent-sdk` added to `package.json` and installs successfully
- [ ] `ClaudeCodeService` exists at `apps/agent/src/llm/claude-code.service.ts` with `execute()` method
- [ ] `ExecuteParams` and `ExecuteResult` types defined at `apps/agent/src/llm/claude-code.types.ts`
- [ ] `execute()` calls `query()` with correct defaults: `cwd` from config, `bypassPermissions`, `persistSession: false`, `settingSources: []`
- [ ] `execute()` passes `ANTHROPIC_API_KEY` via `env` option and `model` from config
- [ ] `execute()` accepts `mcpServers` and uses streaming input mode (`AsyncIterable` prompt) when provided
- [ ] `execute()` accepts `allowedTools` / `disallowedTools` for tool permission passthrough
- [ ] `execute()` returns typed `ExecuteResult` discriminated union (success with `result`/`sessionId`/`numTurns` or error)
- [ ] Session ID captured from `SDKSystemMessage` init event and included in success result
- [ ] SDK exceptions (subprocess failures) caught and mapped to `{ success: false }` — no unhandled rejections
- [ ] Graceful shutdown: `OnApplicationShutdown` aborts all in-flight executions via tracked `AbortController` set
- [ ] `LlmModule` provides and exports both `AnthropicService` and `ClaudeCodeService`
- [ ] Barrel export updated to re-export `ClaudeCodeService` and types
- [ ] Unit tests cover: success path, error result, SDK exception, abort, options passthrough, streaming input mode, shutdown
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (all existing + new tests)

## Dependencies and References

### Prerequisites
- QRM1-008 — Agent LLM Integration (current `AnthropicService` and `LlmModule` being extended)
- QRM1-006 — Structured Logger (`QuorumLogger` for service logging)
- QRM1-003 — Configuration Management (`AgentConfigService` for workspace dir, model, API key)

### Related (not blocking)
- QRM2-001 — Docker Agent Image (provides toolchain that CC's built-in tools depend on; needed for runtime but not for development/testing)

### What This Blocks
- QRM2-003 — MCP Orchestration Tool Bridge (needs `ClaudeCodeService` to inject `mcpServers`)
- QRM2-004 — Role Permission Profiles (needs `ClaudeCodeService` to configure `allowedTools`/`disallowedTools`)
- QRM2-005 — InvocationHandler Migration (needs `ClaudeCodeService` as the replacement engine)

### References
- [`@anthropic-ai/claude-agent-sdk` on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Claude Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
- [SDK custom tools guide](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [SDK permissions guide](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Current `AnthropicService`: `apps/agent/src/llm/anthropic.service.ts`
- Current `InvocationHandler`: `apps/agent/src/connection/invocation-handler.service.ts`