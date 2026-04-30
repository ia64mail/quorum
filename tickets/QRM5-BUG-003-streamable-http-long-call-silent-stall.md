# QRM5-BUG-003: Silent Stall of Long-Running Tool Responses over Streamable HTTP

**Status:** Re-opened 2026-04-29. Pass-2 client-dispatcher fix resolved the stall for the legacy terminal moderator and agent-to-agent calls but does NOT cover the new QRM6 Claude Code CLI moderator (third-party MCP client we cannot patch from our side). Same 5-minute body-timeout fingerprint reproduced 2026-04-28 EDT (2026-04-29 UTC) during the QRM6-BUG-009 implementation session — see "Implementation Notes — Re-opened (2026-04-29)" below. Server-side hardening (Phase 2 fixes #2 + #3) is now the primary remaining work.

## Summary

Long-running `invoke_agent` tool calls from the moderator to the MCP server occasionally stall on the response path: the agent completes, the broker logs `Completed: success=true`, the work is committed — but the JSON-RPC tool result never surfaces on the moderator's MCP client. The transport's POST socket closes at the ~300 s mark with `writableFinished=false`, and the moderator either times out at the 30-minute `MCP_REQUEST_TIMEOUT_MS` (legacy terminal) or surfaces a "Session identity was lost" recovery and re-registers under a fresh MCP session (QRM6 Claude Code CLI moderator). No errors at any server-side layer — a silent stall in the Streamable HTTP response stream caused by an idle body-timeout on the *client* side.

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

> **Re-opened 2026-04-29.** Pass-2 of fix #1 closed the issue for clients we control (`apps/terminal/`, `apps/agent/`). The QRM6 moderator runs Claude Code CLI — a third-party binary whose MCP client uses its own undici stack we cannot patch. Server-side fixes #2 and #3 — originally deferred as defence-in-depth — are promoted to the primary remaining work and are bundled in this re-open. See "Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)" below for the concrete plan.

**1. Raise (or disable) `server.requestTimeout` on the mcp-server HTTP server.** Node 18+ defaults `http.Server.requestTimeout` to 300_000ms (5 min) and silently kills the response socket when a request exceeds it — this is what the Phase 1 logs caught. Mirror the pattern already used for outgoing calls in `apps/mcp-server/src/registry/http-agent-connection.ts:29-37` (undici `headersTimeout`/`bodyTimeout` raised to 35 min): in `apps/mcp-server/src/main.ts` after `NestFactory.create`, grab the underlying HTTP server via `app.getHttpServer()` and set `requestTimeout` and `headersTimeout` to ≥ `MCP_REQUEST_TIMEOUT_MS` (currently 30 min) so the client-side `AbortController` remains the sole timeout authority. Roughly 3–5 lines.

**2. SSE comment-frame heartbeat from the MCP server during in-flight tool calls.** `StreamableHTTPServerTransport` holds the POST response open while the handler runs; emit `:\n\n` comment frames on a 15–30s interval to keep the stream warm and surface a broken connection immediately (write will error rather than silently buffer). Implement in `McpController.handlePost` as a `setInterval` that writes `: keepalive\n\n` only once `res.headersSent` and content-type contains `text/event-stream`, cleared on `close`/`finish`. Guards against intermediate-layer idle drops (Docker bridge conntrack, NAT, proxies) that `requestTimeout` tuning wouldn't touch.

**3. TCP keepalive on the transport socket.** Enable `socket.setKeepAlive(true, 30_000)` on the underlying socket for both the server-side HTTP response and the client-side fetch. This causes the kernel to send keepalive probes on idle connections so dead flows are detected and torn down rather than persisting as zombie `ESTABLISHED` sockets. Node HTTP doesn't set this by default.

## Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)

This section is the actionable spec for the re-opened work; everything an agent needs to land the fix lives here. The Pass-1/Pass-2 history above stays as historical record.

### Why the existing Pass-2 fix doesn't reach the new moderator

The Pass-2 fix attached a custom `UndiciAgent` dispatcher to **our** `fetch` wrappers:

- `apps/terminal/src/connection/mcp-client.service.ts` — patches the legacy NestJS terminal moderator
- `apps/agent/src/connection/mcp-client.service.ts:28-36` — patches every Quorum agent (architect, developer, teamlead, etc.) including nested agent→agent invokes

Both wrappers wrap `globalThis.fetch` with `undici.fetch` and pass an `Agent({ headersTimeout: 35*60_000, bodyTimeout: 35*60_000 })` dispatcher. Node's built-in `fetch` is undici under the hood, so swapping the dispatcher overrides the 300 000 ms default body-timeout that originally killed the long-poll.

The QRM6 moderator (post QRM6-002) is **Claude Code CLI** — `@anthropic-ai/claude-code@2.1.117`, installed globally via `npm i -g` inside the moderator container (`Dockerfile` `moderator` target). CC CLI ships its own MCP client implementation (Streamable HTTP transport over Node `fetch`) and there is no supported extension point for injecting a custom undici dispatcher. From CC CLI's process the MCP POST request still uses undici defaults.

This means **the next time CC CLI awaits an `invoke_agent` response that takes longer than ~5 min, undici's body-timeout still kills the response stream**. The session collapses, CC CLI reconnects, and the moderator either retries (misdiagnosing as "agent down") or — with the QRM6-007 prompt — surfaces "Session identity was lost. Let me re-register and retry." The fix has to move to the **server side** where we *do* control the wire.

### Fix #2 — SSE comment-frame heartbeat on POST in-flight tool responses

**Goal:** make the response body produce bytes at most every 15–30 s while a tool handler is running, so undici's `bodyTimeout` (or any other intermediate idle-timeout) on the client never trips.

**Where:** `apps/mcp-server/src/mcp/mcp.controller.ts`, `handlePost`. There is already a `startSseKeepalive(res)` helper used by `handleGet` (added in QRM5-BUG-005) that emits `: ping\n\n` every `SSE_KEEPALIVE_INTERVAL_MS` (30 s) and clears on `close`. The same helper applies cleanly to POST — the work is identifying the right place to start it and confirming the POST response is in fact an SSE stream by the time we write.

**SDK behavior to respect:** `StreamableHTTPServerTransport.handleRequest` on POST decides per request whether to respond as a single JSON body (short tool call) or open an SSE stream (long-running tool call). It writes headers (`content-type: text/event-stream`) only once the handler is in flight. We must not write a `:\n\n` comment before headers are flushed — that would corrupt the response — and we must not write to a non-SSE response at all.

**Implementation sketch (drop-in for `handlePost`, after the existing instrumentation block):**

```ts
// QRM5-BUG-003 Phase-2 #2: start SSE comment-frame heartbeat once the
// response is committed as text/event-stream. CC CLI and any other MCP
// client whose undici/equivalent stack defaults bodyTimeout to ~300s
// relies on the stream producing bytes during long-running tool calls.
let keepaliveStarted = false;
const maybeStartKeepalive = () => {
  if (keepaliveStarted || !res.headersSent) return;
  const ct = res.getHeader('content-type');
  if (typeof ct === 'string' && ct.includes('text/event-stream')) {
    this.startSseKeepalive(res);     // existing helper from QRM5-BUG-005
    keepaliveStarted = true;
  }
};
// Poll once headers might be flushed; cheap and bounded.
const headerWatch = setInterval(maybeStartKeepalive, 250);
res.on('finish', () => clearInterval(headerWatch));
res.on('close',  () => clearInterval(headerWatch));
```

The existing `startSseKeepalive` already self-clears on `close`, so once it engages we don't need extra cleanup. If a future SDK version exposes a "headers flushed" event we should switch to that — the 250 ms poll is a stopgap that runs at most ~20 times per long call and stops as soon as the heartbeat takes over.

**Interval value:** keep `SSE_KEEPALIVE_INTERVAL_MS = 30_000`. The killer is undici's 300 s default; a 30 s comment frame leaves 10× headroom and matches the GET-side keepalive used elsewhere. If a future client is found with a tighter default (CC CLI's effective ceiling on 2026-04-29 was 293.7 s — close to 300 s but not exact, so other clients may be tighter), drop to 15 s.

