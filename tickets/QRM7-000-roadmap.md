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
| Moderator's CC CLI client holds stale session ID across long idle | First 1–4 tool calls after each post-idle resume fail with `Session not found`; user must manually type `/mcp`; ~1–4 min friction per burst-resume; reproduced in continuous-uptime idle (2026-05-07 evening) as well as hibernation gaps | Issue 2 in `2026-05-06-qrm8-roadmap-run.md` + 2026-05-07 evening observation, promoted to ~~QRM7-010~~ → ~~QRM7-011~~ → QRM7-012 |
| Moderator OAuth access token not auto-refreshed across long idle | 5 `401 authentication_error` events across one 47h session, each forcing manual `/login` after a hibernation gap ≥ ~10h; falsifies QRM7-007's assumption that CC CLI handles renewal transparently | Issue 1 in `2026-05-06-qrm8-roadmap-run.md`, promoted to QRM7-013 |
| `invoke_agent` response lost when target work exceeds CC CLI's 5-min `undici.bodyTimeout` | Moderator sees `transport dropped mid-call; response for tool invoke_agent was lost`; agent work is committed but response envelope vanishes; triggers duplicate-invocation recovery path | Recurring across QRM5-BUG-003 → QRM7-014 follow-up; research ticket QRM7-015 |
| No visibility into `context_query mode=search` quality | Main MCP debug line records only scope + query string + hit count; result keys, scores, snippets, and hybrid-vs-BM25 engine choice are dropped before logging, so silent embedding-service fallback and bad relevance go unnoticed | Surfaced 2026-05-12 during context-store iteration; promoted to QRM7-016 |

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

**Status:** Closed — Superseded by QRM7-012 (2026-05-09)

Premise falsified by runtime instrumentation: CC CLI 2.1.126 **does** open SSE GET, within ~20 ms of session creation and before `register_agent` arrives. The "0 GETs in 11h" evidence base came from grepping for log lines our controller never emitted. Candidate B's `hasOpenedSse` exemption is dead code in the running bundle (sticky-true before role binds); Candidate A's timeout bump was the only mitigation actually working and is now reverted. See [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md) for the corrected mechanism.

**Full ticket:** [QRM7-011](QRM7-011-cc-cli-post-only-vs-server-keepalive.md)

### QRM7-012 — Moderator Session Reaped After SSE GET Stream Dies

**Status:** Open (2026-05-09) — third iteration. Supersedes QRM7-011, which superseded QRM7-010.

CC CLI opens GET on every session within ~20 ms of creation, before `register_agent` runs. `markSseOpened` flips `hasOpenedSse=true` while role is still `undefined`; QRM7-011-B's exemption branch (`role===moderator && !hasOpenedSse`) never fires. The reaper falls through to the bare `lastSeenAt` check. When the SSE stream dies (NAT/conntrack idle, OS TCP teardown, CC CLI internal recycle, transient blip) the keepalive stops refreshing `lastSeenAt`, and 2 min later the moderator session reaps. Same downstream symptom as QRM7-010 and QRM7-011; both prior framings were misdiagnoses caused by inferring transport behavior from logs that didn't capture the relevant signal.

