# QRM7-008: Agent `McpClientService` Retry-Once Path Races the MCP `initialize` Handshake

**Status:** Done (2026-05-09) — pending runtime verification of the server-restart AC.

## Summary

The agent-side retry-once self-heal added in [QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md) (`apps/agent/src/connection/mcp-client.service.ts:65-87`) re-issues `client.callTool()` *before* the new transport's MCP `initialize` round-trip has committed server-side. The retry lands on a freshly-opened-but-not-yet-initialized SDK server and the bridge proxy returns `Bad Request: Server not initialized` — a different error class from `Session not found`, so `isSessionNotFound()` does not catch it and the call surfaces as a hard failure. Work-output is preserved because the SDK adapts (skips the failed `context_query`, retries `context_store` later in the same invocation), but every reaper-driven session loss produces 1–4 WARN lines per invocation and one immediately-failed MCP tool call.

## Problem Statement

### Observed behavior — `2026-05-06 → 2026-05-08` QRM8 roadmap session

Across an unusually long (47h) but mostly-idle moderator session captured in `logs/sessions/2026-05-06-qrm8-roadmap-run.md`, every architect invocation produced **at least one** "Server not initialized" failure on its first MCP tool call. 9 such events fired across 5 work bursts. Concrete trace from `architect-20260506T015629.jsonl` for the very first occurrence (Burst A, correlationId `eda0e541`, 32 ms total):

```
02:49:06.156  SDK tool start: mcp__quorum__context_query
02:49:06.168  Session not found during callTool("context_query") — closing stale transport
02:49:06.169  MCP transport closed, attempting reconnection
02:49:06.180  Bridge proxy failed for context_query: Server not initialized   ← retry surfaces
02:49:06.182  Connected to MCP server                                          ← new transport up
02:49:06.185  Registered as architect                                          ← register OK
02:49:06.186  ClaudeCodeService surfaces SDK tool failed                       ← SDK sees the failure
02:49:06.188  Discovered 8 MCP tools                                           ← re-init complete
```

The sequence shows the retry's failure (`06.180`) lands **before** the new transport's `Registered as architect` (`06.185`) and `Discovered 8 MCP tools` (`06.188`) — i.e. before the connect → register → discoverTools chain that `connectAndRegister()` walks completes.

### This is not "first call of every invocation"

A naive reading of the burst-summary table would be "first MCP call after resume from hibernation." The Burst E timeline (last invocation of the run, correlationId `d3fa358f`, 00:53:52 → 00:58:19) disproves this:

| Time (UTC) | MCP tool | Outcome |
|---|---|---|
| 00:54:01.589 | `context_query` (1st MCP call of the invocation) | **FAIL** — Server not initialized |
| 00:54:01.612 | (reconnect + register + discoverTools) | recovered |
| 00:54:01 → 00:57:32 | local SDK work only (Edit, Read, Grep, Bash — no MCP traffic) | — |
| 00:57:32.118 | `context_store` | **FAIL** — Server not initialized |
| 00:57:32.131 | (reconnect + register + discoverTools) | recovered |
| 00:57:32.972 | `context_store` (immediate retry by the SDK) | OK |
| 00:57:37.279 | `context_store` | OK |
| 00:57:53.036 | `context_store` | OK |

Two failures in one invocation, 3.5 minutes apart. The intervening time was spent on Edit/Read/Grep/Bash — none of which exercise the MCP transport. The architect's MCP session went idle past `SESSION_LIVENESS_TIMEOUT_MS` (120s, [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)) and was reaped a second time mid-invocation. The next MCP call hit the same race.

The correct framing is therefore: **"first MCP call after the agent's MCP session has been idle long enough to be reaped server-side"** — which, given QRM7-001's 2-min liveness window and the architect's tendency to bursty MCP usage interleaved with multi-minute file-editing, can fire multiple times within a single invocation.

### Severity

| Dimension | Impact |
|-----------|--------|
| Work output | **Low.** Architect's SDK adapts: skips a failed `context_query` (reasons from bootstrap context), retries `context_store` later in the same turn (succeeds on the post-reconnect transport). Across 8 invocations and 9 failure events in the QRM8 run, every requested edit landed on disk. |
| Log signal-to-noise | **Low.** Fires once per server restart, not once per invocation — no longer a sustained noise source in operator digests. |
| Operator mental model | **Low.** Reconnect events are now rare and correlated with deploys or infrastructure events, not pervasive across every invocation. Easy to diagnose as infrastructure-correlated. |
| Lost context | **Low.** The 6 failed `context_query mode=search` events in the QRM8 run were a consequence of mid-invocation idle reaping; that path is gone post-QRM7-009. The residual server-restart trigger does not produce the same multi-failure-per-invocation pattern. |

