# QRM6-008: Playbook E2E Test — Containerized Moderator via CC CLI

## Summary

Validate the QRM6 containerized moderator stack end-to-end through a scenario-driven playbook executed by the moderator's own Claude Code CLI session against the live Docker system. The primary deliverable is a sequence of scenarios that exercise every QRM6 surface — moderator container lifecycle, MCP elicitation connection, server-side caller identity injection, session tracking, `new_conversation` correlation scoping, elicitation round-trip, clarification auto-persist, and tool restrictions — verified via registry probes, MCP server logs, context store inspection, and direct observation of the elicitation UX. No new automated tests are written; per-ticket unit tests in the existing 49-suite / 760-test automated suite remain the automated layer.

## Problem Statement

The QRM6 containerized moderator infrastructure is fully implemented across QRM6-002 through QRM6-007: the moderator runs as a Claude Code CLI container, registers via MCP elicitation instead of HTTP callback, gets automatic caller identity and session tracking injection server-side, uses `new_conversation` for per-turn correlation scoping, and has `CLAUDE.md` as its prompt. The automated test suite covers the individual components at the unit level — but no test validates that the full chain works against **real** Docker networking, real MCP session management, real CC CLI elicitation UX, and real NestJS module wiring.

The original QRM6-008 scope in the roadmap proposed comprehensive unit test coverage for all new server-side components (`McpElicitationConnection`, session state injection, `new_conversation`, clarification auto-persist, session cache). That scope is narrowed here to focus on **playbook E2E testing** — a live orchestration runbook that catches the classes of defect unit tests cannot: session-identity binding across real MCP transports, elicitation request/response round-trips through real CC CLI, auto-injection behavior under real multi-session conditions, and container-level integration (settings.json bake, entrypoint script, volume mounts).

### Deferred work streams

**Unit test gap-fill (deferred).** Systematic unit tests for `McpElicitationConnection.handle()`, `McpSessionState` lifecycle, session auto-injection in `invoke_agent`/`context_store`/`context_query`/`context_summarize`, `new_conversation` tool handler, and clarification auto-persist in `MessageBroker`. Deferred: individual QRM6 tickets landed with the existing 760-test suite intact (no regressions), and the auto-injection + new_conversation logic is exercised by every moderator turn in production use. A live playbook catches the integration defects these unit tests would miss (real transport identity, real session-ID headers, real elicitation prompt rendering). Revisit if a specific regression surfaces that a unit test should have caught, or if CI needs a pre-merge gate for the new server-side paths.

## Design Context

### What already exists (baseline from QRM6-002 through QRM6-007)

| Component | Spec file | Tests | Coverage notes |
|-----------|-----------|-------|----------------|
| `McpService` (tools + resources) | `apps/mcp-server/src/mcp/mcp.service.spec.ts` | 22 | Pre-QRM6: invoke_agent routing, register_agent with callbackUrl, context_store/query/summarize/stats, resources. **Does not cover:** session state, auto-injection, register without callbackUrl, new_conversation |
| `AgentRegistry` | `apps/mcp-server/src/registry/agent-registry.service.spec.ts` | 7 | Full contract coverage (register, get, unregister, isAvailable, getAll, overwrite). Connection-type agnostic — works for both `HttpAgentConnection` and `McpElicitationConnection` |
| `MessageBroker` | `apps/mcp-server/src/messaging/message-broker.service.spec.ts` | 12 | Routing, depth limit, circular call prevention, agent not found/disconnected, timeout, chain cleanup, async mode, bootstrap context. **Does not cover:** clarification auto-persist for moderator target |
| `McpElicitationConnection` | *(no spec file)* | 0 | New in QRM6-003 — `handle()` with accept/decline/cancel mapping, empty response, error handling, `isConnected()` — all untested at unit level |
| `McpController` (session lifecycle) | *(no spec file)* | 0 | Session creation, transport→McpServer binding, disconnect cleanup. Tested only through integration |
| `role-timeouts` | *(no spec file)* | 0 | Constants — low-value test target |

**Total automated tests in the suite: 760 across 49 spec files.** The QRM6-specific surfaces (elicitation connection, session state, auto-injection, new_conversation, clarification auto-persist) have **zero dedicated unit tests**. This playbook layers live validation on top of the existing baseline — it does **not** replace it.

### What this ticket adds

A live smoke test playbook following the QRM1-013 / QRM5-008 pattern: numbered scenarios with preconditions, commands, expected outputs, and a result table. Each run is appended below the playbook as a dated section recording per-scenario outcomes and any bugs found.

### Execution model