**Upstream cause (high confidence):** SDK bug [modelcontextprotocol/typescript-sdk#1211](https://github.com/modelcontextprotocol/typescript-sdk/issues/1211) — the GET SSE has no client-side heartbeat, undici's default `bodyTimeout = 300_000` ms aborts the response body, the SDK fires `onerror('SSE stream disconnected: …')` and reconnects. The metronomic 5-min `Session created` cadence in our logs matches `undici.bodyTimeout` exactly. Not fixable on the client side; CC CLI bundles its own SDK version and the SDK fix is unmerged. Mitigation is server-side.

**Fix candidates:**

| Candidate | Description | Scope |
|-----------|-------------|-------|
| **A. Restore A's timeout bump** | Re-revert `SESSION_LIVENESS_TIMEOUT_MS` to 1 800 000 (30 min). The only mitigation that ever worked. | Immediate hotfix |
| **E. Immediate SSE ping + tightened cadence** | Write `: ready\n\n` immediately on GET open (kicks off the response body before any timer fires); reduce keepalive interval 30 s → 15 s. Cheapest principled lever; addresses the SDK bug at the only layer we control. | Land alongside A |
| **B. Live-SSE-response exemption** | Replace `hasOpenedSse` flag with active-response tracking; exempt moderator while SSE response is alive *or* `lastSeenAt` is fresh. | Principled follow-up |
| **C. PTY supervisor (from QRM7-010 Part 2)** | Wrap `claude` in supervisor that types `/mcp` on canonical errors. | Defer |
| **D. Instrument SSE-stream lifetime** | Capture `markSseOpened → res.on('close')` delta per session to confirm or reject the 300 000 ms hypothesis; carries forward QRM7-010 Part 3 instrumentation draft. | Parallel investigation |

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts`, `apps/mcp-server/src/mcp/mcp.controller.ts`, spec files. Diagnostic logging from `623faca` already in place.

**Depends on:** None. Independent.

**Full ticket:** [QRM7-012](QRM7-012-sse-stream-death-reaps-moderator.md)

### QRM7-013 — Moderator OAuth Access Token Not Auto-Refreshed Across Long Idle

**Status:** Open (filed 2026-05-09)

After QRM7-007 shifted the moderator from `ANTHROPIC_API_KEY` to interactive `/login` subscription OAuth, the moderator surfaces `401 authentication_error` after every laptop-hibernation gap ≥ ~10 h, despite a valid refresh token sitting on the persistent volume. QRM7-007's "Token refresh" claim that CC CLI handles renewal transparently is falsified by field evidence (5 401s across a single 47-hour session). Mitigate by switching to a long-lived token via `claude setup-token`, exposed to the container as `CLAUDE_CODE_OAUTH_TOKEN` — preserves QRM7-007's flat-rate subscription-seat billing and is the documented headless path.

**Touches:** `docker-compose.yml`, `docker/moderator/entrypoint.sh`; one-time interactive `claude setup-token` flow

**Depends on:** QRM7-007 (done)

**Full ticket:** [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md)

### QRM7-014 — Replace Dead `hasOpenedSse` With Live SSE Response Signal (Candidate B′)

**Status:** Done (2026-05-10) — verified in fresh runtime; all AC met.

Implements Candidate B′ from QRM7-012's candidate matrix. Replaces the sticky `hasOpenedSse` boolean — which never engages for moderator sessions due to GET-before-`register_agent` ordering — with `activeSseToken: object | null` identity-guarded tracking on `McpSessionState`. Candidates A + E remain the operational floor; B′ is correctness cleanup that expresses the right invariant ("does this session currently have a live SSE channel?") and removes confirmed-dead code. **2026-05-10 erratum:** POST-path SSE keepalive ticks DO fire continuously on long-running `invoke_agent` responses — the "dead `setInterval`" claim from QRM7-012 § Validation was scoped only to the GET path; this nuance unlocks the empirical baseline that QRM7-015 builds on.

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts`, `apps/mcp-server/src/mcp/mcp.controller.ts`, spec files

**Depends on:** QRM7-012 (Candidates A + E landed)

**Full ticket:** [QRM7-014](QRM7-014-candidate-b-prime-live-sse-response-signal.md)

### QRM7-015 — Long-Call Response Delivery (Research)

**Status:** Open — Research (rewritten 2026-05-12)

Research ticket recommending a **long-poll continuation** pattern for delivering `invoke_agent` responses that exceed CC CLI's 5-minute `undici.bodyTimeout`. The server holds the POST response up to a 4 min 30 s ceiling and returns `{ status: "pending", invocationId }` cleanly before the timeout fires; the moderator follows a one-paragraph CLAUDE.md rule to call `wait_invocation(invocationId)` to continue waiting. Sub-5-min calls have zero protocol overhead (sync-shaped from the LLM's perspective); a 20-min task costs ~$0.40 in continuations with sub-second completion latency. Selected over server-push (CC CLI MCP client confirmed not to surface notifications), fire-and-forget Bash-sleep polling (~$2.40 + 60–180 s latency), and singleton-anchor designs after empirical evidence from 48 successful long-hold POST responses post-QRM7-014.

**Implementation ticket:** to be filed after research acceptance — single ticket covering `InvocationResultStore`, `wait_invocation` MCP tool, `invoke_agent` long-poll racing, caller-aware policy, `callerRole` auto-bind sidecar, CLAUDE.md rule.

**Touches:** `tickets/QRM7-015-long-call-response-delivery-research.md` (research deliverable only)

