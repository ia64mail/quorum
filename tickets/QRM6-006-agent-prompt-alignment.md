# QRM6-006: Agent Prompt Alignment

## Summary

Audit and update agent role prompts in `libs/common/src/prompts/role-prompt-templates.ts` to remove terminal-specific clarification references and align with the elicitation-based moderator model. The `invoke_agent(target=moderator, ...)` primitive is unchanged from the agent's perspective, but the surrounding language, JSDoc comments, and moderator role template must reflect that the terminal app is going away and CC CLI + elicitation is the new moderator runtime.

After this ticket, the moderator entry in `ROLE_PROMPT_TEMPLATES` is the authoritative moderator role definition for agent-to-moderator interactions (no longer a secondary template subordinate to `TERMINAL_MODERATOR_PROMPT`), and the file's documentation accurately describes the single-source prompt architecture.

## Problem Statement

`libs/common/src/prompts/role-prompt-templates.ts` was written when two separate moderator prompts existed: `TERMINAL_MODERATOR_PROMPT` (the user-facing terminal, raw Anthropic SDK) and `ROLE_PROMPT_TEMPLATES[moderator]` (the agent-to-moderator clarification fallback, Claude Code SDK). The file is riddled with warnings about keeping these two in sync and references to `apps/terminal/`:

| Location | Reference | Problem |
|----------|-----------|---------|
| Lines 4-21 (SYSTEM_PREAMBLE JSDoc) | "TERMINAL_MODERATOR_PROMPT in apps/terminal/src/chat/chat.service.ts" | Terminal app is being deleted (QRM6-009) |
| Lines 11-12 | "human-facing moderator, raw Anthropic SDK" — prompt pathway #1 | Moderator moves to CC CLI; no longer raw SDK |
| Lines 116-147 (ROLE_PROMPT_TEMPLATES JSDoc) | Extensive drift warning about TERMINAL_MODERATOR_PROMPT | The drift trap disappears — there is only one moderator prompt source after QRM6 |
| Lines 122-127 | "do NOT reach the human-facing terminal moderator" | The user-facing moderator will be CC CLI, not the terminal |
| Lines 128-139 | Warning about agent-to-moderator clarification-only usage, past regressions (QRM5-BUG-002, 5a5581f) | The moderator template becomes the primary agent-facing prompt; CLAUDE.md (QRM6-007) handles the user-facing side |
| Lines 149-152 | Inline comment: "for agent-to-moderator CLARIFICATION calls only" | Template scope broadens — it's the moderator role definition for any agent interaction |

**What changes:**
- File-level JSDoc on `SYSTEM_PREAMBLE` updated to reflect the new dual-prompt model: CLAUDE.md (user-facing moderator) and `ROLE_PROMPT_TEMPLATES` (agent-invoked roles).
- `ROLE_PROMPT_TEMPLATES` block JSDoc updated to remove the drift warning, terminal references, and "clarification calls only" scope limitation.
- Inline comments on the moderator entry updated to describe its new role as the authoritative agent-facing moderator prompt.
- Moderator template content reviewed and adjusted — it may need minor wording changes now that it serves as the full agent-facing moderator definition, not just a clarification fallback.
- Other role prompts audited for any terminal-specific language (expected: none found, but the audit must be explicit).

**What stays the same:**
- `SYSTEM_PREAMBLE` content — cross-cutting guidance unchanged (already transport-neutral).
- Agent role prompts (architect, teamlead, developer, qa, productowner) — content unchanged unless terminal-specific language is found.
- `getRolePromptTemplate()` function — no signature or behavior change.
- All agent-to-moderator escalation guidance (`invoke_agent(moderator, ...)`) — the mechanism is identical from the agent's perspective.

**Risks of deferral:** QRM6-007 (Moderator CLAUDE.md) depends on this ticket — it needs the role template file to be accurate before the moderator's CLAUDE.md is written. Without updating the JSDoc and template, the file's documentation actively misleads developers about the prompt architecture (referencing code that QRM6-009 will delete). The moderator template's "clarification-only" framing also undersells its scope — post-QRM6, it's the moderator prompt for all agent invocations.

