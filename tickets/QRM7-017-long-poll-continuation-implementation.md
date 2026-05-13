# QRM7-017: Long-Poll Continuation Implementation

**Status:** Open

## Summary

Implement the long-poll continuation pattern designed in QRM7-015 (research, accepted). When the moderator calls `invoke_agent` targeting a role whose `ROLE_TIMEOUTS` exceeds 270 s (4 min 30 s), the server races the broker's `deliverWithTimeout` against a 4 min 30 s server timer. If the broker wins, the result returns inline (zero overhead, identical to today's sync path). If the timer wins, the server stores the in-flight invocation in a new `InvocationResultStore` and returns `{ status: "pending", invocationId }`. The moderator then calls `wait_invocation(invocationId)` — a new MCP tool — to continue waiting, repeating until the result lands. Agent-to-agent calls are unaffected; they continue on the 35-min undici dispatcher.

## Problem Statement

When the moderator calls `invoke_agent(target=developer)` and the developer takes >5 minutes, undici's `bodyTimeout = 300_000 ms` inside CC CLI kills the POST response body. The MCP SDK writes the JSON-RPC result after the broker resolves, but the POST's `Response` is already dead. The agent's work is committed and real; only the response envelope is lost — triggering duplicate invocations, context-store key collisions, wasted LLM spend ($0.50-$2 per duplicate), and a frozen-UX window.

QRM7-014's POST-path keepalive pings reset undici's body-timeout counter and eliminated the classic 5-min boundary failure class, but sporadic failures at non-bodyTimeout intervals (~6% rate) remain. The long-poll continuation pattern makes the response delivery protocol resilient to any POST failure: the `InvocationResultStore` holds the result until retrieved, and each `wait_invocation` call opens a fresh POST.

## Design Context

This ticket implements the single recommended design from **QRM7-015 § Recommended Design: Long-Poll Continuation**. All design decisions, rationale, failure mode analysis, and empirical evidence live in QRM7-015 — this ticket is the implementation breakdown, not a re-derivation.

Key design properties (from QRM7-015):
- Sub-5-min calls: zero overhead — one synchronous tool call, identical to today
- Long calls (20-min task): ~4 continuations at ~$0.10 each ≈ $0.40 total
- Completion latency: <1 s (broker resolves into held POST immediately)
- Esc-and-resume: works — invocation continues server-side; `wait_invocation` picks up
- Caller-aware: moderator-only long-poll; agent-to-agent stays on 35-min sync dispatcher

## Implementation Details

Four code units plus a CLAUDE.md rule, all in a single ticket per QRM7-015 § Implementation Tickets.

### 1. InvocationResultStore

**File:** New `apps/mcp-server/src/messaging/invocation-result-store.ts` (or co-located in `apps/mcp-server/src/mcp/`)

**What:** In-memory `Map<string, InvocationRecord>` keyed by `invocationId` (UUID). Each record holds `{ status, callerRole, target, response?, deliveryPromise, createdAt }`. The `deliveryPromise` is the broker's `agent.handle()` promise, allowing `wait_invocation` to race against its own 4 min 30 s timer on the same underlying work.

**Type hint:**
```ts
interface InvocationRecord {
  invocationId: string;
  callerRole: AgentRole;
  target: AgentRole;
  status: 'pending' | 'completed' | 'failed';
  response?: InvokeResponse;
  deliveryPromise: Promise<InvokeResponse>;
  createdAt: number;
}
```

**TTL reaping:** Hook into the existing 30 s `REAPER_INTERVAL_MS` cycle in `mcp.controller.ts:54-55` (`reapStaleSessions`). Add a `reapStaleInvocations()` call on the same interval. TTL should be generous — e.g. 10 min past the target role's timeout — since the store is bounded by `maxCallDepth × concurrent moderator sessions` (in practice <20 entries).

**Why this way:** A standalone injectable service (not bolted onto `MessageBroker` or `McpService`) keeps the store testable in isolation. The `deliveryPromise` field is the key insight: multiple `wait_invocation` calls can all `.then()` on the same promise without re-invoking the agent.

### 2. invoke_agent Racing Logic

**File:** `apps/mcp-server/src/mcp/mcp.service.ts:258-391` (`registerInvokeAgentTool`)

**Insertion point:** Between the `const response = await this.messageBroker.invoke(request)` call at line ~365 and the return block at line ~387. The current synchronous `await` becomes conditional on the caller-aware policy.

