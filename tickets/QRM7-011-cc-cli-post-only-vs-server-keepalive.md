# QRM7-011: CC CLI POST-Only Access Pattern Incompatible with Server's SSE-Based Liveness Keepalive

**Status: Closed — Superseded by [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) (2026-05-09)**

> **Falsified by runtime instrumentation 2026-05-09 evening.** The "POST-only" premise is wrong. The diagnostic logging added in commit `623faca` (per-tick reaper snapshot + `markSseOpened` flip log) shows CC CLI 2.1.126 opens a `GET /mcp` SSE stream within ~20 ms of every session creation, **before** `register_agent` arrives. That makes Candidate B's `hasOpenedSse` exemption a no-op for every moderator session: by the time `state.role = moderator` is set, `state.hasOpenedSse` is already sticky-true, so the exemption branch never fires. Candidate A's timeout bump (since reverted) was the only mitigation actually working. See [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) for the corrected mechanism, the lesson on why this and QRM7-010 both got it wrong, and the next fix plan.
>
> **Code state at supersession:**
> - Candidate A (`SESSION_LIVENESS_TIMEOUT_MS` 120 000 → 1 800 000) — landed at `2ac2657`, reverted at `447f953`. Currently 120 000 (2 min).
> - Candidate B (`hasOpenedSse` exemption) — landed at `447f953`. **Dead code in the running bundle.** No revert pre-QRM7-012; QRM7-012 Candidate B replaces it with a live-SSE-response signal.
> - Candidate C (investigation) — superseded; QRM7-012 Candidate D refocuses the question from "why doesn't CC CLI open SSE" to "why does the SSE stream die mid-session," carrying forward the QRM7-010 Part 3 instrumentation draft.
> - Diagnostic logging from `623faca` (reaper snapshot, `markSseOpened` flip log) — **kept**, per QRM7-012's recommendation. Cost is negligible; value is preventing iteration 4 of this ticket on a different wrong premise.

**Supersedes:** [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md)

## Summary

Claude Code CLI 2.1.126 communicates with the MCP server exclusively via POST requests and never opens an SSE `GET /mcp` long-poll stream. The server's 2-minute liveness timeout (`SESSION_LIVENESS_TIMEOUT_MS = 120_000`) is calibrated for SSE-bridged clients whose `lastSeenAt` is refreshed every 30 seconds by the SSE keepalive ping. Without SSE, `lastSeenAt` is only refreshed by POST traffic. Any natural gap > 2 minutes between tool calls (user reading, typing, thinking) causes the reaper to evict the session. This is the root cause of every observed `Session not found` failure in the moderator's interactive use.

## Evidence

### Source

Single mcp-server lifecycle from `/app/logs/mcp-server-20260508T134859.jsonl`, spanning `2026-05-08T13:48:59Z` through `2026-05-09T01:06:20Z` (~11 h 17 min). Single mcp-server process, single moderator CC CLI process throughout.

### Aggregate metrics

| Metric | Value |
|---|---|
| Total `Session created` + `Session reaped` events | **279** |
| POST count | **1160** |
| Real GET (SSE long-poll) requests | **0** — the only "GET" lines are NestJS startup `RouterExplorer` route-mapping logs (`Mapped {/mcp, GET} route` etc), not actual GET requests |
| Successful `BootstrapContext` (= delivered `invoke_agent` calls) | **3** (morning QRM7-004 doc-update, evening ping `092a785e`, evening QRM7-010 update `021a69f9`) |
| `keepaliveFired=true` events on POST close | **0** (every POST close logs `keepaliveFired=false`) |

### The metronomic 5-minute CC CLI churn

Sample slice from the 10 h idle window — fully representative of the entire span:

```
14:18:19 Session created: 0083cf3d-...   ->   14:20:29 Session reaped (idle): 0083cf3d-...
14:23:19 Session created: 66973090-...   ->   14:25:29 Session reaped (idle): 66973090-...
14:28:20 Session created: 1716f846-...   ->   14:30:29 Session reaped (idle): 1716f846-...
14:33:21 Session created: b72dc365-...   ->   14:35:29 Session reaped (idle): b72dc365-...
14:38:22 Session created: b7a552d5-...   ->   14:40:29 Session reaped (idle): b7a552d5-...
... (continues every ~5 min through the entire 10 h idle) ...
```

