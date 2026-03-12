# QRM2-008: Terminal Moderator Evaluation

## Summary

Evaluate the terminal moderator's runtime and decide against Claude Code SDK migration — the terminal is user-facing with no filesystem needs, so the raw Anthropic SDK remains the right fit. Instead, add moderator initialisation with `quorum.md`: the terminal app reads the workspace config file at startup and injects its contents into the moderator's system prompt, giving the moderator grounded awareness of the project scope and team responsibilities it orchestrates.

## Problem Statement

The terminal moderator currently has no connection to the target project's `quorum.md`. The prompt *mentions* that agents read `quorum.md`, but the moderator itself never sees its contents:

- **Blind orchestration.** The moderator delegates work to agents that read `quorum.md` for project-specific conventions, feature scope, and role-specific instructions — but the moderator has no idea what those instructions say. It orchestrates a team without understanding the project brief.
- **Vague delegation.** Without knowing the project's constraints, feature scope, or role-specific guidance, the moderator's `invoke_agent` calls carry generic instructions rather than project-informed ones. The architect gets "design auth" instead of context the moderator could supply from `quorum.md`.
- **SDK evaluation pending.** The QRM2-000 roadmap flagged a decision: should the terminal migrate to Claude Code SDK? The terminal has no filesystem needs, no workspace operations, and no code tools — it only uses MCP orchestration tools (`invoke_agent`, `context_*`). Migrating adds SDK dependency and permission surface without proportional value. This ticket captures and closes that evaluation.

## Design Context

### SDK Evaluation Decision

The terminal `ChatService` uses the raw Anthropic SDK (`@anthropic-ai/sdk`) via `AnthropicService.chat()` with a manual tool loop (up to 10 rounds). Claude Code SDK (`@anthropic-ai/claude-agent-sdk`) provides filesystem tools, bash execution, and git operations — none of which the moderator needs.

| Consideration | Raw Anthropic SDK | Claude Code SDK |
|--------------|-------------------|-----------------|
| **MCP tool calling** | Works via manual tool loop | Works via custom tools bridge |
| **Filesystem access** | Not needed | Unnecessary capability surface |
| **Bash execution** | Not needed | Unnecessary capability surface |
| **Permission management** | N/A — no built-in tools to restrict | Would need profiles to deny everything |
| **Dependency footprint** | Already installed | Additional SDK dependency for terminal app |
| **Complexity** | 10-round loop, well-understood | SDK session lifecycle, streaming, permission hooks |

**Decision: Stay on raw Anthropic SDK.** The terminal moderator is a pure orchestration agent. It reasons about user intent, selects agents, and synthesises responses. Adding Claude Code's code-editing capabilities to a non-coding agent increases surface area for no benefit. The manual tool loop is simple, tested, and sufficient.

### quorum.md Initialisation

The moderator needs `quorum.md` content in its system prompt so it can:
1. Understand what the project/feature is about when translating user intent into agent tasks
2. Reference role-specific instructions when deciding which agent to invoke and what to tell them
3. Mention project constraints when synthesising agent responses for the user

The workspace path is already known to the system — agent containers use `AGENT_WORKSPACE_DIR` (default `/mnt/quorum/workspace`). The terminal needs an equivalent config value to locate `quorum.md`.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| SDK evaluation decision (stay on Anthropic SDK) | Migrating terminal to Claude Code SDK |
| Add workspace path config to terminal app | Injecting project `docs/` into the prompt |
| Read `quorum.md` at startup and inject into system prompt | Dynamic `quorum.md` reloading mid-session |
| Graceful handling when `quorum.md` is missing | Creating a default `quorum.md` template |
| Tests for the new initialisation behaviour | E2E Docker validation (QRM2-009) |

## Implementation Details

### Terminal Workspace Config

Add a `workspaceDir` field to the terminal config schema in `apps/terminal/src/config/terminal.config.ts`. This follows the same pattern as the agent app's config (`apps/agent/src/config/agent.config.ts:7`):

```typescript
const schema = z.object({
  callbackUrl: z.string().url(),
  workspaceDir: z.string().min(1),
});
```

