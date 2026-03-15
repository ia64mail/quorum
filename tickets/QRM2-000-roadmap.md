# QRM2 Roadmap — Claude Code SDK Integration

## Goal

Replace the raw Anthropic SDK tool loop in agents with the **Claude Code Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as the agent runtime. Each agent's `InvocationHandler` becomes a Claude Code session with role-scoped permissions — giving agents real filesystem access, code editing, bash execution, and git operations against a shared workspace, while retaining the existing MCP-based orchestration layer for inter-agent communication.

Additionally, harden agent containers so they protect the host machine: non-root execution, dropped capabilities, read-only root filesystem, and no privilege escalation paths. Claude Code runs without superuser privileges, using only pre-installed tools.

QRM1 proved the communication infrastructure works. QRM2 makes agents **capable of real work** — they stop being brains in jars and start reading, writing, and testing actual code, inside locked-down containers.

## Success Criteria

- Agents use `@anthropic-ai/claude-agent-sdk` `query()` as their processing engine instead of direct `@anthropic-ai/sdk` `messages.create()` calls
- **Every agent** (developer, architect, teamlead, qa) receives Claude Code with role-appropriate tool permissions — even read-heavy roles like architect benefit from CC's code intelligence
- MCP tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) are injected as custom tools into the Claude Code session via `createSdkMcpServer()` so agents retain orchestration capabilities
- Agents operate on a shared workspace volume (`/mnt/quorum/workspace`) mounted from the host
- Agent containers run as non-root user with dropped capabilities, read-only rootfs, and `no-new-privileges` — Claude Code cannot escalate privileges or access the host beyond designated volumes
- A moderator-initiated task produces observable code changes in the workspace (file created/modified, tests run)

## Scope Exclusions

- QA and Product Owner roles (evaluate after developer agent is functional)
- Ink-based terminal UI (still stdin/stdout)
- Production context store (InMemoryStore remains sufficient)
- CI/CD pipeline integration
- Multi-repo or multi-workspace support

---

## Milestone Scope

### QRM2-001 — Docker Agent Image: Toolchain & Hardening
Rebuild the agent container image with all tools Claude Code needs (git, ripgrep, bash, curl) and harden against host exposure: non-root user, dropped capabilities, read-only rootfs, tmpfs mounts, network restrictions.

**Depends on:** —

### QRM2-002 — Claude Code SDK Service Layer
Install `@anthropic-ai/claude-agent-sdk` and create a NestJS-compatible `ClaudeCodeService` wrapping the SDK's `query()` function. Replaces `AnthropicService` as the agent's LLM engine, handling streaming output, working directory configuration, and permission mode setup.

**Depends on:** —

### QRM2-003 — MCP Orchestration Tool Bridge
Adapter layer that exposes MCP orchestration tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) as Claude Code custom tools using `createSdkMcpServer()`. Each tool proxies to `McpClientService.callTool()` with auto-augmented parameters (correlationId, callerRole, depth).

**Depends on:** QRM2-002

### QRM2-004 — Moderator Invocation Endpoint (User Clarification Flow)
Add the moderator as an invocable target in `invoke_agent` so agents can escalate clarification requests to the user. Extends the MCP server's target enum, adds a POST /invoke endpoint to the Terminal App, and implements a direct user-prompting handler that surfaces agent questions in the console — bypassing the moderator LLM to avoid call-chain deadlocks. Decisions are auto-persisted to Context Store so they're never asked twice.

**Depends on:** QRM2-003

### QRM2-005 — Role Permission Profiles
Per-role configuration defining which Claude Code built-in tools each agent can use and which bash commands are denied. Profiles control `allowedTools` lists and hook-based command filtering to enforce the principle of least privilege.

> **Note:** `AskUserQuestion` must be in `disallowedTools` for all agent roles. Agents have no interactive user — the single-message async iterable exhausts on entry, so `AskUserQuestion` would hang indefinitely. Clarification flows through `invoke_agent` to the moderator instead (see QRM2-004, QRM2-007).

**Depends on:** QRM2-002

### QRM2-006 — InvocationHandler Migration
Replace the manual 10-round Anthropic SDK tool loop in `InvocationHandler` with a single `ClaudeCodeService.execute()` call, integrating the tool bridge and permission profiles. The agentic loop moves inside Claude Code — the handler becomes a thin orchestration layer.

**Depends on:** QRM2-002, QRM2-003, QRM2-005

### QRM2-007 — Prompt Adaptation
Update role prompt templates to reflect Claude Code capabilities. Agents now have filesystem tools — prompts must describe workspace conventions, available capabilities, and collaboration patterns in the context of code-capable agents.

> **Note — Autonomous clarification pattern:** Prompts must explicitly instruct agents to never attempt user interaction (`AskUserQuestion` is disabled via QRM2-005). When an agent needs clarification, it must use `invoke_agent` to reach the appropriate team member: **architect** for design/pattern questions, **teamlead** for task scope/priority, **productowner** for business requirements, **moderator** for user-facing clarification and blocker escalation (see QRM2-004). Prompts should also bias agents toward reasonable assumptions over excessive cross-agent chatter to conserve depth budget and tokens.

**Depends on:** QRM2-004, QRM2-006

### QRM2-008 — Terminal Moderator Evaluation
Evaluate whether the terminal's `ChatService` should migrate to Claude Code SDK or remain on the raw Anthropic SDK. The terminal is user-facing and doesn't need filesystem access — migration may add overhead without proportional value.

**Depends on:** QRM2-006

### QRM2-009 — E2E Integration Smoke Test
End-to-end validation in Docker: moderator-initiated task produces observable code changes in the workspace. Verifies container security posture, MCP orchestration, log tracing, and CC tool execution across roles.

**Depends on:** QRM2-001, QRM2-006, QRM2-007

### QRM2-010 — Enhanced Agent Log Observability
Improve console log readability and SDK execution transparency. Full-line colorization (not just the level label), SDK hook-based tool invocation logging (PreToolUse/PostToolUse/PostToolUseFailure), assistant reasoning extraction from message content blocks, "Session started" downgraded to DEBUG, and LOG_LEVEL defaulted to `debug` in docker-compose for local development.

**Depends on:** QRM2-002, QRM1-006

### QRM2-011 — Context Store File Persistence
Add file-based persistence to `InMemoryStore`. Serialize the store to `quorum.context` (alongside `quorum.md` in the workspace root) on graceful shutdown via `OnModuleDestroy`, and reload on startup via `OnModuleInit`. Expired items are pruned on load, writes use atomic tmp+rename, and missing/corrupt files degrade gracefully to an empty store. Requires adding the workspace volume mount to the MCP server container.

**Depends on:** QRM1-002, QRM1-003

---

## Dependency Graph

```
QRM2-001 (Docker) ──────────────────────────────────────────────────────────┐
                                                                             ├→ QRM2-009 (E2E)
QRM2-002 (SDK) ──→ QRM2-003 (Bridge) ──→ QRM2-004 (Clarify) ──┐             │
               ──→ QRM2-005 (Perms)  ──┐                       ├→ QRM2-007 (Prompts) ┘
               ──→ QRM2-010 (Logs)     ├→ QRM2-006 (Handler) ──┤
                                                               └→ QRM2-008 (Terminal Eval)

QRM2-011 (Context Persistence) ── independent, no QRM2 dependencies
```

**Parallel tracks:** QRM2-001 (infrastructure) and QRM2-002 (code) can start simultaneously. QRM2-003 and QRM2-005 can also run in parallel once QRM2-002 lands. QRM2-004 runs after QRM2-003. QRM2-011 has no QRM2 dependencies and can be implemented at any point.