# QRM5-BUG-003: Silent Stall of Long-Running Tool Responses over Streamable HTTP

## Summary

Long-running `invoke_agent` tool calls from the terminal (moderator) to the MCP server occasionally stall indefinitely on the response path: the agent completes, the broker logs `Completed: success=true`, the work is committed — but the JSON-RPC tool result never surfaces on the terminal's MCP client. The call parks inside `await mcpClient.callTool(...)` until the 30-minute `MCP_REQUEST_TIMEOUT_MS` fires, at which point the moderator enters failure recovery. The TCP socket stays `ESTABLISHED`, no reconnect, no errors at any layer — a silent stall in the Streamable HTTP response stream.

## Problem Statement

Two occurrences reproduced in the same session on the same long-lived Streamable HTTP session (terminal↔mcp-server):

| # | Caller → Target | Invoke (UTC)     | Broker Completed | Duration | Client Outcome                           |
|---|-----------------|------------------|------------------|----------|------------------------------------------|
| 1 | moderator → developer | 00:36:23      | 00:43:05         | 6:42     | Timed out at 01:06:23 (30-min client timeout) |
| 2 | moderator → teamlead  | 01:15:29      | 01:20:39         | 5:10     | Timed out at 01:45:29 (30-min client timeout) |

Both calls: the agent finished and committed real work (QRM5-004 → `2afcd07`, QRM5-004 ticket update + QRM5-005 ticket creation → `2588857`), broker logged success, but the moderator received nothing until its JSON-RPC timeout fired. Short-duration calls (e.g., a 46s developer call at 01:06:31→01:07:17 on the same session) still completed normally, so the failure is selective to long tool calls.

**Impact per occurrence:**
- 30-minute moderator-side wall clock wait before failure recovery can start
- Risk of duplicate work: failure-recovery relies on discovering the developer's `status: complete` checkpoint in the Context Store; if the checkpoint is missing or the moderator misjudges it, a retry duplicates the work
- User-facing UX: appears as a frozen terminal for ~30 minutes

**Same class of bug as [QRM4-BUG-002](QRM4-BUG-002-mcp-client-timeout-mismatch.md), inverted direction.** QRM4-BUG-002 was a client→server request-path timeout mismatch; this is a server→client response-path silent drop. Both share the "no timeout / no heartbeat at the correct layer" shape, and QRM4-BUG-002 took three fix attempts because the first two landed at the wrong layer. The first fix step here is therefore **instrumentation, not a speculative fix.**

## Design Context

The moderator↔mcp-server Streamable HTTP session is long-lived: one session per terminal container run, reused for every tool call. During a long-running `invoke_agent` (5–10+ minutes), the SSE response stream carries **zero bytes** — the MCP SDK does not emit heartbeats or notifications while a tool handler is running. The client's `fetch` stream stays open, and the server's Express response object stays open, but nothing transits.

Once the tool handler returns, `StreamableHTTPServerTransport` writes the JSON-RPC response to the stream as an SSE event. The hypothesis is that a sufficiently long idle window on the response stream allows an intermediate layer (Docker bridge, kernel conntrack entry, TCP stack) to drop the bidirectional data path while leaving both endpoints' socket state as `ESTABLISHED`. Subsequent `res.write()` on the server succeeds locally (bytes go into the kernel send buffer), but the packets never reach the client. The client's fetch body reader waits forever.

`MessageBroker.Completed` at `message-broker.service.ts:92` logs **before** the MCP SDK server writes the tool result to the transport — so its presence only proves the broker resolved, not that the HTTP write reached the client. There is currently no log line at the SDK write boundary or at the `McpController` POST response close. This observability gap is why the exact failure layer is unconfirmed.

## Implementation Details

Execute in two phases. Do **not** ship the speculative fix without the instrumentation phase — QRM4-BUG-002 paid for that lesson twice. An ancillary tool-loop budget bump is bundled below because it mitigates the user-visible impact of the same stalls and can ship independently of the diagnosis.

### Ancillary mitigation — moderator tool-loop budget

Raise `MAX_TOOL_ROUNDS` in `apps/terminal/src/chat/chat.service.ts:18` from 10 to 15. Decoupled from the stall diagnosis and safe to ship on its own. Rationale: the counter already resets per user prompt (fresh `processWithLoop()` per `handleInput`), so this is not a leak fix — it is headroom. Multi-ticket user prompts (create ticket → architect review → implement → code review → fix) approach the 10-round ceiling in the happy path; each stall adds ~3 recovery rounds (2 context queries + 1 verify developer call). 15 absorbs one stall-cycle per turn without the user having to re-prompt, bridging the gap until Phase 2 eliminates the stalls.

### Phase 1 — Instrumentation (ship first, diagnose, then Phase 2)

Add log lines that distinguish "broker completed but SDK never wrote" from "SDK wrote but client never received":

