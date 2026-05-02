# QRM6-BUG-011: Server-Side SSE Heartbeat and TCP Keepalive for Third-Party MCP Clients

**Status: Implemented** — SSE heartbeat on POST and TCP keepalive added (commit b826ca7)

## Summary

Emit SSE comment-frame heartbeats and enable TCP keepalive on the MCP server to prevent 5-minute undici `bodyTimeout` stalls on third-party MCP clients (CC CLI moderator) during long-running `invoke_agent` POST responses. The client-side undici dispatcher fix shipped in QRM5-BUG-003 (Pass 2) resolved the stall for Quorum-controlled clients but cannot reach CC CLI — a third-party binary with its own undici stack and no extension point for a custom dispatcher. The fix must move server-side.

## Problem Statement

### Why the existing Pass-2 fix doesn't reach the CC CLI moderator

The Pass-2 fix attached a custom `UndiciAgent` dispatcher (with `bodyTimeout: 35 * 60_000`) to **our** `fetch` wrappers in `apps/terminal/src/connection/mcp-client.service.ts` and `apps/agent/src/connection/mcp-client.service.ts`. These override the 300 000 ms default body-timeout that killed long-poll response streams.

The QRM6 moderator (post QRM6-002) is **Claude Code CLI** — `@anthropic-ai/claude-code`, installed globally inside the moderator container. CC CLI ships its own MCP client implementation (Streamable HTTP transport over Node `fetch`) with no supported extension point for injecting a custom undici dispatcher. From CC CLI's process, the MCP POST request still uses undici defaults.

This means the next time CC CLI awaits an `invoke_agent` response longer than ~5 min, undici's body-timeout kills the response stream. The session collapses, CC CLI reconnects, and the moderator either retries (misdiagnosing as "agent down") or surfaces "Session identity was lost. Let me re-register and retry." The fix must live on the **server side** where we control the wire.

### Reproduction (2026-04-29, session `20260429T015120` UTC)

During the QRM6-BUG-009 implementation session, two POSTs on MCP session `cd4aa749-…` collapsed simultaneously with `writableFinished=false`:

| UTC time     | Event                                                                                                | Source     |
|--------------|------------------------------------------------------------------------------------------------------|------------|
| 02:14:36.685 | `invoke_agent: moderator → teamlead [cd283ccb]` (POST #1 starts on session `cd4aa749…`)              | mcp-server |
| 02:17:15.124 | Teamlead invocation #1 completes (`success=true`, $0.56, 21 turns)                                   | mcp-server |
| 02:17:35.470 | `invoke_agent: moderator → teamlead [cd283ccb]` again — duplicate (POST #2 starts on `cd4aa749…`)     | mcp-server |
| **02:19:30.393** | **`POST close: sessionId=cd4aa749… status=200 writableFinished=false durationMs=293709`** (POST #1) | **mcp-server** |
| **02:19:30.402** | **`POST close: sessionId=cd4aa749… status=200 writableFinished=false durationMs=114934`** (POST #2) | **mcp-server** |
| 02:19:30.408 | `Session created: 00f48d57-…` (CC CLI reconnects)                                                    | mcp-server |
| 02:19:33.145 | `Registered agent: moderator` — CC CLI re-registers (3rd registration in this run)                   | mcp-server |
| 02:19:36.087 | `invoke_agent: moderator → teamlead [587a2523]` — fresh correlationId (new_conversation)             | mcp-server |

**Smoking gun:** POST #1 closed at `durationMs=293709` — the canonical undici-default boundary (300 000 ms `bodyTimeout` minus connection setup). POST #2 was collateral on the same dead session. Within 20 ms CC CLI established fresh sessions and re-fired `register_agent`. This is exactly the QRM5-BUG-003 Pass-1/Pass-2 fingerprint but on a wire we cannot patch client-side.

### Why the moderator doesn't hang for 30 minutes anymore

Unlike the original QRM5 stall (30-minute frozen prompt), the QRM6 moderator recovers faster: CC CLI reacts to its own session abort by spinning up a new session, and the QRM6-007 prompt instructs the moderator to call `new_conversation` and narrate session loss. This masks — but doesn't solve — the underlying stall. Cost: wasted agent invocations ($0.56+), context-store collisions on the same key (last-write-wins between duplicate invocations), and audit-trail fragmentation across correlationIds.

## Design Context

During a long-running `invoke_agent` (5–10+ min), the SSE response stream on the POST carries **zero bytes** — the MCP SDK does not emit heartbeats while a tool handler is running. The client's `fetch` body reader waits, but undici's `bodyTimeout` clock is ticking. At ~300 s with no bytes, undici kills the response.

**SSE comment frames** (`: …\n\n`) are the correct fix. The SSE specification defines comment lines as no-ops — silently discarded by consumers. The MCP SDK uses `event:`/`data:` frames for JSON-RPC traffic; interleaved comments are invisible to it. Emitting a comment every 30 s keeps undici's body-timeout from tripping (10× headroom below the 300 s default) while adding zero semantic load. The MCP server already has a `startSseKeepalive(res)` helper (QRM5-BUG-005) used by the GET path — the same helper applies to POST.

**TCP keepalive** is defence-in-depth. When a connection goes truly dead (kernel route flap, container restart, conntrack eviction), TCP keepalive probes detect the dead flow within ~30 s and tear it down cleanly, rather than leaving zombie `ESTABLISHED` sockets.

## Implementation Details

### Fix #2 — SSE comment-frame heartbeat on POST in-flight tool responses

**Goal:** Make the response body produce bytes at most every 30 s while a tool handler is running, so undici's `bodyTimeout` (or any intermediate idle-timeout) on the client never trips.

**Where:** `apps/mcp-server/src/mcp/mcp.controller.ts`, `handlePost`. The existing `startSseKeepalive(res)` helper (added in QRM5-BUG-005) emits `: ping\n\n` every `SSE_KEEPALIVE_INTERVAL_MS` (30 s) and clears on `close`. Reuse it for POST — the work is identifying the right insertion point and confirming the POST response is an SSE stream before writing.

**SDK behavior to respect:** `StreamableHTTPServerTransport.handleRequest` on POST decides per-request whether to respond as a single JSON body (short tool call) or open an SSE stream (long-running tool call). Headers (`content-type: text/event-stream`) are written only once the handler is in flight. We must not write a comment frame before headers are flushed (would corrupt the response) and must not write to a non-SSE response at all.

**Implementation sketch (drop-in for `handlePost`, after the existing instrumentation block):**

```ts
// QRM6-BUG-011 Fix #2: start SSE comment-frame heartbeat once the
// response is committed as text/event-stream. CC CLI and any other MCP
// client whose undici/equivalent stack defaults bodyTimeout to ~300s
// relies on the stream producing bytes during long-running tool calls.
let keepaliveStarted = false;
const maybeStartKeepalive = () => {
  if (res.writableEnded) { clearInterval(headerWatch); return; }
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

Key details:
- **`writableEnded` early-exit** at the top of the polling callback: for quick JSON responses (`register_agent`, `context_query`), the response finishes in <10 ms; checking `writableEnded` avoids 1–4 wasted interval ticks before event cleanup fires.
- **`startSseKeepalive` should have a try/catch around `res.write`:** if the socket is destroyed (not just ended), `res.write` could throw. Wrap in try/catch with `clearInterval` on error. Cheap insurance alongside the `writableEnded` guard.
- The existing `startSseKeepalive` already self-clears on `close`, so once it engages there is no extra cleanup.
- If a future SDK version exposes a "headers flushed" event, switch to that — the 250 ms poll is a stopgap that runs at most ~20 times per long call and stops as soon as the heartbeat takes over.

**Interval value:** Keep `SSE_KEEPALIVE_INTERVAL_MS = 30_000`. The killer is undici's 300 s default; 30 s leaves 10× headroom.

**Logging:** Extend the existing `POST close` debug line in `McpController.handlePost` to include `keepaliveFired=<bool>` so future stalls can be triaged from the log alone.

**Validation that short calls are unaffected:** Confirm that JSON-response POSTs (e.g., `context_query`, `register_agent`) don't receive spurious `: ping` comment frames. The content-type guard should prevent this, but explicitly verify from the logs.

### Fix #3 — TCP keepalive on transport sockets

**Goal:** When a connection goes truly dead, have the kernel discover the dead flow within ~30 s and tear it down cleanly. Without this, a dead flow persists as a zombie `ESTABLISHED` socket.

**Server side** (`apps/mcp-server/src/main.ts`): After the existing `requestTimeout`/`headersTimeout` block, attach a `connection` listener:

```ts
const httpServer = app.getHttpServer() as import('node:http').Server;
httpServer.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000);
});
```

`net.Socket.setKeepAlive(true, initialDelay)` enables `SO_KEEPALIVE` and sets `TCP_KEEPIDLE` to `initialDelay`. Probes default to ~75 s apart, ~9 retries — dead flow detected within ~10 min worst case, ~30 s common case.

**Client side** (`apps/terminal/src/connection/mcp-client.service.ts` and `apps/agent/src/connection/mcp-client.service.ts`): Extend the existing `UndiciAgent` instances with `connect` options:

```ts
private readonly dispatcher = new UndiciAgent({
  headersTimeout: 35 * 60_000,
  bodyTimeout:    35 * 60_000,
  connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
});
```

CC CLI is unreachable client-side, but this cleans up agent-side and legacy-terminal-side flows. Fix #2 (heartbeat) is what protects CC CLI on the server side.

### File-by-file change list

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.controller.ts` | In `handlePost`: start `startSseKeepalive(res)` once `res.headersSent` and content-type is `text/event-stream` (poll via `setInterval(250 ms)` with `writableEnded` early-exit, cleared on `close`/`finish`). Add try/catch in `startSseKeepalive` around `res.write` for destroyed sockets. |
| `apps/mcp-server/src/mcp/mcp.controller.ts` (logging) | Extend existing `POST close` debug line to include `keepaliveFired=<bool>`. |
| `apps/mcp-server/src/main.ts` | Add `httpServer.on('connection', s => s.setKeepAlive(true, 30_000))` after the existing timeout block. |
| `apps/terminal/src/connection/mcp-client.service.ts` | Extend the existing `UndiciAgent` with `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`. |
| `apps/agent/src/connection/mcp-client.service.ts` | Same `connect.keepAlive*` addition on the existing `UndiciAgent`. |

### Validation plan

1. **Reproduce the pre-fix stall against CC CLI** before the fix is built, to anchor the baseline. Use the moderator container, invoke a long-running architect or developer task (>5 min). Confirm the `POST close … writableFinished=false durationMs≈300s` pattern. (Alternatively, use the existing 2026-04-29 reproduction logs.)
2. **Apply fix #2 alone** and re-run the same long invocation. Expect: response stream stays alive, tool result delivered cleanly to CC CLI, no "Session identity was lost" narration, mcp-server log shows multiple `: ping\n\n` writes during the handler. The `POST close` line should report `writableFinished=true` with `durationMs` matching the actual handler duration (no 300 s cliff). Verify short-duration JSON POSTs don't receive spurious comment frames.
3. **Apply fix #3 on top** and verify: (a) kernel-level dead-flow detection by killing the moderator container mid-call (the server should observe the socket close within ~30 s rather than indefinitely), and (b) no regression to short-call latency (`context_query`, `register_agent`, `new_conversation` still complete in <100 ms).
4. **Run twice in a row on the same MCP session** to guard against the session-degradation hypothesis from the original Phase 1 occurrence #2.
5. **Smoke test legacy paths** — terminal moderator and an agent→agent nested invoke — to confirm the existing Pass-2 dispatcher fix still works alongside the new server-side keepalive (no double-pinging artifacts, no header-write races).

### Out of scope

- **Reducing `MCP_REQUEST_TIMEOUT_MS`** — the 30 min ceiling is a safety net, not a fix.
- **Auto-retry on stall** — moderator's `new_conversation` recovery is adequate; broker-side dedup is tracked in ICEBOX #1.
- **Patching CC CLI directly** — third-party; not our component. Server-side fix subsumes it for any current or future MCP client.

## Acceptance Criteria

- [x] **Fix #2 (SSE heartbeat)** — `McpController.handlePost` starts the existing `startSseKeepalive(res)` helper once `res.headersSent` is true and `content-type` includes `text/event-stream`; clears on `close`/`finish`. Reuse the QRM5-BUG-005 helper with added try/catch around `res.write` for destroyed sockets.
- [x] **Fix #2 polling guard** — `maybeStartKeepalive` callback includes `if (res.writableEnded)` early-exit so short JSON responses don't waste interval ticks.
- [x] **Fix #2 logging** — extend the existing `POST close` debug line in `McpController.handlePost` to include `keepaliveFired=<bool>`.
- [ ] **Fix #2 safety** — short-duration JSON POSTs (`context_query`, `register_agent`) do not receive spurious `: ping` comment frames (validated from logs).
- [x] **Fix #3 (server-side TCP keepalive)** — `apps/mcp-server/src/main.ts` attaches `connection` listener that calls `socket.setKeepAlive(true, 30_000)` on every incoming socket.
- [x] **Fix #3 (client-side TCP keepalive)** — extend the existing `UndiciAgent` instances in `apps/terminal/src/connection/mcp-client.service.ts` and `apps/agent/src/connection/mcp-client.service.ts` with `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`.
- [ ] **Reproducible CC CLI long-call repro** — moderator container, one `invoke_agent` to a slow target (≥6 min) on the same MCP session. Pre-fix logs show the 300 s `writableFinished=false` close pattern; post-fix logs show normal completion with periodic `: ping\n\n` writes interleaved.
- [ ] **No "Session identity was lost" recovery narration** in the moderator's CC CLI session log for the validation run.
- [ ] **Same-session two-in-a-row** — two consecutive long calls on a single MCP session, both deliver cleanly (regression guard for original session-degradation hypothesis).
- [ ] **Dead-flow detection** — kill the moderator container mid-call; mcp-server observes `POST close` within ~30–60 s rather than indefinitely. (Validates fix #3.)
- [ ] **No latency regression** — short-duration ops (`register_agent`, `context_query`, `context_store`, `new_conversation`) still complete in <100 ms.
- [x] **Build + lint + tests pass** (`npm run build && npm run lint && npm run test`).

## Dependencies and References

- **[QRM5-BUG-003](QRM5-BUG-003-streamable-http-long-call-silent-stall.md)** — Parent ticket. Contains the full diagnostic history: Phase 1 instrumentation findings (the 300.7 s `requestTimeout` correlation), corrected Pass-2 diagnosis (client-side undici `bodyTimeout`), the client-side dispatcher fix, and the 2026-04-29 re-opened reproduction proving the fix doesn't reach CC CLI. All Phase 1 instrumentation remains in place and active.
- **[QRM5-BUG-005](QRM5-BUG-005-agent-reconnect-after-mcp-restart.md)** — Added the `startSseKeepalive(res)` helper used by the GET path; Fix #2 reuses this helper for POST.
- **[QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md)** — Server-side cleanup of dead moderator MCP sessions (was QRM6-BUG-007; promoted to QRM7). Complementary: cleanup runs *after* a session has died; this ticket prevents the session from dying due to idle-timeout stalls.
- **[QRM6-BUG-010](QRM6-BUG-010-broker-timeout-causes-retry-storm-duplicate-sdk-sessions.md)** — Agent-side dedup for retry storms. Orthogonal cause but interacts: the 2026-04-29 stall produced a same-correlationId retry that the dedup did not catch because v1 had already returned before v2 fired.
- **[ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker)** — Duplicate-invocation risk amplified by each stall/retry cycle.
- `apps/mcp-server/src/mcp/mcp.controller.ts` — Primary modification target (Fix #2 heartbeat + logging). Existing `startSseKeepalive(res)` at lines 154–166.
- `apps/mcp-server/src/main.ts` — Modification target for Fix #3 server-side `setKeepAlive`. Existing `requestTimeout`/`headersTimeout` block provides the insertion point.
- `apps/terminal/src/connection/mcp-client.service.ts` — Fix #3 client-side keepalive addition to existing `UndiciAgent`.
- `apps/agent/src/connection/mcp-client.service.ts` — Fix #3 client-side keepalive addition to existing `UndiciAgent`.
- Source logs: `logs/mcp-server-20260429T015120.jsonl` (2026-04-29 reproduction).

## Implementation Notes

**Status:** Implemented 2026-04-30. Code changes complete; runtime validation criteria (CC CLI long-call repro, dead-flow detection, latency regression, same-session two-in-a-row) require Docker stack testing by QA.

### Files Modified

| File | Change |
|------|--------|
| `apps/mcp-server/src/mcp/mcp.controller.ts` | **Fix #2**: Added `maybeStartKeepalive` polling (250ms interval) in `handlePost` after Phase 1 instrumentation block. Checks `res.writableEnded` (early-exit for JSON responses), `res.headersSent`, and `content-type: text/event-stream` before calling `startSseKeepalive(res)`. Clears on `finish`/`close`. Extended POST close debug log with `keepaliveFired=<bool>`. Added try/catch around `res.write` in `startSseKeepalive` for destroyed-socket safety. |
| `apps/mcp-server/src/main.ts` | **Fix #3 server**: Added `httpServer.on('connection', socket => socket.setKeepAlive(true, 30_000))` after the existing `requestTimeout`/`headersTimeout` block, before `app.listen()`. |
| `apps/terminal/src/connection/mcp-client.service.ts` | **Fix #3 client**: Extended existing `UndiciAgent` with `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }`. |
| `apps/agent/src/connection/mcp-client.service.ts` | **Fix #3 client**: Same `connect.keepAlive` addition as terminal. |

### Design Decisions

- **Polling interval placement**: The `maybeStartKeepalive` interval is registered before session routing (existing vs new session branches), so it covers both code paths. The interval fires during the `await transport.handleRequest()` call regardless of session state.
- **`keepaliveFired` variable**: Defined at the top of `handlePost` (before instrumentation block) so it's accessible in the `close` event handler via closure. Named `keepaliveFired` (not `keepaliveStarted`) to match the ticket's log field specification.
- **TCP keepalive listener placement**: Placed before `app.listen()` (after the timeout configuration block) to ensure no incoming connections are missed.
- **All three architect improvements incorporated**: (1) `writableEnded` early-exit in `maybeStartKeepalive`, (2) try/catch in `startSseKeepalive` around `res.write`, (3) content-type guard ensures JSON POSTs never receive comment frames.

### Verification

- `npm run build` — 4/4 compilations successful
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 50 suites, 771 tests passed
- Existing `mcp.controller.spec.ts` tests pass (no regression in POST/GET/DELETE handler behaviour)
