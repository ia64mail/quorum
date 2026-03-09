# QRM2-006: InvocationHandler Migration

## Summary

Replace the manual 10-round Anthropic SDK tool loop in `InvocationHandler` with a single `ClaudeCodeService.execute()` call, integrating the MCP tool bridge (QRM2-003) and role permission profiles (QRM2-005). The agentic loop moves inside the Claude Code subprocess — the handler becomes a thin orchestration layer that assembles parameters and maps results. This completes the core agent runtime migration: after this ticket, agents process invocations through Claude Code with full filesystem access, built-in tools, and orchestration capabilities.

## Problem Statement

The current `InvocationHandler` implements a manual agentic loop that reimplements what Claude Code does natively — and does it worse:

- **Limited tool loop.** A hardcoded `MAX_TOOL_ROUNDS = 10` ceiling on tool iterations. Complex tasks (multi-file implementation, test-driven development) routinely need more. Claude Code manages its own turn budget dynamically.
- **No built-in tools.** The loop only exposes MCP server tools via `mapMcpToolsToAnthropic()`. The agent cannot read files, edit code, run bash commands, search with grep/glob, or use any of Claude Code's ~20 built-in tools. Agents are "brains in jars" — they can reason about code but not touch it.
- **Manual tool execution plumbing.** The handler manually extracts `tool_use` blocks, dispatches `McpClientService.callTool()`, formats results back into `tool_result` messages, and appends to conversation history. All of this is handled internally by Claude Code.
- **No permission enforcement.** QRM2-005 created `RolePermissionService` with `disallowedTools`, bash command filtering, and write path guards — but the manual loop doesn't use any of it. Permission profiles are dead code until this migration.
- **Raw SDK dependency.** The handler imports `@anthropic-ai/sdk` types (`MessageParam`, `ContentBlock`) and calls `AnthropicService.chat()` (a thin `messages.create()` wrapper). After QRM2-002 introduced `ClaudeCodeService`, this is the last consumer of the raw Anthropic SDK in the agent app.

After this ticket, `InvocationHandler.handle()` becomes:
1. Build a prompt string from the `InvokeRequest`
2. Get the system prompt from `RolePromptService`
3. Create a request-scoped tool bridge from `McpToolBridgeService`
4. Get permission restrictions from `RolePermissionService`
5. Call `ClaudeCodeService.execute()` with all of the above
6. Map `ExecuteResult` to `InvokeResponse`

Six steps, no loop, no tool dispatch, no message history management.

## Design Context

### What Moves Inside Claude Code

| Responsibility | Before (manual loop) | After (SDK) |
|----------------|---------------------|-------------|
| Tool iteration | `for` loop, `MAX_TOOL_ROUNDS = 10` | SDK-managed, `maxTurns` configurable |
| Tool discovery | `McpClientService.getTools()` + `mapMcpToolsToAnthropic()` | SDK discovers built-in + bridge tools automatically |
| Tool dispatch | `executeTool()` → `McpClientService.callTool()` | SDK dispatches built-in tools; bridge proxies MCP tools |
| Parameter augmentation | `augmentArgs()` in handler | Closure capture in `McpToolBridgeService.createBridge()` |
| Message history | Manual `MessageParam[]` array, push after each turn | Internal to SDK |
| Error recovery | `try/catch` per tool, format `tool_result` with `is_error` | SDK handles tool errors internally |
| Result extraction | `extractText()` scanning `ContentBlock[]` | `ExecuteResult.result` (already extracted) |
| Permission enforcement | None | `disallowedTools` + `canUseTool` guard from `RolePermissionService` |

### Parameter Flow

```
InvokeRequest
    │
    ├─ action + context ──────────→ prompt (string)
    ├─ caller ─────────────────────→ RolePromptService.getSystemPrompt(caller) → systemPrompt
    ├─ correlationId, depth ───────→ McpToolBridgeService.createBridge(request) → mcpServers
    │                                  (captured in bridge closures)
    └─ (agent role) ───────────────→ RolePermissionService.getDisallowedTools() → disallowedTools
                                   → RolePermissionService.getToolGuardHook()  → canUseTool (via adapter)
```

