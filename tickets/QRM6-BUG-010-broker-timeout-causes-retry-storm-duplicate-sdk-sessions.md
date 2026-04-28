# QRM6-BUG-010: Broker Role Timeout Causes Retry Storm With Duplicate Concurrent SDK Sessions

**Status: Ready**

## Summary

When an agent invocation exceeds its per-role timeout in `ROLE_TIMEOUTS`, the broker returns `success: false, error: "Agent <role> invocation timed out"` to the moderator while the agent's `/invoke` HTTP handler keeps running on the agent side (the abort closes the socket but does not cancel the in-flight `ClaudeCodeService.execute`). The moderator interprets the failure as the agent being offline and retries with the same `correlationId`. Each retry spawns a fresh `query()` SDK session in the same container — no idempotency, no deduplication. During a 2026-04-25 session, the architect ran the **same research task three times concurrently** for $7.00 total ($2.87 + $1.02 + $3.11) before any of them returned. The user-visible symptom is "the architect went offline" even though `docker ps` shows the container healthy throughout.

## Problem Statement

Reproduced spontaneously during a QRM6-BUG-005 investigation session on 2026-04-25 (correlationId `fad31bbe-8d85-4541-928c-3bc8c0dcf71a`):

```
18:25:26  invoke_agent: moderator → architect (research task)
18:25:27  Architect SDK session #1 starts: dde4a77c-...
18:30:26  WARN [HttpAgentConnection] Agent architect invocation timed out  ← 5min broker timeout
18:30:26  Completed: target=architect success=false                          ← moderator sees "failure"
18:30:13  invoke_agent: moderator → architect [retry, SAME correlationId]    ← moderator retries
18:30:14  Architect SDK session #2 starts: f584ddc3-... (concurrent with #1)
18:32:29  invoke_agent: moderator → architect [retry #2, SAME correlationId] ← second retry
18:32:30  Architect SDK session #3 starts: b52a5e24-... (concurrent with #1, #2)
18:35:13  WARN [HttpAgentConnection] Agent architect invocation timed out    ← session #2 hits 5min
18:37:01  Invocation complete: session #1 — 50 turns, $2.8725, 11m 34s
18:37:29  WARN [HttpAgentConnection] Agent architect invocation timed out    ← session #3 hits 5min
18:37:56  Invocation complete: session #3 — 20 turns, $1.0228, 5m 26s
18:38:19  Invocation complete: session #2 — 84 turns, $3.1096, 8m 5s
```

Three separate SDK runs, three separate sessionIds, identical inputs. None of the three could be reused — by the time the first returned, all three timeouts had fired and the moderator had already abandoned the architect for the developer. **Total wasted: $7.00 and ~25 minutes of architect compute on three identical research tasks.**

The moderator's CC CLI summarized this as "architect and teamlead containers are down — only the developer is running" and offered to restart them. Both containers had been `Up 6 hours (healthy)` the whole time. The teamlead never received any invocation in this run; the moderator inferred its absence from a separate transport-drop signal in the same window.

### Why this is severe