**What:** When `callerRole === 'moderator'` and `ROLE_TIMEOUTS[target] > 270_000`, replace the bare `await this.messageBroker.invoke(request)` with:

1. Start the broker delivery: `const deliveryPromise = this.messageBroker.invoke(request)`
2. Create a 4 min 30 s server timer: `const serverTimer = sleep(270_000)`
3. Race them: `const winner = await Promise.race([deliveryPromise.then(r => ({ type: 'result', response: r })), serverTimer.then(() => ({ type: 'timeout' }))])`
4. If `winner.type === 'result'` — return inline (today's sync behavior, zero overhead)
5. If `winner.type === 'timeout'` — store `{ invocationId, deliveryPromise, callerRole, target, status: 'pending' }` in `InvocationResultStore`, wire a `.then()` on `deliveryPromise` to update the record when the broker resolves, return `{ status: "pending", invocationId, next: "call wait_invocation(invocationId)" }`

**Caller-aware policy** (from QRM7-015 § Caller-Aware Policy): The `ROLE_TIMEOUTS[target] > 270_000` threshold means only teamlead (10 min), architect (15 min), qa (15 min), and developer (30 min) trigger the long-poll path when called by the moderator. Productowner (2 min) and moderator-to-moderator (5 min, elicitation) stay on the sync path. Agent-to-agent calls never enter this branch because `callerRole !== 'moderator'`.

**Why this way:** The racing logic lives in the `invoke_agent` handler (not the broker) because it's a protocol concern (how to chunk the response for CC CLI's bodyTimeout), not a messaging concern. The broker's `deliverWithTimeout` and role-timeout semantics remain unchanged.

### 3. wait_invocation MCP Tool

**File:** `apps/mcp-server/src/mcp/mcp.service.ts` — new `registerWaitInvocationTool()` method, called from the tool registration block alongside `registerInvokeAgentTool`.

**Input schema:** `{ invocationId: z.string().describe("The invocationId from a pending invoke_agent response") }`

**Behavior:**
1. Look up `invocationId` in `InvocationResultStore`
2. If not found → return `{ status: "failed", error: "Unknown invocationId" }`
3. If found and `status === 'completed'` or `status === 'failed'` → return the stored result immediately (sub-ms latency for the "result arrived during gap between polls" case)
4. If found and `status === 'pending'` → race `record.deliveryPromise` against a fresh 4 min 30 s timer, same pattern as § 2 above. Return `{ status: "completed", response }` if delivery wins, or `{ status: "pending", invocationId }` if timer wins again.

**Why this way:** The tool is stateless — it reads from the store and races against the same `deliveryPromise`. No new state machine, no subscription model. Each `wait_invocation` call is an independent long-poll window on the same underlying work.

### 4. callerRole Auto-Bind Sidecar

