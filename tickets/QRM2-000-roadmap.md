# QRM2 Roadmap — Claude Code SDK Integration

## Goal

Replace the raw Anthropic SDK tool loop in agents with the **Claude Code Agent SDK** as the agent runtime. Each agent's `InvocationHandler` becomes a Claude Code session with role-scoped permissions — giving agents real filesystem access, code editing, bash execution, and git operations against a shared workspace, while retaining the existing MCP-based orchestration layer for inter-agent communication.

QRM1 proved the communication infrastructure works. QRM2 makes agents **capable of real work** — they stop being brains in jars and start reading, writing, and testing actual code.

## Success Criteria

- Agents use `@anthropic-ai/claude-code` SDK as their processing engine instead of direct `@anthropic-ai/sdk` `messages.create()` calls
- Each agent receives role-appropriate tool permissions (developer gets `Write`/`Edit`/`Bash`; architect gets `Read`/`Glob`/`Grep` only; teamlead gets read + limited write for ticket files)
- MCP tools (`invoke_agent`, `context_store`, `context_query`) are injected as custom tools into the Claude Code session so agents retain orchestration capabilities
- Agents operate on a shared workspace volume (`/mnt/quorum/workspace`) mounted from the host
- A moderator-initiated task produces observable code changes in the workspace (file created/modified, tests run)

## Scope Exclusions

- QA and Product Owner roles (evaluate after developer agent is functional)
- Ink-based terminal UI (still stdin/stdout)
- Production context store (InMemoryStore remains sufficient)
- CI/CD pipeline integration
- Multi-repo or multi-workspace support
- Agent sandboxing beyond Claude Code's built-in permission model

---

## Milestone Scope

Ticket breakdown to be elaborated in future sessions. Expected areas:

- **SDK integration layer** — wrap `@anthropic-ai/claude-code` in a NestJS-compatible service that replaces `AnthropicService` + tool loop in `InvocationHandler`
- **Permission profiles** — per-role tool allowlists and `allowedCommands` configuration
- **Custom tool bridge** — adapter that exposes MCP tools (`invoke_agent`, `context_*`) as Claude Code custom tools so the SDK session can call them
- **Workspace configuration** — shared volume setup, working directory management, concurrent access considerations
- **Prompt adaptation** — update role prompt templates to account for Claude Code's built-in capabilities (agents no longer need instructions about tools they can't use)
- **Terminal moderator** — evaluate whether the terminal's `ChatService` also migrates to Claude Code SDK or remains as-is (it already works and doesn't need filesystem access)