# QRM7-009: Scope MCP Session Reaper to Moderator (Elicitation) Sessions

**Status:** Open

## Summary

Restrict [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)'s `lastSeenAt`-based reaper and `isConnected()` liveness check so they only apply to `McpElicitationConnection`-backed sessions (the moderator). Agent sessions, whose `HttpAgentConnection` routes via a stable callback URL, are not reaped on idle — they remain in `sessionStates` until the transport explicitly closes or `register_agent` re-binds the role. This eliminates the dominant trigger of [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md) (mid-invocation idle reaping forces an unnecessary reconnect that exposes a race in the retry path) and removes a class of pure-collateral-damage churn from every agent burst.

## Problem Statement

### What QRM7-001 actually solved, and what it didn't mean to break

QRM7-001 was triggered by an agent → moderator routing failure: when the moderator's MCP session died, the broker routed `invoke_agent(target=moderator)` to a dead `McpElicitationConnection` and waited the full 5-minute elicitation timeout against a corpse. The fix needed liveness signals for the moderator's session because **`McpElicitationConnection` routes elicitations back over the same live transport** — if the transport is dead, the connection is unreachable, and the broker has no other path.

The fix used a generic mechanism (`lastSeenAt` on every `McpSessionState`, a periodic reaper that touches every session) because at the time the asymmetry between connection types wasn't load-bearing. The 47-hour QRM8 design run (`logs/sessions/2026-05-06-qrm8-roadmap-run.md`) made the asymmetry load-bearing.

### The asymmetry the reaper ignores

| Connection type | How the broker reaches it | Liveness signal needed? |
|---|---|---|
| `McpElicitationConnection` (moderator) | Through the live MCP session — elicitation flows back over the same transport | **Yes** — if the session is dead, the connection is permanently unreachable until re-attach |
| `HttpAgentConnection` (agent) | `POST {callbackUrl}/invoke` — opens a fresh HTTP connection at delivery time | **No** — Docker DNS resolves the callback URL to the running container regardless of MCP session state; the agent's MCP session is only used for the agent's *outbound* tool calls, not for inbound delivery |

Agents already act on this asymmetry on the read side: `HttpAgentConnection.isConnected()` hardcodes `return true` (QRM7-001 Layer 5 was explicitly out of scope) and the broker successfully routes to agents whose MCP sessions have died many times over — every burst in the QRM8 run produced successful inbound `POST /invoke`s while the agent's MCP session was being reaped and reconnected in the background.

But the reaper still runs on agent sessions. The result is **pure collateral damage**: 

- Reaping forces the agent to reconnect on its next outbound MCP call.
- That reconnect path is the QRM5-BUG-005 retry-once flow, which has the QRM7-008 race.
- The race produces one failed tool call per reap event, even though the broker would have routed correctly the whole time.
- Total benefit of reaping the agent session: zero (the broker wasn't going to use the session's liveness signal anyway).

### Concrete cost in the QRM8 design run

Across 47 hours and 8 architect invocations:

- **10** `Registered as architect` events (1 startup + 9 reaper-driven reconnects).
- **9** `Server not initialized` events (one per reaper-driven reconnect, modulo the QRM7-008 race).
- **6** `context_query mode=search` calls — every one failed on first attempt; architect stopped retrying mid-burst.
- **0** broker-level routing failures from these reconnects (the broker never needed the agents' session liveness; HTTP routing always worked).

Every single one of those 9 failures was structurally avoidable. The reaper's contribution to the architect's run was 9 spurious failures and zero correctness improvements.

### Why mid-invocation reaping happens

`SESSION_LIVENESS_TIMEOUT_MS` is 120s and the reaper scans every 30s. Agents routinely spend 3+ minutes inside a single invocation on local SDK work (Edit/Read/Grep/Bash) without touching MCP — see Burst E in the QRM8 run, which had two failures in one invocation 3.5 minutes apart. The 120s window is fine for the moderator (its CC CLI client maintains an SSE stream that touches `lastSeenAt` every 30s on success), but agents have no equivalent stream — when they're not making tool calls, their session ages out.

This is fundamental to the architecture: agents *should* be free to do long stretches of local work without thinking about MCP keepalive. Forcing them to either (a) keep their MCP session warm via heartbeats they don't otherwise need, or (b) absorb a reconnect every few minutes, is a leaky abstraction.

## Design Context

### Where to draw the line

Three semantic categories of MCP session live in `sessionStates` today:

| Category | Detection | Reap behavior under this ticket |
|---|---|---|
| **Moderator (elicitation-backed)** | `state.role === AgentRole.moderator` after `register_agent` | **Reap on idle** — needed for routing fail-fast and for invalidating the bound `McpElicitationConnection` |
| **Agent (HTTP-backed)** | `state.role` is in `DEPLOYABLE_AGENT_ROLES` | **Do not reap on idle** — broker routes via callback URL; session liveness is irrelevant |
| **Anonymous (no `register_agent` ever fired)** | `state.role` is `undefined` — typically CC CLI's transport recycling on the moderator's outbound channel | **Reap on idle** — pure memory bounding; these sessions never registered an agent and are observable in QRM7-001's post-fix evidence (13 reaped sessions in one 10h run, on a ~5-min transport recycle cadence) |

The implementation question is whether to key the decision on `state.role` (simple, role-identity coupling) or on the connection type registered for that session (cleaner, but requires a registry lookup). Recommendation: key on `state.role` for now — it's a one-line change in the reaper and `isSessionAlive()`, and the role identity *is* the asymmetry being expressed (moderator vs. deployable agent roles).

### Memory-bounding worry

Without the idle reaper, do agent sessions accumulate?

- Under steady state: no. Each agent role has one container. `register_agent` with a new session ID for the same role can be made to evict the old session by role (small additive change).
- Under crash/restart: an old agent session persists in `sessionStates` until the new container's `register_agent` evicts it (or the transport's `onclose` fires — which today happens reliably for HTTP-restart-driven closes, see QRM7-001 Layer 2 evidence).
- Under network blips: the agent's `mcp-client.service.ts` reconnects via the existing `transport.onclose` → `handleReconnection()` path. Old session would persist briefly until re-register evicts it.

