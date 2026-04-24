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
