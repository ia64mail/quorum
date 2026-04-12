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

### 3. Agent Session Resume via Correlation ID

Reuse Claude Code SDK sessions across sequential invocations of the same agent role within a correlation chain. The SDK supports `resume` and `persistSession` parameters that Quorum currently ignores (`claude-code.service.ts:39` hardcodes `persistSession: false`). Resuming would cache the system prompt and prior conversation turns, avoiding cold-start overhead (re-reading `quorum.md`, re-discovering codebase, re-querying Context Store).

**Estimated savings:** 20-30% per agent on roles with 3+ sequential invocations (e.g., teamlead had 4 invocations in Run 10 at $2.91 total).

**Blocked by upstream SDK issues:**
- [claude-agent-sdk#247](https://github.com/anthropics/claude-agent-sdk-typescript/issues/247) — MCP server configs are non-serializable, busting the cache on every `query()` call. Resume would pay cache write cost again with no reads until this is fixed.
- [claude-agent-sdk#192](https://github.com/anthropics/claude-agent-sdk-typescript/issues/192) — Random UUID in Bash tool description invalidates cache between `query()` calls.

**Implementation sketch:**
- Maintain a `Map<correlationId:role, sessionId>` in `InvocationHandler`
- Enable `persistSession: true` for agent sessions
- Pass `resume: previousSessionId` on subsequent invocations of the same role+correlation
- Frame new tasks clearly ("Previous task complete. New task:") to prevent cross-task contamination
- Only works for sequential invocations — parallel dispatches of the same role get separate sessions

**Prerequisite:** Upstream fix for SDK #247. Monitor the issue and re-evaluate when resolved.

**Discovered:** Run 10 cost analysis, 2026-04-10 — [QRM4-BUG-013](QRM4-BUG-013-moderator-conversation-caching.md)