In all three cases the bound is "at most one stale entry per agent role" — practically negligible (5 deployable roles × small `McpSessionState`). No reaper needed for memory.

### Interaction with QRM7-008

These tickets are **complementary**, not substitutes:

- This ticket eliminates the **dominant trigger** (mid-invocation idle reaping). The agent-side QRM5-BUG-005 retry path stops firing in normal operation.
- QRM7-008 fixes the **race in the retry path itself**. The buggy code at `mcp-client.service.ts:65-87` is unchanged by this ticket and will still produce failures on rare events (mcp-server restart, container crash recovery, etc.).
- Together they make agent-side MCP transport handling robust both in steady state (this ticket) and in failure recovery (QRM7-008).

If only one ships, this ticket is higher-leverage — it removes the operational tax visible in every burst. QRM7-008 hardens a code path that pre-QRM7-001 fired once per server restart and post-this-ticket returns to that frequency.

## Implementation Details

### Change 1 — Scope `isSessionAlive()` to elicitation-backed sessions

**`apps/mcp-server/src/mcp/mcp.service.ts`** — `isSessionAlive()` should return `true` for any session whose role is not `AgentRole.moderator` (and for sessions with no role yet, retain the existing `lastSeenAt` check so anonymous transient sessions are still reapable for memory bounding):

```typescript
isSessionAlive(server: McpServer): boolean {
  const state = this.sessionStates.get(server);
  if (!state) return false;

  // Agent-role sessions don't need liveness tracking — broker routes via
  // callbackUrl on HttpAgentConnection regardless of MCP session state.
  if (state.role && state.role !== AgentRole.moderator) return true;

  return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
}
```

The `livenessCheck` closure passed into `McpElicitationConnection` continues to delegate to this method; the moderator's `isConnected()` semantics are unchanged.

### Change 2 — Skip agent sessions in the reaper

**`apps/mcp-server/src/mcp/mcp.controller.ts`** — `reapStaleSessions()` should call `isSessionAlive()` (which now returns `true` early for agent-role sessions) and continue evicting moderator sessions and anonymous transient sessions on the same `lastSeenAt` rule. The existing logic doesn't need to change if Change 1 is made — it already gates eviction on `isSessionAlive()`.

Verify by code reading: `reapStaleSessions()` evicts sessions where `isSessionAlive()` returns `false`. After Change 1, that's never agent sessions. Done.

### Change 3 — `register_agent` evicts the prior session for the same role

To preserve the memory-bounding property for agents, when `register_agent` runs for an agent role, evict any prior session bound to that role:

**`apps/mcp-server/src/mcp/mcp.service.ts`** — in the `register_agent` handler (or wherever the agent role is bound to the session), before storing the new role on `state`:

1. Iterate `sessionStates` for any other state with the same role.
2. For each match, call the existing `disconnect()` path (so `agentSessions` cache and registry entries are cleaned consistently with `transport.onclose`).
3. Then bind the role to the new session.

The same-role-overwrite pattern is already what `AgentRegistry` does for connection entries (latest registration wins) — this just extends it to the session state map. Idempotent against the typical case where `register_agent` is the first call on a fresh session and no prior session exists.

### Change 4 — Documentation

Update [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)'s post-fix verification section with a forward-pointer to this ticket: "scope of the reaper is narrowed to elicitation-backed sessions in QRM7-009; the data captured here reflects the broader reaper at fix time." The QRM7-001 design and acceptance criteria don't change — it remains correct for the moderator path it was solving.

