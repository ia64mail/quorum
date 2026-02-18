# QRM1-009: Role Prompt System

## Summary

Replace the placeholder system prompt in `InvocationHandler` with role-specific prompt templates that define each agent's identity, responsibilities, collaboration style, and tool usage guidelines. Store prompt templates in `libs/common/` for cross-app access and provide an injectable `RolePromptService` in the agent app for hydration and resolution.

## Problem Statement

The agentic tool loop from QRM1-008 works — agents receive invocations, call the Anthropic API with tool definitions, execute tool calls, and return text responses. But every agent behaves identically because they all receive the same three-line placeholder prompt:

```
You are a {role} agent in the Quorum multi-agent system.
You received a task from the {caller} agent. Process it and respond with your result.
Use the available tools when needed to complete the task.
```

This creates several concrete problems:

- **No role differentiation** — An architect agent responds the same way as a developer agent. The LLM has no instruction about what an architect *does* versus what a developer *does*. Without role-specific behavior, invoking a particular role is meaningless — you're just calling "generic LLM" with a label.
- **No collaboration guidance** — Agents don't know *when* to invoke other agents versus handling things themselves. The architect doesn't know it can ask the product owner for requirements. The developer doesn't know it should consult the architect on design questions. The tools are available but the LLM has no guidance on when or why to use them.
- **No context discipline** — Agents don't know to store decisions for others or query context before starting work. The pull-based context model (the core design principle from `docs/system-design.md`) requires agents to actively participate: querying what they need, recording what they decide. Without prompting, the LLM won't use `context_store` or `context_query` meaningfully.
- **No communication style** — All agents produce the same format of response. An architect should produce structured design decisions. A team lead should produce task breakdowns. A developer should produce implementation results. Without style guidance, responses are unpredictable.
- **Hardcoded constant** — The prompt is a code constant in the handler, not injectable. Testing handler behavior with different prompts requires modifying source code. Swapping prompts for future features (like `quorum.md` augmentation) would require handler changes rather than configuration changes.

The placeholder was intentional (QRM1-008 established the pattern), but every downstream ticket assumes agents actually *behave* like their roles. QRM1-010 (Terminal Moderator) needs a moderator prompt. QRM1-012 (End-to-End Smoke Test) needs agents that produce role-appropriate responses to verify the system works. Without role prompts, neither ticket can validate meaningful multi-agent behavior.

## Design Context

### Collaboration-Focused, Not Task-Focused

The roadmap scope exclusions are explicit: "Business logic in agent prompts" is out of scope for QRM1. These prompts don't instruct an architect how to design REST APIs or a developer how to write TypeScript. They instruct agents on *how to collaborate within Quorum*:

- When to invoke another agent vs. handle something directly
- What to store in context and at which scope (project vs. conversation)
- What to query before starting work
- How to structure responses for the caller
- What constraints apply (depth limits, context size)

Domain-specific instructions come later, via the `quorum.md` workspace configuration file described in `docs/system-design.md`. That mechanism is out of scope for QRM1 (no filesystem access). The prompts here establish the collaboration foundation that `quorum.md` augments per-project.

### Prompt Template Structure

Every role prompt follows a consistent structure so that prompt behavior is predictable and comparable across roles:

1. **Identity** — Who the agent is and its position in the team
2. **Responsibilities** — What this role is responsible for, and equally important, what it is *not* responsible for (scope boundaries prevent agents from overstepping)
3. **Collaboration guidelines** — When and how to invoke other agents via `invoke_agent`, including which roles to consult for what kinds of questions
4. **Context management** — When to use `context_store` (recording decisions), `context_query` (pulling information), and at which scope. Each role has different context patterns: the architect stores project-wide decisions, the developer queries them before implementing
5. **Communication style** — Response format expectations. Structured decisions from the architect, task lists from the team lead, implementation results from the developer
6. **Constraints** — Behavioral boundaries: don't bypass the collaboration model, don't make decisions outside your role's authority, keep responses concise

