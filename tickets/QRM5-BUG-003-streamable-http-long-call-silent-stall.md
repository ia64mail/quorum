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

Phase 1 evidence (see Implementation Notes below) points to Node's HTTP `server.requestTimeout` as the dominant cause. Land fix #1 first; #2 and #3 are defence-in-depth.

**1. Raise (or disable) `server.requestTimeout` on the mcp-server HTTP server.** Node 18+ defaults `http.Server.requestTimeout` to 300_000ms (5 min) and silently kills the response socket when a request exceeds it — this is what the Phase 1 logs caught. Mirror the pattern already used for outgoing calls in `apps/mcp-server/src/registry/http-agent-connection.ts:29-37` (undici `headersTimeout`/`bodyTimeout` raised to 35 min): in `apps/mcp-server/src/main.ts` after `NestFactory.create`, grab the underlying HTTP server via `app.getHttpServer()` and set `requestTimeout` and `headersTimeout` to ≥ `MCP_REQUEST_TIMEOUT_MS` (currently 30 min) so the client-side `AbortController` remains the sole timeout authority. Roughly 3–5 lines.

**2. SSE comment-frame heartbeat from the MCP server during in-flight tool calls.** `StreamableHTTPServerTransport` holds the POST response open while the handler runs; emit `:\n\n` comment frames on a 15–30s interval to keep the stream warm and surface a broken connection immediately (write will error rather than silently buffer). Implement in `McpController.handlePost` as a `setInterval` that writes `: keepalive\n\n` only once `res.headersSent` and content-type contains `text/event-stream`, cleared on `close`/`finish`. Guards against intermediate-layer idle drops (Docker bridge conntrack, NAT, proxies) that `requestTimeout` tuning wouldn't touch.

**3. TCP keepalive on the transport socket.** Enable `socket.setKeepAlive(true, 30_000)` on the underlying socket for both the server-side HTTP response and the client-side fetch. This causes the kernel to send keepalive probes on idle connections so dead flows are detected and torn down rather than persisting as zombie `ESTABLISHED` sockets. Node HTTP doesn't set this by default.

### What not to do

- **Do not reduce `MCP_REQUEST_TIMEOUT_MS`.** That was QRM4-BUG-002's mistake direction — the 30-min timeout is a safety net, not a fix. Shorter timeouts only mean recovery starts sooner; they don't address the silent stall.
- **Do not retry automatically on stall.** Duplicate-invocation prevention is tracked separately in [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker) and is out of scope here.
- **Do not land Phase 2 without Phase 1 evidence.** Heartbeat + keepalive are plausible fixes, but absent instrumentation we cannot confirm they address the actual failing layer.

## Implementation Notes — Phase 1 Findings (2026-04-18)

Instrumentation deployed 2026-04-17 caught a reproduction on 2026-04-18 during the QRM5-006 implementation session. The logs pinpoint the failing layer unambiguously: **the mcp-server HTTP server is terminating the response socket at ~300s before the tool handler returns.**

**Reproduction timeline (correlationId `55dd5ed5-3a87-45dc-8744-8267fa2472a7`, moderator → developer):**

| UTC time       | Event                                                                 | Source                     |
|----------------|-----------------------------------------------------------------------|----------------------------|
| 13:22:32.351   | `invoke_agent` received by McpService                                 | mcp-server                 |
| 13:22:32.387   | Developer InvocationHandler: "Invocation received"                    | developer                  |
| 13:22:32→13:27:37 | Developer executes the ticket (read files, write code, build, lint, test, commit) | developer          |
| **13:27:33.054** | **`POST close: sessionId=f105acc9... writableFinished=false durationMs=300705`** | **mcp-server** |
| 13:27:37.094   | Developer: "Invocation complete"                                      | developer                  |
| 13:27:37.150   | `MessageBroker.Completed: target=developer success=true`              | mcp-server                 |
| 13:27:37.151   | `invoke_agent returning: success=true handlerMs=304799`               | mcp-server (SDK write)     |
| ~13:52:32      | Expected client-side 30-min timeout recovery                          | terminal                   |

**Smoking gun:** the server-side POST response socket closed with `writableFinished=false` at `durationMs=300705` (≈5:00.7) — four seconds *before* the broker resolved and the SDK tried to write the result. When the SDK's `res.write(...)` fired, the response was already dead. All three prior successful invokes on the same session completed in under 300s (291 745, 294 505, 225 402 ms) and closed cleanly (`writableFinished=true`). The handler that crossed the 300s line got killed.

**Layer classification vs. Phase 1 acceptance criteria:** this is **not** case (c) "server closes cleanly but client never sees bytes" — the prior working hypothesis. It is a variant of case (b): the server's response stream is closed by the Node HTTP stack itself *before* the tool handler returns, so there is no clean SDK write for the client to ever receive. The SSE stream never sees the final JSON-RPC response because the response object is already finished.

**Root cause:** Node.js `http.Server.requestTimeout` defaults to 300 000ms in Node 18+. The MCP server's Express app was never tuned, so `requestTimeout` is silently enforcing a 5-minute ceiling on every POST. The exact 300.7s duration at the kill boundary matches this default to well within single-digit seconds of jitter.

