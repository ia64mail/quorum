# QRM7-001: MCP Session Cleanup Does Not Fire on Container Shutdown — Stale Sessions Reported as Connected

**Status:** Open — promoted to QRM7 stabilization milestone (was QRM6-BUG-007).

> **Renumbered 2026-05-01:** Originally filed as QRM6-BUG-007 during the QRM6-008 playbook on 2026-04-25. Promoted to QRM7-001 because it is the load-bearing fix for the moderator-reconnect failure mode and belongs in the stabilization milestone. The 2026-05-01 live-log analysis below confirms the bug is actively manifesting in production runs.

## Summary

`McpController`'s session-close handler (`transport.onclose`) never fires when an MCP client (CC CLI moderator, agent containers) terminates via SIGTERM/container shutdown. As a result `McpService.disconnect()` does not run, the `agentSessions` cache and per-session state are never cleared, and `AgentRegistry` continues to report dead sessions as `connected: true`. Any agent calling `invoke_agent(target=moderator)` after a moderator restart routes to a dead `McpElicitationConnection` and times out at the 60s elicitation window. Streamable HTTP MCP doesn't have a long-lived TCP connection per session, so the server has no transport-level signal that the client died unless the client explicitly sends `DELETE` on disconnect — which CC CLI does not do during SIGTERM. This is a functional break, not just an observability gap.

## Problem Statement

