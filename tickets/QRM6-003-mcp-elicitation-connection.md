# QRM6-003: MCP Elicitation Connection & Broker Routing

## Summary

Implement the server-side plumbing that translates `invoke_agent(target=moderator, ...)` into an MCP `elicitation/create` request on the moderator's active MCP session. This introduces `McpElicitationConnection` — a new `AgentConnection` subclass that delivers invocations via the MCP SDK's `elicitInput()` method instead of HTTP POST — and updates the `register_agent` tool, `AgentRegistry`, and `MessageBroker` to support this new connection type.

After this ticket, agents can ask the moderator (and therefore the user) questions mid-task. The user sees the question inline in CC CLI, types an answer, and the answer flows back through the MCP session to the calling agent — preserving the current clarification UX without the terminal app's `ClarificationHandler`, `POST /invoke`, or `StdinLockService`.

## Problem Statement

Today, the moderator is a NestJS terminal app that exposes a `POST /invoke` endpoint (`apps/terminal/src/clarification/clarification.controller.ts`). When an agent calls `invoke_agent(target=moderator, ...)`, the broker routes the request to this HTTP endpoint via `HttpAgentConnection`. The `ClarificationHandler` displays the question in the console, reads the user's answer from stdin, auto-persists the decision to the context store, and returns the answer.

QRM6 replaces this terminal app with a Claude Code CLI moderator running in a Docker container (QRM6-002, now complete). CC CLI is an MCP **client**, not a server — it has no `POST /invoke` endpoint. The broker needs a new delivery mechanism for moderator-targeted invocations: **MCP elicitation**.

**What changes:**
- The registry must accept moderator registration **without a `callbackUrl`**, storing an elicitation-based connection instead of an HTTP one.
- The broker must route moderator invocations through `McpServer.elicitInput()` on the moderator's MCP session, not HTTP POST.
- The clarification auto-persist logic (currently in `ClarificationHandler.persistDecision()`) moves into the broker's elicitation-response path.

**What stays the same:**
- The `AgentConnection` abstract contract — `handle(request, timeout) → InvokeResponse` — unchanged.
- Agent-to-agent invocations — still use `HttpAgentConnection` via `POST /invoke`.
- The clarification UX from the user's perspective — question appears inline, user types answer, answer flows back.
- Broker safeguards (depth limiting, circular call prevention, role-based timeouts) — unchanged.

**Risks of deferral:** Without this, the moderator container (QRM6-002) can receive MCP tool calls but cannot be invoked by other agents. The entire agent→moderator→user clarification chain is broken, which blocks QRM6-004 (caller identity injection), QRM6-005 (`new_conversation`), and QRM6-009 (terminal deletion).

## Design Context

This ticket implements **D1 (Back-Channel — MCP Elicitation)** from the roadmap. Key architectural decisions informing this work:

**D1 resolution:** QRM6-001 confirmed GO on CC CLI 2.1.117 — `elicitation/create` round-trips work end-to-end with accept/decline/cancel actions. Simple string schemas and rich form schemas (oneOf enum, integer, boolean, string) all work. Protocol overhead is negligible (~19–34ms). The `action` field in `ElicitResult` returns `"accept"`, `"decline"`, or `"cancel"`.

**Connection abstraction pattern:** The existing `AgentConnection` abstract class (`apps/mcp-server/src/registry/agent-connection.abstract.ts`) is the contract. `HttpAgentConnection` is the sole concrete implementation today. The new `McpElicitationConnection` sits alongside it. The broker and registry never reference transport details — they operate on the abstraction. This is an intentional design pattern (see JSDoc: "consistent with the `ContextStore` pattern").

**Per-session `McpServer` instances:** `McpService.connect()` creates a **new `McpServer` instance per transport/session** (line 61). The `elicitInput()` method lives on the `McpServer` instance, so `McpElicitationConnection` must hold a reference to the specific per-session server that owns the moderator's transport. This is the critical coupling point — the connection needs the session's `McpServer`, not the singleton.

