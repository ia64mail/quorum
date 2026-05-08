# QRM7-010: Moderator's MCP Client Holds Stale Session ID Across Long Idle — First 1–4 Tool Calls After Resume Fail With "Session not found"

**Status:** Open

## Summary

After a long idle gap, the moderator's CC CLI MCP client retries `POST /mcp` with a server-reaped `Mcp-Session-Id`, surfaces `Session not found` / `Server not initialized` to the model, and does not auto-handshake to mint a new session. The user must manually type `/mcp` to force the reconnect, and 1–4 retries are typical before traffic resumes. The bug fires reliably under at least two distinct trigger classes — host hibernation ([the 2026-05-06 → 08 QRM8 design run](../logs/sessions/2026-05-06-qrm8-roadmap-run.md), four post-idle resumes Bursts B–E, all ≥ 10 h hibernation gaps) and **continuous-uptime long idle on an awake host** (observed 2026-05-07 evening, this conversation: the moderator's CC CLI was attached from morning, the laptop ran continuously, and after several hours of low/no user activity the same `Session not found` symptom reproduced). Together they account for every burst-resume failure observed so far.

The two triggers have **different root causes**, both load-bearing for any complete fix:

1. **Hibernation false reap (under our control).** [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)'s reaper compares `Date.now() - state.lastSeenAt` (`apps/mcp-server/src/mcp/mcp.service.ts:123`) — a *wall-clock* delta. During host hibernation, both `Date.now()` and `lastSeenAt` halt, but the SSE keepalive that would have refreshed `lastSeenAt` is paused too. On resume, `Date.now()` jumps forward by the wall-clock elapsed (laptop hibernation duration) while `lastSeenAt` is still pre-hibernation, so the very first reaper tick sees a 10 h diff and evicts the moderator's session — even though the SSE socket and the CC CLI client on the other end woke up in the same instant and are perfectly reachable.

2. **Genuine long idle on a running host (root cause not yet pinned down; CC CLI is third-party).** When the laptop runs continuously for many hours but the moderator is mostly idle, the moderator's GET/SSE stream is presumably torn down somewhere in the stack — CC CLI internal idle timeout, OS-level TCP timeout, NAT/conntrack idle close on the Docker bridge, or a silent `res.write()` back-pressure failure that the server interprets as success. Whichever path fires, the server's SSE keepalive stops refreshing `lastSeenAt`, the reaper *correctly* evicts the dead session, and CC CLI's next `POST /mcp` arrives carrying a session ID the server already retired. Because Claude Code CLI 2.1.126 — and the upstream `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` it depends on — violates MCP Streamable HTTP spec §2.5(4) by **not** re-issuing an `InitializeRequest` on HTTP 404, the failure surfaces as a hard error rather than a transparent re-handshake. The spec-violating behavior is unfixed across at least 9 closed GitHub issues spanning 2025-09 → 2026-05; Anthropic's own docs explicitly state that not-found errors are *not* retried (treated as "configuration errors"), which is a de facto refusal to comply with spec §2.5(4).

The ticket addresses both triggers in layers: Part 1 closes the hibernation false-reap (purely server-side); Part 2 adds a moderator-container supervisor that watches CC CLI's PTY for the canonical error strings and pipes `/mcp` back into the session, neutralizing trigger (2) at the cost of screen-scraping a third-party UI; Part 3 is a follow-on diagnostic step (with concrete instrumentation) to pin down the trigger-(2) root cause so we can decide whether a future server-side mitigation (tighter SSE keepalive cadence, write-result back-pressure handling, session-aliasing) makes Part 2 retire-able.

## Problem Statement

### Observed behavior — `2026-05-06 → 2026-05-08` QRM8 roadmap session

47 hours, 5 work bursts separated by laptop-hibernation gaps of 10 h 30 m, 12 h 50 m, 11 h 02 m, and 10 h 58 m. Every burst after the first opened with the moderator narrating one of:

> "MCP session is not connecting. I'll proceed with local reads…"
> "Server-side session truly gone. Could be the MCP server restarted, or a network blip."
> "Predicted — the 8h idle wiped my MCP client session. Re-registering."
> "MCP dropped again — same pattern as before (works for a few calls, then loses session)."

Each time the moderator retried `register_agent` and `new_conversation` 1–4 times. Quantitatively (cross-checked against `mcp-server-20260506T015623.jsonl`):

