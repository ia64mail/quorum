# QRM7 Roadmap — Stabilization

## Goal

Harden the post-QRM6 system for reliable daily use. QRM6 delivered the containerized CC CLI moderator, MCP elicitation back-channel, and server-side session tracking — a major architectural shift. QRM7 fixes the operational gaps that surfaced during QRM6 development and early production runs: stale session routing, permission persistence, cwd misalignment, and log unification.

**Primary theme: Stabilization.** Every ticket in the initial scope addresses a known bug or code-quality gap carried forward from QRM6. Additional milestone goals (feature work, tooling, infrastructure) will be defined separately and appended to this roadmap as they are scoped.

## Problem

QRM6's live runs exposed several operational issues that individually degrade the user experience and collectively undermine confidence in the system's reliability:

| Issue | Impact | Origin |
|-------|--------|--------|
| MCP session cleanup never fires on container shutdown | Dead moderator reported as connected; agent invocations route to a corpse and wait the full elicitation timeout before failing | QRM6-BUG-007, promoted to QRM7-001 |
| `InvokeRequest` declared twice (TS interface + Zod schema) | Two silent-strip bugs already shipped (QRM6-BUG-012 `sessionId`, QRM6-BUG-014 `bootstrapContext`); bidirectional guard added but dual declaration remains | QRM6-BUG-014 follow-up |
| Moderator cwd is `/app` (empty directory) | CC CLI anchors on wrong project root; model wastes turns self-correcting; permission grants write to read-only path and don't persist | Observed in QRM6 production runs |
| No moderator log adapter | `parse-logs.mjs` has no moderator-side input after `apps/terminal/` deletion; session reports lack moderator activity | QRM6-011, deferred from QRM6 |
| Unit test gap for new server-side components | Session auto-injection, `new_conversation`, elicitation connection, clarification auto-persist lack systematic unit coverage | QRM6-008 deferred |

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

---

## Dependency Graph

```
QRM7-001 (Session Cleanup)        ─── independent
QRM7-002 (Schema-First Migration) ─── independent
QRM7-003 (Permission Persistence) ─── SUPERSEDED by QRM7-004
QRM7-004 (Moderator cwd Fix)      ─── independent (closes QRM7-003)
QRM7-005 (Log Adapter)            ─── independent
QRM7-006 (Unit Test Gap-Fill)     ─── independent
```

All tickets are independent and can run in parallel. QRM7-003 requires no implementation — it is closed when QRM7-004 lands and its acceptance criteria are verified.

**Recommended sequencing (by operational impact):**

1. **QRM7-004** (cwd fix) — smallest change, highest daily-use improvement, also resolves QRM7-003
2. **QRM7-001** (session cleanup) — most critical correctness fix, largest implementation surface
3. **QRM7-002** (schema-first) — code quality, prevents future silent-strip bugs
4. **QRM7-006** (unit tests) — CI hardening, can run after any of the above
5. **QRM7-005** (log adapter) — tooling convenience, no functional urgency

## Additional Goals

> **TBD** — Additional QRM7 goals beyond stabilization will be discussed and appended to this roadmap. Candidate areas include but are not limited to:
>
> - Feature work (new capabilities, workflow improvements)
> - Tooling and developer experience
> - Infrastructure and scaling
> - Documentation consolidation
>
> This section will be updated once goals are finalized.

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

## Icebox Items (Not Scheduled)

The following items from `tickets/ICEBOX.md` remain unscheduled. They are noted here for awareness but are **not** part of the QRM7 scope:

- **Duplicate Invocation Prevention** — idempotency keys / "is agent busy?" query (Icebox #1)
- **Agent Session Resume via Correlation ID** — blocked by upstream SDK issues #247 and #192 (Icebox #3)

## References

- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — predecessor milestone; QRM7 stabilizes the architecture QRM6 delivered
- [QRM6-008-tests.md](QRM6-008-tests.md) — playbook results and deferred unit test rationale
- [ICEBOX.md](ICEBOX.md) — unscheduled technical debt registry
- [docs/system-design.md](../docs/system-design.md) — current system architecture (post-QRM6)