- **Cost amplification.** Any task that exceeds the role timeout becomes 2–3× more expensive (or worse, if the moderator's retry loop is more aggressive). Architect tasks are particularly affected because the role's 5-minute ceiling does not match real research/design timing — every architect session in `architect-20260425T174717.jsonl` that exceeded 5 minutes was a candidate for this bug.
- **Misleading failure signal.** The moderator cannot distinguish "agent crashed" from "agent is busy past its timeout". It sees `success=false` and assumes the worst, which leads to user-facing claims like "containers are down" that are factually wrong and erode trust in the orchestration layer.
- **Interaction with QRM6-BUG-005.** The retry storm depends on the SDK *not* resuming the prior session. If resume worked, retries would at least pick up where the prior session left off. Since resume silently no-ops (BUG-005), each retry is fully fresh. The two bugs amplify each other: BUG-005 makes retries useless; this bug ensures retries happen.
- **Race conditions on shared state.** Three concurrent SDK sessions in the same container write to `~/.claude/projects/<encoded-cwd>/` simultaneously, each holding a different `sessionId`. They also issue MCP `context_store` writes against overlapping keys (`session-resume-fix-options`, `QRM6-BUG-005-sdk-research`) — last-write-wins, so the first two finishers' work is silently overwritten. In the 2026-04-25 incident, the *third* finisher (session #2, 8 minutes, 84 turns) was the canonical version persisted to the store; the first two were thrown away.

### Why the moderator retries

The moderator (CC CLI) sees three signals during a long architect invocation:
1. The MCP `invoke_agent` tool call returns `{ success: false, error: "Agent architect invocation timed out" }` after 5 minutes.
2. The MCP transport (Streamable HTTP) keeps cycling open/close as the moderator's CC CLI re-establishes its session — the QRM5-BUG-003 pattern. From the moderator's view, this looks like connection instability.
3. There is no liveness probe distinguishing "busy" from "dead". `agent.isConnected()` always returns `true` for `HttpAgentConnection` (line 49–51).

A retry with the same correlationId is a reasonable response to (1) given (2) and (3). The bug is on the receiving side: the agent doesn't recognize the duplicate.

## Design Context

### The two-layer timeout

`apps/mcp-server/src/messaging/message-broker.service.ts:78–100,144–169` and
`apps/mcp-server/src/registry/http-agent-connection.ts:53–111`

Two timeouts wrap every invocation:

1. **`HttpAgentConnection.handle`** — wraps `undiciFetch` with an `AbortController` keyed off the same `timeout`. On timeout, the fetch promise rejects with `AbortError`, the handler logs `"Agent <role> invocation timed out"`, and returns `{ success: false, error: ... }`. **The HTTP socket closes, but the agent's `/invoke` request handler keeps running** — Nest's `InvocationController` has no `@Req() onClose` hook to cancel `claudeCode.execute()`.
2. **`MessageBroker.deliverWithTimeout`** — races `agent.handle(request, timeout)` against a `setTimeout(timeout)`. On timeout, resolves with `{ success: false, error: 'Agent <target> timed out after <timeout>ms' }`. This is redundant with (1) for `HttpAgentConnection` but matters for connections that don't honor the timeout themselves (e.g., `McpElicitationConnection` before QRM6-BUG-008).

The end-to-end effect is: **the broker reports failure on time, but the agent keeps spending tokens.**

### The agent has no in-flight registry

`apps/agent/src/connection/invocation-handler.service.ts:72–113`

`InvocationHandler.handle()` is stateless. There is no `Map<correlationId, Promise<InvokeResponse>>`. Every call to `/invoke` invokes `claudeCode.execute()` unconditionally. Two simultaneous POSTs with the same `correlationId` produce two `query()` calls and two SDK subprocesses — they don't even share work, since the SDK's `query()` opens its own subprocess each time.

### The role timeout values

`apps/mcp-server/src/messaging/role-timeouts.ts`

```typescript
[AgentRole.architect]:  5 * 60_000,  // ← exceeded by ~every research/multi-file design review
[AgentRole.teamlead]:  10 * 60_000,
[AgentRole.developer]: 30 * 60_000,
[AgentRole.qa]:        15 * 60_000,
```

The architect ceiling was set in the original Safeguard 4 ticket without empirical data on real architect tasks. The 2026-04-25 incident's three sessions ran 11m 34s, 8m 5s, 5m 26s — all above 5 minutes. A single design-review or research task crossing the boundary is enough to trigger the storm.

### What the moderator sees

The broker's error message (`"Agent architect invocation timed out"`) does technically distinguish timeout from unreachability — but the moderator's prompt-level decision logic treats any `success: false` from the broker as a signal to escalate or retry. The error string is a hint, not a structured signal.

## Decision

**Scope: Layer 1 (required) + Layer 3 (recommended)**

We are implementing:

- **Layer 1 — Idempotency map in `InvocationHandler`** keyed by `correlationId`. This is the load-bearing fix: duplicate invocations with the same correlationId attach to the in-flight promise instead of spawning a new SDK session. Directly prevents the triple-charge duplication observed in the 2026-04-25 incident.
- **Layer 3 — Architect timeout bump to 15 minutes.** Aligns the architect role timeout with empirical task durations (5–12 min observed) so the broker stops triggering timeouts on routine research/design tasks.

We are **not** implementing in this ticket:

- **Layer 2 (cancel SDK on HTTP socket close)** — The refcount complexity (cancel only when ALL requests for a correlationId have disconnected) is not justified until runaway-finishes-nobody-wants prove costly in practice. Layer 1 alone prevents duplicate work. See Icebox for the combined Layer 1 + Layer 2 future improvement.
- **Layer 4 (structured `failureReason` in `InvokeResponse`)** — Useful long-term but larger than this ticket's scope. The moderator's retry behavior can be addressed independently.

**Rationale:** Layer 1 alone solves the $7 triple-charge duplication problem from the 2026-04-25 incident. Layer 3 eliminates the most common trigger (architect tasks routinely exceeding 5 minutes). Together they address the immediate cost and reliability concern without introducing the refcount tracking complexity that Layer 2 requires.

## Implementation Details

The fix has three independent layers. Layer 1 is the load-bearing change; layers 2 and 3 are defense-in-depth.

### Layer 1 (required) — Idempotency on the agent side, keyed by `correlationId`

`apps/agent/src/connection/invocation-handler.service.ts`

Maintain a `Map<string, Promise<InvokeResponse>>` of in-flight invocations:

```typescript
private readonly inflight = new Map<string, Promise<InvokeResponse>>();

async handle(request: InvokeRequest): Promise<InvokeResponse> {
  const existing = this.inflight.get(request.correlationId);
  if (existing) {
    this.logger.log(
      `Duplicate invocation reusing in-flight: correlationId=${request.correlationId}`,
    );
    return existing;
  }
  const work = this.runInvocation(request).finally(() => {
    this.inflight.delete(request.correlationId);
  });
  this.inflight.set(request.correlationId, work);
  return work;
}
```

Where `runInvocation` is the body that previously lived inline in `handle`. This guarantees that retry-with-same-correlationId attaches to the original SDK session instead of starting a new one. The first finisher wins; any retry that arrives before completion gets the same response.

**Why on the agent and not the broker:** the broker already times out the connection, so it cannot wait long enough to deliver the eventual real result to a retry. The agent owns the actual work, and only the agent can decide "this is the same job; piggyback on the existing run."

**Why the response is forwarded to all retries:** the second/third retries' HTTP fetches will likely have *also* aborted by the time the original work finishes, so the response goes nowhere. That's fine. The cost was already paid by the first call; the retries simply got their `success=false` from the broker timeout. The point of the dedupe is to **prevent additional work**, not to deliver duplicate responses.

**Edge case — Bootstrap context drift:** the second retry's `request.bootstrapContext` may differ from the first if the context store has changed in the meantime. We deliberately use the *first* call's bootstrap. This is correct: the retry exists because the first call is still running, so the first call's bootstrap is the canonical input for "this correlationId."

### Layer 2 (recommended) — Cancel the SDK on HTTP socket close

`apps/agent/src/connection/invocation.controller.ts` (and `claude-code.service.ts`)

When the moderator's HTTP request aborts (via the broker's `AbortController.abort()`), the agent's `req.on('close')` event fires. We should pipe that into an `AbortController` passed to `claudeCode.execute()`, which the SDK's `query()` already supports via its options. This stops the runaway session before it consumes more tokens.