## Design Context

This ticket implements **QRM6-006 (Agent Prompt Alignment)** from the roadmap:

> Review agent prompts to ensure moderator invocation guidance still aligns with the elicitation flow. The actual clarification primitive (`invoke_agent(target=moderator, ...)`) does not change — agents send a question, the user answers — but any prompt language referring to "a terminal handler" or "clarification controller" is updated to generic wording.

**Mid-milestone design review (architect) found no gaps** for this ticket. The architect confirmed QRM6-006 is ready to proceed with no dependencies on QRM6-003/004/005 — it only modifies prompt text in `role-prompt-templates.ts`.

**Post-QRM6 prompt architecture (from roadmap D3):**

| Audience | Source | Runtime |
|----------|--------|---------|
| User-facing moderator | `CLAUDE.md` at workspace root + `--append-system-prompt` | CC CLI in moderator container |
| Agent-invoked moderator | `ROLE_PROMPT_TEMPLATES[AgentRole.moderator]` + `SYSTEM_PREAMBLE` | Claude Agent SDK subprocess |
| Agent-invoked roles (architect, developer, etc.) | `ROLE_PROMPT_TEMPLATES[role]` + `SYSTEM_PREAMBLE` | Claude Agent SDK subprocess |

The `TERMINAL_MODERATOR_PROMPT` in `apps/terminal/src/chat/chat.service.ts` is superseded by CLAUDE.md (QRM6-007) and deleted with `apps/terminal/` (QRM6-009). After QRM6-006, the role-prompt-templates file's documentation reflects this new reality.

## Implementation Details

### 1. SYSTEM_PREAMBLE JSDoc Update (Lines 4-21)

Update the docblock above `SYSTEM_PREAMBLE` to reflect the new prompt architecture. The two consumption pathways change:

**Before:**
1. `TERMINAL_MODERATOR_PROMPT` in `apps/terminal/src/chat/chat.service.ts` (human-facing moderator, raw Anthropic SDK) — imports & inlines this.
2. `ROLE_PROMPT_TEMPLATES` below (agent-to-agent via invoke_agent, Claude Code subprocess) — `getRolePromptTemplate()` prepends this.

**After:**
1. `ROLE_PROMPT_TEMPLATES` below — `getRolePromptTemplate()` prepends this preamble to every agent role prompt (agent-to-agent invocations via Claude Agent SDK subprocess).
2. The user-facing moderator prompt lives in `CLAUDE.md` at the workspace root (loaded by CC CLI) — it shares the same conceptual model but does not import this constant directly.

The instruction to "put ONLY truly cross-cutting guidance here" remains valid and unchanged.

### 2. ROLE_PROMPT_TEMPLATES Block JSDoc Update (Lines 116-147)

Replace the extensive drift warning with accurate documentation of the post-QRM6 architecture:

**Remove:**
- The warning about TERMINAL_MODERATOR_PROMPT divergence (lines 122-127)
- The clarification-only scope limitation for `[AgentRole.moderator]` (lines 128-139)
- The past-regression callouts (QRM5-BUG-002, commit 5a5581f) (lines 133-139)
- The instruction to keep behavior in sync across both locations (lines 135-139)

**Replace with:**
- A description of these templates as the role prompts for all agent invocations via `invoke_agent` (Claude Agent SDK subprocess path).
- A note that the user-facing moderator prompt lives in `CLAUDE.md` (loaded by CC CLI in the moderator container).
- A note that the `[AgentRole.moderator]` entry serves as the moderator's role definition when another agent invokes the moderator — it is the full agent-facing moderator prompt, not a clarification-only fallback.
- Preserve the structural convention note: "Identity, Capabilities, Responsibilities, Collaboration, Context Management, Communication Style, Constraints."
- Preserve the `{{caller}}` placeholder documentation.

### 3. Moderator Template Inline Comments (Lines 149-152)

