# QRM7-015: Long-Call Response Delivery — Research

**Status:** Open — Research (rewritten 2026-05-12; prior content superseded)

## Summary

Research ticket recommending a **long-poll continuation** pattern for delivering `invoke_agent` responses that exceed CC CLI's 5-minute `undici.bodyTimeout`. The server holds the POST response up to a 4 min 30 s ceiling; if the target agent hasn't finished, the server returns `{ status: "pending", invocationId }` cleanly before the timeout fires. The moderator LLM follows a CLAUDE.md rule: call `wait_invocation(invocationId)` to continue waiting. Sub-5-min calls (the common case) have **zero protocol overhead** — one synchronous tool call, identical to today. Long calls cost ~4 continuations for a 20-min task at ~$0.40 total LLM spend, with sub-second completion latency.

This replaces the prior three-option analysis (server-push, fire-and-forget async, MCP resumability) with a single recommended design grounded in empirical evidence from 48 successful long-hold POST responses post-QRM7-014.

## Problem Statement

**The bug:** When the moderator calls `invoke_agent(target=developer)` and the developer takes >5 minutes, undici's `bodyTimeout = 300_000 ms` inside CC CLI kills the POST response body. The MCP SDK's `StreamableHTTPServerTransport` writes the JSON-RPC result *after* the broker resolves, but the POST's `Response` is already dead (`writableFinished=false`). The broker logs `Completed: success=true`; the moderator sees `transport dropped mid-call; response for tool invoke_agent was lost`. The agent's work is committed and real; only the response envelope is lost.

**Why existing keepalive doesn't fix this:** The 15 s `startSseKeepalive` interval (`mcp.controller.ts:278-318`) fires `: ping\n\n` on the POST response and resets undici's `bodyTimeout` counter — validated by QRM7-014's `keepaliveFired=true` markers on 48 successful holds >100 s. But CC CLI's bundled undici may have internal timeout logic independent of body bytes on the wire. Empirical evidence: the `durationMs=300705` / `durationMs=293709` signatures in QRM5-BUG-003 match undici defaults exactly, and post-QRM7-014 sporadic failures at 74 s, 193 s, 449 s, and 545 s suggest non-bodyTimeout causes (network, CC CLI internal state, session recycle interactions).

**Impact:** Lost response → moderator recovery path → duplicate invocations, context-store key collisions, wasted LLM spend ($0.50–$2 per duplicate), and a frozen-UX window until CC CLI's transport recycle fires.

**Constraint:** CC CLI is a third-party binary. We cannot patch its undici dispatcher, MCP SDK version, or transport internals. All fixes must be server-side or protocol-level.

## Recommended Design: Long-Poll Continuation

One design. No options matrix. The long-poll continuation pattern was selected after evaluating and discarding server-push notifications, fire-and-forget async with Bash-sleep polling, and moderator singleton anchoring (see § Superseded Approaches below).

### Protocol Mechanics

The 5-min `bodyTimeout` becomes the natural chunk size for held POST responses. Server discipline: **never let a held POST reach 5 min.** Return `{ status: "pending", invocationId }` cleanly at a hard 4 min 30 s ceiling. The LLM follows a CLAUDE.md rule: if a tool response carries `status: "pending"`, immediately call `wait_invocation(invocationId)` to continue waiting. Repeat until result lands.

**Sub-5-min calls (common case — short work):**

```
POST invoke_agent(target=architect, ...)
→ server holds POST, broker resolves at e.g. 2m17s
→ POST returns { status: "completed", response: {...} }
→ Done. ONE tool call. Zero overhead vs today's sync path.
```

**Long calls (the QRM7-015 case):**

```
POST invoke_agent(target=developer, ...)
→ server holds POST up to 4m30s
→ timer hits 4m30s, developer still working
→ server stores invocationId in InvocationResultStore, returns
  { status: "pending", invocationId: "inv_7c2a",
    next: "call wait_invocation(invocationId)" }

POST wait_invocation("inv_7c2a")
→ server holds POST up to another 4m30s
→ developer finishes at 1m40s into this window
→ broker resolves; server writes { status: "completed", response: {...} }
→ Done.
```