```typescript
@Post('/invoke')
async invoke(@Req() req: Request, @Body() request: InvokeRequest) {
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  return this.handler.handle(request, abort.signal);
}
```

`ClaudeCodeService.execute` then plumbs the signal into `query({ ..., abortController: abort })`.

**Caveat — interaction with Layer 1.** If two requests arrive for the same correlationId, the second's HTTP socket closing should *not* cancel the first's work. The `AbortController` should be per-request, but the `query()` call (started by the first) belongs to the in-flight Promise, not the request. Concretely: cancel the SDK only if **all** requests for that correlationId have aborted. Tracking refcounts here is fiddly; the simpler safe option is to **not cancel on close at all** and rely on Layer 1 to prevent new work — at the cost of letting the first runaway finish billable. Pick based on cost-vs-complexity preference.

### Layer 3 (recommended) — Adjust architect timeout, document the rationale

`apps/mcp-server/src/messaging/role-timeouts.ts`

Bump architect to 15 minutes (matches QA, gives design review and SDK research enough headroom):

```diff
- [AgentRole.architect]:  5 * 60_000,
+ [AgentRole.architect]: 15 * 60_000,
```

Add a comment near the table summarizing the empirical basis:

> Architect: research/design tasks observed 5–12 min on the 2026-04-25 SDK
> investigation; bumped to 15 min to absorb the long tail. See QRM6-BUG-010.

Do not extend timeouts indiscriminately — long timeouts are a real cost when an agent *does* die mid-call. The 30-minute developer timeout already pushes the boundary of patience for a stuck call.

### Layer 4 (consider, don't insist) — Structured failure mode in `InvokeResponse`

Currently the broker returns `{ success: false, error: string }`. The error string is the only way to distinguish "timeout while busy" from "agent unreachable" or "agent rejected the request." If the moderator's retry behavior is sensitive to this distinction, consider:

```typescript
interface InvokeResponse {
  success: false;
  error: string;
  failureReason?: 'timeout' | 'unreachable' | 'rejected' | 'unknown';
}
```