Update the inline comment above `[AgentRole.moderator]`:

**Before:**
```
// This moderator entry is for agent-to-moderator CLARIFICATION calls only.
// The user-facing moderator that drives orchestration lives in
// `apps/terminal/src/chat/chat.service.ts` (`TERMINAL_MODERATOR_PROMPT`).
// Keep cross-cutting moderator behavior in sync across BOTH locations.
```

**After:** Update to reflect that this is the moderator's agent-facing role prompt. The user-facing moderator prompt lives in CLAUDE.md. No sync obligation — CLAUDE.md is an independent prompt optimized for the CC CLI context. The templates here serve the Claude Agent SDK subprocess context.

### 4. Moderator Template Content Review (Lines 153-219)

Review the moderator template body for accuracy in the post-QRM6 world. Expected findings:

- **Identity section** — "You are the orchestration hub — the only agent that interfaces directly with the user." — **Keep.** Still accurate.
- **Capabilities section** — "MCP orchestration tools" — **Keep.** Correct for the agent-invoked moderator path.
- **Responsibilities** — **Keep.** Unchanged.
- **Collaboration** — "When an agent invokes you for clarification, surface the question to the user — do not answer on the user's behalf unless you are confident from prior context" — **Keep.** The mechanism (elicitation) is transparent to the template; the guidance is correct.
- **Skill Dispatch** — **Keep.** Identical across both prompts.
- **Context Management** — **Keep.** Correct.
- **Communication Style** — **Keep.** May add a note that the user-facing moderator now runs as CC CLI (if helpful for agents that invoke the moderator to understand the interaction model).
- **Failure Recovery** — **Keep.** Correct.
- **Constraints** — **Keep.** Correct.

The moderator template content is already transport-neutral — the `invoke_agent(moderator, ...)` contract is unchanged. No substantive wording changes should be needed in the template body itself. The heavy lifting is all in the surrounding JSDoc and comments.

### 5. Other Role Prompts Audit

Scan all five non-moderator role prompts (architect, teamlead, developer, qa, productowner) for terminal-specific references:

**Expected findings:** None. The prompts use `invoke_agent(moderator, ...)` for escalation, which is transport-neutral. The SYSTEM_PREAMBLE mentions "moderator — user-facing decisions, blocker escalation (the moderator surfaces your question to the actual user)" which is correct regardless of terminal vs CC CLI.

**If terminal-specific language is found:** Update to generic wording. Do NOT change the escalation guidance — agents should still use `invoke_agent(moderator, ...)` exactly as before.

### 6. SYSTEM_PREAMBLE Content Audit

Scan the SYSTEM_PREAMBLE text (lines 22-102) for terminal-specific references:

**Expected findings:** None. The preamble is deliberately transport-neutral. It describes the agent team, capabilities, workspace, communication model, shared context, and git discipline — none of which reference the terminal app.

**Verification step only** — no changes expected, but the audit must be explicit.

### 7. No Changes to Other Files

This ticket modifies only `libs/common/src/prompts/role-prompt-templates.ts`. No changes to:
- `apps/terminal/` — untouched per QRM6 convention (deleted in QRM6-009)
- `apps/mcp-server/` — no server-side changes
- `apps/agent/` — role-prompt-service.ts consumes the templates via `getRolePromptTemplate()` which is unchanged
- `quorum.md` or `CLAUDE.md` — moderator prompt migration is QRM6-007

## Acceptance Criteria

