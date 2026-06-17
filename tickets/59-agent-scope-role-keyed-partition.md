# #59: Context Store — agent scope provides no cross-invocation role persistence (keyed on correlationId, not role)

## Summary

Ticket #16 (Redirect Agent Memory to Context Store) appended an "## Agent Memory" paragraph to `SYSTEM_PREAMBLE` directing every agent role to persist durable role-level knowledge — "patterns learned, preferences, architectural constraints discovered … that should survive across invocations" — in `context_store(scope='agent')`. But **agent scope is implemented identically to conversation scope**: both resolve the partition id to the *per-invocation* `correlationId`. An agent-scope write therefore lands in `agent:<thisInvocationCorrId>:<key>`, a partition no later invocation can address, so the scope cannot persist anything across invocations — defeating #16's entire purpose. There is no role dimension anywhere in the agent-scope key; the literal prefix string `"agent"` vs `"conversation"` is the only thing that distinguishes the two scopes.

**Fix (addressing):** key agent scope by **role** (`agent:<role>:<key>`) so successive invocations of the same role share a stable partition, making `context_store(scope='agent')` the durable role memory #16 promised.

**Fix (content discipline):** reconcile the conflicting `SYSTEM_PREAMBLE` guidance in `libs/common/src/prompts/role-prompt-templates.ts` — "Progress Checkpointing" (`:113-118`) tells agents to use agent scope for per-task scratch (file/line inventories, `steps_completed` lists), while "Agent Memory" (`:120-122`) tells them to use it for durable role knowledge. The QRM8 reference session shows agents responded to the louder, more concrete cue: all 7 agent-scope writes were per-ticket reconnaissance graded "thin and moot" by the audits, not the "patterns learned, preferences, architectural constraints" #16 intended. Landing only the addressing fix re-creates the same uselessness from the content end — a stable partition that accumulates per-ticket scratch. The two fixes are complementary halves of one correction.

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