The structure is consistent but the *content* differs substantially per role — that's the whole point of role specialization.

### Dynamic Substitution

Templates contain `{{caller}}` as a placeholder, substituted at invocation time with the requesting agent's role. The agent's own role is implicit — baked into the template itself, not substituted.

Using `{{double braces}}` avoids ambiguity with JSON, template literals, and other single-brace patterns that commonly appear in prompt text.

### Why `libs/common/` for Templates

The prompt template content (the `Record<AgentRole, string>` map) belongs in `libs/common/src/prompts/` rather than in the agent app because:

- **QRM1-010 needs the moderator prompt.** The terminal app runs the moderator, not the agent app. If templates live in the agent app, the terminal would need to duplicate the moderator prompt or create a cross-app import dependency.
- **Consistency with existing patterns.** `AgentRole`, `InvokeRequest`/`InvokeResponse`, and config factories already live in `libs/common/` because they're shared types. Prompt templates are shared data of the same kind — they define how each role behaves regardless of which app runs it.
- **The service stays per-app.** Only the template *strings* are shared. The `RolePromptService` (which resolves the template for the current agent's role and substitutes dynamic values) lives in the agent app. The terminal app will have its own prompt handling in QRM1-010 — it doesn't need the same service since the moderator's prompt integration is different (it talks to a user, not to other agents via invocations).

### Generic Fallback

QRM1 defines templates for four roles: moderator, architect, teamlead, developer. The `AgentRole` enum includes two more: qa and productowner (deferred to QRM2 per the roadmap). If someone deploys an agent with `AGENT_ROLE=qa` in QRM1, the system should work — the agent just gets a generic prompt similar to the current placeholder rather than crashing or returning undefined.

The fallback is the safety net. Role-specific prompts are the product.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Prompt templates for moderator, architect, teamlead, developer | `quorum.md` workspace augmentation (no filesystem access in QRM1) |
| `RolePromptService` in agent app | Moderator prompt integration in terminal app (QRM1-010) |
| `{{caller}}` dynamic substitution | Per-invocation context injection into prompt (deferred) |
| Generic fallback for roles without specific templates | Prompt hot-reloading or runtime changes |
| Prompt templates in `libs/common/` for cross-app access | Prompt versioning or A/B testing |
| Unit tests for service and updated handler tests | End-to-end prompt quality validation |

## Implementation Details

### 1. Prompt Templates — `libs/common/src/prompts/role-prompt-templates.ts`

A `ROLE_PROMPT_TEMPLATES` map: `Partial<Record<AgentRole, string>>` — keyed by `AgentRole` values, containing the template string for each role. A `GENERIC_PROMPT_TEMPLATE` constant provides the fallback for roles without specific templates.

A pure function `getRolePromptTemplate(role: AgentRole): string` returns the specific template if one exists, or the generic fallback otherwise. This is the only public API — consumers don't access the map directly.

The generic fallback is essentially the current placeholder but slightly expanded — it identifies the role, acknowledges the caller, and instructs the agent to use available tools. It's deliberately minimal: just enough to function, not enough to be role-specific.

Each role-specific template follows the structure described in Design Context. Key differentiation per role:

**Architect** — Focuses on design-level thinking. Stores architectural decisions in project scope. Consults product owner for requirements. Responds with structured decisions (what was decided and why). Does not implement — delegates to developer via the team lead or moderator.

**Team Lead** — Focuses on task decomposition and coordination. Breaks work into concrete, actionable tasks. Stores task breakdowns in conversation scope. Consults architect for design guidance when decomposing. Responds with structured task lists. Monitors but does not implement.

**Developer** — Focuses on implementation. Queries project and conversation context before starting (pull, don't guess). Stores implementation decisions in conversation scope. Consults architect for design clarification when the existing context is insufficient. Responds with implementation results and any decisions made.

**Moderator** — Focuses on orchestration and user communication. Decides which agents to invoke. Manages the overall flow. Stores session-level context in project scope. Responds in user-friendly language (it's the user-facing agent). Defined here but used by the terminal app in QRM1-010.

All four templates share common guidance:

- Explain the `invoke_agent` tool and when to use synchronous vs. asynchronous invocation
- Explain `context_query` and `context_store` with scope guidance (project for durable decisions, conversation for task-specific state)
- Note that `correlationId` is auto-injected — agents don't need to track it
- Emphasize concise responses — the caller is an LLM too, long prose wastes tokens
- Note the call depth limit — don't create unnecessary delegation chains

### 2. Prompt Barrel Export — `libs/common/src/prompts/index.ts`

Export `getRolePromptTemplate` and `GENERIC_PROMPT_TEMPLATE`. The `ROLE_PROMPT_TEMPLATES` map is not exported — consumers use the getter function, which handles the fallback logic.

Update `libs/common/src/index.ts` to re-export from `prompts/`.

### 3. RolePromptService — `apps/agent/src/prompts/role-prompt.service.ts`

Injectable service with a single responsibility: produce the hydrated system prompt string for the current agent's role.

Constructor injects `AgentConfigService` to access `config.agent.role`.

**`getSystemPrompt(caller: string): string`** — calls `getRolePromptTemplate(this.config.agent.role)`, then substitutes `{{caller}}` with the caller value. Returns the final prompt string ready for `AnthropicService.chat({ system: ... })`.

The service is deliberately thin — it resolves the template and performs substitution. It doesn't cache (template resolution is a map lookup, substitution is a string replace — both are trivial). It doesn't modify the template content. Future augmentation (e.g., appending `quorum.md` instructions) would add a method or extend this service, not change the existing one.

### 4. PromptsModule — `apps/agent/src/prompts/prompts.module.ts`

```
PromptsModule
  imports: [AgentConfigModule]
  providers: [RolePromptService]
  exports: [RolePromptService]
```

`AgentConfigModule` is already global, so the import is technically unnecessary but makes the dependency graph explicit — same convention as `LlmModule`.

### 5. InvocationHandler Modification — `apps/agent/src/connection/invocation-handler.service.ts`

Three changes:

1. **Remove** the `SYSTEM_PROMPT_TEMPLATE` constant (lines 11–13).
2. **Inject** `RolePromptService` in the constructor (alongside existing `AgentConfigService`, `AnthropicService`, `McpClientService`).
3. **Replace** the prompt-building logic in `processWithLoop()`:

   Before:
   ```typescript
   const system = SYSTEM_PROMPT_TEMPLATE.replace('{role}', this.config.agent.role)
     .replace('{caller}', request.caller);
   ```

   After:
   ```typescript
   const system = this.promptService.getSystemPrompt(request.caller);
   ```

No other handler logic changes. The agentic loop, tool execution, augmentation, and error handling remain exactly as QRM1-008 left them.

### 6. ConnectionModule Update — `apps/agent/src/connection/connection.module.ts`

Add `PromptsModule` to imports so `InvocationHandler` can inject `RolePromptService`. Follows the same pattern as `LlmModule` being imported for `AnthropicService`.

### 7. File Structure

```
libs/common/src/
  prompts/
    role-prompt-templates.ts         # Template map + getter function
    role-prompt-templates.spec.ts    # Template existence, fallback, substitution placeholder tests
    index.ts                         # Barrel export
  index.ts                           # Modified — re-export from prompts/

apps/agent/src/
  prompts/
    role-prompt.service.ts           # Injectable — resolves template, substitutes caller
    role-prompt.service.spec.ts      # Service tests: per-role resolution, caller substitution, fallback
    prompts.module.ts                # NestJS module
    index.ts                         # Barrel export
  connection/
    invocation-handler.service.ts    # Modified — inject RolePromptService, remove constant
    invocation-handler.service.spec.ts  # Modified — mock RolePromptService, update prompt assertions
    connection.module.ts             # Modified — import PromptsModule
```

### 8. Testing Strategy

**Prompt template tests** (`role-prompt-templates.spec.ts`):
- `getRolePromptTemplate()` returns a specific template for each defined role (architect, teamlead, developer, moderator)
- All specific templates contain the `{{caller}}` placeholder
- `getRolePromptTemplate()` returns the generic fallback for roles without specific templates (qa, productowner)
- Generic fallback also contains `{{caller}}` placeholder
- All templates are non-empty strings

**RolePromptService tests** (`role-prompt.service.spec.ts`):
- `getSystemPrompt('moderator')` returns a prompt containing the caller name ('moderator')
- `getSystemPrompt()` returns a prompt specific to the configured agent role (verify it's not the generic fallback for defined roles)
- `getSystemPrompt()` substitutes `{{caller}}` — the returned string does not contain the literal `{{caller}}`
- Service works with a role that has no specific template (falls back gracefully)
- Mock `AgentConfigService` with different roles to test resolution

**InvocationHandler tests** (`invocation-handler.service.spec.ts` — modifications):
- Replace the existing "should build system prompt with role and caller" test — instead verify that `RolePromptService.getSystemPrompt()` is called with `request.caller`
- Verify the system prompt from `RolePromptService` is passed to `AnthropicService.chat()`
- All existing tests continue to pass with `RolePromptService` mocked

**PromptsModule tests** — not needed. Module wiring is validated by the handler tests and build. Same pattern as `LlmModule` which has no dedicated module test.

## Acceptance Criteria

- [ ] Prompt templates defined for moderator, architect, teamlead, developer roles
- [ ] Each template covers: identity, responsibilities, collaboration guidelines, context management, communication style, constraints
- [ ] Templates use `{{caller}}` placeholder for dynamic caller substitution
- [ ] Generic fallback template for roles without specific templates (qa, productowner)
- [ ] `getRolePromptTemplate(role)` in `libs/common/src/prompts/` returns the correct template or fallback
- [ ] `RolePromptService` injectable in agent app — resolves template by `config.agent.role`
- [ ] `RolePromptService.getSystemPrompt(caller)` returns hydrated prompt with `{{caller}}` substituted
- [ ] `PromptsModule` provides `RolePromptService`, imported by `ConnectionModule`
- [ ] `InvocationHandler` uses `RolePromptService` instead of `SYSTEM_PROMPT_TEMPLATE` constant
- [ ] `SYSTEM_PROMPT_TEMPLATE` constant removed from handler
- [ ] Prompts are collaboration-focused — no business logic, no domain-specific instructions
- [ ] All prompts reference MCP tool usage (invoke_agent, context_store, context_query) with role-appropriate guidance
- [ ] Prompts emphasize pull-based context model (query before assuming, store decisions for others)
- [ ] `libs/common/src/index.ts` re-exports from `prompts/`
- [ ] Unit tests: template existence and fallback, service resolution and substitution, handler integration
- [ ] Existing tests unaffected (mock RolePromptService in handler tests)
- [ ] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-004 — `AgentRole` enum, `InvokeRequest`/`InvokeResponse` types
- QRM1-008 — `InvocationHandler` with agentic loop, `AnthropicService.chat({ system })`, placeholder prompt to replace

### What This Blocks
- QRM1-010 — Terminal Moderator Bootstrap (uses the moderator prompt template from `libs/common/`)
- QRM1-012 — End-to-End Smoke Test (needs role-differentiated agents to validate meaningful multi-agent behavior)

### References
- [docs/system-design.md](../docs/system-design.md) — `quorum.md` configuration concept, agent roles, pull-based context model
- [docs/agent-messaging.md](../docs/agent-messaging.md) — `invoke_agent` tool, communication patterns (sync/async)
- [docs/context-management.md](../docs/context-management.md) — Context scopes (project/conversation/agent), MCP tools API
- [docs/message-broker.md](../docs/message-broker.md) — Safeguards (depth limit, circular call prevention, timeouts)
- QRM1-008 Implementation Notes — Current `SYSTEM_PROMPT_TEMPLATE`, handler structure, `AnthropicService.chat()` interface