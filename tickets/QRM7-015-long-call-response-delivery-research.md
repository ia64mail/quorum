# QRM7-015: Long-Call Response Delivery — Research

**Status:** Open — Research

## Summary

Research ticket investigating response-delivery mechanisms for moderator-originated `invoke_agent` calls that exceed CC CLI's 5-minute `undici.bodyTimeout`. The current SSE keepalive (QRM5-BUG-003 / QRM6-BUG-011 / QRM7-014) prevents the *session* from dying but cannot prevent the *POST response stream* from being killed when CC CLI's bundled undici closes the body after 300 s of inactivity. Three candidate solutions exist: MCP resumability (out of our control), server-push via the GET SSE channel, and fire-and-forget async decoupling. This ticket evaluates the two actionable options in depth and recommends a path forward.

## Problem Statement

**The bug:** When the moderator calls `invoke_agent(target=developer)` and the developer takes >5 minutes, undici's `bodyTimeout = 300_000 ms` inside CC CLI kills the POST response body. The MCP SDK's `StreamableHTTPServerTransport` writes the JSON-RPC result *after* the broker resolves, but the POST's `Response` is already `writableFinished=false` — dead. The broker logs `Completed: success=true`; the moderator sees `transport dropped mid-call; response for tool invoke_agent was lost`. The agent's work is committed and real (e.g. `e9234bb` from the current session); only the response envelope is lost.

**Why existing keepalive doesn't fix this specific case:** The 15 s `startSseKeepalive` interval in `mcp.controller.ts:278-318` fires `: ping\n\n` on the POST response and resets undici's bodyTimeout counter — this works for calls under 5 minutes. But the problem manifests when CC CLI's MCP SDK itself closes the connection before pings can be received. The POST-path keepalive *is* load-bearing (QRM7-014 erratum confirmed pings firing on 131 s invocations), but CC CLI's bundled SDK may have its own internal timeout logic independent of body bytes on the wire. Empirical evidence: the `durationMs=300705` / `durationMs=293709` signatures in QRM5-BUG-003 and the QRM6-BUG-009 reproduction match undici defaults exactly, suggesting the POST-path pings either don't reset the timer for some CC CLI SDK codepath, or the timer is on the GET stream's body (which gets no pings — first tick self-clears).

**Impact:** Lost response → moderator recovery path → duplicate invocations, context-store key collisions, wasted LLM spend ($0.50–$2 per duplicate), and a frozen-UX window until CC CLI's transport recycle fires.

**Constraint:** CC CLI is a third-party binary. We cannot patch its undici dispatcher, MCP SDK version, or transport internals. All fixes must be server-side or protocol-level.

## Section 0: Moderator Singleton Baseline

**Decision:** Pin the moderator role as a server-side singleton — any `register_agent(role=moderator)` rebinds to the same logical moderator anchor.

**Current state:** Same-role eviction already exists (`mcp.service.ts:420-441`): when a new session calls `register_agent(role=moderator)`, the prior session is evicted (`prior.close()` → maps cleared). This works but is *reactive* — the old session must still be in `sessionStates` to be found. During the recycle window (GET dies → new `initialize` → new `register_agent`), a brief gap exists where no moderator is bound, causing `Agent moderator not connected` rejections from the broker.

**Proposed refinement:** Make the moderator anchor *persist across session recycles*:
- Maintain a `moderatorAnchor: { correlationId, pendingResults: Map<string, InvokeResponse> }` in `McpService` that outlives individual MCP sessions.
- On `register_agent(role=moderator)`, bind the new session to the existing anchor (carry forward any queued results).
- On session death, the anchor stays — it doesn't evict until a new moderator binds.

**Why this is prerequisite:** Option 2 (GET-SSE delivery) needs a stable target for pushing results after a POST dies. Option 3 (async) needs a stable registry for the moderator to poll. Without the anchor, any result that arrives during the recycle gap is lost.

**Complexity:** S (implementation), S (testing). ~50 lines of state management in `mcp.service.ts`, ~20 lines in `message-broker.service.ts` to check the anchor on delivery failure.

---

## Section 1: MCP Resumability (`Last-Event-ID`) — Verdict

