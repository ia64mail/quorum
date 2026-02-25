# End-to-End Connectivity Smoke Test Runbook

Verification steps for the QRM1 milestone success criterion: `docker compose up` brings up MCP server + 4 agent containers that register and communicate.

Designed for execution by a Claude Code agent via bash commands against the live Docker system. Scenarios are sequential — run them in order.

## Prerequisites

1. `.env` at project root with `ANTHROPIC_API_KEY` set
2. Build and start the stack:
   ```bash
   docker compose build && docker compose up -d
   ```
3. Wait for all services to be healthy:
   ```bash
   docker compose ps
   ```
   All 5 services (mcp-server, terminal, architect, teamlead, developer) should show "Up (healthy)" or "Up".

4. Wait ~10 seconds for agents to register with the MCP server after startup.

---

## Scenario 1: Service Health (deterministic)

Verify the MCP server is running and its health endpoint responds.

```bash
curl -s http://localhost:3000/health
```

**Expected:**
```json
{ "status": "ok" }
```

---

## Scenario 2: Agent Registration (deterministic)

Verify all 4 QRM1 agents registered and are connected.

```bash
curl -s http://localhost:3000/registry | jq .
```

**Expected:** 4 agents, all connected:
```json
{
  "agents": [
    { "role": "architect", "connected": true },
    { "role": "teamlead", "connected": true },
    { "role": "developer", "connected": true },
    { "role": "moderator", "connected": true }
  ]
}
```

Order may vary. Verify:
- Exactly 4 entries
- All `connected: true`
- Roles: architect, teamlead, developer, moderator

---

## Scenario 3: Single-Hop Invocation (live LLM)

Send a crafted invocation to the architect agent via `docker compose exec` (agent ports are not mapped to host).

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-test-001',
      caller: 'moderator',
      target: 'architect',
      action: 'Respond with exactly: SMOKE_TEST_OK',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Expected:**
```json
{
  "success": true,
  "result": "..." // Should contain SMOKE_TEST_OK or a reasonable response
}
```

**Verify logs contain the correlation ID:**
```bash
docker compose logs architect 2>&1 | grep smoke-test-001
```

---

## Scenario 4: Context Store Relay (live LLM)

Test cross-agent context sharing via the context store.

**Step 1 — Ask architect to store a value:**
```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-test-002',
      caller: 'moderator',
      target: 'architect',
      action: \"Store the value 'QRM1-SMOKE-PASS' in the context store with key 'smoke-test-result' at project scope, then confirm you stored it.\",
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Step 2 — Ask developer to retrieve it:**
```bash
docker compose exec mcp-server node -e "
  fetch('http://developer:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-test-002',
      caller: 'moderator',
      target: 'developer',
      action: \"Query the context store for key 'smoke-test-result' at project scope and return the value.\",
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Expected:** Developer's response contains `QRM1-SMOKE-PASS`.

---

## Scenario 5: Safeguard — Unavailable Role (deterministic)

Use the test endpoint to invoke a role that is not deployed (qa).

```bash
curl -s -X POST http://localhost:3000/test/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "correlationId": "smoke-test-003",
    "caller": "moderator",
    "target": "qa",
    "action": "ping",
    "wait": true,
    "depth": 0
  }'
```

**Expected:**
```json
{
  "success": false,
  "error": "Agent qa not registered"
}
```

---

## Scenario 6: Safeguard — Depth Limit (deterministic)

Send a request that exceeds the maximum call depth (default: 5).

```bash
curl -s -X POST http://localhost:3000/test/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "correlationId": "smoke-test-004",
    "caller": "moderator",
    "target": "architect",
    "action": "ping",
    "wait": true,
    "depth": 5
  }'
```

**Expected:**
```json
{
  "success": false,
  "error": "Max call depth (5) exceeded"
}
```

---

## Scenario 7: Safeguard — Circular Call (live LLM)

Tell the architect to invoke itself. The broker will detect the circular call chain.

```bash
docker compose exec mcp-server node -e "
  fetch('http://architect:3002/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId: 'smoke-test-005',
      caller: 'moderator',
      target: 'architect',
      action: 'Invoke the architect agent with the action: reply with OK',
      wait: true,
      depth: 0
    })
  }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => console.error(e))
"
```

**Expected:** The response should contain an error about circular call detection, or the architect should report that invoking itself was rejected. This is non-deterministic — it depends on Claude choosing to use the `invoke_agent` tool with `target: architect`.

**Note:** Circular call prevention is thoroughly tested in unit tests (`message-broker.service.spec.ts`). This scenario confirms the safeguard works in the integrated system but may not trigger deterministically.

---

## Scenario 8: Log Correlation (deterministic, post-hoc)

After running scenarios 3-4, verify correlation IDs appear across service logs.

```bash
docker compose logs 2>&1 | grep smoke-test-001
```

**Expected:** Correlation ID `smoke-test-001` appears in both MCP server logs (broker routing) and architect logs (request handling).

```bash
docker compose logs 2>&1 | grep smoke-test-002
```

**Expected:** Correlation ID `smoke-test-002` appears in MCP server, architect, and developer logs.

---

## Teardown

```bash
docker compose down -v
```

## Result Summary

| Scenario | Type | Pass Criteria |
|----------|------|---------------|
| 1. Service Health | Deterministic | `{ "status": "ok" }` |
| 2. Agent Registration | Deterministic | 4 agents, all connected |
| 3. Single-Hop Invocation | Live LLM | `success: true`, response contains SMOKE_TEST_OK |
| 4. Context Store Relay | Live LLM | Developer retrieves value stored by architect |
| 5. Unavailable Role | Deterministic | `Agent qa not registered` |
| 6. Depth Limit | Deterministic | `Max call depth (5) exceeded` |
| 7. Circular Call | Live LLM | Circular call rejected (non-deterministic) |
| 8. Log Correlation | Deterministic | Correlation IDs in cross-service logs |
