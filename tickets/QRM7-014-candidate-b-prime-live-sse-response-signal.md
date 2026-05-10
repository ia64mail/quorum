# QRM7-014: Candidate B′ — Replace Dead `hasOpenedSse` With Live SSE Response Signal

**Status:** Open

## Summary

Implement Candidate B′ (architect-approved, GO with refinements) from [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md). This replaces the dead `hasOpenedSse` sticky boolean — which never engages for moderator sessions due to GET-before-`register_agent` ordering — with `activeSseResponse?: Response` tracking on `McpSessionState`. Candidates A + E remain as the operational floor; B′ is correctness cleanup that expresses the right invariant ("does this session currently have a live SSE channel?") and removes confirmed-dead code.

## Problem Statement

- `hasOpenedSse` (QRM7-011-B) is dead code for every moderator session: CC CLI 2.1.126 opens the GET SSE stream ~20 ms after session creation — before `register_agent` binds the moderator role — so the sticky boolean is already `true` when the exemption check runs. The exemption branch in `isSessionAlive` never fires.
- The `setInterval` keepalive block in `startSseKeepalive` is structurally dead: the SDK ends the GET response within ~15 s of arrival, so the first +15 s interval tick lands on `writableEnded=true`, clears itself, and never writes a ping. Confirmed by three independent observations (validation log, keepalive-tick diagnostic, mechanism analysis — see QRM7-012 § Validation Results).
- Dead code imposes cognitive cost on every reader and breeds false confidence. Three iterations of the moderator-reap bug (QRM7-010 → 011 → 012) were partly caused by assumptions that the keepalive was functional.
- No urgency — A + E fixed the daily-use bug. This is correctness + cleanup, low priority.

## Design Context

Full architect design review with B′ refinements: [docs/QRM7-012-candidate-b-design-review.md](../docs/QRM7-012-candidate-b-design-review.md). That document supersedes QRM7-012's original Candidate B writeup wherever they conflict.

The five B′ refinements below were approved as a unit. The `isSessionAlive` chain becomes:

```
1. No state → false                                           (unchanged)
2. Agent role (non-moderator) → true                          (QRM7-009, unchanged)
3. Moderator with activeSseResponse → true                    (NEW — replaces dead hasOpenedSse)
4. Moderator without activeSseResponse → lastSeenAt check     (30 min timeout, unchanged)
5. Anonymous → lastSeenAt check                               (unchanged)
```

Dead-moderator fail-fast preserved: TCP teardown fires `res.on('close')` → clears `activeSseResponse` → 30 min timeout → reaper evicts. Same-role eviction (QRM7-009) unchanged.

## Implementation Details

### Refinement 1 — Identity-guarded close handler

Add `clearSseResponseIfMatch(server, res)` to `McpService`. The `=== res` identity check ensures a stale close handler from GET₁ never clears a newer response stored by GET₂. In the controller's GET handler, wire `res.on('close', () => clearSseResponseIfMatch(server, res))`.

### Refinement 2 — SSE exemption scoped to moderator only

The `activeSseResponse` exemption in `isSessionAlive` must check `state.role === AgentRole.moderator`. Anonymous sessions (pre-`register_agent`) with an active GET must NOT be immortalized — they fall through to the `lastSeenAt` check. This prevents the pre-`register_agent` window from creating immortal anonymous sessions.

### Refinement 3 — Remove dead `setInterval` block

Remove the entire `setInterval` block from `startSseKeepalive` (lines 291–316 in `mcp.controller.ts`). Keep only: TCP keepalive setup, immediate `: ready\n\n` write, bail-on-failure. The resulting function is ~10 lines.

### Refinement 4 — Rename `startSseKeepalive` → `initSseResponse`

Reflects the actual behavior: one-shot initialization, not periodic keepalive. Update all call sites (two: POST handler at line ~147, GET handler at line ~231) and the corresponding spec file.

### Refinement 5 — Replace `hasOpenedSse` with `activeSseResponse`

On `McpSessionState`: remove `hasOpenedSse: boolean`, add `activeSseResponse?: Response`. Remove `markSseOpened()` method and replace with `markSseResponseActive(server, res)`. Remove the `hasOpenedSse` initialization in `connect()`. Update all references: `isSessionAlive`, `peekSessionState` diagnostic logging, the reaper log format in `mcp.controller.ts`, and any spec assertions that reference `hasOpenedSse`.

## Touches

| File | Change | Refinement |
|------|--------|------------|
| `apps/mcp-server/src/mcp/mcp.service.ts` | Remove `hasOpenedSse` from `McpSessionState`; add `activeSseResponse?: Response`. Remove `markSseOpened()`; add `markSseResponseActive(server, res)` and `clearSseResponseIfMatch(server, res)`. Update `isSessionAlive` to check `role === moderator && activeSseResponse` instead of `role === moderator && !hasOpenedSse`. Update `connect()` initialization (remove `hasOpenedSse: false`). Update `peekSessionState` / diagnostic logging. | 1, 2, 5 |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | In `handleGet`: replace `markSseOpened()` call with `markSseResponseActive(server, res)`; add `res.on('close', () => clearSseResponseIfMatch(server, res))`. Rename `startSseKeepalive` → `initSseResponse`; remove `setInterval` block (lines 291–316), keep TCP keepalive + immediate `: ready` write + bail-on-failure. Update reaper diagnostic log to reflect `activeSseResponse` instead of `hasOpenedSse`. Update both call sites of the renamed function. | 1, 3, 4, 5 |
| `apps/mcp-server/src/mcp/mcp.controller.spec.ts` | Update/replace existing `startSseKeepalive` tests for the renamed `initSseResponse`. Remove tests for interval-based keepalive behavior. Add 7 new tests (see Test Plan below). Update any `hasOpenedSse` assertions to use `activeSseResponse`. | All |
| `apps/mcp-server/src/mcp/mcp.service.spec.ts` | Update `McpSessionState` fixtures — remove `hasOpenedSse`, add `activeSseResponse` where needed. Update `isSessionAlive` test cases for the new exemption semantics. Update `markSseOpened` → `markSseResponseActive` tests. Add `clearSseResponseIfMatch` identity-guard tests. | 1, 2, 5 |

