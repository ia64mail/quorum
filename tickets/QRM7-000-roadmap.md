# QRM7 Roadmap — Stabilization

## Goal

Harden the post-QRM6 system for reliable daily use. QRM6 delivered the containerized CC CLI moderator, MCP elicitation back-channel, and server-side session tracking — a major architectural shift. QRM7 fixes the operational gaps that surfaced during QRM6 development and early production runs: stale session routing, permission persistence, cwd misalignment, and log unification.

**Primary theme: Stabilization.** Every ticket in the initial scope addresses a known bug or code-quality gap carried forward from QRM6. Additional milestone goals (feature work, tooling, infrastructure) will be defined separately and appended to this roadmap as they are scoped.

## Problem

QRM6's live runs exposed several operational issues that individually degrade the user experience and collectively undermine confidence in the system's reliability. A second wave of related issues was uncovered during the QRM8 design run (`logs/sessions/2026-05-06-qrm8-roadmap-run.md`), all downstream of QRM7-001's reaper deployment — fixing one transport edge case made others observable.

**Carry-forward from QRM6:**

| Issue | Impact | Origin |
|-------|--------|--------|
| MCP session cleanup never fires on container shutdown | Dead moderator reported as connected; agent invocations route to a corpse and wait the full elicitation timeout before failing | QRM6-BUG-007, promoted to QRM7-001 |
| `InvokeRequest` declared twice (TS interface + Zod schema) | Two silent-strip bugs already shipped (QRM6-BUG-012 `sessionId`, QRM6-BUG-014 `bootstrapContext`); bidirectional guard added but dual declaration remains | QRM6-BUG-014 follow-up |
| Moderator cwd is `/app` (empty directory) | CC CLI anchors on wrong project root; model wastes turns self-correcting; permission grants write to read-only path and don't persist | Observed in QRM6 production runs |
| No moderator log adapter | `parse-logs.mjs` has no moderator-side input after `apps/terminal/` deletion; session reports lack moderator activity | QRM6-011, deferred from QRM6 |
| Unit test gap for new server-side components | Session auto-injection, `new_conversation`, elicitation connection, clarification auto-persist lack systematic unit coverage | QRM6-008 deferred |

**Surfaced post-QRM7-001 deployment (QRM8 design run, 2026-05-06 → 08, plus 2026-05-07 evening):**

| Issue | Impact | Origin |
|-------|--------|--------|
| Agent retry-once path races the MCP `initialize` handshake | Every reaper-driven agent reconnect produces 1 failed tool call + 4 WARN log lines; 9 events across 5 bursts in the QRM8 run; work-output preserved by SDK adaptation but operator log signal-to-noise is alarming | Issue 3 in `2026-05-06-qrm8-roadmap-run.md`, promoted to QRM7-008 |
| Reaper churns agent sessions that don't need liveness tracking | Pure collateral damage: agents are reachable via stable callback URL regardless of MCP session state, but the reaper still evicts them on idle, triggering the QRM7-008 race | Same run analysis, promoted to QRM7-009 |
| Moderator's CC CLI client holds stale session ID across long idle | First 1–4 tool calls after each post-idle resume fail with `Session not found`; user must manually type `/mcp`; ~1–4 min friction per burst-resume; reproduced in continuous-uptime idle (2026-05-07 evening) as well as hibernation gaps | Issue 2 in `2026-05-06-qrm8-roadmap-run.md` + 2026-05-07 evening observation, promoted to ~~QRM7-010~~ → QRM7-011 |

## Milestone Scope

### QRM7-001 — MCP Session Cleanup Not Firing

**Status:** Open (promoted from QRM6-BUG-007)

Stale MCP sessions accumulate because `transport.onclose` never fires on container shutdown — Streamable HTTP has no transport-level signal that the client died. The registry reports dead sessions as `connected: true`, causing `invoke_agent(target=moderator)` to route to a dead `McpElicitationConnection` and wait the full elicitation timeout.

**Fix is layered (three required, two optional):**