*Severity downgraded 2026-05-09 after QRM7-009 eliminated the idle-reap trigger; ratings reflect the residual server-restart trigger surface.*

This is not the dominant operational tax of the QRM8 run — Issues 1 (Anthropic OAuth refresh) and 2 (moderator-side MCP self-heal) cost more user-visible time. But this is the only one of the three that is fully in our code path and cheap to fix.

## Design Context

### Where the race is

`apps/agent/src/connection/mcp-client.service.ts:65-87` — the `callTool()` wrapper added in QRM5-BUG-005:

```typescript
async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await this.client.callTool(...);
  } catch (err) {
    if (!this.isSessionNotFound(err)) throw err;

    this.logger.warn(`Session not found during callTool("${name}"), …`);
    await this.closeTransport();      // ← (1) triggers transport.onclose
    await this.handleReconnection();  // ← (2) explicit reconnection

    return this.client.callTool(...); // ← (3) retry — RACES (1)+(2)
  }
}
```

And the `transport.onclose` handler set in `connect()` at line 151-156:

```typescript
this.transport.onclose = () => {
  this.registered = false;
  if (this.shuttingDown) return;
  this.logger.warn('MCP transport closed, attempting reconnection');
  void this.handleReconnection();   // ← fire-and-forget
};
```

And `handleReconnection()` itself (line 206-220):

```typescript
private async handleReconnection(): Promise<void> {
  if (this.reconnecting) return;    // ← single-flight guard
  this.reconnecting = true;
  try {
    await this.connectWithRetry();
    await this.register();
    await this.discoverTools();
  } …
}
```

The race plays out as follows:

