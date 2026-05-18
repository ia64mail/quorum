# QRM7-014: Candidate B′ — Replace Dead `hasOpenedSse` With Live SSE Response Signal

**Status:** Done (2026-05-10) — verified in fresh runtime; all AC met.

## Summary

Implement Candidate B′ (architect-approved, GO with refinements) from [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md). This replaces the dead `hasOpenedSse` sticky boolean — which never engages for moderator sessions due to GET-before-`register_agent` ordering — with `activeSseToken: object | null` tracking on `McpSessionState`. Candidates A + E remain as the operational floor; B′ is correctness cleanup that expresses the right invariant ("does this session currently have a live SSE channel?") and removes confirmed-dead code.

## Errata

**2026-05-10 erratum:** Post-implementation operator finding showed POST-path keepalive ticks ARE firing successfully every 15 s on long-running `invoke_agent` SSE responses (e.g., the broker logged `keepaliveFired=true writableFinished=true` on the 131 s teamlead-invocation response that delivered this very ticket's first draft). The "dead `setInterval`" claim from QRM7-012 § Validation Results was scoped only to the GET path — the SDK ends the GET response within ~15 s so the first tick always lands on `writableEnded=true`, but POST-path SSE responses live for the full duration of the tool call and receive ticks continuously. Refinements 3 and 4 revised accordingly; refinements 1, 2, 5 unaffected.

## Verification (2026-05-10)

Verified in fresh runtime (mcp-server log `mcp-server-20260510T170304.jsonl`). All Verification Plan steps exercised; all acceptance criteria met.

### Smoke (new code is live)

- `markSseAlive` symbol present: 15+ occurrences in fresh log
- `activeSseToken` symbol present: 391+ occurrences (reaper diagnostic format)
- Stale symbols (`markSseOpened`, `markSseResponseActive`, `hasOpenedSse`, `activeSseResponse`): **0** — confirmed not running pre-B′ code

### Identity-guard correctness (Refinement 1)

Active moderator session `6f341ddc-…` observed across 14 minutes:

- 28/28 reaper checks recorded `activeSseToken=true` continuously
- No `markSseDead` debug entries, no spurious token clears
- The `===` identity guard correctly rejected stale `res.on('close')` handlers from prior `GET₁` while `GET₂`'s newer token was current

A subsequent moderator session `fffddecb-…` continued to show `activeSseToken=true` continuously after the role flipped to moderator — B′'s exemption visibly active in the reaper diagnostic output.

### Idle survival (≥30 min)

- Session `6f341ddc-…` registered as moderator at 17:46:16; last refresh at 17:58:18 (lastSeenAt updated by an SSE GET reopen)
- Idle 38 minutes through 18:24:23 with no `Session reaped` event for that SID
- 98/98 reaper checks reported `alive=true` over the full lifetime
- The 30-min floor (Candidate A) carried liveness through the long quiet period; B′ supplemented during active windows

### Same-role eviction (QRM7-009)

Two evictions logged cleanly across the run, both via `register_agent` rotation, neither via the reaper:

```
17:46:16  Evicted prior moderator session (idle 1682s) on re-register
18:24:23  Evicted prior moderator session (idle 1565s) on re-register
```

Memory bound preserved; no orphan moderator sessions.

### Round-trip behavior

Two `invoke_agent` round-trips after idle, both successful:

| Time | Target | Result | POST close |
|------|--------|--------|-----------|
| 17:46:21 | developer | success in 3.21 s | `keepaliveFired=true` |
| 18:24:25 | teamlead | success in 1.97 s | (short call) |

`keepaliveFired=true` on the 3.2 s response confirms POST-path SSE keepalive (the QRM7-012 long-form regression backstop) is intact alongside B′.

### Operator finding — out of scope

CC CLI's transport recycler creates fresh anonymous sessions during long idle (observed: `48f0b519-…` at 17:58:18, `fffddecb-…` at 18:13:20). When the user resumed activity at 18:24, CC CLI sent the new POST on `fffddecb-…` rather than the still-alive `6f341ddc-…`. The first `invoke_agent` on the unregistered `fffddecb-…` failed; CC CLI auto-re-registered as moderator and retried successfully (observed as the moderator's "Server lost my identity again" message). The same-role eviction path absorbed this gracefully — the user-visible behavior was a transparent retry. Not a B′ regression and no user-facing impact, so no follow-up ticket filed.

