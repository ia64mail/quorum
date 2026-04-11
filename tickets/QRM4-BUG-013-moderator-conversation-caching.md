# QRM4-BUG-013: Moderator Multi-Turn Conversation Caching

## Summary

The moderator's tool loop re-sends the entire conversation history as uncached input on every API call. With 8 rounds per user turn and agent responses accumulating in the message array, ~65% of the moderator's $1.43 cost in Run 10 was spent re-reading messages it had already processed in earlier rounds. Adding `cache_control` breakpoints to conversation messages and tool definitions would reduce moderator cost by an estimated 60-75%.

## Problem Statement

BUG-012 added prompt caching for the system prompt — a necessary first step. However, the system prompt (~6k tokens) represents only ~25% of the per-call input. The remaining ~75% — conversation messages and tool definitions — is sent as fresh, uncached input on every `messages.create()` call.

**Current caching coverage:**

| Input component | Tokens (per call) | Cached? | Cost rate (Opus) |
|----------------|-------------------|---------|------------------|
| System prompt | ~6k | Yes (ephemeral) | $1.5/MTok (read) |
| Tool definitions (7 MCP tools) | ~2.5k | No | $15/MTok |
| Conversation messages | 0→20k (growing) | No | $15/MTok |

The conversation messages are the dominant cost because they **grow with every round** and are **re-sent cumulatively**. The tool definitions are a fixed cost per call but add up across 8 calls.

### Observed behavior: Run 10 conversation growth

The moderator's `this.messages` array in `chat.service.ts:234` accumulates all assistant/user message pairs across the tool loop. Here is the exact state at each API call during Run 10 ("Let's complete QRM4 milestone implementation"):

**Round 1** (user message → context queries):
```
messages = [
  { role: "user", content: "Let's complete QRM4 milestone implementation" }
]
~50 tokens of messages
```

**Round 2** (context results → invoke architect):
```
messages = [
  { role: "user",      "Let's complete QRM4 milestone implementation" },
  { role: "assistant", [tool_use: context_query(search), tool_use: context_query(get-all)] },
  { role: "user",      [tool_result: "[]", tool_result: "{...9 project items as JSON...}"] },
]
~3k tokens — the get-all result serializes all 9 project-scope context items
```

**Round 3** (architect result → invoke teamlead for 005 ticket):
```
messages = [
  ...3 previous messages,
  { role: "assistant", [tool_use: invoke_agent(architect, "Read QRM4 roadmap...")] },
  { role: "user",      [tool_result: "{success:true, result:'## QRM4 Status Report...', totalCostUsd:0.45}"] },
]
~5k tokens — architect's full response (~1.5k) added verbatim as tool_result
```

**Round 4** (teamlead 005 ticket → parallel dispatch):
```
messages = [
  ...5 previous,
  { role: "assistant", [tool_use: invoke_agent(teamlead, "Create ticket for QRM4-005...")] },
  { role: "user",      [tool_result: "{success:true, result:'Ticket created: ...3 test targets...', totalCostUsd:0.72}"] },
]
~7k tokens — teamlead's ticket breakdown added
```

**Round 5** (parallel results → next parallel pair):
```
messages = [
  ...7 previous,
  { role: "assistant", [tool_use: invoke_agent(teamlead, "006..."), tool_use: invoke_agent(developer, "005...")] },
  { role: "user",      [tool_result: teamlead 006 ticket (~1k), tool_result: developer 005 impl report (~1.5k)] },
]
~10k tokens — two agent responses added
```

**Rounds 6-8** continue the same pattern: review results, final review, context_store + final text. By round 8, the messages array contains **~18-20k tokens** of accumulated tool calls and agent responses.

### Cost pyramid: cumulative input across 8 API calls

Each round re-sends everything from all previous rounds plus new messages:

```
Round 1:  system(cached) + tools(2.5k) + msgs(0.05k)     =  2.5k fresh input
Round 2:  system(cached) + tools(2.5k) + msgs(3k)         =  5.5k fresh input
Round 3:  system(cached) + tools(2.5k) + msgs(5k)         =  7.5k fresh input
Round 4:  system(cached) + tools(2.5k) + msgs(7k)         =  9.5k fresh input
Round 5:  system(cached) + tools(2.5k) + msgs(10k)        = 12.5k fresh input
Round 6:  system(cached) + tools(2.5k) + msgs(14k)        = 16.5k fresh input
Round 7:  system(cached) + tools(2.5k) + msgs(17k)        = 19.5k fresh input
Round 8:  system(cached) + tools(2.5k) + msgs(18k)        = 20.5k fresh input
                                                      ───────────────────────
                                                Total:  ~94k fresh input tokens
```