**Clarification auto-persist migration:** `ClarificationHandler.persistDecision()` (line 115–137 of `clarification.service.ts`) writes `clarification:{caller}:{correlationId}` to project scope after every successful clarification. This logic moves into the broker's elicitation-response path. The key format, scope (project), and value shape (`{question, answer, askedBy, correlationId}`) are preserved exactly.

**Elicitation SDK API:** `McpServer.elicitInput(params)` takes `ElicitRequestFormParams` and returns `Promise<ElicitResult>`. `ElicitResult` has `action: "accept" | "decline" | "cancel"` and optional `content: Record<string, string | number | boolean | string[]>`. For our use case, we use a simple form schema with a single `answer` string field, and the `message` field carries the question text (including caller context).

**QRM6-002 infrastructure notes:** The moderator container uses entrypoint-based settings injection (`docker/moderator/entrypoint.sh`), an idle `tail -f /dev/null` entrypoint, and exec-attach. The `.claude.json` symlink pattern is mandatory for read-only rootfs. MCP URL is substituted at runtime from `MCP_SERVER_URL` env var.

## Implementation Details

### 1. `McpElicitationConnection` — New Connection Type

Create `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` implementing `AgentConnection`.

**Constructor dependencies:**
- `role: AgentRole` — always `AgentRole.moderator` (enforced by caller, not the class)
- `server: McpServer` — the **per-session** `McpServer` instance from `McpService.connect()` that owns the moderator's transport. This is what makes `elicitInput()` route to the correct client.

**`isConnected()` implementation:** Return `true` optimistically, same as `HttpAgentConnection`. Elicitation failures (session dropped, client disconnected) are discovered when `handle()` rejects. The broker's `deliverWithTimeout` wrapper handles this.

**`handle(request, timeout)` implementation:**

