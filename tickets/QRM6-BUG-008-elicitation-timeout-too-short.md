# QRM6-BUG-008: MCP Elicitation Ignores Role Timeout — Hardcoded SDK Default (60s) Too Short for Human-in-the-Loop

**Status: Implemented** — role timeout forwarded to MCP elicitation (commit 9562493)

## Summary

`McpElicitationConnection.handle()` accepts a `timeout` parameter from the broker (currently named `_timeout` to mark it as unused), but never passes it to the underlying `elicitInput()` call. The MCP SDK falls back to its default request timeout of 60 seconds, so every agent-to-moderator clarification fires `MCP error -32001: Request timed out` if the user does not answer within 60s. `ROLE_TIMEOUTS[AgentRole.moderator]` is already correctly set to 5 minutes for exactly this use case — the value is just never wired through. The fix is one parameter to `elicitInput`.

## Problem Statement

Reproduction during the QRM6-008 2026-04-25 playbook run, Scenario 6 (capstone):

```
02:39:17  invoke_agent: developer → moderator [depth=1, correlationId=a1b65a1c-...]
02:40:17  WARN [McpElicitationConnection] Elicitation failed: MCP error -32001: Request timed out   ← attempt 1, ~60s
02:40:22  invoke_agent: developer → moderator [depth=1]                                              ← developer retried
02:41:22  WARN [McpElicitationConnection] Elicitation failed: MCP error -32001: Request timed out   ← attempt 2, ~60s
02:41:30  invoke_agent: developer → moderator [depth=1]                                              ← developer retried again
02:42:21  Embedded document [project:_:clarification:developer:a1b65a1c-...]                         ← attempt 3 finally landed
```

Each timeout fires almost exactly 60 seconds after the prior elicitation began — the MCP SDK's hardcoded default `RequestOptions.timeout`. Two of the three attempts wasted the user's typing because the developer's retry loop discarded a partially typed answer.

The user-visible symptom in CC CLI is harmless-looking — the elicitation prompt simply disappears mid-typing as if cancelled — but the upstream developer agent receives `success: false, error: "Elicitation failed: MCP error -32001: Request timed out"` and (depending on agent prompt) either retries (best case) or gives up. With a typical user response time of 30–120 seconds for any non-trivial question, the 60s ceiling is the dominant failure mode for human-in-the-loop clarifications.

### Why this is severe

- The QRM6-002…QRM6-007 milestone exists to support exactly this flow. A 60s ceiling makes it unreliable in production-like usage.
- Combined with [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md), the user experience for restart scenarios degrades further: a stale moderator entry causes a 60s wait followed by a generic timeout, with no signal that the moderator is dead.
- This regresses behavior that the QRM6-001 spike specifically validated as adequate ("round-trip latency < 1s, user prompt is legible") — the spike measured machine round-trip, not the human's typing window. The role-timeout system was added to bridge that gap; this bug is the missing wire.

## Design Context

### Where the timeout is read

`apps/mcp-server/src/messaging/role-timeouts.ts:5`

```typescript
[AgentRole.moderator]: 5 * 60_000,  // 5 min — user clarification via elicitation
```

This value is read by the `MessageBroker` per-target on every `invoke_agent` and passed to `AgentConnection.handle(request, timeout)`. For `HttpAgentConnection`, `timeout` is honored in the fetch call. For `McpElicitationConnection`, the parameter exists but is unused.

### Where the timeout is dropped

`apps/mcp-server/src/registry/mcp-elicitation-connection.ts:43–62`

```typescript
async handle(
  request: InvokeRequest,
  _timeout: number,                                   // ← marked unused
): Promise<InvokeResponse> {
  try {
    const message = `[${request.caller}] ${request.action}`;
    const result: ElicitResult = await this.server.server.elicitInput({
      message,
      requestedSchema: { ... },
    });                                               // ← no second arg → SDK default (60s)
```

The MCP SDK signature is `elicitInput(params, options?: RequestOptions)`. `RequestOptions.timeout` is the per-request override. Without it, the SDK uses its default (`60_000`) plus optional `resetTimeoutOnProgress` semantics.

### Why the underscore landed

Reasonable inference: when `McpElicitationConnection` was first written (QRM6-003), the call signature was kept compatible with `HttpAgentConnection.handle(request, timeout)` for the `AgentConnection` abstract, but the implementer did not finish wiring the timeout into `elicitInput`. The underscore was a TODO that didn't bubble up in code review because the SDK silently honored its own default and the QRM6-008 playbook didn't exist yet to surface the regression.

## Implementation Details

### Minimal fix

`apps/mcp-server/src/registry/mcp-elicitation-connection.ts`:

```diff
   async handle(
     request: InvokeRequest,
-    _timeout: number,
+    timeout: number,
   ): Promise<InvokeResponse> {
     try {
       const message = `[${request.caller}] ${request.action}`;

-      const result: ElicitResult = await this.server.server.elicitInput({
-        message,
-        requestedSchema: {
-          type: 'object',
-          properties: {
-            answer: {
-              type: 'string',
-              description: 'Your answer',
-            },
-          },
-          required: ['answer'],
-        },
-      });
+      const result: ElicitResult = await this.server.server.elicitInput(
+        {
+          message,
+          requestedSchema: {
+            type: 'object',
+            properties: {
+              answer: {
+                type: 'string',
+                description: 'Your answer',
+              },
+            },
+            required: ['answer'],
+          },
+        },
+        { timeout },
+      );
```

That alone restores the documented 5-minute ceiling.

### Optional refinements (consider, don't insist on)

| Refinement | Why | Why not |
|------------|-----|---------|
| `resetTimeoutOnProgress: true` in the `RequestOptions` | If the SDK supports per-keystroke progress notifications, the timer would reset while the user types — better UX | Unclear whether CC CLI emits progress events for elicitation; needs verification |
| Make timeout env-configurable (`MCP_ELICITATION_TIMEOUT_MS`) | Operators can tune for their team's typical response time | YAGNI for now — the role timeout is the right knob; revisit if anyone actually hits the 5-minute ceiling |
| Log the configured timeout once at startup | Helps diagnose future regressions of this exact form | Nice-to-have; do it as part of the broader observability gap (see QRM6-008 run notes) |

### Testing

Add a unit test that constructs an `McpElicitationConnection` with a mocked `McpServer` whose `elicitInput` records the second argument:

```typescript
it('passes the role timeout through to elicitInput', async () => {
  const elicitInput = jest.fn().mockResolvedValue({ action: 'accept', content: { answer: 'ok' } });
  const conn = new McpElicitationConnection(AgentRole.moderator, makeServer({ elicitInput }));
  await conn.handle(makeRequest(), 300_000);
  expect(elicitInput).toHaveBeenCalledWith(expect.any(Object), { timeout: 300_000 });
});
```

Pair with an assertion that on `MCP error -32001`, the response envelope is `{ success: false, error: <message> }` — the existing catch block already handles this, but the test will fail on regression if the call path changes.

### Out of scope

- Server-side liveness for stale sessions — separate fix in [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md). After both land, a stale moderator times out fast (QRM7-001) while a live-but-thinking user has 5 minutes (this ticket).
- Changing `ROLE_TIMEOUTS[moderator]` itself. The 5-minute value was chosen for elicitation; the regression is purely in the wiring.
- Progress/streaming UX in CC CLI for elicitation — not our code to change.

## Acceptance Criteria

- [ ] `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` passes `{ timeout }` as the second arg to `elicitInput`; parameter is no longer underscore-prefixed
- [ ] Unit test asserts the timeout is forwarded
- [ ] During an interactive playbook run, an elicitation that the user takes 90s to answer completes successfully (no `MCP error -32001` from this attempt)
- [ ] An elicitation that the user ignores for >5 minutes times out with the broker-level role timeout, not the SDK default 60s — verified by elapsed time in `mcp-server` logs
- [ ] QRM6-008 Scenario 6 passes with **one** elicitation attempt (no retry loops driven by 60s timeouts) when the user answers within the role timeout
- [ ] No regression in Scenario 7 (decline path still returns immediately, not after the new longer timeout)
- [ ] `npm run build`, `npm run lint`, `npm run test` pass

## Dependencies and References

### Prerequisites
- None — single-file change

### What This Blocks
- Practical usability of QRM6's clarification flow in any realistic interaction
- QRM6-008 Scenario 6 stability — currently passes only because the developer agent retries; should pass first try

### Relationship to Other Bugs
- [QRM7-001](QRM7-001-mcp-session-cleanup-not-firing.md) — independent fix; together they make moderator-restart and slow-typist scenarios both well-behaved
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — unrelated; mentioned only because all three surfaced in the same playbook run

### References
- `apps/mcp-server/src/registry/mcp-elicitation-connection.ts:45,50` — the underscore parameter and the unforwarded `elicitInput` call
- `apps/mcp-server/src/messaging/role-timeouts.ts:5` — `[AgentRole.moderator]: 5 * 60_000`
- `apps/mcp-server/src/messaging/message-broker.service.ts` — broker reads role timeout and passes to `connection.handle(request, timeout)`
- `apps/mcp-server/src/registry/agent-connection.abstract.ts` — `handle(request, timeout)` contract
- `@modelcontextprotocol/sdk/shared/protocol.js` — default `RequestOptions.timeout` (60_000)
- [QRM6-001 spike findings](tmp/QRM6-001-elicitation-spike-findings.md) — empirically validated round-trip latency but not human typing time
- **Discovered during:** QRM6-008 playbook run 2026-04-25 — Scenario 6. Three elicitation attempts were observed over ~3 minutes; the first two each timed out at ~60s mid-typing; only the third completed within the SDK default window.