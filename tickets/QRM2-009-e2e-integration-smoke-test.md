# QRM2-009: E2E Integration Smoke Test

## Summary

End-to-end validation of the QRM2 milestone in Docker: a moderator-initiated task triggers agent collaboration that produces observable code changes in the shared workspace. Verifies the full QRM2 stack — hardened containers, Claude Code SDK execution, MCP orchestration tool bridge, role permission enforcement, updated prompts, and log tracing — in a single integrated run. Delivers a smoke test runbook and extends the existing QRM1 test infrastructure (`POST /test/invoke`, `GET /registry`) for QRM2-specific verification.

## Problem Statement

QRM2-001 through QRM2-008 replaced the agent runtime: agents moved from raw Anthropic SDK tool loops ("brains in jars") to Claude Code instances with real filesystem access, bash execution, and git operations — all inside hardened containers. Each ticket was individually verified with unit tests (407+ tests across 36 suites), but the integrated system has never been validated as a whole. The QRM2 milestone's success criterion — "a moderator-initiated task produces observable code changes in the workspace" — is currently unverified.

Several integration surfaces exist only at the seams between components and cannot be covered by unit tests:

- **Claude Code SDK subprocess lifecycle in Docker.** `ClaudeCodeService` spawns `claude` as a subprocess via `query()`. The agent image (bookworm-slim, non-root `quorum` user, dropped capabilities, read-only rootfs, tmpfs mounts) imposes constraints that don't exist in unit tests. QRM2-BUG-001 through QRM2-BUG-003 already demonstrated that SDK subprocess spawning, PATH resolution, and UID mapping break in unexpected ways under container hardening.

- **MCP tool bridge under SDK execution.** The tool bridge (`McpToolBridgeService.createBridge()`) exposes orchestration tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) as Claude Code custom tools via `createSdkMcpServer()`. In unit tests, bridge creation is mocked. In the real system, the bridge must correctly proxy through `McpClientService.callTool()` to the MCP server over the Docker network, with auto-augmented parameters (correlationId, callerRole, depth) surviving the proxy chain.

- **Permission enforcement end-to-end.** `RolePermissionService` provides `disallowedTools` and `canUseTool` guard hooks to the SDK. Unit tests confirm the hook logic, but E2E validates that a real Claude Code session actually respects the restrictions — that the architect cannot `git commit`, that the developer cannot `rm -rf /`, and that `AskUserQuestion` is truly blocked for all agents.

- **Workspace file operations across agents.** Agents share `/mnt/quorum/workspace` via a bind-mounted volume. One agent's file writes must be visible to another agent's file reads. The workspace volume must be writable despite `read_only: true` rootfs. File ownership must align between the container's `quorum` user (host UID/GID via build args) and the host filesystem.

- **Prompt-driven behaviour.** QRM2-007 updated prompts to describe workspace conventions, tool capabilities, and the autonomous clarification pattern. The prompts instruct agents to read `quorum.md`, use the Context Store, and route clarifications via `invoke_agent`. E2E validates that agents actually follow these instructions in practice — that the prompted behaviour results in correct tool usage patterns.

- **Log correlation across the full stack.** QRM1-012's runbook verified correlation IDs in broker logs and invocation handler logs. QRM2 adds SDK session metadata (`sessionId`, `durationMs`, `totalCostUsd`, `numTurns`) to invocation logs. E2E validates that a complete request chain — from moderator through MCP broker to agent SDK session — produces traceable, correlated log output.

## Design Context

### Relationship to QRM1-012

QRM1-012 established the smoke test infrastructure: `GET /registry` (agent registration status), `POST /test/invoke` (deterministic broker safeguard testing), and the runbook pattern (sequential scenarios with deterministic + live LLM categorisation). QRM2-009 builds on this:

| QRM1-012 Contribution | QRM2-009 Usage |
|------------------------|----------------|
| `GET /registry` endpoint | Reused — verify all agents register |
| `POST /test/invoke` endpoint | Reused — deterministic safeguard checks |
| Runbook format | Extended — same sequential structure, new scenarios |
| Smoke test runbook (`QRM1-013`) | Superseded — QRM2 runbook covers all QRM1 scenarios plus new ones |