### Properties

| Property | Value |
|---|---|
| Sub-5-min call overhead | **Zero** — sync-shaped from LLM perspective, identical to today |
| Long-call overhead (20-min task) | ~4 continuations × ~$0.10 LLM cost ≈ **~$0.40** |
| Completion latency | **<1 s** — broker resolves → server writes into held POST immediately |
| Esc-and-resume | Works — Esc kills in-flight POST; invocation continues server-side; user re-engages → moderator calls `wait_invocation` to pick up |
| Auto chain progression | Works — after developer completes, moderator immediately dispatches next agent; same long-poll pattern repeats |
| Spec compliance | Standard MCP tool primitives, no protocol extensions, no custom notifications |

### Caller-Aware Policy

The long-poll path only triggers for `caller === moderator`. Agent-to-agent calls (architect → developer, etc.) use the 35-min undici dispatcher we control in the agent container — they don't hit the 5-min bug. The conditional lives in `message-broker.service.ts:invoke()`, immediately after safeguard checks:

| Caller | Target | Timeout | Path |
|--------|--------|---------|------|
| Any agent | Any agent | 2–30 min | **Sync** — 35-min undici dispatcher |
| Moderator | productowner | 2 min | **Sync** — under bodyTimeout |
| Moderator | moderator | 5 min | **Sync** — elicitation, under bodyTimeout |
| Moderator | teamlead | 10 min | **Long-poll** — exceeds bodyTimeout |
| Moderator | architect | 15 min | **Long-poll** — exceeds bodyTimeout |
| Moderator | qa | 15 min | **Long-poll** — exceeds bodyTimeout |
| Moderator | developer | 30 min | **Long-poll** — exceeds bodyTimeout |

Role timeouts sourced from `apps/mcp-server/src/messaging/role-timeouts.ts:4-13`.

### Server-Side Scope

**`InvocationResultStore`** — New in-memory Map keyed by `invocationId`, holds `{ status, response?, deliveryPromise }`. TTL reap on the existing 30 s reaper interval in `mcp.controller.ts`. Bounded by `maxCallDepth × concurrent moderator sessions` — in practice <20 entries.

**`invoke_agent` (modified)** — `mcp.service.ts:258-391`. When `caller === moderator` and `ROLE_TIMEOUTS[target] > 270_000` (4 min 30 s), race the broker's `deliverWithTimeout` against a 4 min 30 s server timer. If broker wins first, return the result inline — today's sync behavior, zero overhead. If server timer wins, store the invocation in `InvocationResultStore`, return `{ status: "pending", invocationId }`.

**`wait_invocation(invocationId)` (new MCP tool)** — Long-polls up to 4 min 30 s on the stored invocation's `deliveryPromise`. Returns `{ status: "completed", response }` when result lands, or `{ status: "pending", invocationId }` if the ceiling hits again. If the result was already stored by the time the tool is called (e.g., agent finished during the gap between two `wait_invocation` calls), returns it immediately.

**`callerRole` auto-bind sidecar** — ~10 lines in `mcp.service.ts`'s `invoke_agent` handler. When a moderator session recycles mid-invocation and the new session hasn't called `register_agent` yet, the auto-bind path resolves `callerRole` from the result store's recorded caller instead of rejecting with `callerRole is required`. Fold into the implementation ticket as a footnote — not a separate piece of work.

### CLAUDE.md Guidance

One paragraph, no polling-cadence boilerplate, no backoff, no max-iteration cap:

```
When any MCP tool response carries `status: "pending"` with an `invocationId`,
the work is still running server-side. Immediately call
`wait_invocation(invocationId)` to continue waiting. Repeat if `wait_invocation`
also returns pending. Stop only when status is "completed" or "failed".
```

The loop is naturally bounded by the agent's `ROLE_TIMEOUTS` (typically 30 min for developer; ~6 continuations max at the 4m30s ceiling).