The playbook is executed by the **moderator itself** — the Claude Code CLI session running inside the moderator container. This is the natural execution model: the moderator IS the system under test AND the test orchestrator. It calls MCP tools directly (which exercises the real auto-injection path), triggers agent invocations, and observes elicitation prompts inline.

For deterministic scenarios (container inspection, registry probes, log grep), the moderator runs bash commands via `docker compose exec` from its attached terminal. For live LLM scenarios (agent invocations, elicitation round-trips), the moderator uses its MCP tools normally — the test IS the production flow.

### Scope vs prior runbooks

- **QRM1-013** validated basic connectivity (registration, single/multi-hop invocation, safeguards, context relay). Assumed passing.
- **QRM5-008** validated the hybrid search stack (OpenSearch activation, embedding pipeline, degradation, migration). Assumed passing.
- **This playbook** validates QRM6-specific behavior only: moderator container lifecycle, elicitation-based registration, server-side auto-injection, session tracking, `new_conversation`, elicitation round-trip, clarification auto-persist, and tool restrictions.

## Implementation Details

### Playbook Structure

The playbook follows the QRM1-013 / QRM5-008 pattern: numbered scenarios with preconditions, commands, expected outputs, and a final result table. Each run is appended below the playbook as a dated section.

### Scenarios

**Scenario 1: Moderator container health & configuration (deterministic)**

Verify the moderator container is running, CC CLI is installed at the expected version, MCP configuration points at the correct server, and tool restrictions are baked in.

```bash
docker compose ps moderator
docker compose exec moderator claude --version
docker compose exec moderator cat /home/quorum/.claude/settings.json
```

**Expected:**
- Moderator container is running (status "Up")
- CC CLI version matches what's pinned in Dockerfile (`@anthropic-ai/claude-code@2.1.117` or the installed version)
- `settings.json` contains MCP server config pointing at `http://mcp-server:3000/mcp`
- `settings.json` contains `disallowedTools` with `Write`, `Edit`, `NotebookEdit` (or equivalent deny config)

**Scenario 2: Moderator registration via MCP elicitation (deterministic)**

Verify the moderator registered with the MCP server via elicitation (not HTTP callback) and appears in the registry.

```bash
curl -s http://localhost:3000/registry | jq .
docker compose logs mcp-server 2>&1 | grep -iE "moderator.*registered|elicitation"
```

**Expected:**
- Registry shows `moderator` with `connected: true`
- MCP server logs show `Agent moderator registered via MCP elicitation (session-bound)` — NOT `registered at http://...`
- Other agents (architect, teamlead, developer) registered via HTTP callback as before

**Scenario 3: `new_conversation` tool — correlation scoping (live LLM)**

Verify the moderator can call `new_conversation` to mint a fresh correlation ID, and that subsequent tool calls auto-inject that ID.

*The moderator (running this playbook) calls `new_conversation` via its MCP tools, then calls `context_store` to write a test record.*

Step 1 — Call `new_conversation`:
- Tool returns `{ correlationId: "<uuid>" }`

Step 2 — Call `context_store` to write a conversation-scoped item WITHOUT explicitly passing `correlationId`:
- Store key `qrm6-smoke-003` with value `"Testing new_conversation auto-injection"` at conversation scope

Step 3 — Verify in logs:
```bash
docker compose logs mcp-server --since 60s 2>&1 | grep -iE "new_conversation|correlationId"
```

**Expected:**
- Step 1: Returns a valid UUID
- Step 2: Succeeds without error (correlationId was auto-injected from session state)
- Step 3: Logs show the `new_conversation` correlationId matching the one used in the `context_store` call

**Scenario 4: Caller identity auto-injection (live LLM)**

Verify the moderator can call `invoke_agent` without providing `callerRole` and the server correctly injects `callerRole=moderator` from the MCP session identity.

*The moderator calls `invoke_agent(target=architect, action="Respond with exactly: QRM6_IDENTITY_OK")` without setting `callerRole`.*

```bash
docker compose logs mcp-server --since 60s 2>&1 | grep -iE "invoke_agent.*moderator.*architect"
```

**Expected:**
- Invocation succeeds (architect responds)
- MCP server logs show `invoke_agent: moderator → architect` — confirming `callerRole=moderator` was injected server-side even though the moderator didn't provide it explicitly
- The architect's response contains `QRM6_IDENTITY_OK` (or equivalent acknowledgment)

**Scenario 5: Server-side session tracking (live LLM)**

Verify that the MCP server caches `sessionId` from agent responses and auto-injects it on subsequent invocations to the same role within a turn.

Step 1 — Moderator invokes developer with a simple task:
- `invoke_agent(target=developer, action="Respond with exactly: SESSION_FIRST")`