- [x] `SYSTEM_PREAMBLE` JSDoc (above the export) accurately describes the two prompt pathways: (1) `ROLE_PROMPT_TEMPLATES` for agent invocations, (2) `CLAUDE.md` for the user-facing moderator. No references to `TERMINAL_MODERATOR_PROMPT` or `apps/terminal/`.
- [x] `ROLE_PROMPT_TEMPLATES` block JSDoc accurately describes the templates' purpose without drift warnings, terminal references, or clarification-only scope limitations.
- [x] Inline comment above `[AgentRole.moderator]` describes the entry as the moderator's agent-facing role prompt, not a clarification-only fallback. No references to `apps/terminal/` or `TERMINAL_MODERATOR_PROMPT`.
- [x] Moderator template body reviewed — content is transport-neutral and accurate for the post-QRM6 architecture. No terminal-specific language.
- [x] All five non-moderator role prompts (architect, teamlead, developer, qa, productowner) audited for terminal-specific language. Findings documented in implementation notes (expected: none found).
- [x] `SYSTEM_PREAMBLE` content audited for terminal-specific language. Findings documented in implementation notes (expected: none found).
- [x] `getRolePromptTemplate()` function signature and behavior unchanged.
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes (existing tests, no regressions)
- [x] No changes to `apps/terminal/` — the terminal app remains untouched
- [x] No changes to files outside `libs/common/src/prompts/role-prompt-templates.ts`

## Dependencies and References

**Depends on:** None. This ticket has no dependencies on QRM6-003/004/005 — it only modifies prompt text and JSDoc comments.

**Blocks:**
- QRM6-007 (Moderator CLAUDE.md) — depends on the role template file being accurate and the moderator template serving as the authoritative agent-facing prompt definition. The CLAUDE.md prompt is the user-facing counterpart.
- QRM6-009 (Terminal deletion) — the file references to `apps/terminal/` and `TERMINAL_MODERATOR_PROMPT` must be removed before the terminal app is deleted, otherwise the comments would reference nonexistent code.

**Key codebase references:**

| File | Relevance |
|------|-----------|
| `libs/common/src/prompts/role-prompt-templates.ts` | **Primary modification target** — JSDoc, comments, and moderator template |
| `apps/terminal/src/chat/chat.service.ts:186-294` | `TERMINAL_MODERATOR_PROMPT` — the prompt being superseded. Referenced in comments to be removed. Do NOT modify this file. |
| `apps/agent/src/connection/role-prompt.service.ts` | Consumer of `getRolePromptTemplate()` — no changes expected, but verify no breakage |
| `CLAUDE.md` | Will become the user-facing moderator prompt in QRM6-007 — this ticket prepares the role template to complement it |

**Design references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D3 (Moderator Prompt — CLAUDE.md), QRM6-006 scope
- [docs/QRM6-mid-milestone-design-review.md](../docs/QRM6-mid-milestone-design-review.md) — confirms no gaps for QRM6-006

**Architect review before implementation:** Not required. The roadmap defines the scope precisely, the mid-milestone design review found no gaps, and the changes are to prompt text and JSDoc comments — no architectural decisions are involved.

## Implementation Notes

**Status:** Complete

**Date:** 2026-04-23

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/prompts/role-prompt-templates.ts` | Modified | Updated JSDoc on `SYSTEM_PREAMBLE`, `GENERIC_PROMPT_TEMPLATE`, and `ROLE_PROMPT_TEMPLATES`; replaced inline comment above `[AgentRole.moderator]`. No template body content changed. |

### Audit Findings

- **SYSTEM_PREAMBLE content** (lines 24–104): No terminal-specific language found. Content is transport-neutral.
- **Moderator template body** (lines 144–210): No terminal-specific language found. Content references `invoke_agent`, MCP tools, and agent collaboration — all transport-neutral.
- **Non-moderator role prompts** (architect, teamlead, developer, qa, productowner): No terminal-specific language found in any of the five templates.
- **`getRolePromptTemplate()` function** (lines 439–442): Unchanged — same signature, same behavior, same consumer (`RolePromptService` at `apps/agent/src/prompts/role-prompt.service.ts`).

### Deviations from Ticket Spec

None. All six implementation steps executed as described. The GENERIC_PROMPT_TEMPLATE JSDoc was also updated (replacing "not the terminal moderator" with a positive description), which was not explicitly called out as a numbered step but falls within scope.

### Verification

- `npm run build` — 4 apps compile successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 49 suites, 760 tests passing (no regressions)
- `git diff --stat` confirms single file changed: 25 insertions, 34 deletions
