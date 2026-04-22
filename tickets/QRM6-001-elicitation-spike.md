# QRM6-001: Elicitation Support Spike

## Summary

Time-boxed investigation to empirically verify that Claude Code CLI, acting as an MCP client, correctly handles `elicitation/create` requests from a server. This spike is the go/no-go gate for the QRM6 elicitation-based clarification design (D1). No production code is shipped; the deliverable is a findings report that either greenlights the rest of QRM6 or triggers the fallback plan.

## Problem Statement

QRM6's clarification back-channel rests on a single unverified assumption: that CC CLI, when connected to a server via Streamable HTTP, reacts to server-initiated `elicitation/create` requests by prompting the user inline and returning a structured response through the same session. If that assumption fails, D1 collapses and every downstream ticket (QRM6-002 through QRM6-010) has to be rewritten against the "cut the back-channel" fallback.

**Risks of skipping the spike:**
- Building QRM6-002 (moderator container) and QRM6-003 (elicitation connection) against an unworkable primitive wastes days of work.
- Discovering the problem mid-implementation forces mid-flight design changes to prompts, the broker, and the agent protocol simultaneously.
- The fallback plan (agents return `{needs_clarification: "..."}`) is substantively different from elicitation — prompt engineering, auto-persist semantics, and the UX all diverge. The choice must be made once, up front.

**Why this is unknown today:**
- MCP elicitation is part of the protocol spec but client support varies across hosts.
- Quorum has never exercised the server→client direction of MCP beyond transport-level keepalives.
- CC CLI's handling of mid-turn interactive prompts (interrupting assistant output, reading user input, resuming) is not documented at the depth needed to predict UX quality.

Time box: **1–2 days.** The output is a decision, not an optimization.

## Design Context

The spike validates **D1** in [QRM6-000-roadmap.md](QRM6-000-roadmap.md):

> When an agent calls `invoke_agent(target=moderator, action=...)`, the broker translates the invocation into an `elicitation/create` request on the moderator's MCP session.

The roadmap's "Back-Channel Options" table already rejected sidecar HTTP, persistent websockets, and the "cut the back-channel" approach in favor of elicitation — but all rejections assumed elicitation works. This spike converts the assumption into a verified fact.

**Nothing in Quorum depends on this spike's code.** The spike deliberately stands up a **minimal MCP server outside the Quorum codebase** (or on a throwaway branch) to avoid contaminating the production codebase with exploratory scaffolding. The only artifact that survives is the findings report.

### Relationship to the Fallback Plan

If the spike fails, the fallback is the third option in the roadmap's back-channel table:

> Agents return `{needs_clarification: "..."}` as a normal response; moderator asks the user, re-invokes with the answer (relies on session resume to unwind the chain)

This fallback is viable because QRM5-001 (session resume) already landed — re-invocation after clarification is cheap. The spike's failure mode is a prompt rewrite, not an architectural dead-end. That is why the time box is short: the cost of being wrong is bounded.

## Implementation Details

### 1. Minimal MCP Server (Throwaway)

Stand up a standalone MCP server using `@modelcontextprotocol/sdk` with **one tool** whose sole purpose is to trigger an elicitation against the caller's session. Pseudocode shape:

```typescript
server.tool("ask_user", { question: z.string() }, async ({ question }, extra) => {
  const answer = await server.elicitInput({
    sessionId: extra.sessionId,
    message: question,
    requestedSchema: { /* see section 3 */ },
  });
  return { content: [{ type: "text", text: JSON.stringify(answer) }] };
});
```

The exact API surface (`elicitInput`, `createElicitation`, `server.request`, etc.) depends on the version of `@modelcontextprotocol/sdk` we already use. Discovering the correct call site is part of the spike.

**Where to run it:** A scratch directory outside the Quorum repo, or a `spike/qrm6-001-elicitation` branch that will never merge. Do NOT place scaffolding in `apps/mcp-server/`.

### 2. CC CLI Client Setup

Configure CC CLI via `.mcp.json` (or the equivalent settings.json entry) to connect to the spike server over Streamable HTTP. Run CC CLI interactively and instruct the assistant, via a direct prompt, to call the `ask_user` tool. Observe what happens in the terminal.