### Result Mapping

`ExecuteResult` → `InvokeResponse`:

```typescript
// Success
{ success: true, result, sessionId, durationMs, totalCostUsd, numTurns }
  → { success: true, result }

// Failure
{ success: false, error, durationMs, totalCostUsd }
  → { success: false, error }
```

The handler logs SDK metadata (`sessionId`, `durationMs`, `totalCostUsd`, `numTurns`) but does not propagate it in `InvokeResponse`. The response contract stays unchanged — callers see no difference.

### Bash Guardrails and Write Path Filtering via `canUseTool`

QRM2-005 created `createToolGuardHook()` which returns a function that inspects tool name and input before execution — blocking denied bash commands and restricting write paths per role. This hook was designed to be called before each tool execution.

The SDK provides exactly this mechanism: the **`canUseTool`** callback option on `query()`. It is called before every tool execution and can allow or deny with a reason.

#### SDK `canUseTool` API

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
  },
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

Key capabilities:
- Receives **tool name** and **full input** before every tool call — same surface as our `createToolGuardHook()`
- Can **deny** with a human-readable `message` that the SDK feeds back to the LLM
- Can **allow with modified input** (`updatedInput`) — enables sanitisation if needed
- Can set `interrupt: true` to abort the entire session on deny (not needed here)

#### Adapter Pattern

The existing `createToolGuardHook()` returns `(toolName, toolInput) → ToolGuardResult`. The adapter maps this to `CanUseTool`:

```typescript
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

function toCanUseTool(
  guardHook: (toolName: string, toolInput: Record<string, unknown>) => ToolGuardResult,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const result = guardHook(toolName, input);

    if (result.allowed) {
      return { behavior: 'allow' };
    }

    return { behavior: 'deny', message: result.reason ?? 'Denied by role policy' };
  };
}
```

The adapter is minimal because the signatures already align. It lives in `InvocationHandler` as a private method (or as a standalone function in the same file) — it doesn't warrant a separate module.

#### Integration in `InvocationHandler`

The handler obtains the guard hook from `RolePermissionService.getToolGuardHook()` and wraps it:

```typescript
const result = await this.claudeCode.execute({
  prompt: this.buildPrompt(request),
  systemPrompt: this.promptService.getSystemPrompt(request.caller),
  mcpServers: this.bridge.createBridge(request),
  disallowedTools: this.permissions.getDisallowedTools(),
  canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
});
```

This gives two layers of enforcement:
- **`disallowedTools`** — removes tools entirely from the model's context (e.g. `AskUserQuestion`, `NotebookEdit` for architect). The LLM never sees them.
- **`canUseTool`** — runtime inspection of tool input for allowed tools (e.g. bash command prefix matching, write path validation). The LLM sees the tool but specific invocations are rejected with a reason.

#### `ExecuteParams` Type Update

Add `canUseTool` to the params type so `ClaudeCodeService.execute()` can pass it through to `query()`:

```typescript
// claude-code.types.ts
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export interface ExecuteParams {
  prompt: string;
  systemPrompt: string;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  maxTurns?: number;
  abortController?: AbortController;
}
```

And in `ClaudeCodeService.execute()`, forward it to the SDK:

```typescript
const gen = query({
  prompt,
  options: {
    // ... existing options ...
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
  },
});
```

#### `bypassPermissions` Interaction

`ClaudeCodeService` currently uses `permissionMode: 'bypassPermissions'` so the SDK auto-approves all built-in permission checks (file writes, bash commands, etc.) without prompting. The question: does `canUseTool` still fire when `bypassPermissions` is set?

`canUseTool` is a **custom permission handler** — a callback injected by the host process, separate from the SDK's built-in permission system. The `bypassPermissions` mode bypasses the SDK's *internal* permission checks (the ones that would normally prompt a human user). Our `canUseTool` callback is the *replacement* for that human user — it's the programmatic authority. The SDK calls it regardless of permission mode.

