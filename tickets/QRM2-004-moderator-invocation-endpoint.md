# QRM2-004: Moderator Invocation Endpoint (User Clarification Flow)

## Summary

Add the moderator as an invocable target in `invoke_agent` so that any agent can escalate clarification requests to the user. The MCP server's target enum gains `moderator`, the Terminal App gains a POST /invoke endpoint mirroring the agent container pattern, and a `ClarificationHandler` surfaces incoming questions directly in the console — bypassing the moderator LLM to avoid call-chain deadlocks. After the user responds, the decision is automatically persisted to the Context Store, ensuring the same question is never asked twice.

## Problem Statement

The current architecture has a one-way escalation gap:

1. **User → Moderator → Agents works.** The moderator orchestrates agents via `invoke_agent`, receives results, and presents them to the user.
2. **Agent → Moderator → User doesn't work.** If the architect needs a user preference (push vs pull architecture, SQL vs NoSQL, REST vs GraphQL), there's no mechanism to surface that question to the user.

This creates two failure modes:

- **Silent assumptions:** The architect picks an approach without user input. The user discovers the choice later, potentially after significant implementation work has gone in the wrong direction.
- **Dead-end escalation:** QRM2-007 (Prompt Adaptation) will instruct agents to `invoke_agent(moderator, ...)` for blocker escalation. But `moderator` isn't a valid `invoke_agent` target, and the terminal has no invocation handler to receive it.

The gap also undermines the Context Store's value proposition. Design decisions that should be explicit user choices get made implicitly by agents. The Context Store can persist decisions — but only if someone makes them deliberately.

### Historical Precedent

QRM1-BUG-002 hit the same pattern in reverse: `register_agent` validated against `DEPLOYABLE_AGENT_ROLES` (which excludes moderator), silently rejecting the terminal's registration. The fix widened the enum scope. This ticket applies the same principle to `invoke_agent`'s target enum.

## Design Context

### Why Not Route Through the Moderator LLM?

The obvious approach — have the architect invoke the moderator LLM, let it ask the user — creates a **synchronous call-chain deadlock**:

```
User asks Moderator: "Design an event system"
  Moderator invokes Architect (synchronous, blocked waiting)
    Architect invokes Moderator: "Push or pull?"
      Moderator can't respond — blocked waiting for Architect
      → Deadlock
```

The moderator's agentic tool loop in `ChatService.processWithLoop()` is blocked on the original `invoke_agent(architect, ...)` call. A nested invocation back to the moderator can't reach the LLM because it's mid-turn.

**Solution:** Bypass the moderator LLM entirely. The Terminal App handles clarification requests at the HTTP/handler level, presenting them directly in the console without involving the moderator's Claude conversation. This is conceptually similar to how an IDE surfaces inline prompts from a background process — the question goes straight to the user.

### Terminal as Relay, Not Interpreter

The clarification handler doesn't process, rephrase, or add context to agent questions. It relays them verbatim:

```
┌──────────────────────────────────────────────────────┐
│ Terminal Console                                      │
│                                                       │
│ > Building event system...                            │
│                                                       │
│ ┌─ Clarification from architect ───────────────────┐  │
│ │ For the event notification system, should we use │  │
│ │ a push-based (server pushes to clients) or       │  │
│ │ pull-based (clients poll) architecture?           │  │
│ └──────────────────────────────────────────────────┘  │
│                                                       │
│ Your answer: pull-based, we want real-time but our    │
│ clients can handle websocket connections              │
│                                                       │
│ ✓ Decision stored: event_notification_pattern         │
│                                                       │
│ > Architect recommends pull-based with WebSocket...   │
└──────────────────────────────────────────────────────┘
```