| Metric | Value |
|---|---|
| `Session created` events over 47 h | 325 (`~5 min` cadence — CC CLI's internal transport recycler) |
| `Registered agent: moderator` events | **3** (initial attach + 2 post-idle re-attaches) |
| Burst-resume retries before `register_agent` succeeded | 1, 2, 4, 2 (Bursts B / C / D / E) |
| User-visible friction per burst | ~1–4 minutes |

The mcp-server was running uninterrupted across the whole run (confirmed by live `EmbeddingPipelineService` debug logs with no restart marker). Every burst-resume failure originates client-side: the CC CLI client's cached `Mcp-Session-Id` no longer matches anything in the server's `sessionStates` map after the reaper-on-resume eviction described in cause (1).

In Burst D the recovery took 4 retries spanning 8 minutes; in Burst E, 2 retries. **Neither was self-resolving — the user's `/mcp` was always required.**

### Observed behavior — `2026-05-07` evening, continuous uptime

Reported during the conversation in which this ticket was drafted. Different trigger class from the QRM8 run:

- The moderator's CC CLI session was attached the morning of 2026-05-07. The host laptop ran continuously through the day with no hibernation, no suspend, no `docker compose restart` of the mcp-server, and no manual moderator detach.
- During the day the moderator was mostly idle (low user activity; no agent dispatches in this window).
- In the evening, on the next user prompt, CC CLI surfaced `Session not found` on the first MCP tool call — the same symptom shape as the QRM8 hibernation-resume cases.

This rules out hibernation as a necessary precondition. It also rules out a wall-clock jump (`Date.now()` and the libuv monotonic timebase advance together when the host is awake), which means **Part 1's monotonic-clock fix would not have prevented this case**. The trigger here is a genuine reaping of the moderator's session by `apps/mcp-server/src/mcp/mcp.controller.ts:reapStaleSessions()` after `lastSeenAt` legitimately aged out — the SSE keepalive that should have been refreshing `lastSeenAt` every 30 s evidently stopped doing so at some point during the day.

Why the keepalive stopped is not yet pinned down (see Part 3). Plausible candidates, in rough order of likelihood:

| # | Candidate | Notes |
|---|---|---|
| (a) | CC CLI internally closed the long-poll GET stream after some idle threshold | CC CLI is observed to recycle MCP transports on a ~5–8 min cadence in active operation; idle behavior is undocumented but a long-idle teardown would match the symptom. |
| (b) | Docker bridge `conntrack` / NAT idle close on the GET stream | Defaults are days, not hours, so unlikely on a default host — but worth confirming with `conntrack -L` and `sysctl net.netfilter.nf_conntrack_tcp_timeout_established`. |
| (c) | Silent `res.write()` back-pressure failure | Node's `res.write()` returns a boolean indicating drain state but doesn't error if the kernel buffer fills behind a wedged client. The server's SSE keepalive (`mcp.controller.ts:startSseKeepalive`) does not currently inspect that boolean — every successful syscall refreshes `lastSeenAt`, even if the bytes never reach the client. |
| (d) | TCP keepalive probe failure detected mid-day | The `mcp-server` `sysctls` configure ~45 s detection of dead peers. If the link to CC CLI ever broke transiently (laptop wifi roam, Docker bridge re-IP), the SSE socket would close, `transport.onclose` would fire, the session would be removed — and CC CLI's POST cache would not learn. Diagnostic: `Session closed:` log lines in `mcp-server-*.jsonl` for the moderator session. |

Crucially, candidates (a) and (b) and (d) tear down the GET stream cleanly enough that the server *does* eventually reap; the bug only manifests because CC CLI's POST cache never learns. Candidate (c) is the only one where the *server* is wrong (it thinks the client is alive when it isn't); fixing it would be a server-side correctness win independent of CC CLI behavior.

### Why retry-blasts sometimes appear to "self-resolve"

In Burst D, the user observed: *"last time we did it, you had some issues with connecting MCP which somehow were self-resolved after a few retries."* The mechanism is luck — between the 1st failed retry and the 2nd, CC CLI's internal transport recycler (the ~5-minute cadence above) may rotate to a fresh transport, at which point the next `register_agent` opens a new server session and succeeds. There is no deterministic recovery path on the client side; the user's `/mcp` is the only reliable lever.

### Severity

| Dimension | Impact |
|---|---|
| **User-visible friction** | ~1–4 min per post-idle resume burst. Across 4 burst-resumes in the QRM8 run, ~10 min of operational tax against ~30 min of actual agent wall time — a 33 % overhead. |
| **D9 / D10 viability under [QRM8](QRM8-000-roadmap.md)** | High. D9 (cross-turn agent session resume) and D10 (`new_conversation` returns `git pull` reminder) both add MCP traffic at *every* turn boundary. Today's failure is concentrated on the first `register_agent` after a long idle gap; post-D9/D10 it migrates onto the moderator's `new_conversation` and turn-start probes — exactly the calls D10 wants to be mechanical. With both hibernation- and continuous-uptime-idle triggers now confirmed, **D9/D10 do not survive the moderator's own-client MCP fragility unless Parts 1 + 2 of this ticket land together.** |
| **Confusion in failure attribution** | Moderate. The moderator's narration ("the mcp-server restarted", "a network blip") is a misdiagnosis — the server was never down. Operators reading the digest may chase ghost server problems unless this ticket's fix lands or the failure mode is documented in `docker/moderator/CLAUDE.md`. |
| **Work output** | None — the architect's invocations all completed. CC CLI's user is the recovery agent (manual `/mcp`). The moderator does not lose data. |

### What this ticket is NOT

- **Not the agent-side dual** ([QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md), already shipped). Agents run on `apps/agent/src/connection/mcp-client.service.ts:65-87`'s wrapper that catches `Session not found`, closes the transport, reconnects, and retries once. CC CLI has **no equivalent**, and CC CLI cannot be patched.
- **Not [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md)** (agent retry races MCP initialize). That fixes the *agent's* retry path. This ticket's bug is the *moderator's* missing retry path entirely.
- **Not the QRM7-009 narrowing**. [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) leaves moderator sessions in scope of the reaper — exactly the path this ticket addresses. The two are complementary: QRM7-009 stops the reaper from churning agent sessions; this ticket stops it from spuriously reaping the moderator on hibernation resume.
- **Not the Anthropic OAuth-refresh issue** (the 5 forced `/login` cycles in the same session log). That is a separate bug class and will be filed separately.

## Design Context

### Cause (1) — wall-clock reaping vs. hibernation

`apps/mcp-server/src/mcp/mcp.service.ts:120-123`:

```typescript
isSessionAlive(server: McpServer): boolean {
  const state = this.sessionStates.get(server);
  if (!state) return false;
  return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
}
```

`Date.now()` returns wall-clock milliseconds (`CLOCK_REALTIME`-equivalent). `lastSeenAt` is set to `Date.now()` on every POST/GET, on every successful SSE keepalive write, and at session creation (`mcp.service.ts:96`, `:115`).