**File:** `apps/mcp-server/src/mcp/mcp.service.ts` — inside the `wait_invocation` handler (and optionally in `invoke_agent`'s callerRole resolution block near line ~310).

**What:** When `wait_invocation` is called and the requesting session has no `callerRole` bound (because the moderator's CC CLI session recycled mid-invocation and hasn't called `register_agent` yet), resolve `callerRole` from the `InvocationResultStore` record's `callerRole` field. This prevents the `callerRole is required` rejection that would otherwise block result retrieval after a session recycle.

**Type hint:** ~10 lines — a guard clause at the top of the `wait_invocation` handler:
```ts
if (!callerRole && record?.callerRole) {
  callerRole = record.callerRole;
  // Optionally bind to session state for subsequent calls
}
```

**Why this way:** The store already records `callerRole` at `invoke_agent` time. The sidecar is a read from existing state, not new infrastructure. Per QRM7-015: "Fold into the implementation ticket as a footnote — not a separate piece of work."

### 5. CLAUDE.md Rule

**File:** `/mnt/quorum/workspace/CLAUDE.md`

**What:** Add one paragraph (from QRM7-015 § CLAUDE.md Guidance) in the Architecture Concept section or as a new section:

> When any MCP tool response carries `status: "pending"` with an `invocationId`, the work is still running server-side. Immediately call `wait_invocation(invocationId)` to continue waiting. Repeat if `wait_invocation` also returns pending. Stop only when status is "completed" or "failed".

No polling-cadence boilerplate, no backoff, no max-iteration cap. The loop is naturally bounded by the agent's `ROLE_TIMEOUTS` (typically 30 min for developer; ~6 continuations max at the 4 min 30 s ceiling).

## Acceptance Criteria

### InvocationResultStore
- [ ] Unit tests: record lifecycle — create, read, update status on delivery resolve, read after completion
- [ ] Unit tests: TTL reaping — records past TTL are cleaned on reap cycle; records within TTL survive
- [ ] Unit tests: immediate-return path — `wait_invocation` on an already-completed record returns instantly without racing

### invoke_agent Racing Logic
- [ ] Unit tests: racing semantics — broker resolves before 4m30s → returns inline result (sync path)
- [ ] Unit tests: racing semantics — broker does not resolve before 4m30s → returns `{ status: "pending", invocationId }` and stores record
- [ ] Unit tests: deliveryPromise `.then()` on the record fires and updates status when broker resolves after the server timer

### wait_invocation Tool
- [ ] Tool registered with correct input schema (`invocationId: string`)
- [ ] Unit tests: unknown invocationId → returns `{ status: "failed", error }`
- [ ] Unit tests: pending record, delivery resolves within 4m30s → returns `{ status: "completed", response }`
- [ ] Unit tests: pending record, delivery does not resolve within 4m30s → returns `{ status: "pending", invocationId }`
- [ ] Unit tests: completed record → returns stored result immediately

### Caller-Aware Policy
- [ ] Unit tests: `callerRole === 'moderator'` + `ROLE_TIMEOUTS[target] > 270_000` → enters long-poll path
- [ ] Unit tests: `callerRole === 'moderator'` + `ROLE_TIMEOUTS[target] <= 270_000` (productowner, moderator) → sync path
- [ ] Unit tests: `callerRole !== 'moderator'` (any agent-to-agent) → sync path regardless of target timeout

### Auto-Bind Sidecar
- [ ] Unit tests: `wait_invocation` with no session `callerRole` but valid record → resolves callerRole from store, succeeds
- [ ] Unit tests: `wait_invocation` with no session `callerRole` and no matching record → rejects cleanly

### Integration
- [ ] CLAUDE.md rule added (one paragraph, no polling boilerplate)
- [ ] `npm run build` — compiles successfully
- [ ] `npm run lint` — 0 errors, 0 warnings
- [ ] `npm run test` — all existing tests pass, new tests added
- [ ] Implementation Notes appended to this ticket post-implementation

## Dependencies and References

### Dependencies
- **QRM7-015** (research, accepted) — design source of truth. All protocol mechanics, caller-aware policy, failure modes, and CLAUDE.md guidance are defined there.
- **QRM7-014** (done) — POST-path keepalive infrastructure. The long-poll pattern sits on top of the `startSseKeepalive` mechanism; keepalive pings fire during each held POST window.

### Code Touchpoints (from QRM7-015 § References)
| File | Lines | Role |
|------|-------|------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | 258-391 | `invoke_agent` handler — racing logic insertion |
| `apps/mcp-server/src/mcp/mcp.service.ts` | (new method) | `wait_invocation` tool registration |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | 54-55, 72+ | Reaper interval — add `reapStaleInvocations()` call |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | 278-318 | `startSseKeepalive` — keepalive fires during long-poll windows |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | 27-147 | `invoke()` and `deliverWithTimeout()` — unchanged, but racing logic uses same `deliveryPromise` |
| `apps/mcp-server/src/messaging/role-timeouts.ts` | 4-13 | `ROLE_TIMEOUTS` constants — drive caller-aware policy threshold |
| `libs/common/src/messaging/invoke.types.ts` | 103-108 | Existing `wait: boolean` field — unrelated to `wait_invocation` but same namespace |
| New: `apps/mcp-server/src/messaging/invocation-result-store.ts` | — | `InvocationResultStore` service |
| `CLAUDE.md` | — | Long-poll continuation guidance paragraph |

### Related Tickets
- [QRM7-015](QRM7-015-long-call-response-delivery-research.md) — full design, empirical evidence, failure modes, superseded approaches
- [QRM7-014](QRM7-014-candidate-b-prime-live-sse-response-signal.md) — keepalive infrastructure prerequisite
- [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) — SSE stream death context (Candidates A+E)
- [QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md) — original 5-minute stall diagnosis

### External References
- [SEP-1686](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686) — MCP Tasks spec (validates result-store pattern as canonical)
- CC CLI async gaps — [#470](https://github.com/anthropics/claude-code/issues/470), [#1478](https://github.com/anthropics/claude-code/issues/1478), [#1759](https://github.com/anthropics/claude-code/issues/1759), [#31427](https://github.com/anthropics/claude-code/issues/31427), [#47076](https://github.com/anthropics/claude-code/issues/47076)