### What stays the same

- TCP keepalive on SSE socket (Layer 2) — still applies; relevant only for moderator sessions in practice (agents don't use long-lived SSE streams for inbound delivery).
- `transport.onclose` cleanup — still fires for any session, agent or moderator.
- SIGTERM `DELETE` from agent containers (Layer 4) — still applies and remains the cleanest cleanup path on graceful shutdown.
- `HttpAgentConnection.isConnected()` returning `true` — unchanged. This ticket reinforces, not contradicts, the QRM7-001 Layer 5 deferral: agent connections don't need a liveness signal.

### Tests

- **Unit — `isSessionAlive()` returns `true` for agent-role sessions regardless of `lastSeenAt` age.** Stale `lastSeenAt`, agent role, expect `true`.
- **Unit — `isSessionAlive()` continues to return `false` for stale moderator sessions.** Existing QRM7-001 test should still pass.
- **Unit — `isSessionAlive()` returns `false` for stale anonymous sessions.** No role set, stale `lastSeenAt`, expect `false` (memory bounding for transient transport recycles).
- **Unit — `reapStaleSessions()` skips agent sessions, evicts stale moderator + anonymous sessions.** Compose three sessions into the controller, run the reaper, assert only moderator + anonymous evicted.
- **Unit — `register_agent` for an agent role evicts the prior session bound to the same role.** Two sessions, second `register_agent` with same role, assert first session's state is removed and `disconnect()` was called for it.
- **Integration check (manual or runbook):** an architect invocation that idles ≥ 2 minutes mid-invocation produces zero `Server not initialized` events in `architect-*.jsonl`. Reproduces the QRM8 design-run pattern (Burst E specifically) and verifies the trigger is gone.

## Acceptance Criteria

- [ ] `isSessionAlive()` returns `true` for sessions whose role is in `DEPLOYABLE_AGENT_ROLES`, regardless of `lastSeenAt`.
- [ ] `isSessionAlive()` continues to apply the `lastSeenAt` check for moderator sessions and for anonymous (no `register_agent` yet) sessions.
- [ ] The periodic reaper does not evict agent-role sessions on idle.
- [ ] The reaper continues to evict moderator sessions per QRM7-001's existing behavior.
- [ ] The reaper continues to evict anonymous transient sessions on idle (memory bounding for CC CLI transport recycling).
- [ ] `register_agent` for an agent role explicitly evicts any prior session bound to the same role (preserves memory-bounding for agents now that idle reaping is off).
- [ ] After deploy, an agent invocation that includes ≥ 2 minutes of mid-invocation MCP idle produces zero `MCP transport closed, attempting reconnection` and zero `Server not initialized` warnings (verifiable by reproducing the Burst E pattern from `logs/sessions/2026-05-06-qrm8-roadmap-run.md`).
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass.

## Dependencies and References

### Surfaced by

- `logs/sessions/2026-05-06-qrm8-roadmap-run.md` — Issue 3 analysis. The asymmetry between elicitation- and HTTP-backed connections, made operationally visible by 9 reaper-driven reconnects during a single 47-hour session.

### Related

- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — introduced the reaper. This ticket narrows its scope but does not contradict it. QRM7-001's moderator-path acceptance criteria continue to hold under the narrower implementation.
- [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md) — fixes the agent-side retry race. Complementary, not substitutable. This ticket removes the dominant trigger; QRM7-008 hardens the rare-trigger path.
- [QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md) — the original retry-once self-heal. After this ticket, that path returns to its original purpose: handling mcp-server restarts, not idle reaping.

### Out of scope

- Tightening `HttpAgentConnection.isConnected()` to surface real reachability information (QRM7-001 Layer 5; orthogonal — would track HTTP connectivity, not MCP session state).
- Heartbeat / keep-alive on the agent's outbound MCP channel (would solve the same problem from the other side but wastes traffic and changes the cost model).
- Redesigning the reaper's threshold (`SESSION_LIVENESS_TIMEOUT_MS = 120s`) — fine for the moderator path; not relevant for agents under this ticket.

### Key files

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | `isSessionAlive()` — Change 1; `register_agent` handler — Change 3 |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | `reapStaleSessions()` — gates on `isSessionAlive()`; behavior changes implicitly via Change 1 |
| `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` | `livenessCheck` closure path — unchanged in interface, semantics unchanged for moderator |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | Tests for `isSessionAlive()` and `register_agent` same-role eviction |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | Tests for reaper behavior with mixed-role session population |
| `logs/sessions/2026-05-06-qrm8-roadmap-run.md` | Operational evidence for the asymmetry; 9 reaper-driven reconnects, 0 routing failures from those reaps |