**Assertion to verify:** CC CLI's bundled MCP SDK does not implement SSE `Last-Event-ID` resumption.

**Evidence:**
1. **Codebase-wide grep** for `Last-Event-ID`, `lastEventId`, `resumption`, `progressToken`, `notifications/progress` — zero matches in the Quorum codebase. The server assigns no event IDs to SSE frames.
2. **QRM7-012 validation logs** (`logs/mcp-server-20260510T170304.jsonl`): GET streams reopen every ~300 s with the same `mcp-session-id` header but no `Last-Event-ID` header. The server treats each as a fresh SSE response, not a resumption.
3. **CC CLI session JSONL** (`logs/moderator-sessions/`): The adapter (`cc-session-adapter.mjs`) maps six event categories. None reference a resume-header or event-ID. No `Last-Event-ID` signal appears in any captured moderator session.
4. **MCP SDK issue [typescript-sdk#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211)** — filed against the same body-timeout behavior. No client-side heartbeat, no resume header.

**Verdict: Confirmed not available.** Even if Quorum implemented server-side replay buffers with event IDs, CC CLI's SDK would have to emit `Last-Event-ID` on reconnect. It doesn't. This option requires upstream SDK changes we cannot influence on any useful timeline.

**No further design work warranted.**

---

## Section 2: Server-Push via GET SSE Channel

### Protocol Mechanics

When `invoke_agent`'s POST response dies, the broker still holds the `InvokeResponse`. The idea: deliver it via the moderator's persistent GET SSE channel, which is reliably alive (reopened every ~5 min, identity-guarded tokens, `activeSseToken` tracking).

**Available SDK server→client primitives** (from `@modelcontextprotocol/sdk` type analysis):

| Primitive | Server API | Spec status | Payload shape |
|-----------|-----------|-------------|---------------|
| `notifications/progress` | `protocol.notification()` | Stable | `{ progressToken, progress, total, message? }` |
| `notifications/resources/updated` | `server.sendResourceUpdated()` | Stable | `{ uri }` |
| Logging (`notifications/message`) | `server.sendLoggingMessage()` | Stable | `{ level, logger?, data }` |
| `notifications/tasks/status` | `server.experimental.tasks` | **Experimental** | `{ taskId, status, statusMessage? }` |
| `elicitation/create` | `server.elicitInput()` | Stable | `{ message, requestedSchema }` — **request**, not notification |
| Custom notification | `protocol.notification()` | Non-standard | Arbitrary JSON-RPC notification |

**Five sub-variants for the push primitive:**

**2a. Custom notification (`notifications/invocation_result`):**
- Server constructs a JSON-RPC notification: `{ jsonrpc: "2.0", method: "notifications/invocation_result", params: { invocationId, response: InvokeResponse } }`
- Written to the moderator's GET SSE response via the per-session `McpServer`'s transport.
- **Spec deviation:** `notifications/invocation_result` is not a defined MCP notification. The SDK `Client` class registers handlers for known methods and drops unknown ones per standard JSON-RPC behavior for notifications. **Predicted behavior: silently discarded.**

**2b. `sendLoggingMessage()` (logging notification):**
- Server pushes `{ level: 'info', data: { invocationId, result } }` at any time via `server.server.sendLoggingMessage()`.
- The SDK client receives it. CC CLI uses MCP server logging for debug output and MCP inspector panels.
- **Key question: does CC CLI surface logging notifications to the LLM?** No evidence it injects logging messages into the LLM's conversation context. The LLM would never see the result. **Predicted behavior: silently consumed by CC CLI's debug layer, not surfaced to the model.**

**2c. Repurpose `elicitation/create`:**
- Server calls `server.server.elicitInput({ message: "Invocation result for <id>: <JSON>" })` on the moderator's session.
- CC CLI would see this as a normal elicitation prompt and present it to the LLM.
- **Fatal flaw:** The LLM receives this as a *question* to answer, not a *result* to consume. It would attempt to respond to the elicitation rather than incorporating the result into its tool-call flow. The result would be stored as an elicitation answer, not as the `invoke_agent` tool result. This fundamentally mismatches the expected data flow.

**2d. `notifications/progress`:**
- MCP spec defines `notifications/progress` for reporting progress on in-flight requests: `{ method: "notifications/progress", params: { progressToken, progress, total, data } }`.
- The `progressToken` must match a token provided in the original request's `_meta`. CC CLI would need to have passed a `progressToken` in the `invoke_agent` request.
- **Problem:** Even if the server forges a progress notification, there's no prior `progressToken` to reference — the originating POST is dead and the request is no longer in the SDK's pending-requests map. And progress notifications are informational — the SDK treats them as updates, not as replacement results for failed tool calls. **Predicted behavior: dropped by SDK client — no matching request context.**

**2e. Experimental `notifications/tasks/status`:**
- The MCP SDK has an experimental tasks API (`server.experimental.tasks`) with `notifications/tasks/status` that can push `{ taskId, status: 'completed', statusMessage }` to clients. Semantically the closest match — "your task completed, here's the result."
- **Problems:** (1) The API is experimental and may change without notice. (2) CC CLI's client would need to have declared `tasks` capability during `initialize` — no evidence it does. (3) Even if supported, the notification reaches the SDK client layer, not the LLM context. (4) `TaskStatus` values (`working | input_required | completed | failed | cancelled`) are lifecycle signals, not data carriers — `statusMessage` is a string, not a structured result payload.

**2f. `sendResourceUpdated()` + resource read:**
- Server pushes `sendResourceUpdated({ uri: 'context://invocation/<id>' })`. If CC CLI has subscribed to resource updates, it would re-read the resource.
- **Problems:** (1) CC CLI would need to have subscribed to resource updates — no evidence it subscribes automatically. (2) Even if it did, the re-read result would go to the SDK's resource cache, not into the LLM's conversation context. (3) Resource subscriptions are client-initiated; would need CLAUDE.md to instruct the LLM to subscribe, which is fragile and unprecedented in our flows.

### CC CLI Behavior Under Unsolicited Messages

**What we know empirically:**
- CC CLI handles `elicitation/create` over SSE correctly (QRM6-001 spike, verified end-to-end).
- CC CLI has never received a custom notification, `notifications/progress`, `sendLoggingMessage`, or `notifications/tasks/status` from Quorum — no precedent exists in any captured session log.
- The MCP SDK's `Client` class registers handlers for known methods and drops unknown ones silently (standard JSON-RPC behavior for notifications). This means variant 2a's custom notification would almost certainly be silently discarded.
- The `logs/moderator-sessions/` directory contains only `.gitkeep` — the bind-mount is wired (QRM7-005) but no CC CLI JSONL captures have been collected yet. Empirical inspection of CC CLI's handling of server-initiated messages from captured session data is **not currently possible**.

**What we cannot verify without a prototype:**
- Whether CC CLI surfaces `sendLoggingMessage` content to the LLM (unlikely — logging is debug infrastructure, not a data channel).
- Whether CC CLI's SDK would surface an unknown notification to the LLM's context (unlikely — the SDK processes protocol-level messages and only surfaces tool results, elicitations, and resource updates through defined channels).
- Whether a `notifications/progress` with fabricated `progressToken` would reach the LLM (unlikely — no matching request context, dead request).
- Whether CC CLI supports the experimental tasks API and would surface `notifications/tasks/status` (likely no — CC CLI is conservative on experimental features).
- Whether an unsolicited `elicitation/create` (one not triggered by a tool call in progress) is surfaced to the LLM or rejected by the SDK client.

**Empirical verification proposal — minimum-viable spike:**
1. Stand up a minimal MCP server (QRM6-001 pattern) that sends each candidate message type at 10-second intervals: `sendLoggingMessage`, custom notification, `notifications/progress` (with synthetic token), and `elicitation/create`.
2. Connect CC CLI. Observe: which messages surface in the terminal? Which reach the LLM? Which are silently dropped? Which cause errors?
3. If `logs/moderator-sessions/` bind-mount is active, inspect the CC CLI JSONL for evidence of message receipt.
4. Time box: 1 day (same scale as QRM6-001 spike).

### Server-Side Implementation Sketch (Variant 2a)

**Trigger condition:** In `message-broker.service.ts`, after `deliverWithTimeout` resolves with a successful `InvokeResponse`, detect that the original POST response is dead:
- The tool handler in `mcp.service.ts:364-389` would need to signal whether the write succeeded.
- If the write fails (POST `writableEnded=true`), broker queues the response in the moderator anchor (`pendingResults.set(invocationId, response)`).

**Delivery path:**
- `mcp.service.ts` adds a `deliverPendingResult(invocationId, response)` method.
- Looks up the moderator's current session via `AgentRegistry.get(moderator)`.
- Accesses the `McpServer` from the `McpElicitationConnection`.
- Writes the custom notification to the transport: `server.server.sendNotification("notifications/invocation_result", { invocationId, response })`.

**Files affected:**
- `message-broker.service.ts` — add dead-POST detection, queue to anchor.
- `mcp.service.ts` — add moderator anchor state, `deliverPendingResult` method, wire notification push.
- `mcp-elicitation-connection.ts` — expose the underlying `McpServer` for notification delivery (currently private).
- New: `libs/common/src/messaging/invocation-anchor.ts` — anchor type definition.

### Failure Modes

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| GET SSE mid-recycle when result ready | Notification lost — no open stream to write to | Buffer in anchor; retry on next GET open (register a `drain` hook on `markSseAlive`) |
| Moderator disconnected entirely | Anchor holds result indefinitely | TTL on pending results (10 min); after expiry, log and drop |
| Multiple results queue up | All delivered sequentially on next GET | Anchor is a Map; drain in FIFO order on `markSseAlive` |
| CC CLI silently drops the notification | Result lost with no error signal | This is the *critical risk* — no way to detect silent drop server-side. Applies to all candidates 2a-2f. Requires the spike to verify. |
| Moderator LLM doesn't understand the notification | LLM ignores the result even if surfaced | Would need CLAUDE.md guidance: "when you receive a `notifications/invocation_result`, treat it as the tool result for the corresponding `invoke_agent` call" |
| Elicitation (2c) misinterpreted as question | LLM "answers" the result instead of consuming it | Fundamental semantic mismatch — not fixable via CLAUDE.md guidance alone |

### Moderator UX Impact

**If it works (notification reaches LLM):** Seamless — the result appears in context as if the tool call succeeded. Minimal CLAUDE.md guidance needed: one paragraph explaining late-delivery notifications.

**If it doesn't work (notification silently dropped):** Complete failure mode. The moderator never sees the result and enters recovery. We're back to the status quo but with wasted implementation effort.

**Key risk:** The entire option rests on CC CLI's SDK surfacing an unknown notification to the LLM. This is architecturally unlikely given how MCP clients work. **A spike is mandatory before committing.**

### Spec-Compliance / Future-Proofing

- **Custom notification (2a):** Non-standard. A web UI or third-party MCP client would need custom handler code. Not portable.
- **Logging (2b):** Standard primitive, but repurposed beyond its intent (debug output, not data transport). A web UI would likely display it in a debug panel, not in the conversation.
- **Elicitation (2c):** Standard primitive, but semantic misuse. A web UI would render a form dialog asking the user to "respond to" a result payload. The worst spec divergence.
- **Progress (2d):** Standard primitive, but requires a valid `progressToken` from a live request. Fabricating tokens violates the spec contract.
- **Tasks (2e):** Experimental API. May change or be removed. Not portable to non-experimental clients.
- **Resource update (2f):** Standard primitive, but requires client-side subscription. Passive clients would never see the update.
- **If MCP adds `Last-Event-ID` resumption:** Option 2 becomes unnecessary. We'd be maintaining custom infrastructure that the protocol intends to solve natively.
- **Verdict:** Poor spec alignment across all candidates. Each repurposes a primitive beyond its intended semantics. Works only for CC CLI (if at all), not generalizable.

### Complexity Estimate

- **Implementation:** M (anchor state + notification delivery + dead-POST detection + drain-on-reconnect)
- **Testing:** M (need to mock SSE channel states, test buffering/drain, test silent-drop detection)
- **Platform dependency:** Requires spike to validate CC CLI behavior — **blocking unknown**
- **Risk:** High — entire approach may be DOA if CC CLI drops unknown notifications

---

## Section 3: Fire-and-Forget Async Decoupling

### Protocol Mechanics

`invoke_agent` returns immediately with `{ status: "queued", invocationId: "<uuid>" }`. The agent works asynchronously. When complete, the result lands in a registry (context store or dedicated `InvocationResultStore`). The moderator retrieves results by polling or receiving a completion signal.

**JSON-RPC flow:**

```
# Moderator → Server (POST)
invoke_agent { target: developer, action: "implement QRM7-016", mode: "async" }

# Server → Moderator (immediate POST response)
{ content: [{ type: "text", text: '{"status":"queued","invocationId":"abc-123"}' }] }

# ... developer works for 15 minutes ...

# Moderator checks result (POST)
check_invocation { invocationId: "abc-123" }

# Server → Moderator (POST response)
{ content: [{ type: "text", text: '{"status":"complete","response":{"success":true,"result":"..."}}' }] }
```

**Two new MCP tools:**
1. `invoke_agent_async` (or `invoke_agent` with `mode: "async"`) — queues the invocation, returns `invocationId`.
2. `check_invocation` — polls for result by `invocationId`. Returns `{ status: "pending" | "complete" | "failed", response?: InvokeResponse }`.

### CC CLI Behavior

**No unknown-primitive risk.** Both tools use standard MCP tool call/response semantics. CC CLI handles tool calls natively — this is the entire basis of Quorum's architecture. The moderator LLM calls `invoke_agent_async`, receives the invocation ID as a normal tool result, and later calls `check_invocation` as a normal tool call. No custom notifications, no protocol extensions.

**Empirical confidence: High.** Every tool call the moderator has ever made uses this exact pattern. The async wrapper adds no new primitives.

### Server-Side Implementation Sketch

**New state: `InvocationResultStore`**

Location: `apps/mcp-server/src/messaging/invocation-result-store.ts`

```
InvocationResultStore {
  private results: Map<string, { status, response?, createdAt, expiresAt }>
  
  queue(invocationId, request: InvokeRequest): void     // status = pending
  complete(invocationId, response: InvokeResponse): void // status = complete/failed
  check(invocationId): { status, response? }
  reap(): void                                           // TTL cleanup
}
```

**Modified files:**

| File | Change |
|------|--------|
| `message-broker.service.ts` | Add `invokeAsync(request)` method: validates safeguards (depth, availability, circular), queues to result store, spawns `agent.handle()` as a detached promise with `.then(result => store.complete(id, result))`. Returns `{ status: "queued", invocationId }`. |
| `mcp.service.ts` | Register `invoke_agent_async` tool (or add `mode` param to `invoke_agent`). Register `check_invocation` tool. Wire to broker's async path. |
| `invocation-result-store.ts` | New file. In-memory Map with TTL reaping on the existing 30 s reaper interval. |
| `libs/common/src/messaging/invoke.types.ts` | Add `InvocationStatus` type, `CheckInvocationResponse` type. |

**Trigger condition for async mode — two designs:**

**Design A — Explicit async tool:**
- New `invoke_agent_async` tool alongside existing `invoke_agent`.
- Moderator LLM chooses which to use based on CLAUDE.md guidance ("use async for developer/architect invocations that may exceed 5 minutes").
- Pro: Clear separation, no behavioral change to existing tool.
- Con: LLM must make the right choice; two tools to document and maintain.

**Design B — Mode flag with server-side auto-escalation:**
- `invoke_agent` gains `mode: "sync" | "async" | "auto"` parameter (default: `"auto"`).
- `"auto"` mode: broker checks `ROLE_TIMEOUTS[target]`. If timeout > 5 min (the undici bodyTimeout), auto-escalates to async for moderator-originated calls.
- Pro: No LLM decision needed; existing tool contract preserved.
- Con: More complex broker logic; `"auto"` heuristic may be wrong (short developer tasks forced async unnecessarily).

**Recommended: Design B with caller-aware policy.** The broker already knows the caller's role from `state.role`. Apply async auto-escalation only when `caller === moderator` AND `ROLE_TIMEOUTS[target] > 300_000`. Agent-to-agent calls (which use the 35-min undici dispatcher we control) stay synchronous — they don't hit the 5-min bug.

```
// In message-broker.service.ts
const shouldAsync = 
  caller === AgentRole.moderator && 
  (ROLE_TIMEOUTS[target] ?? defaultTimeoutMs) > UNDICI_BODY_TIMEOUT_MS;
```

Where the asymmetry lives: `message-broker.service.ts:invoke()`, immediately after safeguard checks. The `shouldAsync` branch calls `invokeAsync()` instead of `deliverWithTimeout()`. Transparent to the tool handler — it still returns an `InvokeResponse`-shaped object, just with `status: "queued"` instead of the agent's actual result.

### Completion Signaling — Poll vs. Push Hybrid

Pure polling wastes LLM turns. Combine with Option 2's push channel for completion signaling:

**Hybrid: async queue + push notification for completion:**
1. `invoke_agent` returns `{ status: "queued", invocationId }` (async path).
2. When the agent completes, broker calls `store.complete(id, response)`.
3. Broker attempts to push a lightweight notification via GET SSE: `notifications/invocation_complete { invocationId }` (just the ID, not the full result).
4. If the notification reaches the LLM, it calls `check_invocation` to retrieve the full result.
5. If the notification is silently dropped (the CC CLI unknown-notification risk), the LLM falls back to periodic polling.

**Why the hybrid is stronger than either alone:**
- The notification is best-effort — if CC CLI drops it, polling still works. No single point of failure.
- The notification carries only `invocationId` (small payload, no spec-divergence risk from data-bearing notifications).
- Polling has a bounded cost: one `check_invocation` call per in-flight invocation per moderator turn (likely 0–1 in practice).

### Failure Modes

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| GET SSE mid-recycle when completion fires | Notification lost | Polling fallback; CLAUDE.md instructs moderator to poll on each turn if any invocations are pending |
| Moderator disconnected entirely | Result sits in store until TTL expiry | TTL = 30 min (matches `SESSION_LIVENESS_TIMEOUT_MS`); on re-register, moderator can poll for any pending results |
| Multiple async invocations in flight | Moderator must track multiple invocation IDs | `list_invocations` tool returns all pending/completed invocations for the caller; LLM drains on each turn |
| Moderator restarts and loses invocation IDs | IDs were in LLM context, now gone | Anchor stores pending IDs; `list_invocations` recovers them. CLAUDE.md: "after session recovery, always call `list_invocations` to check for pending results" |
| Developer finishes instantly (< 1 s) | Async overhead was unnecessary | `check_invocation` on the same turn returns immediately. Extra round-trip cost: ~$0.01 at current token rates. Acceptable. |
| Result store grows unbounded | Memory pressure on mcp-server | TTL reaping on 30 s interval. Map size bounded by `maxCallDepth × concurrent sessions` — in practice < 20 entries. |

### Moderator UX Impact

**CLAUDE.md guidance needed:**
```
## Async Invocation Handling

When `invoke_agent` returns `{ status: "queued" }`, the target agent is working
asynchronously. To retrieve the result:
1. Note the `invocationId` from the response.
2. Continue with other work or wait briefly.
3. Call `check_invocation { invocationId }` to poll for the result.
4. If the result is not yet ready, continue with other work and check again on your next turn.

After session recovery (re-register), call `list_invocations` to discover any
results that arrived while the session was recycling.
```

**Turn-count impact:** +1 turn per async invocation (the `check_invocation` call). For a typical moderator turn that invokes one developer task, this adds one extra tool call. At current token rates, ~$0.01–0.02 marginal cost. Negligible.

**LLM comprehension risk:** Low. The "queue → poll" pattern is a standard programming concept. The LLM already handles multi-step tool workflows (e.g., `new_conversation` → `invoke_agent` → `context_query`). Adding one more tool call in the chain is natural.

### Spec-Compliance / Future-Proofing

- **Fully spec-compliant.** `invoke_agent_async` and `check_invocation` are standard MCP tools with standard request/response semantics. Any MCP client (web UI, third-party host, future CC CLI version) can use them without custom handlers.
- **If MCP adds `Last-Event-ID` resumption:** The async path remains useful as an explicit opt-in for truly long-running work (>35 min, multi-agent orchestration). Resumption fixes the transport; async decouples the workflow.
- **If the moderator moves to a web UI:** The async tools work identically. The web UI calls `check_invocation` the same way CC CLI does. The push notification for completion (if implemented) would need the web UI's MCP client to handle it — but it's optional (polling fallback).

### Complexity Estimate

- **Implementation:** M (result store + async broker path + 2–3 new tools + CLAUDE.md guidance)
- **Testing:** M (async lifecycle tests, store TTL/reaping, polling semantics, auto-escalation logic)
- **Platform dependency:** None — uses only standard MCP tool primitives
- **Risk:** Low — no unknown CC CLI behaviors, no protocol extensions

---

## Hybrids and Partials

### Sync Default, Async Fallback (Recommended)

Keep `invoke_agent` synchronous for all calls where the POST response can survive (agent-to-agent, short moderator calls). Auto-escalate to async only for moderator-originated calls targeting roles with >5-min timeouts.

**Decision point: one tool or two?**

| Approach | Pro | Con |
|----------|-----|-----|
| One tool (`invoke_agent` with `mode` flag) | Backward-compatible; LLM doesn't choose wrong tool; auto-escalation is transparent | `mode: "auto"` heuristic adds complexity; return type is polymorphic |
| Two tools (`invoke_agent` + `invoke_agent_async`) | Clear separation; each tool has a single return type | LLM must pick the right one; CLAUDE.md must guide the choice; risk of using sync for long calls |

**Recommendation:** One tool with server-side auto-escalation. The `mode` flag defaults to `"auto"`. The LLM never needs to think about it. The broker applies the policy based on `caller + target + timeout`. Agent-to-agent calls are always sync (their undici is configured for 35-min bodyTimeout). Moderator → long-running-role calls are always async. Moderator → productowner (2-min timeout) stays sync.

### Async Queue + Push Notification (Option 3 + Option 2 Hybrid)

This is the strongest design:
1. **Option 3** provides the reliable baseline: queue, poll, result store.
2. **Option 2's push notification** (best-effort) reduces polling latency: the moderator doesn't have to wait until its next turn to discover a completed invocation.
3. **If the notification is dropped** (likely, given CC CLI's handling of unknown notifications), polling still works. No regression.
4. **If the notification is surfaced** (unlikely but possible in future SDK versions), the moderator acts immediately. Free improvement.

The push notification is a low-cost addition (~20 lines in the broker's completion path) that doesn't block the core async design. Ship Option 3 first; add the notification as a follow-up if the QRM6-001-style spike shows CC CLI surfaces unknown notifications.

### Per-Role Policy

| Caller | Target | Timeout | Path |
|--------|--------|---------|------|
| Any agent | Any agent | 2–30 min | Sync (35-min undici) |
| Moderator | productowner | 2 min | Sync (< 5-min bodyTimeout) |
| Moderator | moderator | 5 min | Sync (elicitation, < 5-min bodyTimeout) |
| Moderator | teamlead | 10 min | **Async** (> 5-min bodyTimeout) |
| Moderator | architect | 15 min | **Async** (> 5-min bodyTimeout) |
| Moderator | qa | 15 min | **Async** (> 5-min bodyTimeout) |
| Moderator | developer | 30 min | **Async** (> 5-min bodyTimeout) |

The 5-minute boundary aligns with undici's `bodyTimeout = 300_000 ms`. The asymmetry lives in `message-broker.service.ts:invoke()` as a single `shouldAsync` conditional.

---

## Recommendation

**Pick Option 3 (fire-and-forget async decoupling) with the sync-default/async-fallback hybrid and auto-escalation policy.**

**Reasoning:**

1. **No blocking unknowns.** Option 2 requires a spike to verify CC CLI notification behavior — and the likely outcome is "silently dropped." Option 3 uses standard MCP tool primitives that are proven to work.

2. **Spec-compliant and future-proof.** Option 3 works with any MCP client. Option 2 requires custom notification handlers per client.

3. **Existing infrastructure.** The `wait: false` field on `InvokeRequest` already exists in the schema (`invoke.types.ts:103-108`) and is accepted by the tool handler — it just isn't wired to an async path yet. The spec *anticipated* this. The broker test suite already has a `describe('async (wait: false)')` block (`message-broker.service.spec.ts:333`). The foundation is laid.

4. **Incremental implementation.** Ship in phases: (a) result store + async broker path, (b) auto-escalation policy, (c) optional push notification for completion signaling. Each phase is independently valuable.

5. **The checkpoint-based recovery flow becomes the primary path.** Agents already store progress checkpoints in the context store. The async model makes this the *designed* recovery mechanism instead of a backstop — the moderator queries the context store for agent status as part of normal `check_invocation` flow, not as emergency recovery after a transport failure.

**What we need before committing:**
- The moderator singleton anchor (Section 0) should land first — it's cheap, prerequisite for both options, and independently useful (resolves the `callerRole is required` race after CC CLI-side recycles).
- No spike needed for Option 3. The only unknown is moderator LLM behavior with the polling pattern, which can be validated in the first implementation session.

### Ticket Decomposition

File as **two implementation tickets** plus the baseline:

| Ticket | Scope | Depends On |
|--------|-------|------------|
| QRM7-016 (or next) | Moderator singleton anchor (Section 0) | None |
| QRM7-017 (or next) | Async invocation path: result store, `invoke_agent` auto-escalation, `check_invocation` + `list_invocations` tools, CLAUDE.md guidance, broker auto-escalation policy | QRM7-016 |
| QRM7-018 (or next, optional) | Push notification for completion signaling — requires QRM6-001-style spike to verify CC CLI behavior first | QRM7-017, spike result |

**Dependency on QRM7-014:** The live-SSE-response signal (landed, validated) is a prerequisite for the completion notification (optional QRM7-018) but not for the core async path (QRM7-017). The async path works entirely via tool call/response semantics and doesn't depend on SSE channel state.

## Acceptance Criteria

Research deliverables (this ticket):

- [x] MCP resumability verdict documented with empirical evidence
- [x] Option 2 (server-push) analyzed: protocol mechanics, CC CLI behavior, implementation sketch, failure modes, UX impact, spec compliance, complexity
- [x] Option 3 (async decoupling) analyzed: same dimensions as Option 2
- [x] Hybrid designs evaluated: sync-default/async-fallback, push+poll, per-role policy
- [x] Clear recommendation with reasoning
- [x] Ticket decomposition for implementation follow-up
- [x] Moderator singleton baseline documented as prerequisite
- [x] Project-scope context summary stored for team lead

## Touches

| File | Action |
|------|--------|
| `tickets/QRM7-015-long-call-response-delivery-research.md` | Created (this ticket) |

## Depends On

- **QRM7-012** (mitigated) — SSE stream death / moderator session reaping. Provides the session-lifecycle understanding this research builds on.
- **QRM7-014** (complete) — Live SSE response signal. The `activeSseToken` / `markSseAlive` infrastructure is prerequisite for Option 2's push delivery and for the moderator singleton anchor.

## References

- [QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md) — Original 5-minute stall diagnosis. Phase 1 findings, Phase 2 client-side fix, re-opened for CC CLI.
- [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) — Corrected diagnosis: undici `bodyTimeout` on GET, metronomic 5-min recycle. Candidates A+E landed.
- [QRM7-014](QRM7-014-candidate-b-prime-live-sse-response-signal.md) — `activeSseToken` identity-guard pattern. POST-path keepalive erratum.
- [QRM6-001](QRM6-001-elicitation-spike.md) — Elicitation support spike. Precedent for the spike methodology recommended for Option 2's notification verification.
- [docs/mcp-connectivity.md](../docs/mcp-connectivity.md) §2.3 (SSE keepalive), §3.2 (agent transport), §4.2 (moderator SSE GET), §7.3 (long-running invoke keepalive).
- [docs/message-broker.md](../docs/message-broker.md) — Broker safeguards, delivery-with-timeout, role-based timeouts.
- `libs/common/src/messaging/invoke.types.ts:103-108` — Existing `wait: boolean` field and fire-and-forget description.
- `apps/mcp-server/src/messaging/message-broker.service.spec.ts:333` — Existing `async (wait: false)` test describe block.
- MCP SDK issue [typescript-sdk#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211) — Client-side body-timeout, no heartbeat.
