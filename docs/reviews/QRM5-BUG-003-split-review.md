# Architectural Review: QRM5-BUG-003 Re-opened Phase 2 Split Decision

**Date:** 2026-04-30
**Reviewer:** Architect
**Ticket:** QRM5-BUG-003 (Streamable HTTP Long-Call Silent Stall)
**Request:** Evaluate whether remaining Phase 2 server-side work should be extracted into a new QRM6 bug ticket.

---

## 1. Decision: Split into QRM6-BUG-011

**Extract the re-opened Phase 2 work (Fix #2: SSE heartbeat on POST, Fix #3: TCP keepalive) into a new ticket `QRM6-BUG-011-server-side-sse-heartbeat-tcp-keepalive`.**

Close QRM5-BUG-003 as complete for its original scope.

### Rationale

| Factor | Assessment |
|--------|-----------|
| **Different problem surface** | QRM5-BUG-003's original problem was "our clients use undici's default 300s bodyTimeout." The fix was client-side dispatchers. The remaining work is "third-party CC CLI client has the same default but we can't patch it." Same root cause, but fundamentally different fix surface — server-side accommodation rather than client-side repair. |
| **Different era** | The completed work is QRM5-era (legacy terminal moderator, agent-to-agent). The remaining work is motivated entirely by QRM6's CC CLI moderator architecture (QRM6-002). The "why now" is QRM6, not QRM5. |
| **Ticket convention alignment** | `tickets/README.md` defines tickets as "time snapshots" — frozen records of a decision point. QRM5-BUG-003 at 340+ lines has become a living document spanning two eras and three fix passes. Splitting restores the snapshot property. |
| **Self-contained spec** | The "Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)" section is already a complete, standalone ticket spec — it has its own file-by-file change list, implementation sketches, validation plan, and out-of-scope section. Extraction is mechanical, not creative. |
| **Clean completion signal** | With the split, QRM5-BUG-003 has an unambiguous "done" state: all Quorum-controlled MCP clients are patched, instrumentation is in place, root cause is documented. A developer won't confuse "closed with follow-up" for "still open." |
| **Lineage clarity** | QRM6-BUG-011 slots after QRM6-BUG-010 (broker retry storm), both of which are reliability/resilience bugs in the QRM6 CC CLI architecture. Sequential numbering places it correctly in the QRM6 timeline. |

### Counter-argument addressed

> "Splitting loses context — a developer won't read QRM5-BUG-003's diagnostic history."

The new ticket cross-references QRM5-BUG-003 for the full Phase 1 instrumentation findings and corrected diagnosis. The spec section itself is self-contained — a developer doesn't need to re-derive the diagnosis, they need to implement Fix #2 and #3 as specified. The "why" is captured concisely in the new ticket's Problem Statement.

---

## 2. QRM5-BUG-003 Status Update

### What changes in QRM5-BUG-003

1. **Status line** → `Closed 2026-04-30. Client-side fix (Pass 2 undici dispatcher) resolved the stall for all Quorum-controlled clients. Server-side hardening for third-party MCP clients (CC CLI) tracked in QRM6-BUG-011.`

2. **Acceptance criteria updates:**
   - `[x]` Ancillary: `MAX_TOOL_ROUNDS` = 15 — **already shipped** (confirmed in `apps/terminal/src/chat/chat.service.ts:18`, commit visible in entropy report)
   - Phase 1 checkboxes — mark as complete (instrumentation is in place and findings documented)
   - Phase 2 original checkboxes — already `[x]` (Pass 1/2 shipped)
   - Phase 2 re-opened checkboxes — **remove or annotate** as "Moved to QRM6-BUG-011"

3. **Add a cross-reference** in Dependencies and References pointing to QRM6-BUG-011.

### What stays in QRM5-BUG-003

Everything currently there stays as historical record. The Implementation Notes sections (Phase 1, Phase 2 Fix #1, Re-opened) are valuable diagnostic artifacts. The "Implementation Details — Re-opened Phase 2" section stays too — it's the historical record of what was planned when the ticket was re-opened; the new ticket is the actionable version.

---

## 3. QRM6-BUG-011 Structure

**File:** `tickets/QRM6-BUG-011-server-side-sse-heartbeat-tcp-keepalive.md`

### Recommended sections

- **Summary**: Server-side SSE heartbeat and TCP keepalive to prevent 5-minute undici bodyTimeout stalls on third-party MCP clients (CC CLI moderator) that we cannot patch client-side.
- **Problem Statement**: Lift from the "Why the existing Pass-2 fix doesn't reach the new moderator" section. Cite the 2026-04-29 reproduction with the `durationMs=293709` smoking gun. Reference QRM5-BUG-003 for full diagnostic history.
- **Design Context**: Explain the Streamable HTTP POST idle-stream problem, why SSE comment frames are the right fix, and why TCP keepalive is defence-in-depth.
- **Implementation Details**: Lift the "Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)" section nearly verbatim, including the code sketches and file-by-file change list.
- **Acceptance Criteria**: Lift the "Phase 2 (hardening) — re-opened" checkboxes from QRM5-BUG-003.
- **Dependencies and References**: Cross-reference QRM5-BUG-003 (diagnostic history, Phase 1 instrumentation), QRM5-BUG-005 (startSseKeepalive helper origin), QRM6-BUG-007 (session cleanup — complementary), QRM6-BUG-010 (retry storm — orthogonal).

---

## 4. Technical Plan Evaluation

I reviewed the "Implementation Details — Re-opened Phase 2 (#2 + #3 bundled)" against the actual source files. Overall assessment: **clear, actionable, well-grounded in actual code. Ready for a developer.**

### Fix #2 (SSE heartbeat on POST) — Sound

**Verified against `mcp.controller.ts`:**

- The `startSseKeepalive(res)` helper (lines 154–166) is clean and reusable. It self-clears via `res.on('close')` and checks `res.writableEnded` before each write.
- The implementation sketch's placement — after the Phase 1 instrumentation block (line 60), before the session-routing branches (line 62) — is correct. The `setInterval(250)` will fire during the `await transport.handleRequest()` regardless of whether it's an existing or new session.
- The `content-type` guard is essential: `StreamableHTTPServerTransport` decides per-request whether to respond as JSON (short call) or SSE (long call). Writing a comment frame to a JSON response would corrupt it.
- SSE spec correctness: confirmed. Comment lines (`: …\n\n`) are defined as no-ops by the SSE specification. The MCP SDK uses `event:`/`data:` frames; interleaved comments are silently discarded.

**Minor improvements to recommend:**

1. **`writableEnded` early-exit in the polling callback.** Add `if (res.writableEnded) { clearInterval(headerWatch); return; }` at the top of `maybeStartKeepalive`. For quick JSON responses (register_agent, context_query), the response will finish in <10ms; checking `writableEnded` avoids ~1-4 wasted interval ticks waiting for `finish`/`close` event cleanup.

2. **Try/catch in `startSseKeepalive` around `res.write`.** Currently, if the socket is destroyed (not just ended), `res.write` could throw. Wrapping in try/catch with `clearInterval` on error would harden the helper. This is not blocking — `writableEnded` covers the normal case — but it's cheap insurance. Worth noting in the new ticket.

3. **Future: event-based header detection.** The 250ms poll is acknowledged as a stopgap. If `StreamableHTTPServerTransport` ever exposes a "headers flushed" event or if Express's `res.writeHead` can be intercepted, that would be cleaner. Not worth pursuing now — the poll runs at most ~20 times per long call and stops as soon as the keepalive takes over.

### Fix #3 (TCP keepalive) — Sound

**Verified against `main.ts` and both `mcp-client.service.ts` files:**

- **Server side:** `main.ts` already captures `httpServer` at line 24. Adding `httpServer.on('connection', s => s.setKeepAlive(true, 30_000))` after line 28 (`await app.listen(...)`) is a 3-line change. Note: the `connection` listener should be attached *before* `app.listen()` to avoid missing the initial connections, or *on* the server object which Node keeps for the lifetime. Both work — the `connection` event fires for every new TCP connection, and attaching the listener before or after `listen()` both catch future connections. Recommend placing it after the existing `requestTimeout`/`headersTimeout` block (after line 26) for readability.

- **Client side:** Both `mcp-client.service.ts` files already have `UndiciAgent` dispatchers (terminal: lines 27–30, agent: lines 33–36). Adding `connect: { keepAlive: true, keepAliveInitialDelay: 30_000 }` is additive and non-breaking.

- **Scope limitation is correct:** CC CLI's MCP client doesn't use our dispatcher, so client-side keepalive doesn't help it. Fix #2 (heartbeat) is the mechanism that protects CC CLI; Fix #3 protects our own clients and gives the server dead-flow detection.

### Validation plan — Comprehensive

The 5-step validation plan covers: baseline reproduction, fix #2 in isolation, fix #3 on top, same-session two-in-a-row regression guard, and legacy-path smoke test. This is thorough. One addition to recommend:

- **Step 2 should explicitly check that short-duration calls are unaffected** — confirm that JSON-response POSTs (e.g., `context_query`) don't receive spurious `: ping` comment frames. The content-type guard should prevent this, but it's worth a manual log check.

### Risk assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Comment frame corrupts non-SSE response | High (would break JSON-RPC) | Content-type check in `maybeStartKeepalive` — only fires for `text/event-stream`. Tested by validation step with short calls. |
| Double keepalive (GET + POST on same session) | Low | They're separate TCP connections (separate Express responses). Each gets its own independent keepalive. No interference. |
| `setInterval(250)` leak on crashed request | Very Low | Cleared by both `finish` and `close` events. Even if both somehow fail to fire, `startSseKeepalive` takes over and the poll self-clears. Worst case: 250ms interval runs for the life of the response, checking a boolean. |
| `res.write` throws on destroyed socket | Low | Mitigated by `writableEnded` check. Recommend adding try/catch as belt-and-suspenders. |

---

## 5. Proposed Next Steps

1. **Team Lead** creates `QRM6-BUG-011-server-side-sse-heartbeat-tcp-keepalive.md` by lifting the spec from QRM5-BUG-003's re-opened section. Updates QRM5-BUG-003 status to closed with cross-reference.

2. **Developer** implements QRM6-BUG-011:
   - Fix #2 first (SSE heartbeat on POST) — this is the primary fix that protects CC CLI.
   - Fix #3 second (TCP keepalive) — defence-in-depth.
   - Incorporate the minor improvements noted above (writableEnded early-exit, try/catch in startSseKeepalive).
   - Run build + lint + tests before committing.

3. **Architect** reviews the implementation for:
   - Correct placement of the `maybeStartKeepalive` interval (before session routing, after instrumentation)
   - Content-type guard correctness
   - No writes to non-SSE responses
   - TCP keepalive on the right lifecycle hook

4. **QA** runs the validation plan (ideally on the Docker stack with a real CC CLI moderator session ≥6 minutes).

5. **Stale checkbox cleanup**: While updating QRM5-BUG-003, mark the `MAX_TOOL_ROUNDS = 15` ancillary checkbox as `[x]` — it's already shipped (confirmed in code at `chat.service.ts:18`).