| Layer | Mechanism | Gap closed |
|-------|-----------|------------|
| 1. `lastSeenAt`-based `isConnected()` | Replace hardcoded `return true` with timestamp check | Sub-second fail-fast at routing time |
| 2. TCP keepalive on SSE socket | Tune kernel keepalive so `transport.onclose` fires in ~30–60s | Transport-level cleanup for graceful client deaths |
| 3. Periodic liveness reaper | `setInterval` sweep evicts sessions idle past threshold | Defense-in-depth backstop; bounds memory |
| 4. SIGTERM `DELETE` (optional) | Agent containers send explicit `DELETE` on shutdown | Sub-second cleanup for agents only |
| 5. `HttpAgentConnection.isConnected()` (optional) | Tighten HTTP agent liveness check | Out of scope unless triggered |

**Touches:** `apps/mcp-server/` — `mcp-elicitation-connection.ts`, `mcp.controller.ts`, `mcp.service.ts`, `agent-registry.service.ts`

**Depends on:** —

**Full ticket:** [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)

### QRM7-002 — Schema-First InvokeRequest Migration

**Status:** Done — implemented and reviewed 2026-05-04

Move `invokeRequestSchema` from `apps/agent/` to `libs/common/` and derive the `InvokeRequest` TypeScript interface via `z.infer`. Eliminates the dual declaration that caused two silent-strip bugs. The bidirectional compile-time guard added in QRM6-BUG-014 is defense; this is the cure.

**Touches:** `libs/common/src/messaging/invoke.types.ts`, `apps/agent/src/connection/invocation.controller.ts`, consumer audit across `apps/mcp-server/` and `apps/agent/`

**Depends on:** —

**Full ticket:** [QRM7-002](QRM7-002-schema-first-invoke-request-migration.md)

### QRM7-003 — Moderator Permission Grants Not Persisting

**Status:** Closed — **Superseded by QRM7-004** (2026-05-08)

CC CLI 2.1.119+ writes interactive "always allow" grants to `<cwd>/.claude/settings.local.json`. With `cwd=/app` (read-only), writes fail silently. QRM7-003 proposed a writable `/app/.claude/` volume mount, but QRM7-004's cwd relocation solves this more cleanly by landing grants on the existing workspace bind-mount.

**Resolution:** Close as superseded when QRM7-004 lands. Verify grants persist at `/mnt/quorum/workspace/.claude/settings.local.json`.

**Full ticket:** [QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md)

### QRM7-004 — Moderator cwd Not Aligned with Workspace

**Status:** Done — **Supersedes QRM7-003** (2026-05-08)

The moderator's `WORKDIR /app` is inherited boilerplate from other Dockerfile stages. `/app` is empty in the moderator image (only `/app/logs` bind-mount), yet CC CLI anchors its project root there. This causes: (a) model wastes turns self-correcting path references, (b) project-scope `CLAUDE.md` at `/mnt/quorum/workspace/CLAUDE.md` is not auto-loaded, (c) permission grants fail to persist (QRM7-003's symptom).

**Fix:** Change `Dockerfile` moderator stage `WORKDIR` to `/mnt/quorum/workspace`. Single-line change with cascading benefits:
- CC CLI auto-loads workspace `CLAUDE.md` as project-scope
- Permission grants land on writable workspace bind-mount
- Model's cwd matches the actual project root
- Eliminates need for QRM7-003's volume engineering

**Touches:** `Dockerfile` (moderator stage `WORKDIR`), optionally `docker/moderator/entrypoint.sh` (remove redundant CLAUDE.md echo)

**Depends on:** —

**Full ticket:** [QRM7-004](QRM7-004-moderator-cwd-not-aligned-with-workspace.md)

### QRM7-005 — Unified Moderator Log Adapter

**Status:** Open (moved from QRM6-011)

After `apps/terminal/` deletion, `parse-logs.mjs` has no moderator-side input. CC CLI writes session transcripts in a different JSONL schema than QuorumLogger. A post-processor adapter reads raw CC CLI session JSONL and emits `logs/moderator-{timestamp}.jsonl` in QuorumLogger shape, so `parse-logs.mjs` can ingest moderator activity on equal terms with agents.

**Key decisions:**
- Adapter at `tools/session-report/cc-session-adapter.mjs`
- Bind-mount raw CC CLI session logs under `logs/moderator-sessions/`
- Event mapping: `type=user` → `UserPrompt`, `type=assistant` text → `ModeratorResponse`, `type=assistant` tool_use → `ToolCall`, etc.
- Invoked as a pre-step by `parse-logs.mjs` or standalone

