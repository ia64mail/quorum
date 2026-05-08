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
| Moderator's CC CLI client holds stale session ID across long idle | First 1–4 tool calls after each post-idle resume fail with `Session not found`; user must manually type `/mcp`; ~1–4 min friction per burst-resume; reproduced in continuous-uptime idle (2026-05-07 evening) as well as hibernation gaps | Issue 2 in `2026-05-06-qrm8-roadmap-run.md` + 2026-05-07 evening observation, promoted to QRM7-010 |

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

**Status:** Open (follow-up from QRM6-BUG-014)

Move `invokeRequestSchema` from `apps/agent/` to `libs/common/` and derive the `InvokeRequest` TypeScript interface via `z.infer`. Eliminates the dual declaration that caused two silent-strip bugs. The bidirectional compile-time guard added in QRM6-BUG-014 is defense; this is the cure.

**Touches:** `libs/common/src/messaging/invoke.types.ts`, `apps/agent/src/connection/invocation.controller.ts`, consumer audit across `apps/mcp-server/` and `apps/agent/`

**Depends on:** —

**Full ticket:** [QRM7-002](QRM7-002-schema-first-invoke-request-migration.md)

### QRM7-003 — Moderator Permission Grants Not Persisting

**Status:** Draft — **Superseded by QRM7-004**

CC CLI 2.1.119+ writes interactive "always allow" grants to `<cwd>/.claude/settings.local.json`. With `cwd=/app` (read-only), writes fail silently. QRM7-003 proposed a writable `/app/.claude/` volume mount, but QRM7-004's cwd relocation solves this more cleanly by landing grants on the existing workspace bind-mount.

**Resolution:** Close as superseded when QRM7-004 lands. Verify grants persist at `/mnt/quorum/workspace/.claude/settings.local.json`.

**Full ticket:** [QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md)

### QRM7-004 — Moderator cwd Not Aligned with Workspace

**Status:** Draft — **Supersedes QRM7-003**

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

**Status:** Open

QRM7-001's reaper applies uniformly to every MCP session in `sessionStates`, but only the moderator's `McpElicitationConnection` actually depends on session liveness for routing — agents are reached by `HttpAgentConnection` via stable callback URLs that survive any MCP session churn. The result: the reaper evicts agent sessions on idle, forces an unnecessary reconnect via the QRM5-BUG-005 retry path, and exposes the QRM7-008 race. **Pure collateral damage** — 9 spurious failures across the QRM8 run, zero correctness improvements from reaping agents.

**Fix:** `isSessionAlive()` returns `true` for sessions whose role is in the deployable agent set, regardless of `lastSeenAt`. Continues to apply liveness check for moderator and anonymous sessions. `register_agent` for an agent role evicts any prior session bound to the same role, preserving memory-bounding now that idle reaping is off.

This is **complementary** to QRM7-008 (not a substitute): QRM7-009 removes the dominant trigger; QRM7-008 hardens the retry path for residual triggers (real mcp-server restart, container crash recovery).

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts` (`isSessionAlive`, `register_agent` handler), spec files

**Depends on:** QRM7-001 (must be deployed; QRM7-009 narrows its scope)

**Full ticket:** [QRM7-009](QRM7-009-scope-reaper-to-elicitation-sessions.md)

### QRM7-010 — Moderator's MCP Client Holds Stale Session Across Long Idle

**Status:** Open

The user-visible burst-resume bug: after a long idle gap (laptop hibernation OR continuous-uptime idle on an awake host), the moderator's CC CLI MCP client retries `POST /mcp` with a server-reaped `Mcp-Session-Id`, surfaces `Session not found` to the model, and does not auto-handshake. The user must manually type `/mcp` to recover. CC CLI 2.1.126 — and upstream `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` — violates MCP Streamable HTTP spec §2.5(4) by refusing to re-initialize on HTTP 404; Anthropic's docs explicitly state this is a deliberate design decision. The bug is unfixed across at least 9 closed CC GitHub issues (2025-09 → 2026-05).

**Fix is layered (three parts, all in scope):**

| Part | Trigger addressed | Code location |
|------|-------------------|---------------|
| 1. Monotonic `lastSeenAt` | Hibernation false reap (wall-clock jump on resume) | `apps/mcp-server/src/mcp/mcp.service.ts` |
| 2. PTY supervisor in moderator container | Continuous-uptime long idle (genuine reap of dead session) | `docker/moderator/` (new `node-pty` proxy wrapping `claude`) |
| 3. Diagnostic instrumentation | Pin down trigger (2)'s root cause among four candidates | `apps/mcp-server/src/mcp/mcp.controller.ts` (logging only) |

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts`, `apps/mcp-server/src/mcp/mcp.controller.ts`, `docker/moderator/entrypoint.sh`, new `docker/moderator/supervisor/` directory

