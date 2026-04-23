# QRM6-007: Moderator CLAUDE.md

## Summary

Port the moderator prompt from `TERMINAL_MODERATOR_PROMPT` in `apps/terminal/src/chat/chat.service.ts:206` to `CLAUDE.md` at the workspace root, updated for the CC CLI + elicitation architecture. This is the user-facing moderator's system prompt — CC CLI auto-loads it when the user attaches to the moderator container. After this ticket, the moderator operates from `CLAUDE.md` + `--append-system-prompt` instead of the inline terminal prompt.

Two architect-flagged concerns from the mid-milestone design review are addressed in this ticket:
1. The prompt includes explicit guidance for elicitation decline/cancel UX discoverability (weak discoverability found in QRM6-001 spike).
2. A strong, early instruction requires the LLM to call `new_conversation` at the start of each user turn before any other tool call.

## Problem Statement

The moderator's prompt today lives inline in `apps/terminal/src/chat/chat.service.ts:206` as `TERMINAL_MODERATOR_PROMPT` — a 90-line template string concatenated with `SYSTEM_PREAMBLE` and runtime-appended `quorum.md` content. This creates three problems:

1. **Terminal coupling.** The prompt is embedded in the terminal app, which QRM6-009 will delete. Before deletion, the prompt content must live elsewhere.
2. **Runtime concatenation.** `initSystemPrompt()` (line 331) reads `quorum.md` and appends it at startup. CC CLI handles this natively — `CLAUDE.md` auto-loads, and `@quorum.md` import syntax merges project conventions.
3. **Missing CC CLI-specific guidance.** The terminal prompt assumes a raw Anthropic SDK runtime (no tool restrictions, no session management, no `new_conversation` tool). The CC CLI moderator needs guidance for:
   - Calling `new_conversation` at the start of each user turn
   - Understanding elicitation (agents ask questions that appear inline)
   - Handling elicitation decline/cancel scenarios
   - Server-side session tracking (simplified session resume)
   - CC CLI tool restrictions (Write/Edit/NotebookEdit denied)