During hibernation:

- Node's `setInterval` is backed by libuv's monotonic timer (`CLOCK_MONOTONIC`), which **does not advance during suspend** on Linux. So the reaper interval doesn't fire while paused.
- Likewise, the SSE keepalive `setInterval` does not fire — no `res.write(': ping\n\n')`, no `touchSession()`. `lastSeenAt` is frozen at its pre-hibernation value.
- TCP keepalive on the SSE socket (`mcp-server` `sysctls`: 15 s/5 s/6) likewise pauses; no probes are sent or received.

On resume:

- The host's wall clock is corrected via `hwclock`/NTP. `Date.now()` jumps forward by the hibernation duration.
- The reaper's `setInterval` ticks (within ~30 s after resume).
- `Date.now() - lastSeenAt` ≈ hibernation duration ≫ `SESSION_LIVENESS_TIMEOUT_MS = 120_000`.
- `isSessionAlive()` returns `false`. Reaper evicts the moderator's session via `disconnect()` + map deletes.
- The CC CLI client, which woke up in the same instant and observed essentially zero monotonic time elapsed, is still holding the (now-evicted) `Mcp-Session-Id` and the (still-open from its perspective) SSE GET stream.
- Next CC CLI tool call → `POST /mcp` with the stale session ID → server returns 404 / 400 / "Server not initialized" depending on which path is hit first.

The post-fix evidence in QRM7-001's "Residual gap" section foreshadowed this: *"There remains a window of up to `SESSION_LIVENESS_TIMEOUT_MS` (2 min) where CC CLI's transport is dead but `lastSeenAt` hasn't expired."* What the QRM8 run revealed is the *opposite* failure: the transport is **alive** but `lastSeenAt` has expired (because of the wall-clock jump). QRM7-001 did not anticipate hibernation as a vector — its monitoring use case was ordinary idle, where `Date.now()` and the SSE keepalive cadence move together.

### Cause (2) — CC CLI / `@modelcontextprotocol/sdk` does not honor MCP §2.5(4)

The MCP Streamable HTTP specification (latest stable revision **2025-11-25**, identical wording in 2025-03-26 and 2025-06-18) is unambiguous in *§ Session Management* clauses 3 and 4:

> **3.** The server **MAY** terminate the session at any time, after which it **MUST** respond to requests containing that session ID with HTTP 404 Not Found.
>
> **4.** When a client receives HTTP 404 in response to a request containing an `Mcp-Session-Id`, it **MUST** start a new session by sending a new `InitializeRequest` without a session ID attached.

Source: `https://modelcontextprotocol.io/specification/2025-03-26/basic/transports` (and the 2025-11-25 successor at `…/specification/2025-11-25/…`).

The TypeScript SDK that CC CLI bundles (`@modelcontextprotocol/sdk`, `packages/client/src/client/streamableHttp.ts`) does not implement clause 4. The `_send()` method's response-handling block special-cases `401` (OAuth re-auth) and `403` (insufficient scope) but treats every other non-OK response as a generic `SdkError(SdkErrorCode.ClientHttpNotImplemented, …)` and throws. On 404 specifically, the SDK:

- does **not** clear `this._sessionId` (only cleared by user-driven `terminateSession()`),
- does **not** call `onclose`,
- does **not** auto-retry as `initialize`,
- surfaces the failure with `status: 404` in `extra` — and CC CLI's MCP client wrapper does not consume that signal to drive a re-handshake.

Anthropic's own documentation (`https://code.claude.com/docs/en/mcp` § Automatic reconnection) describes this as deliberate:

> The same backoff applies when an HTTP or SSE server fails its initial connection at startup. As of v2.1.121, Claude Code retries the initial connection up to three times on transient errors such as a 5xx response, a connection refused, or a timeout, then marks the server as failed if it still cannot connect. **Authentication and not-found errors are not retried because they require a configuration change to resolve.**

So: there is a known, documented design decision in Claude Code to treat 404 as fatal/configuration. This contradicts MCP §2.5(4)'s `MUST`. We cannot expect Anthropic to flip it; we have to handle it on our side.

This ticket's recommended primary fix (Part 1) sidesteps cause (2) entirely by removing the trigger that produces the 404 in the first place. The optional Part 2 (supervisor) addresses cause (2)'s residual cases.

## Prior Art

Cause (2) is a well-documented, recurring class of bug across multiple MCP client implementations. None of the canonical Claude Code issues have been fixed; they have been closed as "not planned" or "duplicate" without a code change.

### Claude Code GitHub issues — direct duplicates of this bug

