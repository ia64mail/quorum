# #59: Context Store — agent scope provides no cross-invocation role persistence (keyed on correlationId, not role)

## Summary

Ticket #16 (Redirect Agent Memory to Context Store) appended an "## Agent Memory" paragraph to `SYSTEM_PREAMBLE` directing every agent role to persist durable role-level knowledge — "patterns learned, preferences, architectural constraints discovered … that should survive across invocations" — in `context_store(scope='agent')`. But **agent scope is implemented identically to conversation scope**: both resolve the partition id to the *per-invocation* `correlationId`. An agent-scope write therefore lands in `agent:<thisInvocationCorrId>:<key>`, a partition no later invocation can address, so the scope cannot persist anything across invocations — defeating #16's entire purpose. There is no role dimension anywhere in the agent-scope key; the literal prefix string `"agent"` vs `"conversation"` is the only thing that distinguishes the two scopes.

**Fix:** key agent scope by **role** (`agent:<role>:<key>`) so successive invocations of the same role share a stable partition, making `context_store(scope='agent')` the durable role memory #16 promised.

## Problem Statement

In `McpService`, both the write tool (`context_store`) and the read tool (`context_query`) resolve the scope partition id with the same expression:

```ts
// write — apps/mcp-server/src/mcp/mcp.service.ts:787-789
// Project scope is global — never include an id in the key.
// Conversation/agent scopes use correlationId as the id partition.
const id = scope === ContextScope.project ? undefined : correlationId;

// read — apps/mcp-server/src/mcp/mcp.service.ts:848 (identical line in context_query)
const id = scope === ContextScope.project ? undefined : correlationId;
```

`correlationId` is `args.correlationId ?? state?.correlationId` (`:764` write, `:845` read) — for an agent invocation, its own fresh session correlationId. Items are stored under the composite key `` `${scope}:${id ?? '_'}:${key}` `` (`libs/common/src/context-store/context-store.types.ts:16`), so:

- An agent-scope write by a `developer` invocation `A` → `agent:<corrId-A>:<key>`.
- The **next** `developer` invocation `B` (new correlationId `corrId-B`) reads `agent:<corrId-B>:…` → a different, empty partition.

Agent scope thus behaves as a per-invocation scratch space indistinguishable from conversation scope — never as the cross-invocation, role-scoped memory its name and #16's prompt imply.

### Evidence — QRM8 reference session (2026-05-24 → 05-27)

From the context-usage research (`tickets/tmp/context-analysis-qrm8/`):

- **Index finding F2:** the 7 agent-scope "research checkpoints" written in the session (`ticket-14-research`, `11-research-checkpoint`, `11-pass-a-research`, `11-passB-research`, `ticket-12-research`, `pass-b-research`, `12-research-findings`) had **zero consumption** — none was ever read back, because each lived under its writer's correlationId.
- **Index §2:** every agent-scope retrieval failed — **6/6 agent-scope searches** and **7/7 agent-scope `get-all`s** returned 0 items, across the whole session and the appendix windows.
- **#16 audit (`research-qrm8-16-context-audit.md`, finding B2):** the very ticket that *created* this policy produced **zero agent-scope writes**; its developer read its own empty agent partition (`get-all → 0`) and then wrote its implementation result to **conversation** scope. The policy changed no behavior even for its own author, and its read path returned nothing on first exercise.

### Why this is not covered by the QRM9 quality-upgrade plan

The QRM8 roadmap defers "background summarization, agent-scope bootstrap injection, decay/TTL" to QRM9 (`tickets/8-workspace-isolation.md:423,589`) as the work that "make[s] `context_store(scope='agent')` a full replacement for CC memory." **None of those addresses the addressing defect.** Summarization, TTL, and agent-scope bootstrap injection all presuppose a *stable partition* to summarize, expire, or inject from; with the id keyed on `correlationId` there is no role-stable partition for any of them to operate on. This ticket is the precondition: agent-scope bootstrap injection is meaningless until agent scope is role-addressable.

## Design Context