**What changes:**
- `CLAUDE.md` at the workspace root is rewritten to serve as the moderator's prompt. It imports `@quorum.md` for project conventions and contains the full moderator role definition.
- `docker/moderator/settings.json` gains an `appendSystemPrompt` field for moderator-specific enforcement rules that should not be user-editable.
- The `TERMINAL_MODERATOR_PROMPT` in `chat.service.ts` becomes dead code — it is NOT deleted in this ticket (that's QRM6-009), but this ticket is its functional replacement.

**What stays the same:**
- `quorum.md` — unchanged; imported via `@quorum.md` in the new CLAUDE.md.
- `ROLE_PROMPT_TEMPLATES[AgentRole.moderator]` — unchanged (agent-facing prompt, updated in QRM6-006).
- `SYSTEM_PREAMBLE` — not directly imported into CLAUDE.md (CLAUDE.md is a standalone prompt), but the conceptual overlap is intentional.
- `getRolePromptTemplate()` — no changes.
- No server-side code changes.

**Risks of deferral:** Without this, the moderator container (QRM6-002) has no prompt — CC CLI loads a stub CLAUDE.md that contains only project documentation, not role guidance. The moderator would operate without identity, skill dispatch rules, failure recovery guidance, or the `new_conversation` instruction. This blocks QRM6-009 (terminal deletion requires the replacement prompt to exist) and degrades the moderator's effectiveness.

## Design Context

This ticket implements **D3 (Moderator Prompt — CLAUDE.md)** from the roadmap.

**D3 summary:** Port `TERMINAL_MODERATOR_PROMPT` to CLAUDE.md. CC CLI auto-loads it. `@quorum.md` imports project conventions. `--append-system-prompt` layers moderator-specific enforcement rules.

**Mid-milestone design review concerns (both MUST be addressed):**

1. **Concern: `new_conversation` prompt reliability is load-bearing.** The architect's review states: "QRM6-007 should include a strong, early instruction: 'You MUST call `new_conversation` at the start of each user turn before any other tool call.'" This instruction must appear early in the prompt — before any tool dispatch guidance — because conversation scoping depends on the LLM reliably calling this tool. The server fallback (auto-generated `randomUUID()` per call) works but degrades conversation context coherence.

2. **Concern: Elicitation decline/cancel UX discoverability.** QRM6-001 found that the decline affordance in CC CLI is "not obviously discoverable on first encounter." The moderator prompt should include guidance on what decline/cancel mean in the elicitation context, so the moderator can communicate clearly to the user when an agent's clarification question is declined or cancelled. Specifically, the Clarification Flow section should explain that the user may decline (skip) or cancel a question, and the moderator should handle the agent's error response gracefully (explaining the agent will proceed without the answer or retry later).

**Existing prompt content to port (from `TERMINAL_MODERATOR_PROMPT`):**

| Section | Lines | Port Action |
|---------|-------|-------------|
| Identity | 210-212 | Keep — update "terminal interface" to "CC CLI" |
| Agent Capabilities Awareness | 215-223 | Keep unchanged |
| Clarification Flow | 225-229 | **Update** — reference elicitation, add decline/cancel handling |
| Responsibilities | 231-236 | Keep unchanged |
| Collaboration | 238-244 | Keep unchanged |
| Skill Dispatch | 246-265 | Keep unchanged |
| Context Management | 267-270 | Keep unchanged |
| Communication Style | 272-276 | Keep — minor wording update for CC CLI context |
| Failure Recovery | 278-282 | Keep unchanged |
| Session Resume | 284-289 | **Simplify** — server tracks sessions (D6) |
| Constraints | 291-293 | Keep unchanged |

**New sections not in the terminal prompt:**

| Section | Content | Rationale |
|---------|---------|-----------|
| Turn Lifecycle (`new_conversation`) | Strong instruction to call `new_conversation` first each turn | D5, architect concern #1 |
| Elicitation Decline/Cancel | How to handle agent questions the user declines or cancels | Architect concern #2 from QRM6-001 findings |
| Tool Restrictions | Write/Edit/NotebookEdit denied; why and how to work around | D7 — moderator knows its own constraints |

**QRM6-005 context:** The `new_conversation` tool exists with description: "Start a new conversation scope. Mints a fresh correlation ID for the current user turn and clears cached agent sessions so subsequent invocations start fresh. Call this at the beginning of each new user turn." The CLAUDE.md prompt reinforces this with a stronger, earlier instruction.

**QRM6-002 context:** `docker/moderator/settings.json` currently contains only permissions and MCP server config. This ticket adds `appendSystemPrompt` for moderator-specific enforcement rules.

## Implementation Details

### 1. CLAUDE.md Structure

Rewrite the existing `CLAUDE.md` at the workspace root. The file serves dual duty: (a) project documentation (build commands, project structure, tech stack) that any CC CLI user benefits from, and (b) the moderator's role prompt.

**Top-level structure:**

```
# CLAUDE.md

@quorum.md                         <-- import project conventions

## Moderator Identity
## Turn Lifecycle (CRITICAL)        <-- new_conversation instruction (early!)
## Agent Capabilities Awareness
## Clarification Flow               <-- updated for elicitation
## Responsibilities
## Collaboration
## Skill Dispatch
## Context Management
## Communication Style
## Failure Recovery
## Session Resume                   <-- simplified
## Tool Restrictions                <-- new
## Constraints

## Project Overview                 <-- preserved from current CLAUDE.md
## Tech Stack
## Project Structure
## Documentation
## Build Commands
## Architecture Concept
```

The `@quorum.md` import at the top pulls in project conventions (tech stack, build commands, coding standards, workflow). This replaces the manual `initSystemPrompt()` read of `quorum.md` in `chat.service.ts:331-334`.

The moderator role content appears first (before project documentation) because CC CLI truncates long CLAUDE.md files — role guidance is higher priority than project structure for the moderator's behavior.

### 2. Turn Lifecycle Section (CRITICAL — Early Placement)

This section MUST appear near the top of the moderator role content — before Skill Dispatch, before Collaboration, before any guidance that involves tool calls. The architect's concern is that this instruction is load-bearing for conversation scoping.

**Content:**

> **You MUST call `new_conversation` at the start of each user turn before making any other tool call.** This mints a fresh correlation ID for the turn, ensuring all agent invocations and context operations within the turn share the same scope. It also clears cached agent sessions so invocations start fresh for a new topic.
>
> If you forget, the server auto-generates a random correlation ID per tool call — but this fragments the conversation scope, making cross-call context queries fail.

This instruction is blunt by design. The architect's review notes that `new_conversation` prompt reliability is "load-bearing for the conversation scoping design" — subtle guidance risks being ignored during long conversations.

### 3. Clarification Flow Section (Updated for Elicitation)

Replace the terminal-specific clarification flow with elicitation-aware guidance:

**Core content:**

> Agents may send you clarification questions via `invoke_agent(target=moderator, ...)`. When this happens, the question appears inline in your session as an elicitation prompt — you see the agent's question and type your answer directly.
>
> **Actions:**
> - **Accept**: Type your answer and submit. The answer flows back to the asking agent, and it continues working.
> - **Decline**: You can decline to answer (skip the question). The agent receives an error and must proceed without your input or try a different approach. Use this when the question is premature or the agent should make the decision itself.
> - **Cancel**: Cancel the elicitation entirely. Similar to decline — the agent receives an error. Use this if the question is irrelevant to the current task.
>
> When an agent's clarification is declined or cancelled, the agent handles the error gracefully — it was designed to proceed without an answer when needed. Do not worry about breaking the agent's work by declining.
>
> **Important:** The decline and cancel actions may not be immediately obvious in the CC CLI interface. Look for options beyond the text input field. If you want to skip a question, you may need to look for a decline/skip option rather than typing a refusal.

This last paragraph addresses the architect's concern about decline UX discoverability — QRM6-001 found that the decline affordance was "not obviously discoverable on first encounter."

### 4. Session Resume Section (Simplified)

Replace the current session resume section with simplified guidance that reflects server-side tracking (D6):

**Before (terminal prompt):**
> Follow-up invocations to the same agent role automatically resume the prior SDK session... You do not need to pass `sessionId` yourself.

**After:**
> Agent sessions are tracked server-side. When you invoke the same agent role multiple times within a turn, the agent automatically resumes its prior session with full conversation history. This is handled transparently — you do not pass `sessionId`.
>
> To force a fresh agent session (independent perspective, different task), pass `sessionId: ""` in the `invoke_agent` call. The `new_conversation` tool at the start of each turn already clears session caches, so fresh invocations in a new turn start fresh automatically.

This is cleaner than the original because the terminal prompt's session resume explanation included caveats about the terminal tracking sessions per-role — now the server does it.

### 5. Tool Restrictions Section (New)

Add guidance about the moderator's mechanical tool restrictions:

> By default, you cannot use Write, Edit, or NotebookEdit tools. This is a mechanical restriction (not just a prompt guideline) that enforces the moderator role boundary: orchestrate, do not implement.
>
> You CAN read files, search the codebase, and run restricted bash commands — use these for quick inspections without delegating to an agent. For implementation work, invoke the developer.

### 6. Identity Section (Updated)

Change from:
> You are the **Moderator**, chatting with a human user through a terminal interface.

To:
> You are the **Moderator**, the orchestration hub of the Quorum multi-agent system. You interface directly with the user through this Claude Code CLI session.

### 7. Project Documentation (Preserved)

The existing CLAUDE.md content (Project Overview, Tech Stack, Project Structure, Documentation table, Build Commands, Architecture Concept) is preserved in the lower half of the file. Two updates to the existing content:

1. **Tech Stack** — update "Moderator LLM" entry from "Raw Anthropic SDK" to "Claude Code CLI" (reflects the QRM6 change).
2. **Project Structure** — update the `apps/terminal/` comment when it still exists, or add a note that the terminal app is being replaced. (This line will be cleaned up in QRM6-009 and QRM6-010.)

All other project documentation content remains unchanged — it's accurate and useful for the moderator's project understanding.

### 8. `--append-system-prompt` via settings.json

Update `docker/moderator/settings.json` to include moderator-specific enforcement rules that should NOT be user-editable (they're baked into the container image):

```json
{
  "permissions": {
    "deny": ["Write", "Edit", "NotebookEdit"]
  },
  "mcpServers": {
    "quorum": {
      "type": "url",
      "url": "__MCP_SERVER_URL__"
    }
  },
  "systemPrompt": "<moderator enforcement rules>"
}
```

The `systemPrompt` field (equivalent to `--append-system-prompt`) contains:
- A reinforcement of the `new_conversation` requirement (belt-and-suspenders with the CLAUDE.md instruction)
- Skill dispatch enforcement ("ALWAYS use /code-review for review tasks")
- Context management rules (store decisions in project scope, query before assuming)
- A reminder that the moderator must call `register_agent(role='moderator')` on startup to enable elicitation routing

**Note:** The exact field name for `appendSystemPrompt` in `settings.json` depends on CC CLI's configuration schema. The developer should verify whether it's `systemPrompt`, `appendSystemPrompt`, or requires a different mechanism. If settings.json doesn't support this, use the `--append-system-prompt` CLI flag via the entrypoint script instead.

### 9. Entrypoint Consideration

If `appendSystemPrompt` requires a CLI flag rather than settings.json, update `docker/moderator/entrypoint.sh` to pass `--append-system-prompt "..."` when launching CC CLI. However, the entrypoint currently runs `tail -f /dev/null` (idle; user attaches via exec). The `--append-system-prompt` would need to be configured in a way that applies when the user runs `claude` via exec, not when the container starts.

**Preferred approach:** If settings.json supports it, use settings.json (already baked into the image). If not, create a shell wrapper at `/usr/local/bin/claude-moderator` that wraps the `claude` command with the flag, and alias `claude` to it in the image. The scripts/moderator.sh wrapper can also pass the flag.

The developer should investigate CC CLI's actual configuration surface and choose the cleanest approach. Document the choice in implementation notes.

### 10. Sections Kept Unchanged

The following sections are ported verbatim from `TERMINAL_MODERATOR_PROMPT` (no substantive changes needed):

- **Agent Capabilities Awareness** — describes agent team capabilities. Transport-neutral.
- **Responsibilities** — orchestration role definition. Transport-neutral.
- **Collaboration** — agent routing guidance. Transport-neutral.
- **Skill Dispatch** — `/code-review` and `/simplify` dispatch rules. Transport-neutral.
- **Context Management** — project/conversation scope guidance. Transport-neutral.
- **Communication Style** — user-facing language guidance. Minor wording update (remove "terminal" if present).
- **Failure Recovery** — `get-all` query pattern for discovering agent checkpoints. Transport-neutral.
- **Constraints** — delegation boundaries. Transport-neutral.

## Acceptance Criteria

- [ ] `CLAUDE.md` at workspace root rewritten with full moderator role definition
- [ ] `@quorum.md` import syntax used at the top of CLAUDE.md to merge project conventions
- [ ] **Turn Lifecycle section appears early** in the moderator role content (before Skill Dispatch), with a strong instruction: "You MUST call `new_conversation` at the start of each user turn before making any other tool call"
- [ ] Clarification Flow section updated to describe elicitation (inline question/answer, accept/decline/cancel actions)
- [ ] **Elicitation decline/cancel UX discoverability addressed** — prompt explicitly explains decline and cancel options and notes they may not be immediately obvious
- [ ] Session Resume section simplified to reference server-side tracking; `sessionId: ""` override documented; `new_conversation` cache-clearing mentioned
- [ ] Tool Restrictions section added (Write/Edit/NotebookEdit denied; read/search/bash available)
- [ ] Identity section updated from "terminal interface" to "CC CLI session"
- [ ] All sections from TERMINAL_MODERATOR_PROMPT ported: Identity, Agent Capabilities Awareness, Clarification Flow, Responsibilities, Collaboration, Skill Dispatch, Context Management, Communication Style, Failure Recovery, Session Resume, Constraints
- [ ] Project documentation content preserved in CLAUDE.md (Project Overview, Tech Stack, Project Structure, Documentation table, Build Commands, Architecture Concept)
- [ ] Tech Stack entry updated: moderator uses CC CLI, not raw Anthropic SDK
- [ ] `docker/moderator/settings.json` updated with `appendSystemPrompt` (or equivalent mechanism) containing moderator enforcement rules
- [ ] Enforcement rules include: `new_conversation` reinforcement, skill dispatch enforcement, context management rules, `register_agent` startup reminder
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (existing tests, no regressions)
- [ ] No changes to `apps/terminal/` — the terminal app remains untouched
- [ ] No changes to `apps/mcp-server/` or `apps/agent/` — server-side code is unaffected

## Dependencies and References

**Depends on:**
- QRM6-005 (`new_conversation` tool) — the tool must exist before the prompt can instruct the moderator to call it. **Status: Complete.**
- QRM6-006 (Agent Prompt Alignment) — the role template file must be updated to accurately describe the post-QRM6 prompt architecture before this ticket writes the CLAUDE.md counterpart. This avoids introducing new inconsistencies between the two prompt sources.

**Blocks:**
- QRM6-009 (Terminal deletion) — the terminal's `TERMINAL_MODERATOR_PROMPT` is dead code after this ticket lands. QRM6-009 deletes it along with the rest of `apps/terminal/`.
- QRM6-010 (Documentation) — CLAUDE.md updates are a prerequisite for the system design docs to accurately describe the moderator's prompt source.

**Key codebase references:**

| File | Relevance |
|------|-----------|
| `CLAUDE.md` | **Primary modification target** — rewritten as moderator prompt |
| `docker/moderator/settings.json` | **Secondary modification target** — add `appendSystemPrompt` |
| `apps/terminal/src/chat/chat.service.ts:206-294` | Source: `TERMINAL_MODERATOR_PROMPT` to port. Do NOT modify. |
| `libs/common/src/prompts/role-prompt-templates.ts:22-102` | Source: `SYSTEM_PREAMBLE` — conceptual overlap; CLAUDE.md is standalone but shares the same model |
| `libs/common/src/prompts/role-prompt-templates.ts:153-219` | Agent-facing moderator template (updated in QRM6-006) — the companion prompt |
| `quorum.md` | Imported via `@quorum.md` — project conventions |
| `docker/moderator/entrypoint.sh` | May need update if `appendSystemPrompt` requires CLI flag |
| `apps/mcp-server/src/mcp/mcp.service.ts:666-721` | `new_conversation` tool implementation — the prompt references this tool |
| `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` | Elicitation connection — the prompt describes this mechanism to the moderator |

**Design references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D3 (Moderator Prompt — CLAUDE.md), D5 (Correlation ID lifecycle), D7 (Tool Restrictions)
- [docs/QRM6-mid-milestone-design-review.md](../docs/QRM6-mid-milestone-design-review.md) — Concern #3 (`new_conversation` prompt reliability), QRM6-007 gap (decline/cancel UX)
- [QRM6-001-elicitation-spike.md](QRM6-001-elicitation-spike.md) — Implementation Notes: decline UX discoverability finding
- [QRM6-005-new-conversation-tool.md](QRM6-005-new-conversation-tool.md) — Tool description and behavioral contracts

**Architect review before implementation:** Recommended. The architect flagged two specific concerns for this ticket in the mid-milestone design review (decline/cancel UX, `new_conversation` instruction strength). While both are addressed in this ticket spec, a brief architect review of the final CLAUDE.md content before deployment would verify the prompt quality for what the architect called a "load-bearing" component.