**SSE-spec correctness:** comment lines (`: …\n\n`) are explicitly defined as ignored by SSE consumers (HTML5 §"Server-sent events"). The MCP SDK uses real `event:`/`data:` frames for protocol traffic; comment frames interleaved between them are silently discarded by the receiver. Risk to JSON-RPC framing: zero. Risk to non-SSE responses: avoided by the `content-type` check above.

### Fix #3 — TCP keepalive on transport sockets

**Goal:** when a connection goes truly dead (kernel route flap, container restart, conntrack eviction), have the kernel discover the dead flow within ~30 s and tear it down cleanly. Without this, a dead flow can persist as a zombie `ESTABLISHED` socket that consumes a session slot and leaves both sides waiting indefinitely. This is defence-in-depth alongside fix #2.

**Where (server side):** `apps/mcp-server/src/main.ts` (or a small middleware applied in `McpController.handlePost`/`handleGet`). After `app.listen` returns the HTTP server, attach a `connection` listener:

```ts
const httpServer = app.getHttpServer() as import('node:http').Server;
httpServer.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000);
});
```

`net.Socket.setKeepAlive(true, initialDelay)` enables `SO_KEEPALIVE` and sets `TCP_KEEPIDLE` (initial idle before first probe) to `initialDelay`. Probes default to ~75 s apart, ~9 retries — so a dead flow is detected within ~10 min in the worst case, ~30 s in the common case (first probe fails immediately on a torn-down route). This is enough to converge with fix #2's 30 s heartbeat without further tuning.