**Touches:** `tools/session-report/cc-session-adapter.mjs` (new), `tools/session-report/parse-logs.mjs`, `tools/session-report/SESSION-REPORT.md`, `docker-compose.yml` (moderator log volume)

**Depends on:** —

**Full ticket spec:** See [QRM6-000-roadmap.md § QRM6-011](QRM6-000-roadmap.md) for the detailed design carried forward.

### QRM7-006 — Unit Test Gap-Fill for QRM6 Server-Side Components

**Status:** Open (deferred from QRM6-008)

QRM6 landed new server-side components (elicitation connection, session auto-injection, `new_conversation` tool, clarification auto-persist) with the existing 760-test suite intact but no dedicated unit coverage for the new paths. The live playbook served as integration verification, but systematic unit tests are needed for CI regression gates.

**Coverage targets:**

| Component | Key scenarios |
|-----------|--------------|
| `McpElicitationConnection` | `handle()` calls `createElicitation`, resolves on response, rejects on timeout/session drop |
| `McpService` session state | Auto-injection of `callerRole`/`correlationId`/`sessionId`; explicit values override; `sessionId=""` forces fresh |
| `new_conversation` tool | Returns fresh UUID, clears `agentSessions` cache |
| `MessageBroker` | Clarification auto-persist to context store; `sessionId` cache updated from response |

**Touches:** `apps/mcp-server/src/` — spec files for `mcp-elicitation-connection`, `mcp.service`, `message-broker.service`, `agent-registry.service`

**Depends on:** —

### QRM7-008 — Agent `McpClientService` Retry-Once Path Races MCP `initialize`

**Status:** Open

The agent-side retry-once self-heal added in QRM5-BUG-005 fires `client.callTool()` *before* the new transport's MCP `initialize` round-trip has committed server-side. The retry lands on a freshly-opened-but-not-yet-initialized SDK server and surfaces `Bad Request: Server not initialized` — a different error class from `Session not found`, so `isSessionNotFound()` does not catch it and the call surfaces as a hard SDK tool failure. Work-output is preserved because the SDK adapts; log signal-to-noise is alarming and operator mental model degrades.

**Fix:**
- **Part 1 (load-bearing):** Replace the `reconnecting` boolean with a memoized `reconnectPromise`. Both call sites (`transport.onclose` and `callTool()` catch block) `await` the same in-flight chain; the catch-block retry no longer fires until `connect → register → discoverTools` resolves.
- **Part 2 (belt-and-suspenders):** Broaden `isSessionNotFound()` to recognize `Server not initialized` / `Bad Request: Server not initialized` as the same failure class. Single-retry guard preserved.

**Touches:** `apps/agent/src/connection/mcp-client.service.ts`, matching spec file

**Depends on:** —

**Full ticket:** [QRM7-008](QRM7-008-agent-retry-races-mcp-initialize.md)

### QRM7-009 — Scope MCP Session Reaper to Elicitation Sessions

**Status:** Done (2026-05-09) — pending runtime verification of the Burst-E integration check.

QRM7-001's reaper applies uniformly to every MCP session in `sessionStates`, but only the moderator's `McpElicitationConnection` actually depends on session liveness for routing — agents are reached by `HttpAgentConnection` via stable callback URLs that survive any MCP session churn. The result: the reaper evicts agent sessions on idle, forces an unnecessary reconnect via the QRM5-BUG-005 retry path, and exposes the QRM7-008 race. **Pure collateral damage** — 9 spurious failures across the QRM8 run, zero correctness improvements from reaping agents.

**Fix:** `isSessionAlive()` returns `true` for sessions whose role is in the deployable agent set, regardless of `lastSeenAt`. Continues to apply liveness check for moderator and anonymous sessions. `register_agent` for an agent role evicts any prior session bound to the same role, preserving memory-bounding now that idle reaping is off.

