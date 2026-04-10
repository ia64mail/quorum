# QRM4-BUG-012: Moderator Prompt Caching and Cost Tracking

## Summary

The terminal moderator (raw Anthropic SDK path) sends the full system prompt on every API call without prompt caching, and its costs are invisible — not tracked, not displayed in the activity feed. Agent costs are visible via the Claude Code SDK's `total_cost_usd`, but the moderator's per-turn API spend is a blind spot.

## Problem Statement

Two related gaps in the terminal moderator's LLM integration:

**1. No prompt caching.** The moderator's `processWithLoop()` makes up to 10 `messages.create()` calls per user turn. Each call re-sends the full system prompt (~4-8KB: SYSTEM_PREAMBLE + moderator template + quorum.md). The Anthropic SDK supports `cache_control` on system prompt blocks, but we pass the prompt as a plain string with no cache directives. After the first call, subsequent calls could read the system prompt from cache at 1/10th the input token cost.

**2. No cost visibility.** The `Message` object returned by `messages.create()` includes a `usage` field with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. This data is returned by `AnthropicService.chat()` but never inspected — `processWithLoop()` only reads `response.content` and `response.stop_reason`. Meanwhile, agent costs are fully visible in the activity feed (e.g., `← developer (1m13s, $0.43)`), and in session reports. The moderator shows "—" for cost.

**Risks of not doing it:**
- Paying full input token price on 9 out of 10 rounds per user turn — pure waste
- No visibility into the largest per-session API consumer (moderator makes the most calls)
- Session cost reports undercount total spend

## Design Context

The terminal moderator uses the raw `@anthropic-ai/sdk` (v0.73.0) — not the Claude Code SDK — because it's a pure orchestrator, not a code-writing agent. The SDK's `messages.create()` accepts the `system` parameter in two forms:

1. **String** (current): `system: "prompt text"` — no caching possible
2. **Array of content blocks**: `system: [{ type: "text", text: "...", cache_control: { type: "ephemeral" } }]` — enables caching

The Claude Code SDK (agent path) already handles prompt caching internally — no changes needed there. However, there are known upstream issues that likely degrade caching effectiveness for Quorum's agent path specifically:

- **[anthropics/claude-agent-sdk-typescript#247](https://github.com/anthropics/claude-agent-sdk-typescript/issues/247):** Prompt caching fails when MCP servers are configured — server configs are not serializable, invalidating the cache on every resume query. Quorum agents pass `mcpServers` on every `query()` call (`invocation-handler.service.ts:73`), so caching may be partially or fully broken in practice.
- **[anthropics/claude-agent-sdk-typescript#192](https://github.com/anthropics/claude-agent-sdk-typescript/issues/192):** A random UUID in the built-in Bash tool description changes between `query()` calls, busting the cache. Caching works *within* a single agentic loop but not across separate `invoke_agent` invocations.
- **[anthropics/claude-agent-sdk-typescript#188](https://github.com/anthropics/claude-agent-sdk-typescript/issues/188):** The SDK defaults to `ephemeral_1h` (1-hour TTL) instead of `ephemeral` (5-minute TTL). Cache writes at 1-hour cost 2× the input rate vs 1.25× for 5-minute — a cost surprise.
- **[anthropics/claude-agent-sdk-typescript#89](https://github.com/anthropics/claude-agent-sdk-typescript/issues/89):** No user-facing API to control cache breakpoints. The SDK places `cache_control` on every system prompt block, risking 400 errors when >4 blocks exist.

These are upstream SDK limitations — not actionable in Quorum today, but worth tracking for future optimization once the SDK exposes cache control or fixes these issues.

## Implementation Details

### Part 1: Prompt caching

In `apps/terminal/src/llm/anthropic.service.ts`, change the `system` parameter from a plain string to an array with a single `cache_control` breakpoint:

```typescript
system: [
  {
    type: 'text' as const,
    text: params.system,
    cache_control: { type: 'ephemeral' },
  },
],
```

This caches the entire system prompt (preamble + moderator template + quorum.md) as a single block. The content is effectively static for the entire session — quorum.md is loaded once at startup and never reloaded. The default TTL is 5 minutes, which comfortably covers a multi-round tool loop and consecutive user turns.

No need to split into multiple blocks — the entire system prompt is session-static.

### Part 2: Cost tracking with hardcoded pricing

Add a pricing utility that converts token counts from `response.usage` to USD. Hardcode per-model rates as constants since the Anthropic SDK does not expose pricing information.

Create `apps/terminal/src/llm/pricing.ts` with:
- A `MODEL_PRICING` map keyed by model ID string, with `inputPerMToken`, `outputPerMToken`, `cacheReadPerMToken`, and `cacheWritePerMToken` rates
- Include at minimum: `claude-sonnet-4-5-20250929` and `claude-opus-4-6` (the two models currently used)
- A `calculateCostUsd(model: string, usage: Usage): number` function
- A fallback for unknown models — log a warning and return 0 rather than crashing

The `Usage` type from the SDK includes:
- `input_tokens` — standard input pricing
- `output_tokens` — standard output pricing
- `cache_creation_input_tokens` — charged at cache write rate (1.25× input)
- `cache_read_input_tokens` — charged at cache read rate (0.1× input)

### Part 3: Accumulate and display per-turn cost

In `apps/terminal/src/chat/chat.service.ts`, modify `processWithLoop()`:

1. Accumulate `response.usage` across all rounds in the loop (sum token counts)
2. After the loop completes, call `calculateCostUsd()` with accumulated usage
3. Return the cost alongside the response text — adjust the return type or add a side-channel (e.g., store on `this` and read after `processWithLoop()` returns)
4. Display the moderator's per-turn cost after its response, matching the existing activity feed style — e.g., `Moderator ($0.12): "Here's what happened..."`

The exact display format should integrate naturally with the existing activity feed. The key data to show is the USD cost; optionally include token breakdown for debug-level logging.

### Part 4: Pricing comment in .env.example

Add a comment in `.env.example` next to `ANTHROPIC_MODEL` reminding that pricing constants are hardcoded and linked to this model selection:

```env
# NOTE: Token pricing for moderator cost tracking is hardcoded per model
# in apps/terminal/src/llm/pricing.ts — update if changing ANTHROPIC_MODEL
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
```

## Acceptance Criteria

- [x] `AnthropicService.chat()` sends the system prompt as a content block array with `cache_control: { type: "ephemeral" }`
- [x] `processWithLoop()` accumulates `response.usage` across all rounds
- [x] Moderator per-turn cost (USD) is displayed in the terminal after each moderator response
- [x] Hardcoded pricing constants exist for `claude-sonnet-4-5-20250929` and `claude-opus-4-6`
- [x] Unknown model falls back gracefully (warning log, $0.00 cost) rather than crashing
- [x] `.env.example` contains a comment linking `ANTHROPIC_MODEL` to the hardcoded pricing file
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` — all existing tests pass, no regressions

## Dependencies and References

- **Files to modify:** `apps/terminal/src/llm/anthropic.service.ts`, `apps/terminal/src/chat/chat.service.ts`, `.env.example`
- **Files to create:** `apps/terminal/src/llm/pricing.ts`
- **Related ticket:** QRM4-BUG-005 (moderator activity feed) — established the display format this ticket extends
- **Anthropic docs:** Prompt caching — `cache_control: { type: "ephemeral" }` on system content blocks
- **SDK type:** `Usage` from `@anthropic-ai/sdk/resources/messages/messages`

## Implementation Notes

**Status:** ✅ Accepted

**Files modified:**
- `apps/terminal/src/llm/anthropic.service.ts` — System prompt now sent as content block array with `cache_control: { type: 'ephemeral' }`
- `apps/terminal/src/chat/chat.service.ts` — `processWithLoop()` returns `{ text, costUsd }`, accumulates usage across rounds, `handleInput()` displays `Moderator ($X.XX): ...` format
- `.env.example` — Comment linking `ANTHROPIC_MODEL` to `pricing.ts`

**Files created:**
- `apps/terminal/src/llm/pricing.ts` — `MODEL_PRICING` map, `TokenUsage` interface, `calculateCostUsd()` function with unknown-model fallback
- `apps/terminal/src/llm/index.ts` — Barrel re-export for `calculateCostUsd` and `TokenUsage`

**Test updates:**
- `anthropic.service.spec.ts` — System parameter assertion updated from string to content block array format
- `chat.service.spec.ts` — Added `defaultUsage` helper, `usage` field to mock responses, updated `callProcessWithLoop` return type and assertions for `{ text, costUsd }` shape, added `mockConfig.anthropic.model`

**Deviations:** None — implementation matches ticket specification exactly.

**Verification:** `npm run build` (4/4 webpack builds), `npm run lint` (clean), `npm run test` (477/477 pass, 38/38 suites)