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