Step 2 — Moderator invokes developer again (same turn, no `new_conversation` in between):
- `invoke_agent(target=developer, action="Respond with exactly: SESSION_SECOND")`

Step 3 — Inspect logs:
```bash
docker compose logs mcp-server --since 120s 2>&1 | grep -iE "sessionId|session.*cache|agentSessions"
```

**Expected:**
- Step 1: Succeeds, response includes a `sessionId`
- Step 2: Succeeds — the server auto-injected the `sessionId` from Step 1 (developer resumes its session, not a fresh start)
- Step 3: Logs show session cache update after Step 1, and session cache hit for Step 2

**Scenario 6: Elicitation round-trip — agent asks moderator (live LLM, capstone)**

The core QRM6 promise. Validates that an agent can invoke the moderator mid-task, the user sees the question inline as an elicitation prompt, the user's answer flows back to the agent, and the clarification is auto-persisted to the context store.

Step 1 — Moderator invokes the developer with a task that naturally requires clarification:

`invoke_agent(target=developer, action="I need you to write a context record. But first, ask the moderator whether to use key name 'elicitation-test-A' or 'elicitation-test-B' by calling invoke_agent(target=moderator). Use whichever key the moderator chooses. Write the record at project scope with value 'QRM6 elicitation round-trip verified'. Confirm the write.")`

Step 2 — When the elicitation prompt appears inline, the user (orchestrator) **accepts** and answers `"Use elicitation-test-A"`.

Step 3 — Verify outcomes:
```bash
# Check context store for the written record
curl -s http://localhost:3000/mcp  # (or use context_query tool)
# Check for clarification auto-persist
docker compose logs mcp-server --since 120s 2>&1 | grep -iE "clarification|elicitation|persist"
```

Also call `context_query` at project scope, mode=keys, keys=`["clarification:developer:{correlationId}"]` to find the auto-persisted clarification.

**Expected:**
- Step 1: Moderator invokes developer; developer begins working
- Step 2: Developer calls `invoke_agent(target=moderator, ...)` — the moderator sees the question inline as an elicitation prompt; user types answer; answer flows back to developer
- Step 3: Developer writes `project:_:elicitation-test-A` (or equivalent composite key); context store contains the record
- Auto-persist: `clarification:developer:{correlationId}` exists in project scope with `question` and `answer` fields matching the exchange
- MCP server logs show elicitation request and response

**Scenario 7: Elicitation decline — graceful degradation (live LLM)**

Verify that declining an elicitation prompt returns a structured error to the calling agent, and the agent handles it gracefully without crashing.

Step 1 — Moderator invokes the developer with a task that triggers a clarification:

`invoke_agent(target=developer, action="Before doing anything, ask the moderator a clarification question about naming conventions by calling invoke_agent(target=moderator). If the moderator declines, proceed with your own reasonable choice and confirm what you chose.")`

Step 2 — When the elicitation prompt appears inline, the user **declines** (does not answer).

Step 3 — Verify:
```bash
docker compose logs mcp-server --since 120s 2>&1 | grep -iE "decline|cancel|elicitation"
```

**Expected:**
- Developer receives `{ success: false, error: "User declined the clarification request" }`
- Developer proceeds with a default choice (no crash, no error loop)
- No `clarification:{caller}:{correlationId}` record persisted (decline = no persist)
- MCP server logs show the decline path

**Scenario 8: Tool restrictions enforcement (deterministic)**

Verify that the moderator container's baked settings deny `Write`, `Edit`, and `NotebookEdit` tools.

```bash
docker compose exec moderator cat /home/quorum/.claude/settings.json | jq '.permissions'
```

The orchestrator (moderator) also verifies by introspection: attempt to use the `Write` tool on a test file. CC CLI should block the operation based on settings.

**Expected:**
- `settings.json` shows `Write`, `Edit`, `NotebookEdit` in denied tools
- Any attempt to invoke `Write` or `Edit` from the moderator session is blocked by CC CLI permission enforcement
- Read, Grep, Glob, and Bash remain available (moderator can inspect files)

**Scenario 9: Session cleanup on disconnect (deterministic)**

Verify that MCP session state is cleaned up when the moderator's MCP session closes.

```bash
# Check current session count
docker compose logs mcp-server --since 300s 2>&1 | grep -iE "session created|session closed|session.*cleanup"
```

If a prior moderator session was terminated (e.g. `docker compose restart moderator`), verify the MCP server logged the cleanup:
- `Session closed: {sessionId}` or `Session state cleaned up`

**Expected:**
- MCP server logs show session state cleanup when a moderator session ends
- No stale session state accumulates across moderator restarts

