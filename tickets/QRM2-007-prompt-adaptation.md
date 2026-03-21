# QRM2-007: Prompt Adaptation

## Summary

Update all role prompt templates to reflect the Claude Code-powered agent runtime. Agents now have filesystem tools (read, write, edit, search), bash execution, and git operations against a shared workspace — the prompts must describe these capabilities, workspace conventions, permission boundaries, and the autonomous clarification pattern. This is the final behavioral alignment step before E2E integration: the runtime (QRM2-006) gives agents power, and the prompts tell them how to use it.

## Problem Statement

The current prompts in `libs/common/src/prompts/role-prompt-templates.ts` and `apps/terminal/src/chat/chat.service.ts` were written for QRM1's "brains in jars" architecture — agents that could only reason and call MCP tools. After QRM2-002 through QRM2-006, agents are Claude Code instances with real tool capabilities, but the prompts don't reflect this:

- **No awareness of filesystem tools.** The prompts say "you do NOT implement code" (architect) or "write code" (developer) without acknowledging that agents now have `FileRead`, `FileWrite`, `FileEdit`, `Glob`, `Grep`, `Bash`, and other Claude Code built-in tools. The developer prompt says "write tests" but doesn't describe how (bash commands, file creation in the workspace).
- **No workspace conventions.** Agents operate on `/mnt/quorum/workspace` — a shared volume mounted from the host project. The prompts don't mention the workspace path, `quorum.md` configuration file, or the convention of keeping tickets in `tickets/` and documentation in `docs/`.
- **No permission boundary awareness.** QRM2-005 defined per-role permission profiles — the architect can only write to `docs/` and `tickets/`, the product owner can only write to `tickets/`, certain bash commands are denied per role. Prompts must describe what each role *can* and *cannot* do so the LLM doesn't waste turns attempting denied actions.
- **`AskUserQuestion` is disabled but not communicated.** QRM2-005 mechanically blocks `AskUserQuestion` via `disallowedTools`, but the prompts don't tell agents about the autonomous clarification pattern. Without prompt guidance, the LLM may attempt interactive user questions (which fail silently) or halt when it "should" ask the user, instead of routing through `invoke_agent`.
- **No clarification routing guidance.** QRM2-004 established that agents escalate to the moderator (or other agents) via `invoke_agent` when they need decisions. The prompts need to encode the routing table: architect for design questions, teamlead for scope/priority, productowner for requirements, moderator for user-facing clarification.
- **Assumption bias not encoded.** The roadmap notes that prompts should "bias agents toward reasonable assumptions over excessive cross-agent chatter to conserve depth budget and tokens." Current prompts encourage querying context and consulting agents freely — they need guardrails against over-escalation.

## Design Context

### What Changes

Two files contain prompt content:

| File | Content | Consumers |
|------|---------|-----------|
| `libs/common/src/prompts/role-prompt-templates.ts` | `SYSTEM_PREAMBLE` + per-role templates for all 6 roles | Agent app via `RolePromptService` |
| `apps/terminal/src/chat/chat.service.ts` | `TERMINAL_MODERATOR_PROMPT` (inline) | Terminal `ChatService` |

The terminal moderator prompt duplicates the `SYSTEM_PREAMBLE` and moderator template inline with terminal-specific adjustments. Both must be updated consistently.

### Prompt Architecture (Unchanged)

The layering stays the same:

```
SYSTEM_PREAMBLE          ← universal context: team, communication, context model, capabilities
  ─────────────
Role-Specific Template   ← identity, responsibilities, collaboration, constraints
  ─────────────
Dynamic Substitution     ← {{caller}} replaced at invocation time
```

`getRolePromptTemplate(role)` prepends the preamble to the role template. `RolePromptService.getSystemPrompt(caller)` hydrates `{{caller}}`. No structural changes to this pipeline.

### Preamble Updates

The `SYSTEM_PREAMBLE` gains three new sections:

**1. Capabilities** — Describes that agents run as Claude Code instances with built-in tools: file reading/writing/editing, glob/grep search, bash execution, and git operations. Emphasizes that these tools operate against a shared workspace, not a hypothetical environment.

**2. Workspace** — Describes the shared workspace at `/mnt/quorum/workspace`: the target project directory, `quorum.md` configuration file, `docs/` for documentation, `tickets/` for task tracking. Agents should read `quorum.md` early in any task to understand project-specific conventions.

**3. Autonomous Clarification** — Explains that `AskUserQuestion` is disabled and agents must never attempt direct user interaction. Defines the routing table for clarification:
- **architect** — design/pattern questions
- **teamlead** — task scope/priority questions
- **productowner** — business requirements/acceptance criteria
- **moderator** — user-facing decisions and blocker escalation (routed to the actual user via QRM2-004's clarification handler)

Includes the assumption bias: prefer reasonable assumptions over excessive `invoke_agent` calls, noting that every invocation costs depth budget and tokens.

### Per-Role Template Updates

Each role template gains a **Capabilities** section describing what tools are available and any restrictions. The existing sections (Identity, Responsibilities, Collaboration, Context Management, Communication Style, Constraints) are updated to reference concrete tool usage rather than abstract descriptions.

| Role | Key Capability Changes |
|------|----------------------|
| **developer** | Full filesystem + bash access. Can read, write, edit any file. Can run builds, tests, linting. Can use git (no force-push). Should query context and read `quorum.md` before coding. |
| **architect** | Full read access + analysis tools (grep, glob, bash for read commands). Write restricted to `docs/` and `tickets/`. Cannot git commit/push. Stores decisions in Context Store AND documents in `docs/`. |
| **teamlead** | Full filesystem + bash access. Creates tickets in `tickets/`. Can commit (no force-push). Monitors builds/tests. Reviews integration across tasks. |
| **qa** | Full filesystem + bash access. Writes test files. Runs test suites. Cannot git push/commit. Reports results to Context Store. |
| **productowner** | Read access only + write to `tickets/`. No bash. Authors user stories and requirements in `tickets/`. Provides business context via Context Store. |
| **moderator** (terminal) | No filesystem tools (runs on raw Anthropic SDK). Orchestrates via MCP tools only. Updated to describe the clarification flow from QRM2-004. |

### Terminal Moderator Prompt

The `TERMINAL_MODERATOR_PROMPT` in `chat.service.ts` is updated separately because the terminal moderator:
- Runs on the raw Anthropic SDK, not Claude Code
- Has no filesystem tools — only MCP tools (`invoke_agent`, `context_*`)
- Is the recipient of clarification requests from agents (QRM2-004)
- Needs to know that agents can now do real work (read/write/test code)

The terminal prompt doesn't use the `SYSTEM_PREAMBLE` directly (it has its own copy with terminal-specific wording). Both must be updated, but the terminal version omits the Capabilities and Workspace sections that describe Claude Code tools.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Update `SYSTEM_PREAMBLE` with capabilities, workspace, clarification sections | Structural changes to `getRolePromptTemplate()` or `RolePromptService` |
| Update all 6 role-specific templates | Adding new roles (qa, productowner deployment) |
| Update `TERMINAL_MODERATOR_PROMPT` in `chat.service.ts` | Terminal moderator migration to Claude Code SDK (QRM2-008) |
| Update `GENERIC_PROMPT_TEMPLATE` fallback | Changes to permission profiles (QRM2-005) |
| Rewrite prompt tests for updated content | E2E testing (QRM2-009) |

## Implementation Details

### SYSTEM_PREAMBLE Rewrite

Location: `libs/common/src/prompts/role-prompt-templates.ts`

The preamble retains its existing sections (The Team, Communication, Shared Context) and gains three new ones. The overall length will increase — but this is the foundation prompt for every agent session, and the added context is essential for correct behavior. Keep each section concise; use structured lists over prose.

**New section: Capabilities**

Describes Claude Code built-in tools available to all agents (subject to per-role restrictions noted in role templates):
- File operations: `FileRead`, `FileWrite`, `FileEdit` — read, create, modify files in the workspace
- Search: `Glob` (file pattern matching), `Grep` (content search) — navigate unfamiliar codebases
- `Bash` — run shell commands: build, test, lint, git, analysis tools
- These are real tools operating on real files — changes persist and are visible to all agents

**New section: Workspace**

- Shared workspace at `/mnt/quorum/workspace` — the target project directory
- All agents see the same files; changes by one agent are immediately visible to others
- `quorum.md` at the workspace root defines project-specific conventions, feature scope, and role-specific instructions — read it at the start of any task
- `docs/` contains system documentation; `tickets/` contains task definitions
- Git repository — agents can read history, diffs, and branches

**New section: Autonomous Operation**

- You operate autonomously — there is no interactive user in your session
- `AskUserQuestion` is disabled; never attempt to ask the user directly
- If you need a decision you cannot make yourself, use `invoke_agent` to reach the right team member:
  - **architect** — design patterns, technology choices, architectural constraints
  - **teamlead** — task scope, priority, acceptance criteria clarification
  - **productowner** — business requirements, user stories, feature priorities
  - **moderator** — user-facing decisions, blocker escalation (the moderator surfaces your question to the actual user)
- **Prefer reasonable assumptions over escalation.** Every `invoke_agent` call costs depth budget and tokens. If the answer is likely obvious or non-controversial, make a reasonable choice, document it in the Context Store, and move on. Escalate only when the decision materially affects the outcome and you genuinely cannot infer the right choice from context.

**Updated section: Communication**

Add a note that MCP orchestration tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) are available alongside Claude Code built-in tools. The MCP tools are for inter-agent communication and shared context; the built-in tools are for working with the codebase.