| # | Title | State | Notes |
|---|---|---|---|
| [#8338](https://github.com/anthropics/claude-code/issues/8338) | "404 for Invalid Session ID should trigger a new session" | Closed NOT_PLANNED 2026-01-22 | The canonical bug. Cites spec §2.5(4) verbatim. Repro on the SDK's own example server. |
| [#9608](https://github.com/anthropics/claude-code/issues/9608) | "When CC receives HTTP 404 with a session ID error from an MCP server it should start a new session but it doesn't" | Closed NOT_PLANNED 2026-03-20 | CC v2.0.17. Error: `-32001 "Session not found"`. |
| [#17412](https://github.com/anthropics/claude-code/issues/17412) | "MCP HTTP client doesn't re-initialize session after 'Server not initialized' error" | Closed NOT_PLANNED 2026-03-20 | CC v2.1.4. Same exact error text as our run. |
| [#27142](https://github.com/anthropics/claude-code/issues/27142) | "MCP Streamable HTTP client does not re-initialize after server-side session invalidation" | Closed (auto-dup) 2026-03-28 | Includes a 7-day frequency study: 14 forced restarts across 14 sessions. |
| [#21032](https://github.com/anthropics/claude-code/issues/21032) | "Todoist MCP loses session with 'No transport found for sessionId' error" | Closed NOT_PLANNED 2026-03-11 | CC v2.1.19. **`/mcp reconnect` itself does not resolve — only full restart.** |
| [#21721](https://github.com/anthropics/claude-code/issues/21721) | "MCP HTTP transport fails after ~89 minutes without automatic reconnection" | Closed DUPLICATE → #21032 2026-02-02 | Time-bounded variant; matches the moderator's hibernation pattern. |
| [#10250](https://github.com/anthropics/claude-code/issues/10250) | Meta-issue, MCP `area:auth` | **OPEN** | Anthropic engineer `bhosmer-ant` posted "should be fixed in v2.1.41" for the OAuth-reconnect leg only. Commenter `axeldunkel` confirmed on **CC v2.1.45** the 404 → re-init path is *still broken*; our session log uses v2.1.126 with no relevant changelog entry between 2.1.41 → 2.1.133. |
| [#54136](https://github.com/anthropics/claude-code/issues/54136) | "Reconnect/restart MCP servers from Claude Code in Claude Desktop without Cmd+Q" | **OPEN** 2026-04-28 | Same bug surfacing in Desktop. |

### Auto-reconnect feature requests — all closed without a fix

[#1026](https://github.com/anthropics/claude-code/issues/1026) (manual reconnect UI shipped 2025-07-31), [#10129](https://github.com/anthropics/claude-code/issues/10129), [#15232](https://github.com/anthropics/claude-code/issues/15232), [#15904](https://github.com/anthropics/claude-code/issues/15904), [#36308](https://github.com/anthropics/claude-code/issues/36308), [#56937](https://github.com/anthropics/claude-code/issues/56937), [#30224](https://github.com/anthropics/claude-code/issues/30224), [#24350](https://github.com/anthropics/claude-code/issues/24350) — all closed as duplicates / not-planned.

### Same bug in other MCP clients

- [`microsoft/vscode#253854`](https://github.com/microsoft/vscode/issues/253854) — VS Code's MCP client has the identical 404 → re-init gap.
- [`modelcontextprotocol/python-sdk#1676`](https://github.com/modelcontextprotocol/python-sdk/issues/1676) — Python SDK has the same gap.
- [`danny-avila/LibreChat#11868`](https://github.com/danny-avila/LibreChat/issues/11868) — LibreChat ignores SSE 404 when session exists.
- [`google/adk-go#399`](https://github.com/google/adk-go/issues/399) — Go ADK caches sessions without validating.

This is a systemic cross-implementation gap, not a Claude-Code-specific oversight; the MUST clause has been widely under-implemented.

### Claude Code release notes — does any 2.x version fix this?

Surveyed `https://github.com/anthropics/claude-code/releases` (CHANGELOG) for v2.1.107 → v2.1.133 (latest as of 2026-05-07). MCP entries:

- 2.1.110: SSE mid-response drop fix (different code path).
- 2.1.113: concurrent-call timeout disambiguation.
- 2.1.118: `/mcp` menu OAuth re-auth surfacing; hooks can call MCP tools.
- 2.1.122: `/mcp` shows hidden connectors.
- 2.1.126 (our version): no MCP-session entry. Closest is "Fixed 'Stream idle timeout' error after waking Mac from sleep mid-request" — that's the model-API stream, not the MCP transport.
- 2.1.128: `/mcp` shows tool counts; reconnects no longer flood the conversation.
- 2.1.132: tools/list silent-failure retry.
- 2.1.133: HTTP(S)_PROXY for MCP OAuth.

**No release in this window addresses 404 → re-initialize, stale session, or post-idle handshake.**

### Mitigation patterns the community has settled on

1. **Manual `/mcp` reconnect** — built-in, partial. #21032 reports `/mcp reconnect` does *not* resolve some stale-session cases; only restart works. Matches our Burst-D experience (4 retries needed).
2. **`mcp-remote` proxy wrapper** — `claude mcp add <name> -- npx -y mcp-remote@latest <url>`. Reframes the transport as stdio-from-CC's-perspective; `mcp-remote` then handles HTTP session re-handshake itself. Most cited workaround, but adds a third-party process and re-introduces stdio's own quirks.
3. **Server-side aliasing / silent renewal** — server accepts any `Mcp-Session-Id`, rebinds it to a fresh internal session, never returns 404. Violates spec §2.5(3) but unblocks broken clients. Discussed below as Option C.
4. **Pty/supervisor wrapping CC stdin** — no first-class tooling found. `claude-code-supervisor` on PyPI wraps the Claude Agent **SDK** (not the CLI). Watching CC's stderr for `Session not found` / `-32001` and piping `/mcp` into stdin via `node-pty` would be original work.
5. **Custom MCP tool that triggers reconnect** — not feasible: the tool itself runs over the broken transport.

## Implementation Details

Three parts. Originally drafted as "Part 1 fixes the dominant case, Part 2 is optional"; revised after the 2026-05-07 evening observation, which falsified that framing — Part 1 only addresses the hibernation trigger, and the continuous-uptime trigger needs Part 2 to be neutralized in our deployment. Part 3 is the diagnostic step needed to decide whether Part 2 can later retire in favor of a server-side fix.

| Part | Trigger addressed | Code location | Status |
|---|---|---|---|
| **1** | Hibernation false reap (trigger 1) | `apps/mcp-server/src/mcp/mcp.service.ts` | In scope, primary |
| **2** | Continuous-uptime long idle (trigger 2) | `docker/moderator/entrypoint.sh` + new supervisor | In scope, primary |
| **3** | Diagnostic instrumentation to identify trigger-(2) root cause | `apps/mcp-server/src/mcp/mcp.controller.ts` (logging only) | In scope, blocks future de-scoping of Part 2 |

### Part 1 — Switch session-liveness tracking from wall-clock to monotonic time

**Scope: trigger (1) only.** This part fixes the hibernation false-reap. It does **not** help the continuous-uptime case, where `Date.now()` and the monotonic clock advance together — `lastSeenAt` is genuinely stale and the reaper is correct to evict.

The CC CLI client and the mcp-server are both Docker containers on the same host: when the host hibernates, both pause together; when the host resumes, both resume together. From the *MCP* perspective essentially zero time passed — but our reaper, comparing wall-clock timestamps, sees ~10 h elapsed and reaps. Eliminating that false reap eliminates the hibernation trigger that produces the 404 CC CLI cannot recover from. The cause-(2) bug (CC CLI not honoring §2.5(4)) remains latent under hibernation but stops firing.

**Concrete change.** Track `lastSeenAt` in monotonic milliseconds (`Number(process.hrtime.bigint() / 1_000_000n)` or `performance.now()`), and compare against a monotonic `now()` of the same kind in `isSessionAlive()`. Files affected:

- `apps/mcp-server/src/mcp/mcp.service.ts:25` — `SESSION_LIVENESS_TIMEOUT_MS` unchanged (still 120 s); add a private helper `private monoNow(): number { return Number(process.hrtime.bigint() / 1_000_000n); }`.
- `apps/mcp-server/src/mcp/mcp.service.ts:96, :115` — initialize and refresh `lastSeenAt` from `monoNow()` instead of `Date.now()`.
- `apps/mcp-server/src/mcp/mcp.service.ts:123` — `isSessionAlive()` compares `monoNow() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS`.

Other `Date.now()` call sites in the file (`:250` `handlerStart`, `:270` `handlerMs`) are duration logging — those should stay on wall clock so the existing log-derived metrics keep their semantics. The change is scoped precisely to the liveness-check timestamps.

**Why `process.hrtime.bigint()` and not `Date.now()` with NTP-jump compensation.** A naïve "detect a clock jump > N × interval, treat as paused" heuristic in the reaper tick is fragile:

- It doesn't help the SSE keepalive's `lastSeenAt` refresh, which would need its own jump-detection.
- It doesn't help the moderator's `livenessCheck` closure (`mcp.service.ts:340`), which is consulted on the routing path independent of the reaper tick.
- It misclassifies legitimate NTP step adjustments as "paused" — uncommon in normal operation but real on first-boot or after a long DST transition window.

The monotonic switch is a single locus of change and is correct by construction: the elapsed monotonic time across hibernation is exactly the elapsed monotonic time of the host being awake, which is the right signal for "has this client actually been silent."

**Side-effect on `transport.onclose` semantics.** None. `transport.onclose` fires from socket-level events (TCP keepalive failure, explicit DELETE) and is independent of `lastSeenAt`. After the change, hibernation resume:

1. Both ends wake. Sockets resume in established state. `lastSeenAt` still freshly inside the 120 s window in monotonic time.
2. The next reaper tick (within ~30 s wall-clock after resume) sees `monoNow() - lastSeenAt ≈ 30 s < 120 s` → does **not** evict.
3. CC CLI's next tool call lands on the still-bound session and succeeds.

The "Residual gap" the QRM7-001 verification noted (a 2-minute window where CC CLI's transport is dead but `lastSeenAt` hasn't expired) remains unchanged — that's the genuine-death case, addressed by Part 2 below.

### Part 2 — Moderator-container supervisor that types `/mcp` on canonical errors

**Scope: trigger (2), and any future trigger of the same shape (genuine session reaping).** Originally drafted as optional; promoted to load-bearing after the 2026-05-07 evening observation showed the bug fires under triggers Part 1 cannot fix.

The viable lever, since CC CLI is third-party and won't be patched: wrap the `claude` invocation in a small supervisor that owns CC's stdin/stdout via a pseudo-terminal, watches the streams for the canonical error strings, and pipes `/mcp` into the live session.

**Implementation sketch.** A Node script using `node-pty` (or a Python equivalent using `pexpect`) that replaces the `exec tail -f /dev/null` step at the end of `docker/moderator/entrypoint.sh`. When the user invokes `docker compose exec -it moderator claude`, the supervisor proxies the PTY:

- Detect canonical error strings in the model's tool-output stream and CC CLI stderr:
  - `Session not found`
  - `Bad Request: Server not initialized` / `Server not initialized`
  - `MCP error -32001`
  - `No transport found for sessionId`
  - The `Streamable HTTP error: Error POSTing to endpoint` envelope
- On match: emit a structured marker line (`[moderator-supervisor] auto-recover via /mcp triggered: pattern=…`) to the supervisor's own stderr, then write `/mcp\r` into the CC CLI session's stdin, then read CC CLI's confirmation panel response, then resume normal proxying.
- Rate-limit: at most one auto-`/mcp` per 30 s and per-pattern, to avoid loops if the recovery itself fails (since [#21032](https://github.com/anthropics/claude-code/issues/21032) reports `/mcp reconnect` does not always resolve the stale session — sometimes only a full restart works; in that case the supervisor escalates by exiting with a non-zero status so `docker compose exec` returns and the user can re-attach to a fresh `claude` invocation).
- Log every auto-recovery attempt to a file under `/home/quorum/.claude/supervisor.log` so the operator can post-hoc audit the cadence.

**Caveats and risks.**

- **PTY scraping fragility.** CC CLI's interactive UI rewraps and scrolls output; matching has to be tolerant of ANSI escapes and line-wrapping. The error strings above appear in the log stream we already capture in `logs/`, but the in-CC-CLI rendering is what the supervisor sees on the PTY. Expect a small iteration cycle to harden the regex against UI churn across CC versions.
- **Mid-input injection.** If the CC CLI session is in input mode with the user mid-typing, injecting `/mcp` would corrupt their input. Two mitigation shapes:
  - (Preferred) Detect "ready for input" via the CC CLI prompt prefix, debounce on recent user keystrokes for ≥ 2 s, and only inject during quiescence.
  - (Fallback) Surface a one-line stderr hint instead of auto-injecting (`[moderator-supervisor] MCP session lost — type /mcp to reconnect`). Less automatic but zero risk of input corruption. Could be a flag-controlled fallback mode for users who don't want the supervisor to type for them.
- **CC CLI version drift.** Slash-command syntax, escape sequences, and panel rendering are not part of any documented stable contract. The supervisor implicitly couples to a CC CLI version range. Pin a tested range and version-check on startup; refuse to auto-inject (fall back to the stderr hint) on unrecognized versions.
- **No public OSS supervisor matches this shape.** `claude-code-supervisor` on PyPI wraps the Claude Agent SDK, not the CLI. This is original work — budget ~150–300 lines of Node + tests, plus a per-CC-version validation step.

**Why not server-side aliasing instead?** Considered and rejected (see Out-of-scope). The MCP `initialize` round-trip carries client capability info the server cannot fabricate without coupling the server tightly to one specific client implementation; the client also generally won't adopt a session-id changed mid-stream. Supervisor injection is uglier but actually works against an unmodified third-party client.

### Part 3 — Diagnostic instrumentation to identify the trigger-(2) root cause

The 2026-05-07 evening incident left us with four plausible candidates (table in Problem Statement) and no way to discriminate. Adding cheap, targeted instrumentation now means the next reproduction will give us a direct answer and let us decide whether Part 2's PTY supervisor is permanent or can be replaced by a server-side fix.

**Three small additions to `apps/mcp-server/src/mcp/mcp.controller.ts`:**

1. **Log SSE `res.write()` return value.** In `startSseKeepalive()` (`mcp.controller.ts:262` area), capture the boolean `res.write()` returns and emit a debug-level log when it returns `false` (kernel buffer full / back-pressure). If we ever see `false` followed by `lastSeenAt` continuing to refresh, that's evidence for candidate (c) — server is wrong about liveness.
2. **Log `Session reaped` with the elapsed *monotonic* idle time and the *wall-clock* timestamp.** Today's reaper log line is `Session reaped (idle): <sessionId>`; extend it to `Session reaped (idle): <sessionId> idleMonoMs=<n> idleWallMs=<n> role=<role>`. Comparing the two values across a real reproduction immediately tells us whether (1) hibernation was at fault (large wall-clock delta + small monotonic delta) or (2) genuine idle (both deltas equal).
3. **Log `transport.onclose` reason.** Today's log is `Session closed: <sessionId>`; extend to `Session closed: <sessionId> reason=<…>` where the reason captures whichever signal triggered close (SDK-provided error, TCP keepalive socket-error event, explicit DELETE). This discriminates candidates (b) and (d).

These three additions are pure logging — no behavior change, no risk. They are blocking acceptance for any decision about retiring Part 2: until we see at least one trigger-(2) reproduction with the new instrumentation, we don't have evidence for which mitigation (tighter SSE keepalive, write-result back-pressure handling, session aliasing, or none of the above) is appropriate.

**Note on telemetry hygiene.** Don't add `Date.now()` deltas in scattered places — make Part 1's monotonic helper public from `mcp.service.ts` and reuse it in the reaper log so the two log lines tell a consistent story.

### Out of scope (alternatives considered)

- **Server-side stale-ID forgiveness.** On a request with an unknown `Mcp-Session-Id`, mint a new session, bind it to the stale ID, return 200. Violates spec §2.5(3) (server MUST return 404). More importantly, the request payload is typically a tool call, not `initialize` — the server cannot fabricate the client's capability set, so the SDK would reject the request anyway. The cleaner version (return 200 with a *new* session ID in the response header, hoping the client picks it up) does not work either: CC CLI / the SDK only adopt session IDs from the `initialize` response, not from arbitrary subsequent responses. Reject for now; revisit if Part 3 instrumentation reveals a viable narrow form (e.g. server synthesizes a fake `initialize` response with hardcoded CC-CLI capabilities — doable but tightly couples the server to a specific client implementation).
- **`mcp-remote` proxy wrapper.** Reframes the transport as stdio-from-CC's-perspective and lets `mcp-remote` manage the HTTP session. Adds a third-party Node dependency to the moderator container, an extra hop on the in-network MCP path, and re-introduces stdio's reconnection caveats. The Part 2 PTY supervisor is functionally equivalent at the layer we control; if Part 2 turns out to be untenable in practice, `mcp-remote` is the natural pivot. Rejected for now.
- **Make `SESSION_LIVENESS_TIMEOUT_MS` very large for the moderator (24 h, 7 d).** Eliminates idle reaping but defeats QRM7-001's original purpose of fail-fast routing for `invoke_agent(target=moderator)` against a dead moderator. Would re-open the bug class QRM7-001 closed. Rejected.
- **Disable the reaper entirely for the moderator session.** Same problem as above. Rejected.
- **Patch `@modelcontextprotocol/sdk` upstream.** Worth filing a ts-sdk PR independently — `_send()` could safely catch 404 and call `_initialize()` once before re-throwing — but it does not help us in the short term because CC CLI bundles its own SDK version. Out of scope here; recommend tracking as a separate community-contribution task.
- **Tightening SSE keepalive cadence (e.g. 30 s → 5 s).** Would close some of the candidate-(c) back-pressure window, but adds traffic per session and doesn't address the documented CC CLI 404-recovery refusal. Defer until Part 3 confirms (c) is the actual mechanism.

### Tests

#### Part 1 — monotonic liveness (unit)

- **Monotonic delta survives wall-clock jumps.** Mock `process.hrtime.bigint()` to advance by 30 s (monotonic) while `Date.now()` advances by 10 h (simulated wall-clock jump). `isSessionAlive()` must return `true`.
- **Monotonic delta still expires after real idle.** Advance `process.hrtime.bigint()` by 121 s, leave `Date.now()` aligned. `isSessionAlive()` returns `false`. Reaper evicts.
- **`register_agent` handler initializes `lastSeenAt` from monotonic clock.** Verify by mocking `process.hrtime.bigint`.
- **SSE keepalive `touchSession()` writes a monotonic timestamp.** Existing keepalive test extended to assert the stored `lastSeenAt` is monotonic, not wall-clock.
- **Existing QRM7-001 unit tests** continue to pass after the type change.

#### Part 2 — supervisor (unit + scripted)

- **Pattern detection.** Feed pre-recorded CC CLI output buffers containing each canonical error string (with realistic ANSI escapes) into the supervisor's matcher; assert each fires the recovery path.
- **Debounce against user keystrokes.** Inject a stream where the error string and a recent keystroke arrive within 500 ms; assert the supervisor *does not* type `/mcp` for at least 2 s after the last keystroke.
- **Rate limit.** Two errors of the same pattern within 30 s; assert only one `/mcp` injection.
- **Version gate.** Mock `claude --version` to an unrecognized string; assert the supervisor falls back to hint-only mode and logs a warning.
- **Fallback escalation.** Simulate a `/mcp` injection that does not clear the error within 30 s; assert the supervisor surfaces the stderr hint and exits with non-zero.

#### Part 3 — instrumentation (unit)

- Existing reaper test extended to assert the new log fields (`idleMonoMs`, `idleWallMs`, `role`) are present and numerically consistent with the configured timeouts.
- New unit test: simulate `res.write()` returning `false`; assert the back-pressure debug line is emitted exactly once.

#### Integration / runbook (manual verification, no CI)

- **Hibernation reproduction (Part 1).** Run the moderator + mcp-server stack, leave the moderator's `claude` session attached, then `systemctl suspend && sleep 3 && systemctl wakeup` (or use `rtcwake`). After resume, issue a tool call from the moderator. Pre-fix: `Session not found` fires within ~30 s. Post-fix: tool call succeeds with no reconnect.
- **Continuous-uptime idle reproduction (Part 2 + 3).** Attach moderator at 09:00, leave idle (host awake) until ≥ 18:00, issue a tool call. Capture `mcp-server-*.jsonl` and `supervisor.log`. Pre-fix: `Session not found` requires manual `/mcp`. Post-fix: either auto-recovered by the supervisor (Part 2), or surfaced as a clear stderr hint and the Part 3 instrumentation pinpoints which trigger candidate fired. The findings are appended to this ticket as an Implementation Note.

## Acceptance Criteria

### Part 1 — Monotonic liveness

- [ ] `apps/mcp-server/src/mcp/mcp.service.ts` uses a monotonic clock (`process.hrtime.bigint()` or equivalent) for `lastSeenAt` initialization, refresh (`touchSession()`), and the `isSessionAlive()` comparison.
- [ ] `Date.now()` remains the source of all *duration* / *human-readable timestamp* logging (handlerMs, log timestamps) — only the liveness-check timestamps switch to monotonic.
- [ ] All existing QRM7-001 unit tests in `mcp.service.spec.ts` and `mcp.controller.spec.ts` continue to pass.
- [ ] New unit test: a session whose monotonic `lastSeenAt` is fresh remains alive *even when wall-clock `Date.now()` has jumped* by ≥ 1 hour (simulating a hibernation wake-up).
- [ ] New unit test: a session whose monotonic `lastSeenAt` is stale (≥ 121 s of monotonic elapsed) is reaped, regardless of wall-clock state.
- [ ] After deploy, a host suspend → resume cycle of ≥ 10 minutes does not produce `Bad Request: Server not initialized` / `Session not found` on the moderator's first tool call after resume.

### Part 2 — Moderator-container PTY supervisor

- [ ] `docker/moderator/entrypoint.sh` (or a new sibling supervisor script) wraps the user's `claude` invocation in a PTY that detects the canonical error strings listed in Part 2 above.
- [ ] On match, the supervisor injects `/mcp` into the live CC CLI session, debounced against recent user keystrokes (≥ 2 s quiescence) and rate-limited (one auto-recovery per 30 s per pattern).
- [ ] If `/mcp` injection does not clear the error within ~30 s, the supervisor falls back to a stderr hint (`MCP session lost — please restart the claude session`) and lets the user decide.
- [ ] The supervisor logs every auto-recovery attempt to `/home/quorum/.claude/supervisor.log` with a structured marker line.
- [ ] CC CLI version is checked at supervisor startup; injection is disabled (hint-only mode) on unrecognized versions to avoid coupling silently to UI changes.
- [ ] After deploy, a continuous-uptime long-idle reproduction (e.g. attach moderator at 09:00, leave idle until 18:00, issue a tool call) either succeeds transparently after one auto-`/mcp` injection, or surfaces the clear stderr hint without any prompt corruption.

### Part 3 — Diagnostic instrumentation

- [ ] `Session reaped (idle)` log line is extended with `idleMonoMs=<n> idleWallMs=<n> role=<role>` so hibernation false reaps (large wall, small mono) are distinguishable from genuine idle (both equal).
- [ ] `Session closed:` log line is extended with `reason=<…>` where `…` captures the close trigger (SDK error, TCP keepalive failure, explicit DELETE).
- [ ] `startSseKeepalive` logs a debug-level entry the first time `res.write()` returns `false` for a session, indicating back-pressure (candidate (c) in the trigger table).
- [ ] After deploy, the next continuous-uptime reproduction yields a single log block that lets us discriminate among trigger-(2) candidates (a)/(b)/(c)/(d) without further code changes. The result should be appended to this ticket as an Implementation Note before any decision to retire Part 2.

### Cross-cutting

- [ ] `npm run build`, `npm run lint`, `npm run test` all pass.

## Dependencies and References

### Surfaced by

- [`logs/sessions/2026-05-06-qrm8-roadmap-run.md`](../logs/sessions/2026-05-06-qrm8-roadmap-run.md) — Issue 2. Four hibernation-gap burst-resumes, 1–4 retries each, ~10 min user-visible friction.

### Related

- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — introduced the wall-clock-based reaper. This ticket fixes the hibernation-vs-reaping interaction without changing QRM7-001's core design (layered liveness + reap; only the timestamp source changes). All QRM7-001 acceptance criteria continue to hold.
- [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md) — the agent-side dual: agent's retry path races the re-init handshake. Different code path (`apps/agent/src/connection/mcp-client.service.ts`), different error class. Complementary; neither blocks the other.
- [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) — narrows the reaper to elicitation-backed (moderator) sessions. Leaves the moderator squarely in scope, which is exactly what this ticket addresses. If both ship, QRM7-009's narrowing applies first (agents stop being reaped at all), then this ticket's monotonic-clock fix prevents the moderator from being false-reaped on hibernation resume.
- [QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md) — agent-side reconnect-on-`Session-not-found`. Established the pattern this ticket cannot apply to the moderator (CC CLI is third-party); recovery has to come from removing the trigger or from a supervisor.
- [QRM8-000](QRM8-000-roadmap.md) D9 / D10 — both add MCP traffic at every turn boundary, which is precisely when the moderator's MCP session is most likely to be just-reaped today. This ticket is a soft prerequisite for D9 / D10 landing cleanly.

### Out of scope

- Anthropic OAuth refresh on long idle (Issue 1 in the same session log; separate ticket).
- Server-side prevention of `Server not initialized` as the spec response (it's spec-correct; the bug is client-side recovery).
- Patching `@modelcontextprotocol/sdk` upstream to honor §2.5(4) (worth a community PR; out of scope here).

### Key files

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts:25, :96, :115, :120-123, :340` | The `lastSeenAt` lifecycle and `isSessionAlive()` comparison — the entire Part 1 change is here. |
| `apps/mcp-server/src/mcp/mcp.controller.ts:55, :76` | The reaper interval and its `isSessionAlive()` consultation. No code change required (the type / source of `lastSeenAt` flows in transparently); existing reaper tests will need their fakes updated. |
| `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` | The `livenessCheck` closure path — unchanged behaviorally; just consumes the new monotonic semantics through `isSessionAlive()`. |
| `docker/moderator/entrypoint.sh` (`exec tail -f /dev/null` near EOF) | Insertion point for the Part 2 supervisor — replace `tail -f /dev/null` with a small Node/`node-pty` proxy that wraps the user's `claude` invocation. New file under `docker/moderator/supervisor/` for the proxy itself. |
| `apps/mcp-server/src/mcp/mcp.controller.ts:startSseKeepalive` and `reapStaleSessions` | Insertion point for Part 3 instrumentation (write-result logging, `idleMonoMs`/`idleWallMs` on reap log, `reason` on close log). |
| `logs/sessions/2026-05-06-qrm8-roadmap-run.md` | Issue 2 narrative; the four hibernation-gap timeline rows in the "Note on Run Shape" table are the cleanest reproduction. |
| `mcp-server-20260506T015623.jsonl` | Server-side log; 325 `Session created` events and only 3 `Registered agent: moderator` events confirm the client-side stale-session pattern. |

### External references

- [MCP Streamable HTTP spec § Session Management (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#session-management) — clauses 3 and 4 (server MAY terminate / client MUST re-initialize on 404). Identical wording in 2025-06-18 and 2025-11-25 (current stable).
- [Claude Code MCP docs § Automatic reconnection](https://code.claude.com/docs/en/mcp) — Anthropic's documented design that 404 / not-found errors are *not* retried.
- Canonical Claude Code GitHub issues: [#8338](https://github.com/anthropics/claude-code/issues/8338), [#9608](https://github.com/anthropics/claude-code/issues/9608), [#17412](https://github.com/anthropics/claude-code/issues/17412), [#21032](https://github.com/anthropics/claude-code/issues/21032), [#21721](https://github.com/anthropics/claude-code/issues/21721), [#27142](https://github.com/anthropics/claude-code/issues/27142), [#10250](https://github.com/anthropics/claude-code/issues/10250) (open meta-issue).
- Same bug in adjacent ecosystems: [`microsoft/vscode#253854`](https://github.com/microsoft/vscode/issues/253854), [`modelcontextprotocol/python-sdk#1676`](https://github.com/modelcontextprotocol/python-sdk/issues/1676), [`danny-avila/LibreChat#11868`](https://github.com/danny-avila/LibreChat/issues/11868).
- [TypeScript SDK source — `streamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/streamableHttp.ts) — the `_send()` method's response-handling block special-cases 401/403 only; 404 is rethrown without re-init. The spec-required §2.5(4) handling is unimplemented at the SDK layer.