### Cost breakdown estimate (Opus, Run 10)

| Component | Tokens | Rate | Cost | Share |
|-----------|--------|------|------|-------|
| Conversation messages (uncached, cumulative) | ~74k | $15/MTok | ~$1.11 | 65% |
| Tool definitions (uncached, 2.5k × 8) | ~20k | $15/MTok | ~$0.30 | 18% |
| System prompt cache reads (6k × 7) | ~42k | $1.5/MTok | ~$0.06 | 4% |
| System prompt cache write (6k × 1) | ~6k | $18.75/MTok | ~$0.11 | 6% |
| Output tokens (tool_use blocks + final text) | ~2k | $75/MTok | ~$0.14 | 8% |
| **Total** | | | **~$1.72** | |

The estimate of ~$1.72 vs the observed $1.43 is reasonable given token count approximations. The key insight is that **conversation replay accounts for ~65% of moderator cost**, and it's entirely cacheable.

### Why this matters at scale

Run 10 was a 7-invocation session. As orchestration complexity grows (more agents, more sequential steps, deeper review chains), the conversation grows proportionally. A 15-invocation session would have ~15 API rounds with ~40k tokens of messages by the end, pushing cumulative fresh input past 200k tokens — over $3 in conversation replay alone.

## Design Context

The Anthropic Messages API supports `cache_control: { type: 'ephemeral' }` on three types of content:

1. **System prompt blocks** — already implemented (BUG-012)
2. **Tool definitions** — put `cache_control` on the last tool in the `tools` array
3. **Conversation message blocks** — put `cache_control` on any content block within messages

For multi-turn tool loops, the standard caching pattern is:

1. Mark the system prompt for caching (done)
2. Mark the last tool in the tools array for caching (not done)
3. Before each API call, mark the last content block of the most recent user message for caching (not done)

This creates a "sliding cache breakpoint" — everything up to the breakpoint is cached, and only the newest assistant response + tool results are fresh input. On the next round, the breakpoint advances to include the previously-fresh messages.

**Cache breakpoint limits:** The API allows up to 4 `cache_control` breakpoints per request. This implementation uses 3 (system + tools + last user message), leaving 1 spare.

**Cache write cost:** Creating a cache entry costs 1.25× the input rate. This is amortized across all subsequent reads at 0.1× — any breakpoint that's read at least twice pays for itself. In the moderator's 8-round loop, every breakpoint is read at least once (the immediately following round), making the write cost worthwhile from round 2 onward.

## Implementation Details

### Part 1: Multi-turn conversation caching

In `apps/terminal/src/llm/anthropic.service.ts`, before calling `messages.create()`, inject a `cache_control` breakpoint on the last content block of the last user message in the array.

The `messages` array contains alternating `assistant`/`user` entries where content is either a string (the initial user message) or an array of content blocks (tool_use/tool_result pairs). The implementation must handle both content formats:

- **String content** (first user message): Convert to a content block array with `cache_control` on the single text block
- **Array content** (tool_result messages): Add `cache_control` to the last block in the array

To avoid mutating the caller's data, work on a deep copy of the last user message or use a targeted shallow clone of the last content block.

The `chat()` method signature stays unchanged — callers don't need to know about caching internals. This keeps the caching strategy encapsulated in `AnthropicService`.

**Cache behavior per round:**

```
Round 1: WRITE system + tools + user("Let's complete...") → all cached
Round 2: READ cached prefix, WRITE new asst+user (context results) → extends cache
Round 3: READ cached prefix, WRITE new asst+user (architect result) → extends cache
...
Round 8: READ cached prefix, WRITE new asst+user (store confirmation) → final response
```

Fresh input per round drops from "everything" to "only the latest message pair" (~1-3k tokens instead of the full conversation).

### Part 2: Tool definition caching

In the same `chat()` method, add `cache_control` to the last tool in the tools array before passing to `messages.create()`. Tools don't change between rounds within a turn, so this is a one-time write with 7 subsequent reads.