**Verification:** The implementor should write a quick integration test confirming `canUseTool` fires with `bypassPermissions` before building the full integration. If the assumption is wrong, the fallback is to switch to `permissionMode: 'default'` and use `canUseTool` as the sole permission authority (returning `{ behavior: 'allow' }` for everything the guard hook doesn't block).

### Dependencies Removed from InvocationHandler

| Dependency | Why removed |
|------------|-------------|
| `AnthropicService` | SDK replaces raw `messages.create()` calls |
| `McpClientService` (direct) | Bridge encapsulates MCP tool proxying |
| `mapMcpToolsToAnthropic` | No manual tool schema conversion needed |
| `formatToolResult` | SDK handles tool result formatting internally |

After this migration, `AnthropicService` has no consumers in the agent app. It remains in `LlmModule` but is unused. The ticket should remove the import from `InvocationHandler` — whether to remove `AnthropicService` from the module entirely is a judgment call for the implementor (it's harmless dead code and may be useful for debugging).

### Dependencies Added

| Dependency | Purpose |
|------------|---------|
| `ClaudeCodeService` | SDK execution engine |
| `McpToolBridgeService` | Request-scoped orchestration tool bridge |
| `RolePermissionService` | Role-based `disallowedTools` list |

All three are already provided/exported by their respective modules (`LlmModule`, `ConnectionModule`, `AgentConfigModule`) and available to `InvocationHandler` in `ConnectionModule` without wiring changes.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Rewrite `InvocationHandler` to use `ClaudeCodeService.execute()` | Prompt template updates (QRM2-007) |
| Integrate `McpToolBridgeService.createBridge()` for MCP tools | Terminal moderator migration (QRM2-008) |
| Integrate `RolePermissionService.getDisallowedTools()` | Removal of `AnthropicService` from `LlmModule` |
| Map `ExecuteResult` → `InvokeResponse` | Adding new fields to `InvokeResponse` (cost, duration) |
| Log SDK metadata (session, cost, turns) | |
| Rewrite unit tests for the new implementation | |
| Remove unused imports (`MessageParam`, `ContentBlock`, etc.) | |
| Integrate tool guard hook via SDK `canUseTool` callback | |
| Add `canUseTool` to `ExecuteParams` and `ClaudeCodeService` | |

## Implementation Details

### Rewritten InvocationHandler

The service shrinks from ~194 lines to roughly 60-80. The entire `processWithLoop()` / `executeTool()` / `augmentArgs()` / `extractText()` chain is replaced by a single `ClaudeCodeService.execute()` call.

**Constructor dependencies:**

```typescript
constructor(
  private readonly config: AgentConfigService,
  private readonly claudeCode: ClaudeCodeService,
  private readonly bridge: McpToolBridgeService,
  private readonly permissions: RolePermissionService,
  private readonly promptService: RolePromptService,
)
```

**`handle(request)` method:**

```typescript
async handle(request: InvokeRequest): Promise<InvokeResponse> {
  this.logger.log(
    `Invocation received: correlationId=${request.correlationId} ` +
      `action="${request.action}" caller=${request.caller} depth=${request.depth}`,
  );

  try {
    const result = await this.claudeCode.execute({
      prompt: this.buildPrompt(request),
      systemPrompt: this.promptService.getSystemPrompt(request.caller),
      mcpServers: this.bridge.createBridge(request),
      disallowedTools: this.permissions.getDisallowedTools(),
      canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
    });

    this.logResult(request, result);

    return result.success
      ? { success: true, result: result.result }
      : { success: false, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `SDK execution failed: correlationId=${request.correlationId} ${message}`,
    );
    return { success: false, error: `SDK execution failed: ${message}` };
  }
}
```

**`buildPrompt(request)` method:**

Replaces `buildUserMessage()`. Same logic — formats the action and optional context into a prompt string. Name changed to reflect that this is a Claude Code prompt, not an Anthropic `MessageParam`.

**`logResult(request, result)` method:**

New private method that logs SDK metadata at appropriate levels:

```typescript
private logResult(request: InvokeRequest, result: ExecuteResult): void {
  const base = `correlationId=${request.correlationId}`;
  if (result.success) {
    this.logger.log(
      `Invocation complete: ${base} sessionId=${result.sessionId} ` +
        `turns=${result.numTurns} cost=$${result.totalCostUsd.toFixed(4)} ` +
        `duration=${result.durationMs}ms`,
    );
  } else {
    this.logger.warn(
      `Invocation failed: ${base} error="${result.error}" ` +
        `cost=$${result.totalCostUsd.toFixed(4)} duration=${result.durationMs}ms`,
    );
  }
}
```

### Removed Code

The following private methods are deleted entirely — their functionality is subsumed by the SDK:

| Method | Lines | Replacement |
|--------|-------|-------------|
| `processWithLoop()` | 47-105 | `ClaudeCodeService.execute()` internal loop |
| `extractText()` | 115-123 | `ExecuteResult.result` |
| `executeTool()` | 125-169 | SDK built-in dispatch + bridge `proxy()` |
| `augmentArgs()` | 171-193 | Bridge closure capture |

The `MAX_TOOL_ROUNDS` constant is also removed. The SDK's `maxTurns` (default 20, configurable via `ExecuteParams`) replaces it.

### Module Wiring

No changes to `ConnectionModule` are strictly necessary — it already imports `LlmModule` (which exports `ClaudeCodeService`) and `AgentConfigModule` (which exports `RolePermissionService`), and provides `McpToolBridgeService`. The `InvocationHandler` provider just gets different constructor dependencies via NestJS DI.

The only wiring change: if `InvocationHandler` no longer injects `McpClientService` and `AnthropicService`, NestJS won't resolve them for the handler (but they're still provided for other consumers like `McpToolBridgeService`). No action needed — NestJS only resolves what's in the constructor.

### Testing Strategy

The test file is rewritten to test the new integration surface. Tests mock `ClaudeCodeService.execute()`, `McpToolBridgeService.createBridge()`, and `RolePermissionService.getDisallowedTools()` instead of the old `AnthropicService.chat()` and `McpClientService` mocks.

**Test cases:**

1. **Success path:** Mock `execute()` → `{ success: true, result: 'done', ... }`. Verify `handle()` returns `{ success: true, result: 'done' }`.

2. **Failure path:** Mock `execute()` → `{ success: false, error: 'timeout', ... }`. Verify `handle()` returns `{ success: false, error: 'timeout' }`.

3. **Exception handling:** Mock `execute()` to throw. Verify `handle()` catches and returns `{ success: false, error: 'SDK execution failed: ...' }`.

4. **Prompt building:** Verify `execute()` receives `prompt` containing the action text. Verify context is included when present, omitted when absent/empty.

5. **System prompt:** Verify `RolePromptService.getSystemPrompt()` is called with `request.caller` and the result is passed as `systemPrompt`.

6. **Bridge integration:** Verify `McpToolBridgeService.createBridge()` is called with the full `InvokeRequest` and the result is passed as `mcpServers`.

7. **Permission integration — disallowedTools:** Verify `RolePermissionService.getDisallowedTools()` is called and the result is passed as `disallowedTools`.

8. **Permission integration — canUseTool:** Verify `RolePermissionService.getToolGuardHook()` is called and the result is wrapped via `toCanUseTool()` and passed as `canUseTool`.

9. **toCanUseTool adapter:** Unit test the adapter function directly — verify `{ allowed: true }` maps to `{ behavior: 'allow' }`, and `{ allowed: false, reason: 'Denied bash command: "rm -rf"' }` maps to `{ behavior: 'deny', message: 'Denied bash command: "rm -rf"' }`. Verify missing reason defaults to `'Denied by role policy'`.

10. **Metadata logging:** Verify that success results log `sessionId`, `numTurns`, `totalCostUsd`, `durationMs`. Verify that failure results log the error and cost.

Note: the old tests for `augmentArgs()` semantics, tool loop round limits, and `tool_result` formatting are removed — these behaviors moved into the bridge (tested in QRM2-003) and the SDK (not our code). The new tests verify integration wiring, not internal loop mechanics.

### File Structure

```
apps/agent/src/
  llm/
    claude-code.types.ts                 # MODIFIED — add canUseTool field to ExecuteParams
    claude-code.service.ts               # MODIFIED — forward canUseTool to query() options
  connection/
    invocation-handler.service.ts        # MODIFIED — rewritten (manual loop → SDK call + canUseTool adapter)
    invocation-handler.service.spec.ts   # MODIFIED — rewritten (new mock surface)
```

## Acceptance Criteria

- [ ] `InvocationHandler` no longer imports or uses `AnthropicService`, `McpClientService`, `mapMcpToolsToAnthropic`, or `formatToolResult`
- [ ] `InvocationHandler` constructor injects `ClaudeCodeService`, `McpToolBridgeService`, `RolePermissionService`, and `RolePromptService`
- [ ] `handle()` calls `ClaudeCodeService.execute()` with `prompt`, `systemPrompt`, `mcpServers`, `disallowedTools`, and `canUseTool`
- [ ] `prompt` is built from `request.action` and `request.context` (same format as before)
- [ ] `systemPrompt` comes from `RolePromptService.getSystemPrompt(request.caller)`
- [ ] `mcpServers` comes from `McpToolBridgeService.createBridge(request)`
- [ ] `disallowedTools` comes from `RolePermissionService.getDisallowedTools()`
- [ ] `ExecuteResult` is mapped to `InvokeResponse`: success → `{ success: true, result }`, failure → `{ success: false, error }`
- [ ] SDK metadata (`sessionId`, `durationMs`, `totalCostUsd`, `numTurns`) is logged but not propagated in `InvokeResponse`
- [ ] Exceptions from `execute()` are caught and returned as `{ success: false, error }`
- [ ] `MAX_TOOL_ROUNDS` constant and `processWithLoop()` / `executeTool()` / `augmentArgs()` / `extractText()` methods are removed
- [ ] `canUseTool` field added to `ExecuteParams` (type: `CanUseTool` from SDK) and forwarded in `ClaudeCodeService.execute()`
- [ ] `toCanUseTool()` adapter maps `ToolGuardResult` → `PermissionResult` (`allowed → { behavior: 'allow' }`, `!allowed → { behavior: 'deny', message }`)
- [ ] `canUseTool` is wired from `RolePermissionService.getToolGuardHook()` through the adapter
- [ ] `canUseTool` fires with `bypassPermissions` mode verified (integration test or manual confirmation documented)
- [ ] Unit tests cover: success/failure mapping, exception handling, prompt building, system prompt resolution, bridge integration, permission integration (`disallowedTools` + `canUseTool`), metadata logging
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (all existing + rewritten tests)

## Dependencies and References

### Prerequisites
- **QRM2-002** — Claude Code SDK Service Layer (`ClaudeCodeService`, `ExecuteParams`, `ExecuteResult`)
- **QRM2-003** — MCP Orchestration Tool Bridge (`McpToolBridgeService.createBridge()`)
- **QRM2-005** — Role Permission Profiles (`RolePermissionService.getDisallowedTools()`, tool guard hook)

### What This Blocks
- **QRM2-007** — Prompt Adaptation (prompts need to reflect the new CC-capable agent runtime)
- **QRM2-008** — Terminal Moderator Evaluation (evaluates whether terminal should follow the same migration path)
- **QRM2-009** — E2E Integration Smoke Test (validates the full migrated pipeline)

### References
- Current `InvocationHandler`: `apps/agent/src/connection/invocation-handler.service.ts`
- `ClaudeCodeService`: `apps/agent/src/llm/claude-code.service.ts`
- `ExecuteParams` / `ExecuteResult`: `apps/agent/src/llm/claude-code.types.ts`
- `McpToolBridgeService`: `apps/agent/src/connection/mcp-tool-bridge.service.ts`
- `RolePermissionService`: `apps/agent/src/config/role-permission.service.ts`
- `RoleToolProfile` / tool guard hook: `apps/agent/src/config/role-tool-profiles.ts`, `apps/agent/src/config/tool-guard-hook.ts`
- `ConnectionModule`: `apps/agent/src/connection/connection.module.ts`
- SDK `CanUseTool` / `PermissionResult` types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:114-140`
- QRM2-000 roadmap: `tickets/QRM2-000-roadmap.md` (line 59-62)