### Per-Role Template Updates

Each role template below shows the **new or changed sections** relative to the existing template. Unchanged sections (Identity core wording, Communication Style) receive minor polish but no structural changes.

#### Developer

**New: Capabilities section**
- Full filesystem access — read, write, edit any file in the workspace
- Full bash access — run builds (`npm run build`), tests (`npm run test`), linting (`npm run lint`), and other commands
- Git operations — read history, create branches, commit changes. Denied: `git push --force`, `git push -f`, `rm -rf /`
- Search tools — use `Glob` and `Grep` to navigate the codebase before making changes

**Updated: Responsibilities**
- Add: Read `quorum.md` and query context before starting any task
- Add: Run tests after implementation; verify build and lint pass
- Add: Store implementation decisions in conversation context so reviewers can understand the approach

**Updated: Constraints**
- Add: Do not force-push or run destructive commands
- Add: Read existing code before modifying — use `Grep`/`Glob` to understand patterns, then match them

#### Architect

**New: Capabilities section**
- Full read access — can read any file, use `Glob`/`Grep` to analyze codebase patterns
- Bash for analysis — can run read-only commands (grep, find, tree, `npm run test`, `npm run lint`) but denied: `git push`, `git commit`, `git checkout -b`, `rm -rf`, `npm publish`
- Write access limited to `docs/` and `tickets/` — can create and update architecture documentation and design review tickets
- Cannot modify source code directly — design decisions are communicated through Context Store and documentation

**Updated: Responsibilities**
- Add: Read the codebase to ground design decisions in actual code structure
- Add: Document architectural decisions in `docs/` files in addition to storing them in the Context Store
- Add: When reviewing, read the actual implementation files — don't review based on descriptions alone

**Updated: Constraints**
- Add: Write operations are restricted to `docs/` and `tickets/` — attempting to write elsewhere will be denied
- Add: Cannot commit or push — document decisions, don't implement them