This is **complementary** to QRM7-008 (not a substitute): QRM7-009 removes the dominant trigger; QRM7-008 hardens the retry path for residual triggers (real mcp-server restart, container crash recovery).

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts` (`isSessionAlive`, `register_agent` handler), spec files

**Depends on:** QRM7-001 (must be deployed; QRM7-009 narrows its scope)

**Full ticket:** [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md)

### QRM7-010 — Moderator's MCP Client Holds Stale Session Across Long Idle

**Status:** Closed — Superseded by QRM7-011 (2026-05-09)

Superseded after log evidence from `mcp-server-20260508T134859.jsonl` revealed that CC CLI never opens SSE — the prior framing (SSE socket drops, hibernation wall-clock jumps, partial SDK reinit) investigated mechanisms that presuppose a stream that never existed. See [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md) for the corrected mechanism and fix plan.

**Full ticket:** [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md)

### QRM7-011 — CC CLI POST-Only Access Pattern Incompatible with Server's SSE-Based Liveness Keepalive

**Status:** Open (2026-05-09) — Candidate A landed 2026-05-09; B/C remain. Supersedes QRM7-010.

CC CLI 2.1.126 communicates via POST-only and never opens an SSE `GET /mcp` long-poll. The server's 2-min liveness timeout is calibrated for SSE-bridged clients whose `lastSeenAt` refreshes every 30 s via keepalive ping. Without SSE, any >2 min gap between tool calls reaps the session. Root cause of every observed `Session not found` failure in moderator interactive use — confirmed by 11+ hours of log data (0 GET requests across 1160 POSTs).

**Fix candidates:**

| Candidate | Description | Scope |
|-----------|-------------|-------|
| **A. Cheap mask (hotfix)** | Bump `SESSION_LIVENESS_TIMEOUT_MS` from 120 s → 30 min. One-line change. | ✅ Landed 2026-05-09 |
| **B. Principled fix** | Detect POST-only sessions (track `hasOpenedSse`); exempt from idle reaping. Memory-bound by same-role eviction. | After A |
| **C. Investigation** | Why does CC CLI never open SSE? Server bug, client design choice, or environmental? | Parallel |

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts` (timeout const for A; `hasOpenedSse` for B), `apps/mcp-server/src/mcp/mcp.controller.ts` (track GET-opened state for B). Spec files matching.

**Depends on:** None. Independent.

**Full ticket:** [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md)

---

## Dependency Graph

```
QRM7-001 (Session Cleanup)         ─── independent (DONE 2026-05-03)
QRM7-002 (Schema-First Migration)  ─── independent (DONE 2026-05-04)
QRM7-003 (Permission Persistence)  ─── SUPERSEDED by QRM7-004 (closed 2026-05-08)
QRM7-004 (Moderator cwd Fix)       ─── independent (DONE 2026-05-08, closes QRM7-003)
QRM7-005 (Log Adapter)             ─── independent
QRM7-006 (Unit Test Gap-Fill)      ─── independent
QRM7-007 (Moderator Subscription)  ─── independent (DONE 2026-05-04)
QRM7-008 (Agent Retry Race)        ─── independent
QRM7-009 (Scope Reaper)            ─── after QRM7-001 (DONE 2026-05-09)
QRM7-010 (Moderator Stale Session) ─── SUPERSEDED by QRM7-011 (closed 2026-05-09)
QRM7-011 (CC CLI POST-Only Liveness)  ─── independent
```

QRM7-001, QRM7-002, QRM7-004, QRM7-007, and QRM7-009 are complete. QRM7-003 is closed (superseded by QRM7-004). QRM7-010 is closed (superseded by QRM7-011). QRM7-011 Candidate A is landed; B and C remain. QRM7-008 is the remaining post-QRM7-001 cluster member: hardens the agent-side retry path for residual failures (real mcp-server restart, container crash) — much lower frequency now that QRM7-009 has eliminated the dominant trigger.

**Recommended sequencing (by operational impact, given current state):**

1. ~~**QRM7-011** Candidate A (CC CLI POST-only liveness hotfix)~~ — ✅ DONE 2026-05-09. One-line timeout bump; stops all observed `Session not found` breakage.
2. ~~**QRM7-009** (scope reaper)~~ — ✅ DONE 2026-05-09. Eliminates 9 spurious agent reconnects/burst that the QRM8 design run captured; immediately quiets log signal-to-noise.
3. **QRM7-011** Candidate B (POST-only session detection) — principled fix. After it lands, the QRM7-011-A timeout bump can revert to 2 min for SSE-backed sessions, restoring the original fail-fast behavior.
4. **QRM7-008** (agent retry race) — hardens the residual-trigger path that 009 cannot eliminate (real mcp-server restart, container crash). Lower urgency now that 009 ships but still needed for correctness.
5. ~~**QRM7-004** (cwd fix)~~ — ✅ DONE 2026-05-08. Smallest change, high daily-use improvement, also resolves QRM7-003.
6. ~~**QRM7-002** (schema-first)~~ — ✅ DONE 2026-05-04. Code quality, prevents future silent-strip bugs.
7. **QRM7-006** (unit tests) — CI hardening, can run after any of the above.
8. **QRM7-005** (log adapter) — tooling convenience, no functional urgency.