The QRM2 runbook is a **superset** of the QRM1 runbook. It replaces QRM1-013, not supplements it — running the QRM2 runbook validates everything QRM1 tested plus the new QRM2 surfaces.

### Test Scenario Design

Scenarios are grouped into three categories:

**Tier 1 — Infrastructure (deterministic, no LLM).** These validate the container environment and communication plumbing without API costs. They use `curl`, `docker compose exec`, and the `POST /test/invoke` endpoint.

**Tier 2 — Agent capabilities (live LLM, single agent).** These invoke a single agent via `POST /invoke` and verify that Claude Code tools work correctly inside the container. Each scenario targets a specific QRM2 feature (SDK execution, permission enforcement, workspace file ops).

**Tier 3 — Multi-agent collaboration (live LLM, multi-agent).** These test the full orchestration loop: moderator → agent → workspace changes. These are the most expensive and non-deterministic but directly validate the QRM2 success criterion.

### Scenario Overview

| # | Scenario | Tier | Category | What It Validates |
|---|----------|------|----------|-------------------|
| 1 | Service Health | 1 | Deterministic | MCP server running, health endpoint |
| 2 | Agent Registration | 1 | Deterministic | All agents register (architect, teamlead, developer, moderator) |
| 3 | Container Security Posture | 1 | Deterministic | Non-root user, no sudo, dropped caps, read-only rootfs |
| 4 | CC Toolchain Availability | 1 | Deterministic | git, rg, bash, curl, jq present in agent containers |
| 5 | Workspace Volume Writable | 1 | Deterministic | Agent can write/read files in `/mnt/quorum/workspace` despite read-only rootfs |
| 6 | Safeguard — Unavailable Role | 1 | Deterministic | Broker rejects invocation for undeployed role (qa) |
| 7 | Safeguard — Depth Limit | 1 | Deterministic | Broker rejects invocation at max call depth |
| 8 | Single-Agent SDK Execution | 2 | Live LLM | Claude Code processes a task and returns a result via `InvocationHandler` |
| 9 | Workspace File Creation | 2 | Live LLM | Agent creates a file in workspace; file exists on host |
| 10 | Context Store Relay | 2 | Live LLM | Agent stores value; different agent retrieves it |
| 11 | Permission Enforcement — Write Path | 2 | Live LLM | Architect writes to `docs/` (allowed) but cannot write to `src/` (denied by `canUseTool`) |
| 12 | Multi-Agent Task — Code Generation | 3 | Live LLM | Moderator-initiated task: architect designs → developer implements → file appears in workspace |
| 13 | Log Correlation | 1 | Deterministic (post-hoc) | Correlation IDs and SDK metadata in cross-service logs |

### quorum.md for Smoke Test

The smoke test workspace needs a `quorum.md` that provides enough project context for agents to complete the test scenarios. This is a minimal, purpose-built config — not a real project. It lives in the runbook as inline content to be written to the workspace before running live LLM scenarios.

```markdown
# Quorum E2E Smoke Test

## Description
This is a smoke test workspace for validating the Quorum multi-agent system.
Agents should create files in this workspace to verify end-to-end functionality.

## Constraints
- Keep all generated code in the `smoke-test/` subdirectory
- Use TypeScript for any code files
- Do not modify existing files outside `smoke-test/`
```

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Smoke test runbook (`tickets/QRM2-010-smoke-test-runbook.md`) | Automated CI test suite or test harness |
| All 13 scenarios covering Tiers 1-3 | Performance benchmarks or load testing |
| `quorum.md` smoke test config (inline in runbook) | Production deployment runbook |
| Verification of container security posture | AppArmor/seccomp profile validation |
| Verification of workspace file operations | Multi-workspace or multi-repo scenarios |
| Verification of permission enforcement (write paths) | Exhaustive permission matrix testing for every role |
| Verification of SDK metadata in logs | Log aggregation or external monitoring setup |
| No code changes to the application | New endpoints, modules, or test infrastructure |

### Key Difference from QRM1-012

