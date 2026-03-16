# Claude Code SDK Integration

This document covers how Quorum agents use the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) (`@anthropic-ai/claude-agent-sdk`) to process tasks. For overall system architecture, see [System Design](system-design.md).

## Overview

Each agent container runs a NestJS application that receives invocations via HTTP and processes them through the Claude Agent SDK. The SDK spawns a Claude Code subprocess with full filesystem access, bash execution, and MCP tool integration — making agents capable of real software development work.

```mermaid
graph TB
    subgraph "Agent Container"
        CTRL[InvocationController<br/>POST /invoke]
        HANDLER[InvocationHandler]
        SDK[ClaudeCodeService<br/>SDK query]
        BRIDGE[McpToolBridge<br/>In-process MCP Server]
        PERMS[RolePermissionService]
        PROMPTS[RolePromptService]
        HOOKS[Observability Hooks]

        CTRL --> HANDLER
        HANDLER --> SDK
        HANDLER --> BRIDGE
        HANDLER --> PERMS
        HANDLER --> PROMPTS
        SDK --> HOOKS
        SDK --> BRIDGE
    end

    subgraph "MCP Server"
        MCP[MCP Tools]
    end

    BRIDGE -->|"proxy tool calls"| MCP
```

## Invocation Flow

When a task arrives at `POST /invoke`, the `InvocationHandler` assembles all parameters and delegates to `ClaudeCodeService`:

1. **Prompt**: Built from `request.action` + serialized `request.context`
2. **System prompt**: Role-specific template from `RolePromptService`
3. **MCP servers**: In-process bridge from `McpToolBridgeService` (scoped to this request)
4. **Permissions**: `disallowedTools` list + `canUseTool` runtime callback from `RolePermissionService`

The `ClaudeCodeService` calls the SDK's `query()` generator and iterates over the message stream until a `result` message arrives (success or error). Results are mapped to an `InvokeResponse` and returned to the caller.

### ExecuteResult

The SDK response is normalized into a discriminated union:

| Field | Success | Failure |
|-------|---------|---------|
| `success` | `true` | `false` |
| `result` | LLM output text | — |
| `error` | — | Error description |
| `sessionId` | SDK session ID | — |
| `durationMs` | Elapsed time | Elapsed time |
| `totalCostUsd` | API cost | API cost |
| `numTurns` | Tool-use rounds | — |

## MCP Tool Bridge

The tool bridge is the mechanism connecting Claude Code sessions to Quorum's MCP orchestration. Since the SDK runs as a subprocess, it cannot directly call remote MCP tools. The bridge solves this by creating an **in-process MCP server** that proxies tool calls to the remote MCP server.

```mermaid
graph LR
    subgraph "Claude Code Subprocess"
        LLM[Claude LLM]
    end

    subgraph "Agent Process"
        BRIDGE["McpToolBridgeService<br/>(in-process MCP server)"]
        CLIENT[McpClientService]
    end

    subgraph "MCP Server Container"
        MCP[MCP Server]
    end

    LLM -->|"tool call"| BRIDGE
    BRIDGE -->|"mcpClient.callTool()"| CLIENT
    CLIENT -->|"Streamable HTTP"| MCP
```

### Bridged Tools

The bridge exposes 5 orchestration tools to the Claude Code session:

| Tool | Purpose | Auto-injected Parameters |
|------|---------|-------------------------|
| `invoke_agent` | Call another agent | `callerRole`, `correlationId`, `depth+1` (always override) |
| `context_store` | Write to Context Store | `correlationId` (default, agent can override) |
| `context_query` | Read from Context Store | `correlationId` (default, agent can override) |
| `context_summarize` | Compress context | `correlationId` (default) |
| `context_stats` | Usage statistics | Pure passthrough |

The bridge is **request-scoped** — a new in-process server is created per invocation, capturing `correlationId`, `callerRole`, and `depth` in closures. This ensures each Claude Code session has correctly scoped orchestration context.

### Parameter Augmentation