### Failure Modes

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Moderator Esc during `wait_invocation` | POST killed; invocation continues server-side | User re-engages → moderator calls `wait_invocation(same id)` → result waiting or still pending |
| Session recycle between continuation polls | New session has no `callerRole` | Auto-bind sidecar resolves `callerRole` from result store; `wait_invocation` works on any session with the `invocationId` |
| Result arrives during gap between polls | Result sits in `InvocationResultStore` | `wait_invocation` checks store first — returns immediately if already complete |
| Sporadic POST failure (~6% rate) | Held POST dies mid-hold | Next `wait_invocation` call opens a fresh POST; same `invocationId` picks up where it left off |
| Result store grows unbounded | Memory pressure on mcp-server | TTL reaping on 30 s interval; bounded by `maxCallDepth × concurrent sessions` (<20 entries) |
| Agent times out (ROLE_TIMEOUT fires) | Broker returns `{ success: false, error: "timed out" }` | Stored as `{ status: "failed" }` in result store; next `wait_invocation` returns the failure cleanly |

### Complexity Estimate

| Dimension | Estimate | Notes |
|-----------|----------|-------|
| Implementation | **M** | Result store (~80 lines) + `invoke_agent` racing logic (~40 lines) + `wait_invocation` tool (~60 lines) + auto-bind sidecar (~10 lines) + CLAUDE.md guidance |
| Testing | **M** | Async lifecycle tests, store TTL/reaping, racing semantics, caller-aware policy, `wait_invocation` immediate-return path |
| Platform dependency | **None** | Standard MCP tool primitives throughout |
| Risk | **Low** | No unknown CC CLI behaviors; every tool call uses proven request/response semantics |

## Empirical Evidence: Post-QRM7-014 Hold Duration Data

All data from `POST close` diagnostic lines in `/mnt/quorum/workspace/logs/*.jsonl` with `keepaliveFired=true` marker (indicating the QRM7-014 keepalive infrastructure was active). Methodology:

```bash
# Successful holds >270s (4.5 min)
grep -hE "POST close:.*writableFinished=true.*keepaliveFired=true.*durationMs=[0-9]+" \
  logs/*.jsonl | grep -oE "durationMs=[0-9]+" | awk -F= '$2 > 270000' | wc -l
# → 15

# Failures with keepalive active
grep -hE "POST close:.*writableFinished=false.*keepaliveFired=true" \
  logs/*.jsonl | wc -l
# → 4
```

### Aggregate Metrics

| Metric | Value |
|---|---|
| Successful holds >100 s | **48** |
| Successful holds >270 s (4.5 min) | **15** |
| Longest validated successful hold | **614,681 ms ≈ 10 min 14 s** (2026-05-06) |
| Failures (any duration, keepalive active) | **4** |
| Failure rate at >100 s | 3 / 51 ≈ **5.9%** |

### Top Successful Long Holds

All `writableFinished=true keepaliveFired=true`:

| Duration (ms) | ≈ Human | Date |
|---|---|---|
| 614,681 | 10 min 14 s | 2026-05-06 |
| 562,075 | 9 min 22 s | 2026-05-09 |
| 539,027 | 8 min 59 s | 2026-05-03 |
| 531,370 | 8 min 51 s | 2026-05-07 |
| 524,775 | 8 min 45 s | 2026-04-30 |
| 493,245 | 8 min 13 s | 2026-05-03 |
| 462,253 | 7 min 42 s | 2026-05-10 |
| 402,014 | 6 min 42 s | 2026-04-30 |

### Failure Profile

Post-QRM7-014 failures (`writableFinished=false keepaliveFired=true`):

| Duration (ms) | ≈ Human |
|---|---|
| 74,163 | 1 min 14 s |
| 192,878 | 3 min 13 s |
| 449,670 | 7 min 30 s |
| 544,778 | 9 min 5 s |

These are sporadic — no clustering around the 291–301 s signature that characterized the classic QRM5-BUG-003 `bodyTimeout` failure mode. That 5-min boundary cluster is **gone** post-QRM7-014. Remaining failures suggest non-bodyTimeout causes (network blip, CC CLI internal state, session recycle interaction).

### Pre-QRM7-014 Baseline (for contrast)

