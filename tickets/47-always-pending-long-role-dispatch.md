# #47: Always return pending on long-role `invoke_agent` dispatch — close the 0–270 s recovery gap

## Summary

The long-poll continuation protocol (#QRM7-017) only mints an `invocationId` *after* the 270 s `LONG_POLL_CEILING_MS` timer fires server-side. Between dispatch (t=0) and that ceiling, the invocation exists only as an in-memory `deliveryPromise` keyed by `correlationId` — there is no recovery handle. If the moderator's dispatch POST dies in that window (CC CLI transport recycle, network blip, container restart, user Esc), the work continues server-side but the moderator has no way to call `wait_invocation`. Recovery requires falling back to log scraping (`/app/logs/*.jsonl`).

Fix: remove the `raceAgainstCeiling` from the dispatch path. For long-role targets, `invoke_agent` always parks the invocation in `InvocationResultStore` immediately and returns `{ status: "pending", invocationId }` in a sub-second response. The moderator then calls `wait_invocation(invocationId)` to receive the actual result. The 0–270 s blind spot collapses to the dispatch round-trip itself (~10–100 ms).

## Problem Statement

### Current behavior (`mcp.service.ts:401-475`)

For `useLongPoll` calls (moderator → teamlead/architect/qa/developer), the handler races the broker's `deliveryPromise` against a 270 s server-side timer:

- **Broker wins (t < 270 s):** response returns inline on the dispatch POST. No record is ever parked. Logged as `invoke_agent returning (long-poll sync)`.
- **Timer wins (t ≥ 270 s):** `InvocationRecord` is created, parked in `InvocationResultStore`, and `{ status: "pending", invocationId }` is returned. The moderator's `wait_invocation(invocationId)` cycles continue until the broker resolves.

### Why this is wrong

The lazy mint of `invocationId` creates a 0–270 s window where the invocation has **no recovery handle.** This is documented as a known structural limitation in `docker/moderator/CLAUDE.md:114-118`:

> *Before the 270 s ceiling fires server-side, the invocation has no `invocationId` — it is only a `correlationId` and an in-memory `deliveryPromise`. There is nothing to `wait_invocation` against. If you abandon the POST mid-wait and re-dispatch, you have no way to recover the original invocation — the agent will run to completion in parallel with your retry, and you will be billed for both.*

### Observed frequency

Pre-270 s dispatch POST drops are happening **often** in recent runs (user-reported, 2026-05-27). Symptoms: agent `invoke_agent` calls "fail" from the moderator's perspective, the moderator falls back to the auxiliary log-scraping channel (`/app/logs/<role>-*.jsonl`) to monitor agent progress, and the original invocation completes server-side but lands in the void. Each lost invocation is one billable run that produced no orchestration-level result.

The 2026-05-19 QRM8 #10 incident referenced in `docker/moderator/CLAUDE.md:116` was a *false positive* of this same gap (moderator abandoned a healthy POST out of impatience), but the structural risk is real: any actual transport interruption pre-270 s is unrecoverable today.

### Why this gap exists at all

The lazy-mint design optimized for one case: **fast long-role calls** (e.g. teamlead replying with a short clarification in 20 s) return inline on the dispatch POST with zero extra round-trips. The cost is a 0–270 s recovery dead zone that bites every time the dispatch POST does not survive.

The trade-off was the right call when the protocol was introduced (#QRM7-017) but no longer fits observed failure rates.

## Design Context

### Why "always return pending" over the alternatives

Three designs were considered (see prior discussion 2026-05-27):

| Option | Mechanism | Verdict |
|---|---|---|
| (A) Eager park, keep inline fast path | Park record before `raceAgainstCeiling`. Inline-return on broker win, pending-return on ceiling win. Same envelope shape. | Closes the gap, but keeps two response paths (inline vs pending). Adds branching complexity to the moderator's expected protocol surface. |
| (B) Pre-generate `correlationId` on moderator, add `wait_by_correlation` | Moderator owns the recovery handle from t=0. Two tools (`wait_invocation`, `wait_by_correlation`) backed by two store indices. | Truly zero-loss but additive — keeps `invocationId` and adds `correlationId` as parallel recovery handles. The user explicitly rejected this on the grounds that "additive spoils it." |
| **(C) Always return pending** | Park at dispatch, return `pending` immediately on every long-role call. Remove the inline fast path. One protocol, one recovery handle (`wait_invocation`). | **Chosen.** Single clean path. The dispatch POST itself becomes ~100 ms (well below any realistic drop window). Cost is +1 round-trip and +1 moderator turn per long-role call. |

### The accepted trade-off

Option C adds:

- **+1 HTTP round-trip per long-role call.** Initial dispatch returns `pending` (~10–100 ms), then `wait_invocation(invocationId)` carries the actual delivery. Today's "fast" long-role completions (e.g. teamlead returning in 20 s) become 2-POST cycles instead of 1-POST.
- **+1 model turn for the moderator per long-role call.** The moderator receives `{status: pending}`, decides to call `wait_invocation`, and emits that tool call. On Claude Max / Pro subscription billing the dollar cost is zero, but clock latency adds ~5–10 s per long-role call and context-window consumption grows by one tool-call exchange per dispatch.

For the moderator's typical workflow (a handful of long-role dispatches per turn, each with minutes-long real work) this is negligible latency and worth the protocol simplification + universal recoverability.

Short-role calls (moderator → productowner 2 min, moderator → moderator 5 min, all agent→agent calls) are **unaffected** — they keep today's sync path because `useLongPoll` is already false for them.

### Relationship to #25 (Icebox)

Issue #25 covers a similar but distinct gap: a real transport drop **after** the ceiling fires, where the pending envelope itself is lost in transit. This ticket does not solve #25 — that envelope-loss window still exists (now compressed to the dispatch round-trip). #25 remains in icebox; if pulled, options (2) and (3) from that ticket still apply.

This ticket *does* invalidate the "voluntary-abandonment" failure mode entirely: there is no 0–270 s silence to be impatient through, because the dispatch POST returns in milliseconds.

## Implementation Details

### Server: `apps/mcp-server/src/mcp/mcp.service.ts`

**`invoke_agent` handler — useLongPoll branch (`mcp.service.ts:401-475`)**

Collapse the branch by removing `raceAgainstCeiling`. Pseudocode:

```
if (useLongPoll) {
  const invocationId = randomUUID();
  const deliveryPromise = this.messageBroker.invoke(request);

  const record: InvocationRecord = {
    invocationId, callerRole, target,
    status: 'pending', deliveryPromise,
    createdAt: Date.now(),
  };
  this.invocationResultStore.store(record);

  // Wire .then() to update record on broker resolution — unchanged from today
  deliveryPromise.then(...);

  return { status: 'pending', invocationId, next: 'call wait_invocation(invocationId)' };
}
```

Net change: **delete** the `await this.raceAgainstCeiling(...)` call, the `if (winner.type === 'result')` block (the inline fast-path return, ~15 lines), and the `invoke_agent returning (long-poll sync)` log line. The remaining code is the existing pending-return path; it just runs unconditionally now.

**`raceAgainstCeiling` helper (`mcp.service.ts:1150-1168`)**

Still used by `wait_invocation` (`mcp.service.ts:572`) — keep it.

**`wait_invocation` (`mcp.service.ts:506-608`)**

No changes. The auto-bind sidecar (`mcp.service.ts:529-535`) continues to handle session recycles. The tool's caller now exercises it on every long-role call, not just on ceiling-exceeded ones — exposure increases but behavior is identical.

### Moderator persona: `docker/moderator/CLAUDE.md`

The Long-Poll Continuation section (lines ~105–120) needs to be simplified, not just trimmed. The current text frames the protocol around "you'll wait 0–270 s in silence" — that framing is gone now.

Concrete edits:

1. **Remove** the paragraph at line 114 starting "The 0–270 s window between dispatching `invoke_agent` and receiving the first response envelope is **the protocol working as designed.**" — this whole phenomenon no longer exists.

2. **Remove** the paragraph at line 116 starting "**Why this matters:** before the 270 s ceiling fires server-side..." including the 2026-05-19 QRM8 #10 incident citation. The incident's lesson ("don't re-dispatch in silence") is now structurally impossible — the dispatch never produces silence longer than the round-trip.

3. **Rewrite** line 105's section header content to: every long-role `invoke_agent` (target ∈ {teamlead, architect, qa, developer}) returns `{ status: "pending", invocationId, next: "call wait_invocation(invocationId)" }` in the dispatch response. Always. Immediately call `wait_invocation(invocationId)` and continue cycling until status is `completed` or `failed`.

4. **Keep** the existing line 118 paragraph on pending envelope handling — it generalizes cleanly.

5. **Update** any incident citations that referenced the old behavior (search for "0–270" and "270 s" across the persona).

### Docs

**`docs/mcp-connectivity.md` §3.6**

Update the protocol description:

- Strike the "race the broker's delivery against a 270 s server-side ceiling" framing.
- Replace with: long-role dispatches always park an `InvocationRecord` and return `{ status: "pending", invocationId }` immediately. The `LONG_POLL_CEILING_MS` timer is now only consulted inside `wait_invocation`.
- Update the protocol sequence diagram (lines 366–389) — the "ceiling fires at 270 s" beat is replaced with an immediate pending return.
- Update the caller-aware gating table — the **Path** column for moderator→long-role becomes "Always long-poll" (drop the "exceeds ceiling" rationale; the gating is now categorical, not threshold-based).

**`docs/mcp-connectivity.md` §7.4**

Update the end-to-end "long-running invoke_agent" diagram. The first beat is now `Server-->>Mod: { status: "pending", invocationId }` after a sub-second dispatch, not after 270 s.

**`docs/mcp-connectivity.md` §7.3**

The "Long-running invoke_agent — keepalive in action" section's framing applies only to short-role calls and agent-to-agent calls now. Clarify or remove the moderator-targeting bits.

**`docs/agent-messaging.md`**

The "Long-poll continuation (moderator → long-running agents)" section (lines 176–197): minor edit, the "270 s ceiling fires — still working" beat is no longer the trigger for pending; pending is returned at dispatch.

**`docs/message-broker.md`**

Section ~105 ("Long-Poll Continuation"): describe the new always-pending dispatch.

### Tests: `apps/mcp-server/src/mcp/mcp.service.spec.ts`

The existing long-poll suite covers:

| Test (approximate description) | Status under this change |
|---|---|
| `LONG_POLL_CEILING_MS` race — broker wins → inline response (line ~1493) | **Delete.** Path no longer exists. |
| `LONG_POLL_CEILING_MS` race — timer wins → pending envelope (line ~1542) | **Replace.** This is now the *only* dispatch path for long-role; rewrite to assert pending is returned immediately without advancing fake timers. |
| Pending then completed via `wait_invocation` (line ~1596) | **Keep.** Adjust setup (no timer advance needed on dispatch). |
| Pending then still-pending then completed (line ~1779) | **Keep.** Adjust setup similarly. |
| Short-role sync path (productowner, etc.) | **Keep unchanged.** Not affected. |

Add a new test: "dispatch returns pending immediately with `invocationId` parked in `InvocationResultStore` before `wait_invocation` is called." Specifically assert `invocationResultStore.size === 1` immediately after the dispatch handler resolves, without advancing any fake timers.

### Scope guard

- **DO NOT** touch the short-role sync path (`useLongPoll === false`).
- **DO NOT** modify `wait_invocation` behavior.
- **DO NOT** modify `InvocationResultStore` internals — record shape and reaping are unchanged.
- **DO NOT** modify `LONG_POLL_CEILING_MS` value (270 s) — still governs each `wait_invocation` window.
- **DO NOT** add new MCP tools or new request/response fields.

## Acceptance Criteria

- [ ] `mcp.service.ts` `invoke_agent` useLongPoll branch removes the `raceAgainstCeiling` call and the inline fast-path return; always parks the record and returns `{ status: "pending", invocationId, next }`.
- [ ] `InvocationResultStore.size === 1` immediately after a moderator → long-role `invoke_agent` dispatch resolves, with no fake-timer advancement.
- [ ] The `invoke_agent returning (long-poll sync)` log line is removed; the `invoke_agent returning pending: ...` log line continues to fire on every long-role dispatch.
- [ ] Short-role calls (moderator → productowner, moderator → moderator, all agent-to-agent) continue to return their `InvokeResponse` inline — no behavior change.
- [ ] `wait_invocation` continues to behave as today: returns stored result if completed/failed, races `deliveryPromise` vs fresh 270 s timer if still pending, applies auto-bind sidecar.
- [ ] `docker/moderator/CLAUDE.md` Long-Poll Continuation section is rewritten: no "0–270 s silence" guidance, no "do not retry" lecture, no QRM8 #10 incident citation. New guidance: "every long-role `invoke_agent` returns pending; call `wait_invocation` immediately."
- [ ] `docs/mcp-connectivity.md` §3.6, §7.3, §7.4 updated to reflect always-pending dispatch.
- [ ] `docs/agent-messaging.md` and `docs/message-broker.md` long-poll sections updated.
- [ ] Existing test cases in `mcp.service.spec.ts` updated: the broker-wins-inline case is removed; remaining cases assert immediate pending return without timer advancement on dispatch.
- [ ] New test: dispatch immediately parks an `InvocationRecord` in `InvocationResultStore` before any `wait_invocation` call.
- [ ] `npm run build`, `npm run lint`, `npm run test` all pass.
- [ ] Smoke verification: a moderator → developer call shows in `mcp-server-*.jsonl` as `Stored invocation: id=... status=pending` at dispatch time (not 270 s later), and the moderator's transcript shows a `wait_invocation` call following the dispatch in the same turn.

## Dependencies and References

**Built atop:**
- #QRM7-017 (`tickets/QRM7-017-long-poll-continuation-implementation.md`) — introduced `InvocationResultStore`, `LONG_POLL_CEILING_MS`, `wait_invocation`, and the lazy-mint protocol this ticket reshapes.

**Related (not blocked by, does not block):**
- #25 (Icebox: recover orphaned invocation after real transport drop post-270s) — different gap (envelope-loss after ceiling). This ticket compresses but does not eliminate that gap. Independent.

**References:**
- `apps/mcp-server/src/mcp/mcp.service.ts:401-475` — useLongPoll branch (primary edit target)
- `apps/mcp-server/src/mcp/mcp.service.ts:506-608` — `wait_invocation` handler (unchanged)
- `apps/mcp-server/src/mcp/mcp.service.ts:1150-1168` — `raceAgainstCeiling` helper (kept, still used by `wait_invocation`)
- `apps/mcp-server/src/messaging/invocation-result-store.ts` — record shape, TTL semantics (unchanged)
- `apps/mcp-server/src/mcp/mcp.service.spec.ts:1493+` — existing long-poll test cases (rewrite targets)
- `docker/moderator/CLAUDE.md:105-120` — Long-Poll Continuation section (rewrite target)
- `docs/mcp-connectivity.md` §3.6, §7.3, §7.4 — protocol description (update target)
- `docs/agent-messaging.md` (long-poll continuation section) — update target
- `docs/message-broker.md` (long-poll continuation section) — update target

## Architect Review

**Not requested.** This is a localized protocol simplification within the well-defined long-poll continuation surface from #QRM7-017. It removes one branch (inline fast path), preserves the existing `wait_invocation` semantics verbatim, and accepts an explicit latency trade-off the user has already weighed. No new abstractions, no cross-module contract changes, no new tools or fields. The trade-off discussion (Options A/B/C) is captured in Design Context above.