**Depends on:** QRM7-012 (mitigated), QRM7-014 (done — keepalive infrastructure)

**Full ticket:** [QRM7-015](QRM7-015-long-call-response-delivery-research.md)

### QRM7-016 — Context Store Search Observability

**Status:** Open (filed 2026-05-12)

Add a dedicated `/app/logs/context-search-{startupTimestamp}.jsonl` stream that captures every `context_query mode=search` invocation in full detail — verbatim query, scope/id filters, hybrid vs BM25-only engine choice, top hits with scores and snippets, token-budget truncation flag, round-trip duration, error surface. The existing one-line debug entry in the main MCP log becomes a breadcrumb carrying a `queryId` UUID linking back to the detailed record. Capture seam: optional `onTrace` callback on `ContextStore.search()` keeps the public API `ContextItem[]` unchanged. Purpose: make context-search quality auditable offline (silent BM25 fallback, bad relevance, budget-driven truncation) and enable feeding the stream directly into a future relevance-eval script.

**Touches:** `libs/common/src/context-store/context-store.abstract.ts`, `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts`, `apps/mcp-server/src/context-store/in-memory-store.ts`, new `apps/mcp-server/src/observability/context-search-trace-logger.service.ts`, `apps/mcp-server/src/mcp/mcp.service.ts`, spec files, `docs/context-store.md`, `tools/session-report/SESSION-REPORT.md`

**Depends on:** —

**Full ticket:** [QRM7-016](QRM7-016-context-search-observability.md)

### QRM7-017 — Long-Poll Continuation Implementation

**Status:** Open (filed 2026-05-13)

Implements the long-poll continuation pattern designed in QRM7-015 (research, accepted). When the moderator calls `invoke_agent` targeting a role whose `ROLE_TIMEOUTS` exceeds 270 s, the server races the broker's delivery against a 4 min 30 s server timer. If the timer wins, the server stores the in-flight invocation in a new `InvocationResultStore` and returns `{ status: "pending", invocationId }`. The moderator calls `wait_invocation(invocationId)` — a new MCP tool — to continue waiting, repeating until the result lands. Sub-5-min calls have zero overhead. Agent-to-agent calls are unaffected.

Single ticket covering: `InvocationResultStore`, `invoke_agent` racing logic, `wait_invocation` MCP tool, caller-aware policy (moderator-only), `callerRole` auto-bind sidecar (~10 lines), CLAUDE.md rule.

**Touches:** `apps/mcp-server/src/mcp/mcp.service.ts`, `apps/mcp-server/src/mcp/mcp.controller.ts`, new `apps/mcp-server/src/messaging/invocation-result-store.ts`, `apps/mcp-server/src/messaging/role-timeouts.ts` (read-only ref), `CLAUDE.md`, spec files

**Depends on:** QRM7-015 (research, accepted), QRM7-014 (done — keepalive infrastructure)