1. Build the elicitation `message` string from the request: include the caller role and the action text so the user has context. Format suggestion: `"[{caller}] {action}"` or `"Clarification from {caller}: {action}"`. The `correlationId` can be included in the message or omitted from the user-facing text (it's noise for the user).

2. Build the `ElicitRequestFormParams`:
   - `message`: the formatted question string
   - `requestedSchema`: a JSON Schema object with a single `answer` string property:
     ```
     { type: "object", properties: { answer: { type: "string", description: "Your answer" } }, required: ["answer"] }
     ```
   - No `mode` field needed — form mode is the default per SDK docs

3. Call `this.server.elicitInput(params)` and await the result.

4. Map `ElicitResult` to `InvokeResponse`:
   - `action === "accept"` and `content?.answer` exists: return `{ success: true, result: content.answer }` (string coercion if needed)
   - `action === "decline"`: return `{ success: false, error: "User declined the clarification request" }`
   - `action === "cancel"`: return `{ success: false, error: "User cancelled the clarification request" }`
   - `content` missing or `answer` missing on accept: return `{ success: false, error: "Elicitation returned empty response" }`

5. Error handling: wrap the `elicitInput()` call in try/catch. On rejection (transport error, session dropped), return `{ success: false, error: "Elicitation failed: {message}" }`. **Never throw** — match `HttpAgentConnection`'s contract of always resolving to an `InvokeResponse`.

**Note on timeout:** The `timeout` parameter is a hint. The broker wraps the call with its own `Promise.race` timeout safeguard (`deliverWithTimeout`), so `McpElicitationConnection` does not need to implement its own AbortController. However, if the MCP SDK supports a `RequestOptions.signal` or timeout option on `elicitInput()`, it may be worth passing it through. The developer should check the SDK's `RequestOptions` type. If not feasible, the broker-level timeout is sufficient.

### 2. `register_agent` Tool Schema Update

In `McpService.registerRegisterAgentTool()` (line 173), update the input schema:

- Make `callbackUrl` optional: change from `z.string().url()` to `z.string().url().optional()`
- Update the description to reflect that `callbackUrl` is required for agents, optional for moderator

In the handler (line 189):

- **When `callbackUrl` is provided:** Create `HttpAgentConnection` as today (agent path unchanged)
- **When `callbackUrl` is absent:**
  - The registering client must be the moderator. Validate that `args.role` is `AgentRole.moderator` — if a non-moderator role omits `callbackUrl`, return an error.
  - Create an `McpElicitationConnection` with the **per-session `McpServer`** instance for this client's MCP session.

**The critical challenge:** The `register_agent` handler runs inside a tool callback on a per-session `McpServer` instance (line 62–63 of `mcp.service.ts`). The handler receives `args` but does **not** currently have access to the `McpServer` instance or the MCP session ID. The developer needs to capture the per-session `McpServer` so it can be passed to `McpElicitationConnection`.

Two approaches for the developer to evaluate:

**Approach A — Closure capture:** In `McpService.connect()`, after creating `const session = new McpServer(...)`, pass `session` into `registerTools()`. Then `registerRegisterAgentTool(server)` already receives the per-session server. In the tool handler, check if `callbackUrl` is absent and `role === moderator`, and if so, use the `server` argument (which is the per-session instance) to construct `McpElicitationConnection`. This is the cleanest — the server is already in scope.

**Approach B — Session map:** Maintain a `Map<mcpSessionId, McpServer>` in `McpService`. Look up the session's server in the handler. This is more complex and preempts the session-indexed state map that QRM6-004 introduces — the developer should evaluate whether to start the map now or defer to QRM6-004.

Approach A is recommended — it requires no new state management and the per-session server is already the `server` parameter in every `registerXxxTool()` method.

### 3. AgentRegistry — No Changes Required

The `AgentRegistry` operates on the `AgentConnection` abstraction. It stores connections by role via `register(connection)` and retrieves them via `get(role)`. Since `McpElicitationConnection extends AgentConnection`, the registry requires **no code changes**. Registration of the new connection type flows through the existing `register()` method.

### 4. MessageBroker — Clarification Auto-Persist

The `MessageBroker.invoke()` method currently delegates to `agent.handle(request, timeout)` and returns the response. For moderator-targeted invocations that succeed (the elicitation was answered), add auto-persist logic **after** the response is received.

**Where to add it:** After the `deliverWithTimeout()` call (line 86–91 of `message-broker.service.ts`), before returning `response`. Conditionally:

- **Condition:** `target === AgentRole.moderator && response.success === true && response.result`
- **Action:** Persist to context store:
  - `scope`: `project`
  - `key`: `clarification:{caller}:{correlationId}`
  - `value`: `{ question: request.action, answer: response.result, askedBy: request.caller, correlationId: request.correlationId }`
  - `createdBy`: `'moderator'`

This preserves the exact key format and value shape from `ClarificationHandler.persistDecision()`.

**Error handling:** The persist is **non-fatal** — wrap in try/catch and log a warning on failure. The clarification answer is still returned to the calling agent regardless. This matches the existing behavior (line 134–137 of `clarification.service.ts`: "Non-fatal: the user's answer is still returned to the calling agent").

**Dependency:** The `MessageBroker` currently does not have `ContextStore` injected. Add `ContextStore` to its constructor dependencies (and update `MessagingModule` providers/imports as needed).

### 5. ROLE_TIMEOUTS — Moderator Timeout

The `ROLE_TIMEOUTS` map (`apps/mcp-server/src/messaging/role-timeouts.ts`) does not currently include a timeout for `AgentRole.moderator`. The broker falls back to `config.broker.defaultTimeoutMs`.

Add an explicit moderator timeout. The moderator timeout represents how long to wait for the **user** to answer a clarification question — this can be long (the user might be away). Recommended: **5 minutes** (5 * 60_000 = 300,000ms) — matching the architect timeout. The user can always answer faster; this is the upper bound before the calling agent gets a timeout error.

### 6. Barrel Export Update

Update `apps/mcp-server/src/registry/index.ts` to export `McpElicitationConnection`.

## Acceptance Criteria

- [ ] `McpElicitationConnection` class exists in `apps/mcp-server/src/registry/mcp-elicitation-connection.ts`, extends `AgentConnection`, implements `handle()` via `McpServer.elicitInput()`
- [ ] `McpElicitationConnection.handle()` maps `ElicitResult.action` to `InvokeResponse`: accept→success, decline→error, cancel→error
- [ ] `McpElicitationConnection.handle()` never throws — transport errors are caught and returned as `{ success: false, error }` envelopes
- [ ] `register_agent` tool schema accepts `callbackUrl` as optional; omitting it for `role=moderator` creates an `McpElicitationConnection`
- [ ] `register_agent` rejects non-moderator roles that omit `callbackUrl` (agents must provide a callback URL)
- [ ] `AgentRegistry` can store and retrieve `McpElicitationConnection` alongside `HttpAgentConnection` without code changes (verify in tests)
- [ ] `MessageBroker` auto-persists successful clarifications to context store: key `clarification:{caller}:{correlationId}`, project scope, value contains question/answer/askedBy/correlationId
- [ ] Auto-persist is non-fatal — failure is logged but does not affect the `InvokeResponse` returned to the caller
- [ ] `ROLE_TIMEOUTS` includes an explicit moderator timeout entry
- [ ] `McpElicitationConnection` is exported from `apps/mcp-server/src/registry/index.ts`
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (existing 760 tests, 49 suites — no regressions)
- [ ] No changes to `apps/terminal/` — the existing terminal service remains untouched

## Dependencies and References

- **Depends on:**
  - QRM6-001 (elicitation spike — GO verdict confirmed, CC CLI 2.1.117 validated)
  - QRM6-002 (moderator container — provides the Docker infrastructure for integration testing)
- **Blocks:**
  - QRM6-004 (server-side caller identity & session tracking — builds on session-indexed state)
  - QRM6-005 (`new_conversation` tool — depends on QRM6-004)
  - QRM6-008 (tests — includes `McpElicitationConnection` unit tests and integration tests)
  - QRM6-009 (terminal deletion — cannot remove terminal until elicitation path is working)

**Key codebase references:**

| File | Relevance |
|------|-----------|
| `apps/mcp-server/src/registry/agent-connection.abstract.ts` | Contract to implement — `handle(request, timeout): Promise<InvokeResponse>` |
| `apps/mcp-server/src/registry/http-agent-connection.ts` | Reference implementation — error handling, never-throw contract, timeout pattern |
| `apps/mcp-server/src/mcp/mcp.service.ts` | `connect()` creates per-session `McpServer`; `registerRegisterAgentTool()` needs schema update; tool handlers receive the per-session server via `registerTools(session)` |
| `apps/mcp-server/src/mcp/mcp.controller.ts` | Session lifecycle — `sessions` map tracks `StreamableHTTPServerTransport` by `mcp-session-id` |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | `invoke()` method — add clarification auto-persist after `deliverWithTimeout()` |
| `apps/mcp-server/src/messaging/role-timeouts.ts` | Add moderator timeout entry |
| `apps/terminal/src/clarification/clarification.service.ts` | Source logic for `persistDecision()` — key format, value shape, non-fatal error handling |
| `libs/common/src/messaging/invoke.types.ts` | `InvokeRequest`, `InvokeResponse` types — the contract |
| `libs/common/src/messaging/agent-role.enum.ts` | `INVOCABLE_AGENT_ROLES` includes `moderator` (already) |
| `@modelcontextprotocol/sdk` server types | `McpServer.elicitInput()`, `ElicitRequestFormParams`, `ElicitResult` |

**Design references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D1 (Back-Channel), Clarification Flow via Elicitation sequence diagram, Tool Call Auto-Augmentation table
- [QRM6-001-elicitation-spike.md](QRM6-001-elicitation-spike.md) — GO verdict, schema surface area, round-trip latency, accept/decline/cancel behavior
- [docs/agent-messaging.md](../docs/agent-messaging.md) — Current clarification flow (will be updated in QRM6-010)
- [docs/message-broker.md](../docs/message-broker.md) — Broker safeguards, delivery semantics
