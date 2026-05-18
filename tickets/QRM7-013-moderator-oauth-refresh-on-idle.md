# QRM7-013: Moderator OAuth Access Token Not Auto-Refreshed Across Long Idle

**Status: Code-complete (2026-05-14) — human-run steps pending (token issuance, /status check, hibernation regression test)**

## Summary

After QRM7-007 shifted the moderator container from `ANTHROPIC_API_KEY` to interactive `/login` subscription OAuth, the moderator surfaces `401 authentication_error` and forces a fresh `/login` after every laptop-hibernation gap of ≥ ~10 hours, despite a valid refresh token sitting on the persistent volume. QRM7-007's "Token refresh" section claimed this would be handled transparently by CC CLI; field evidence falsifies that claim. Mitigate by switching to a long-lived token issued by `claude setup-token`, set as `CLAUDE_CODE_OAUTH_TOKEN`, which preserves QRM7-007's flat-rate subscription-seat billing and is the documented headless path.

## Problem Statement

During the QRM8 design run (`logs/sessions/2026-05-06-qrm8-roadmap-run.md`, Issue 1), the moderator hit Anthropic API `401 authentication_error` **5 times across a single 47-hour session**, each forcing a manual `/login` cycle:

| # | UTC time | Wall gap before |
|---|---|---|
| 1 | 2026-05-06 02:27:50 | startup → first prompt (expected first attach) |
| 2 | 2026-05-06 13:27 | 10h 30m idle |
| 3 | 2026-05-07 02:43 | 12h 50m idle |
| 4 | 2026-05-07 13:46 | 11h 02m idle |
| 5 | 2026-05-08 00:53 | 10h 58m idle |

The pattern is mechanical: every laptop-hibernation gap of ≥ ~10 hours triggers an OAuth token failure on the first user prompt after resume. No 401s were observed inside an active burst. Each cycle costs ~5 seconds of friction plus the cognitive cost of context-switching out of the in-progress prompt. Across an "always-on" QRM8 deployment scenario this is unacceptable; for daily interactive use it is tolerable but persistently annoying.

### Why QRM7-007 was wrong on this point

[QRM7-007](QRM7-007-moderator-subscription-auth.md) lines 103–105 asserted:

> "OAuth tokens carry a refresh token; CC CLI handles renewal transparently as long as the container has outbound network access … No cron, no manual refresh."

This was a **plausible inference, not a verified claim** — QRM7-007's acceptance criteria (line 122) included "OAuth credentials survive `docker compose restart moderator` — no re-login required" but did not include any long-idle / hibernation criterion. The 47-hour QRM8 design run is the first sustained-uptime test the moderator-OAuth path has been subjected to, and it falsified the auto-refresh assumption.

The moderator-side configuration is correct: refresh token *is* persisted on the `moderator-claude-data` volume, container has outbound network access to claude.ai, `forceLoginMethod: "claudeai"` is set, `ANTHROPIC_API_KEY` is absent (verified post-QRM7-007). The bug is upstream, not in our setup.

### Risk of leaving as-is

- Five user-visible friction events per ~50h of operation; scales linearly with uptime.
- Blocks any QRM8 "autonomous overnight run" scenario — first prompt after resume always 401s, halting the session at exactly the moment unattended progress would resume.
- Compounds with [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) (SSE-stream-death reaping): a post-hibernation resume currently surfaces *both* an OAuth 401 *and* a stale MCP session — ~3–6 minutes of cumulative recovery friction per burst.

## Design Context

### Upstream bug class — known, unfixed, no canonical tracking issue

This is a documented multi-issue pattern on `anthropics/claude-code` with **no fix-version**, **no committed timeline**, and **no Anthropic-engineer engagement** visible on any of the related issues:

| Issue | State | Relevance |
|---|---|---|
| [#12447](https://github.com/anthropics/claude-code/issues/12447) | **Open**, regression label, `area:auth`, has-repro | Multi-day Docker run; closest match to our environment |
| [#44930](https://github.com/anthropics/claude-code/issues/44930) | **Open**, stale | `claude login` itself fails with 401, no recovery path after 34+ hours |
| [#50743](https://github.com/anthropics/claude-code/issues/50743) | Closed as duplicate | Linux VM headless, refreshToken ignored — exact pattern |
| [#34306](https://github.com/anthropics/claude-code/issues/34306) | Closed as duplicate | OAuth not auto-refreshed on startup, forces re-login after every PC restart |
| [#42904](https://github.com/anthropics/claude-code/issues/42904) | Closed as duplicate | Daily re-login required for subscription users |
| [#28827](https://github.com/anthropics/claude-code/issues/28827) | Closed as duplicate | OAuth token refresh fails in non-interactive/headless mode |
| [#22066](https://github.com/anthropics/claude-code/issues/22066) | Closed as duplicate | OAuth not persisting across Docker container restarts |
| [#21765](https://github.com/anthropics/claude-code/issues/21765) | Closed (not planned) | refreshToken ignored when credentials moved between machines |

The "closed as duplicate, no canonical issue linked" pattern means **there is no upstream tracking issue we can subscribe to**. We must mitigate ourselves.

### Refresh mechanics (what is known)

Anthropic's [Authentication doc](https://code.claude.com/docs/en/authentication) documents `apiKeyHelper` refresh behavior in detail (configurable via `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, called after 5 minutes or on HTTP 401) but **says nothing about subscription-OAuth lifetime, refresh cadence, or 401 recovery**. Refresh behavior for the Claude.ai subscription path is undocumented.

Empirically, across the cited issues, the refresh code path appears to be **lazy on first API call** (not background/proactive) and to fail silently in headless/container scenarios despite the refresh token being present. There is **no documented "refresh on resume from idle"** code path. The hibernation-correlated 10h trigger is consistent with a clock-jump invalidating the local `expiresAt` check while the refresh fallback either is not invoked or rejects — both plausible mechanisms, neither confirmable without reading the minified CC CLI bundle.

### Credential storage layout (2.1.126, Linux)

Confirmed in issue bodies #42904 and #21765: credentials live at `~/.claude/.credentials.json` (mode 0600) with a `claudeAiOauth` block containing `accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`. In our setup this file lands on the `moderator-claude-data` named volume via the existing `/home/quorum/.claude/` mount (`docker-compose.yml:173`) — persistence is fine; the bug is in the refresh logic, not in storage.

(Note: a prior session log claim that the credential path moved at CC CLI 2.1.119 was **not corroborated** by research — no evidence of a 2.1.119 path move was found. The Linux layout has been stable for the full 2.1.x line.)

### Why `setup-token` preserves QRM7-007's billing premise

`claude setup-token` issues a long-lived OAuth token (format `sk-ant-oat01-…`) intended for headless / programmatic use. The official [Authentication doc](https://code.claude.com/docs/en/authentication) is explicit on its billing class:

> "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`. This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It is scoped to inference only and cannot establish Remote Control sessions."

The same page's auth-precedence list places `CLAUDE_CODE_OAUTH_TOKEN` (item 5) and `/login` credentials (item 6) in the **subscription tier**, distinct from `ANTHROPIC_API_KEY` (item 3, "direct Anthropic API access"). Calls authenticated by either credential consume the same flat-rate subscription seat — switching to `setup-token` does *not* re-introduce the metered-billing path that QRM7-007 was designed to avoid.

The token has a documented ~1-year lifetime and is observed in some user reports to be involuntarily rotated earlier (see [#19274](https://github.com/anthropics/claude-code/issues/19274)). This is acceptable: a once-a-year forced re-issuance is two orders of magnitude better than the current twice-daily forced `/login`.

## Implementation Details

### Recommended fix: switch the moderator from interactive `/login` to `CLAUDE_CODE_OAUTH_TOKEN`

#### Step 1 — Generate the token (one-time, manual)

Inside the running moderator container:

```bash
docker compose exec -it moderator claude setup-token
# Follow the printed URL, complete subscription auth in browser,
# paste the resulting code back. CC CLI prints the token (sk-ant-oat01-…).
```

Copy the printed token into the project `.env` file:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
```

`.env` is already gitignored. Treat the token like any other credential: do not commit, do not paste into chat or PRs.

#### Step 2 — Wire it into the moderator service env

In `docker-compose.yml`, add the variable to the moderator's `environment:` block alongside the existing `MCP_SERVER_URL`:

```yaml
environment:
  <<: *git-identity
  MCP_SERVER_URL: http://mcp-server:3000/mcp
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
```

Do **not** add it to `x-shared-env` — agents continue to use `ANTHROPIC_API_KEY` and must not see the moderator's subscription token (different billing path, different failure modes).

#### Step 3 — Seed `hasCompletedOnboarding` to suppress prompt on fresh container

Per HN report ([item 46691873](https://news.ycombinator.com/item?id=46691873)) and confirmed in user reports, even with `CLAUDE_CODE_OAUTH_TOKEN` set, CC CLI may still prompt for onboarding on first start in a fresh `~/.claude.json`. Our existing entrypoint merge already preserves `~/.claude.json` across restarts (QRM6-BUG-009 Phase 2), so the prompt is a one-time event for fresh volumes. Two options:

- **Accept it.** First container start after volume reset requires one interactive pass. Lower complexity; consistent with current `/login` flow.
- **Bake `"hasCompletedOnboarding": true`** into `docker/moderator/claude.json` so the entrypoint's `jq -s '.[0] * .[1]'` merge propagates it on every start. Eliminates the prompt entirely.

Recommend the latter — small change, removes the only remaining manual step from a clean rebuild.

#### Step 4 — Verify

After `./scripts/start.sh -d`:

1. `docker compose exec moderator env | grep CLAUDE_CODE_OAUTH_TOKEN` — confirms the token is present in the container env.
2. `docker compose exec -it moderator claude` → `/status` — expected: subscription auth reported, no API-key mention, no `/login` prompt.
3. Trigger any moderator turn that calls an agent; confirm the call lands without a 401.
4. **The load-bearing acceptance test** — let the host hibernate for ≥ 12 hours, resume, and verify the first moderator prompt does not 401. This is the regression QRM7-007 didn't catch and the only criterion that proves the mitigation works.

#### Step 5 — Update QRM7-007

Soften the "Token refresh" section (QRM7-007 lines 103–105) to reflect that the assumed auto-refresh does not work in practice and to point at QRM7-013 for the corrected guidance. Add a one-line cross-reference under "Implementation Notes."

### Alternatives considered

| Alternative | Why not |
|---|---|
| **Cron `claude /status` keepalive** | Would refresh the access token on a cadence shorter than the failure window — but does not survive a host clock-jump on hibernation (the symptom is *correlated with* the resume, not with elapsed wall-clock between calls inside an active burst). Adds a process to babysit and does not address the documented headless-refresh bug. |
| **Wrapper PTY supervisor that types `/login`** | Same shape as QRM7-010's PTY-supervisor sketch — works but high complexity for a problem with a documented config-only fix. |
| **Wait for upstream fix** | No canonical tracking issue, no fix-version, no Anthropic-engineer engagement on any of the cited issues. The two open ones (#12447, #44930) are both stale-tagged. Waiting is not a strategy. |
| **Fall back to `ANTHROPIC_API_KEY`** | Reverts QRM7-007 entirely — re-introduces metered org billing for moderator turns. Wrong direction. |

### Reverting

To shift back to interactive `/login`:

1. Remove `CLAUDE_CODE_OAUTH_TOKEN` line from the moderator service `environment:` block in `docker-compose.yml`.
2. Remove the variable from `.env`.
3. (If Step 3's belt-and-suspenders was applied) remove `hasCompletedOnboarding` from `docker/moderator/claude.json`.

The OAuth credentials from prior `/login` runs remain on the volume; CC CLI's auth-precedence resolver will fall back to them.

## Acceptance Criteria

- [x] `docker-compose.yml` moderator service `environment:` block exposes `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}`
- [x] `.env.example` documents the variable and points to `claude setup-token` for issuance; `.env` itself is not committed
- [ ] One-time `claude setup-token` run inside the moderator produces a valid token; the token is added to `.env`
- [x] (Optional but recommended) `docker/moderator/claude.json` includes `"hasCompletedOnboarding": true` so the entrypoint merge propagates it on every start, suppressing first-run onboarding on fresh volumes
- [ ] Inside the running moderator, `claude /status` reports Claude.ai subscription auth (not API key, not "no auth")
- [ ] **Regression test that QRM7-007 lacked:** after a ≥ 12-hour host hibernation, the first moderator prompt on resume does **not** surface `401 authentication_error` and does **not** require manual `/login`
- [x] Agent containers continue to invoke the Anthropic API successfully via `ANTHROPIC_API_KEY` — `CLAUDE_CODE_OAUTH_TOKEN` was added only to the moderator service, not to `x-shared-env`
- [x] [QRM7-007](QRM7-007-moderator-subscription-auth.md) "Token refresh" section softened and cross-references QRM7-013
- [x] [QRM7-000](QRM7-000-roadmap.md) Carry-Forward Registry / Post-QRM7-001 Findings table records this ticket alongside the existing entries

## Dependencies and References

### Prerequisites
- [QRM7-007](QRM7-007-moderator-subscription-auth.md) — moderator on subscription auth (DONE 2026-05-04). QRM7-013 mitigates a regression-class symptom that emerged from QRM7-007's deployment under sustained uptime.
- Active Claude.ai subscription seat (Pro, Max, Team, or Enterprise) — required by `setup-token` per the official Authentication doc.
- Outbound network access from the moderator to claude.ai (already in place).

### What this blocks

- Any QRM8 "always-on" / "autonomous overnight run" scenario — currently each post-hibernation resume forces a manual `/login` before the moderator can dispatch its first agent. Compounds with [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md): post-hibernation resume currently surfaces *both* an OAuth 401 *and* a stale MCP session.

### References

- `docker/moderator/settings.json` — baked moderator settings (`forceLoginMethod: "claudeai"` from QRM7-007)
- `docker/moderator/claude.json` — baked `~/.claude.json` template (`mcpServers` + onboarding seed if Step 3 applied)
- `docker/moderator/entrypoint.sh:14-22, :37-45` — `jq -s '.[0] * .[1]'` merge that propagates baked keys onto every container start; covers the optional `hasCompletedOnboarding` propagation
- `docker-compose.yml:144-174` — moderator service block; `CLAUDE_CODE_OAUTH_TOKEN` lands here
- `docker-compose.yml:173` — `moderator-claude-data` named volume backs `/home/quorum/.claude/` (where credentials persist)
- `Dockerfile:102` — CC CLI 2.1.126 pinned
- [logs/sessions/2026-05-06-qrm8-roadmap-run.md § Issue 1](../logs/sessions/2026-05-06-qrm8-roadmap-run.md) — field evidence (5 forced `/login` cycles, 47h session)
- [QRM7-007](QRM7-007-moderator-subscription-auth.md) lines 103–105 — falsified auto-refresh claim
- [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md) line 146 — explicit deferral of "the Anthropic OAuth-refresh issue" to a separate ticket; this is that ticket
- [Anthropic — Authentication (Claude Code docs)](https://code.claude.com/docs/en/authentication) — `setup-token`, precedence list, subscription-tier credentials
- GitHub `anthropics/claude-code` issues — see Design Context table for full list

### Relationship to other QRM7 work

- **Independent of [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md)** (SSE-stream-death reaping). Different layer (Anthropic identity service vs MCP transport), different failure surface, different fix. Both should land — they compound on hibernation resume.
- **Independent of [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md)** — agent-side retry race; this ticket is moderator-side auth.
- **Not** the [QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md) permission-grant regression. Different file (`~/.claude/.credentials.json` vs `<cwd>/.claude/settings.local.json`), different cause (token TTL vs read-only path), different fix. The QRM8 design run log § Issue 1 explicitly disambiguates the two.

## Implementation Notes

**Status:** Partial (code-side complete; human-run steps pending)

**Date:** 2026-05-14

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `docker-compose.yml` | Modified | Added `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}` to the moderator service's `environment:` block (line 170). Not added to `x-shared-env` — agents remain on `ANTHROPIC_API_KEY`. |
| `.env.example` | Modified | Documented `CLAUDE_CODE_OAUTH_TOKEN` with issuance procedure (`claude setup-token`), subscription-tier requirement, billing context (QRM7-007), and ticket reference. Updated `ANTHROPIC_API_KEY` heading from `(terminal, agent)` to `(agents only)`. |
| `docker/moderator/claude.json` | Modified | Added `"hasCompletedOnboarding": true` so the entrypoint's `jq -s '.[0] * .[1]'` merge propagates it on every start, suppressing first-run onboarding on fresh volumes. |
| `tickets/QRM7-013-moderator-oauth-refresh-on-idle.md` | Modified | Flipped 6 code-resolvable acceptance criteria checkboxes; 3 human-only items remain unchecked. |

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 748 tests passing (0 new — config-only change, no new test surface)
- `.env` confirmed in `.gitignore` (line 16)
- `CLAUDE_CODE_OAUTH_TOKEN` is NOT in `x-shared-env` (verified in docker-compose.yml lines 7–17)
- Agent services (architect, teamlead, developer) all inherit `<<: *shared-env` — no exposure to the moderator token
- Entrypoint merge (`docker/moderator/entrypoint.sh:37-45`) uses baked-wins semantics (`jq -s '.[0] * .[1]'`): `hasCompletedOnboarding: true` propagates on fresh and existing volumes; existing CC CLI state (oauth, projects) survives
- QRM7-007 "Token refresh" section already softened (2026-05-09) with cross-reference to QRM7-013 — pre-dates this commit
- QRM7-000 Post-QRM7-001 Findings table already contains QRM7-013 row — pre-dates this commit

### Pending Human-Run Steps (block ticket close)

Three acceptance criteria require manual execution inside the rebuilt moderator container:
1. `claude setup-token` — one-time token issuance, add to `.env`
2. `claude /status` — verify subscription auth is active
3. ≥ 12-hour hibernation regression test — the load-bearing acceptance test