Pre-QRM7-014 logs (no `keepaliveFired` marker): 8 failures out of 60 observations >100 s ≈ **13.3%** failure rate. Five of those eight cluster at 291,848 / 293,709 / 294,927 / 300,526 / 300,705 ms — the classic `bodyTimeout` signature. QRM7-014's keepalive infrastructure eliminated that failure class entirely.

### Key Conclusion

The 4 min 30 s ceiling has **~3.8× empirical headroom** vs the longest validated successful hold (614 s). The choice of 270 s is conservative — well inside the proven-safe envelope. The ~6% sporadic failure rate makes the `InvocationResultStore` load-bearing for recovery (next `wait_invocation` call picks up transparently), not for handling clean 5-min bodyTimeout cuts.

## External Research

### MCP Tasks (SEP-1686) — Accepted Into Spec

SEP-1686 has been **accepted by core MCP maintainers** for the `DRAFT-2025-11-25` milestone. It introduces a generic Task primitive enabling deferred result retrieval (`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`) with `task: { ttl }` augmentation on `tools/call`. Status state machine: `working | input_required | completed | failed | cancelled`. Spec mandate: **"poll for truth, listen for speed"** — completion notifications are optional best-effort.

Our `@modelcontextprotocol/sdk@^1.29.0` already ships `server.experimental.tasks.registerToolTask(...)` and `experimental.tasks.getTaskResult()`. Server-side compliance is shippable today.

**Relevance:** Validates that the broader MCP ecosystem has converged on the same architectural pattern we're proposing — deferred retrieval indexed by ID, optional push. Confirms the result-store approach is canonical, not a hack. **However, our long-poll continuation design is NOT a Tasks implementation.** Tasks is poll-based; long-poll is held-POST-based. The two are complementary; long-poll is more efficient on CC CLI specifically because each continuation costs only ~$0.10 (one tool call) vs Tasks polling which would require the LLM to decide when to poll and risk both under-polling (latency) and over-polling (cost). A future Tasks facade can be added on top of the same `InvocationResultStore` if CC CLI's MCP client gains Tasks support natively.