**Full ticket:** [QRM7-017](QRM7-017-long-poll-continuation-implementation.md)

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
QRM7-011 (CC CLI POST-Only Liveness)  ─── SUPERSEDED by QRM7-012 (closed 2026-05-09 — premise falsified)
QRM7-012 (SSE-Stream-Death Reaping)   ─── independent (open 2026-05-09; A reverts 011-B's effective regression)
QRM7-013 (Moderator OAuth Refresh)    ─── after QRM7-007 (DONE) — open
QRM7-014 (Live SSE Response Signal)   ─── after QRM7-012 (DONE 2026-05-10)
QRM7-015 (Long-Call Delivery Research)─── after QRM7-014 (research, open) — implementation ticket TBD
QRM7-016 (Context Search Observability) ─── independent (open 2026-05-12)
QRM7-017 (Long-Poll Continuation)      ─── after QRM7-015 + QRM7-014 (open 2026-05-13)
```

QRM7-001, QRM7-002, QRM7-004, QRM7-007, and QRM7-009 are complete. QRM7-003 is closed (superseded by QRM7-004). QRM7-010 and QRM7-011 are both closed via supersession on the same operational bug — the moderator-reap regression. QRM7-012 carries the bug forward with the corrected mechanism: CC CLI opens SSE on init, QRM7-011-B's exemption is dead code, and `Session not found` reproduces on any SSE-stream death plus 2 min of POST silence. QRM7-008 is the remaining post-QRM7-001 cluster member: hardens the agent-side retry path for residual failures (real mcp-server restart, container crash) — much lower frequency now that QRM7-009 has eliminated the dominant trigger.

**Recommended sequencing (by operational impact, given current state):**

1. ~~**QRM7-011** Candidate A (timeout bump)~~ — ✅ DONE then reverted 2026-05-09 under the false belief that B subsumed it. **QRM7-012 Candidate A re-applies it as the immediate hotfix** — the only mitigation that ever actually worked.
2. ~~**QRM7-009** (scope reaper)~~ — ✅ DONE 2026-05-09. Eliminates 9 spurious agent reconnects/burst that the QRM8 design run captured; immediately quiets log signal-to-noise.
3. ~~**QRM7-011** Candidate B (POST-only exemption)~~ — ✅ Code landed 2026-05-09 but is dead in the running bundle (sticky-true `hasOpenedSse` flips before role binds). **Replaced by QRM7-012 Candidate B** (live-SSE-response signal).
4. ~~**QRM7-012** Candidate B′~~ — ✅ DONE 2026-05-10 as [QRM7-014](QRM7-014-candidate-b-prime-live-sse-response-signal.md). Replaces dead `hasOpenedSse` with `activeSseToken` identity-guarded tracking; correctness cleanup on top of Candidates A + E.
5. **QRM7-013** (moderator OAuth refresh) — high daily-use friction (5 user-visible 401s per ~47h session). Hotfix via `claude setup-token` long-lived token. Blocks any "always-on" QRM8 scenario; one-time setup + compose/entrypoint edits.
6. **QRM7-012** Candidate D (SSE-stream-death investigation) — research task. Refocused QRM7-011-C: not "why does CC CLI never open SSE" (it does) but "why does the SSE stream die mid-session." Carries forward QRM7-010 Part 3 instrumentation draft.
7. **QRM7-015** (long-call delivery — research) — accept the long-poll continuation design, then file the implementation ticket. Unblocks reliable >5-min `invoke_agent` calls (developer/architect/qa long work) without duplicate-invocation recovery thrash.
8. **QRM7-008** (agent retry race) — hardens the residual-trigger path that 009 cannot eliminate (real mcp-server restart, container crash). Lower urgency now that 009 ships but still needed for correctness.
9. ~~**QRM7-004** (cwd fix)~~ — ✅ DONE 2026-05-08. Smallest change, high daily-use improvement, also resolves QRM7-003.
10. ~~**QRM7-002** (schema-first)~~ — ✅ DONE 2026-05-04. Code quality, prevents future silent-strip bugs.
11. **QRM7-016** (context search observability) — observability/tooling. No functional urgency, but high payoff while iterating on OpenSearch tuning and embedding choice. Land alongside or after QRM7-006.
12. **QRM7-006** (unit tests) — CI hardening, can run after any of the above.
13. **QRM7-005** (log adapter) — tooling convenience, no functional urgency.

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
| Moderator's CC CLI client holds stale session ID after long idle (hibernation + continuous-uptime) | Issue 2 in same log + 2026-05-07 evening reproduction | ~~QRM7-010~~ → ~~QRM7-011~~ → QRM7-012 / QRM7-014 |
| Moderator OAuth access token not auto-refreshed across long idle | Issue 1 in same log (5 401s across 47h session) | QRM7-013 |
| `invoke_agent` response lost when target work exceeds CC CLI's 5-min `undici.bodyTimeout` | Recurring QRM5-BUG-003 → QRM7-014 follow-up empirical baseline | QRM7-015 (research) |
| No structured visibility into `context_query mode=search` quality | Context-store iteration, 2026-05-12 | QRM7-016 |

## Icebox Items (Not Scheduled)

The following items from `tickets/ICEBOX.md` remain unscheduled. They are noted here for awareness but are **not** part of the QRM7 scope:

- **Duplicate Invocation Prevention** — idempotency keys / "is agent busy?" query (Icebox #1)
- **Agent Session Resume via Correlation ID** — blocked by upstream SDK issues #247 and #192 (Icebox #3)

## References

- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — predecessor milestone; QRM7 stabilizes the architecture QRM6 delivered
- [QRM6-008-tests.md](QRM6-008-tests.md) — playbook results and deferred unit test rationale
- [ICEBOX.md](ICEBOX.md) — unscheduled technical debt registry
- [docs/system-design.md](../docs/system-design.md) — current system architecture (post-QRM6)