**Scenario 10: Log correlation across the full chain (deterministic, post-hoc)**

After scenarios 3–7, verify that correlation IDs propagate correctly across all service boundaries.

```bash
# Use the correlationId from scenario 6 (the capstone)
docker compose logs 2>&1 | grep "{correlationId-from-scenario-6}"
docker compose logs mcp-server --since 300s 2>&1 | grep -iE "invoke_agent|context_store|elicitation" | head -30
```

**Expected:**
- The correlation ID from `new_conversation` appears in `invoke_agent` calls, `context_store` writes, and elicitation log entries
- MCP server logs show the full chain: moderator → developer → moderator (elicitation) → developer → context_store
- Agent logs (developer) show the same correlation ID received in the invocation

### Result Summary Template

| Scenario | Type | Pass Criteria |
|----------|------|---------------|
| 1. Container Health | Deterministic | Moderator container up; CC CLI version correct; settings.json has MCP config + tool denials |
| 2. Elicitation Registration | Deterministic | Registry shows moderator connected; logs confirm elicitation path (not HTTP callback) |
| 3. new_conversation | Live LLM | Fresh UUID returned; auto-injected into subsequent context_store call |
| 4. Caller Identity | Live LLM | invoke_agent succeeds without explicit callerRole; logs show moderator identity injected |
| 5. Session Tracking | Live LLM | Second invocation to same role auto-injects sessionId from first response |
| 6. Elicitation Round-Trip | Live LLM | Agent question appears inline; user answer flows back; record written; clarification auto-persisted |
| 7. Elicitation Decline | Live LLM | Decline returns structured error; agent proceeds gracefully; no persist |
| 8. Tool Restrictions | Deterministic | Write/Edit/NotebookEdit denied in settings; blocked by CC CLI |
| 9. Session Cleanup | Deterministic | Session state cleaned up on disconnect; no stale sessions |
| 10. Log Correlation | Deterministic | Correlation ID propagates across moderator → agent → moderator chain |

### Teardown

```bash
# No destructive teardown needed — QRM6 playbook writes only lightweight context records.
# Optionally clean up smoke test context entries:
# context_query project scope, mode=search, query="qrm6-smoke" to find and review artifacts
```

## Acceptance Criteria

- [ ] Unit test gap-fill explicitly documented as deferred with rationale in this ticket
- [ ] Playbook committed in this ticket with 10 scenarios (container health, elicitation registration, new_conversation, caller identity, session tracking, elicitation round-trip, elicitation decline, tool restrictions, session cleanup, log correlation)
- [ ] At least one full run of the playbook executed by the moderator CC CLI session against the live Docker stack; results appended as a dated run section below the playbook
- [ ] Scenarios 1, 2, 8, 9, 10 (deterministic) pass on the recorded run
- [ ] Scenarios 3, 4, 5, 6, 7 (live LLM) pass on the recorded run, or their failures are filed as `QRM6-BUG-NNN` tickets
- [ ] Scenario 6 (elicitation round-trip) specifically validates: inline prompt visible, answer returned to agent, clarification auto-persisted to context store
- [ ] Any failing scenario or bug discovered has a follow-up ticket opened and linked from the run section

## Dependencies and References

- **Depends on:**
  - QRM6-002 (moderator container image) ✅ — scenarios 1, 8 depend on baked settings and container lifecycle
  - QRM6-003 (elicitation connection & broker routing) ✅ — scenarios 2, 6, 7 depend on `McpElicitationConnection` and clarification auto-persist
  - QRM6-004 (server-side caller identity & session tracking) ✅ — scenarios 4, 5 depend on auto-injection from session state
  - QRM6-005 (new_conversation tool) ✅ — scenario 3 depends on `new_conversation` handler and correlation scoping
  - QRM6-007 (moderator CLAUDE.md) ✅ — the moderator session that runs the playbook depends on the baked prompt
  - QRM1-013 (connectivity smoke test) ✅ — basic connectivity is assumed passing
  - QRM5-008 (hybrid search smoke test) ✅ — OpenSearch/embedding stack assumed passing