## Additional Goals

Beyond the stabilization carry-forwards above, the following goals are appended as they are scoped:

### QRM7-007 — Shift Moderator from API Key to Subscription (OAuth) Auth

**Status:** Open

The moderator currently inherits `ANTHROPIC_API_KEY` via the compose `x-shared-env` anchor and bills against the org's metered API quota for every CC CLI orchestration turn. With a Claude.ai subscription seat available, the moderator should authenticate via `claude /login` (OAuth) so its interactive turns are covered by the flat per-month seat. Agents must keep the API key — Claude Agent SDK calls the Anthropic API programmatically, which subscription seats do not grant.

**Touches:** `docker-compose.yml` (drop `<<: *shared-env` from moderator service), `docker/moderator/settings.json` (add `forceLoginMethod: "claudeai"` defense-in-depth)

**One-time:** interactive `/login` via `docker compose exec -it moderator claude`; OAuth token persists on the existing `moderator-claude-data` volume.

**Depends on:** —

**Full ticket:** [QRM7-007](QRM7-007-moderator-subscription-auth.md)

> Further QRM7 goals will be discussed and appended here. Candidate areas:
>
> - Feature work (new capabilities, workflow improvements)
> - Tooling and developer experience
> - Infrastructure and scaling
> - Documentation consolidation

## Carry-Forward Registry

Items deferred into QRM7 from previous milestones:

| Item | Origin | QRM7 Ticket |
|------|--------|-------------|
| MCP session cleanup / stale session routing | QRM6-BUG-007 | QRM7-001 |
| Schema-first `InvokeRequest` | QRM6-BUG-014 Option B | QRM7-002 |
| Permission grant persistence (CC CLI 2.1.119+ regression) | Observed post-QRM6 | QRM7-003 (superseded by QRM7-004) |
| Moderator cwd misalignment | Observed post-QRM6 | QRM7-004 |
| Unified moderator log adapter | QRM6-011 | QRM7-005 |
| Unit test gap-fill for server-side components | QRM6-008 deferred | QRM7-006 |

## Post-QRM7-001 Findings (Surfaced In-Milestone)

Discovered after QRM7-001's deployment, while running the QRM8 design session and during continuous-uptime moderator usage in the same week. Promoted into QRM7 scope rather than punted to QRM8 because they belong to the same MCP-transport stabilization theme and unblock D9/D10 in the QRM8 roadmap:

| Finding | Surfaced By | QRM7 Ticket |
|---------|-------------|-------------|
| Agent retry-once path races MCP `initialize` handshake | `logs/sessions/2026-05-06-qrm8-roadmap-run.md` Issue 3 | QRM7-008 |
| Reaper churns agent sessions despite their stable callback URL | Same run analysis (asymmetry between connection types) | QRM7-009 |
| Moderator's CC CLI client holds stale session ID after long idle (hibernation + continuous-uptime) | Issue 2 in same log + 2026-05-07 evening reproduction | ~~QRM7-010~~ → QRM7-011 |

## Icebox Items (Not Scheduled)

The following items from `tickets/ICEBOX.md` remain unscheduled. They are noted here for awareness but are **not** part of the QRM7 scope:

- **Duplicate Invocation Prevention** — idempotency keys / "is agent busy?" query (Icebox #1)
- **Agent Session Resume via Correlation ID** — blocked by upstream SDK issues #247 and #192 (Icebox #3)

## References

- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — predecessor milestone; QRM7 stabilizes the architecture QRM6 delivered
- [QRM6-008-tests.md](QRM6-008-tests.md) — playbook results and deferred unit test rationale
- [ICEBOX.md](ICEBOX.md) — unscheduled technical debt registry
- [docs/system-design.md](../docs/system-design.md) — current system architecture (post-QRM6)