- **At `McpController` (`apps/mcp-server/src/mcp/mcp.controller.ts`):** log when the POST response emits `close` and `finish` events, with the session ID and whether the response completed normally. Today the controller only logs `Session created`/`Session closed`; it has no per-request lifecycle signal.
- **At the SDK write boundary:** wrap the tool handler return in `McpService.registerInvokeAgentTool` (`apps/mcp-server/src/mcp/mcp.service.ts:131-157`) with a debug log immediately before `return { content: [...] }`. If the handler returns but no corresponding response close fires, the SDK is holding the response. If both fire but the client times out, the drop is on the network path.
- **On the terminal side (`apps/terminal/src/connection/mcp-client.service.ts`):** instrument the custom `fetch` wrapper to log when the response stream emits its first byte and when it closes. Today it only creates an `AbortSignal.timeout` — no visibility into whether the stream is producing bytes at all.

Deploy, reproduce (long dev or teamlead invocation, observed to trigger the stall ~50% of the time in QRM5 sessions), and capture one occurrence with the new logs. The log pattern will tell us which specific layer to harden in Phase 2.

### Phase 2 — Hardening (after Phase 1 pinpoints the layer)

Two candidate fixes, both cheap; likely apply both regardless of Phase 1 outcome:

**1. SSE comment-frame heartbeat from the MCP server during in-flight tool calls.** `StreamableHTTPServerTransport` holds the POST response open while the handler runs; emit `:\n\n` comment frames on a 15–30s interval to keep the stream warm and surface a broken connection immediately (write will error rather than silently buffer). The SDK may not expose a hook for this directly — if not, the fix involves a thin wrapper transport or a periodic writer attached to the response object in `McpController`.

**2. TCP keepalive on the transport socket.** Enable `socket.setKeepAlive(true, 30_000)` on the underlying socket for both the server-side HTTP response and the client-side fetch. This causes the kernel to send keepalive probes on idle connections so dead flows are detected and torn down rather than persisting as zombie `ESTABLISHED` sockets. Node HTTP doesn't set this by default.

### What not to do

- **Do not reduce `MCP_REQUEST_TIMEOUT_MS`.** That was QRM4-BUG-002's mistake direction — the 30-min timeout is a safety net, not a fix. Shorter timeouts only mean recovery starts sooner; they don't address the silent stall.
- **Do not retry automatically on stall.** Duplicate-invocation prevention is tracked separately in [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker) and is out of scope here.
- **Do not land Phase 2 without Phase 1 evidence.** Heartbeat + keepalive are plausible fixes, but absent instrumentation we cannot confirm they address the actual failing layer.

## Acceptance Criteria

### Ancillary (tool-loop budget)
- [ ] `MAX_TOOL_ROUNDS` = 15 in `apps/terminal/src/chat/chat.service.ts`

### Phase 1 (instrumentation)
- [ ] `McpController` logs POST response `close` and `finish` events with session ID
- [ ] `McpService.registerInvokeAgentTool` logs immediately before returning the tool result (with correlationId)
- [ ] Terminal `McpClientService` fetch wrapper logs first-byte and stream-close events per request
- [ ] A reproduced stall captures these logs and narrows the failure layer to: (a) SDK server write never happens, (b) server write happens but response never closes, or (c) server closes cleanly but client never sees bytes
- [ ] Diagnostic findings are documented in this ticket's Implementation Notes before Phase 2 begins

### Phase 2 (hardening)
- [ ] SSE heartbeat frames (`:\n\n`) emitted from the MCP server on a configurable interval (default 15–30s) while a tool handler is in flight
- [ ] `setKeepAlive(true, 30_000)` applied to both server-side response sockets and client-side fetch sockets
- [ ] A long-running tool call (≥10 min simulated, e.g., developer handler with an artificial delay) returns its result over Streamable HTTP without stalling, on a fresh session
- [ ] The same long-running call succeeds **twice in a row on the same session** (guards against session-degradation hypothesis from occurrence #2)
- [ ] No `-32001: Request timed out` errors during the validation runs
- [ ] Existing short-duration MCP operations (register, context_query, context_store) are unaffected — no latency regression

## Dependencies and References

- Discovered: 2026-04-17 QRM5-004/QRM5-005 session. Stalled invocations:
  - `c0792d0b-0d61-4a20-98a3-3b300ad0578f` (developer, duration 401029ms)
  - `368d62f7-5225-4f4f-bf36-58ad80a76e4a` (teamlead, duration 309073ms)
- Promoted from [ICEBOX #4](ICEBOX.md#4-silent-stall-of-long-running-tool-responses-over-streamable-http)
- Related: [QRM4-BUG-002](QRM4-BUG-002-mcp-client-timeout-mismatch.md) — same class of bug, opposite direction; see its Fix History for the "diagnose-before-fix" precedent
- Related: [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker) — duplicate-invocation risk amplified by each stall/retry cycle
- `apps/mcp-server/src/mcp/mcp.controller.ts` — Streamable HTTP transport per-session management
- `apps/mcp-server/src/mcp/mcp.service.ts:131-157` — `invoke_agent` tool handler; SDK write boundary
- `apps/mcp-server/src/messaging/message-broker.service.ts:92` — current `Completed` log (pre-SDK-write)
- `apps/terminal/src/connection/mcp-client.service.ts:76-85` — custom `fetch` wrapper (from QRM4-BUG-002 attempt 2)