## Design Notes

Consolidated from two architect reviews (2026-05-10). Both source docs removed from `docs/` — design context lives in the ticket per project convention.

### Layering principle: opaque identity token, not `Response`

`McpService` is protocol-level — it owns session state, liveness checks, and the MCP tool registry. It has no Express/HTTP knowledge and must not import `Response` from `'express'`. Storing a `Response` object on `McpSessionState` would leak HTTP concerns across the architecture boundary.

Instead, `markSseAlive(server)` creates a plain `{}` object as an opaque identity token (reference equality via `===`). The controller captures the token on GET open and passes it to `markSseDead(server, token)` in the `res.on('close')` handler. The service never sees or knows about `Response` — it only compares tokens.

### POST/GET dual-path: keep `setInterval` in `startSseKeepalive`

`startSseKeepalive` is called from **two** paths:

1. **GET handler** — the SDK ends the GET response within ~15 s of arrival. The first `setInterval` tick lands on `writableEnded=true` and self-clears. Dead on GET; costs one no-op tick.
2. **POST handler** via `maybeStartKeepalive` (QRM6-BUG-011) — long-running `invoke_agent` SSE responses live for the full duration of the tool call (e.g., 131 s for the teamlead invocation that drafted this ticket). The interval fires continuously, refreshing `lastSeenAt` and resetting undici's 5-min `bodyTimeout`.

The `writableEnded` self-clear discriminates automatically. Removing the interval would silently break POST-path keepalive.

### Concurrency: GET-reopen race

CC CLI reopens GET every ~5 min on the same session ID. If a new GET arrives before the prior response's `close` fires:

| Time | Event | `activeSseToken` |
|------|-------|-------------------|
| T+0 | GET₁ arrives | `token₁` |
| T+5:00 | GET₂ arrives | `token₂` (overwrite) |
| T+5:01 | GET₁ `close` fires | **No change** — `token₂ !== token₁`, identity check fails |
| T+5:15 | GET₂ `close` fires | `null` — `token₂` matches, cleared |

The stale `close` handler is a no-op because its captured token no longer matches `activeSseToken`. Same pattern as timer-handle invalidation in event-driven systems.

`res.on('close')` is the correct cleanup signal — it fires when the underlying connection is destroyed (even on abnormal teardown). `writableEnded` only means the server called `.end()` and the connection may still be draining.

### Compatibility

No regression against existing safeguards:

- **QRM7-009 same-role eviction** — unaffected. `register_agent` evicts prior sessions regardless of SSE state.
- **QRM7-001 reaper** — preserved. Moderator reaps when `activeSseToken` is null AND `lastSeenAt` exceeds 30 min.
- **QRM7-001 fail-fast** — preserved. `McpElicitationConnection.isConnected()` delegates to `isSessionAlive`, which returns true while a moderator has a live SSE token.
- **QRM6-BUG-011 POST-SSE keepalive** — preserved. `setInterval` in `startSseKeepalive` unchanged.

### What was NOT chosen and why

Two approaches were rejected during design iteration:

1. **`activeSseResponse?: Response` on `McpSessionState`** (implemented in first pass, then corrected). Violated the layering principle — `McpService` gained `import type { Response } from 'express'`, coupling protocol-level session state to the HTTP transport. The opaque token achieves the same identity-guard semantics without the type leak.
2. **Remove `setInterval` block entirely** (recommended in the second architect review's §2, retracted in the §2 Erratum). The "dead code" finding was scoped only to GET-path observations; POST-path keepalive ticks were firing successfully the entire time. Removing the interval regressed every long-running `invoke_agent` call.

## Problem Statement

- `hasOpenedSse` (QRM7-011-B) is dead code for every moderator session: CC CLI 2.1.126 opens the GET SSE stream ~20 ms after session creation — before `register_agent` binds the moderator role — so the sticky boolean is already `true` when the exemption check runs. The exemption branch in `isSessionAlive` never fires.
- The `setInterval` keepalive block in `startSseKeepalive` is structurally dead **on the GET path**: the SDK ends the GET response within ~15 s of arrival, so the first +15 s interval tick lands on `writableEnded=true`, clears itself, and never writes a ping. Confirmed by three independent observations (validation log, keepalive-tick diagnostic, mechanism analysis — see QRM7-012 § Validation Results). However, the interval is **load-bearing on the POST path** for long-running SSE-streamed `invoke_agent` responses — it refreshes `lastSeenAt` and resets undici's `bodyTimeout` every 15 s. The `writableEnded` self-clear in the interval automatically discriminates between the two paths.
- Dead code imposes cognitive cost on every reader and breeds false confidence. Three iterations of the moderator-reap bug (QRM7-010 → 011 → 012) were partly caused by assumptions that the keepalive was functional.
- No urgency — A + E fixed the daily-use bug. This is correctness + cleanup, low priority.

## Design Context

Architect design reviews consolidated into §Design Notes above (source docs removed from `docs/` per project convention).

The five B′ refinements below were approved as a unit. The `isSessionAlive` chain becomes:

```
1. No state → false                                           (unchanged)
2. Agent role (non-moderator) → true                          (QRM7-009, unchanged)
3. Moderator with activeSseToken → true                       (NEW — replaces dead hasOpenedSse)
4. Moderator without activeSseToken → lastSeenAt check        (30 min timeout, unchanged)
5. Anonymous → lastSeenAt check                               (unchanged)
```

Dead-moderator fail-fast preserved: TCP teardown fires `res.on('close')` → clears `activeSseToken` → 30 min timeout → reaper evicts. Same-role eviction (QRM7-009) unchanged.

## Implementation Details

### Refinement 1 — Identity-guarded close handler

Add `markSseDead(server, token)` to `McpService`. The `=== token` identity check ensures a stale close handler from GET₁ never clears a newer token stored by GET₂. In the controller's GET handler, capture the token from `markSseAlive` and wire `res.on('close', () => markSseDead(server, token))`.

### Refinement 2 — SSE exemption scoped to moderator only

The `activeSseToken` exemption in `isSessionAlive` must check `state.role === AgentRole.moderator`. Anonymous sessions (pre-`register_agent`) with an active GET must NOT be immortalized — they fall through to the `lastSeenAt` check. This prevents the pre-`register_agent` window from creating immortal anonymous sessions.

### Refinement 3 — Retain `setInterval` block; remove only QRM7-012 temporary diagnostic log lines

The `setInterval` keepalive block in `startSseKeepalive` is load-bearing on the POST path (long-running SSE-streamed `invoke_agent` responses) — ticks fire continuously, refreshing `lastSeenAt` and resetting undici's `bodyTimeout`. The `writableEnded` self-clear automatically handles the GET path (first tick sees `writableEnded=true`, clears the interval). Retain the full interval block with its three cleanup paths (`writableEnded` self-clear, write-failure clear, `res.on('close')` clear). Remove only the QRM7-012 temporary per-tick diagnostic log lines (from `8d4616d` / `005136e`). Keep: TCP keepalive setup, immediate `: ready\n\n` write, bail-on-failure, and the 15 s `setInterval` heartbeat. Restore `SSE_KEEPALIVE_INTERVAL_MS = 15_000` constant.

### Refinement 4 — Keep `startSseKeepalive` name (rename reverted)

The original name `startSseKeepalive` correctly describes the dual-path behavior: TCP keepalive setup, immediate `: ready` write, and a periodic `setInterval` heartbeat that fires continuously on long-lived POST responses and self-clears on short-lived GET responses. No rename needed. The JSDoc must document the dual-path behavior explicitly (long-lived POST → ticks fire every 15 s; short-lived GET → first tick self-clears via `writableEnded`).

### Refinement 5 — Replace `hasOpenedSse` with `activeSseToken`

On `McpSessionState`: remove `hasOpenedSse: boolean`, add `activeSseToken: object | null`. New API on `McpService`: `markSseAlive(server): object` returns an opaque identity token (a plain `{}` — unique by reference); `markSseDead(server, token): void` clears `activeSseToken` only when the passed token matches the stored one (`===` identity check). The controller captures the token in `handleGet` and passes it to the `res.on('close')` handler. `McpService` MUST NOT import Express's `Response` type — the layering principle is load-bearing (see §Design Notes). Remove the `hasOpenedSse` initialization in `connect()` (initialize `activeSseToken: null`). Update all references: `isSessionAlive`, `peekSessionState` diagnostic logging, the reaper log format in `mcp.controller.ts`, and any spec assertions that reference `hasOpenedSse`.

## Touches

| File | Change | Refinement |
|------|--------|------------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Remove `hasOpenedSse` from `McpSessionState`; add `activeSseToken: object \| null`. Remove `markSseOpened()`; add `markSseAlive(server): object` and `markSseDead(server, token): void`. Remove `import type { Response } from 'express'`. Update `isSessionAlive` to check `role === moderator && activeSseToken !== null` instead of `role === moderator && !hasOpenedSse`. Update `connect()` initialization (`activeSseToken: null`). Update `peekSessionState` / diagnostic logging. | 1, 2, 5 |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | In `handleGet`: replace `markSseOpened()` with `const token = markSseAlive(server)`; add `res.on('close', () => markSseDead(server, token))`. Retain `startSseKeepalive` name and keepalive interval; remove only QRM7-012 temporary diagnostic log lines from the `setInterval` callback. Keep TCP keepalive + immediate `: ready` write + bail-on-failure + 15 s interval with `writableEnded` self-clear. Update reaper diagnostic log to reflect `activeSseToken` instead of `hasOpenedSse`. | 1, 3, 4, 5 |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | Update existing `startSseKeepalive` tests for the revised keepalive behavior (retain interval tests, remove diagnostic-specific assertions). Add 10 new tests (see Test Plan below). Update any `hasOpenedSse` assertions to use `activeSseToken`. | All |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | Update `McpSessionState` fixtures — remove `hasOpenedSse`, add `activeSseToken` where needed. Update `isSessionAlive` test cases for the new exemption semantics. Update `markSseOpened` → `markSseAlive`/`markSseDead` tests. Add identity-guard tests for `markSseDead`. | 1, 2, 5 |

## Acceptance Criteria

- [ ] `McpSessionState.hasOpenedSse` removed; replaced by `activeSseToken: object | null`.
- [ ] `markSseOpened()` removed; replaced by `markSseAlive(server): object` that returns an opaque identity token.
- [ ] `markSseDead(server, token)` added — only clears `activeSseToken` when the passed token matches (`=== identity guard`).
- [ ] `apps/mcp-server/src/mcp/mcp.service.ts` does not import `Response` from `'express'`.
- [ ] `isSessionAlive` exempts moderator sessions with a non-null `activeSseToken`, regardless of `lastSeenAt`. Anonymous sessions with active SSE are NOT exempt — they fall through to `lastSeenAt` check.
- [ ] On SSE `res.on('close')`, the close handler calls `markSseDead` with the captured token so a moderator with dead SSE and stale POSTs still reaps eventually.
- [ ] `startSseKeepalive` retains TCP keepalive setup, immediate `: ready\n\n` write, `touchSession` on success, bail-on-failure, AND the 15 s `setInterval` heartbeat with `writableEnded` self-clear. QRM7-012 temporary diagnostic log lines removed.
- [ ] All 10 tests pass (see Test Plan).
- [ ] `npm run build` compiles successfully.
- [ ] `npm run lint` — 0 errors, 0 warnings.
- [ ] `npm run test` — all tests passing (existing + new).

### Test Plan (10 required tests)

1. **SSE-opened-before-`register_agent` moderator exemption.** Create session → `markSseResponseActive(res₁)` → `register_agent(moderator)` → verify `isSessionAlive = true`. Then fire `res₁.on('close')` (clears `activeSseResponse`) → verify session still alive (within `lastSeenAt` timeout). Then advance clock past 30 min → verify `isSessionAlive = false` → reaper evicts.

2. **GET reopen identity guard.** `markSseResponseActive(res₁)` → `markSseResponseActive(res₂)` → fire `res₁.on('close')` → verify `activeSseResponse` is still `res₂` (not cleared). Fire `res₂.on('close')` → verify `activeSseResponse` cleared to `undefined`.

3. **Active SSE overrides stale `lastSeenAt`.** Set `lastSeenAt` to 31 minutes ago. Set `activeSseResponse` to a live `res`. Register as moderator. Verify `isSessionAlive = true`. Clear `activeSseResponse` → verify `isSessionAlive = false`.

4. **Dead-moderator end-to-end.** Moderator session with active SSE → SSE closes → advance clock 30 min past last POST → reaper evicts → verify `disconnect` called and session removed from maps.

5. **Same-role eviction with active SSE.** Moderator with `activeSseResponse = res₁` → new `register_agent(moderator)` on a different session → verify prior session evicted and its `activeSseResponse` reference released (no leak).

6a. **`startSseKeepalive` on long-lived response (POST path).** Verify: immediate `: ready` write happens; advance 15 s → `: ping` written + `touchSession` called; advance another 15 s → second `: ping` + second `touchSession`; verify TCP keepalive set on socket.

6b. **`startSseKeepalive` self-clears on short-lived response (GET path).** Set `res.writableEnded = true` before the first tick; advance 15 s → no `: ping` written, interval cleared; advance further → no additional writes.

6c. **`startSseKeepalive` clears on write failure.** Advance 15 s → first tick's `res.write(': ping')` throws → interval cleared; advance further → no additional writes.

6d. **`startSseKeepalive` bails early if immediate write throws.** `res.write(': ready')` throws → no interval scheduled, `touchSession` not called for the immediate path.

7. **Anonymous session not immortalized by SSE.** Session opens GET (has `activeSseResponse`) but never calls `register_agent`. Verify `isSessionAlive` subjects it to `lastSeenAt` timeout — not exempted by the SSE signal.

## Out of Scope

- **Candidate C (PTY supervisor)** — separate decision; deferred until A+B′ effectiveness is confirmed.
- **Candidate D Part 3 instrumentation** beyond what's already landed (reaper diagnostic in `623faca`). Note: the QRM7-012 temporary per-tick diagnostic log lines (from `8d4616d` / `005136e`) are removed as part of Refinement 3; the `markSseOpened` debug log is replaced by `markSseAlive` (Refinement 5); the reaper `hasOpenedSse` log is updated to `activeSseToken` (Refinement 5).
- **Any change to `SESSION_LIVENESS_TIMEOUT_MS`** — Candidate A's 30 min stays. This ticket does not touch the timeout value.

## Dependencies and References

### Design parent
- [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) — parent ticket. Candidates A + E landed and validated 2026-05-10. This ticket implements Candidate B′ as the principled follow-up.

### Architect review
- Consolidated into §Design Notes above. Source docs (`docs/qrm7-012-candidate-b-design.md`, `docs/QRM7-012-candidate-b-design-review.md`) removed from `docs/` per project convention (design context lives in tickets, not system documentation).

### Context store
- Project-scope key `QRM7-012-design-notes` — architect's design notes summary.

### Related tickets
- [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md) — same-role eviction (unchanged by B′).
- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — introduced the reaper. B′ replaces the dead QRM7-011-B exemption.
- [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md) — superseded by QRM7-012. B′ removes the dead code QRM7-011-B introduced.

### Key commits
- `623faca` — reaper diagnostic logging (per-tick snapshot + `markSseOpened` flip log).
- `8d4616d` — keepalive-tick branch diagnostic (confirmed `setInterval` dead).
- `005136e` — keepalive-tick diagnostic verification.
- `4c06d35` — Candidates A + E landed.

## Verification Plan

After deploy, verify with a moderator session surviving ≥30 min with intermittent SSE reopens:

1. Start Quorum (`./scripts/start.sh`). Attach to moderator (`./scripts/moderator.sh`).
2. Issue a tool call to establish the moderator session.
3. Wait ≥30 min with no manual interaction — let the SDK's 5-min SSE reopen cycle run at least 6 times.
4. Issue another tool call — must succeed without `Session not found`.
5. Check reaper diagnostic logs (from `623faca`): confirm `activeSseToken` is set/cleared on each GET reopen cycle, and `isSessionAlive` returns `true` throughout.
6. Verify keepalive pings fire on long-running POST-path SSE responses (e.g., an `invoke_agent` call lasting >15 s should show `keepaliveFired=true` in POST close diagnostics). Verify no QRM7-012 temporary per-tick diagnostic log lines appear (those are removed).
7. Confirm session count doesn't grow — same-role eviction (QRM7-009) continues to bound memory.