- `ContextScope` is `{ project, conversation, agent }` (`libs/common/src/context-store/context-store.types.ts:8-12`). Intended semantics: **project** = global; **conversation** = per-`correlationId` dialogue history; **agent** = per-**role** durable knowledge. Only the first two are implemented as intended.
- The agent's role is already available at both context handlers: `McpSessionState.role` is bound when the agent calls `register_agent` (`apps/mcp-server/src/mcp/mcp.service.ts:646`) and is read elsewhere in the same handlers (e.g. the search-trace `callerRole: state?.role`, `:893`). No new plumbing is needed to obtain the role.
- The conversation-scope guard (`correlationId is required for conversation scope`, `:771-783`) is the pattern to mirror for the new agent-scope role guard.

## Implementation Details

1. **Resolve agent-scope id to role, not correlationId**, in both `registerContextStoreTool` and `registerContextQueryTool`. Replace the shared two-branch expression with a three-branch resolver, e.g.:

   ```ts
   const id =
     scope === ContextScope.project ? undefined
     : scope === ContextScope.agent ? state?.role
     : correlationId; // conversation
   ```

   Factor this into a single private helper (`resolveScopeId(scope, state, args)`) used by both tools so read and write can never diverge again (the read/write symmetry is exactly what makes this defect total).

2. **Validation:** agent scope requires a known role — reject the call with a clear message when `state?.role` is absent (and no explicit override is supplied), mirroring the existing conversation-scope `correlationId` guard. Decide whether an explicit `role`/override arg is allowed (parallel to the existing `correlationId` override) or whether agent scope is strictly session-role-bound; default to session-role-bound for safety.

3. **Migration:** existing `agent:<correlationId>:*` documents are already orphaned (unreadable today), so no data migration is required for correctness. Optionally add a one-off cleanup/reindex; the only such docs in the reference data are the 7 research-residue records above. Note the change in the OpenSearch backend notes if a reindex is chosen.

4. **Docs:** update the scope tables in `docs/context-store.md` and `docs/context-management.md` to state that agent scope is role-partitioned (`agent:<role>:<key>`) and durable across invocations, distinct from conversation scope.

5. **Out of scope (follow-on, QRM9):** injecting `agent:<role>` records into the dispatched role's bootstrap. This ticket fixes *addressing only*; bootstrap injection is the separately-tracked quality upgrade that this unblocks.

## Acceptance Criteria

- [ ] `context_store` and `context_query` resolve the agent-scope partition id to the agent **role**, not `correlationId`, via a single shared resolver used by both tools.
- [ ] A role-`A` invocation can read agent-scope records written by a **prior** role-`A` invocation that ran under a **different** `correlationId`.
- [ ] Role-`B` cannot read role-`A`'s agent-scope records (role isolation preserved).
- [ ] Conversation-scope and project-scope behavior is unchanged (regression-covered).
- [ ] Agent scope rejects (or safely handles) a call with no resolvable role, with a clear message mirroring the conversation-scope guard.
- [ ] `docs/context-store.md` and `docs/context-management.md` describe agent scope as role-partitioned and durable.
- [ ] `npm run build && npm run lint && npm run test` pass; new tests cover cross-invocation, same-role persistence and cross-role isolation.

## Dependencies and References

- **Surfaced by:** `tickets/tmp/context-analysis-qrm8/research-qrm8-16-context-audit.md` (finding **B2**) and the index's session-wide finding **F2** (`research-qrm8-context-usage-index.md`).
- **Makes functional:** #16 (Redirect Agent Memory to Context Store) — #16's prompt guidance is correct; this ticket makes its target actually persist. #16 needs no change.
- **Sibling QRM9 Context Store fixes:** #55 (bootstrap `getAll` recency ordering) and #56 (bootstrap budget sizing) — same area, same wave; this completes the trio of audit-surfaced store defects.
- **Unblocks (deferred to QRM9):** agent-scope bootstrap injection (`tickets/8-workspace-isolation.md`, Context Store quality-upgrades row) — only meaningful once agent scope is role-addressable.
- **Parent epic:** #49 (QRM9 Roadmap — Stabilization).