**Corroborating evidence already in the codebase:** `apps/mcp-server/src/registry/http-agent-connection.ts:29-37` documents the exact same 300s default on the *outgoing* undici side and raises both `headersTimeout` and `bodyTimeout` to 35 minutes for agent calls. The incoming HTTP server is the mirror case that was missed.

**Implication for Phase 2 ordering:** fix #1 (`server.requestTimeout` tuning) is now the primary fix and directly addresses the confirmed failing layer. Fixes #2 (heartbeat) and #3 (keepalive) stay on the plan as defence-in-depth against intermediate-layer idle drops that `requestTimeout` alone does not cover (Docker bridge conntrack, NAT, proxies), but they are no longer blocking.

## Implementation Notes — Phase 2 Fix #1 (2026-04-18)

Applied only fix #1 (`server.requestTimeout` tuning). Fixes #2 (heartbeat) and #3 (keepalive) deferred — not blocking now that the confirmed failing layer is addressed.

**Change:** `apps/mcp-server/src/main.ts` — after `NestFactory.create`, grab the underlying `http.Server` via `app.getHttpServer()` and set `requestTimeout` and `headersTimeout` to `MCP_REQUEST_TIMEOUT_MS + 5 min` (35 min default).

```ts
const clientTimeoutMs = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 1_800_000;
const serverTimeoutMs = clientTimeoutMs + 5 * 60_000;
const httpServer = app.getHttpServer() as Server;
httpServer.requestTimeout = serverTimeoutMs;
httpServer.headersTimeout = serverTimeoutMs;
```

**Deviations from the Phase 2 plan:**

1. **Env read, not ConfigService injection.** The plan implied reading through `config.mcp.requestTimeoutMs`, but `McpServerConfigService` does not currently expose `mcp` — that config module is consumed by clients (terminal, agent). Widening the server-side ConfigService for a single bootstrap-time value would be disproportionate, so `main.ts` reads `process.env.MCP_REQUEST_TIMEOUT_MS` directly with the same `1_800_000` fallback hardcoded in `libs/common/src/config/mcp.config.ts:12`. If a future change requires the same value elsewhere on the server, promote to a proper `mcp` server config then.

2. **+5 min margin, not disabled (`0`).** The plan mentioned "≥ `MCP_REQUEST_TIMEOUT_MS` (or disabled)". Chose a bounded margin over disabling because it matches the precedent already set for the outgoing undici dispatcher in `apps/mcp-server/src/registry/http-agent-connection.ts:29-37` (same +5-min shape there: client 30 min → undici 35 min). Keeps a safety ceiling — a runaway handler will still be killed eventually rather than holding sockets forever.

3. **Also set `headersTimeout`, not just `requestTimeout`.** Node requires `headersTimeout ≤ requestTimeout` (else it warns and clamps). Raising both together avoids a silent clamp surprise if defaults ever shift.

**Not yet done (intentionally deferred):**
- SSE heartbeat (Phase 2 fix #2) — ~15–25 lines in `McpController.handlePost` plus a config knob. Defence-in-depth against intermediate-layer idle drops.
- TCP keepalive (Phase 2 fix #3) — `setKeepAlive(true, 30_000)` on both sides. Defence-in-depth against zombie ESTABLISHED sockets.

Reassess need for #2 and #3 after the next long-running session under the new `requestTimeout`. If stalls fully disappear, they may stay deferred; if a different stall signature appears (e.g., no POST close event, client never sees bytes despite handler returning), #2 is the next move.

**Validation state:** build + lint pass on the change. Runtime validation requires rebuilding the mcp-server docker image and rerunning a long (>5 min) developer invocation to confirm the stall is gone.

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
- [ ] `server.requestTimeout` (and `headersTimeout`) on the mcp-server HTTP server raised to ≥ `MCP_REQUEST_TIMEOUT_MS` (or disabled), matching the pattern in `apps/mcp-server/src/registry/http-agent-connection.ts:29-37`
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
- Re-reproduced 2026-04-18 QRM5-006 session with Phase 1 instrumentation: `55dd5ed5-3a87-45dc-8744-8267fa2472a7` (developer, handlerMs=304799). POST socket closed at `durationMs=300705` with `writableFinished=false` — see Implementation Notes.
- Promoted from [ICEBOX #4](ICEBOX.md#4-silent-stall-of-long-running-tool-responses-over-streamable-http)
- Related: [QRM4-BUG-002](QRM4-BUG-002-mcp-client-timeout-mismatch.md) — same class of bug, opposite direction; see its Fix History for the "diagnose-before-fix" precedent
- Related: [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker) — duplicate-invocation risk amplified by each stall/retry cycle
- `apps/mcp-server/src/mcp/mcp.controller.ts` — Streamable HTTP transport per-session management
- `apps/mcp-server/src/mcp/mcp.service.ts:131-157` — `invoke_agent` tool handler; SDK write boundary
- `apps/mcp-server/src/messaging/message-broker.service.ts:92` — current `Completed` log (pre-SDK-write)
- `apps/terminal/src/connection/mcp-client.service.ts:76-85` — custom `fetch` wrapper (from QRM4-BUG-002 attempt 2)