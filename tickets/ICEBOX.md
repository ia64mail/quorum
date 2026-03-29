# Icebox

Technical debt and future improvements that are recognized but not yet scheduled. Items here are out of scope for current milestones — they represent known gaps, hardening opportunities, or enhancements worth revisiting later.

## How to use

- Add items as they surface during implementation or session analysis
- Each entry has a short title, context on *why* it matters, and a reference to where it was identified
- When an item is promoted to a milestone ticket, remove it from here and link the ticket

---

## Registry

### 1. Duplicate Invocation Prevention (Message Broker)

When a transient failure (network drop, MCP server restart) causes the moderator to retry an `invoke_agent` call, the broker has no way to detect that the original invocation is still running. This can spawn duplicate concurrent sessions on the shared workspace.

QRM4-BUG-002 fixes the primary trigger (client timeout mismatch), but retries from genuine transport errors remain unguarded.

**Possible approaches:**
- Idempotency keys on `invoke_agent` — broker deduplicates by key within a TTL window
- "Is agent busy?" query — broker checks if a pending invocation exists for the target role + correlationId before delivering
- Caller-side guard — moderator checks invocation status before retrying

**Discovered:** [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md) — Issue #5, [QRM4-BUG-002](QRM4-BUG-002-mcp-client-timeout-mismatch.md)

### 2. Streaming Moderator Output (Terminal)

Switch the terminal's `AnthropicService` from `messages.create()` (blocking, full response) to `messages.stream()` (chunked). This enables a typewriter effect for the moderator's final text and surfaces `tool_use` blocks the moment the LLM emits them — before execution starts.

[QRM4-BUG-005](QRM4-BUG-005-moderator-activity-feed.md) adds a tool activity feed (Layer 1) that works with the current non-streaming call. Streaming (Layer 2) is a natural follow-up that requires refactoring `AnthropicService` to return an async iterator and `ChatService.processWithLoop()` to consume it incrementally.

**Scope:**
- `AnthropicService.chat()` returns `AsyncIterable<StreamEvent>` instead of `Message`
- `ChatService` renders text chunks to stdout as they arrive
- Tool use blocks detected mid-stream trigger the activity feed lines from QRM4-BUG-005
- Tool results still feed back into the next round as before

**Discovered:** Terminal UX analysis, 2026-03-28