QRM1-012 created new code (RegistryController, TestController, TestModule) alongside the runbook. QRM2-009 produces **only the runbook** — all necessary test infrastructure already exists from QRM1-012. The existing `GET /registry`, `POST /test/invoke`, and `POST /invoke` endpoints are sufficient. No application code changes are needed.

## Implementation Details

### Runbook Structure

The runbook follows the QRM1-013 format: prerequisites, sequential scenarios, teardown, and result summary table. Each scenario includes the exact bash commands to run, expected output, and pass/fail criteria.

Location: `tickets/QRM2-010-smoke-test-runbook.md`

### Tier 1 Scenarios (Deterministic)

**Scenario 1 — Service Health:** Identical to QRM1-013 Scenario 1. `curl -s http://localhost:3000/health` → `{ "status": "ok" }`.

**Scenario 2 — Agent Registration:** Same endpoint as QRM1-013 Scenario 2. `curl -s http://localhost:3000/registry | jq .` → 4 agents (architect, teamlead, developer, moderator), all connected.

**Scenario 3 — Container Security Posture:** Run commands inside an agent container to verify hardening:

```bash
docker compose exec architect whoami          # → quorum
docker compose exec architect id              # → uid=1000(quorum) gid=1000(quorum)
docker compose exec architect sh -c 'sudo ls 2>&1 || echo "no sudo"'  # → no sudo / command not found
docker compose exec architect sh -c 'cat /proc/1/status | grep -i capeff'  # → CapEff: 0000000000000000
docker compose exec architect sh -c 'touch /test-readonly 2>&1 || echo "read-only"'  # → read-only
```

Validates QRM2-001 acceptance criteria in the integrated system.

**Scenario 4 — CC Toolchain Availability:** Verify Claude Code's required binaries exist:

```bash
docker compose exec architect git --version   # → git version 2.x.x
docker compose exec architect rg --version    # → ripgrep 13.x.x
docker compose exec architect bash --version  # → GNU bash 5.x.x
docker compose exec architect curl --version  # → curl 7.x.x
docker compose exec architect jq --version    # → jq-1.x
```

**Scenario 5 — Workspace Volume Writable:** Confirm agents can write to the workspace despite `read_only: true` rootfs:

```bash
docker compose exec architect sh -c 'echo "test" > /mnt/quorum/workspace/.smoke-test-write && cat /mnt/quorum/workspace/.smoke-test-write && rm /mnt/quorum/workspace/.smoke-test-write'
```

Expected: `test` printed, file created and cleaned up. If this fails, volume permissions are misconfigured.

**Scenario 6 — Unavailable Role:** Identical to QRM1-013 Scenario 5. `POST /test/invoke` with `target: qa` → `Agent qa not registered`.

**Scenario 7 — Depth Limit:** Identical to QRM1-013 Scenario 6. `POST /test/invoke` with `depth: 5` → `Max call depth (5) exceeded`.

### Tier 2 Scenarios (Live LLM, Single Agent)

**Scenario 8 — Single-Agent SDK Execution:** The foundational live test — verifies that `InvocationHandler` → `ClaudeCodeService.execute()` → Claude Code subprocess → result works end-to-end inside the container. This is the scenario most likely to uncover SDK subprocess issues (QRM2-BUG-001/002/003 class of bugs).

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-qrm2-001',
      caller: 'moderator',
      target: 'architect',
      action: 'Respond with exactly: QRM2_SDK_OK',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

Expected: `{ "success": true, "result": "..." }` where result contains `QRM2_SDK_OK`. Verify logs contain `sessionId` and `correlationId`:

```bash
docker compose logs architect 2>&1 | grep smoke-qrm2-001
```

**Scenario 9 — Workspace File Creation:** Verify an agent can use Claude Code's `FileWrite` tool to create a file in the shared workspace:

```bash
docker compose exec mcp-server node -e "
  fetch('http://developer:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-qrm2-002',
      caller: 'moderator',
      target: 'developer',
      action: 'Create a file at /mnt/quorum/workspace/smoke-test/hello.ts with the content: export const message = \"QRM2_SMOKE_OK\";',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

Post-verification — file exists and has correct content (check from host or another container):

```bash
docker compose exec architect cat /mnt/quorum/workspace/smoke-test/hello.ts
```

Expected: File contains `export const message = "QRM2_SMOKE_OK";`. This validates workspace volume sharing (developer writes, architect reads) and Claude Code `FileWrite` tool execution.

**Scenario 10 — Context Store Relay:** Same pattern as QRM1-013 Scenario 4 but validates that the MCP tool bridge (QRM2-003) correctly proxies `context_store` and `context_query` calls from inside Claude Code sessions. Store with architect, retrieve with developer using `correlationId: 'smoke-qrm2-003'`. Expected: developer retrieves the value `QRM2-CONTEXT-PASS` stored by architect.

**Scenario 11 — Permission Enforcement (Write Path):** Ask the architect to write a file to `docs/` (allowed by role permission profile) and then attempt to write to `src/` (denied by `canUseTool` write path guard):

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-qrm2-004',
      caller: 'moderator',
      target: 'architect',
      action: 'First, create the file /mnt/quorum/workspace/docs/smoke-test-arch.md with content \"# Smoke Test\". Then try to create /mnt/quorum/workspace/src/forbidden.ts with content \"// should fail\". Report what happened for each attempt.',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

Expected: `docs/smoke-test-arch.md` is created successfully. The `src/forbidden.ts` write is denied by the permission guard, and the agent reports the denial. Post-verification:

```bash
docker compose exec architect cat /mnt/quorum/workspace/docs/smoke-test-arch.md  # → "# Smoke Test"
docker compose exec architect ls /mnt/quorum/workspace/src/forbidden.ts 2>&1      # → No such file
```

This validates QRM2-005 permission profiles and QRM2-006 `canUseTool` integration.

### Tier 3 Scenarios (Live LLM, Multi-Agent)

**Scenario 12 — Multi-Agent Task (Code Generation):** The headline scenario — directly validates the QRM2 success criterion. The moderator initiates a task that requires agent collaboration producing workspace changes.

This scenario requires writing `quorum.md` to the workspace first (see "quorum.md for Smoke Test" above), then invoking the moderator's orchestration through a crafted architect → developer pipeline.

**Step 1 — Architect designs:**
```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-qrm2-005',
      caller: 'moderator',
      target: 'architect',
      action: 'Design a simple TypeScript utility module at /mnt/quorum/workspace/smoke-test/utils.ts that exports a function called greet(name: string): string which returns a greeting message. Store your design decision (function signature and return format) in the context store at conversation scope with key \"greet-design\". Then create a brief design doc at /mnt/quorum/workspace/docs/smoke-test-design.md describing your design.',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Step 2 — Developer implements:**
```bash
docker compose exec mcp-server node -e "
  fetch('http://developer:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-qrm2-005',
      caller: 'moderator',
      target: 'developer',
      action: 'Query the context store for the key \"greet-design\" at conversation scope (correlationId: smoke-qrm2-005) to get the architects design. Then implement the greet utility at /mnt/quorum/workspace/smoke-test/utils.ts according to the design. Also create a simple test file at /mnt/quorum/workspace/smoke-test/utils.test.ts.',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Post-verification:**
```bash
# Design doc exists (architect output)
docker compose exec architect cat /mnt/quorum/workspace/docs/smoke-test-design.md

# Implementation exists (developer output)
docker compose exec developer cat /mnt/quorum/workspace/smoke-test/utils.ts

# Test file exists (developer output)
docker compose exec developer cat /mnt/quorum/workspace/smoke-test/utils.test.ts
```

Expected:
- `docs/smoke-test-design.md` — contains a design description authored by the architect
- `smoke-test/utils.ts` — contains a `greet` function implementation by the developer
- `smoke-test/utils.test.ts` — contains test cases for the `greet` function

This validates the full pipeline: SDK execution (QRM2-002, QRM2-006), MCP tool bridge (QRM2-003), permission profiles (architect writes to `docs/`, developer writes anywhere), prompt-driven behaviour (QRM2-007), and cross-agent context sharing.

### Scenario 13 — Log Correlation (Post-Hoc)

After running Tier 2-3 scenarios, verify that correlation IDs and SDK metadata appear across service logs:

```bash
# SDK execution metadata (sessionId, cost, turns) in agent logs
docker compose logs architect 2>&1 | grep -E 'smoke-qrm2-001.*sessionId'