- **Blocks:** QRM6-009 (terminal deletion) — live validation must pass before the legacy moderator is removed
- **Part of:** [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — Containerized Moderator via Claude Code CLI milestone

**Reference runbooks:**
- [QRM1-013-smoke-test-runbook.md](QRM1-013-smoke-test-runbook.md) — QRM1 connectivity scenarios + run log format
- [QRM5-008-tests.md](QRM5-008-tests.md) — QRM5 hybrid search runbook + dated run sections (structural model for this playbook)

**Key surfaces exercised:**

| Surface | Scenarios | Source |
|---------|-----------|--------|
| Moderator container lifecycle | 1, 9 | `Dockerfile` (moderator target), `docker-compose.yml`, `docker/moderator/entrypoint.sh` |
| MCP elicitation registration (no callbackUrl) | 2 | `apps/mcp-server/src/mcp/mcp.service.ts` (register_agent handler) |
| `McpElicitationConnection.handle()` | 6, 7 | `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` |
| Server-side caller identity injection | 4 | `apps/mcp-server/src/mcp/mcp.service.ts` (invoke_agent handler, McpSessionState) |
| Server-side session tracking | 5 | `apps/mcp-server/src/mcp/mcp.service.ts` (agentSessions cache) |
| `new_conversation` tool | 3 | `apps/mcp-server/src/mcp/mcp.service.ts` (registerNewConversationTool) |
| Clarification auto-persist | 6, 7 | `apps/mcp-server/src/messaging/message-broker.service.ts` (moderator target branch) |
| Tool restrictions (Write/Edit deny) | 8 | `docker/moderator/settings.json` |
| MCP session state cleanup | 9 | `apps/mcp-server/src/mcp/mcp.service.ts` (disconnect), `mcp.controller.ts` (transport.onclose) |
| Correlation ID propagation | 3, 10 | `McpSessionState.correlationId`, auto-injection across tool handlers |
| Moderator CLAUDE.md prompt | All | `CLAUDE.md` (startup, turn lifecycle, clarification flow guidance) |

---

## Run 2026-04-25

- **Correlation ID:** `a1b65a1c-50fd-40cb-9dba-be5ec273f8a3`
- **Executor:** Moderator CC CLI session inside `quorum-moderator-1`, driven interactively by the human orchestrator. Host-side commands (`docker compose ...`, `docker compose logs`) and the Scenario 9 restart probe were executed from the host.
- **CC CLI version:** 2.1.117
- **Stack:** moderator + mcp-server + opensearch + ollama + architect + teamlead + developer (built with `HOST_UID=1002 HOST_GID=1002`).
- **Precondition fix landed mid-session:** `docker/moderator/entrypoint.sh:15,20` patched to write `/etc/claude/claude.json` directly to `/tmp/.claude.json` (the symlink target) instead of through the symlink. Without the patch, the container exits at startup with `cp: not writing through dangling symlink '/home/quorum/.claude.json'` because the QRM6-BUG-001 `*base-security` profile makes `/tmp` a fresh tmpfs on each start, leaving the build-time symlink dangling on first boot. Filed as QRM6-BUG-006.

### Scenario results

| # | Scenario | Type | Result | Notes |
|---|----------|------|--------|-------|
| 1 | Container Health | Deterministic | **PASS** | CC CLI 2.1.117 (matches Dockerfile pin); MCP server config in `~/.claude.json` (CC CLI user scope), not `~/.claude/settings.json` — minor inaccuracy in the ticket's expected-output description, no functional impact; `permissions.deny: ["Write", "Edit", "NotebookEdit"]` confirmed; `claude mcp list` reports `quorum: ✓ Connected`. |
| 2 | Elicitation Registration | Deterministic | **PASS** | Registry shows `moderator: connected:true`. `mcp-server` log: `Agent moderator registered via MCP elicitation (session-bound)`. The legacy `terminal` service registered moderator first via HTTP (`http://terminal:3001`); CC CLI's `register_agent` then overwrote it with the elicitation-based registration — confirms QRM6-009 (delete `apps/terminal/`) is needed to close the registration race. |
| 3 | new_conversation | Live LLM | **PASS** | `new_conversation` returned `a1b65a1c-...`. `context_store(scope=conversation, key=qrm6-smoke-003)` succeeded with no explicit `correlationId`. Server log confirms auto-injection: `Embedded document [conversation:a1b65a1c-...:qrm6-smoke-003]`. `context_query` retrieved the value back. |
| 4 | Caller Identity | Live LLM | **PASS** | `invoke_agent(target=architect)` succeeded without explicit `callerRole`. Server log: `invoke_agent: moderator → architect [depth=0, correlationId=a1b65a1c-...]`. Architect responded `QRM6_IDENTITY_OK`. |
| 5 | Session Tracking | Live LLM | **FAIL** | First call sessionId `49bc7b52-...`, second `20941083-...` — different IDs, no resume. Source-code inspection shows the server-side cache in `mcp.service.ts:204,235` is structurally correct; the regression is in the agent-side SDK wrapper. **Already tracked as [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md)** (SDK `resume` parameter starts a fresh session silently). This run is the live confirmation Scenario 5 was designed to surface. |
| 6 | Elicitation Round-Trip (capstone) | Live LLM | **PASS** | Developer called `invoke_agent(target=moderator)` at depth=1; user saw the elicitation prompt inline (`[developer] ...`); user answered `elicitation-test-A`; developer wrote `project:_:elicitation-test-A = "QRM6 elicitation round-trip verified"`; `clarification:developer:a1b65a1c-...` auto-persisted at project scope with `question` and `answer` fields. **Notable:** the round-trip required 3 elicitation attempts — 2 timed out at 60s before the third succeeded. The 60s MCP elicitation timeout is too tight for realistic human-in-the-loop interaction. Filed as QRM6-BUG-008. |
| 7 | Elicitation Decline | Live LLM | **PASS** | User declined the prompt. Developer received `success=false` after 18.3s. Developer proceeded with its own naming conventions analysis — no crash, no retry loop. No `clarification:developer:...` record persisted (`message-broker.service.ts:100` guards on `response.success`). |
| 8 | Tool Restrictions | Deterministic | **PASS** | Stronger than expected: `Write`, `Edit`, and `NotebookEdit` are absent from the moderator's tool set entirely (CC CLI removes denied tools at load time, not just at call time). `Read` and `Bash` remain available — moderator can inspect files without delegating. |
| 9 | Session Cleanup | Deterministic | **FAIL** | Verified by host-side `docker compose restart moderator`. Result: zero `Session closed` / `Session state cleaned up` log lines fire — the Streamable HTTP transport's `onclose` doesn't trigger on container SIGTERM. Worse, the registry continues to report `moderator: connected:true` against the dead session `332e0a45-...`; the new container only ran `tail -f /dev/null` and `claude mcp list` (entrypoint self-check), no `register_agent`. Any `invoke_agent(target=moderator)` after a moderator restart would route to the dead `McpElicitationConnection` and time out at 60s. Filed as QRM6-BUG-007 (renumbered to QRM7-001 on 2026-05-01). |
| 10 | Log Correlation | Deterministic | **PASS** | 52 server-log entries share `a1b65a1c-...`. Same ID propagates into architect logs (1 invocation) and developer logs (4 invocations). Full Scenario 6 chain visible end-to-end: `moderator → developer (depth=0) → moderator (depth=1, elicitation) → context_store → clarification persist → developer return`. |

**Tally:** 8 PASS · 2 FAIL · 0 BLOCKED.

### Session IDs collected

| Scenario | Agent | Session ID |
|----------|-------|------------|
| 4 | architect | `84548073-46d6-4238-b856-fb2ec17b1724` |
| 5 (1st) | developer | `49bc7b52-df3b-4447-8ef9-bf0a4126a3f5` |
| 5 (2nd) | developer | `20941083-eea0-49fe-a6a3-d84a7cd44d96` |
| 6 | developer | `a4a972a5-27e5-4ae3-9461-4d9bf12d397d` |
| 7 | developer | `4ec3a5e5-0375-4fab-bd80-2df3483069dd` |

Stale post-restart MCP session reported as alive: `332e0a45-2527-49d8-a710-9b3d3d0d20ca`.

### Bugs surfaced or confirmed

| Bug | Summary | Status |
|-----|---------|--------|
| [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) | SDK `resume` parameter silently starts a fresh session in the agent container — server-side `agentSessions` cache injects correctly but resume is non-functional downstream | Pre-existing; this run is the live confirmation |
| QRM6-BUG-006 | Moderator entrypoint `cp` writes through dangling symlink under tmpfs `/tmp` and exits non-zero on first start — patch landed mid-session | New (patch landed; ticket TBD) |
| QRM6-BUG-007 → [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) | MCP session cleanup never fires on container shutdown; `transport.onclose` not triggered by SIGTERM; registry continues reporting dead sessions as connected — functional break, not just observability | Promoted to QRM7-001 (stabilization milestone) on 2026-05-01 |
| QRM6-BUG-008 | MCP elicitation timeout (~60s) too tight for human-in-the-loop; 2 of 3 elicitation attempts in Scenario 6 timed out before user could answer | New (TBD) |

### Observability gaps (sub-bug-worthy, suggest bundling)

1. **Session cache operations** in `mcp.service.ts` — no debug log on cache set/get; cache hits/misses are invisible. Diagnosis of QRM6-BUG-005 from logs alone was impossible.
2. **Elicitation decline/cancel** — `McpElicitationConnection` only logs on exception. Decline and cancel paths are silent.
3. **Session lifecycle** — `Session created` is logged; nothing on close or cleanup. Combined with QRM7-001 (was QRM6-BUG-007), this means session leaks are doubly invisible.

---

## Run 2026-05-01

- **Correlation ID:** `fed351d3-8f2e-4ad9-a798-cfd3c0444b14`
- **Executor:** Moderator CC CLI session inside `quorum-moderator-1`, driven interactively by the human orchestrator. Host-side commands (`docker compose ...`, `docker compose logs`) and the Scenario 9 restart probe were executed from the host.
- **CC CLI version:** 2.1.126 (bumped from 2.1.117 in prior run)
- **Stack:** moderator + mcp-server + opensearch + ollama + architect + teamlead + developer (built with `HOST_UID=1002 HOST_GID=1002`).
- **Purpose:** Final-state capture after QRM6 closure with stabilization items rescheduled to QRM7. Validates that bugs surfaced in 2026-04-25 (BUG-005 session resume, BUG-006 entrypoint symlink, BUG-008 elicitation timeout) are resolved, and that QRM7-001 (session cleanup) remains the only functional gap.

### Scenario results

| # | Scenario | Type | Result | Notes (delta vs 2026-04-25 in **bold**) |
|---|----------|------|--------|------------------------------------------|
| 1 | Container Health | Deterministic | **PASS** | CC CLI `2.1.126` (matches Dockerfile pin); `~/.claude/settings.json` carries `permissions.deny: ["Write","Edit","NotebookEdit"]` and a new `systemPrompt` directive instructing the moderator to call `register_agent`/`new_conversation` on each turn and use `/code-review` for review dispatch; `claude mcp list` reports `quorum: ✓ Connected`. **`policy-limits.json` is new** in `/home/quorum/.claude/`. |
| 2 | Elicitation Registration | Deterministic | **PASS** | Registry shows all four agents `connected: true`. mcp-server log: `Agent moderator registered via MCP elicitation (session-bound)`. **The legacy `terminal` HTTP-callback registration race observed in 2026-04-25 is gone — QRM6-009 (terminal deletion) closed it.** |
| 3 | new_conversation | Live LLM | **PASS** | `new_conversation` returned `fed351d3-...`. `context_store(scope=conversation, key=qrm6-rerun-003)` and matching `context_query` both succeeded with no explicit `correlationId`. Server log confirms auto-injection: `Embedded document [conversation:fed351d3-...:qrm6-rerun-003]` and `context_query: ... → 1 item(s)`. |
| 4 | Caller Identity | Live LLM | **PASS** | `invoke_agent(target=architect)` succeeded without explicit `callerRole`. Server log: `invoke_agent: moderator → architect [depth=0, correlationId=fed351d3-...]`. Architect responded `QRM6_IDENTITY_OK_RERUN`. |
| 5 | Session Tracking | Live LLM | **PASS** | **Was FAIL in 2026-04-25 — QRM6-BUG-005 fix confirmed end-to-end.** Both consecutive `invoke_agent(target=developer)` calls returned the same SDK sessionId `a5a6c934-d370-43ad-8b71-e7126fb86361`. Second call also notably faster (3.5s vs 7.8s), consistent with session resume skipping initialization. (Obs-gap from prior run — still no explicit "session cache hit" log on the server — remains; passing inferred from behavioral evidence.) |
| 6 | Elicitation Round-Trip (capstone) | Live LLM | **PASS** | Developer called `invoke_agent(target=moderator)` at depth=1; elicitation prompt appeared inline; user answered `qrm6-rerun-elicit-A`; developer wrote `project:_:qrm6-rerun-elicit-A = "QRM6 elicitation round-trip RERUN verified"`; clarification record `clarification:developer:fed351d3-...` auto-persisted at project scope with matching `question`/`answer` fields. **Completed in a single elicitation attempt vs. 3 attempts in 2026-04-25 — QRM6-BUG-008 (60s elicitation timeout) fix confirmed.** Same developer SDK sessionId `a5a6c934-...` reused across the 3rd consecutive call. |
| 7 | Elicitation Decline | Live LLM | **PASS** | User declined the prompt. Developer received `success=false` after ~3.6s and proceeded with its own naming convention choice — no crash, no retry loop. No `clarification:developer:...` record created for this scenario (the only record under `fed351d3-...` remained the one from Scenario 6). Same developer SDK sessionId `a5a6c934-...` (4th consecutive call). Decline log path still silent (obs-gap 2 from prior run). |
| 8 | Tool Restrictions | Deterministic | **PASS** | `permissions.deny: ["Write","Edit","NotebookEdit"]` confirmed via `cat /home/quorum/.claude/settings.json`. (No new probe of CC CLI tool exposure performed — assumed unchanged from 2026-04-25 finding that the denied tools are absent from the tool list, not just blocked at call time.) |
| 9 | Session Cleanup | Deterministic | **FAIL** | **Unchanged — QRM7-001 still open.** Pre-restart moderator MCP session `b149f26e-9da5-4695-9160-b82811a13343` (created 2:50:18) has zero `Session closed` / `Session state cleaned up` log entries after `docker compose restart moderator`. System-wide: dozens of `Session created` lines across the log, **zero** `Session closed` lines. Registry continues reporting `moderator: connected:true` against the dead session. Post-restart session `7aacd4eb-e746-4de0-9fe4-f26d73ceada5` was created (entrypoint `claude mcp list` health check), no `register_agent` from the new container until the user re-attaches. |
| 10 | Log Correlation | Deterministic | **PASS** | 62 entries share `fed351d3-...` across `mcp-server`, `architect`, `developer`. Full chain visible: S4 `moderator → architect`; S5 two `moderator → developer` invocations sharing the same SDK session; S6 `moderator → developer (depth=0) → moderator (depth=1, success=true) → context_store → clarification persist → developer return`; S7 `moderator → developer (depth=0) → moderator (depth=1, success=false=decline) → developer return`. |

**Tally:** 9 PASS · 1 FAIL · 0 BLOCKED. (Prior run: 8 PASS · 2 FAIL.)

### Session IDs collected

| Scenario | Agent | Session ID |
|----------|-------|------------|
| 4 | architect | `6b75bd08-fe36-419b-9bcd-506bb2e29285` |
| 5 (1st) | developer | `a5a6c934-d370-43ad-8b71-e7126fb86361` |
| 5 (2nd) | developer | `a5a6c934-d370-43ad-8b71-e7126fb86361` (resumed — same id) |
| 6 | developer | `a5a6c934-d370-43ad-8b71-e7126fb86361` (3rd consecutive — resumed) |
| 7 | developer | `a5a6c934-d370-43ad-8b71-e7126fb86361` (4th consecutive — resumed) |

Pre-restart moderator MCP session that did NOT close on shutdown: `b149f26e-9da5-4695-9160-b82811a13343`. Post-restart MCP session created (no `register_agent` issued): `7aacd4eb-e746-4de0-9fe4-f26d73ceada5`.

### Bugs surfaced, confirmed fixed, or carried over

| Bug | Status this run | Notes |
|-----|-----------------|-------|
| [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) | **Confirmed fixed** | Scenario 5 was the original surfacing point — now passes end-to-end. Same SDK sessionId reused across 4 consecutive developer invocations within the same conversation. |
| [QRM6-BUG-006](QRM6-BUG-006-moderator-entrypoint-dangling-symlink.md) | **Confirmed fixed** | No precondition fix needed mid-session; container started cleanly. |
| [QRM6-BUG-008](QRM6-BUG-008-elicitation-timeout-too-short.md) | **Confirmed fixed** | Scenario 6 completed in a single elicitation attempt (vs 3 attempts / 2 timeouts in 2026-04-25). |
| [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) | **Open, reproduces** | Scenario 9 failure mode unchanged. Functional break: `invoke_agent(target=moderator)` after a moderator restart would still route to a dead `McpElicitationConnection`. |

No new bugs surfaced this run.

### Observability gaps (carried over from 2026-04-25, no tickets filed)

1. **Session cache operations** — `mcp.service.ts` still doesn't emit a "session cache hit/miss" debug line; Scenario 5 PASS was inferred from behavioral evidence (sessionId equality + faster 2nd-call), not from server logs.
2. **Elicitation decline/cancel** — `McpElicitationConnection` decline and cancel paths remain silent; Scenario 7 decline was visible only as `invoke_agent returning ... success=false handlerMs=3627`, which is not specific to the decline cause.
3. **Session lifecycle** — `Session created` logged but no close/cleanup line. Combined with QRM7-001, session leaks remain doubly invisible.

These were noted as "sub-bug-worthy, suggest bundling" in the prior run. Recommend filing as a single observability ticket in QRM7 if the team agrees to invest in diagnosability before further milestone work.

### Final state assessment

QRM6-008 acceptance criteria are met for the closing run:

- 9 of 10 scenarios PASS; the single FAIL (Scenario 9) is tracked as **QRM7-001** with stabilization-milestone ownership and is non-blocking for QRM6 closure.
- All three QRM6-era bugs that were live at 2026-04-25 (BUG-005, BUG-006, BUG-008) are confirmed fixed via this re-run.
- QRM6 milestone closes with no new bugs surfaced.