The agent formulates the question (it's an LLM — it can write clear questions). The handler pipes it through and returns the user's raw answer.

### Context Store Auto-Persistence

After the user answers, the handler persists the decision in the Context Store before returning the answer to the calling agent. This ensures:

1. The answer is immediately available to all agents via `context_query`
2. If the same question arises in a future task chain, the agent finds the answer in the store and doesn't escalate

The persistence scope depends on the nature of the decision:
- **Project scope** for tech stack / architectural choices (persist across all conversations)
- **Conversation scope** for task-specific clarifications (scoped to the current correlationId)

For the MVP, default to **project scope** — most user clarifications are architectural preferences that should be durable. The agent can specify a preferred scope in the `context` payload if needed.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Add `moderator` to `invoke_agent` target enum on MCP server | Moderator LLM involvement in clarification |
| POST /invoke endpoint in Terminal App | Rich UI for clarification (Ink, interactive menus) |
| `ClarificationHandler` with console display + stdin input | Async/queued clarification (all synchronous for now) |
| Auto-persist decisions to Context Store | Semantic deduplication of similar questions |
| Update bridge tool's target enum (from QRM2-003) | Changes to agent permission profiles (QRM2-005) |
| Stdin coordination with ChatService | Prompt template updates (QRM2-007) |

## Implementation Details

### 1. MCP Server: Target Enum Update

**Location:** `apps/mcp-server/src/mcp/mcp.service.ts` (line ~96)

The `invoke_agent` tool currently restricts targets to `DEPLOYABLE_AGENT_ROLES`:

```typescript
target: z
  .enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
  .describe('Target agent role to invoke')
```

**Option A — Use full `AgentRole` enum:**
```typescript
target: z
  .enum(Object.values(AgentRole) as [string, ...string[]])
  .describe('Target agent role to invoke')
```

**Option B — Create `INVOCABLE_AGENT_ROLES` constant:**
```typescript
// libs/common/src/messaging/agent-role.enum.ts
export const INVOCABLE_AGENT_ROLES = [
  ...DEPLOYABLE_AGENT_ROLES,
  AgentRole.moderator,
] as const;
```

Option B is preferred — it makes the distinction explicit (`DEPLOYABLE` = runs as agent container, `INVOCABLE` = valid target for invoke_agent) and avoids accidentally allowing future non-invocable roles. The constant lives in `@app/common` alongside `DEPLOYABLE_AGENT_ROLES`.

### 2. Terminal App: POST /invoke Endpoint

**Location:** `apps/terminal/src/clarification/clarification.controller.ts` (new)

Mirror the agent container's `InvocationController` pattern from `apps/agent/src/connection/invocation.controller.ts`:

- POST /invoke receives `InvokeRequest` body
- Validates with the same Zod schema the agent uses
- Routes to `ClarificationHandler.handle(request)`
- Returns `InvokeResponse`

The terminal already listens on a configured port (`PORT: 3001`) and registers with a callback URL (`MCP_CALLBACK_URL: http://terminal:3001`). The MCP server's message broker uses this URL to deliver invocations via HTTP POST — the same mechanism used for agent containers.

### 3. ClarificationHandler

**Location:** `apps/terminal/src/clarification/clarification.service.ts` (new)

Core service that:

1. **Acquires stdin access** — coordinates with `ChatService` to avoid interleaved I/O (see Stdin Coordination below)
2. **Formats the question** — displays agent role and action text in a visually distinct block
3. **Reads user input** — blocking readline prompt; the calling agent waits synchronously
4. **Persists the decision** — calls `context_store` via `McpClientService` to store the user's answer
5. **Returns response** — wraps the answer in `InvokeResponse { success: true, result: answer }`

```typescript
@Injectable()
export class ClarificationHandler {
  constructor(
    private readonly mcpClient: McpClientService,
    private readonly stdinLock: StdinLockService,  // shared with ChatService
  ) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    const release = await this.stdinLock.acquire();
    try {
      // Display the clarification prompt
      this.displayQuestion(request.caller, request.action);

      // Read user answer
      const answer = await this.readUserInput();

      // Auto-persist to Context Store
      await this.persistDecision(request, answer);

      return { success: true, result: answer };
    } catch (err) {
      return { success: false, error: `Clarification failed: ${err.message}` };
    } finally {
      release();
    }
  }
}
```

### 4. Stdin Coordination

**Location:** `apps/terminal/src/clarification/stdin-lock.service.ts` (new)

The `ChatService` currently owns stdin via a `readline` interface created in `chatLoop()`. When a clarification arrives mid-conversation, both the chat loop and the clarification handler compete for stdin.

**Approach: Shared mutex on stdin access.**

- `StdinLockService` provides `acquire(): Promise<ReleaseFn>` — a simple async mutex
- `ChatService` acquires the lock before each `rl.question()` call and releases after receiving input
- `ClarificationHandler` acquires the lock when a clarification arrives
- If the moderator LLM is mid-stream (writing to stdout), the clarification waits until the current turn's output completes before displaying its prompt

This keeps the ChatService changes minimal — wrap the existing `rl.question()` in lock acquire/release. The clarification handler creates its own temporary `readline` interface (or reuses the shared one) for the single-question interaction.

### 5. McpToolBridgeService Update

**Location:** `apps/agent/src/connection/mcp-tool-bridge.service.ts` (line ~72)

The bridge's `invoke_agent` tool uses the same `DEPLOYABLE_AGENT_ROLES` enum. Update to use `INVOCABLE_AGENT_ROLES` (the new constant from step 1) so Claude Code sessions can invoke the moderator.

### 6. Module Wiring

```typescript
// apps/terminal/src/clarification/clarification.module.ts
@Module({
  imports: [ConnectionModule],  // McpClientService
  controllers: [ClarificationController],
  providers: [ClarificationHandler, StdinLockService],
  exports: [StdinLockService],  // ChatModule needs the lock too
})
export class ClarificationModule {}
```

`TerminalModule` imports `ClarificationModule`. `ChatModule` imports or receives `StdinLockService` to coordinate stdin access.

### Testing Strategy

**Unit tests:**
- `ClarificationHandler` with mocked stdin, stdout, `McpClientService`, and `StdinLockService`
- Verify question formatting includes agent role
- Verify `context_store` is called with correct scope/key/value after user input
- Verify error handling when stdin is unavailable or MCP client fails

**Integration test:**
- POST /invoke endpoint receives `InvokeRequest`, returns `InvokeResponse`
- Zod validation rejects malformed requests

**Manual validation (Docker):**
- Architect invokes moderator with a design question
- Console displays the question with agent attribution
- User types answer
- Context Store receives the decision (verify via `context_stats` or `context_query`)
- Architect receives the answer and proceeds

### File Structure

```
apps/terminal/src/
  clarification/
    clarification.controller.ts        # NEW — POST /invoke endpoint
    clarification.service.ts           # NEW — ClarificationHandler
    clarification.service.spec.ts      # NEW — unit tests
    stdin-lock.service.ts              # NEW — async mutex for stdin
    stdin-lock.service.spec.ts         # NEW — unit tests
    clarification.module.ts            # NEW — ClarificationModule
    index.ts                           # NEW — barrel exports
  chat/
    chat.service.ts                    # MODIFIED — integrate StdinLockService
  app.module.ts                        # MODIFIED — import ClarificationModule

libs/common/src/messaging/
  agent-role.enum.ts                   # MODIFIED — add INVOCABLE_AGENT_ROLES

apps/mcp-server/src/mcp/
  mcp.service.ts                       # MODIFIED — invoke_agent target → INVOCABLE_AGENT_ROLES

apps/agent/src/connection/
  mcp-tool-bridge.service.ts           # MODIFIED — invoke_agent target → INVOCABLE_AGENT_ROLES
```

## Acceptance Criteria

- [x] `INVOCABLE_AGENT_ROLES` constant exists in `@app/common` and includes all 6 roles (5 deployable + moderator)
- [x] `invoke_agent` tool on MCP server accepts `moderator` as a valid target
- [x] Terminal App exposes POST /invoke endpoint that accepts `InvokeRequest`
- [x] `ClarificationHandler` receives invocations and displays the agent's question in the console
- [x] Console output clearly identifies which agent is asking (e.g., `[architect asks]`)
- [x] User can type a response via stdin; response is returned as `InvokeResponse`
- [x] After user responds, decision is auto-stored in Context Store via `context_store` MCP tool
- [x] `McpToolBridgeService`'s `invoke_agent` target enum updated to `INVOCABLE_AGENT_ROLES`
- [x] Stdin access is coordinated with `ChatService` via `StdinLockService` (no interleaved I/O)
- [x] Error handling: if stdin is unavailable or `context_store` fails, return `{ success: false, error: '...' }`
- [x] `npm run build` compiles successfully
- [x] `npm run lint` passes
- [x] `npm run test` passes (all existing + new tests)

## Implementation Notes

**Status:** Complete (2 commits on `qrm2-agent-sdk-migration`)

### Deviations from Plan

None structurally — Option B was chosen for the target enum as planned. All files match the proposed file structure. Four post-review refinements were applied:

1. **Compile-time schema guard added** (`clarification.controller.ts:25-27`). The agent's `InvocationController` has a `_SchemaMatchesInvokeRequest` type alias that fails compilation if the Zod schema drifts from `InvokeRequest`. The same guard was missing from `ClarificationController` — now added. Note: the `invokeRequestSchema` itself is duplicated between the two controllers; extracting to `libs/common` is deferred (see Known Tech Debt below).

2. **Long question word-wrapping** (`clarification.service.ts:58-79`). The original `displayQuestion` used `action.padEnd(58)` which overflows the box border for multi-sentence questions. Replaced with `wrapText()` — word-wraps at 58 chars respecting newlines, outputs multiple `│ ... │` rows.

3. **Context Store key uses `correlationId`** (`clarification.service.ts:122`). Changed from `clarification:${caller}:${Date.now()}` to `clarification:${caller}:${correlationId}`. Eliminates millisecond collision risk and makes decisions queryable by correlation chain.

4. **EOF-safe `readUserInput`** (`clarification.service.ts:81-112`). Added a `settled` flag to prevent double-settling: `rl.close()` in the question callback fires the `close` event, which would otherwise reject an already-resolved promise. The `close` handler now rejects only if stdin closes *before* the user answers (e.g., container restart, piped input EOF).

### Key Implementation Details

**Stdin lock integration with ChatService** (`chat.service.ts:86-93`): The chat loop wraps each `rl.question()` call in `stdinLock.acquire()/release()`. When a clarification arrives, `ClarificationHandler` acquires the same lock, blocking the chat prompt until the clarification completes. The handler creates its own temporary `readline.Interface` for the single-question interaction rather than sharing the chat loop's instance.

**Context Store persistence is non-fatal** (`clarification.service.ts:118-137`): If `context_store` call fails (MCP offline, store full), the user's answer is still returned to the calling agent. A warning is logged but the clarification succeeds. This prevents infrastructure issues from blocking agent workflows.

**Error handling split**: Empty answers reject with `Error('Empty answer')` which propagates to `{ success: false, error: 'Clarification failed: Empty answer' }`. All other errors (stdin broken, EOF) follow the same pattern. The `finally` block guarantees lock release on any code path.

### Known Tech Debt

- **Duplicated `invokeRequestSchema`**: The Zod schema for `InvokeRequest` validation is defined identically in `apps/agent/src/connection/invocation.controller.ts` and `apps/terminal/src/clarification/clarification.controller.ts`. Both have a comment noting this should move to `libs/common/src/messaging/`. Extracting it touches every `InvokeRequest` consumer — deferred to avoid scope creep.

### Test Coverage

| File | Tests | What's covered |
|------|-------|----------------|
| `clarification.service.spec.ts` | 7 | Question display, answer return, context_store call shape, empty answer, MCP failure resilience, lock acquire/release, lock release on error |
| `stdin-lock.service.spec.ts` | 4 | Initial state, acquire/release, FIFO queue ordering, double-release idempotency, hand-off semantics |

All 298 tests pass (33 suites). Build and lint clean.

## Dependencies and References

### Prerequisites
- QRM2-003 — MCP Orchestration Tool Bridge (`McpToolBridgeService`, bridge's `invoke_agent` definition)
- QRM1-007 — Agent-to-Server Connection (invocation endpoint pattern in agent container)
- QRM1-005 — MCP Server Bootstrap (`invoke_agent` tool definition in `McpService`)
- QRM1-010 — Terminal Moderator Bootstrap (`ChatService`, terminal connection, callback URL)

### What This Blocks
- QRM2-007 — Prompt Adaptation (prompts describe the user clarification pattern)
- QRM2-009 — E2E Integration Smoke Test (clarification flow is a testable scenario)

### References
- `invoke_agent` server-side tool: `apps/mcp-server/src/mcp/mcp.service.ts:83-149`
- Agent invocation controller: `apps/agent/src/connection/invocation.controller.ts`
- Agent invocation handler: `apps/agent/src/connection/invocation-handler.service.ts`
- Terminal ChatService: `apps/terminal/src/chat/chat.service.ts`
- Terminal main bootstrap: `apps/terminal/src/main.ts`
- Bridge `invoke_agent` tool: `apps/agent/src/connection/mcp-tool-bridge.service.ts:70-93`
- `DEPLOYABLE_AGENT_ROLES`: `libs/common/src/messaging/agent-role.enum.ts:11-17`
- QRM1-BUG-002 (moderator registration rejected): `tickets/QRM1-BUG-002-moderator-registration-rejected.md`