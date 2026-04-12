# QRM4-BUG-009: Project-Scope Context Enrichment via Architect Review and Team Lead Synthesis

## Summary

Project-scope context is almost empty — after 6 runs, only one item exists (`qrm4-status-report`, a status tracker). No agent synthesizes design decisions, implementation patterns, or cross-ticket knowledge into durable project memory. Introduce two complementary prompt/workflow changes: (1) the architect reviews each ticket before implementation and stores project-scope design notes, and (2) the team lead stores a project-scope synthesis at the end of code review.

## Problem Statement

In Runs 4–6, the Context Store accumulated 11 items — all conversation-scoped except one project-scope status tracker. The conversation-scope items record *what happened* (ticket status, implementation result, review verdict) but not *what it means* at the project level:

- Which patterns were established and should be reused?
- Which integration points were created and how do they connect?
- What constraints or trade-offs were discovered during implementation?
- How does the test suite evolve across tickets?

When a new ticket cycle begins, agents query project scope and find almost nothing. The developer must re-discover patterns by reading files. The team lead must re-learn integration points by reading code. The architect has no record of prior design decisions beyond what's in `docs/`.

**Concrete example from Run 6:** The developer's 3 parallel `context_query` calls at start returned 0 useful project-scope items. The developer then read 7 files to understand the codebase — reads that could have been avoided if a project-scope item described the patterns and integration points from QRM4-002.

**Concrete example from Run 5:** The architect wrote `qrm4-status-report` (a task tracker), but nothing about the config factory + config service pattern established in QRM4-002, or the module wiring convention used across all tickets. The developer's retry had to re-discover these by globbing the filesystem.

### What's missing

| Gap | Effect | Who should fill it |
|-----|--------|--------------------|
| No design review of tickets before implementation | Developer interprets ticket alone, may miss architectural context | Architect |
| No project-scope design notes | Agents can't discover patterns/constraints from prior tickets | Architect |
| No project-scope implementation synthesis | Patterns established in one ticket aren't propagated to the next | Team Lead |

## Design Context

### Orchestration flow change

The current moderator flow for a ticket cycle is:

```
teamlead writes ticket → (user confirmation) → developer implements → teamlead reviews
```

The new flow adds one step:

```
teamlead writes ticket → architect reviews ticket → (user confirmation) → developer implements → teamlead reviews
```

This change is in `quorum.md` only — the moderator reads `quorum.md` at session start and follows the workflow described there. No code changes to the moderator, terminal app, or MCP server.

### Context Store scopes

The Context Store already supports project scope (`scope: "project"`). All agents can read project-scope items via `context_query`. The mechanism exists — the prompts and workflow just don't guide agents to populate it with useful knowledge.

### Cost estimate

The architect review adds ~$0.40-0.60 and ~1min per ticket cycle (based on architect costs in Run 5). The team lead's project-scope store is one extra `context_store` call during an already-running review invocation — marginal cost near zero.

For a 6-subtask milestone: ~$3 extra from architect reviews. This is recovered if it prevents even one failed developer retry ($0.73 in Run 5).

## Implementation Details

### 1. Update `quorum.md` — Development Workflow section

**File:** `quorum.md` (workspace root — `/mnt/quorum/workspace/quorum.md` in Docker)

In the **"Commit Cadence Per Subtask"** section, update the table to reflect the new flow:

Current:
```markdown
| Commit | Content | Responsible |
|--------|---------|-------------|
| **1st** | Ticket file ... | Team Lead |
| **2nd** | Implementation ... | Developer |
| **3rd** | Code review ... | Team Lead (review) + Developer (fixes) |
```

Updated:
```markdown
| Step | Content | Responsible |
|------|---------|-------------|
| **1st commit** | Ticket file (`tickets/QRMX-NNN-*.md`) — problem statement, design context, implementation details, acceptance criteria | Team Lead |
| **Architect review** | Architect reviews the ticket for design alignment, stores project-scope design notes (patterns, constraints, integration points) in Context Store. No commit — context store only. | Architect |
| **2nd commit** | Implementation — code changes that fulfill the ticket | Developer |
| **3rd commit** | Code review + project synthesis — acceptance criteria checked, implementation notes added to ticket, project-scope synthesis stored in Context Store | Team Lead (review) + Developer (fixes) |
```

Add a new subsection after "Commit Cadence Per Subtask":

```markdown
### Architect Ticket Review

After the team lead creates a ticket and before the user confirms implementation, the moderator invokes the architect to review the ticket. The architect:

1. **Reads the ticket** end-to-end
2. **Reads relevant code** — files referenced in the ticket's implementation details
3. **Queries project context** — checks for prior design decisions, established patterns, and constraints
4. **Stores project-scope design notes** — a `context_store` call with key `{ticket-id}-design-notes`, scope `project`, containing:
   - Patterns to reuse from prior tickets (with file paths)
   - Constraints the developer should be aware of
   - Integration points with existing code
   - Any concerns or ambiguities in the ticket's proposed approach
5. **Returns a brief summary** to the moderator (accept/flag concerns)

The architect does NOT modify the ticket file — design notes go into the Context Store where the developer will find them via `context_query` at implementation start.
```

### 2. Update `quorum.md` — Architect role section

**File:** `quorum.md` — Role Configurations → Architect

Add to **Core Responsibilities** (after item 4 "Staying in sync"):

