# QRM4-BUG-008: Incremental Context Checkpointing in Agent Prompts

## Summary

Agent prompts (especially the developer's) only instruct agents to store context at the end of a task. When an invocation fails mid-task, the retry has no structured record of what the first attempt discovered or completed — it recovers only through filesystem artifacts (files on disk, git state). Harden the system preamble and developer prompt to encourage incremental context checkpointing using `agent`-scope context, so retries can pick up where the previous attempt left off.

## Problem Statement

In [Run 5](../logs/sessions/2026-04-02-qrm4-run5.md), the developer's first invocation:
1. Read 21 files to understand the codebase (62% of all tool calls)
2. Wrote 2 new files and made 5 edits
3. Failed at turn 20 (`error_max_turns`) before completing

The retry succeeded, but had to re-discover what had been done by running `Glob` to check which files existed. It worked because the first attempt's file writes persisted on disk. But this is fragile — the retry has no structured knowledge of:
- Which files the first attempt read and what it learned
- Which design decisions it made and why
- Which implementation steps completed vs. which remain
- Why it was working on a particular approach

The current developer prompt says:

> **Store** implementation decisions in **conversation** scope [...] so reviewers understand your approach

This is end-of-task, reviewer-facing guidance. It does not encourage:
- Saving research findings early (before implementation begins)
- Checkpointing implementation progress incrementally
- Using `agent` scope for private working memory during the task
- Structuring context in a way that a retry of the same agent can consume

The `agent` scope exists in the Context Store but is not mentioned in any role prompt.

## Design Context

The Context Store already supports three scopes:
- **project** — session-wide, all agents see it
- **conversation** — tied to correlationId, visible to the chain
- **agent** — private to the current agent instance

The `agent` scope is ideal for incremental checkpointing: it doesn't pollute the shared context, and a retry of the same agent on the same correlationId can query it to find the previous attempt's state. The scope is already implemented in `InMemoryStore` and exposed through the `context_store`/`context_query` MCP tools.

**Important constraint:** These are prompt-only changes. No code changes to the Context Store, MCP tools, or agent infrastructure. The tools already support this pattern — the prompts just don't guide agents to use them.

## Implementation Details

### 1. System preamble: document `agent` scope for working memory

**File:** `libs/common/src/prompts/role-prompt-templates.ts` — `SYSTEM_PREAMBLE`

In the "Shared Context — Pull, Don't Push" section, expand the `agent` scope description:

Current (line 56):
```
- **agent** scope — Private working memory for the current agent only.
```

Updated:
```
- **agent** scope — Private working memory for the current agent only. Use it to checkpoint progress during long tasks: save research findings, implementation steps completed, and decisions made. If your session is retried, the next attempt can query agent-scope context to pick up where you left off instead of re-researching from scratch.
```

### 2. System preamble: add resilience guideline

Add a new subsection under "General Guidelines" in the preamble:

```
## Progress Checkpointing
For tasks that involve significant research or multi-step implementation:
- **After research**: Store key findings in **agent** scope (e.g., "research_findings": { files read, patterns discovered, constraints identified })
- **After each implementation step**: Update your checkpoint (e.g., "progress": { steps_completed: [...], steps_remaining: [...], current_approach: "..." })
- **On retry**: Query **agent** scope first — a previous attempt may have left findings and progress that save you from re-doing work
This costs one tool call per checkpoint but can save dozens of tool calls on retry.
```

### 3. Developer prompt: add incremental context instructions

**File:** `libs/common/src/prompts/role-prompt-templates.ts` — `AgentRole.developer` template

Replace the current Context Management section (lines 240-244) with:

```
## Context Management
- **Query project context first** — check for architectural decisions, tech stack, constraints, and patterns before writing any code
- **Query conversation context** — check for task-specific decisions, dependencies, and prior work in this chain
- **Query agent context on start** — a previous attempt at this task may have left research findings and progress checkpoints. If found, use them instead of re-reading files
- **Checkpoint after research** — once you have read and understood the relevant code, store a summary of findings in **agent** scope (key files, patterns, constraints, approach). This is your insurance against session interruption
- **Checkpoint after implementation milestones** — after creating/modifying files, update your agent-scope checkpoint with completed steps. Keep it concise: file paths and one-line descriptions, not full code
- **Store** implementation decisions in **conversation** scope so reviewers and downstream agents understand your approach
- Do NOT guess at requirements — if context is missing, query for it or ask the architect
```

### 4. No changes to other role prompts

The architect and teamlead prompts already have stronger context-saving patterns (they store decisions proactively). The developer is uniquely affected because:
- Implementation tasks are the longest (30min timeout, most tool calls)
- Research phase is the most expensive to repeat
- The developer is the role most likely to hit turn limits

QA could benefit similarly but is lower priority — QA tasks are shorter and less research-heavy.

## Acceptance Criteria

- [x] System preamble `agent` scope description mentions checkpointing and retry recovery
- [x] System preamble includes "Progress Checkpointing" guideline
- [x] Developer prompt Context Management section includes agent-scope query on start
- [x] Developer prompt instructs checkpointing after research phase
- [x] Developer prompt instructs checkpointing after implementation milestones
- [x] No code changes to Context Store, MCP tools, or agent infrastructure
- [x] No changes to architect, teamlead, or QA prompts (scope limited to developer + preamble)
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes

## Implementation Notes

**Status:** Accepted ✅

**Files modified:**
- `libs/common/src/prompts/role-prompt-templates.ts` — prompt-only changes (no code logic changes)

**Changes made:**
1. `SYSTEM_PREAMBLE` — expanded `agent` scope description (line 57) to include checkpointing and retry recovery guidance
2. `SYSTEM_PREAMBLE` — added new `## Progress Checkpointing` section (lines 68-73) under General Guidelines with three actionable bullets (After research, After each step, On retry)
3. Developer template (`AgentRole.developer`) — replaced Context Management section with 7 bullets including agent-scope query on start, checkpoint after research, checkpoint after milestones, and retained conversation-scope storage for reviewers

**Deviations from ticket:** None — implementation matches all four specified changes exactly.

**Verification results:**
- `npm run build` — all 4 apps compiled successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 38 suites, 469 tests, all passing
- No changes to architect, teamlead, QA, moderator, or productowner templates confirmed via diff

## Dependencies and References

- **Discovered in:** [Run 5 session report](../logs/sessions/2026-04-02-qrm4-run5.md) — Issue 1
- **Context Store docs:** [docs/context-store.md](../docs/context-store.md), [docs/context-management.md](../docs/context-management.md)
- **Prompt templates:** `libs/common/src/prompts/role-prompt-templates.ts`
- **Related:** QRM4-BUG-006 (error reporting) and QRM4-BUG-007 (per-role maxTurns) address the same incident from different angles
- **Note:** This is a behavioral change via prompts, not a code change. Effectiveness should be validated in a future session run by observing whether agents actually checkpoint and whether retries consume fewer research turns