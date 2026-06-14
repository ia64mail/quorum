# Ticket Library

## Purpose

The ticket library is an **implementation timeline knowledge base** — a sequential record of every unit of work in the project. Each ticket captures the circumstances, reasoning, and implementation approach for a specific piece of codework at a specific point in time.

**The ticket library is a library for the agent first.** It exists so that a Claude Code agent (or any agent in the Quorum system) can understand not just *what* was implemented, but *why* it was implemented that way, what constraints existed at the time, and what alternatives were considered.

## Tickets vs Documentation

Tickets and documentation serve different roles:

| Aspect | Documentation (`docs/`) | Tickets (`tickets/`) |
|--------|------------------------|---------------------|
| **Nature** | Living reference — updated as the system evolves | Time snapshot — frozen record of a decision point |
| **Answers** | "How does the system work?" | "Why was it built this way?" |
| **Lifespan** | Maintained indefinitely | Written once, rarely modified |
| **Scope** | System-wide concepts and architecture | Single unit of work |

Tickets **complement** documentation. Documentation describes the current state of the system; tickets explain the sequence of decisions that got it there. Together they give an agent full context: the architecture (docs) and the reasoning trail (tickets).

## A Ticket Is the Truth About a Change, Not About the Present

A ticket *is* a source of truth — but for **how the system changed over time**, not for its **current state**. Reading it as a live description of the system is the most common way to misuse the library. The discipline below applies whenever you consume a ticket.

- **A ticket records a transition, A → B, at the moment it was authored.** It is the truth about *that change*, not a standing description of current behavior. The current state is the **composition of every transaction in the chain**; the code and the running system are the final ground truth for it.
- **A claim true at its transaction may be stale now.** `file:line` references, payload and type shapes, log strings, flag names, and behavioral descriptions were accurate for the change the ticket recorded. They are not standing facts about the present — a later change may have moved them. Don't treat "true then" as "true now"; confirm the present state before relying on a concrete claim (read a flag's current value rather than assuming the ticket's).
- **Read the chain, not one ticket.** One ticket is one transaction. The change that superseded an earlier ticket is itself recorded by a *later* ticket — this is how the library reinforces itself. To reconstruct the present, follow referenced and predecessor tickets and the chronological numbering across A → B → C → … → now. A single mid-history ticket read in isolation reconstructs a state that may already be superseded.
- **Read a ticket whole, not a fragment.** This is the intra-ticket form of the same rule. A ticket is a deliberately ordered narrative, and the parts that *qualify or override* its own earlier plan — `Implementation Notes`, `Deviations from Ticket Spec`, and the flipped acceptance-criteria checkboxes — sit at the **end**. Grepping for a symbol and reading only the surrounding lines surfaces the plan and misses its corrections, reproducing "true then" vs "true now" *within a single ticket*. Tickets are deliberately small — typically ~100–300 lines, a complete story from start to end — so a full read is cheap. Use search to *locate* the right ticket; once it is the one you will act on, read it end to end rather than acting on a matched excerpt.
- **Reconcile across the chain, confirm against code.** Use `docs/` for current-state architecture and the code and running system as ground truth; use `tickets/` for the **why** and the **evolution path** — the ordered record of how the code reached its present shape.