Same mutation concern applies — clone the last tool object before adding `cache_control` to avoid modifying the caller's tools array.

```typescript
// Sketch — clone last tool and add cache_control
const cachedTools = params.tools ? [...params.tools] : undefined;
if (cachedTools?.length) {
  cachedTools[cachedTools.length - 1] = {
    ...cachedTools[cachedTools.length - 1],
    cache_control: { type: 'ephemeral' as const },
  };
}
```

### Mutation safety

Both parts modify message/tool objects before sending them to the API. The `chat()` method must not mutate the caller's arrays. The recommended approach:

- Shallow-clone the `messages` array
- Shallow-clone only the last user message (the one getting `cache_control`)
- Shallow-clone only the last content block within that message
- Shallow-clone the tools array and only the last tool

This avoids deep-cloning the entire messages array (which can be large) while preventing side effects.

### Expected cost reduction

With both fixes applied (Opus pricing):

| Round | Current fresh input | With caching (fresh only) |
|-------|--------------------|-----------------------|
| 1 | 2.5k | 8.5k (cache write: system + tools + user) |
| 2 | 5.5k | ~2k (new asst + tool_results only) |
| 3 | 7.5k | ~2.5k |
| 4 | 9.5k | ~2k |
| 5 | 12.5k | ~3k |
| 6 | 16.5k | ~3k |
| 7 | 19.5k | ~2k |
| 8 | 20.5k | ~1.5k |
| **Total** | **~94k** | **~24.5k fresh + ~70k cache reads** |

At Opus rates: ~24.5k × $15/MTok + ~70k × $1.5/MTok = $0.37 + $0.11 = **~$0.48** (vs current ~$1.43). Cache write overhead adds ~$0.10, for an estimated total of **~$0.58** — a **~60% reduction**.

## Acceptance Criteria

- [x] `AnthropicService.chat()` injects `cache_control: { type: 'ephemeral' }` on the last content block of the last user message before each API call
- [x] `AnthropicService.chat()` injects `cache_control: { type: 'ephemeral' }` on the last tool in the tools array
- [x] Neither injection mutates the caller's `messages` or `tools` arrays
- [x] String-format user content (initial message) is handled correctly — converted to content block array with cache_control
- [x] The existing system prompt caching (BUG-012) continues to work alongside the new breakpoints
- [x] Total cache_control breakpoints per request does not exceed 4 (API limit)
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` — all existing tests pass, no regressions
- [x] Updated `anthropic.service.spec.ts` tests verify cache_control injection on messages and tools

## Implementation Notes

**Status:** Complete ✅ — Accepted after code review

**Files modified:**
- `apps/terminal/src/llm/anthropic.service.ts` — Added tool definition caching (lines 21-31) and conversation message caching (lines 33-73). Extracted shared `CACHE_CONTROL` constant. Refactored system prompt to use same constant.
- `apps/terminal/src/llm/anthropic.service.spec.ts` — Restructured from 5 tests to 15 tests. Extracted shared `mockResponse` and `getCallArgs()` helpers. Added dedicated sections for system prompt caching, tool definition caching, conversation message caching (string + array), mutation safety (tools + messages), edge cases, and breakpoint count verification.

**Deviations from ticket:** None. Implementation follows the ticket's design precisely — shallow cloning at each mutation point, reverse loop for last-user-message detection, string-to-block conversion, `Record<string,unknown>` cast for union narrowing.

**Verification results:**
- `npm run build`: 4 apps compiled successfully
- `npm run lint`: Zero errors, zero warnings
- `npm run test`: 527 tests, 39 suites, all pass
- Breakpoint count: Verified at most 3 per request (system + tools + last user message), under the API limit of 4

## Dependencies and References

- **Prerequisite:** QRM4-BUG-012 (moderator prompt caching and cost tracking) — already implemented, provides system prompt caching and cost visibility
- **Files to modify:** `apps/terminal/src/llm/anthropic.service.ts`
- **Test file:** `apps/terminal/src/llm/anthropic.service.spec.ts`
- **Anthropic docs:** Prompt caching — supports `cache_control` on system blocks, tool definitions, and message content blocks; max 4 breakpoints per request
- **Observed in:** Run 10 session report (`logs/sessions/2026-04-10-qrm4-run10.md`) — moderator cost $1.43 for 8-round orchestration