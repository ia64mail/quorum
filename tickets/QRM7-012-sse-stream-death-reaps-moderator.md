# QRM7-012: Moderator Session Reaped After SSE GET Stream Dies — QRM7-011-B Exemption Is Dead Code

**Status:** Mitigated (Candidates A + E landed and validated 2026-05-10) — third iteration on the same operational bug. Candidate B (live-SSE-response signal) remains open as the principled follow-up; recommended priority bumped after validation revealed Candidate E's keepalive ticks aren't actually refreshing `lastSeenAt` (see Validation Results). Supersedes [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md), which was itself a corrective rewrite of [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md). Both prior framings were falsified by runtime instrumentation added 2026-05-09 evening.

## Summary

CC CLI 2.1.126 **does** open a `GET /mcp` SSE stream — within ~20 ms of session creation, and **before** `register_agent` arrives. That ordering makes QRM7-011-B's `hasOpenedSse` exemption a no-op for every moderator session: by the time `state.role = moderator` is set, `state.hasOpenedSse` is already sticky-true, so the exemption branch never fires and the reaper falls through to the bare `lastSeenAt` check. When the SSE stream subsequently dies for any reason (NAT/conntrack idle eviction, OS-level TCP teardown, CC CLI internal recycle, transient blip), the keepalive stops refreshing `lastSeenAt`, and 2 min after the last POST the reaper evicts the moderator's session. Next POST → 404 → user-visible `Session not found`. Same downstream symptom QRM7-010 and QRM7-011 each tried to fix; the underlying mechanism was misdiagnosed both times.

## Evidence

Single restart on 2026-05-09 with diagnostic logging added in commit `623faca` (per-tick reaper snapshot + `markSseOpened` flip log). Log: `logs/mcp-server-20260509T191135.jsonl`.

### CC CLI opens SSE GET immediately on every fresh session

```
19:11:41.989  Session created: 4c255082    (anonymous)
19:11:42.007  markSseOpened: role=none wasOpenedSse=false   ← GET arrives 19 ms after create
19:11:42.069  Session created: 60c04672
19:11:42.089  markSseOpened: role=none wasOpenedSse=false
19:11:42.081  Session created: 06c0a37b
19:11:42.109  markSseOpened: role=none wasOpenedSse=false
19:11:42.141  Session created: bf46dc83
19:11:42.162  markSseOpened: role=none wasOpenedSse=false
19:12:15.801  Session created: 106c1343
19:12:15.820  markSseOpened: role=none wasOpenedSse=false   ← moderator's eventual session
19:12:45.573  Registered agent: moderator                    ← register fires 30 s LATER
```

Five sessions, five SSE GETs within ~20 ms of session creation, all with `role=none` because `register_agent` hasn't run yet. Once `register_agent` sets `role=moderator` on session 106c1343, it's already too late — `hasOpenedSse` is true and sticky.

### Reaper sees the dead exemption every tick

```
Reaper check: sessionId=106c1343 role=moderator hasOpenedSse=true lastSeenAtAge=46990ms alive=true
```

Hits the third branch of `isSessionAlive` (`Date.now() - lastSeenAt < TIMEOUT`), not the QRM7-011-B exemption (`role===moderator && !hasOpenedSse`). The session stays alive only as long as the SSE keepalive ping refreshes `lastSeenAt`. The moment the SSE stream dies, the 2-min countdown starts.

### Why QRM7-011 missed this

The controller logs `POST finish` and `POST close` debug lines but emits **no per-GET log line**. QRM7-011 counted "0 GET requests in 11 hours" by grepping for GET-tagged log lines that don't exist in our log format. CC CLI was opening GETs all along; we were blind to them. Absence of evidence got read as evidence of absence.

### Metronomic 5-minute session recycle

Same log, every fresh session created after the moderator binds shows the same exact spacing:

| Session id | Created | Δ from previous |
|---|---|---|
| 106c1343 | 19:12:15.801 | (anchor — the moderator's own session) |
| 841d68f6 | 19:17:17.698 | +5:01.9 |
| 9264590f | 19:22:17.698 | +5:00.0 |
| fe7e0ebb | 19:27:18.700 | +5:01.0 |
| 8d729453 | 19:32:19.689 | +5:00.99 |
| (continues) | … | (consistent across the entire log window) |

Metronomic to the second. Not network, not conntrack, not laptop wifi roam — a timer somewhere in CC CLI / the SDK is firing exactly every **300 000 ms**. The number identifies the source.

## Upstream Cause — SDK-side `undici.bodyTimeout` on the GET SSE stream

Searched `modelcontextprotocol/typescript-sdk`, `anthropics/claude-code`, and `nodejs/undici` for the 300-second signal. There is a **single, open, named SDK bug** that matches the symptom precisely:

| Issue | Status | Match |
|---|---|---|
| [modelcontextprotocol/typescript-sdk#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211) — *"SSE stream disconnected: TypeError: terminated" every 5 minutes* | **Open**, labeled `bug / P2 / ready for work` | Direct hit. Code-path analysis on the issue traces it to `packages/.../client/streamableHttp.ts ~line 383`: the GET SSE has no client-side heartbeat, undici's default `bodyTimeout = 300_000` aborts the response body, the SDK catches `TypeError: terminated`, fires `onerror('SSE stream disconnected: …')`, and reconnects (the server sees a brand-new session). Reproduced across Cline, Cursor, playwright-mcp. |
| [anthropics/claude-code#20335](https://github.com/anthropics/claude-code/issues/20335) — *MCP server timeout configuration ignored in Streamable SSE HTTP connections* | Closed as stale, never fixed | "SSE streams disconnect after ~5 minutes regardless of configured timeout values … `MCP_TIMEOUT` env var is ignored; the value never appears in MCP debug logs." Duplicate cluster: [#3033](https://github.com/anthropics/claude-code/issues/3033), [#16837](https://github.com/anthropics/claude-code/issues/16837), [#18684](https://github.com/anthropics/claude-code/issues/18684). |
| [anthropics/claude-code#27142](https://github.com/anthropics/claude-code/issues/27142) — *MCP Streamable HTTP client does not re-initialize after server-side session invalidation* | Closed | Explains the user-visible payload: after the reconnect, CC CLI's POST cache still holds the dead session id and returns 404 instead of transparently re-initializing per MCP spec §2.5(4). |
| undici defaults | — | `headersTimeout = 300_000`, `bodyTimeout = 300_000`. Refs: [nodejs/undici#1987](https://github.com/nodejs/undici/issues/1987), [#1864](https://github.com/nodejs/undici/issues/1864), [#474](https://github.com/nodejs/undici/issues/474). |

**Net diagnosis:**

- The 5-minute metronome is `undici.bodyTimeout` firing in CC CLI's HTTP stack on the GET SSE response. CC CLI doesn't customize the dispatcher; the SDK's `StreamableHTTPClientTransport` doesn't either. The SDK has no client-side keepalive / heartbeat on the GET stream and doesn't send `last-event-id` reconnection hints by default.
- The "GET dies fast within a session, before the first 30 s server-side keepalive can fire" sub-symptom is consistent with the same root cause: between `transport.handleRequest(req, res)` opening the GET response on the server side and the first `setInterval` tick at +30 s, the SDK's read on the body has *nothing to read*. If anything in the path enforces "must produce first byte within N seconds" (Node's default `requestTimeout`, an undici `headersTimeout` interaction, a buffering layer), the stream dies before our keepalive can save it.
- Severity for us: with QRM7-011-B exemption dead and A's timeout bump reverted, every session is a 2-minute time bomb that recycles every 5 minutes anyway — exactly the operator-visible cadence the user describes.

This is **not fixable on the client side**. CC CLI bundles its own SDK version; the SDK fix is upstream and currently unmerged. Mitigation has to be server-side. Three useful levers:

1. **Send the first SSE comment immediately on GET open**, not at +30 s — kicks off the response body so undici sees a chunk before any timer fires.
2. **Tighten the keepalive cadence below 30 s** — defense-in-depth, but not load-bearing.
3. **Cap `lastSeenAt`-based reaping to longer than `undici.bodyTimeout`** — bumps the timeout floor over the 5-min reconnect cadence so the recycled session is created before the previous one reaps.

Candidate E below combines (1) and (2). Candidate A (timeout bump back to 30 min) covers (3).

## Validation Results (post-A+E deploy, 2026-05-10)

After A + E landed (commit `4c06d35`), Quorum was restarted at 00:38:19 UTC and observed for ~15 min. Findings diverged from the predicted Candidate E mechanism in a load-bearing way.

### What was predicted

> *Candidate E:* "undici resets `bodyTimeout` on every chunk, so any traffic prevents the 5 min kill." 15 s pings and immediate `: ready` were expected to keep the GET stream alive indefinitely; the 5-min metronomic `Session created` cadence was expected to disappear.

### What actually happened

Single moderator session `f81dff19` from log `mcp-server-20260510T003819.jsonl`, observed across 15 min after one user-driven `Ask developer which last task he implemented` invocation:

| Signal | Result |
|---|---|
| `Session created` events post-bootstrap | **Zero**. Only the 5 from 00:38:25–28 (initial CC CLI handshake burst). |
| `Session reaped` events | **Zero**. |
| Moderator session id | **Unchanged** across the entire window. |
| SDK GET reopens (`markSseOpened` re-fires on the same session) | **Two**, at exactly 00:43:29.283 and 00:48:29.279 — Δ 5:00.996 between them, lining up with `undici.bodyTimeout`. |
| `lastSeenAtAge` evolution between two reopens (00:43:50 → 00:48:20) | Climbs in clean **30 s reaper-tick increments** with **no intermediate refreshes** — 20 727 → 50 728 → 80 729 → 110 730 → 140 730 → 170 730 → 200 731 → 230 731 → 260 734 → 290 734 ms. `lastSeenAt` is touched once at GET-arrival time and never again until the next reopen. |

### What the 30 s monotonic climb tells us — confirmed

If E's 15 s `setInterval` keepalive ticks were firing successfully, `lastSeenAt` would refresh every 15 s and `lastSeenAtAge` would never exceed ~15 s. It exceeds 290 s. The keepalive **isn't running on the GET response after the immediate `: ready` write**.

The keepalive-tick diagnostic added in commit `8d4616d` confirmed this on the next restart (`logs/mcp-server-20260510T014240.jsonl`):

```
=== Keepalive-tick branch counts (first 3 min after restart) ===
  ping written:                  0
  skipped (writableEnded=true):  1
  write threw:                   0
```

The very first +15 s `setInterval` tick lands on `writableEnded=true` and the interval clears itself before ever firing a ping. So the actual sequence is:

1. GET arrives → `handleGet` calls `touchSession` synchronously (this is the **only** `lastSeenAt` refresh per GET — the climb between reopens is purely the absence of refreshes).
2. `await transport.handleRequest(req, res)` returns.
3. `startSseKeepalive` runs → immediate `: ready\n\n` write succeeds.
4. **Within the next 15 s, the SDK ends the response** (`res.writableEnded = true`). Why isn't visible from outside the SDK; the practical observation is that the GET response lifecycle is short-lived, not long-poll.
5. `setInterval` fires at +15 s, sees `writableEnded`, logs the `skipped (writableEnded=true)` branch, clears itself. Permanently.
6. ~5 min later CC CLI's SDK reissues a GET via undici's reconnect. Step 1 fires again.

Net: the entire `setInterval` keepalive block in `startSseKeepalive` is **structurally dead** for GETs from CC CLI 2.1.126 — it never refreshes anything. The QRM5-BUG-005 keepalive design assumed a long-lived SSE response that this SDK simply doesn't produce. The QRM7-012-E immediate `: ready` write is what's load-bearing — it conditions the SDK into reusing the session id on subsequent reconnects (without it, the SDK was issuing fresh `initialize` and creating new sessions every 5 min).

### Why A + E still works in practice

The user-visible bug is gone. The mechanism is just a different one than predicted:

1. **Each SDK GET reopen refreshes `lastSeenAt` once** (via the synchronous `touchSession` call in `handleGet` *before* `await transport.handleRequest`). The reopens are metronomic at exactly 5 min — the same `undici.bodyTimeout` that previously caused new sessions now triggers a same-session GET reconnect.
2. **The SDK reuses the cached `Mcp-Session-Id` on reopen** instead of issuing a fresh `initialize`. This is the load-bearing behavioral observation — the previous environment (pre-A+E) was creating new sessions every 5 min; this one isn't. Possibly the SDK only issues a fresh `initialize` when the previous GET fails *before* receiving any body bytes; our immediate `: ready` write makes the GET appear "successfully connected" so the SDK treats subsequent failures as transient and reconnects on the same session.
3. **Candidate A's 30 min `SESSION_LIVENESS_TIMEOUT_MS` is the floor that lets this work.** With each reopen refreshing `lastSeenAt` once and the next reopen ~5 min later, `lastSeenAtAge` peaks at ~5 min between reopens — well under 30 min. The original 2 min would have reaped the session inside every reopen window.

### Net judgment

A + E is a working self-heal. E's *intended* mechanism (keepalive ticks refreshing `lastSeenAt`) doesn't actually engage; the *unintended* mechanism (immediate `: ready` write conditions the SDK into reusing the session id) does the work, and A's 30-min floor backstops the gap. Candidate B (live-SSE-response signal) becomes more attractive as the principled follow-up because it expresses the right invariant ("session has a live SSE") without depending on per-tick refreshes that aren't reliably firing.

## Mechanism (corrected)

1. **Session bootstrap (cold path).** CC CLI sends `POST /mcp` with `initialize`. Server creates a session, returns the new session id. CC CLI immediately opens `GET /mcp` carrying that session id — within ~20 ms in our environment. Server's `handleGet` calls `markSseOpened()`, flipping `hasOpenedSse=true`. Role is still `undefined` at this point; `register_agent` arrives ~30 s later and sets `role=moderator`. **QRM7-011-B's exemption window is closed before the moderator is even bound.**
2. **Steady state.** SSE keepalive (30 s `setInterval`, `mcp.controller.ts:258-273`) writes `: ping\n\n` and refreshes `lastSeenAt` on every successful write. Session stays alive indefinitely under healthy SSE.
3. **SSE stream death.** Eventually the GET stream dies. Possible causes (table from QRM7-010 § Continuous-uptime trigger remains valid):
   - CC CLI internal idle teardown.
   - Docker bridge `conntrack` / NAT idle close.
   - Silent `res.write()` back-pressure failure (server thinks it's writing, client sees nothing).
   - TCP keepalive probe failure (laptop wifi roam, Docker bridge re-IP).
4. **Reap.** With no SSE keepalive refreshing `lastSeenAt`, any `>SESSION_LIVENESS_TIMEOUT_MS` (2 min) gap between POSTs causes the reaper to evict the moderator's session. `hasOpenedSse=true` means QRM7-011-B's exemption can't save it — exactly as the diagnostic shows.
5. **404.** CC CLI's POST cache still holds the dead session id. Next tool call returns 404. CC CLI does not honor MCP §2.5(4) (re-initialize on 404), surfaces `Session not found`, requires manual `/mcp`.

## What QRM7-010 and QRM7-011 Both Got Wrong (and what to take from it)

Two iterations on this ticket, two confidently-stated mechanisms, both falsified by instrumentation:

| Iteration | Mechanism claimed | Falsified by |
|---|---|---|
| QRM7-010 | "SSE socket drops during idle, hibernation wall-clock jumps, partial SDK reinit." Three trigger classes investigated, all presupposing an SSE stream that the next ticket said never existed. | QRM7-011's grep-based "0 GETs" count |
| QRM7-011 | "CC CLI is POST-only, never opens SSE." `hasOpenedSse` exemption added on this premise. | QRM7-012's per-flip `markSseOpened` log shows GETs firing within 20 ms of every session creation, on every restart. |

**Both iterations made the same class of error: inferring transport behavior from logs that don't capture the relevant signal.** The controller logs POST traffic but not GET; the GET path's only log was a single `Mapped {/mcp, GET} route` startup line. Neither author noticed the gap; both treated the absence as ground truth.

The lesson is operational, not architectural: **before reframing a transport-layer mechanism, instrument the path you're reasoning about.** A 5-line debug log on the GET handler would have prevented both misdiagnoses. The QRM7-011-B code is in the running bundle and is dead code; the QRM7-011-A timeout bump that was reverted as "no longer needed" was actually the only thing protecting moderator sessions.

The diagnostic added in commit `623faca` (`Reaper check`, `markSseOpened` flip log) makes future analysis empirical. **Suggest keeping it.** Its cost is one debug line per session per 30 s reaper tick — negligible — and its value is preventing iteration 4 of this ticket on a different wrong premise.

## Fix Candidates

### Candidate A — Restore QRM7-011-A's timeout bump

**One-line revert** of commit `447f953`'s timeout downgrade. `SESSION_LIVENESS_TIMEOUT_MS` goes back to `1_800_000` (30 min).

**Pro:** This was the only mitigation actually working. Empirically stops user-visible breakage during normal interactive use.

**Con:** Same tradeoff as before — extends `invoke_agent(target=moderator)` fail-fast against a dead moderator from 2 min → 30 min. The QRM7-001 author rejected this for that reason. Acceptable in current flows where agent→moderator escalation is rare.

**Recommend as immediate hotfix.**

### Candidate B — Replace "ever opened SSE" with "currently has live SSE"

The flag QRM7-011-B introduced expressed the wrong condition. The actual signal we want is "SSE stream is currently producing keepalive pings" — i.e., we have a writable response object whose `res.on('close')` hasn't fired.

**Mechanism:**
1. Track the active SSE response object on `McpSessionState` instead of (or alongside) `hasOpenedSse`. `markSseOpened` becomes "store this response"; `res.on('close')` becomes "clear it."
2. `isSessionAlive` exempts moderator sessions where the active SSE response is alive *or* `lastSeenAt` is within the timeout. Session reaps only when both signals are stale.
3. Same-role eviction (QRM7-009) continues to bound memory.

**Pro:** Expresses the actual condition. Idempotent against the GET-before-`register_agent` ordering. Survives SSE death without false-reaping the moderator until POSTs also stop. **Promoted in priority (2026-05-10):** D's keepalive-tick diagnostic confirmed E's 15 s ticks never fire a ping (the response is ended within 15 s of GET arrival, every time) — so the entire `setInterval` keepalive block is dead code for CC CLI 2.1.126. A live-SSE-response signal expresses the right invariant without depending on a `setInterval` that doesn't run, and would let us simplify `startSseKeepalive` significantly while we're at it.

**Con:** Couples the session state to the controller's response lifecycle. More moving parts than A.

**Recommend as principled follow-up. Daily-use bug is gone with A + E; B is cleanup + correctness, no urgency. When B lands, also remove the dead `setInterval` ping loop from `startSseKeepalive` — keep only the immediate `: ready` write, since that's what's actually load-bearing.**

### Candidate C — Anthropic-side recovery (PTY supervisor, from QRM7-010 Part 2)

Wrap `claude` in a `node-pty` supervisor that watches for canonical error strings (`Session not found`, `Server not initialized`) and types `/mcp` automatically. Original work; ~150–300 lines + per-CC-CLI-version validation.

**Pro:** Closes the loop at the layer we control. Survives any future server-side mistake of this class. Decoupled from the SSE-keepalive question.

**Con:** Screen-scraping a third-party UI; couples to CC CLI version. Significant effort relative to A or B.

**Defer until we see whether A+B is enough.**

### Candidate D — Confirm `undici.bodyTimeout` as the recycle trigger (refocused)

The Upstream Cause section identifies SDK issue [#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211) and undici's 5-minute `bodyTimeout` as the most likely cause of the metronomic recycle. Confirm by capturing the dying-GET event the next time it fires:

- Add the QRM7-010 Part 3 instrumentation (`idleMonoMs`/`idleWallMs` on reap, `reason=` on close, write-back-pressure logging on `res.write()` return value).
- Additionally, log the **time between `markSseOpened` and `res.on('close')`** for every GET — this is the per-session SSE lifetime. If it clusters tightly around 300 000 ms, the diagnosis is confirmed and the window for a future SDK upstream fix is well-characterized.
- File a comment on issue #1211 with our reproduction once captured. Worth one engineer-hour for the upstream impact.

**Recommend as parallel investigation, non-blocking on A/B/C/E.**

### Candidate E — Send an SSE comment immediately on GET open and tighten cadence

`mcp.controller.ts:startSseKeepalive` schedules its first `: ping\n\n` write at +30 s via `setInterval(fn, 30_000)`. By that time, anything on the path that enforces "first byte within N seconds" (Node's default `requestTimeout`, undici's `headersTimeout` interaction with an unflushed body, an intermediate buffering layer) has already aborted the GET. **One-line change** to write an immediate SSE comment frame inside `startSseKeepalive` before the `setInterval` runs — the response body stops being empty, the timer never has its inciting condition.

Recommended pairing: tighten `SSE_KEEPALIVE_INTERVAL_MS` from 30 000 → 15 000 so undici's chunk-counter is reset twice per minute against any future tightening of `bodyTimeout`.

**Mechanism:**

```typescript
// In startSseKeepalive(), before the existing setInterval:
try {
  res.write(': ready\n\n');
  if (server) this.mcpService.touchSession(server);
} catch {
  return; // socket already gone — bail before scheduling
}
// (existing setInterval block follows unchanged)
```

**Pro:** Cheapest principled lever. Addresses the SDK bug at the only layer we control. Doesn't change session-state semantics. Compatible with A and B.

**Con:** Doesn't help if the 5-minute kill turns out to be a CC-CLI-internal recycler unrelated to undici (in which case Candidate D's instrumentation will tell us). The fix-ahead-of-evidence risk is small because the change is one line and the worst case is "still recycling."

**Caveat to verify in deploy:** if our existing 30 s pings *were* working, undici should never have aborted the GET (each chunk resets `bodyTimeout`). The fact that the recycle still fires every 300 000 ms suggests either (a) our pings aren't reaching the client (a server-side flush issue worth Candidate D's `res.write()` return-value logging), or (b) the recycle is from a different 5-min timer than undici. Land Candidate E + tighten cadence first; if the metronome persists, Candidate D pinpoints the next layer.

**Recommend landing alongside A as the second prong of the immediate hotfix.**

## Touches

| File | Change | Candidate |
|------|--------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Bump `SESSION_LIVENESS_TIMEOUT_MS` 120 000 → 1 800 000 | A |
| `apps/mcp-server/src/mcp/mcp.service.ts` | Replace `hasOpenedSse` with active-response tracking; revise `isSessionAlive` | B |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Update GET handler to register/unregister active response on session state | B |
| `docker/moderator/entrypoint.sh` + new supervisor | PTY supervisor that types `/mcp` on canonical errors | C |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Add `idleMonoMs`/`idleWallMs`/`reason` instrumentation per QRM7-010 Part 3; log SSE lifetime (markSseOpened → res.on('close')) per session | D |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Keepalive-tick diagnostic: log per-tick branch (`ping written` / `skipped (writableEnded=true)` / `write threw`) inside `startSseKeepalive`'s `setInterval` callback. Settles whether the 30 s lastSeenAt climb between GET reopens is from `writableEnded` or silent throws. | D |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Send immediate `: ready\n\n` SSE comment in `startSseKeepalive`; tighten `SSE_KEEPALIVE_INTERVAL_MS` 30 000 → 15 000 | E |
| Spec files matching above | Unit tests, including a regression test that asserts a moderator session whose SSE was opened before `register_agent` is still exempt under B | A, B |

## Depends on

None. Independent of QRM7-008. The diagnostic logging in `623faca` is a soft prerequisite for B's correctness verification.

## Acceptance Criteria

### Candidate A (hotfix) — Code landed 2026-05-09

- [x] `SESSION_LIVENESS_TIMEOUT_MS` reset to `1_800_000` (30 min). (`apps/mcp-server/src/mcp/mcp.service.ts:38` — comment rewritten with QRM7-012 context.)
- [x] Existing unit tests reference the constant symbolically — no value updates needed. (716/716 pass.)
- [ ] After deploy, moderator survives ≥25 min between tool calls without `Session not found`. (Pending runtime verification.)

### Candidate B (principled fix)

- [ ] `McpSessionState` tracks the active SSE response object (or equivalent live-stream signal); `hasOpenedSse` removed or repurposed.
- [ ] `isSessionAlive` exempts moderator sessions with a live SSE response, regardless of `lastSeenAt`.
- [ ] On SSE `res.on('close')`, the live-stream signal clears so a moderator with a dead SSE and stale POSTs still reaps eventually.
- [ ] Regression test: moderator session whose SSE was opened **before** `register_agent` is still exempt while the SSE response is live, and reaps after `lastSeenAt` goes stale once the SSE response closes.
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass.

### Candidate C (PTY supervisor)

- (Lifted unchanged from QRM7-010 Part 2 acceptance criteria — see that ticket if C lands.)

### Candidate D (instrumentation)

- (Lifted unchanged from QRM7-010 Part 3 acceptance criteria — see that ticket if D lands.)
- [ ] Per-session SSE lifetime logged (`markSseOpened` → `res.on('close')` delta in ms) so the next reproduction confirms or rejects the 300 000 ms hypothesis.
- [x] Keepalive-tick branch logging added inside `startSseKeepalive`'s `setInterval` callback (`'ping written'` / `'skipped (writableEnded=true)'` / `'write threw'`). **Confirmed 2026-05-10** (`logs/mcp-server-20260510T014240.jsonl`): first +15 s tick after every GET hits `skipped (writableEnded=true)` and clears the interval; `ping written` count is 0. The `setInterval` block is structurally dead for CC CLI 2.1.126 — the SDK ends the response within 15 s of GET arrival. Candidate B should remove the dead block as part of the cleanup.

### Candidate E (immediate ping + tightened cadence) — Code landed 2026-05-09

- [x] `startSseKeepalive` writes a single `: ready\n\n` SSE comment immediately on entry, before scheduling the keepalive interval. Errors on the immediate write bail before scheduling (socket already gone). (`apps/mcp-server/src/mcp/mcp.controller.ts:271-280`.)
- [x] `SSE_KEEPALIVE_INTERVAL_MS` is reduced from 30 000 to 15 000. (`apps/mcp-server/src/mcp/mcp.controller.ts:18-25`.)
- [x] Updated unit tests cover the immediate-ready behavior and the new 15 s cadence. (`mcp.controller.spec.ts:258-335`.)
- [x] After deploy, the metronomic 5-min `Session created` cadence is **eliminated** — verified 2026-05-10. New sessions don't fire on the 5-min undici recycle; the SDK reuses the cached session id and reopens the GET on the same session. See Validation Results.
- [x] `npm run build`, `npm run lint`, `npm run test` all pass. (716/716.)
- [x] Caveat surfaced by validation: keepalive `setInterval` ticks aren't actually refreshing `lastSeenAt` between GET reopens — only the GET-arrival `touchSession` does. **Mechanism confirmed 2026-05-10** by Candidate D's keepalive-tick diagnostic — first +15 s tick lands on `writableEnded=true` every time, clearing the interval; `ping written` count is 0. Acceptable for daily use because A's 30 min floor backstops the 5 min reopen cadence. Candidate B removes the dead `setInterval` block as cleanup.

## Dependencies and References

### Supersedes

- [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md) — premise falsified. The shipped exemption code is dead in the running bundle; A's timeout bump (since reverted) was the only thing actually working.

### Closes-via-supersession

- [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md) — already closed by QRM7-011. The Part 2 (PTY supervisor) and Part 3 (instrumentation) drafts there remain the canonical reference for Candidates C and D.

### Related

- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — introduced the reaper. Candidate A re-applies its post-deploy timeout bump; Candidate B replaces the QRM7-011-B exemption with one that actually engages.
- [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) — agent-session exemption. Memory-bounding via same-role eviction continues to apply under B.
- [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md) — agent-side retry race. Different code path. Independent.

### External references

- [MCP Streamable HTTP spec § Session Management](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#session-management) — clauses 3 and 4. Server MAY terminate; client MUST re-initialize on 404. CC CLI does not honor §2.5(4); recovery has to come from removing the trigger or from a supervisor.
- QRM7-010's Prior Art and Claude Code GitHub issue catalog remain valid for Candidate C scoping.

### Key files

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | `SESSION_LIVENESS_TIMEOUT_MS` (A); `McpSessionState`, `markSseOpened`, `isSessionAlive` (B); `peekSessionState` diagnostic (kept) |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | GET handler, reaper diagnostic, response-lifecycle hooks (B) |
| `logs/mcp-server-20260509T191135.jsonl` | Smoking-gun log; first capture of GET-before-register and the dead exemption |
| `logs/mcp-server-20260510T003819.jsonl` | A+E validation log; captures session-id-reuse-on-reopen and the 30 s `lastSeenAt` climb that surfaces the keepalive-tick puzzle |
| `logs/mcp-server-20260510T014240.jsonl` | Keepalive-tick diagnostic confirmation log; first restart with the per-tick branch logging from `8d4616d`. `ping written: 0`, `skipped (writableEnded=true): 1` settles the puzzle |