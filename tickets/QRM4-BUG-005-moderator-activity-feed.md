# QRM4-BUG-005: Moderator Activity Feed — Expose Tool Loop to Terminal UI

## Summary

The terminal's agentic tool loop runs silently — the user sees nothing between their input and the moderator's final response. For multi-agent invocations that take minutes, this creates a black box experience. Add a real-time activity feed that prints tool calls, agent responses, and context operations to stdout as they happen.

## Problem Statement

When the moderator processes a user request, it typically executes multiple tool rounds: querying context, invoking agents, storing results. Each `invoke_agent` call can take 30 seconds to 30 minutes. During this time the user sees only a blank terminal with no indication of:

- Which agent is being invoked and why
- Whether the agent has responded
- What the agent said back to the moderator
- How long each step took and what it cost
- Which context was queried or stored

The only visible output is the final `Moderator: ...` text after all rounds complete. In the QRM4 kick-off session, the user waited ~5 minutes with no feedback while 5+ invocations ran across 3 agents.

**Root cause:** `ChatService.processWithLoop()` executes tools via `executeTool()` without any stdout output. Tool names, arguments, and results are available in the loop but never displayed.

## Implementation Details

### Activity feed format

Print indented status lines to stdout around each tool execution in the `processWithLoop()` loop:

```
You: Let's start implementation of QRM4
  → context_query: project scope, mode=get-all
  ← 3 items returned
  → invoke_agent → developer: "Read QRM4 roadmap and return contents"
  ← developer (11s, $0.08): "The QRM4 roadmap defines 6 tickets: QRM4-001
    through QRM4-006, targeting bootstrap context injection..."
  → context_store: project scope, key=qrm4-status
  ← stored
  → invoke_agent → teamlead: "Create QRM4-001 ticket"
  ← teamlead (46s, $0.42): "Created and committed ticket QRM4-001:
    Extend InvokeRequest with bootstrapContext Field..."
  → invoke_agent → developer: "Implement QRM4-001"
  ← developer (88s, $0.47): failed — could not run npm run build
Moderator: I've started the QRM4 milestone. The teamlead created...
```

### What to print per tool type

| Tool | `→` line (before execution) | `←` line (after execution) |
|------|---------------------------|--------------------------|
| `invoke_agent` | `→ invoke_agent → {target}: "{action}"` (action truncated to ~80 chars) | `← {target} ({duration}, ${cost}): "{result}"` (result truncated to ~150 chars) |
| `context_query` | `→ context_query: {scope} scope, mode={mode}` | `← {N} items returned` |
| `context_store` | `→ context_store: {scope} scope, key={key}` | `← stored` |
| `context_summarize` | `→ context_summarize: correlationId={id}` | `← {preserved}/{total} keys preserved` |
| `context_stats` | `→ context_stats` | `← {itemCount} items, ~{tokens} tokens` |

### Where to add the output

In `apps/terminal/src/chat/chat.service.ts`, the `executeTool()` method (or the parallel execution block in `processWithLoop()`) already has access to:

- `toolUse.name` — tool name
- `toolUse.input` — tool arguments (contains `target`, `action`, `scope`, `key`, etc.)
- The MCP call result — contains the response text

Add `process.stdout.write()` calls:
1. **Before** `mcpClient.callTool()` — print the `→` line with tool name and key args
2. **After** `mcpClient.callTool()` — print the `←` line with result summary

For `invoke_agent` results, parse the response JSON to extract `success`, `result` (or `error`), and optionally `durationMs`/`totalCostUsd` if the broker includes them.

### Formatting helper

Extract a small `formatActivityLine()` function in `chat.service.ts` that takes tool name + args + result and returns the formatted strings. This keeps the tool loop clean.

### Truncation

Agent responses can be long. Truncate the `←` result display to ~150 characters with `...` suffix. The full response is still fed to the LLM — this is display-only truncation.

### Color (optional)

If the terminal supports it, use ANSI codes for subtle differentiation:
- `→` lines: dim/gray
- `←` success: default
- `←` failure: red
- Agent names: bold

This is optional and can be a follow-up. Plain text is fine for v1.

## Acceptance Criteria

- [ ] Tool calls print a `→` status line to stdout before execution
- [ ] Tool results print a `←` status line to stdout after execution
- [ ] `invoke_agent` lines include target role, action summary, and response summary
- [ ] `context_*` lines include scope, key, and result summary
- [ ] Agent responses are truncated to a readable length (~150 chars)
- [ ] Activity lines are visually distinct from the `Moderator:` response (indented with `  `)
- [ ] No changes to the agentic loop logic — display only
- [ ] Clarification handler output remains unaffected

## Dependencies and References

- `apps/terminal/src/chat/chat.service.ts` — `processWithLoop()`, `executeTool()`
- `apps/terminal/src/llm/anthropic.service.ts` — non-streaming `messages.create()`
- [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md) — user experienced 5min black box
- ICEBOX #2 (Streaming Moderator Output) — natural follow-up for real-time LLM text