```markdown
5. **Ticket design review** — When the moderator invokes you to review a ticket before implementation, read the ticket and the code it references, then store project-scope design notes in the Context Store. Focus on what the developer needs to know that isn't already in the ticket: reusable patterns from prior work, integration constraints, and potential pitfalls. Key format: `{ticket-id}-design-notes`, scope: `project`.
```

Add to **What You Produce** list:

```markdown
- Project-scope design notes for tickets (`context_store` with key `{ticket-id}-design-notes`)
```

### 3. Update `quorum.md` — Team Lead role section

**File:** `quorum.md` — Role Configurations → Team Lead

In **Core Responsibilities**, item 3 "Code review", add after the existing text:

```markdown
   After accepting a review, also store a **project-scope synthesis** in the Context Store (key: `{ticket-id}-project-notes`, scope: `project`) summarizing what this implementation established at the project level:
   - Patterns introduced or reused (with file paths as evidence)
   - Integration points created (what's now injectable/importable/callable)
   - Test coverage changes (suite count, new test categories)
   - Dependency graph updates (what's now unblocked)
   This is NOT a duplicate of the conversation-scope review verdict — it captures cross-ticket knowledge that future agents need.
```

Add to **Context Management** section:

```markdown
- **Store** project-scope synthesis after code review — capture patterns, integration points, and test evolution that matter beyond this conversation chain
```

### 4. Update role prompt template — Architect

**File:** `libs/common/src/prompts/role-prompt-templates.ts` — `AgentRole.architect` template

In the **Context Management** section, add after the existing "Store architectural decisions in project scope" bullet:

```
- **Store** ticket design notes in **project** scope when reviewing tickets before implementation — key: `{ticket-id}-design-notes`. Include: patterns to reuse, constraints, integration points, concerns. The developer queries project scope at task start and will find these automatically.
```

### 5. Update role prompt template — Team Lead

**File:** `libs/common/src/prompts/role-prompt-templates.ts` — `AgentRole.teamlead` template

In the **Context Management** section, add after the existing bullets:

```
- **Store** project-scope synthesis after accepting a code review — key: `{ticket-id}-project-notes`, scope: **project**. Summarize patterns established, integration points created, test coverage changes, and dependency graph updates. This is cross-ticket knowledge, not a duplicate of the conversation-scope review verdict.
```

### 6. No changes to moderator prompt or code

The moderator reads `quorum.md` at session start and follows the workflow. The orchestration change (invoke architect after ticket creation) is driven by the workflow description in `quorum.md`, not by moderator prompt changes or code changes.

### 7. No changes to developer prompt

The developer already queries project scope at task start (added in QRM4-BUG-008). The architect's design notes and team lead's project synthesis will be discovered automatically via existing `context_query` calls.

## Acceptance Criteria

- [x] `quorum.md` "Commit Cadence Per Subtask" table updated to include architect review step
- [x] `quorum.md` contains new "Architect Ticket Review" subsection describing the review flow
- [x] `quorum.md` Architect role section includes ticket design review responsibility
- [x] `quorum.md` Architect "What You Produce" includes project-scope design notes
- [x] `quorum.md` Team Lead role section includes project-scope synthesis after code review
- [x] `quorum.md` Team Lead "Context Management" includes project-scope synthesis instruction
- [x] Architect prompt template (`role-prompt-templates.ts`) includes design notes storage instruction
- [x] Team Lead prompt template (`role-prompt-templates.ts`) includes project synthesis storage instruction
- [x] No changes to moderator prompt, developer prompt, or any application code
- [x] No changes to Context Store, MCP tools, or agent infrastructure
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm run test` passes

## Dependencies and References

- **Observed in:** [Run 6 session report](../logs/sessions/2026-04-03-qrm4-run6.md) — project-scope context gap analysis
- **Related:** QRM4-BUG-008 (incremental checkpointing) — added agent-scope checkpointing; this ticket addresses the complementary project-scope gap
- **Related:** Run 5 `qrm4-status-report` — the only existing project-scope item, a status tracker rather than a knowledge artifact
- **Context Store docs:** [docs/context-store.md](../docs/context-store.md), [docs/context-management.md](../docs/context-management.md)
- **Prompt templates:** `libs/common/src/prompts/role-prompt-templates.ts`
- **Orchestration config:** workspace `quorum.md`
- **Note:** Like QRM4-BUG-008, this is a behavioral change via prompts and workflow config. Effectiveness should be validated in the next ticket cycle (QRM4-003 or QRM4-004) by observing whether the architect stores design notes and whether the team lead stores project synthesis.

## Implementation Notes

**Status:** Complete

**Date:** 2026-04-03

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `quorum.md` | Modified | Updated Commit Cadence table to 4-step flow (added Architect review step), added "Architect Ticket Review" subsection, added responsibility #5 and design notes output to Architect role, added project-scope synthesis to Team Lead code review responsibility, added Context Management section to Team Lead role |
| `libs/common/src/prompts/role-prompt-templates.ts` | Modified | Added ticket design notes storage instruction to Architect Context Management section, added project-scope synthesis instruction to Team Lead Context Management section |

### Deviations from Ticket Spec

- None — implementation matches the ticket specification exactly.

### Verification

- `npm run build` — 4 webpack compilations successful
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 473 tests passing across 38 suites (0 new tests — no application code changed)