This complements, rather than replaces, the post-implementation `Implementation Notes` / `Deviations from Ticket Spec` convention (see [Post-Implementation Update](#post-implementation-update)). That convention keeps an individual ticket honest about where the merged code intentionally diverged from its spec; the discipline here governs the *temporal* case — a ticket accurate for its own transaction, later superseded by subsequent ones.

## Naming Convention

### Ticket ID

Format: `QRM1-NNN` where `NNN` is a zero-padded sequential number.

```
QRM1-001  ← first ticket
QRM1-002  ← second ticket
QRM1-043  ← forty-third ticket
```

Sequential numbering is intentional — it gives the agent a **timeline sense**. The order of tickets reflects the order of decisions. An agent reading QRM1-015 knows that QRM1-001 through QRM1-014 represent prior context and earlier decisions.

### File Name

The file name mirrors the branch name associated with the work:

```
tickets/QRM1-001-instrumental-package-research.md    ← branch: QRM1-001-instrumental-package-research
tickets/QRM1-002-project-scaffolding.md              ← branch: QRM1-002-project-scaffolding
```

If no PR/branching process is configured yet, the ticket still follows this naming pattern and is associated with the `main` branch.

### Branch Association

| Scenario | Branch Name | Ticket File Name |
|----------|-------------|------------------|
| PR workflow active | `QRM1-NNN-short-description` | `QRM1-NNN-short-description.md` |
| No PR workflow | `main` | `QRM1-NNN-short-description.md` |

## Ticket Structure

Every ticket follows this structure. Sections marked *(optional)* can be omitted when not applicable.

```markdown
# QRM1-NNN: Ticket Title

## Summary
One to three sentences describing the unit of work and its purpose.

## Problem Statement
What problem or gap this ticket addresses. Include:
- Current situation or limitation
- Why this work is needed now
- Risks of not doing it

## Design Context *(optional)*
How the system design informs this implementation. Connects
the architectural decisions from docs/ to the concrete work
in this ticket.

## Implementation Details
The core of the ticket: how the work should be (or was) carried out.
See "Writing Implementation Details" below for guidelines.

## Acceptance Criteria
Concrete, verifiable conditions that define "done."
Use checkboxes for trackability:
- [ ] Criterion one
- [ ] Criterion two

## Dependencies and References
- Prerequisites (other tickets, tools, access)
- What this ticket blocks
- Links to relevant docs, packages, or external resources

## Implementation Notes *(added post-implementation)*
See "Post-Implementation Update" below for format.
```

## Writing Implementation Details

The Implementation Details section is the most important part of the ticket. It should explain the **reasoning and approach**, not duplicate the code.

### Guidelines

**Do:**
- Explain *why* a particular approach was chosen
- Describe the structure and flow of the implementation
- Call out non-obvious decisions and their rationale
- Reference specific files or modules by path when relevant
- Use small, focused code snippets as hints (a type definition, a function signature, a config snippet)

**Do not:**
- Paste large blocks of implementation code — the codebase is the primary source of truth
- Duplicate code that already exists or will exist in the repository
- Write step-by-step code that reads like a tutorial
- Include boilerplate or obvious patterns

### Code Snippet Guidance

Code snippets in tickets serve as **hints**, not as implementation. They help the agent understand intent without creating a maintenance burden of duplicated code.

Appropriate:
```markdown
The MCP server exposes tools using the `McpServer.tool()` registration pattern:

    server.tool("tool_name", schema, handler)

See `apps/mcp-server/src/` for the full implementation.
```

Inappropriate:
```markdown
Here is the full implementation of the MCP server:

    const server = new McpServer({ name: "quorum", version: "1.0" });
    server.tool("echo", { message: z.string() }, async ({ message }) => {
      return { content: [{ type: "text", text: message }] };
    });
    server.tool("get_time", {}, async () => {
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    });
    // ... 50 more lines
```

The ticket explains *why*. The code speaks for *how*.

## Post-Implementation Update

After implementation is complete, the ticket **must** be updated with an `## Implementation Notes` section appended at the end. This closes the loop — the ticket starts as a plan and ends as a record of what actually happened.

### When to Update

Update the ticket in the same commit (or PR) that completes the implementation. The implementation notes are part of the deliverable, not an afterthought.

### Required Subsections

```markdown
## Implementation Notes

**Status:** Complete

**Date:** YYYY-MM-DD

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `path/to/file.ts` | Created | Brief description of what this file does |
| `path/to/other.ts` | Modified | What changed and why |

### Deviations from Ticket Spec

- **What changed.** Why it changed — reference the constraint, lint rule,
  or codebase convention that motivated the deviation.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — N tests passing (X new + Y existing)
```

### Guidelines

**Files Created/Modified table:**
- List every file touched, including test files and barrel exports
- Action is `Created` or `Modified`
- Notes column captures the essential "what" — just enough for an agent to understand the file's role without opening it

**Deviations from Ticket Spec:**
- Only include actual deviations — places where the implementation intentionally differs from what the ticket described
- Each deviation is a bolded summary followed by the rationale
- If there are no deviations, omit this subsection entirely
- This is critical context: a future agent reading the ticket needs to know that the code doesn't match the spec *on purpose*, not by accident

**Verification:**
- Record the exact commands run and their outcomes
- Include test counts (new + existing) so regressions are detectable by comparison

### Acceptance Criteria Checkboxes

When updating the ticket, also flip all completed acceptance criteria from `- [ ]` to `- [x]`. This makes completion status visible at a glance.