For `invoke_agent`, the bridge always overrides `callerRole`, `correlationId`, and `depth+1` — the agent cannot spoof its identity or break the call chain. For context tools, `correlationId` is injected as a default that the agent can override (useful when querying a different conversation's context).

## Role Permission Profiles

Each agent role has a static permission profile that enforces principle of least privilege. Permissions are enforced mechanically — not just via prompts.

### Enforcement Layers

```mermaid
graph TB
    subgraph "Permission Enforcement"
        DIS[disallowedTools<br/>Static tool blocklist]
        CAN[canUseTool Hook<br/>Runtime input inspection]
    end

    subgraph "canUseTool Checks"
        BASH[Bash Command Filter<br/>Prefix matching]
        WRITE[Write Path Guard<br/>Workspace-relative resolution]
    end

    DIS --> SDK[Claude Code SDK]
    CAN --> SDK
    CAN --> BASH
    CAN --> WRITE
```

1. **`disallowedTools`**: Static list of tool names the SDK will never offer to the LLM
2. **`canUseTool` hook**: Runtime callback that inspects tool name + input before execution
   - **Bash command filter**: Prefix-matches against denied commands (case-insensitive, strips `sudo`, normalizes whitespace)
   - **Write path guard**: Resolves paths relative to workspace, enforces `allowedWritePaths` with trailing-slash comparison to prevent prefix-substring attacks

### Per-Role Profiles

All roles share a common set of disallowed tools: `AskUserQuestion` (would hang — no interactive user), `Config`, `ExitPlanMode`.

| Role | Additional Disallowed Tools | Denied Bash Commands | Write Path Restrictions |
|------|---------------------------|---------------------|------------------------|
| **developer** | — | `git push --force`, `rm -rf /` | Unrestricted |
| **architect** | `NotebookEdit` | `git commit`, `git push`, `rm -rf /` | `docs/`, `tickets/` only |
| **teamlead** | — | `git push --force`, `npm publish`, `rm -rf /` | Unrestricted |
| **qa** | — | `git commit`, `git push`, `rm -rf /`, `npm publish` | Unrestricted |
| **productowner** | `NotebookEdit`, `Bash`, `EnterWorktree`, `Agent` | N/A (Bash disabled) | `tickets/` only |

> **Security boundary**: Bash filtering is bypassable via shell operators (pipes, subshells). This is an acknowledged design trade-off — the container itself (read-only filesystem, dropped capabilities, no-new-privileges) is the security boundary, not the tool filter. The filter prevents accidental misuse, not adversarial bypass.

## Container Hardening

Agent containers run with defense-in-depth security constraints. The Dockerfile uses a multi-target build: `default` for mcp-server/terminal (Alpine), `agent` for agents (Debian bookworm-slim with toolchain).

### Agent Target (`node:24-bookworm-slim`)

Bookworm-slim (Debian) is used instead of Alpine because Claude Code tools require glibc (musl libc causes edge cases with ripgrep and git).

**Installed toolchain**: git, bash, ripgrep, curl, jq, openssh-client, ca-certificates

**User setup**: Non-root `quorum` user with configurable UID/GID via `HOST_UID`/`HOST_GID` build args (default 1000). This aligns container file ownership with the host user's UID, preventing bind-mount permission issues.

### Docker Compose Security Policy

Agent services inherit a shared `x-agent-security` YAML anchor:

| Constraint | Value | Purpose |
|------------|-------|---------|
| `security_opt` | `no-new-privileges:true` | Prevent privilege escalation via setuid/setgid |
| `cap_drop` | `ALL` | Drop all Linux capabilities |
| `read_only` | `true` | Read-only root filesystem |
| `tmpfs /tmp` | 512 MB | Writable scratch space |
| `tmpfs ~/.claude` | 256 MB | SDK state directory |
| `tmpfs ~/.config` | 64 MB | XDG config directory |
| `tmpfs ~/.local` | 64 MB | XDG local directory |
| `tmpfs ~/.cache` | 128 MB | XDG cache directory |

The workspace volume is explicitly mounted `:rw` against the read-only rootfs. Logs are written to a shared `quorum-logs` volume.

### SDK Filesystem Workarounds

The read-only rootfs required several workarounds for Claude Code SDK compatibility:

- **`~/.claude.json`**: Symlinked to `/tmp/.claude.json` at build time (SDK writes config on startup)
- **`~/.claude/debug/`**: Created at container startup via CMD wrapper (`mkdir -p`)
- **tmpfs UID/GID**: Aligned with `HOST_UID`/`HOST_GID` build args so the `quorum` user can write

## Observability Hooks

The `createObservabilityHooks()` factory produces SDK lifecycle hooks that log tool execution at DEBUG level:

| Hook | Event | Logged Data |
|------|-------|-------------|
| `PreToolUse` | Tool execution starts | Tool name, truncated input (200 chars) |
| `PostToolUse` | Tool execution succeeds | Tool name, `tool_use_id` |
| `PostToolUseFailure` | Tool execution fails | Tool name, truncated error (300 chars) |

All hooks return `{ continue: true }` — they observe but don't modify SDK behavior.

Additionally, `ClaudeCodeService` extracts tool call information from assistant messages (`tool_use` content blocks) and logs them at DEBUG level for end-to-end tracing.

### Log Levels

- **LOG**: Invocation start/complete, result summary (turns, cost, duration)
- **DEBUG**: SDK session start, tool events (via hooks), assistant reasoning
- **WARN**: Tool failures, invocation errors
- **ERROR**: SDK crashes, abort signals

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `AGENT_ROLE` | `developer` | Determines role prompt and permission profile |
| `AGENT_WORKSPACE_DIR` | `/mnt/quorum/workspace` | Working directory for SDK subprocess |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Model for SDK queries |
| `ANTHROPIC_MAX_TOKENS` | `4096` | Max tokens per response |

## Terminal Moderator Exception

The terminal app's Moderator uses the **raw Anthropic SDK** (`@anthropic-ai/sdk`), not the Claude Agent SDK. The moderator is pure orchestration (no filesystem operations, no code generation), so the Claude Code capability surface adds no value. The manual 10-round tool loop in `ChatService` is simpler and already tested.

The terminal reads `quorum.md` from the workspace at startup and injects it into the moderator's system prompt for project context awareness.

## References

- [System Design](system-design.md) — Overall architecture
- [Agent Messaging](agent-messaging.md) — Bidirectional MCP, invoke_agent patterns
- [Message Broker](message-broker.md) — Routing, safeguards, timeouts
- [Context Management](context-management.md) — MCP context API design
- [Context Store](context-store.md) — Storage backend details