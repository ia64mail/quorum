# QRM6-BUG-004: Elicitation Round-Trip Blocked by Circular-Call Safeguard

**Status: Open**

## Summary

`MessageBroker`'s circular-call safeguard rejects any `invoke_agent` where the target is already in the current correlation's call chain. This is correct for genuine agent-to-agent recursion (e.g. architect → teamlead → architect) but fundamentally breaks the QRM6 elicitation flow: `moderator → developer → moderator(elicitation)` is the *point* of QRM6 and will always be tripped by this safeguard, since the moderator is in the chain before it invokes the developer. The elicitation path delivers via `McpElicitationConnection` (a user-input prompt, not a recursive LLM invocation), so it should be exempt from the circular check.

## Problem Statement

Reproduction (with QRM6-BUG-003 already worked around so MCP tools are live):

```
$ docker compose exec -T moderator claude -p --permission-mode bypassPermissions "
1. register_agent(role='moderator')
2. new_conversation()
3. invoke_agent(target='developer', action=
     'Call invoke_agent(target=moderator) with a question. Report the answer.')
"
...
Developer's response:
  success: true,
  result: "The invoke_agent call to the moderator failed with the error:
           Circular call: moderator → moderator"
```

MCP server log confirms the rejection:

```
[MessageBroker] Invoke: correlationId=<id> caller=moderator target=developer depth=0
[InvocationHandler] Invocation received: ... caller=moderator
[MessageBroker] Invoke: correlationId=<id> caller=developer target=moderator depth=1
[MessageBroker] Rejected: Circular call: moderator → developer → moderator
```