CC CLI opens fresh MCP sessions on a ~5-minute cadence (background heartbeat / transport recycler / SDK reconnect logic — exact trigger uncertain). Each session sees only the `initialize` POST, never a GET. The session reaps 2 min 10 s after creation (the liveness timeout plus reaper-sweep granularity). This cycle is independent of moderator activity — it ran at the same cadence through the entire 10 h idle when nothing was happening on the moderator side.

### Session `551e208f` post-mortem

The sharpest single-session reproduction:

```
00:35:44 Agent moderator registered via MCP elicitation (session-bound)
00:38:00 Session reaped (last "background" reap before evening turn)
00:40:20 Session created: 551e208f-...
00:40:20.446-.468 Burst of 5 POSTs (200/202/200/200/200), all durationMs=1-20, keepaliveFired=false
00:42:30 Session reaped (idle): 551e208f-...   <- exactly 2:10 after last POST
00:43:59 POST status=404 sessionId=551e208f    <- user-visible "Session not found"
```

The 5 POSTs at 00:40:20 successfully refreshed `lastSeenAt` (the `mcp.controller.ts:140` `touchSession` call is verified by the data). Then ~2 min of the user composing dispatch text and reading output — completely normal interactive behavior. Session reaped at 00:42:30, exactly the 2-min liveness window plus reaper-sweep granularity. The 404 at 00:43:59 is the user-visible failure. **No GET stream was ever opened for this session** — the keepalive had nothing to write to.

### The architectural mismatch

The server's keepalive mechanism (`mcp.controller.ts:266`, 30 s `setInterval` writing to the SSE stream and refreshing `lastSeenAt`) requires an open SSE GET stream to function. CC CLI 2.1.126 never opens that stream — zero `GET /mcp` requests in 11+ hours. Without SSE, the keepalive has nothing to write to, so `lastSeenAt` is only refreshed on POST traffic. POST traffic in interactive moderator usage has natural 30 s–10 min gaps (user reads, types, thinks). Any gap > 2 min reaps the session.

This is **not** "long idle" (sessions reap in 2 min, not hours). It's **not** "hibernation wall-clock jump" (reproduced on a continuously awake host). It's **not** "SDK refuses to reinit on Session not found" (the SDK does reinit silently in some call paths). And it's **not** "silent reinit doesn't re-establish SSE" (per the data, **SSE is never established at all**, by silent reinit OR by the initial handshake).

## Trigger Taxonomy

Clean replacement for QRM7-010's confused three-part taxonomy:

| Trigger class | Mechanism | Coverage |
|---|---|---|
| **SSE-not-opened** (root cause) | CC CLI uses POST-only; server's 2-min liveness timeout fires on any natural inter-tool-call gap. Covers ~all observed reaps including the 5-min background churn and the `551e208f` reproduction. | All fix candidates (A, B, C) |
| **Server restart** (special case) | State wipe forces 404 on first POST; no session to keep alive. | Covered implicitly by all candidates (new session is created; the timeout question only arises for the new session's lifetime). |

## Implementation Plan

Three fix candidates, ordered by immediacy:

### Candidate A — Cheap mask: bump `SESSION_LIVENESS_TIMEOUT_MS`

**One-line change.** Increase `SESSION_LIVENESS_TIMEOUT_MS` from `120_000` (2 min) to `1_800_000` (30 min) in `apps/mcp-server/src/mcp/mcp.service.ts`.

Doesn't fix the architectural mismatch — POST-only sessions still have no background heartbeat and will reap after 30 min of no POST traffic. But 30 min is long enough to cover all normal interactive use patterns (user reads, types, thinks, takes a coffee break). Stops user-facing breakage during realistic moderator sessions.

**Tradeoff (acknowledged):** extends the fail-fast window for `invoke_agent(target=moderator)` routing against a dead moderator from 2 min → 30 min. QRM7-001 picked the tight 2-min timeout specifically so the broker's `livenessCheck` closure (`mcp.service.ts:340`) could fail-fast on a dead moderator. QRM7-010's "Out of scope" section rejected raising the timeout to "very large" (24 h, 7 d) values for exactly this reason. The 30-min middle-ground is bounded enough that agent→moderator escalation against a dead moderator still surfaces within a single sitting, and Candidate B's POST-only exemption keeps the tight timeout for SSE-backed sessions — so the regression is fully reversed once B ships. Agent→moderator escalation is rare in current flows; the tradeoff is acceptable in the interim.

**Recommended as immediate hotfix.** Highest-value, lowest-risk change. Can land in minutes.

### Candidate B — Principled fix: POST-only session detection and exemption

Detect POST-only sessions server-side and exempt them from idle reaping, parallel to [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md)'s agent-session exemption model.

**Mechanism:**
1. Track whether a session has *ever* opened a `GET /mcp` long-poll stream. New boolean field `hasOpenedSse` on session state, initialized `false`, flipped `true` on first GET.
2. In `reapStaleSessions()`, skip sessions where `hasOpenedSse === false` — these are POST-only clients that have no background heartbeat mechanism.
3. Memory-bound POST-only sessions by `register_agent`-on-same-role eviction (same model QRM7-009 uses for agent sessions). When a new `register_agent` for the same role arrives, the prior session is explicitly cleaned up regardless of its POST-only exemption.

**Touches:**
- `apps/mcp-server/src/mcp/mcp.service.ts` — add `hasOpenedSse` to `SessionState`, check in `isSessionAlive()`.
- `apps/mcp-server/src/mcp/mcp.controller.ts` — set `hasOpenedSse = true` in the GET handler.

**Recommended as the principled fix landing right after A.**

### Candidate C — Investigation: why does CC CLI never open SSE?

Three possibilities:
- **(a)** Our server's `GET /mcp` handler isn't advertised correctly in the MCP `initialize` response — a server-side bug.
- **(b)** CC CLI 2.1.x is POST-only by design (some MCP clients are POST-only per spec) — nothing to do client-side; B is the canonical answer.
- **(c)** Environmental configuration issue (proxy stripping upgrade headers, Docker networking, etc.).

File as investigation. If (a), there may be a fix that coerces the client into opening SSE. If (b), B is the permanent answer. If (c), it's environmental and fixable without code changes.

**Do not block A or B on resolving C.**

### Recommendation

Land **A immediately** (one-line hotfix, stops all user-visible breakage). Land **B** as the principled fix right after. Pursue **C** as a parallel investigation to inform whether the SSE gap is fixable from the server side.

## What QRM7-010 Got Right and Wrong

**Right:**
- The symptom registry: comprehensive catalog of CC CLI GitHub issues, SDK behavior analysis, community mitigation patterns. All remains valid reference material.
- The trigger that the ticket exists at all — this is a real, high-impact operational problem.

**Wrong:**
- **The mechanism.** QRM7-010 identified three trigger classes: hibernation false reap, continuous-uptime long idle (SSE socket drop), and server restart. The actual mechanism is simpler: SSE was never opened in the first place. The "SSE socket drop" framing (candidates a–d in QRM7-010's Problem Statement) was investigating why something broke that never existed.
- **The three-part fix plan.** Part 1 (monotonic `lastSeenAt`) doesn't help — the un-refreshed `lastSeenAt` is real, not a wall-clock illusion; both monotonic and wall-clock time advance together on an awake host. Part 2 (PTY supervisor) solves a downstream symptom, not the root cause — the session shouldn't be dying in the first place. Part 3 (diagnostic instrumentation) pointed at wrong candidates (SSE socket teardown, TCP keepalive failure, `res.write()` back-pressure) when the real answer is that SSE is never established.

## Touches

| File | Change | Candidate |
|------|--------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Bump `SESSION_LIVENESS_TIMEOUT_MS` from `120_000` to `1_800_000` | A |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Add `hasOpenedSse` to `SessionState`; check in `isSessionAlive()` | B |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Set `hasOpenedSse = true` in GET handler; track GET-opened state | B |
| Spec files matching above | Unit tests for new behavior | A, B |

## Depends on

None. Independent of QRM7-008 and QRM7-009. Can land immediately.

## Acceptance Criteria

### Candidate A (hotfix) — Landed and reverted 2026-05-09

- [x] `SESSION_LIVENESS_TIMEOUT_MS` is increased to `1_800_000` (30 min). (Landed at `2ac2657`.)
- [x] Existing unit tests updated to reflect the new timeout value. (Tests reference the constant symbolically — no value updates needed.)
- [x] After deploy, the moderator can sustain a session through normal interactive pauses (up to ~25 min between tool calls) without `Session not found`. (Implicitly verified by the in-session work that built B on top of A: no `Session not found` interruptions during the QRM7-009 + QRM7-011-B implementation across multiple inter-tool-call gaps.)
- [x] **Reverted to `120_000` (2 min) after B landed.** With POST-only moderator sessions exempt at the source, the timeout bump is no longer needed, and the original 2 min restores fail-fast routing for SSE-backed moderators and bounds anonymous transient sessions tightly.

### Candidate B (principled fix) — Landed 2026-05-09

- [x] `SessionState` tracks `hasOpenedSse: boolean`, initialized `false`. (`mcp.service.ts:38-54`)
- [x] `GET /mcp` handler sets `hasOpenedSse = true` on the session. (`mcp.controller.ts:200-205`, via `mcpService.markSseOpened()`)
- [x] `isSessionAlive()` returns `true` for sessions where `hasOpenedSse === false`, regardless of `lastSeenAt`. **Scoped to moderator role only** — anonymous (no-role) POST-only sessions still reap for memory bounding (CC CLI's transport recycler creates these continuously). See implementation note. (`mcp.service.ts:181-187`)
- [x] `register_agent` for the same role evicts prior POST-only sessions (memory bounding). (Already in place from QRM7-009; verified by new test `register_agent same-role eviction works against POST-only sessions`.)
- [x] New unit test: a POST-only session survives past the liveness timeout. (`should return true for stale POST-only moderator session`)
- [x] New unit test: an SSE-backed session is still reaped after the liveness timeout. (`should return false for stale SSE-backed moderator session` and `markSseOpened flips hasOpenedSse so the lastSeenAt check resumes`)
- [x] New unit test: `register_agent` for the same role evicts a POST-only session. (`register_agent same-role eviction works against POST-only sessions`)
- [x] `npm run build`, `npm run lint`, `npm run test` all pass. (714/714.)

## Implementation Notes (Candidate B)

### POST-only exemption is scoped to moderator role, not all roles

The original mechanism description said *"In `reapStaleSessions()`, skip sessions where `hasOpenedSse === false`."* The implementation narrows this to **moderator-role sessions only**. Anonymous (no-role) POST-only sessions still reap on the `lastSeenAt` check because they are CC CLI's transport recycler creating fresh sessions every ~5 min that never call `register_agent` — exempting them would let `sessionStates` grow unbounded. Memory bounding for moderator POST-only sessions is preserved by same-role eviction in `register_agent` (already in place from QRM7-009).

### `hasOpenedSse` is sticky once set

Once a session has opened SSE, the flag stays `true` even if the SSE socket later dies. This is intentional: a session whose SSE has died but whose `lastSeenAt` is fresh is still considered alive (the SSE keepalive must have written recently); a session whose SSE has died and whose `lastSeenAt` is stale should be reaped (per QRM7-010's analysis of "SSE drop during idle"). Without stickiness, an SSE-backed session whose stream silently died would re-classify as POST-only and become permanently exempt — exactly the bug class QRM7-010 was investigating.

### A's timeout bump is now reverted

`SESSION_LIVENESS_TIMEOUT_MS` is back to `120_000` (2 min). The hotfix bump to 30 min was a stop-gap to keep POST-only moderator sessions alive when there was no other exemption mechanism. Now that B exempts them at the source, the original tight 2 min restores QRM7-001's fail-fast routing semantics for SSE-backed moderators and tight memory bounding for anonymous transient sessions. Net: POST-only moderator sessions never reap (B); SSE-backed moderators reap after 2 min of silence (original behavior); anonymous transient sessions reap after 2 min (memory bounding). Agent-role sessions never reap (QRM7-009).

### Candidate C (investigation)

- [ ] Determination of whether CC CLI's POST-only behavior is (a) server-side advertisement gap, (b) client design choice, or (c) environmental.
- [ ] Findings documented in this ticket as an Implementation Note.

## Dependencies and References

### Supersedes

- [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md) — QRM7-010's framing ("SSE drops during idle", "hibernation false reap", "SDK reinit is partial") was technically partially true but missed that SSE was never opened in the first place. The fix plan (monotonic `lastSeenAt`, PTY supervisor, diagnostic instrumentation) all targeted the wrong problem. This ticket replaces QRM7-010 with a clean framing grounded in log evidence.

### Related

- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — introduced the liveness reaper and `SESSION_LIVENESS_TIMEOUT_MS`. This ticket modifies the timeout (A) and the reaper's exemption logic (B).
- [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) — exempts agent sessions from reaping. This ticket extends the exemption model to POST-only moderator sessions (B). Complementary; neither blocks the other.
- [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md) — agent-side retry hardening. Different code path, independent.
- [QRM8-000](QRM8-000-roadmap.md) D9/D10 — both add MCP traffic at every turn boundary; this ticket's fix is a soft prerequisite for D9/D10 landing cleanly.

### External references

- [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) — SSE is optional per spec; POST-only clients are valid.
- QRM7-010's Prior Art section (CC CLI GitHub issues, community mitigation patterns) remains valid reference — see that ticket for the full catalog.