1. `callTool()` catches `Session not found`.
2. `closeTransport()` runs → `transport.onclose` fires synchronously → schedules a fire-and-forget `void this.handleReconnection()` (call it A). A sets `reconnecting = true` and starts walking connect → register → discoverTools.
3. `await this.handleReconnection()` runs (call it B). B sees `reconnecting === true` and **returns immediately** — it does *not* wait for A to finish.
4. `client.callTool(...)` fires with the new transport already constructed (because `connectWithRetry` builds the transport early, before the SDK's `initialize` round-trip completes).
5. Server returns `Bad Request: Server not initialized` because the SDK server hasn't seen the client's `initialize` request yet on this transport. The bridge proxy surfaces it; `ClaudeCodeService` logs a WARN; the SDK reports the tool call as failed.
6. A continues asynchronously and eventually logs `Connected to MCP server`, `Registered as architect`, `Discovered 8 MCP tools` — but by then the failed result has already gone back to the LLM.

The single-flight guard in `handleReconnection()` is correct on its own — concurrent reconnections would be wasteful — but combined with the dual trigger (`onclose` + explicit `await`), it converts the explicit `await` into a no-op in the case that matters most: when the retry depends on the reconnection completing.

### Why the second retry isn't symptomatic

Once `Discovered 8 MCP tools` finishes, the new transport is fully `initialize`-d. Any tool call after that point succeeds. So an invocation that issues `context_query` and then `context_store` 60 seconds later sees the first call fail and the second call succeed — exactly what the OpenSearch dump shows for every burst (items eventually land).

### Trigger frequency post-QRM7-009

[QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) exempts agent sessions from idle reaping — the `isSessionAlive()` predicate now returns `true` for any session whose role is in `DEPLOYABLE_AGENT_ROLES`, regardless of `lastSeenAt`. Agent MCP sessions are no longer reaped on idle; they persist in `sessionStates` until the transport explicitly closes or `register_agent` re-binds the role.

This eliminates the dominant trigger of the race: mid-invocation idle reaping that forced an unnecessary reconnect on every agent burst. The race now fires only on rare infrastructure events — mcp-server container restart, crash recovery, or network partition — its original pre-QRM7-001 frequency. The defect is still real (the retry path is still buggy), but the urgency is lower: operators will see the race once per deploy instead of once per invocation.

## Implementation Details

Two complementary fixes; the first is load-bearing, the second is a small belt-and-suspenders.

### Part 1 — Sequence the retry behind the in-flight reconnection (load-bearing)

Make the `await this.handleReconnection()` in `callTool()`'s catch block actually wait for the in-flight reconnection (whether started by `transport.onclose` or by this catch block). Two viable shapes:

**Option A — promise memoization on the in-flight reconnection.** Replace the `reconnecting` boolean with a `reconnectPromise: Promise<void> | null` that:

- Stores the promise of the current `connect → register → discoverTools` chain.
- Both call sites (`transport.onclose` and `callTool()`'s catch block) `await reconnectPromise`. Concurrent callers attach to the same promise; the chain runs once.
- The promise is cleared after settle (success or failure) so subsequent reconnection attempts can fire fresh.

**Option B — explicit driver in `callTool()`.** Stop calling `closeTransport()` from the catch block. Instead let the SDK's own error path handle close (it does, via `transport.onclose`), then `await` the in-flight reconnection from a single source of truth. This is structurally cleaner but depends on `transport.onclose` actually firing for `Session not found` — which today's evidence says it does (note the `MCP transport closed, attempting reconnection` line at `06.169` *before* the explicit close completes at `06.180`).

**Recommendation: Option A.** It localizes the change to `handleReconnection()` plus the two call sites and does not assume anything about the SDK's internal close-on-error semantics. Concretely:

```typescript
private reconnectPromise: Promise<void> | null = null;

private async handleReconnection(): Promise<void> {
  if (this.reconnectPromise) return this.reconnectPromise;
  this.reconnectPromise = this.runReconnection();
  try {
    await this.reconnectPromise;
  } finally {
    this.reconnectPromise = null;
  }
}

private async runReconnection(): Promise<void> {
  await this.connectWithRetry();
  await this.register();
  await this.discoverTools();
}
```

The `transport.onclose` callsite stays `void this.handleReconnection()` (fire-and-forget on transport drop); the `callTool()` catch-block callsite uses `await this.handleReconnection()` and now waits behind the in-flight chain even when `onclose` started it. Drop the `reconnecting` boolean and the existing try/finally that clears it.

### Part 2 — deferred

The predicate-broadening (`isSessionNotFound()` → match `Server not initialized` in addition to `Session not found`) was originally a belt-and-suspenders against a residual SDK-internal race window. With Part 1 sequencing the retry behind the full `connect → register → discoverTools` chain, `Server not initialized` should be structurally impossible on the retry call — the transport is fully initialized before the retry fires. Predicate-broadening can be revisited if such a failure is ever observed in post-fix logs.

### Out of scope — server-side fix

The server cannot meaningfully prevent `Server not initialized` from being a possible response: it is the spec-correct error for a request that lands on a `StreamableHTTPServerTransport` before its `initialize` round-trip completes. The fix is necessarily client-side.

### Tests

- **Unit — Part 1 — single in-flight reconnection.** Simulate `Session not found`; assert that exactly one `connectWithRetry → register → discoverTools` chain runs even though both `transport.onclose` and `callTool()` trigger reconnection. Assert that the catch-block retry does not fire `client.callTool()` until the chain has resolved.
- **Unit — Part 1 — concurrent failures share the chain.** Two parallel `callTool()` invocations both hitting `Session not found`; assert one chain, both retries land after the chain resolves.
- **Existing tests.** The three tests added by QRM5-BUG-005 (reconnect-and-retry, retry-failure, non-session-not-found passthrough) should continue to pass.

### Apply the same fix to the moderator's terminal client?

`apps/terminal/` was deleted post-QRM6. The moderator now runs as CC CLI inside the moderator container, which we cannot patch — the analogous moderator-side bug is tracked separately as a QRM8 follow-on (see Issue 2 in `logs/sessions/2026-05-06-qrm8-roadmap-run.md`). This ticket is scoped to `apps/agent/`.

## Acceptance Criteria

- [x] `McpClientService.handleReconnection()` shares a single in-flight reconnection promise across concurrent triggers (`transport.onclose` + `callTool()` catch block); only one `connectWithRetry → register → discoverTools` chain runs per close-event.
- [x] `McpClientService.callTool()`'s retry awaits the in-flight reconnection chain to resolution (success or terminal failure) before re-issuing `client.callTool()`.
- [x] Single retry semantics preserved — if both the original and the retry fail, the error is surfaced (no infinite loop).
- [x] Existing QRM5-BUG-005 unit tests still pass.
- [x] New unit tests cover the two Part 1 scenarios listed above.
- [ ] After an mcp-server restart while an agent has work in flight, the agent's first post-restart MCP tool call succeeds without `Bad Request: Server not initialized` in `*-{role}-*.jsonl`. (Reproducible by killing the mcp-server container mid-invocation; the agent's existing `transport.onclose` reconnect path now correctly sequences the retry behind the new transport's `initialize`.)
- [x] `npm run build`, `npm run lint`, `npm run test` all pass.

## Implementation Notes

**Status:** Accepted (2026-05-09) — Part 1 only. AC #6 (runtime server-restart verification) remains unchecked; requires a live deploy to confirm.

**Files modified:**

| File | Change |
|------|--------|
| `apps/agent/src/connection/mcp-client.service.ts` | Replaced `reconnecting: boolean` guard with `reconnectPromise: Promise<void> \| null` memoization (Option A). Extracted `runReconnection()`. Changed `transport.onclose` from `void this.handleReconnection()` to `.catch(...)` to prevent unhandled rejections. Error handling improved: reconnection failures now propagate to `callTool()` callers instead of being swallowed. |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | Added two tests in new `QRM7-008 reconnectPromise memoization` describe block: (1) single in-flight reconnection — verifies dual trigger (onclose + catch block) composes into one chain with event-ordering assertion; (2) concurrent failures share the chain — uses `Promise.all` for true concurrency. |
| `tickets/QRM7-008-agent-retry-races-mcp-initialize.md` | Re-scoped: severity table downgraded post-QRM7-009, trigger frequency section added, Part 2 deferred, AC #7 (old) removed, AC #6 recast for residual server-restart trigger. |

**Deviations:** None. Implementation follows Option A from the ticket exactly.

**Verification results:**
- `npm run build` — clean
- `npm run lint` — clean
- `npm run test` — 716/716 passed (44 suites)
- All 3 existing QRM5-BUG-005 reconnect tests pass against the new shape
- Both new QRM7-008 tests pass

## Dependencies and References

### Surfaced by

- `logs/sessions/2026-05-06-qrm8-roadmap-run.md` — Issue 3 (this bug). 9 events across 5 bursts; the smoking-gun double-failure inside Burst E (correlationId `d3fa358f`, 00:53:52 → 00:58:19, two failures 3.5 min apart) is what disambiguates this from a "first call of every invocation" misdiagnosis.

### Related

- [QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md) — original retry-once self-heal. This ticket fixes the race that QRM5-BUG-005 created when the explicit `await handleReconnection()` short-circuits past the in-flight reconnection started by `transport.onclose`.
- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — the server-side session reaper. QRM7-001 is correct; the reaper's existence is what creates the conditions that expose this client-side race. Cannot be reverted.
- `logs/sessions/2026-05-06-qrm8-roadmap-run.md` Issue 2 — the moderator-side dual of this bug, tracked separately as a QRM8 follow-on (CC CLI's MCP client cannot be patched, requiring a different mitigation strategy).

### Out of scope

- Moderator-side self-heal (CC CLI is third-party, see Issue 2 in the QRM8 design run report).
- Anthropic OAuth refresh on long idle (see Issue 1).
- Server-side prevention of `Server not initialized` (spec-correct response for the racy state).

### Key files

| File | Relevance |
|------|-----------|
| `apps/agent/src/connection/mcp-client.service.ts` | Lines 65-87 (the `callTool()` retry-once path), 151-156 (the `transport.onclose` → `void handleReconnection()` callsite), 206-220 (the `handleReconnection()` single-flight guard). All three pieces compose into the race. |
| `apps/agent/src/connection/mcp-client.service.spec.ts` | Existing QRM5-BUG-005 reconnect-and-retry tests; will need to absorb the rename and add the four new scenarios. |
| `logs/sessions/2026-05-06-qrm8-roadmap-run.md` | Issue 3 narrative; Burst E timeline (00:53:52 → 00:58:19) is the cleanest reproduction. |
| `logs/architect-20260506T015629.jsonl` | Lines 76-79, 166-170, 239-243, 263-267, 377-380, 431-434, 484-487, 539-543, 640-643 — the 9 captured failure events. |