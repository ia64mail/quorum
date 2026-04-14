# QRM5-001: Agent Session Resume via Moderator-Driven Session Routing

## Summary

Enable Claude Code SDK session persistence for all agents and let the moderator decide whether follow-up invocations should resume an existing session or start fresh. Agents report their session ID in responses; session IDs are stored in the Context Store so the moderator (and potentially other agents) can reference them for future invocations.

## Problem Statement

Every agent invocation currently starts a cold session (`persistSession: false` at `apps/agent/src/llm/claude-code.service.ts:39`). When the moderator sends sequential tasks to the same role within a workflow — e.g., asking the architect to "design the auth module" then "clarify the token refresh strategy" — the second invocation has zero memory of the first. The agent re-reads `quorum.md`, re-discovers the codebase, re-queries the Context Store, and re-reasons about decisions it already made.

**Current cost:** In Run 10, the teamlead had 4 sequential invocations at $2.91 total. An estimated 20-30% of that is cold-start overhead — re-establishing context that was already built in a prior session.

**What we lose without this:**
- Token waste on repeated context discovery
- Risk of inconsistent reasoning when an agent re-derives decisions it already made
- Inability to have a "conversation" with a specific agent across invocations

The original ICEBOX sketch (Icebox #3) placed session routing logic inside `InvocationHandler` with a `Map<correlationId:role, sessionId>` heuristic — automatic resume for same-role + same-correlation. This ticket replaces that with moderator-driven routing, which is both simpler in agent code and smarter in decision quality.

## Design Context

### Why the moderator decides

The moderator has the full conversation context to judge whether a follow-up benefits from prior session state:

| Scenario | Moderator decision | Reason |
|----------|-------------------|--------|
| "Clarify what you said about auth" → architect | **Resume** | Prior analysis is directly relevant |
| "Now implement a different ticket" → developer | **Fresh** | Prior context would be noise |
| "Review the developer's code" → teamlead | **Fresh** | Independent perspective is the point |
| "Add error handling to the endpoint you just wrote" → developer | **Resume** | Same code, same context |

No heuristic in the agent layer can match this judgment. The moderator already tracks the workflow — it knows what it asked each agent and whether continuity or a clean slate serves the next question better.

### How it fits the existing architecture

The design leverages infrastructure that already exists:

- **`ExecuteResult.sessionId`** — already captured from the SDK (`claude-code.types.ts:51`), currently logged but discarded before building `InvokeResponse`
- **Context Store (conversation scope)** — natural home for session IDs, keyed by `{role}:{correlationId}`, with TTL-based expiry for cleanup
- **Bootstrap context injection** — could surface available session IDs to the moderator in the future
- **`invoke_agent` schema** — the natural place for an optional `sessionId` parameter
- **Moderator tool loop** — already receives and processes `InvokeResponse`; adding session tracking requires no architectural changes

### SDK session persistence model

The Claude Agent SDK supports two relevant parameters on `query()`:
- `persistSession: true` — saves session state to disk after the call completes
- `resume: '<sessionId>'` — resumes a previously persisted session (conversation history, tool state)

Agent containers store session data in `~/.claude` (256 MB tmpfs). Sessions survive across invocations within the same container lifetime but are lost on container restart. This is acceptable — the typical workflow is a single `docker compose up` session.

### Upstream SDK blockers (informational, not blocking)

Two SDK issues affect **prompt cache efficiency** but not **functional session resume**:
- [claude-agent-sdk#247](https://github.com/anthropics/claude-agent-sdk-typescript/issues/247) — MCP server configs non-serializable, busts prompt cache on every `query()` call
- [claude-agent-sdk#192](https://github.com/anthropics/claude-agent-sdk-typescript/issues/192) — Random UUID in Bash tool description invalidates prompt cache between calls

With these issues unresolved, session resume provides **conversation continuity** (the LLM sees prior turns, avoids re-reading files, avoids re-querying Context Store) but not **prompt cache hits** (system prompt still reprocessed). Once fixed upstream, prompt caching kicks in automatically with no Quorum-side changes needed.

**Decision:** These issues do NOT block implementation. Session continuity alone is valuable — it eliminates redundant file reads, Context Store queries, and re-reasoning. Prompt cache savings are a future bonus.

## Implementation Details

### 1. Surface `sessionId` in `InvokeResponse`

Currently `InvocationHandler.handle()` (`invocation-handler.service.ts:90-102`) maps `ExecuteResult` to `InvokeResponse` and drops `sessionId`. Add it to the response type:

```typescript
// libs/common/src/messaging/invoke.types.ts
export interface InvokeResponse {
  // ... existing fields ...
  /** SDK session ID — enables session resume on follow-up invocations. */
  sessionId?: string;
}
```

The handler maps it on success: `sessionId: result.sessionId`.

### 2. Accept `sessionId` in `InvokeRequest`

Add an optional field for callers to request session resume:

```typescript
// libs/common/src/messaging/invoke.types.ts
export interface InvokeRequest {
  // ... existing fields ...
  /** Resume a prior SDK session instead of starting fresh. */
  sessionId?: string;
}
```

### 3. Plumb `sessionId` through the invoke_agent tool schema

Add optional `sessionId` parameter to the `invoke_agent` MCP tool registration (`apps/mcp-server/src/mcp/mcp.service.ts`). The broker passes it through to `InvokeRequest` — no broker-side logic needed.

### 4. Enable session persistence in `ClaudeCodeService`

```typescript
// apps/agent/src/llm/claude-code.service.ts
// Change persistSession: false → true
// Add resume param from ExecuteParams

// apps/agent/src/llm/claude-code.types.ts
export interface ExecuteParams {
  // ... existing fields ...
  /** Resume a persisted session by ID. */
  resume?: string;
}
```

In `ClaudeCodeService.execute()`, pass `persistSession: true` and `resume: params.resume ?? undefined` to the SDK `query()` call.

### 5. Pass `sessionId` from request to SDK

`InvocationHandler.handle()` forwards `request.sessionId` as `resume` in the `ExecuteParams`:

```typescript
const result = await this.claudeCode.execute({
  // ... existing params ...
  resume: request.sessionId,
});
```

### 6. Moderator-side session tracking

The moderator (Terminal App) tracks session IDs returned in `InvokeResponse` and includes them in subsequent `invoke_agent` calls when it judges that session continuity is beneficial. Two approaches (to be decided during implementation):

**Option A — Context Store**: Store `session:{role}:{correlationId} → sessionId` in conversation scope via `context_store`. The moderator queries before invoking.

**Option B — In-memory map in ChatService**: Simpler, but lost on terminal restart. Since the terminal already holds full conversation state in memory during a session, this may be sufficient.

Both approaches are viable. Option A is more aligned with the pull-based context model; Option B is simpler and avoids Context Store churn. The moderator's system prompt needs a brief addition explaining when to reuse sessions vs. start fresh.

### 7. Graceful fallback on resume failure

If an agent can't find the persisted session (container restarted, tmpfs cleared), the SDK should fall back to a fresh session. Verify that the SDK handles missing session IDs gracefully — if it throws, catch and retry without `resume`.

## Acceptance Criteria

- [ ] `InvokeResponse` includes optional `sessionId` field
- [ ] `InvokeRequest` includes optional `sessionId` field
- [ ] `invoke_agent` MCP tool schema accepts optional `sessionId` parameter
- [ ] `ClaudeCodeService` uses `persistSession: true` and passes `resume` when provided
- [ ] `InvocationHandler` forwards `request.sessionId` to `ClaudeCodeService` and returns `result.sessionId` in response
- [ ] Moderator receives `sessionId` in tool call results from `invoke_agent`
- [ ] Moderator can pass `sessionId` on follow-up `invoke_agent` calls
- [ ] Resume failure (missing session) falls back to fresh session without error
- [ ] Existing tests updated; new tests cover resume path and fallback
- [ ] E2E validation: sequential invocations to the same agent with session resume show the agent retaining prior context

## Dependencies and References

- **Supersedes:** ICEBOX #3 (Agent Session Resume via Correlation ID) — same goal, different routing strategy
- **Builds on:** QRM4 bootstrap context injection (agents already receive prior decisions; session resume adds conversational continuity)
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone
- **Upstream SDK issues (non-blocking):** [#247](https://github.com/anthropics/claude-agent-sdk-typescript/issues/247), [#192](https://github.com/anthropics/claude-agent-sdk-typescript/issues/192) — affect prompt cache efficiency, not session resume functionality
- **Key files:**
  - `libs/common/src/messaging/invoke.types.ts` — `InvokeRequest`, `InvokeResponse` types
  - `apps/agent/src/llm/claude-code.service.ts` — SDK `query()` call, `persistSession` flag
  - `apps/agent/src/llm/claude-code.types.ts` — `ExecuteParams`, `ExecuteResult`
  - `apps/agent/src/connection/invocation-handler.service.ts` — request→SDK→response mapping
  - `apps/mcp-server/src/mcp/mcp.service.ts` — `invoke_agent` tool schema
  - `apps/terminal/src/chat/chat.service.ts` — moderator tool loop (session tracking)