**Things to watch for:**
- Does CC CLI surface the elicitation request as a visible user prompt, or does it silently auto-respond / error?
- Does the prompt interrupt the assistant's mid-turn output cleanly, or does it look garbled?
- Does the typed answer flow back as a structured response, or is it mangled / sent as plain text?
- Does the tool call that triggered the elicitation receive the answer and continue, or does it error out?
- What is the round-trip latency from `elicitInput()` call to resolved answer?

### 3. Schema Exploration

Elicitation uses JSON Schema for `requestedSchema`. The spike must answer:

- Does CC CLI support only trivial string inputs (`{ type: "string" }`) or full structured schemas (object with multiple fields, enum constraints, descriptions)?
- How are `title` / `description` rendered in the CLI prompt?
- Does a multi-field schema produce one prompt or a sequence?

Start with the simplest schema (`{ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }`) and only escalate if the simple case works.

### 4. Failure Modes to Probe

| Scenario | Expected | Probe |
|----------|----------|-------|
| User answers normally | Tool call returns the answer | Baseline test |
| User hits Ctrl+C during prompt | Tool call returns error or timeout | Verify CC CLI does not leave the session zombie |
| Session dropped mid-elicitation (kill server) | Promise rejects client-side | Verify CC CLI recovers without crash |
| Elicitation triggered during streaming assistant output | Prompt appears without breaking the stream | UX quality check |
| Elicitation triggered with a large schema | Rendered prompt remains legible | Schema complexity ceiling |

Not every scenario needs to be a formal test — the point is qualitative observation.

### 5. Findings Report

The only persistent deliverable is `tickets/tmp/QRM6-001-elicitation-spike-findings.md`. Required sections:

- **Verdict** — GO or NO-GO, with a one-line justification
- **Environment** — CC CLI version, MCP SDK version, OS
- **What works** — bullet list of confirmed-working behaviors
- **What does not work** — bullet list of broken / unsupported behaviors
- **UX observations** — subjective notes on how the prompt feels
- **Schema support** — documented JSON Schema surface area
- **Latency numbers** — representative round-trip timings
- **Implications for downstream tickets** — specifically, any constraints QRM6-003 must respect (e.g., "only single-string schemas work, so the elicitation payload must flatten multi-field clarifications into one string")
- **If NO-GO:** an explicit pointer to the fallback plan and which roadmap sections need to change

This report is what unblocks QRM6-002 onward.

## Acceptance Criteria

- [ ] Minimal MCP server standalone (not in `apps/mcp-server/`) registers a tool that issues `elicitation/create`
- [ ] CC CLI connects to the spike server and the tool is discoverable
- [ ] At least one successful end-to-end round trip: tool call → inline user prompt → user answer → tool call returns
- [ ] Round-trip latency measured and recorded
- [ ] JSON Schema surface area probed (at minimum: single-string, multi-field object)
- [ ] Failure modes probed: Ctrl+C during prompt, server-side session drop
- [ ] `tickets/tmp/QRM6-001-elicitation-spike-findings.md` written with all required sections
- [ ] Explicit GO or NO-GO verdict recorded in findings
- [ ] No code committed to `apps/`, `libs/`, or `docs/` under this ticket

## Dependencies and References

- **Gates:** QRM6-002, QRM6-003, QRM6-004, QRM6-005, QRM6-007, QRM6-008, QRM6-009, QRM6-010 — all downstream QRM6 work is conditional on GO verdict
- **Fallback trigger:** NO-GO reroutes all downstream tickets to the "cut the back-channel" plan (see [QRM6-000-roadmap.md](QRM6-000-roadmap.md) Research Summary → MCP Back-Channel Options)
- **Prior art within Quorum:** None — this is the first server→client MCP primitive Quorum would use
- **Key references:**
  - [MCP specification — Elicitation](https://modelcontextprotocol.io/) (server-to-client structured input)
  - [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — version pinned in Quorum's `package.json`
  - `@anthropic-ai/claude-code` — CC CLI package; version under test is the same one the moderator image will pin in QRM6-002
  - [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D1 (Back-Channel), Risk table entry "CC CLI elicitation support missing/broken"