**Depends on:** QRM7-001 (this ticket modifies the reaper Q7-001 introduced); ideally lands after QRM7-009 (so the supervisor only intervenes for moderator sessions, not agent sessions that 009 removed from the reaper's path)

**Full ticket:** [QRM7-010](QRM7-010-moderator-stale-mcp-session-after-idle.md)

---

## Dependency Graph

```
QRM7-001 (Session Cleanup)         ─── independent (DONE 2026-05-03)
QRM7-002 (Schema-First Migration)  ─── independent
QRM7-003 (Permission Persistence)  ─── SUPERSEDED by QRM7-004
QRM7-004 (Moderator cwd Fix)       ─── independent (closes QRM7-003)
QRM7-005 (Log Adapter)             ─── independent
QRM7-006 (Unit Test Gap-Fill)      ─── independent
QRM7-007 (Moderator Subscription)  ─── independent (DONE 2026-05-04)
QRM7-008 (Agent Retry Race)        ─── independent
QRM7-009 (Scope Reaper)            ─── after QRM7-001 (deployed)
QRM7-010 (Moderator Stale Session) ─── after QRM7-001 (deployed); ideally after QRM7-009
```

QRM7-001 and QRM7-007 are already complete. QRM7-003 requires no implementation — it is closed when QRM7-004 lands and its acceptance criteria are verified. QRM7-008/009/010 form a coherent post-QRM7-001 cluster: 008 hardens the agent-side retry path; 009 stops the reaper from churning agent sessions in the first place; 010 stabilizes the moderator-side resume path. They are mostly independent of each other but ideally land in the order 009 → 010 → 008 (009 removes the dominant trigger 008 fixes; 010 reuses 009's narrowed reaper semantics).

**Recommended sequencing (by operational impact, given current state):**

1. **QRM7-010** (moderator stale session) — ✱ highest user-visible operational tax today; reproduced twice in 48 h (hibernation gap + continuous-uptime idle). Parts 1 + 2 needed together. ✱
2. **QRM7-009** (scope reaper) — eliminates 9 spurious agent reconnects/burst that the QRM8 design run captured; immediately quiets log signal-to-noise.
3. **QRM7-008** (agent retry race) — hardens the residual-trigger path that 009 cannot eliminate (real mcp-server restart, container crash). Lower urgency once 009 ships but still needed for correctness.
4. **QRM7-004** (cwd fix) — smallest change, high daily-use improvement, also resolves QRM7-003.
5. **QRM7-002** (schema-first) — code quality, prevents future silent-strip bugs.
6. **QRM7-006** (unit tests) — CI hardening, can run after any of the above.
7. **QRM7-005** (log adapter) — tooling convenience, no functional urgency.

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
| Moderator's CC CLI client holds stale session ID after long idle (hibernation + continuous-uptime) | Issue 2 in same log + 2026-05-07 evening reproduction | QRM7-010 |

## Icebox Items (Not Scheduled)

The following items from `tickets/ICEBOX.md` remain unscheduled. They are noted here for awareness but are **not** part of the QRM7 scope:

- **Duplicate Invocation Prevention** — idempotency keys / "is agent busy?" query (Icebox #1)
- **Agent Session Resume via Correlation ID** — blocked by upstream SDK issues #247 and #192 (Icebox #3)

## References

- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — predecessor milestone; QRM7 stabilizes the architecture QRM6 delivered
- [QRM6-008-tests.md](QRM6-008-tests.md) — playbook results and deferred unit test rationale
- [ICEBOX.md](ICEBOX.md) — unscheduled technical debt registry
- [docs/system-design.md](../docs/system-design.md) — current system architecture (post-QRM6)