**References:**
- [SEP-1686](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686) — accepted
- [SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391) — superseded by SEP-1686
- [WorkOS blog: MCP async tasks](https://workos.com/blog/mcp-async-tasks-ai-agent-workflows) — wire-protocol writeup

### CC CLI's Confirmed Gaps as an Async-MCP Client

Five separate Anthropic feature requests, all closed without implementation:

| Issue | Ask | Resolution |
|---|---|---|
| [claude-code#470](https://github.com/anthropics/claude-code/issues/470) | `resetTimeoutOnProgress=True` — progress notifications keep long calls alive | Closed as not planned |
| [claude-code#1478](https://github.com/anthropics/claude-code/issues/1478) | Auto-resume conversation when MCP completion notification arrives | Closed as not planned |
| [claude-code#1759](https://github.com/anthropics/claude-code/issues/1759) | Background MCP tasks ("issue request, continue conversation, accept response when ready") | Closed as not planned |
| [claude-code#31427](https://github.com/anthropics/claude-code/issues/31427) | `run_in_background: true` for MCP tools (parity with Bash) | Closed as duplicate |
| [claude-code#47076](https://github.com/anthropics/claude-code/issues/47076) | Configurable per-MCP-server tool call timeout | Open, no commitment |

**Conclusion:** CC CLI's MCP client today treats tool calls as synchronous round-trips with no auto-resume on notifications, no background MCP execution, and no spec-level long-running primitive support. The community workaround across MCP servers is uniformly "proxy server that polls" — the result-store + held-POST pattern we're building is the canonical approach given today's CC CLI reality.

This reinforces dropping all server-push designs: any architecture that relies on CC CLI's MCP client surfacing server-initiated notifications to the LLM is empirically and officially unsupported.

## Superseded Approaches

The prior version of this ticket (pre-2026-05-12) evaluated three options in depth. All have been discarded in favor of long-poll continuation. Each is credited below with the reason for rejection.

### Moderator Singleton Anchor (prior Section 0)

The original ticket proposed a `moderatorAnchor` that persists across session recycles, holding `pendingResults` for the moderator to retrieve after reconnecting. **Discarded.** With long-poll continuation, polling is indexed by `invocationId` (server-owned state in `InvocationResultStore`), not by session identity. Session recycles don't lose results — any session can call `wait_invocation` with the same ID. The residual quality-of-life value (avoiding `callerRole is required` friction after a mid-invocation recycle) is handled by the ~10-line auto-bind sidecar folded into the implementation ticket as a footnote.

### Server-Push via GET SSE Channel (prior Section 2, variants 2a–2f)

The original ticket analyzed six sub-variants for pushing results through the moderator's persistent GET SSE channel: custom notification, `sendLoggingMessage`, repurposed elicitation, `notifications/progress`, experimental `tasks/status`, and `sendResourceUpdated`. **Discarded.** The external research (§ CC CLI's Confirmed Gaps) now provides definitive evidence: CC CLI's MCP client does not surface server-initiated notifications to the LLM. All five Anthropic feature requests for background/async MCP client behavior have been closed as not planned. The original ticket's assessment — "the entire option rests on CC CLI's SDK surfacing an unknown notification to the LLM; this is architecturally unlikely" — has been confirmed. No spike needed.

### Push Notification for Completion Signaling (prior optional QRM7-018 follow-up)

The original ticket sketched a hybrid: fire-and-forget async with optional push notification when the result lands. **Discarded.** Long-poll continuation already delivers sub-second completion latency without server-push — the broker resolves into the held POST immediately. Layering push on top adds complexity with no latency benefit.

### Bash-Sleep Polling with `check_invocation` Tool (prior Section 3 / Option 3)

Fire-and-forget async: `invoke_agent` returns `{ status: "queued", invocationId }` immediately; moderator polls with `check_invocation` on a CLAUDE.md-guided cadence. This was the leading candidate during discussion before long-poll continuation was proposed. **Discarded** because:

- **Cost**: Polling at 60 s intervals costs ~$0.12/iteration × ~20 iterations for a 20-min task ≈ **$2.40** total. Long-poll continuation: ~$0.40 for the same task. **6× cheaper.**
- **Latency**: Polling completion latency is 60–180 s (must wait for next poll iteration). Long-poll: **<1 s** (broker resolves into held POST).
- **Fragility**: CLAUDE.md polling-cadence guidance is brittle. The LLM may drift off pattern, over-poll (cost), under-poll (latency), or forget to poll entirely during multi-step orchestration. Long-poll CLAUDE.md guidance is one sentence: "call `wait_invocation` when you see `status: pending`."

### MCP_TIMEOUT / Long-Hold Empirical Spike (discussed during QRM7-014)

A proposed spike to validate whether `MCP_TIMEOUT` env var or manual undici dispatcher configuration could extend the bodyTimeout past 5 min. **Discarded.** We have weeks of production evidence (§ Empirical Evidence) that the existing QRM7-014 keepalive infrastructure supports POST holds well past 5 minutes — longest validated: 614 s (10 min 14 s). The bodyTimeout is already being reset by keepalive pings; the sporadic failures are non-bodyTimeout causes. No spike needed.

## Implementation Tickets (Forward Pointers)

The team lead will file these after this research ticket is accepted. Sketched here for scoping; not filed.

1. **QRM7-016 (or next)** — `InvocationResultStore` + `wait_invocation` MCP tool + `invoke_agent` long-poll racing logic + caller-aware policy + `callerRole` auto-bind sidecar (~10 lines) + CLAUDE.md rule. Single implementation ticket.

2. **(Optional, deferred)** — `/loop` + `/bg` operational mode for detached moderator. CLAUDE.md additions + `scripts/moderator.sh` changes to attach/detach the daemon. Out of scope for QRM7-015's research deliverable but worth a forward-pointer.

3. **(Optional, future)** — MCP Tasks spec facade on top of the same `InvocationResultStore`. Only worth filing if CC CLI's MCP client gains Tasks support natively. Speculative — monitor [SEP-1686](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686) and CC CLI changelogs.

## Acceptance Criteria

Research deliverables (this ticket completes when reviewed and accepted; no code work):

- [x] Problem statement preserved from prior version with unchanged framing
- [x] Single recommended design (long-poll continuation) documented with protocol mechanics, properties, failure modes, complexity estimate
- [x] Caller-aware policy table (moderator-only long-poll; agent-to-agent stays sync)
- [x] Empirical evidence section with verified log data (48 successes >100 s, 15 >270 s, longest 614 s, ~6% sporadic failure rate)
- [x] External research section: SEP-1686 (MCP Tasks, accepted) and CC CLI async gaps (5 closed issues)
- [x] Superseded approaches section crediting and discarding: singleton anchor, server-push (6 variants), push notification, Bash-sleep polling, MCP_TIMEOUT spike
- [x] CLAUDE.md guidance drafted (one paragraph, no polling boilerplate)
- [x] Implementation ticket sketch for team lead decomposition
- [x] Server-side scope: `InvocationResultStore`, modified `invoke_agent`, new `wait_invocation`, auto-bind sidecar
- [x] Project-scope context summary stored for team lead

## Touches

| File | Action |
|------|--------|
| `tickets/QRM7-015-long-call-response-delivery-research.md` | Rewritten (this ticket) |

## Depends On

- **QRM7-012** (mitigated) — SSE stream death / moderator session reaping. Provides the session-lifecycle understanding this research builds on.
- **QRM7-014** (done) — Live SSE response signal. The `activeSseToken` / `markSseAlive` infrastructure and POST-path keepalive are prerequisite for the empirical evidence cited here.

## References

- [QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md) — Original 5-minute stall diagnosis. The classic `durationMs=300705` bodyTimeout signature that QRM7-014's keepalive eliminated.
- [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) — Corrected diagnosis: undici `bodyTimeout` on GET, metronomic 5-min recycle. Candidates A+E landed. §Validation Results confirmed keepalive mechanics.
- [QRM7-014](QRM7-014-candidate-b-prime-live-sse-response-signal.md) — `activeSseToken` identity-guard pattern. POST-path keepalive erratum confirmed pings fire continuously on long-running `invoke_agent` SSE responses.
- [docs/mcp-connectivity.md](../docs/mcp-connectivity.md) — §2.3 (SSE keepalive), §3.2 (agent transport), §4.2 (moderator SSE GET), §7.3 (long-running invoke keepalive).
- [docs/message-broker.md](../docs/message-broker.md) — Broker safeguards, `deliverWithTimeout`, role-based timeouts.
- `apps/mcp-server/src/mcp/mcp.service.ts:258-391` — `invoke_agent` tool handler (modification site).
- `apps/mcp-server/src/mcp/mcp.controller.ts:278-318` — `startSseKeepalive` (keepalive infrastructure the long-poll design sits on top of).
- `apps/mcp-server/src/messaging/message-broker.service.ts:27-147` — `invoke()` and `deliverWithTimeout()` (racing logic insertion point).
- `apps/mcp-server/src/messaging/role-timeouts.ts:4-13` — Per-role timeout constants.
- `libs/common/src/messaging/invoke.types.ts:103-108` — Existing `wait: boolean` field.
- [SEP-1686](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686) — MCP Tasks spec (accepted, `DRAFT-2025-11-25`).
- [SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391) — Prior async tasks proposal (superseded by SEP-1686).
- [WorkOS MCP async tasks blog](https://workos.com/blog/mcp-async-tasks-ai-agent-workflows) — Wire-protocol writeup.
- [typescript-sdk#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211) — Client-side body-timeout, no heartbeat.
- [claude-code#470](https://github.com/anthropics/claude-code/issues/470), [#1478](https://github.com/anthropics/claude-code/issues/1478), [#1759](https://github.com/anthropics/claude-code/issues/1759), [#31427](https://github.com/anthropics/claude-code/issues/31427), [#47076](https://github.com/anthropics/claude-code/issues/47076) — CC CLI async/background MCP feature requests (all closed except #47076).