…and update the moderator's prompt or `ChatService` to suppress retries when `failureReason === 'timeout'`. This is the cleanest long-term answer but is larger than this ticket — file a follow-up if the team wants it.

### Out of scope

- Restructuring the broker's two-layer timeout into a single layer — the redundancy is defensive and harmless.
- Solving the underlying SDK resume bug ([QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md)) — independent fix; once resume works, retries become cheaper but the retry-storm pattern is still wrong.
- The MCP transport instability that contributes to the moderator's "agent down" inference — see QRM5-BUG-003 / QRM6-BUG-007.
- Distributed deduplication across agent containers (e.g., a shared Redis key) — single-container is sufficient because the broker only routes a given role to one connection.

## Acceptance Criteria

- [ ] `InvocationHandler.handle` returns the same `Promise<InvokeResponse>` when called twice with identical `correlationId` while the first call is still running
- [ ] Unit test in `apps/agent/src/connection/invocation-handler.service.spec.ts` asserts the dedupe: two concurrent `handle()` calls with same correlationId result in **one** `claudeCode.execute()` invocation
- [ ] Reproduce the 2026-04-25 incident in an integration setting (architect with 5-min timeout, research task that takes 7+ min). After the fix, broker reports timeout once; subsequent retries with the same correlationId return immediately without spawning new SDK sessions; logs show one `Session started` not three
- [ ] Architect role timeout bumped to 15 minutes in `role-timeouts.ts` with a comment referencing this ticket
- [ ] Smoke runbook (`docs/smoke-test-runbook.md`) gains a scenario: "architect long-running task + moderator retry should not double-charge"
- [ ] `npm run build`, `npm run lint`, `npm run test` pass

## Icebox

### Layer 1 + Layer 2 with refcounting

Cancel the SDK session only when ALL requests for a given correlationId have disconnected. This is the optimal solution — it prevents both duplicate work (Layer 1's idempotency map) AND runaway token spend on sessions nobody is waiting for (Layer 2's abort-on-close). However, it requires refcount tracking across HTTP requests mapped to the same in-flight promise: each new request for an existing correlationId increments the refcount, each `req.on('close')` decrements it, and the `AbortController` fires only when the count hits zero. Deferred because the complexity is not justified until runaway-finishes-nobody-wants prove costly in practice. Layer 1 alone solves the $7 triple-charge duplication problem from the 2026-04-25 incident — the first session's work is reused by retries, so even if it finishes after the broker has timed out, no additional SDK sessions are spawned.

## Dependencies and References

### Prerequisites
- None — agent-side change is independent

### What This Blocks
- Practical reliability of architect for any non-trivial design or research task
- Cost predictability — without this, every architect timeout multiplies cost by retry count
- Confidence in the moderator's "agent down" claims (currently unreliable)

### Relationship to Other Bugs
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — amplified by this bug; with resume broken, retries are pure waste. Together they cause the worst-case cost.
- [QRM6-BUG-007](QRM6-BUG-007-mcp-session-cleanup-not-firing.md) — independent. Related in that both bugs cause the moderator to misjudge agent liveness.
- [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md) — same shape (timeout on a slow human-in-the-loop, retry loop). BUG-008 already fixed the moderator-elicitation side; this ticket fixes the architect/teamlead/developer side.

### References
- `apps/mcp-server/src/messaging/message-broker.service.ts:78–100` — broker reads role timeout, races `deliverWithTimeout`
- `apps/mcp-server/src/messaging/message-broker.service.ts:144–169` — `deliverWithTimeout` implementation
- `apps/mcp-server/src/registry/http-agent-connection.ts:53–111` — fetch with `AbortController`, error mapping
- `apps/mcp-server/src/messaging/role-timeouts.ts:6` — `[AgentRole.architect]: 5 * 60_000`
- `apps/agent/src/connection/invocation-handler.service.ts:72–113` — stateless handler, no idempotency
- `logs/architect-20260425T174717.jsonl` — three concurrent sessions for correlationId `fad31bbe-...` (sessions `dde4a77c`, `f584ddc3`, `b52a5e24`)
- `logs/mcp-server-20260425T174711.jsonl` — three `invoke_agent` calls and three `Agent architect invocation timed out` warnings, all on the same correlationId
- **Discovered during:** QRM6-BUG-005 SDK resume investigation, 2026-04-25. The architect was tasked with researching SDK resume behavior; the research itself fell into this trap and ran 3× concurrently. The user noticed the cost and the moderator's misdiagnosis ("containers are down") and asked for a postmortem.