Default value: `/mnt/quorum/workspace` (from `TERMINAL_WORKSPACE_DIR` env var, matching the agent's `AGENT_WORKSPACE_DIR` convention). The `TerminalConfigService` exposes it as `config.terminal.workspaceDir`.

### quorum.md Reader

A lightweight service (or method within `ChatService`) that:

1. Resolves the path: `path.join(workspaceDir, 'quorum.md')`
2. Reads the file contents (`fs.readFile`)
3. Returns the content as a string, or `undefined` if the file doesn't exist

No parsing, no validation — `quorum.md` is a freeform markdown file. The reader is a simple I/O operation.

**Missing file handling:** If `quorum.md` doesn't exist, log a warning and proceed without it. The moderator can still function — it just won't have project-specific context. This is important for first-run scenarios where the workspace hasn't been configured yet.

### System Prompt Assembly

The system prompt in `ChatService` currently uses a hardcoded `TERMINAL_MODERATOR_PROMPT` constant. Change this to dynamic assembly at startup:

```
TERMINAL_MODERATOR_PROMPT
─────────────
[if quorum.md exists]
---

## Project Configuration (quorum.md)

{quorum.md contents}
```

The `quorum.md` section is appended after the existing prompt, separated by a horizontal rule. If `quorum.md` is absent, the prompt remains unchanged — no empty section, no placeholder.

The assembly happens once during `ChatService.start()` (or `onModuleInit`), not per-message. The system prompt is set for the session lifetime. This keeps things simple — no per-turn file reads, no stale-content concerns within a single session.

### Chat Service Changes

The `ChatService` changes are minimal:

1. Inject the workspace path via config (or a reader service)
2. In `start()` (before entering `chatLoop`), read `quorum.md`
3. If content exists, set `this.systemPrompt` to `TERMINAL_MODERATOR_PROMPT + separator + quorum content`
4. If content is absent, `this.systemPrompt` stays as `TERMINAL_MODERATOR_PROMPT`

The existing `processWithLoop()` method already reads `this.systemPrompt` — no changes needed downstream.

### Docker Compose

Add `TERMINAL_WORKSPACE_DIR: /mnt/quorum/workspace` to the terminal service's environment variables. The workspace volume is already mounted for agent containers; the terminal container needs the same mount (read-only is sufficient — the moderator never writes to the workspace):

```yaml
terminal:
  environment:
    <<: *shared-env
    TERMINAL_WORKSPACE_DIR: /mnt/quorum/workspace
  volumes:
    - ${QUORUM_WORKSPACE:-./workspace}:/mnt/quorum/workspace:ro
    - quorum-logs:/app/logs
```

The `:ro` mount flag ensures the terminal cannot modify workspace files, maintaining the principle that the moderator orchestrates but does not implement.

### Test Strategy

**Unit tests for quorum.md reading:**
- File exists → returns contents
- File missing → returns undefined, logs warning
- File empty → returns empty string (still "exists")

**Unit tests for system prompt assembly:**
- With quorum.md content → prompt includes "Project Configuration" section with content
- Without quorum.md → prompt equals the base `TERMINAL_MODERATOR_PROMPT`

**Integration test for ChatService initialisation:**
- Mock filesystem, verify `systemPrompt` is assembled correctly before `chatLoop` starts

**Config tests:**
- `TERMINAL_WORKSPACE_DIR` env var overrides default
- Default value is `/mnt/quorum/workspace`

## Acceptance Criteria

- [ ] SDK evaluation decision documented: terminal stays on raw Anthropic SDK (no migration)
- [ ] Terminal config (`terminal.config.ts`) includes `workspaceDir` with `TERMINAL_WORKSPACE_DIR` env var, defaulting to `/mnt/quorum/workspace`
- [ ] `TerminalConfigService` exposes `workspaceDir`
- [ ] `ChatService` reads `quorum.md` from the workspace directory at startup
- [ ] `quorum.md` contents are injected into the moderator's system prompt under a "Project Configuration" section
- [ ] Missing `quorum.md` is handled gracefully: warning logged, moderator functions without it
- [ ] System prompt assembly is tested (with content, without content)
- [ ] `docker-compose.yml` adds workspace volume mount (read-only) and `TERMINAL_WORKSPACE_DIR` to terminal service
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (all existing + new tests)

## Dependencies and References

### Prerequisites
- **QRM2-006** — InvocationHandler Migration (establishes the SDK-based agent runtime that this ticket evaluates against)
- **QRM2-007** — Prompt Adaptation (the `TERMINAL_MODERATOR_PROMPT` this ticket extends)

### What This Blocks
- **QRM2-009** — E2E Integration Smoke Test (needs the terminal to be project-aware via `quorum.md`)

### References
- Terminal chat service: `apps/terminal/src/chat/chat.service.ts`
- Terminal config: `apps/terminal/src/config/terminal.config.ts`
- Agent workspace config pattern: `apps/agent/src/config/agent.config.ts:7-14`
- Workspace conventions: `docs/system-design.md:136-179`
- quorum.md description: `docs/system-design.md:150-179`
- QRM2-000 roadmap (QRM2-008 entry): `tickets/QRM2-000-roadmap.md:71-73`
- Current moderator prompt: `apps/terminal/src/chat/chat.service.ts:16-70`
- Ticket conventions: `tickets/README.md`