#### Team Lead

**New: Capabilities section**
- Full filesystem access — read, write, edit any file
- Full bash access — run builds, tests, monitor integration. Denied: `git push --force`, `git push -f`, `rm -rf /`, `npm publish`
- Git operations — can commit (for ticket files and integration fixes). Cannot force-push
- Creates and manages tickets in `tickets/` directory

**Updated: Responsibilities**
- Add: Create ticket files in `tickets/` following the naming convention in `tickets/README.md`
- Add: Read existing tickets to understand current task state before decomposing new work
- Add: Run builds/tests to verify integration status when monitoring

#### QA

**New: Capabilities section**
- Full filesystem access — read source code, write test files
- Full bash access — run test suites, generate coverage reports, check builds. Denied: `git push`, `git commit`, `rm -rf`, `npm publish`
- Cannot commit or push — test results are reported via Context Store and stdout

**Updated: Responsibilities** (new template — QA currently uses the generic fallback)
- Execute test suites and report results
- Write new test files when test coverage gaps are identified
- Verify build integrity: `npm run build`, `npm run lint`, `npm run test`
- Report test results, failures, and coverage to the Context Store
- Query context for implementation details before writing tests

**Updated: Constraints**
- Do not modify source code (except test files) — report failures, don't fix them
- Do not commit or push — results go to the Context Store for the developer or team lead to act on

#### Product Owner

**New: Capabilities section**
- Read access — can read any file to understand current codebase state
- Write access limited to `tickets/` — can author user stories, requirements documents, and acceptance criteria
- No bash access — no command execution
- Cannot modify source code or documentation — provides context through tickets and the Context Store

**Updated: Responsibilities** (new template — Product Owner currently uses the generic fallback)
- Provide business requirements and acceptance criteria when consulted
- Author user stories and requirements documents in `tickets/`
- Query context before responding — check what has been decided to maintain consistency
- Store business decisions in project scope for all agents to access

**Updated: Constraints**
- Cannot run commands, modify source code, or edit documentation
- Write operations limited to `tickets/` — attempting to write elsewhere will be denied
- Focus on requirements and business context — do not make technical decisions

#### Moderator (in role-prompt-templates.ts)

**Updated: Collaboration**
- Note that agents are now code-capable — they can read, write, test code directly
- The moderator's role is orchestration, not implementation relay
- When agents escalate via `invoke_agent(moderator, ...)`, surface the question to the user (QRM2-004 clarification flow)

**Updated: Constraints**
- Add: When an agent invokes you for clarification, you surface the question to the user — you don't answer on the user's behalf unless you're confident about the answer from prior context

#### Terminal Moderator (in chat.service.ts)