# Cross-service correlation for multi-agent scenario
docker compose logs 2>&1 | grep smoke-qrm2-005
```

Expected: Correlation ID `smoke-qrm2-005` appears in MCP server logs (broker routing) and both architect and developer logs (invocation handling). Agent logs include SDK metadata (`sessionId`, `durationMs`, `totalCostUsd`, `numTurns`).

### Workspace Cleanup

The runbook includes a cleanup section that removes smoke test artifacts from the workspace:

```bash
docker compose exec developer rm -rf /mnt/quorum/workspace/smoke-test /mnt/quorum/workspace/docs/smoke-test-arch.md /mnt/quorum/workspace/docs/smoke-test-design.md
docker compose down
```

### Runbook Run Tracking

The runbook includes an empty "Runs" section at the end for recording results, matching the QRM1-013 pattern. Each run gets a date header, pre-run fixes (if any), result table, and bugs found (if any). This historical record is critical — QRM1-013's run history revealed three bugs (BUG-001, BUG-002, BUG-003) that were invisible to unit tests.

## Acceptance Criteria

- [ ] `tickets/QRM2-010-smoke-test-runbook.md` created with all 13 scenarios
- [ ] Tier 1 scenarios (1-7) are fully deterministic — no API key required
- [ ] Tier 2 scenarios (8-11) each target a specific QRM2 feature (SDK, workspace, context, permissions)
- [ ] Tier 3 scenario (12) validates the QRM2 success criterion: multi-agent task → workspace code changes
- [ ] Scenario 3 validates container security posture (non-root, no sudo, dropped caps, read-only rootfs)
- [ ] Scenario 9 validates workspace file creation via Claude Code `FileWrite` tool
- [ ] Scenario 11 validates permission enforcement via `canUseTool` write path guard
- [ ] Scenario 12 validates cross-agent collaboration: architect designs + stores context → developer retrieves context + implements
- [ ] Scenario 13 validates SDK metadata (`sessionId`, `durationMs`, `totalCostUsd`, `numTurns`) in agent logs
- [ ] Runbook includes inline `quorum.md` content for the smoke test workspace
- [ ] Runbook includes workspace cleanup section
- [ ] Runbook includes empty "Runs" section for result tracking
- [ ] No application code changes required — only the runbook file is created
- [ ] `npm run build` compiles successfully (no regressions)
- [ ] `npm run lint` passes (no regressions)
- [ ] `npm run test` passes (all existing tests — no new tests added)

## Dependencies and References

### Prerequisites
- **QRM2-001** — Docker Agent Image (hardened containers, CC toolchain, non-root user)
- **QRM2-006** — InvocationHandler Migration (agents use `ClaudeCodeService.execute()`)
- **QRM2-007** — Prompt Adaptation (agents instructed on workspace conventions, tools, clarification routing)

### What This Blocks
- QRM2 milestone completion — this ticket provides the final integrated validation

### References
- QRM1 smoke test runbook: `tickets/QRM1-013-smoke-test-runbook.md` (pattern reference + run history)
- QRM1 smoke test ticket: `tickets/QRM1-012-e2e-connectivity-smoke-test.md` (infrastructure created)
- Dockerfile (agent target): `Dockerfile:39-68`
- Docker Compose: `docker-compose.yml` (agent security anchor, volume mounts, service definitions)
- InvocationHandler: `apps/agent/src/connection/invocation-handler.service.ts`
- ClaudeCodeService: `apps/agent/src/llm/claude-code.service.ts`
- McpToolBridgeService: `apps/agent/src/connection/mcp-tool-bridge.service.ts`
- RolePermissionService: `apps/agent/src/config/role-permission.service.ts`
- Role prompt templates: `libs/common/src/prompts/role-prompt-templates.ts`
- Terminal ChatService: `apps/terminal/src/chat/chat.service.ts`
- Registry endpoint: `apps/mcp-server/src/registry/registry.controller.ts`
- Test endpoint: `apps/mcp-server/src/testing/test.controller.ts`
- QRM2-000 roadmap: `tickets/QRM2-000-roadmap.md` (line 76-79)
- QRM2-BUG tickets: `tickets/QRM2-BUG-001-*.md`, `QRM2-BUG-002-*.md`, `QRM2-BUG-003-*.md` (prior SDK subprocess bugs)

---

## Runs

### Run 1 — 2026-03-14

**Pre-run fixes:** Docker daemon restarted to resolve agent network connectivity to LLM API. Scenarios 6-7 payloads corrected (missing required fields `correlationId`, `caller`, `wait`).

| # | Scenario | Tier | Result | Notes |
|---|----------|------|--------|-------|
| 1 | Service Health | 1 | **PASS** | `{"status":"ok"}` |
| 2 | Agent Registration | 1 | **PASS** | 4 agents (moderator, teamlead, developer, architect), all connected |
| 3 | Container Security Posture | 1 | **PASS** | user=`quorum` uid=1002 gid=1002, no sudo (`sh: 1: sudo: not found`), CapEff=`0000000000000000`, read-only rootfs |
| 4 | CC Toolchain Availability | 1 | **PASS** | git 2.39.5, rg 13.0.0, bash 5.2.15, curl 7.88.1, jq 1.6 |
| 5 | Workspace Volume Writable | 1 | **PASS** | Write/read/delete succeeded despite `read_only: true` rootfs |
| 6 | Unavailable Role | 1 | **PASS** | `"Agent qa not registered"` |
| 7 | Depth Limit | 1 | **PASS** | `"Max call depth (5) exceeded"` |
| 8 | Single-Agent SDK Execution | 2 | **PASS** | `QRM2_SDK_OK` returned. Logs: `sessionId=4a4c70ee-...` `turns=1` `cost=$0.1096` `duration=3331ms` |
| 9 | Workspace File Creation | 2 | **PASS** | Developer created `smoke-test/hello.ts`, architect read it cross-container. Content: `export const message = "QRM2_SMOKE_OK";` |
| 10 | Context Store Relay | 2 | **PASS** | Architect stored `QRM2-CONTEXT-PASS` at key `smoke-relay` (conversation scope). Developer retrieved exact value via `context_query`. |
| 11 | Permission Enforcement — Write Path | 2 | **FAIL** | Architect created `docs/smoke-test-arch.md` (expected: pass) AND `src/forbidden.ts` (expected: denied). Both succeeded. Write path guard did not enforce. See QRM2-BUG-004. |
| 12 | Multi-Agent Task — Code Generation | 3 | **PASS** | Architect: design doc at `docs/smoke-test-design.md` + stored `greet-design` in context. Developer: queried context, implemented `smoke-test/utils.ts` (greet function) + `smoke-test/utils.test.ts` (3 test cases). All 3 files verified. Architect: 6 turns, $0.0906, 35.7s. Developer: 11 turns, $0.1606, 42.6s. |
| 13 | Log Correlation | 1 | **PASS** | `correlationId=smoke-qrm2-005` appears in both architect and developer logs with `sessionId`, `turns`, `cost`, `duration`. Cross-service tracing intact. |

**Result: 12/13 PASS, 1 FAIL**

**Bugs found:**
- **QRM2-BUG-004** — Architect write path guard not enforcing `src/` denial. Root cause: `WRITE_TOOLS` array uses `FileWrite`/`FileEdit` but Claude Code SDK tool names are `Write`/`Edit`. Guard hook never matches actual tool calls. See `tickets/QRM2-BUG-004-write-path-guard-tool-name-mismatch.md`.

### Run 2 — 2026-03-14 (Scenario 11 retest after BUG-004 partial fix)

**Pre-run fixes:** Three issues addressed in BUG-004:
1. `WRITE_TOOLS` corrected from `['FileWrite', 'FileEdit', 'NotebookEdit']` to `['Write', 'Edit', 'NotebookEdit']`
2. `permissionMode` changed from `'bypassPermissions'` to `'default'` — `bypassPermissions` caused `canUseTool` to never be invoked
3. `toCanUseTool` updated to pass `options.suggestions` as `updatedPermissions` in allow responses

Rebuilt containers via `./scripts/start.sh` (4 builds total during investigation).

| # | Scenario | Tier | Result | Notes |
|---|----------|------|--------|-------|
| 11 | Permission Enforcement — Write Path | 2 | **PARTIAL** | `src/forbidden.ts` correctly **denied** with message `"This role can only write to: docs/, tickets/"` ✅. `docs/smoke-test-arch.md` **failed** with ZodError ("Invalid union schema") ✗. Deny path works; allow path broken. |

**Result: Scenario 11 partially fixed — deny enforced, allow broken**

**Root cause of remaining failure:** The `canUseTool` callback is correctly invoked and returns `{ behavior: 'allow', updatedPermissions: [...] }` for allowed paths (confirmed via console.log instrumentation). However, the Claude Code subprocess rejects the allow response with a Zod validation error. The deny response `{ behavior: 'deny', message: '...' }` is accepted by the subprocess. See BUG-004 Issue 3 for investigation directions.

### Run 3 — 2026-03-15 (Full retest after BUG-004 complete resolution)

**Pre-run fixes:** BUG-004 Issue 3 resolved — `toCanUseTool` allow response now passes `updatedInput: input` (the original tool input) as required by the SDK's `PermissionResultAllow` Zod schema. Containers rebuilt via `./scripts/start.sh`.

| # | Scenario | Tier | Result | Notes |
|---|----------|------|--------|-------|
| 1 | Service Health | 1 | **PASS** | `{"status":"ok"}` |
| 2 | Agent Registration | 1 | **PASS** | 4 agents (moderator, developer, architect, teamlead), all connected |
| 3 | Container Security Posture | 1 | **PASS** | user=`quorum` uid=1002, no sudo, CapEff=`0000000000000000`, read-only rootfs |
| 4 | CC Toolchain Availability | 1 | **PASS** | git 2.39.5, rg 13.0.0, bash 5.2.15, curl 7.88.1, jq 1.6 |
| 5 | Workspace Volume Writable | 1 | **PASS** | Write/read/delete succeeded despite `read_only: true` rootfs |
| 6 | Unavailable Role | 1 | **PASS** | `"Agent qa not registered"` |
| 7 | Depth Limit | 1 | **PASS** | `"Max call depth (5) exceeded"` |
| 8 | Single-Agent SDK Execution | 2 | **PASS** | `QRM2_SDK_OK` returned. `sessionId=2abe71d6-...` `turns=1` `cost=$0.1085` `duration=2905ms` |
| 9 | Workspace File Creation | 2 | **PASS** | Developer created `smoke-test/hello.ts`, architect read it cross-container. Content: `export const message = "QRM2_SMOKE_OK";` |
| 10 | Context Store Relay | 2 | **PASS** | Architect stored `QRM2-CONTEXT-PASS` at key `smoke-relay` (conversation scope). Developer retrieved exact value via `context_query`. |
| 11 | Permission Enforcement — Write Path | 2 | **PASS** | `docs/smoke-test-arch.md` created successfully. `src/forbidden.ts` correctly **denied**: `"This role can only write to: docs/, tickets/"`. Both allow and deny paths working. BUG-004 fully resolved. |
| 12 | Multi-Agent Task — Code Generation | 3 | **PASS** | Architect: design doc at `docs/smoke-test-design.md` + stored `greet-design` in context (5 turns, $0.0852, 32.7s). Developer: queried context, implemented `smoke-test/utils.ts` (greet function) + `smoke-test/utils.test.ts` (6 test cases) (9 turns, $0.1498, 44.5s). All 3 files verified. |
| 13 | Log Correlation | 1 | **PASS** | `correlationId=smoke-qrm2-005` appears in both architect and developer logs with `sessionId`, `turns`, `cost`, `duration`. Cross-service tracing intact. |

**Result: 13/13 PASS — Full green.**

**QRM2 milestone validated.** All acceptance criteria met. BUG-004 (all 3 issues) confirmed resolved in production containers.