Reproduction (host-side, after a normal stack startup with the moderator's CC CLI session attached and `register_agent` called):

```
$ curl -s http://localhost:3000/registry | jq .
{
  "agents": [
    { "role": "developer",  "connected": true },
    { "role": "teamlead",   "connected": true },
    { "role": "architect",  "connected": true },
    { "role": "moderator",  "connected": true }
  ]
}

$ docker compose restart moderator
 Container quorum-moderator-1 Restarting
 Container quorum-moderator-1 Started

$ curl -s http://localhost:3000/registry | jq .
{
  "agents": [
    { "role": "developer",  "connected": true },
    { "role": "teamlead",   "connected": true },
    { "role": "architect",  "connected": true },
    { "role": "moderator",  "connected": true }   # ← still reports the DEAD session as connected
  ]
}

$ docker compose logs mcp-server --since 60s 2>&1 | grep -iE "session closed|session state cleaned|disconnect"
# (empty — no cleanup events fired)
```

The new moderator container only runs `tail -f /dev/null` until a user attaches via `docker compose exec -it moderator claude`; the entrypoint's `claude mcp list` self-verification is the only HTTP traffic the new container generates (one new `Session created: 6fbb751f-...` line). No `register_agent` was called; the registry's `moderator: connected: true` entry is stale, still keyed to the dead session ID `332e0a45-...` from the killed container.

A second observation across the entire log history of the project reinforces this: searching all `mcp-server-*.jsonl` files in the bind-mounted log dir for `Session closed` or `Session state cleaned up` returns **zero matches** — the cleanup branch has never executed in any run, even across multiple stack tear-downs.

### Live evidence from `mcp-server-20260501T144144.jsonl` (11h 25min run, 2026-05-01 → 02)

Captured during a routine moderator session that prompted the renumbering of this ticket:

| Metric | Value |
|---|---|
| `Session created` log lines | **49** |
| `Session closed` log lines | **0** |
| `Session reaped` log lines | **0** (no reaper exists yet) |
| `Registered agent: moderator` log lines | **1** (only the user's first attach at `14:42:56`) |
| Cadence of new `Session created` lines | every **15:02 ± 2s** for 11+ hours, like clockwork |

What this means in practice: CC CLI's MCP transport is being recycled every ~15 minutes (most likely an idle-driven reconnect on the moderator side; the moderator container otherwise just runs `tail -f /dev/null` between user attaches). Each new MCP session opens, but **none of them ever calls `register_agent`** — that only fires on the user's first `claude` attach. Combined with the broken `transport.onclose`:

- The registry's `moderator` entry has been pointing at the **original** `McpElicitationConnection` keyed to session `<first attach>` for the entire 11-hour window.
- That connection's session is dead within 15 minutes of the original attach.
- `McpElicitationConnection.isConnected()` still hardcodes `return true`, so `AgentRegistry.getAll()` continues to report `moderator: connected: true` against the corpse.
- Any `invoke_agent(target=moderator)` issued after the first 15 minutes routes to the dead connection and waits the full elicitation timeout before failing.

### Operational impact observed in the same run

The same log captures a downstream symptom that the moderator's CC CLI surfaced as "team lead call dropped":

```
14:51:06  invoke_agent: moderator → teamlead [correlationId=14b906e8-…, in-flight]
14:53:36  invoke_agent: moderator → qa  → success=false handlerMs=1   ← qa not deployed (intentional)
14:53:42  invoke_agent: moderator → teamlead [correlationId=14b906e8-…, RETRY while #1 still running]
14:57:39  Both teamlead POSTs return success at the same instant
            • POST #1: durationMs=393537, keepaliveFired=true, writableFinished=true
            • POST #2: durationMs=236888, keepaliveFired=true, writableFinished=true
```

Reading the timeline:

- QRM6-BUG-011's SSE heartbeat fix worked correctly — both POSTs sailed past the undici 300s `bodyTimeout` cliff (`keepaliveFired=true`, `writableFinished=true`).
- QRM6-BUG-010's idempotency map worked correctly — the second POST attached to the in-flight promise from #1; both ended within 1 ms of each other; only one SDK session was actually spawned.
- And yet the moderator still misdiagnosed the situation as a drop and retried mid-flight. The most plausible cause is the same MCP-session-recycling pattern documented above: the moderator's CC CLI client lost its view of the in-flight POST when the underlying MCP session was renewed, even though the server was still running it. With this ticket fixed (Layer 1 + Layer 3), `isConnected()` would have answered correctly and the moderator's prompt-level decision would have had a stable signal to base the retry on.

The empirical takeaway: BUG-007 is not just a registry-truthfulness bug; under the moderator's 15-minute reconnect cadence, **it is the dominant cause of the user-visible "agent dropped" failure mode** even when the underlying agent invocation is succeeding. BUG-010 and BUG-011 are necessary but not sufficient until session-state truthfulness is restored.

### When this fires

The bug triggers whenever a moderator MCP session ends without being immediately replaced by a new `register_agent` call. Reconnection is what *masks* the bug, not what causes it.

| Trigger | Stale entry? | User-visible impact |
|---------|--------------|---------------------|
| **User exits the `claude` CLI** (Ctrl+C, `/quit`) — moderator container stays up running `tail -f /dev/null` | Yes, until the user re-`exec`s `claude` | Any agent's `invoke_agent(target=moderator)` hangs for the elicitation role timeout, then fails. Most common real-world trigger. |
| **Moderator container restart** without a follow-up `claude` attach | Yes, until exec | Same as above. |
| **Moderator container restart** with prompt re-attach | Briefly stale; overwritten by the new session's `register_agent` | Tiny race window only. |
| **Agent container restart** (architect/developer/teamlead) | Stale entry remains, but the connection is `HttpAgentConnection(callbackUrl)` | **No practical impact.** Docker DNS resolves the service name to the new container, so the stale URL still routes successfully; on agent startup `register_agent` overwrites the entry. |

The moderator path is uniquely vulnerable because its connection is bound to a specific live MCP session (the user's CC CLI process), not to a stable URL. Agents don't have this property — they're addressable by callback URL that survives container lifecycle. Restart is therefore not the most common trigger; **a user simply ending their `claude` session is**.

### Severity

| Path | Impact |
|------|--------|
| Agent calls `invoke_agent(target=moderator)` while no live moderator session exists | Routes to dead `McpElicitationConnection`; broker waits the full elicitation role timeout (5 min after [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md), 60s before); returns a generic timeout error to the calling agent |
| Repeated moderator sessions across one mcp-server lifetime | Each ended session leaks a registry entry; `getAll()` returns N entries for N sessions; routing chooses the most-recently-overwritten entry by role uniqueness |
| MCP session state map (`mcpSessionState`, `agentSessions` cache) | Grows unbounded in long-running mcp-server processes; minor memory pressure, but more importantly a correctness issue if the same MCP session ID is ever reused |
| Operator visibility | The registry endpoint is the documented health probe (per QRM1-013 / QRM6-008 Scenario 2) — relying on it gives a wrong answer about which agents are reachable |

The "connected: true on a dead session" misreport is the most user-visible symptom; the silent cache leak is the foundation.

## Design Context

### Where cleanup is supposed to happen

`apps/mcp-server/src/mcp/mcp.controller.ts:93–99` registers an `onclose` handler:

```typescript
transport.onclose = () => {
  this.logger.log(`Session closed: ${sessionId}`);
  this.mcpService.disconnect(sessionId);   // clears mcpSessionState + agentSessions
  this.agentRegistry.disconnectBySession(sessionId);
};
```

`McpService.disconnect(sessionId)` and `AgentRegistry.disconnectBySession(sessionId)` are both correct in isolation — verified by source inspection during the playbook run. The chain is:

```
client closes MCP session → transport.onclose fires → disconnect() → registry/cache cleaned
```

What we observe: the leftmost trigger never happens. `transport.onclose` is from `StreamableHTTPServerTransport` in `@modelcontextprotocol/sdk`. In Streamable HTTP, "closing" a session normally requires the client to issue `DELETE /mcp` (per spec, optional) — there is no TCP `FIN` to detect because HTTP requests are short-lived. CC CLI on SIGTERM appears not to issue the `DELETE`.

### Why MCP servers usually need a liveness mechanism

The MCP Streamable HTTP spec leaves session liveness to the implementation. Common patterns:

1. **Heartbeat/ping** — server pings the client (or vice versa) at a fixed interval; missed pings beyond a threshold mark the session dead.
2. **Last-seen timestamp** — every request updates `lastSeenAt`; a periodic reaper sweeps and evicts sessions older than N minutes.
3. **Explicit DELETE on shutdown** — relies on graceful client cooperation. Insufficient on its own (SIGKILL, container OOM, network split all bypass it).

Quorum currently has none of the three. The `transport.onclose` callback is the only cleanup hook, and it only fires on the spec's optional explicit close.

## Implementation Details

A single mechanism is not enough. Three layers compose into a complete fix; each closes a different temporal gap. Skipping any one of them means there is some window during which agents still route to a dead moderator.

### Layer 1 — Active liveness check at routing time (closes the routing-window gap)

Without this layer, between the moment the moderator dies and the moment the reaper (Layer 3) sweeps, an agent invoking `invoke_agent(target=moderator)` is routed to the dead `McpElicitationConnection` and waits the full elicitation role timeout (5 min after [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md)) before failing.

`McpElicitationConnection.isConnected()` currently hardcodes `return true` (with a source comment acknowledging it as optimistic). Replace with a `lastSeenAt`-based check:

- Track `lastSeenAt: number` on the bound `McpSessionState` (or directly on the connection); update it in the `POST /mcp` request middleware so every client poll refreshes it.
- `isConnected()` returns `now - lastSeenAt < LIVENESS_GRACE_MS`, where `LIVENESS_GRACE_MS` is set to comfortably exceed the SDK client's longest expected idle gap (CC CLI's MCP client polls/heartbeats — measure the actual cadence; tentatively 30–60s, never less than the longest expected SSE keepalive interval to avoid false negatives).
- The broker already gates routing on `isConnected()` via the registry (see `AgentRegistry.isAvailable`); once it returns `false`, `invoke_agent(target=moderator)` fails fast with the existing "agent not available" envelope. No new error path needed.

This is the single most important layer for the user-visible bug: it makes the dead-moderator failure mode return in milliseconds instead of minutes.

### Layer 2 — TCP keepalive on the SSE socket (faster onclose firing)

Streamable HTTP MCP carries server→client traffic over a Server-Sent Events socket. The existing `transport.onclose` handler at `mcp.controller.ts:93–99` is correct; the reason it never fires today is that Linux defaults TCP keepalive to ~2 hours. Docker's bridge network does not surface a dead peer until then — the server's TCP stack still believes the SSE socket is alive even though the moderator container is gone.

Set socket-level keepalive on the SSE response stream when the transport binds:

- `socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS)` plus `TCP_KEEPINTVL` / `TCP_KEEPCNT` via `setsockopt` (or via `setKeepAliveInitialDelay` if the Node version exposes it).
- Tune so dead peers are detected in roughly 30–60s (e.g. initial delay 15s, interval 5s, count 6 → ~45s detection).
- After the kernel marks the socket dead, the SDK's `transport.onclose` fires; existing `disconnect(sessionId)` chain runs.

Layer 2 makes the well-behaved case (graceful client shutdown that just doesn't issue `DELETE`) close in tens of seconds instead of hours.

### Layer 3 — Periodic liveness reaper (defense in depth)

Add a `setInterval` reaper (e.g. every 30s) that:

1. Scans `mcpSessionState`.
2. Marks any session whose `lastSeenAt` is older than `SESSION_IDLE_TIMEOUT_MS` (default 2 minutes; configurable) as stale.
3. Calls `disconnect(sessionId)` — same code path as `transport.onclose` and Layer 1's check.
4. Logs the eviction at `log` level: `Session reaped (idle): {sessionId} lastSeen=<timestamp>`.

This catches anything Layers 1 and 2 miss (e.g. a session that became stale right after a `lastSeenAt` update but never sent another request because the client was wedged but didn't TCP-close). It also bounds memory growth across long-running mcp-server processes.

Don't reap sessions that have an in-flight elicitation — the elicitation request itself is the only outbound traffic on the server side, and the client is legitimately idle waiting for the user to answer. Either gate the reaper on `mcpSessionState[sessionId].pendingElicitations === 0`, or update `lastSeenAt` whenever the SDK's request lifecycle progresses (heartbeat, partial response, etc.).

### Layer 4 (optional) — Best-effort `DELETE` on graceful shutdown

In `apps/agent/`, install a SIGTERM handler that calls the MCP client's `close()` (which the SDK turns into a `DELETE` request). Caveats:

- The moderator's CC CLI is a third-party binary — we cannot patch its SIGTERM behavior. So this only helps the four agent services.
- Does nothing for SIGKILL, container crashes, network partitions.
- Cheap to add as a complement; not load-bearing if Layers 1–3 are correct.

### Layer 5 (optional) — Make `AgentRegistry.connected` derive from liveness for `HttpAgentConnection` too

Layer 1 fixes `McpElicitationConnection`. The four `HttpAgentConnection`-backed agents have their own optimistic `isConnected()` semantics — their staleness window is shorter (HTTP per-request) but not zero. Independent ticket if anyone hits the corresponding misroute; out of scope here.

### Summary of the gap each layer closes

| Layer | Closes gap | Cost |
|-------|------------|------|
| 1. `isConnected()` reads `lastSeenAt` | Sub-second routing-time decision; `invoke_agent` fails fast | Minimal — touches `McpElicitationConnection` + per-request middleware |
| 2. TCP keepalive on SSE socket | ~30–60s for transport-level cleanup; `transport.onclose` fires reliably | Low — `setKeepAlive` calls in transport binding |
| 3. Reaper | Bounded backstop for everything Layers 1–2 miss; bounds memory | Low — single `setInterval`; logging and unit-test surface |
| 4. SIGTERM `DELETE` (optional) | Sub-second cleanup for graceful agent shutdown only | Trivial — `process.on('SIGTERM', ...)` |
| 5. `HttpAgentConnection.isConnected()` (optional) | Tightens HTTP agent path | Out of scope |

### Out of scope

- Fixing the MCP elicitation timeout itself — that is [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md). The two bugs interact (a dead moderator multiplies elicitation pain), but the fixes are independent.
- Adding general per-MCP-tool observability (separate ticket if we want it).

## Acceptance Criteria

- [ ] After `docker compose restart moderator`, `curl -s http://localhost:3000/registry` no longer reports `moderator: connected: true` against the dead session — either the entry is removed within `SESSION_IDLE_TIMEOUT_MS` of restart, or its `connected` field flips to `false`
- [ ] `mcp-server` logs include at least one `Session reaped (idle)` (or equivalent) line per stale-session sweep that finds anything to evict
- [ ] An agent invoking `invoke_agent(target=moderator)` while no moderator session is attached returns `success: false` with a clear `error: "moderator not connected"` (or similar) within `<= SESSION_IDLE_TIMEOUT_MS + tolerance` rather than waiting the full elicitation timeout
- [ ] Reaper does not evict sessions that have an in-flight elicitation (test: keep an elicitation pending for >`SESSION_IDLE_TIMEOUT_MS`, verify session survives, answer, verify normal completion)
- [ ] `mcpSessionState` and `agentSessions` size remain bounded across repeated restart cycles (test: 10 moderator restart cycles, assert map sizes return to baseline)
- [ ] Unit coverage: `McpService.disconnect` is exercised by both `transport.onclose` AND the new reaper path
- [ ] `npm run build`, `npm run lint`, `npm run test` pass

## Dependencies and References

### Prerequisites
- None — the cleanup mechanism lives entirely in `apps/mcp-server/`

### What This Blocks
- Production-readiness of the moderator restart path
- QRM6-008 Scenario 9 cannot pass cleanly until cleanup is verifiable
- Future work that relies on registry truthfulness (operator dashboards, observability tools, supervisor-driven agent restarts)

### Relationship to Other Bugs
- [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md) — separate root cause, but stacks with this one: a dead moderator session today silently times out at 60s. After QRM7-001 lands, the `invoke_agent` returns "not connected" immediately; after QRM6-BUG-008 lands, even a stuck-but-alive elicitation has a saner timeout
- [QRM6-BUG-010](QRM6-BUG-010-broker-timeout-causes-retry-storm-duplicate-sdk-sessions.md) — agent-side dedup. Confirmed working in the 2026-05-01 capture (two teamlead POSTs sharing a correlationId returned at the same instant). Necessary but not sufficient on its own — the moderator still issued a stale-state-driven retry that BUG-010 only papered over.
- [QRM6-BUG-011](QRM6-BUG-011-server-side-sse-heartbeat-tcp-keepalive.md) — server-side SSE heartbeat / TCP keepalive. Confirmed working in the same capture (`keepaliveFired=true`, `writableFinished=true` on a 6m 33s POST). Complementary: BUG-011 prevents the server-to-client stream from dying on idle; this ticket prevents the registry from lying about which client is alive.
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — unrelated SDK-side bug; mentioned only because both surfaced in the same playbook run

### References
- `apps/mcp-server/src/mcp/mcp.controller.ts:93–99` — `transport.onclose` handler (correct but never invoked)
- `apps/mcp-server/src/mcp/mcp.service.ts` — `disconnect()` implementation (correct, never called via the close path)
- `apps/mcp-server/src/registry/agent-registry.service.ts` — `disconnectBySession()` (correct, never called via the close path); `getAll()` returns stale `connected: true`
- `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` — would be the right place to surface a liveness signal at the connection level
- [Anthropic MCP specification — Streamable HTTP transport](https://modelcontextprotocol.io/) — session lifecycle and DELETE semantics
- **Discovered during:** QRM6-008 playbook run 2026-04-25 — Scenario 9. Reproduction was performed host-side after the moderator playbook completed: restart triggered, no cleanup logs observed, registry queried before/after.
- **Re-confirmed and promoted to QRM7-001 on:** 2026-05-01. Live-log analysis of `logs/mcp-server-20260501T144144.jsonl` showed 49 sessions created / 0 closed / 0 reaped over an 11h 25min window, with only 1 `Registered agent: moderator` line and a 15:02 reconnect cadence — quantitative confirmation that the bug has been actively manifesting in every QRM6 production run.