## Acceptance Criteria

- [ ] `McpSessionState.hasOpenedSse` removed; replaced by `activeSseResponse?: Response`.
- [ ] `markSseOpened()` removed; replaced by `markSseResponseActive(server, res)` that stores the response reference.
- [ ] `clearSseResponseIfMatch(server, res)` added — only clears when `state.activeSseResponse === res` (identity guard).
- [ ] `isSessionAlive` exempts moderator sessions with a live `activeSseResponse`, regardless of `lastSeenAt`. Anonymous sessions with active SSE are NOT exempt — they fall through to `lastSeenAt` check.
- [ ] On SSE `res.on('close')`, the close handler calls `clearSseResponseIfMatch` so a moderator with dead SSE and stale POSTs still reaps eventually.
- [ ] Dead `setInterval` block removed from `startSseKeepalive`.
- [ ] `startSseKeepalive` renamed to `initSseResponse` — all call sites updated.
- [ ] `initSseResponse` retains: TCP keepalive setup, immediate `: ready\n\n` write, `touchSession` on success, bail-on-failure. No interval scheduled.
- [ ] All 7 tests pass (see Test Plan).
- [ ] `npm run build` compiles successfully.
- [ ] `npm run lint` — 0 errors, 0 warnings.
- [ ] `npm run test` — all tests passing (existing + new).

### Test Plan (7 required tests)

1. **SSE-opened-before-`register_agent` moderator exemption.** Create session → `markSseResponseActive(res₁)` → `register_agent(moderator)` → verify `isSessionAlive = true`. Then fire `res₁.on('close')` (clears `activeSseResponse`) → verify session still alive (within `lastSeenAt` timeout). Then advance clock past 30 min → verify `isSessionAlive = false` → reaper evicts.

2. **GET reopen identity guard.** `markSseResponseActive(res₁)` → `markSseResponseActive(res₂)` → fire `res₁.on('close')` → verify `activeSseResponse` is still `res₂` (not cleared). Fire `res₂.on('close')` → verify `activeSseResponse` cleared to `undefined`.

3. **Active SSE overrides stale `lastSeenAt`.** Set `lastSeenAt` to 31 minutes ago. Set `activeSseResponse` to a live `res`. Register as moderator. Verify `isSessionAlive = true`. Clear `activeSseResponse` → verify `isSessionAlive = false`.

4. **Dead-moderator end-to-end.** Moderator session with active SSE → SSE closes → advance clock 30 min past last POST → reaper evicts → verify `disconnect` called and session removed from maps.

5. **Same-role eviction with active SSE.** Moderator with `activeSseResponse = res₁` → new `register_agent(moderator)` on a different session → verify prior session evicted and its `activeSseResponse` reference released (no leak).

6. **`initSseResponse` post-cleanup.** Verify: immediate `: ready` write happens, `touchSession` called once on success, no interval scheduled, TCP keepalive set. Verify: if immediate write throws, no further calls (bail early).

7. **Anonymous session not immortalized by SSE.** Session opens GET (has `activeSseResponse`) but never calls `register_agent`. Verify `isSessionAlive` subjects it to `lastSeenAt` timeout — not exempted by the SSE signal.

## Out of Scope

- **Candidate C (PTY supervisor)** — separate decision; deferred until A+B′ effectiveness is confirmed.
- **Candidate D Part 3 instrumentation** beyond what's already landed (keepalive-tick diagnostic in `8d4616d`, reaper diagnostic in `623faca`). Note: the QRM7-012 temporary diagnostics (`markSseOpened` debug log, reaper `hasOpenedSse` log, keepalive-tick branch logging) should be updated to reflect the new field names but are not otherwise expanded.
- **Any change to `SESSION_LIVENESS_TIMEOUT_MS`** — Candidate A's 30 min stays. This ticket does not touch the timeout value.

## Dependencies and References

### Design parent
- [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) — parent ticket. Candidates A + E landed and validated 2026-05-10. This ticket implements Candidate B′ as the principled follow-up.

### Architect review
- [docs/QRM7-012-candidate-b-design-review.md](../docs/QRM7-012-candidate-b-design-review.md) — B′ refinements, test strategy, concurrency analysis. **Supersedes** QRM7-012's original Candidate B writeup.

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
5. Check reaper diagnostic logs (from `623faca`): confirm `activeSseResponse` is set/cleared on each GET reopen cycle, and `isSessionAlive` returns `true` throughout.
6. Check that no `setInterval` keepalive-tick diagnostics appear (the dead code is removed).
7. Confirm session count doesn't grow — same-role eviction (QRM7-009) continues to bound memory.
