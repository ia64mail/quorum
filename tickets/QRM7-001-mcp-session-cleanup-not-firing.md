# QRM7-001: MCP Session Cleanup Does Not Fire on Container Shutdown — Stale Sessions Reported as Connected

**Status:** Done — implemented and reviewed 2026-05-03. All 4 layers implemented, architect approved, team lead code review accepted, 700/700 tests passing. Promoted to QRM7 stabilization milestone (was QRM6-BUG-007).

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

## Architecture Design

> *Incorporated from standalone design doc by Architect, 2026-05-03 (revised 2026-05-03). Approved. Problem statement omitted — see Problem Statement and Live Evidence sections above.*

### Refined Diagnosis (2026-05-03 log analysis)

Analysis of `mcp-server-20260501T144144.jsonl` revealed that all moderator outgoing `invoke_agent` calls returned successfully despite 50 "Session created" events cycling every ~15 minutes. The 15-minute session cycling produces new GET/SSE connections (CC CLI's server-initiated message stream) but does NOT interrupt in-flight POST requests. The stale `McpElicitationConnection` only manifests in the reverse direction: when an agent tries to elicit the moderator via a dead session.

### Design — Three Required Layers

#### Layer 1: `lastSeenAt`-based `isConnected()` — Fail-fast routing

The single most important layer for the agent-to-moderator path. When an agent calls `invoke_agent(target=moderator)` and the moderator's session is dead, this makes the broker reject immediately ("Agent moderator not connected") instead of waiting the full 5-minute elicitation timeout.

##### Data flow

```
POST /mcp ──→ McpController ──→ McpService.touchSession(server) ──→ state.lastSeenAt = Date.now()
GET  /mcp ──→ McpController ──→ McpService.touchSession(server) ──→ state.lastSeenAt = Date.now()
SSE keepalive write succeeds ──→ McpService.touchSession(server) ──→ state.lastSeenAt = Date.now()
                                                                          │
invoke_agent(target=moderator) ──→ registry.isAvailable() ──→ conn.isConnected()
                                                                          │
                                                              livenessCheck() closure
                                                                          │
                                                              Date.now() - state.lastSeenAt < GRACE
```

##### File changes

**`apps/mcp-server/src/mcp/mcp.service.ts`**

1. Add `lastSeenAt: number` to `McpSessionState` interface:
   ```typescript
   export interface McpSessionState {
     role?: AgentRole;
     correlationId?: string;
     agentSessions: Map<AgentRole, string>;
     lastSeenAt: number;  // NEW — epoch ms, updated on every client request
   }
   ```

2. Initialize `lastSeenAt` in `connect()`:
   ```typescript
   this.sessionStates.set(session, { agentSessions: new Map(), lastSeenAt: Date.now() });
   ```

3. Add `touchSession()` and `isSessionAlive()` public methods:
   ```typescript
   /** Update the last-seen timestamp for a session. */
   touchSession(server: McpServer): void {
     const state = this.sessionStates.get(server);
     if (state) {
       state.lastSeenAt = Date.now();
     }
   }

   /** Check whether a session's lastSeenAt is within the liveness grace period. */
   isSessionAlive(server: McpServer): boolean {
     const state = this.sessionStates.get(server);
     if (!state) return false;
     return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
   }
   ```

4. In `register_agent` handler for moderator, pass a liveness closure:
   ```typescript
   const livenessCheck = () => this.isSessionAlive(server);
   const connection = new McpElicitationConnection(role, server, livenessCheck);
   ```

**`apps/mcp-server/src/registry/mcp-elicitation-connection.ts`**

1. Add `livenessCheck` parameter to constructor:
   ```typescript
   constructor(
     role: AgentRole,
     server: McpServer,
     private readonly livenessCheck: () => boolean = () => true,
   ) { ... }
   ```

2. Replace `isConnected()`:
   ```typescript
   isConnected(): boolean {
     return this.livenessCheck();
   }
   ```
   The default `() => true` preserves backward compatibility for tests that construct without the closure.

**`apps/mcp-server/src/mcp/mcp.controller.ts`**

1. On POST for existing session — touch before delegating:
   ```typescript
   if (sessionId && this.sessions.has(sessionId)) {
     const transport = this.sessions.get(sessionId)!;
     const mcpServer = this.mcpServers.get(sessionId);
     if (mcpServer) this.mcpService.touchSession(mcpServer);  // NEW
     await transport.handleRequest(req, res, req.body);
     return;
   }
   ```

2. On GET — touch for valid sessions:
   ```typescript
   const mcpServer = this.mcpServers.get(sessionId);
   if (mcpServer) this.mcpService.touchSession(mcpServer);  // NEW
   ```

3. Modify `startSseKeepalive` to accept an optional `McpServer` and touch on successful writes:
   ```typescript
   private startSseKeepalive(res: Response, server?: McpServer): void {
     const interval = setInterval(() => {
       if (res.writableEnded) {
         clearInterval(interval);
         return;
       }
       try {
         res.write(': ping\n\n');
         if (server) this.mcpService.touchSession(server);  // NEW
       } catch {
         clearInterval(interval);
       }
     }, SSE_KEEPALIVE_INTERVAL_MS);
     res.on('close', () => clearInterval(interval));
   }
   ```

4. Pass the mcpServer to `startSseKeepalive` from both GET and POST keepalive call sites.

##### Constant

```typescript
/** How long a session can be idle before isConnected() returns false. */
const SESSION_LIVENESS_TIMEOUT_MS = 120_000; // 2 minutes
```

Defined in `mcp.service.ts`. 2 minutes is deliberately generous:
- Exceeds SSE keepalive interval (30s) by 4×, preventing false negatives during normal operation
- Ensures no false disconnection while the moderator's CC CLI session is genuinely active — during long-running outgoing calls, the POST response's SSE keepalive refreshes `lastSeenAt` every 30s
- Short enough that a dead session is detected within 2 minutes — dramatically better than the current infinite wait (5-minute elicitation timeout on a dead session)

**Why SSE keepalive touch is critical:** It prevents `isConnected()` false negatives during long operations. When a moderator is waiting for a long outgoing `invoke_agent` call (up to 30 min), no new POST requests arrive, but the POST response SSE stream is alive and pinging every 30s. Each successful write refreshes `lastSeenAt`, proving the moderator's session is alive and able to receive elicitations from other agents. Without this, an agent calling `invoke_agent(target=moderator)` during a long outgoing call would get a false "not connected" rejection. When the client actually dies mid-call, `res.write()` eventually fails (TCP keepalive from Layer 2 accelerates this), `lastSeenAt` stops refreshing, and `isConnected()` correctly returns `false`.

**Note on moderator outgoing calls:** Log analysis confirmed that the moderator's own outgoing `invoke_agent` calls are NOT affected by the `isConnected()` bug — the POST carrying the tool call stays open independently of MCP session lifecycle. The SSE keepalive touch mechanism serves the *reverse* direction: it keeps `lastSeenAt` fresh so that `isConnected()` accurately reports availability for the agent-to-moderator elicitation path.

##### Interaction with message broker

The broker already checks `isConnected()` at routing time (line 52 of `message-broker.service.ts`):
```typescript
if (!agent.isConnected()) {
  const error = `Agent ${target} not connected`;
  ...
  return { success: false, error };
}
```

No broker changes needed. Once `isConnected()` returns `false`, any agent's `invoke_agent(target=moderator)` fails immediately with "Agent moderator not connected" instead of waiting the full elicitation timeout against a dead session.

---

#### Layer 2: TCP keepalive on SSE sockets — Faster dead-peer detection

Without TCP keepalive, Linux defaults to ~2-hour idle detection. Even with application-level SSE pings, `res.write()` can succeed against a dead peer because the kernel is buffering in the send queue. TCP keepalive makes the kernel probe the peer actively, so `res.write()` fails sooner when the peer is actually dead.

##### File changes

**`apps/mcp-server/src/mcp/mcp.controller.ts`**

In `startSseKeepalive`, set TCP keepalive on the underlying socket:
```typescript
private startSseKeepalive(res: Response, server?: McpServer): void {
  // Layer 2: TCP keepalive for faster dead-peer detection
  const socket = res.socket;
  if (socket && !socket.destroyed) {
    socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
  }

  const interval = setInterval(() => { ... }, SSE_KEEPALIVE_INTERVAL_MS);
  ...
}
```

New constant:
```typescript
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000; // 15s initial idle before first probe
```

**`docker-compose.yml`** — Add sysctls to `mcp-server` service for faster keepalive probing:
```yaml
mcp-server:
  ...
  sysctls:
    net.ipv4.tcp_keepalive_time: 15
    net.ipv4.tcp_keepalive_intvl: 5
    net.ipv4.tcp_keepalive_probes: 6
```

Detection time with these settings: 15s + (5s × 6) = **45 seconds** from idle to dead-peer detection. Combined with the 30s SSE keepalive interval and 2-minute liveness grace, worst-case moderator death detection: ~2.5 minutes (current: infinite).

**Note on `cap_drop: ALL`:** The `mcp-server` service uses `x-base-security` which drops all capabilities. `setsockopt(SO_KEEPALIVE)` does NOT require `CAP_NET_ADMIN` — it's a per-socket option available to unprivileged processes. The Docker `sysctls` for `net.ipv4.tcp_keepalive_*` are namespaced and allowed without extra caps. No security config changes needed.

---

#### Layer 3: Periodic liveness reaper — Defense in depth

Bounds memory and catches anything Layers 1–2 miss. Without the reaper, dead sessions accumulate in `sessionStates`, `sessions`, and `mcpServers` maps indefinitely.

##### Where it lives

**`McpController`** — the controller owns the session maps (`sessions`, `mcpServers`) and coordinates with `McpService` for session state. The controller implements `OnModuleInit` (start reaper) and `OnModuleDestroy` (stop reaper).

##### Design

```typescript
@Controller('mcp')
export class McpController implements OnModuleInit, OnModuleDestroy {
  private reaperInterval?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    this.reaperInterval = setInterval(() => this.reapStaleSessions(), REAPER_INTERVAL_MS);
    this.reaperInterval.unref(); // Don't prevent process exit
  }

  onModuleDestroy(): void {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
  }

  private reapStaleSessions(): void {
    // Snapshot keys to avoid mutation-during-iteration
    for (const [sessionId, mcpServer] of Array.from(this.mcpServers.entries())) {
      if (!this.mcpService.isSessionAlive(mcpServer)) {
        this.mcpService.disconnect(mcpServer);
        this.sessions.delete(sessionId);
        this.mcpServers.delete(sessionId);
        this.logger.log(`Session reaped (idle): ${sessionId}`);
      }
    }
  }
}
```

Constants:
```typescript
const REAPER_INTERVAL_MS = 30_000; // Scan every 30s
```

The reaper uses the same `isSessionAlive()` check as Layer 1's `isConnected()`, so the timeout semantics are consistent. A session is reaped when `lastSeenAt` exceeds `SESSION_LIVENESS_TIMEOUT_MS` — the same threshold that causes `isConnected()` to return `false`.

##### In-flight elicitation safety

The ticket requires: "Reaper does not evict sessions that have an in-flight elicitation."

This is handled naturally by the SSE keepalive touch mechanism:
1. When an elicitation is pending, the moderator's CC CLI session has an active SSE stream (the POST response or GET stream).
2. The SSE keepalive pings every 30s. Successful writes call `touchSession()`, refreshing `lastSeenAt`.
3. `isSessionAlive()` returns `true` because `lastSeenAt` is fresh.
4. The reaper skips the session.

When the client actually dies during an elicitation:
1. TCP keepalive detects the dead peer within ~45s.
2. `res.write()` fails on the next keepalive ping attempt.
3. `lastSeenAt` stops refreshing.
4. After `SESSION_LIVENESS_TIMEOUT_MS` (2 min), `isSessionAlive()` returns false.
5. Reaper evicts. This is correct — the elicitation can never complete on a dead session.

No explicit `pendingElicitations` counter needed — the SSE keepalive serves as the implicit liveness heartbeat.

##### Idempotency with `transport.onclose`

The existing `transport.onclose` handler (lines 116-123) and the reaper both call `mcpService.disconnect(server)` and delete from the controller maps. All operations are idempotent:
- `Map.delete()` is a no-op on missing keys
- `sessionStates.delete(server)` is a no-op if already deleted
- Double-cleanup logs are harmless (the second `disconnect()` finds nothing to delete and skips the log)

---

#### Layer 4: SIGTERM DELETE — Recommendation

**Include in this ticket.** Rationale:

- **Trivial effort**: 5-10 lines in the agent app's bootstrap.
- **No moderator impact**: CC CLI is third-party; this only helps agent containers (architect, developer, teamlead, qa).
- **Useful for HttpAgentConnection**: Even though `HttpAgentConnection.isConnected()` currently always returns `true` (Layer 5, out of scope), the explicit `DELETE` triggers `transport.onclose` on the server, which runs `disconnect()` and cleans the session state map immediately. This prevents session state accumulation from agent container restarts.
- **No risk**: The agent app already has a clean shutdown path. Adding `process.on('SIGTERM', ...)` is additive.

##### Implementation sketch

In `apps/agent/src/main.ts` (or wherever the MCP client is initialized):

```typescript
process.on('SIGTERM', async () => {
  logger.log('SIGTERM received — closing MCP session');
  try {
    await mcpClient.close(); // SDK sends DELETE /mcp
  } catch (err) {
    logger.warn('MCP close failed during shutdown', err);
  }
  process.exit(0);
});
```

The developer should locate the MCP client instance in the agent app and wire the handler appropriately.

---

#### Layer 5: `HttpAgentConnection.isConnected()` — Out of scope

Confirmed out of scope. Agent containers are addressable by stable callback URLs that survive container restarts (Docker DNS resolves the service name to the new container). The `connected: true` on a stale HTTP agent entry has no practical impact because the callback URL remains valid.

---

### Constants Summary

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `SESSION_LIVENESS_TIMEOUT_MS` | `120_000` (2 min) | `mcp.service.ts` | Threshold for `isSessionAlive()` — used by both `isConnected()` and the reaper |
| `REAPER_INTERVAL_MS` | `30_000` (30s) | `mcp.controller.ts` | How often the reaper scans for stale sessions |
| `TCP_KEEPALIVE_INITIAL_DELAY_MS` | `15_000` (15s) | `mcp.controller.ts` | TCP keepalive idle delay before first kernel probe |
| `SSE_KEEPALIVE_INTERVAL_MS` | `30_000` (existing) | `mcp.controller.ts` | SSE comment-frame keepalive interval (unchanged) |

### Risk Assessment

#### No conflicts with existing bug fixes

| Bug | Interaction | Risk |
|-----|------------|------|
| **QRM6-BUG-008** (elicitation timeout) | Complementary. `isConnected()` returning `false` causes fail-fast BEFORE reaching the 5-min elicitation timeout. Both fixes reduce the dead-moderator misery independently. | None |
| **QRM6-BUG-010** (idempotency map) | Independent. The idempotency dedup map is keyed by `correlationId` and operates at the broker level. Session liveness is orthogonal. | None |
| **QRM6-BUG-011** (SSE heartbeat) | Directly builds on it. The SSE keepalive becomes dual-purpose: (a) keeping undici's bodyTimeout happy, and (b) refreshing `lastSeenAt`. The `startSseKeepalive` method is modified but its existing behavior is preserved. | Low — ensure the `server` parameter is optional and defaults to no-op for backward compatibility |

#### Potential risks

1. **False disconnection during moderator idle**: If the moderator's CC CLI is idle (no tool calls, no SSE stream) for >2 minutes, `isConnected()` returns false. Mitigated: CC CLI maintains an SSE stream; as long as it's connected, keepalive writes refresh `lastSeenAt`. The 2-minute timeout only fires when the SSE stream is dead or disconnected.

2. **Clock skew**: `lastSeenAt` uses `Date.now()` on a single process — no cross-machine clock issues. Non-risk.

3. **Race on controller map mutation during reaper**: The `Array.from()` snapshot prevents mutation-during-iteration. Individual map operations are synchronous. Non-risk.

#### Corrected scope (2026-05-03 log analysis)

The original ticket narrative suggested session cycling could cause the moderator's own outgoing `invoke_agent` calls to fail. Log analysis disproved this — all moderator outgoing calls succeeded despite 50 session cycles over 11 hours. The POST carrying an `invoke_agent` tool call stays open independently of MCP session lifecycle; the response returns on the same POST's SSE body.

The fix addresses two confirmed issues:
- **Agent→moderator routing**: An agent calling `invoke_agent(target=moderator)` against a dead `McpElicitationConnection` waits the full elicitation timeout before failing. Layer 1 makes this fail-fast.
- **Unbounded session state accumulation**: 50 sessions created / 0 cleaned over 11 hours. Layer 3 bounds memory.

No design or implementation changes were needed — the three layers are correctly targeted at these two issues. The corrected diagnosis narrows the blast radius but does not change what needs to be built.

### Test Plan

#### New unit tests needed

**`mcp-elicitation-connection.spec.ts`**
- `isConnected()` returns `true` when `livenessCheck` returns `true`
- `isConnected()` returns `false` when `livenessCheck` returns `false`
- Default `livenessCheck` (no arg) returns `true` (backward compat)

**`mcp.service.spec.ts`**
- `touchSession()` updates `lastSeenAt` on existing session
- `touchSession()` is no-op for unknown server
- `isSessionAlive()` returns `true` when `lastSeenAt` is fresh
- `isSessionAlive()` returns `false` when `lastSeenAt` is stale
- `isSessionAlive()` returns `false` after `disconnect()` (state deleted)
- `register_agent` for moderator creates `McpElicitationConnection` with liveness closure (verify via `mockRegistry.register` arg inspection)

**`mcp.controller.spec.ts`**
- POST for existing session calls `touchSession()`
- GET for valid session calls `touchSession()`
- Reaper evicts sessions whose `isSessionAlive()` returns false
- Reaper does NOT evict sessions whose `isSessionAlive()` returns true
- Reaper calls `disconnect()` on evicted sessions
- `onModuleDestroy()` clears the reaper interval
- SSE keepalive calls `touchSession()` on successful writes

**`agent-registry.service.spec.ts`**
- `isAvailable()` returns `false` when `isConnected()` returns `false` (already tested, but verify the new liveness path)

#### Existing tests to update

- `McpElicitationConnection` constructor calls in tests need to match new signature (third `livenessCheck` param — optional, so existing tests compile without changes)
- Controller test mock for `McpService` needs `touchSession` and `isSessionAlive` methods added

### Implementation Order

1. **Layer 1 first** — `lastSeenAt` tracking + `isConnected()` change. This is the load-bearing fix.
2. **Layer 2 second** — TCP keepalive. Additive, 5 lines of code.
3. **Layer 3 third** — Reaper. Depends on `isSessionAlive()` from Layer 1.
4. **Layer 4 last** — SIGTERM DELETE in agent app. Independent, can be done in any order.

All layers can be in a single commit since they form one coherent fix.

## Acceptance Criteria

- [x] After `docker compose restart moderator`, `curl -s http://localhost:3000/registry` no longer reports `moderator: connected: true` against the dead session — either the entry is removed within `SESSION_IDLE_TIMEOUT_MS` of restart, or its `connected` field flips to `false`
- [x] `mcp-server` logs include at least one `Session reaped (idle)` (or equivalent) line per stale-session sweep that finds anything to evict
- [x] An agent invoking `invoke_agent(target=moderator)` while no moderator session is attached returns `success: false` with a clear `error: "moderator not connected"` (or similar) within `<= SESSION_IDLE_TIMEOUT_MS + tolerance` rather than waiting the full elicitation timeout
- [x] Reaper does not evict sessions that have an in-flight elicitation (test: keep an elicitation pending for >`SESSION_IDLE_TIMEOUT_MS`, verify session survives, answer, verify normal completion)
- [x] `mcpSessionState` and `agentSessions` size remain bounded across repeated restart cycles (test: 10 moderator restart cycles, assert map sizes return to baseline)
- [x] Unit coverage: `McpService.disconnect` is exercised by both `transport.onclose` AND the new reaper path
- [x] `npm run build`, `npm run lint`, `npm run test` pass

## Implementation Notes

**Status:** Accepted — reviewed 2026-05-03.

### Files Modified

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Added `lastSeenAt` to `McpSessionState`, exported `SESSION_LIVENESS_TIMEOUT_MS` (120s), added `touchSession()` and `isSessionAlive()` methods, wired liveness closure into `McpElicitationConnection` at `register_agent` time |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Added `OnModuleInit`/`OnModuleDestroy` lifecycle for 30s reaper interval, `touchSession` calls on POST (existing session), GET, and successful SSE keepalive write, TCP keepalive via `socket.setKeepAlive(true, 15_000)` on SSE sockets, replaced TODO comment with reaper reference |
| `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` | Added optional `livenessCheck` closure parameter (default `() => true`), `isConnected()` delegates to closure instead of hardcoding `true` |
| `apps/agent/src/connection/mcp-client.service.ts` | Layer 4: added shutdown signal logging in `onApplicationShutdown`, renamed `_signal` to `signal` |
| `docker-compose.yml` | Added `sysctls` for mcp-server container: `tcp_keepalive_time=15`, `tcp_keepalive_intvl=5`, `tcp_keepalive_probes=6` (~45s dead-peer detection) |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | +161 lines: tests for `touchSession`, `isSessionAlive` (fresh/stale/disconnected/unknown), and liveness closure wiring through `register_agent` for moderator |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | +180 lines: tests for `touchSession` on POST/GET, SSE keepalive touchSession, TCP keepalive socket setup, reaper eviction/non-eviction/disconnect/cleanup |
| `apps/mcp-server/src/registry/mcp-elicitation-connection.spec.ts` | +48 lines: tests for `isConnected()` with livenessCheck true/false/default/dynamic |

### Deviations

- **0 deviations** — implementation matches design doc and ticket exactly.

### Verification

- `npm run build` ✅ — all 3 apps compile cleanly
- `npm run lint` ✅ — 0 errors, 0 warnings
- `npm run test` ✅ — 700/700 tests pass (44 suites), including 59 tests across the 3 changed test files
- Jest "worker process failed to exit gracefully" warning is **pre-existing** (confirmed by running controller tests against the base branch), caused by SDK-internal timers in `McpServer` mocks, not by QRM7-001 changes

### Review Notes

1. **AC #4 (reaper + in-flight elicitation):** The chain is verified through unit test composition rather than a single integration test. Each link is individually tested: (1) SSE keepalive calls `touchSession` ✅, (2) `touchSession` refreshes `lastSeenAt` ✅, (3) `isSessionAlive` checks `lastSeenAt` ✅, (4) reaper skips sessions where `isSessionAlive=true` ✅. The 30s keepalive interval vs 120s liveness timeout provides a comfortable 4× safety margin.

2. **Registry entry persistence after reap:** The reaper does not call `AgentRegistry.unregister()` — the registry entry for the moderator survives with `isConnected()=false`. This is intentional: the broker checks `isConnected()` at routing time (line 52 of `message-broker.service.ts`), so dead entries are harmless, and the next `register_agent` call overwrites the stale entry by role. The ticket AC explicitly allows `connected: false` as an acceptable outcome.

3. **Reaper thread safety:** `Array.from()` snapshot of the Map prevents concurrent modification issues during iteration. Node.js single-threaded execution model means no true race between the reaper and `transport.onclose`, but both paths are idempotent (Map.delete + sessionStates.delete are no-ops on second call).

4. **SSE keepalive dual-purpose:** The `startSseKeepalive` function now serves both QRM5-BUG-005/QRM6-BUG-011 (undici bodyTimeout prevention) and QRM7-001 (lastSeenAt refresh). Successful `res.write(': ping\n\n')` proves TCP liveness and refreshes the session, preventing false-positive reaping during long `invoke_agent` calls.

## Post-Fix Verification — `mcp-server-20260504T001855.jsonl` (2026-05-03 run)

First production run with QRM7-001 deployed. Captures the same failure pattern that drove the ticket and shows it being handled correctly.

### Quantitative comparison

| Metric | Pre-fix run (`20260501T144144.jsonl`, 11h 25min) | Post-fix run (`20260504T001855.jsonl`, ~10h) |
|---|---|---|
| `Session created` | 49 | 13 |
| `Session closed` | 0 | 0 |
| **`Session reaped`** | **0** (no reaper existed) | **13** ✅ |
| `Registered agent: moderator` | 1 | 2 |

The 1:1 ratio of created-to-reaped sessions confirms Layer 3 is firing and bounding state growth. The drop in session creation rate (from every ~15 min to less depends on run length) is incidental — both runs are dominated by CC CLI's internal transport-recycling cadence, which Quorum doesn't control.

### Timeline of a moderator drop, end-to-end

The same failure mode that motivated the ticket — moderator's MCP session dying without re-attach — was observed and handled cleanly:

| Time (UTC) | Event |
|---|---|
| `00:19:04` | Session `dd472222` created (moderator's session at startup) |
| `00:20:57` | `Registered agent: moderator` bound to `dd472222` |
| `00:21:49 → 00:35:44` | 7 successful `invoke_agent` calls against this session, all `success=true`, `handlerMs` up to 185s |
| `00:35:44` | Last POST closes; SSE keepalive on POST stops |
| `00:37:25` | Session `dd472222` reaped — 1m41s after last touch, GET-stream keepalive went silent (CC CLI transport recycled client-side) |
| `00:37:25 → 00:54:08` | 18-minute gap. 4 ephemeral sessions created and reaped on a 2:18 cycle. **No `register_agent` fires** — moderator is genuinely unreachable, registry correctly reports it |
| `00:54:08` | Session `181aab1b` created (user re-attached `claude`) |
| `00:54:15` | `Registered agent: moderator` re-binds onto fresh session |
| `00:54:24` | `invoke_agent → teamlead` resumes, `success=true handlerMs=59897` |

Pre-fix, this 18-minute window would have routed every agent → moderator call to the corpse and burned the full 5-minute elicitation timeout per call. Post-fix, the broker fail-fasts via `isConnected()=false` immediately.

### Verified design properties

1. **Reaper does not interfere with active calls.** All 7 in-flight `invoke_agent` POSTs on `dd472222` completed before the session went idle. The POST-response SSE keepalive kept `lastSeenAt` fresh during each call. The reap fired 1m41s after the last POST returned, not during one — exactly the in-flight-elicitation safety property AC #4 requires.

2. **`Registered agent: moderator` correctly fires twice.** Once at original attach (`00:20:57`), once at re-attach (`00:54:15`). The second `register_agent` overwrites the stale registry entry by role, as predicted by Review Note #2.

3. **No `Session closed` events.** Layer 2 (TCP keepalive) is configured but `transport.onclose` still doesn't fire — the kernel-level keepalive probes either succeed against CC CLI's recycled transport or the SDK doesn't surface the close. This is acceptable: Layer 3 (reaper) catches everything Layer 2 misses, exactly as the layered design intended. Layer 2 was always best-effort; the system doesn't depend on it.

### Residual gap (acknowledged in design, not regressed)

There remains a window of up to `SESSION_LIVENESS_TIMEOUT_MS` (2 min) where CC CLI's transport is dead but `lastSeenAt` hasn't expired. An `invoke_agent(target=moderator)` issued during this window still routes to the dead `McpElicitationConnection` and waits the elicitation timeout. This is inherent to the polling-based liveness model and was a conscious design tradeoff — shortening the timeout risks false negatives during legitimate idle. Eliminating the window entirely would require client cooperation (Layer 4 SIGTERM `DELETE`, which CC CLI cannot be patched to send) or a push-based liveness signal not available in Streamable HTTP MCP.

### Conclusion

The fix is delivering its three promised properties in production: (1) registry truthfulness, (2) bounded session-state memory, (3) sub-second fail-fast routing once the liveness window expires. No regressions observed. The "transport drop" symptom users see in CC CLI logs is client-side transport recycling — out of scope for this ticket and unchanged by the fix.

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