# #72: Increase teamlead invocation timeout 10 → 15 min for `/code-review`

## Summary

Raise the teamlead `ROLE_TIMEOUTS` entry from 10 to 15 minutes. The 10-minute broker ceiling is too tight for the heavyweight `/code-review` skill: in the #65 session the teamlead review hit the timeout, and even the *successful* retry consumed 7m44s of the 10-minute budget — barely two minutes of headroom on a clean run.

## Problem Statement

`ROLE_TIMEOUTS[teamlead]` was set to 10 minutes when ticket creation was the role's defining task. Since then `/code-review` — a 16-sub-agent pipeline (parallel CLAUDE.md auditors, bug detector, git-blame analyzer, confidence scoring) — became the role's long pole, and it does not reliably fit:

- **#65 session:** the first `/code-review` dispatch was declared failed at the ~10-minute broker ceiling; the re-dispatched review completed in **7m44s**. A clean review already sits within ~2 minutes of the limit, so any review slightly heavier than average is killed.
- **Cost of the miss:** the timed-out attempt produced `$0` of usable output and burned ~10 minutes of wall time before the moderator could recover and re-dispatch — the run's single largest efficiency loss.

**Risk of not doing it:** legitimate reviews near the ceiling keep getting killed, forcing costly re-dispatch and manual recovery.

## Design Context

**Why 15 minutes, and not a larger bump.** The #65 timeout fired on an agent that had gone *off-task* (scanning unrelated prior PRs) — so the ceiling was also correctly bounding a runaway. A larger timeout lengthens the wasted wall-clock and cost on exactly that failure mode. 15 minutes gives ~2× headroom over the observed 7m44s clean run while keeping a relatively tight leash on runaways. The complementary fix for off-task scope-creep — a "review only this PR's diff" guard on `/code-review` — is a separate concern and out of scope here.

**Interactions verified safe (no other ceiling crossed):**

- 15 min (900,000 ms) stays **above** `LONG_POLL_CEILING_MS` (270,000 ms / 4m30s, `mcp.service.ts:39`), so the #47 always-pending long-poll dispatch path for the teamlead is unchanged.
- 15 min is **below** both `MCP_REQUEST_TIMEOUT_MS` (1,800,000 ms / 30 min) and `SESSION_LIVENESS_TIMEOUT_MS` (30 min, `mcp.service.ts:61`), so neither the MCP transport timeout nor the session-liveness window is breached. (This is the trap that blocks blanket-doubling: `developer` already sits *at* the 30-min ceiling, so it cannot be raised in isolation — the teamlead bump has ample room.)

## Implementation Details

Single change in `apps/mcp-server/src/messaging/role-timeouts.ts`:

    [AgentRole.teamlead]: 15 * 60_000, // 15 min — /code-review pipeline

The inline comment is updated from `// 10 min — ticket creation` to `// 15 min — /code-review pipeline` to reflect that `/code-review` is now the role's long pole. (The full rationale and #65 reference live in this ticket rather than the code comment, matching the one-line style of the other `ROLE_TIMEOUTS` entries.)

`ROLE_TIMEOUTS` is a hardcoded architectural constant (the file header notes it is *not* env-configurable), so the change takes effect only on an **mcp-server image rebuild** — same deployment caveat as every QRM9 server-side fix.

## Acceptance Criteria

- [x] `ROLE_TIMEOUTS[teamlead]` is `15 * 60_000`.
- [x] The inline comment is updated to `// 15 min — /code-review pipeline` (terse, matching sibling entries; rationale + #65 reference kept in this ticket).
- [x] No other role timeout is changed.
- [x] `npm run build` / `npm run lint` / `npm run test` green (no test pins the teamlead value, so none needed updating).

## Dependencies and References

- **Evidence:** [#65 session report](../logs/sessions/2026-06-20-qrm9-65-worktree-commit-push-hardening.md) Issue §1 — "the ~10-minute broker timeout is too tight for `/code-review`"; successful retry 7m44s.
- **Complementary (not in scope):** a `/code-review` scope-guard to bound off-task runaways (the actual #65 failure mode); harvesting long reviews via the #47 always-pending mechanism rather than writing them off on timeout.
- **Touchpoint:** `apps/mcp-server/src/messaging/role-timeouts.ts`. Non-conflicting constants confirmed: `LONG_POLL_CEILING_MS`, `MCP_REQUEST_TIMEOUT_MS`, `SESSION_LIVENESS_TIMEOUT_MS`.
- **Epic:** [#49 QRM9 — Stabilization](49-stabilization/49-stabilization.md), residual-hygiene strand.

## Implementation Notes

**Status:** Complete

**Date:** 2026-06-20

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `tickets/72-teamlead-timeout-15min.md` | Created | This spec |
| `apps/mcp-server/src/messaging/role-timeouts.ts` | Modified | `ROLE_TIMEOUTS[teamlead]` 10 → 15 min; comment updated to `// 15 min — /code-review pipeline` |

### Deviations from Ticket Spec

- **Code comment kept terse.** The spec proposed an inline comment carrying the rationale and a #65 reference; the landed comment is the one-line `// 15 min — /code-review pipeline` to match the style of the sibling `ROLE_TIMEOUTS` entries. The rationale and evidence live here in the ticket, which is the durable record.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — green; no test pins the teamlead timeout value (specs read `ROLE_TIMEOUTS` dynamically), so none required updating