**Updated: `TERMINAL_MODERATOR_PROMPT`**
- Add awareness that agents are now Claude Code instances with real capabilities
- Add note about the clarification flow — agents may invoke you to reach the user
- Describe what agents can do (so the moderator gives appropriate instructions)
- No Capabilities/Workspace sections (terminal doesn't have CC tools)

### GENERIC_PROMPT_TEMPLATE Update

The fallback for roles without specific templates gets a capabilities awareness line:

```
You have access to Claude Code built-in tools for working with the codebase
(file operations, search, bash) and MCP tools for inter-agent communication.
Check your role's permission restrictions — some tools may be unavailable.
Read quorum.md and query context before starting work.
```

### Test Updates

Location: `libs/common/src/prompts/role-prompt-templates.spec.ts`

The existing tests verify prompt structure (preamble present, `{{caller}}` placeholder, role-specific content). Update content assertions for the new sections:

- Verify `SYSTEM_PREAMBLE` contains "Capabilities", "Workspace", "Autonomous Operation" sections
- Verify each role template mentions its tool restrictions (e.g., architect template contains "docs/" and "tickets/")
- Verify `AskUserQuestion` is mentioned in the preamble (disabled, don't attempt)
- Verify `quorum.md` is mentioned in the preamble
- Verify clarification routing mentions all four targets (architect, teamlead, productowner, moderator)
- Add tests for new QA and Product Owner templates (they move from generic fallback to specific templates)

### File Structure

```
libs/common/src/prompts/
  role-prompt-templates.ts           # MODIFIED — SYSTEM_PREAMBLE + all role templates rewritten
  role-prompt-templates.spec.ts      # MODIFIED — updated content assertions

apps/terminal/src/chat/
  chat.service.ts                    # MODIFIED — TERMINAL_MODERATOR_PROMPT updated
```

## Acceptance Criteria

- [x] `SYSTEM_PREAMBLE` includes a Capabilities section describing Claude Code built-in tools (file ops, search, bash)
- [x] `SYSTEM_PREAMBLE` includes a Workspace section describing `/mnt/quorum/workspace`, `quorum.md`, `docs/`, `tickets/`
- [x] `SYSTEM_PREAMBLE` includes an Autonomous Operation section with clarification routing table (architect, teamlead, productowner, moderator)
- [x] `SYSTEM_PREAMBLE` explicitly states `AskUserQuestion` is disabled and must not be attempted
- [x] `SYSTEM_PREAMBLE` encodes assumption bias: prefer reasonable assumptions over excessive `invoke_agent` escalation
- [x] Developer template describes full filesystem/bash access and git restrictions (`git push --force`, `rm -rf /` denied)
- [x] Architect template describes read-all + write-to-`docs/`-and-`tickets/`-only + bash analysis commands + no git commit/push
- [x] Team Lead template describes full filesystem + bash + commit (no force-push) + ticket creation in `tickets/`
- [x] QA role gets a dedicated template (replaces generic fallback) with test execution focus, file write for tests, no git push/commit
- [x] Product Owner role gets a dedicated template (replaces generic fallback) with read-all + write-to-`tickets/`-only, no bash
- [x] Moderator template (in `role-prompt-templates.ts`) updated for agent code-capability awareness and clarification flow
- [x] `TERMINAL_MODERATOR_PROMPT` (in `chat.service.ts`) updated consistently with agent capability awareness
- [x] `GENERIC_PROMPT_TEMPLATE` updated with capability awareness
- [x] All templates reference `quorum.md` as the starting point for project-specific context
- [x] All per-role Capabilities sections accurately match the permission profiles defined in QRM2-005's `ROLE_TOOL_PROFILES`
- [x] Prompt tests updated to verify new section presence and role-specific content
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` passes (all existing + updated tests)

## Dependencies and References

### Prerequisites
- **QRM2-004** — Moderator Invocation Endpoint (clarification flow that prompts describe)
- **QRM2-006** — InvocationHandler Migration (agents now use `ClaudeCodeService.execute()` — prompts must match the runtime)
- **QRM2-005** — Role Permission Profiles (prompts must accurately describe per-role tool restrictions)

### What This Blocks
- **QRM2-009** — E2E Integration Smoke Test (needs prompts that correctly instruct agents on workspace usage and collaboration)

### References
- Current prompt templates: `libs/common/src/prompts/role-prompt-templates.ts`
- Terminal moderator prompt: `apps/terminal/src/chat/chat.service.ts:16-54`
- Role permission profiles: `apps/agent/src/config/role-tool-profiles.ts`
- Permission service: `apps/agent/src/config/role-permission.service.ts`
- Prompt service: `apps/agent/src/prompts/role-prompt.service.ts`
- Workspace conventions: `docs/system-design.md:136-179`
- Clarification handler: `apps/terminal/src/clarification/clarification.service.ts`
- QRM2-000 roadmap prompt notes: `tickets/QRM2-000-roadmap.md:64-68`
- Ticket conventions: `tickets/README.md`

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-10

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/prompts/role-prompt-templates.ts` | Modified | Rewrote `SYSTEM_PREAMBLE` (added Capabilities, Workspace, Autonomous Operation sections), updated Communication section, added dedicated templates for QA and Product Owner (replacing generic fallback), added Capabilities sections to all 6 role templates, updated Responsibilities/Constraints sections with tool-aware guidance, updated `GENERIC_PROMPT_TEMPLATE` with capability awareness |
| `libs/common/src/prompts/role-prompt-templates.spec.ts` | Modified | Expanded from ~20 to 53 tests: added preamble tests for new sections (Capabilities, Workspace, Autonomous Operation, AskUserQuestion, assumption bias, quorum.md), added dedicated describe blocks for each role (developer, architect, teamlead, qa, productowner, moderator), replaced generic-fallback-for-qa/po tests with dedicated template assertions, added generic fallback tests for capability awareness |
| `apps/terminal/src/chat/chat.service.ts` | Modified | Updated `TERMINAL_MODERATOR_PROMPT` with Agent Capabilities Awareness section (agents are Claude Code instances with file/bash/search tools), Clarification Flow section (agents invoke moderator for user-facing decisions), and `quorum.md` reference |

### Deviations from Ticket Spec

- **Terminal moderator wording unified with role template moderator.** The ticket spec didn't prescribe exact wording for the terminal prompt's capability description. Initial implementation used "read, write, and edit files" while the role template moderator used "read, write, and test code." Post-review consolidation aligned both to "read, write, and test code" for consistency.

- **Denied command `rm -rf` normalized to `rm -rf /` across all roles.** The ticket spec listed `rm -rf` (without `/`) for architect and QA denied commands, while developer and teamlead used `rm -rf /`. Post-review consolidation normalized all four roles to `rm -rf /` for consistency. The actual enforcement is in QRM2-005's permission profiles; the prompt wording is advisory guidance.

- **Terminal moderator gained `quorum.md` reference.** The ticket spec's terminal moderator section (line 232-237) didn't explicitly mention `quorum.md`, but the AC "All templates reference `quorum.md`" applied broadly. Added a line telling the moderator that agents read `quorum.md` and to keep it current.

### Test Coverage

| File | Tests | Covers |
|------|-------|--------|
| `role-prompt-templates.spec.ts` — `SYSTEM_PREAMBLE` | 10 | Team roles present, Capabilities section (tool names), Workspace section (path, quorum.md, docs/, tickets/), Autonomous Operation (routing targets), AskUserQuestion disabled, assumption bias + depth budget, quorum.md as starting point |
| `role-prompt-templates.spec.ts` — specific templates | 6 | All 6 roles have templates, `{{caller}}` placeholder present in each |
| `role-prompt-templates.spec.ts` — developer | 2 | Full filesystem/bash access, git push --force/rm -rf denied |
| `role-prompt-templates.spec.ts` — architect | 3 | Read-all + write docs/tickets, bash analysis + denied commands, cannot commit/push |
| `role-prompt-templates.spec.ts` — teamlead | 2 | Full filesystem/bash + commit, ticket creation in tickets/ |
| `role-prompt-templates.spec.ts` — qa | 3 | Dedicated template (not fallback), test execution commands, write test files + no git |
| `role-prompt-templates.spec.ts` — productowner | 3 | Dedicated template (not fallback), read-all + write tickets, no bash |
| `role-prompt-templates.spec.ts` — moderator | 2 | Agent code-capability awareness, clarification flow |
| `role-prompt-templates.spec.ts` — generic fallback | 4 | `{{caller}}` placeholder, Claude Code tools + permissions, quorum.md, non-empty |
| `role-prompt-templates.spec.ts` — all templates | 6 | Non-empty string for each role |

### Verification

```
npm run build   → 4 apps compiled successfully
npm run lint    → 0 errors, 0 warnings
npm run test    → 407/407 passed (36 suites), 53 in role-prompt-templates.spec.ts
```