**Where (client side):** the same `setKeepAlive` is set automatically by undici's `Agent` when present, but our existing `UndiciAgent` instances in `apps/terminal/src/connection/mcp-client.service.ts` and `apps/agent/src/connection/mcp-client.service.ts` do not configure `connect.keepAliveTimeout`. Add an explicit:

```ts
private readonly dispatcher = new UndiciAgent({
  headersTimeout: 35 * 60_000,
  bodyTimeout:    35 * 60_000,
  connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
});
```

CC CLI is again unreachable, but this still cleans up the agent-side and legacy-terminal-side flows. (Symmetry is the goal: any flow we own gets keepalive; CC CLI relies on fix #2 to surface the dead flow on its own POST.)

### File-by-file change list

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.controller.ts` | In `handlePost`: start `startSseKeepalive(res)` once `res.headersSent` and content-type is `text/event-stream` (poll-via-`setInterval(250 ms)` until either fires `close`/`finish` or keepalive takes over). The existing `startSseKeepalive` helper is reused unchanged. |
| `apps/mcp-server/src/main.ts` | Add `httpServer.on('connection', s => s.setKeepAlive(true, 30_000))` after `app.listen` returns. |
| `apps/terminal/src/connection/mcp-client.service.ts` | Extend the existing `UndiciAgent` to add `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`. |
| `apps/agent/src/connection/mcp-client.service.ts` | Same `connect.keepAlive*` addition on the existing `UndiciAgent`. |
| `apps/mcp-server/src/mcp/mcp.controller.ts` (logging) | Extend the existing `POST close` debug line to additionally include `keepaliveFired=<bool>` so future diagnoses can tell whether fix #2 engaged on a stalled call. Cheap and pays for itself the next time we have to triage. |

### Validation plan

1. **Reproduce the pre-fix stall against CC CLI** before the fix is built, to anchor the baseline. Use the moderator container, invoke a long-running architect or developer task (>5 min), and confirm the `POST close ... writableFinished=false durationMs≈30Xs` pattern. (We already have today's reproduction in the logs — see Re-opened Implementation Notes — so this can also be done by replay rather than fresh repro.)
2. **Apply fix #2 alone** and re-run the same long invocation. Expect: response stream stays alive, tool result delivered cleanly to CC CLI, no "Session identity was lost" narration, mcp-server log shows multiple `: ping\n\n` writes during the handler. The `POST close` line should report `writableFinished=true` with `durationMs` matching the actual handler duration (no 300 s cliff).
3. **Apply fix #3 on top** and verify (a) kernel-level dead-flow detection by killing the moderator container mid-call (the server should observe the socket close within ~30 s rather than indefinitely), and (b) no regression to short-call latency (`context_query`, `register_agent`, `new_conversation` still complete in <100 ms).
4. **Run twice in a row on the same MCP session** to guard against the session-degradation hypothesis from the original Phase 1 occurrence #2.
5. **Smoke test legacy paths** — terminal moderator and an agent→agent nested invoke — to confirm the existing Pass-2 dispatcher fix still works alongside the new server-side keepalive (no double-pinging artifacts, no header-write races).

### Out of scope (still)

- **Reducing `MCP_REQUEST_TIMEOUT_MS`** — same reason as before; the 30 min ceiling is a safety net.
- **Auto-retry on stall** — the moderator's `new_conversation` recovery is already adequate user-visible behavior; the ICEBOX-#1 broker-side dedup work covers the other axis.
- **Patching CC CLI directly** — third-party; not our component. Server-side fix subsumes it for any current or future MCP client.

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

Shipped in two passes:

- **Pass 1 (commit `646ea54`):** Raised `server.requestTimeout`/`headersTimeout` on the mcp-server HTTP server. Based on the 300.7s correlation in the Phase 1 logs, this looked like the fix. It was not — see Pass 2.
- **Pass 2 (this update):** After Pass 1 deployed and a fresh long invocation stalled with the same 300.5s signature (correlationId `b4acdd0b-c9c3-42cc-a10f-c19ec009dd4b`, 2026-04-18 14:29→14:34), root cause was re-diagnosed: the 300s ceiling lives on the **client-side undici dispatcher**, not the server. Shipped the real fix by attaching a custom `UndiciAgent` dispatcher to the terminal and agent `fetch` wrappers.

### Corrected diagnosis

Node's `http.Server.requestTimeout` applies to *receiving a slow incoming request body*, not to a slow response. The `invoke_agent` request body is a small JSON payload received in milliseconds, so the server-side timer never fires for this scenario. Pass 1 raised it anyway, but that fix is orthogonal to the actual stall.

The actual 300s killer is **undici's default `bodyTimeout`** (also 300 000 ms). Node's built-in `fetch` is undici. When the terminal `fetch` wrapper awaits the response body from the MCP POST, undici waits up to `bodyTimeout` for the next byte on that body stream; for a long-running tool handler, the server holds the SSE stream open without writing, and undici kills it at the 5-minute mark. That the outgoing side of the mcp-server already documents this exact default (`apps/mcp-server/src/registry/http-agent-connection.ts:29-37`) for its own 30-min agent calls — and fixes it with a custom `UndiciAgent` dispatcher — was the precedent staring at us. The terminal and agent `fetch` wrappers never got the same treatment.

Log correlation for the Pass-1 failure to repro:

| UTC time       | Event                                                                            |
|----------------|----------------------------------------------------------------------------------|
| 14:29:11.270   | Terminal: "Calling tool: invoke_agent" (correlationId `b4acdd0b…`)                |
| 14:29:11.275   | mcp-server: `invoke_agent: moderator → developer`                                 |
| 14:34:11.799   | mcp-server: `POST close ... writableFinished=false durationMs=300526` ← client cut |
| 14:34:51.294   | mcp-server: `MessageBroker.Completed success=true` (40s after socket died)         |

The socket closure at 300.5s is the terminal's undici dispatcher giving up on the response body — not anything on the server.

### Changes

- `apps/terminal/src/connection/mcp-client.service.ts` — swap global `fetch` → `undici.fetch`; add `UndiciAgent` dispatcher with `headersTimeout: 35 * 60_000`, `bodyTimeout: 35 * 60_000`; cast `init` / response at the type boundary (undici and global DOM types are runtime-compatible but TS-divergent).
- `apps/agent/src/connection/mcp-client.service.ts` — same change; protects nested invokes (agent A → agent B) whose return trip uses the same client wrapper.
- `apps/mcp-server/src/main.ts` — Pass-1 change kept. Comment rewritten to state the truth: this is defence-in-depth, not the primary fix. Reason for keeping: it's already shipped, it's cheap, and it preserves the "client AbortController is the sole timeout authority" invariant end-to-end, matching the outgoing side's same +5-min margin.

### Deviations from the Phase 2 plan

1. **Primary fix moved client-side.** The plan put `server.requestTimeout` as fix #1 based on Phase 1's 300s correlation, but that turned out to be the wrong layer (see Corrected diagnosis). The real primary fix is an undici dispatcher on the terminal/agent fetch wrappers — same *shape* as the plan, different *side* of the wire.
2. **Symmetry: agent client also patched.** The original plan focused on terminal↔mcp-server. Agent↔mcp-server has the identical default-undici issue for nested invokes, so the same dispatcher was applied to `apps/agent/src/connection/mcp-client.service.ts`.
3. **+5 min margin, not disabled.** Mirrors `http-agent-connection.ts` exactly (client 30 min → undici 35 min). Bounded margin keeps a safety ceiling instead of letting a runaway handler hold sockets forever.
4. **TypeScript boundary casts.** The global `fetch` / DOM `Response` types and undici's own types are runtime-compatible but TS-divergent (global Blob vs buffer.Blob, `stream/web` vs global ReadableStream). Applied narrow casts at the call site (`init as Parameters<typeof undiciFetch>[1]`, `response as unknown as Response`) rather than weakening the signature — keeps the fetch option's type contract with the MCP SDK.
5. **Server-side `requestTimeout` kept, not reverted.** Pass-1 commit `646ea54` is left in place as defence-in-depth with an updated comment reflecting its real role. Reverting would churn another commit and weaken the (admittedly edge-case) slowloris margin without benefit.

### Not yet done (intentionally deferred)

- SSE heartbeat (Phase 2 fix #2) — defence-in-depth against intermediate-layer idle drops (Docker bridge conntrack, NAT, proxies).
- TCP keepalive (Phase 2 fix #3) — defence-in-depth against zombie ESTABLISHED sockets.

Reassess after the next long-running session under the new dispatcher. If stalls disappear, both may stay deferred; if a different signature appears (e.g., client sees first byte then mid-stream drop), #2 is the next move.

### Validation state

Build + lint + tests (47 suites / 700 tests) pass. Runtime validation requires rebuilding the terminal and agent docker images and rerunning a >5-min developer invocation to confirm the stall is gone.

## Implementation Notes — Re-opened (2026-04-29): CC CLI moderator hits the same stall

The Pass-2 client-dispatcher fix above closed the issue for the legacy terminal moderator and for agent-to-agent nested invokes. The QRM6 moderator (containerized Claude Code CLI, QRM6-002 / QRM6-007) is a third-party MCP client that ships its own undici stack with no extension point for swapping a dispatcher — so the fix never reached it. The same 5-minute body-timeout fingerprint reproduced 2026-04-28 EDT during the QRM6-BUG-009 implementation session.

### Reproduction (session `20260429T015120` UTC, correlationId `cd283ccb-d752-4088-82f3-4e62a24abc08`)

Goal that day: implement QRM6-BUG-009 (moderator entrypoint settings.json merge). The session did `architect → architect → developer → teamlead /code-review v1`. v1 returned cleanly. The user then asked an unrelated CC CLI permission-UX question and said "continue"; the moderator misread that and re-fired the same `/code-review` (v2) on the same correlationId. v1's POST to mcp-server was *still in undici's response-buffer window* when v2's POST went out on the same MCP session. Both POSTs collapsed simultaneously at the 5-minute boundary on the older one:

| UTC time     | Event                                                                                                | Source     |
|--------------|------------------------------------------------------------------------------------------------------|------------|
| 02:14:36.685 | `invoke_agent: moderator → teamlead [cd283ccb]` (POST #1 starts on session `cd4aa749…`)              | mcp-server |
| 02:17:15.124 | Teamlead invocation #1 completes (`success=true`, $0.56, 21 turns)                                   | mcp-server |
| 02:17:35.470 | `invoke_agent: moderator → teamlead [cd283ccb]` again — duplicate (POST #2 starts on `cd4aa749…`)     | mcp-server |
| **02:19:30.393** | **`POST close: sessionId=cd4aa749… status=200 writableFinished=false durationMs=293709`** (POST #1) | **mcp-server** |
| **02:19:30.402** | **`POST close: sessionId=cd4aa749… status=200 writableFinished=false durationMs=114934`** (POST #2) | **mcp-server** |
| 02:19:30.408 | `Session created: 00f48d57-…` (CC CLI reconnects)                                                    | mcp-server |
| 02:19:30.413 | `Session created: 2fe6146e-…` (CC CLI reconnects, second new session)                                 | mcp-server |
| 02:19:33.145 | `Registered agent: moderator` — CC CLI re-registers (3rd registration in this run)                   | mcp-server |
| 02:19:36.087 | `invoke_agent: moderator → teamlead [587a2523]` — fresh correlationId (new_conversation)             | mcp-server |
| 02:20:36.318 | Teamlead invocation #2 completes ($0.56, 25 turns) — but no live MCP session to deliver result        | mcp-server |
| 02:22:03.561 | Teamlead invocation #3 completes ($0.44, 25 turns) — `587a2523` correlationId, ACCEPT verdict reaches CC CLI | mcp-server |

**Smoking gun:** two POSTs on the same MCP session `cd4aa749-…` closed at the same instant (02:19:30.393 vs 02:19:30.402, 9 ms apart) with `writableFinished=false`. Their ages were 293.709 s and 114.934 s. The 293.7 s figure lands at the canonical undici-default boundary (300 000 ms `bodyTimeout`, minus initial-connection setup). The 114.9 s figure is just collateral — it was on the same session and the session went away. No `warn`/`error` lines on the server side in this window. Within 20 ms CC CLI established two fresh MCP sessions (`00f48d57-…`, `2fe6146e-…`) and re-fired `register_agent` 3 s later.

This is exactly the Pass-1 / Pass-2 fingerprint (`POST close … writableFinished=false durationMs≈300xxx`) — but on the wire from CC CLI's MCP client, which the dispatcher fix does not patch. So the fix has to move to the server side: emit bytes to keep the client's body-timeout ticker rolling.

### Why the moderator doesn't hang for 30 minutes anymore

In the original 2026-04-17/18 reproductions on the legacy terminal, the silent stall manifested as a 30-minute frozen prompt (waiting for `MCP_REQUEST_TIMEOUT_MS` to fire). The QRM6 moderator surfaces the failure faster because:

1. CC CLI reacts to its own MCP-session abort by spinning up a new session and re-registering. The moderator doesn't sit waiting for a single timeout — it gets a transport-level error, not silent buffering.
2. The QRM6-007 prompt instructs the moderator to call `new_conversation` on each turn and to narrate session loss explicitly. Today's run is the first occasion where the moderator actually emitted **"Session identity was lost. Let me re-register and retry."** to the user.

That is a real UX improvement, but it's masking — not solving — the underlying stall. The cost shows up elsewhere: today's run wasted ~$0.56 on a duplicate teamlead `/code-review` whose response the moderator could not see, plus context-store collisions on the same key (`project:_:QRM6-BUG-009-project-notes`, last-write-wins between v1 and v2), and a verdict that landed under a fresh correlationId (`587a2523`) different from the rest of the audit trail (`cd283ccb`). Once the server-side heartbeat lands, the moderator should never enter the recovery path for this cause again.

### Implication

The Phase 2 plan above already specified the right fix for the third-party-client case: SSE comment-frame heartbeat (#2) + TCP keepalive (#3). They were deferred when the dispatcher fix appeared sufficient. Today's evidence promotes both to required.

The detailed plan, file list, and validation procedure live in **Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)** above; that section is the single source of truth for the fix. The session report `logs/sessions/2026-04-28-qrm6-run2.md` references this ticket as the canonical record — do not duplicate the analysis there.

## Acceptance Criteria

### Ancillary (tool-loop budget)
- [ ] `MAX_TOOL_ROUNDS` = 15 in `apps/terminal/src/chat/chat.service.ts`

### Phase 1 (instrumentation)
- [ ] `McpController` logs POST response `close` and `finish` events with session ID
- [ ] `McpService.registerInvokeAgentTool` logs immediately before returning the tool result (with correlationId)
- [ ] Terminal `McpClientService` fetch wrapper logs first-byte and stream-close events per request
- [ ] A reproduced stall captures these logs and narrows the failure layer to: (a) SDK server write never happens, (b) server write happens but response never closes, or (c) server closes cleanly but client never sees bytes
- [ ] Diagnostic findings are documented in this ticket's Implementation Notes before Phase 2 begins

### Phase 2 (hardening) — original

- [x] `server.requestTimeout` (and `headersTimeout`) on the mcp-server HTTP server raised to ≥ `MCP_REQUEST_TIMEOUT_MS` (defence-in-depth; not the primary cause — see Implementation Notes)
- [x] Custom `UndiciAgent` dispatcher with `headersTimeout`/`bodyTimeout` = 35 min applied to the terminal fetch wrapper (`apps/terminal/src/connection/mcp-client.service.ts`) — primary fix for legacy terminal moderator
- [x] Same dispatcher applied to the agent fetch wrapper (`apps/agent/src/connection/mcp-client.service.ts`) for nested-invoke symmetry

### Phase 2 (hardening) — re-opened 2026-04-29 for the QRM6 CC CLI moderator

- [ ] **Fix #2 (SSE heartbeat)** — `McpController.handlePost` starts the existing `startSseKeepalive(res)` helper once `res.headersSent` is true and `content-type` includes `text/event-stream`; clears on `close`/`finish`. Reuse the QRM5-BUG-005 helper unchanged so behavior matches the GET path.
- [ ] **Fix #2 logging** — extend the existing `POST close` debug line in `McpController.handlePost` to include `keepaliveFired=<bool>` so future stalls can be triaged from the log alone.
- [ ] **Fix #3 (server-side TCP keepalive)** — `apps/mcp-server/src/main.ts` attaches `connection` listener after `app.listen` that calls `socket.setKeepAlive(true, 30_000)` on every incoming socket.
- [ ] **Fix #3 (client-side TCP keepalive)** — extend the existing `UndiciAgent` instances in `apps/terminal/src/connection/mcp-client.service.ts` and `apps/agent/src/connection/mcp-client.service.ts` with `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`.
- [ ] **Reproducible CC CLI long-call repro** — moderator container, one `invoke_agent` to a slow target (≥6 min synthetic delay or a real architect/teamlead task) on the same MCP session. Pre-fix logs show the 300 s `writableFinished=false` close pattern; post-fix logs show normal completion with periodic `: ping\n\n` writes interleaved.
- [ ] **No "Session identity was lost" recovery narration** in the moderator's CC CLI session log for the validation run.
- [ ] **Same-session two-in-a-row** — two consecutive long calls on a single MCP session, both deliver cleanly (regression guard for the original session-degradation hypothesis).
- [ ] **Dead-flow detection** — kill the moderator container mid-call; mcp-server observes `POST close` within ~30–60 s rather than indefinitely. (Validates fix #3.)
- [ ] **No latency regression** — short-duration ops (`register_agent`, `context_query`, `context_store`, `new_conversation`) still complete in <100 ms.
- [ ] **Build + lint + tests pass** (`npm run build && npm run lint && npm run test`).

## Dependencies and References

- Discovered: 2026-04-17 QRM5-004/QRM5-005 session. Stalled invocations:
  - `c0792d0b-0d61-4a20-98a3-3b300ad0578f` (developer, duration 401029ms)
  - `368d62f7-5225-4f4f-bf36-58ad80a76e4a` (teamlead, duration 309073ms)
- Re-reproduced 2026-04-18 QRM5-006 session with Phase 1 instrumentation: `55dd5ed5-3a87-45dc-8744-8267fa2472a7` (developer, handlerMs=304799). POST socket closed at `durationMs=300705` with `writableFinished=false` — see Implementation Notes.
- Re-reproduced 2026-04-18 after Pass-1 server-side fix landed: `b4acdd0b-c9c3-42cc-a10f-c19ec009dd4b` (developer, handlerMs=340019). Same `durationMs=300526` `writableFinished=false` close. Triggered the corrected client-side diagnosis and the Pass-2 undici dispatcher fix.
- **Re-opened 2026-04-29 from the QRM6-BUG-009 implementation session** (`20260429T015120` UTC). Two POSTs on MCP session `cd4aa749-…` collapsed simultaneously with `writableFinished=false` at `durationMs=293709` and `durationMs=114934`; CC CLI immediately re-established sessions `00f48d57-…` and `2fe6146e-…` and re-fired `register_agent`. Full timeline in "Implementation Notes — Re-opened (2026-04-29)" above. Source logs: `logs/mcp-server-20260429T015120.jsonl`. Moderator narration captured in `quorum_moderator-claude-data:/projects/-app/c5f7c848-….jsonl`.
- Promoted from [ICEBOX #4](ICEBOX.md#4-silent-stall-of-long-running-tool-responses-over-streamable-http)
- Related: [QRM4-BUG-002](QRM4-BUG-002-mcp-client-timeout-mismatch.md) — same class of bug, opposite direction; see its Fix History for the "diagnose-before-fix" precedent
- Related: [QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md) — added `startSseKeepalive(res)` helper used by GET path; the re-opened fix #2 reuses this helper for POST.
- Related: [QRM6-BUG-007](QRM6-BUG-007-mcp-session-cleanup-not-firing.md) — server-side cleanup of dead moderator MCP sessions; complementary, not a substitute (cleanup runs *after* the session has died; this ticket prevents the session from dying for stalls).
- Related: [QRM6-BUG-010](QRM6-BUG-010-broker-timeout-causes-retry-storm-duplicate-sdk-sessions.md) — agent-side dedup for retry storms; orthogonal cause but interacts (today's stall produced a same-correlationId retry that the new dedup did *not* catch because v1 had already returned before v2 fired).
- Related: [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker) — duplicate-invocation risk amplified by each stall/retry cycle
- `apps/mcp-server/src/mcp/mcp.controller.ts` — Streamable HTTP transport per-session management; primary modification target for fix #2 (POST keepalive). Existing `startSseKeepalive(res)` at lines 154–166 is reused.
- `apps/mcp-server/src/main.ts` — modification target for fix #3 (server-side `setKeepAlive`).
- `apps/mcp-server/src/mcp/mcp.service.ts:131-157` — `invoke_agent` tool handler; SDK write boundary.
- `apps/mcp-server/src/messaging/message-broker.service.ts:92` — `Completed` log (pre-SDK-write).
- `apps/terminal/src/connection/mcp-client.service.ts` — legacy terminal undici dispatcher (Pass-2 fix); modification target for fix #3 client-side keepalive.
- `apps/agent/src/connection/mcp-client.service.ts:28-36` — agent-side undici dispatcher (Pass-2 fix); modification target for fix #3 client-side keepalive.
- `Dockerfile` (`moderator` target) and `docker/moderator/settings.json` — installs `@anthropic-ai/claude-code@2.1.117` globally; documents why CC CLI is the third-party MCP client we cannot reach with a dispatcher patch.