6. **SYSTEM_PREAMBLE content-discipline tweak** (`libs/common/src/prompts/role-prompt-templates.ts`). The addressing fix (items 1–4) makes the partition stable; this item fixes what agents put in it. The problem is that two SYSTEM_PREAMBLE sections give contradictory guidance about agent scope's purpose:

   **Current text to replace (`:113-122`):**

   ```
   ## Progress Checkpointing
   For tasks that involve significant research or multi-step implementation:
   - **After research**: Store key findings in **agent** scope (e.g., "research_findings": { files read, patterns discovered, constraints identified })
   - **After each implementation step**: Update your checkpoint (e.g., "progress": { steps_completed: [...], steps_remaining: [...], current_approach: "..." })
   - **On retry**: Query **agent** scope first — a previous attempt may have left findings and progress that save you from re-doing work
   This costs one tool call per checkpoint but can save dozens of tool calls on retry.

   ## Agent Memory

   Claude Code memory (`~/.claude/`) is ephemeral on agent containers — files accumulate on tmpfs during a session but are lost on container restart. Do not rely on CC memory for persistent knowledge. Instead, use `context_store(scope='agent')` to persist role-level knowledge (patterns learned, preferences, architectural constraints discovered) that should survive across invocations.
   ```

   "Progress Checkpointing" directs agents to write per-task scratch (file/line inventories, `steps_completed` lists, `research_findings`) to agent scope. "Agent Memory" directs them to write durable role knowledge (patterns, preferences, constraints) to the same scope. These are different content types with different lifetimes — the first is per-ticket ephemera, the second is cross-ticket institutional memory. Agents in the QRM8 session responded to the louder, more concrete "Progress Checkpointing" cue: all 7 agent-scope writes were per-ticket reconnaissance, zero were durable role knowledge (`research-qrm8-context-usage-index.md §5 F2`).

   **Resolution approach — evaluate candidates (a) and (b); the developer/architect should refine:**

   **(a) Single section, two-bucket key convention** within `agent:<role>:*` — define a naming convention where `scratch:<ticketId>:<label>` keys are per-task checkpoints (expect TTL or overwrite on next task) and bare keys (no `scratch:` prefix) are durable role memory. Cheap, convention-only, no schema change. Downside: relies on agents consistently following a naming convention under prompt pressure.

   **(b) Repurpose Progress Checkpointing to conversation scope** — per-task checkpoints are correlation-bound by nature (they help retry within the same invocation chain, not across invocations). Move the "After research / After each step / On retry" guidance to use **conversation** scope, which is already keyed by `correlationId` and scoped to the task chain. Reserve agent scope strictly for durable role memory. This is the cleanest semantic split. The developer should verify with the architect that conversation scope's `correlationId` keying supports per-task retry adequately — the "On retry" use case assumes a fresh invocation can find the prior attempt's checkpoint, which requires the retry to share the same `correlationId` or the moderator to pass it. If retry correlation is not wired today, note it as a follow-on gap rather than blocking.

   **Regardless of which approach is chosen, the revised text must include a content rubric for agent-scope writes:**

   - **Write only what future-you (any role-X invocation on a different ticket) cannot find in `docs/` or `tickets/`.** If the next sentence restates the ticket spec, don't write it.
   - **Atomic and ≤ ~400 tokens** — one pattern per write, not one digest per ticket. The QRM8 audits show oversized notes are silently dropped by the bootstrap budget (#56); three specimens (#31 at 674 tok, #11 at ~770 tok, #12 at 617 tok) never entered any bootstrap.
   - **What counts as "patterns / preferences / constraints":**
     - A recurring multi-site gotcha: e.g. "changing `InvokeRequest` schema requires touching `invoke.types.ts:68` *and* `mcp.service.ts:282` together — they share a validated contract but have no shared type."
     - A stable implementation preference: e.g. "use `execFileAsync` over `execAsync` for any child_process call that interpolates request-supplied values (#39 defense-in-depth pattern)."
     - An architectural constraint discovered mid-task: e.g. the path-traversal advisory during #11 that became ticket #39.
   - **What does NOT count (belongs in conversation scope or the ticket file, not agent scope):**
     - Ticket-specific file/line modification lists ("Pass A files modified: …")
     - Commit SHAs or PR URLs (recoverable from git)
     - "Research complete for ticket N" status markers
     - Current-state inventories ("SYSTEM_PREAMBLE has N sections: …")
   - **Note the new addressing semantics** so agents understand the channel actually persists: agent scope is now keyed as `agent:<role>:<key>` — records survive across invocations of the same role. A developer writing a finding today will find it in agent scope on the next developer invocation, even under a different `correlationId`.

   **Test expectations (for item 6):** existing `role-prompt-templates.spec.ts` tests pass; new assertions verify the rubric text is present in `SYSTEM_PREAMBLE` and the per-task checkpointing instruction no longer references `agent` scope (or is relocated to conversation scope).

## Acceptance Criteria

- [ ] `context_store` and `context_query` resolve the agent-scope partition id to the agent **role**, not `correlationId`, via a single shared resolver used by both tools.
- [ ] A role-`A` invocation can read agent-scope records written by a **prior** role-`A` invocation that ran under a **different** `correlationId`.
- [ ] Role-`B` cannot read role-`A`'s agent-scope records (role isolation preserved).
- [ ] Conversation-scope and project-scope behavior is unchanged (regression-covered).
- [ ] Agent scope rejects (or safely handles) a call with no resolvable role, with a clear message mirroring the conversation-scope guard.
- [ ] `docs/context-store.md` and `docs/context-management.md` describe agent scope as role-partitioned and durable.
- [ ] `npm run build && npm run lint && npm run test` pass; new tests cover cross-invocation, same-role persistence and cross-role isolation.
- [ ] `SYSTEM_PREAMBLE` in `role-prompt-templates.ts` no longer instructs agents to use `agent` scope for per-task progress/research checkpoints; the conflict between the Progress Checkpointing and Agent Memory sections is resolved (either merged into one section with a two-bucket convention, or checkpointing relocated to conversation scope).
- [ ] The revised preamble includes a content rubric for `agent:<role>` writes — what counts as durable role knowledge vs. what does not, with at least one positive example (a recurring gotcha or stable preference) and one negative example (ticket-specific file lists, commit SHAs).
- [ ] The revised preamble notes the new addressing semantics (`agent:<role>:<key>` — durable across invocations of the same role) so agents understand the channel actually persists.
- [ ] Existing `role-prompt-templates.spec.ts` tests pass; new assertions cover: (a) the content rubric text is present in `SYSTEM_PREAMBLE`, (b) the per-task checkpointing instruction (`research_findings`, `steps_completed`) is absent from the `agent` scope guidance or relocated to `conversation` scope.

## Dependencies and References

- **Surfaced by:** `tickets/49-stabilization/research-qrm8-16-context-audit.md` (finding **B2** — the addressing defect) and the index's session-wide finding **F2** (`research-qrm8-context-usage-index.md` — 7 agent-scope writes with zero consumption).
- **Completes:** #16 (Redirect Agent Memory to Context Store) — #16 shipped the policy pointing agents at `context_store(scope='agent')` for durable role memory; this ticket fixes *where* that memory lands (addressing, items 1–4) and *what* agents put there (content discipline, item 6). Same target file for item 6: `libs/common/src/prompts/role-prompt-templates.ts`, the file #16 last modified. #16 established the two conflicting sections; this ticket reconciles them.
- **Empirical basis for content discipline (item 6):** `research-qrm8-16-context-audit.md` (E4/E5 — the mechanism's first exercise was self-refuting; E7/B3 — `16-project-notes` only store-unique content was an incorrect structural inventory), `research-qrm8-context-usage-index.md §5 F2` (the 7 per-ticket scratch writes that the preamble's "Progress Checkpointing" cue produced), and the per-ticket audits confirming each write was "thin and moot" (#14-B3, #11-B4, #12-B2).
- **Sibling QRM9 Context Store fixes:** #55 (bootstrap `getAll` recency ordering) and #56 (bootstrap budget sizing) — same area, same wave; this completes the trio of audit-surfaced store defects. The ≤400-token rubric in item 6 references #56's evidence (three oversized project-notes never bootstrapped).
- **Unblocks (deferred to QRM9):** agent-scope bootstrap injection (`tickets/8-workspace-isolation.md`, Context Store quality-upgrades row) — only meaningful once agent scope is role-addressable *and* contains useful content.
- **Parent epic:** #49 (QRM9 Roadmap — Stabilization).

## Out of Scope

- **Agent-scope bootstrap injection** — deferred to QRM9; this ticket fixes addressing and content policy only.
- **Migrating existing `agent:<correlationId>:*` orphan records to `agent:<role>:*` partitions** — the 7 session orphans were per-task scratch under the old policy and have no durable value; they are already unreachable and will age out. No migration needed.
- **Mechanical enforcement of the content rubric** — the rubric is prompt guidance only (same approach as #16). Schema-level validation (e.g. rejecting oversized writes or ticket-number-anchored keys) is a potential follow-on but not part of this ticket.