Safeguard 2 in `apps/mcp-server/src/messaging/message-broker.service.ts:43` trips unconditionally on any `target === moderator` that comes in while moderator is already in the chain — which is the entire normal QRM6 workflow (moderator always originates the chain as the user's interface). Every scenario in the QRM6-008 playbook that depends on elicitation (Scenario 6 round-trip, Scenario 7 decline) fails with the same error.

This blocks the **core QRM6 deliverable** — the clarification flow preserved from `ClarificationHandler` via elicitation is never reachable in practice.

### Root cause

The circular-call safeguard was designed when agents could only invoke each other through `HttpAgentConnection`, i.e. real LLM-to-LLM recursion that could genuinely loop forever. QRM6-003 introduced `McpElicitationConnection` as a second implementation of `AgentConnection`, but the safeguard treats all connections uniformly. An elicitation is a *synchronous human-in-the-loop prompt* — the "target moderator" does not run an LLM, does not consume turns, and cannot itself emit further `invoke_agent` calls. It's architecturally incapable of recursion.

The chain check protects against a real risk for `HttpAgentConnection`. For `McpElicitationConnection` it is a gratuitous no-op that happens to mis-fire because the moderator's identity overloads both "chain anchor" and "elicitation target."

## Design Context

The QRM6 roadmap (D1, "MCP elicitation") and QRM6-003's ticket both describe the flow as:

> `moderator → developer → invoke_agent(target=moderator)` translates to `elicitation/create` on the moderator's MCP session. The user answers inline; the answer flows back as the `invoke_agent` result to the developer.

The broker is the right enforcement point for "is this actually an elicitation?" because it's where connection-type dispatch already happens (`agent.handle(request, timeout)` on line 89 of the broker — `agent` is polymorphic). The registry knows which `AgentConnection` a role resolves to. The broker can check connection type *before* the circular safeguard and skip the safeguard for elicitation targets.

We do NOT want to just exempt `target === moderator` unconditionally — if a future configuration registered moderator as an HTTP-backed role (e.g. a web-UI moderator), the safeguard should still apply. The right predicate is "is this delivery an elicitation?", not "is the role named moderator?".

## Implementation Details

### Approach — check the connection type before the safeguard

In `apps/mcp-server/src/messaging/message-broker.service.ts`, look up the target connection **before** the circular check, and skip the check if it is an `McpElicitationConnection`:

```typescript
// Current layout (line 40-47 and surrounding):
//   Safeguard 2 — Circular call prevention
//   ...then later...
//   Safeguard 3 — Agent availability (registry lookup)

// Proposed:
//   Safeguard 3 first — registry lookup (pull the connection)
//   If connection is McpElicitationConnection: skip safeguard 2
//   Safeguard 2 — circular check (only for HTTP-delivered targets)
```

Reordering matters because the registry lookup is what tells us the connection type. The availability and connection checks at lines 49–62 need to run on the same lookup result — avoid two `registry.get()` calls.

Pseudocode for the revised top of `invoke()`:

```typescript
// Safeguard 1 — Depth limit (unchanged, O(1))
if (depth >= max) return { success: false, error: 'Max depth exceeded' };

// Safeguard 3 (moved up) — Agent availability
const agent = this.registry.get(target);
if (!agent) return { success: false, error: `Agent ${target} not registered` };
if (!agent.isConnected()) return { success: false, error: `Agent ${target} not connected` };

// Safeguard 2 (now conditional) — Circular call prevention
// Elicitation targets are human-in-the-loop prompts, not recursive LLM calls,
// so the chain check is not meaningful for them and would block the intended
// moderator-via-elicitation flow (QRM6-003).
const isElicitation = agent instanceof McpElicitationConnection;
const chain = this.callChains.get(correlationId) ?? new Set<AgentRole>();
if (!isElicitation && chain.has(target)) {
  return { success: false, error: `Circular call: ${[...chain].join(' → ')} → ${target}` };
}
```

### Chain bookkeeping still happens for elicitation

Elicitation does not recurse, but the *caller* should still be added to the chain (line 65) so that if the elicited moderator later tries to invoke another agent (a hypothetical future flow where elicitation response includes an agent call), the safeguard would still work. Keep `chain.add(caller)` unchanged.

### Test coverage

- Add a broker spec that sets up a fake moderator registered with `McpElicitationConnection` and a real target chain `moderator → developer → moderator`; assert the second invocation succeeds and reaches `handle()` on the elicitation connection.
- Keep existing circular-call tests — they must still pass for the `HttpAgentConnection` case (architect → teamlead → architect must still be rejected).
- Add an edge-case test: if moderator is *accidentally* registered as `HttpAgentConnection` (e.g. legacy terminal still up), the circular check should still fire. This documents that the fix is specifically about connection type, not role name.

### Roadmap/QRM6-003 back-reference

The QRM6-003 ticket mentioned that the broker's behavior "mirrors `ClarificationHandler.persistDecision()`". Add a line to that ticket (or the design doc this references) noting that the original `ClarificationHandler` delivered user prompts via a separate `POST /invoke` on the terminal, bypassing the broker entirely — so the circular-call safeguard never applied to clarifications in the old architecture. QRM6-003 correctly consolidated delivery in the broker but missed that this change subjected elicitation to a safeguard it wasn't previously exposed to.

### Alternative approaches considered

1. **Short-circuit at the elicitation connection itself.** Let the broker still enter the safeguard path, and have the connection return `success: false, error: 'circular'` — this is strictly worse: the error has already been produced by the broker before control reaches the connection.
2. **Maintain a separate chain for elicitation.** Over-engineered; elicitation doesn't recurse, so it doesn't need its own chain at all.
3. **Exempt target === AgentRole.moderator unconditionally.** Rejected: couples the fix to the role name rather than the delivery semantics. Breaks for any future scenario where moderator is HTTP-delivered (web UI) or any other role uses elicitation.

## Acceptance Criteria

- [ ] In `message-broker.service.ts`, the circular-call safeguard is skipped when the target's registered connection is an `McpElicitationConnection`
- [ ] The safeguard still fires for `HttpAgentConnection` targets (verified by existing tests, no regressions)
- [ ] New broker spec: moderator → developer → moderator via elicitation reaches the connection's `handle()` instead of being rejected
- [ ] New broker spec: moderator → developer → moderator over HTTP is still rejected (covers future configurations)
- [ ] `apps/mcp-server/src/messaging/message-broker.service.spec.ts` suite expands by the new cases; full suite still green
- [ ] QRM6-008 playbook Scenario 6 (elicitation round-trip) passes end-to-end: developer invokes moderator, user sees inline prompt, answer returns to developer, clarification auto-persisted to `clarification:developer:<correlationId>`
- [ ] QRM6-008 playbook Scenario 7 (elicitation decline) returns `{ success: false, error: 'User declined ...' }` to the developer and persists no clarification record
- [ ] `npm run build`, `npm run lint`, `npm run test` pass

## Dependencies and References

### Prerequisites
- QRM6-003 — Elicitation connection & broker routing (introduced `McpElicitationConnection`)
- QRM6-BUG-003 — MCP config must reach CC CLI first; without it, no moderator session exists to test elicitation against

### What This Blocks
- QRM6-008 — Playbook E2E test scenarios 6 and 7 (capstone elicitation scenarios)
- QRM6-009 — `apps/terminal/` deletion; the terminal remains the only working clarification path until elicitation is unblocked

### References
- `apps/mcp-server/src/messaging/message-broker.service.ts:40–47` — current circular safeguard
- `apps/mcp-server/src/messaging/message-broker.service.ts:49–62` — availability check (reorder above the safeguard)
- `apps/mcp-server/src/registry/mcp-elicitation-connection.ts` — connection class; `instanceof` check is the cleanest discriminator
- `apps/mcp-server/src/registry/agent-connection.abstract.ts` — consider adding a boolean like `isElicitation(): boolean` on the abstract if you prefer ducktyping over `instanceof` (trivial extension, keeps the broker free of connection-class imports)
- **Discovered during:** QRM6-008 playbook run 2026-04-24 — Scenario 6 probe returned `Circular call: moderator → developer → moderator` instead of surfacing the user prompt