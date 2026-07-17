# #70: Bootstrap context — task-aware project-scope selection via moderator-authored search query

## Summary

Make bootstrap project-scope selection **task-relevant** instead of merely recency-ordered: thread a short, moderator-authored `searchQuery` through `invoke_agent` into the broker, and have `BootstrapContextService` rank project records by hybrid BM25 + k-NN relevance to that query (reusing the existing `ContextStore.search`) rather than dumping the newest records. Recency selection remains the fallback. This realizes epic [#49](49-stabilization/49-stabilization.md) design-conclusion **#4** ("Bootstrap is recency-driven but not task-aware … moot once bootstrap selection is reworked per this conclusion").

## Problem Statement

After #55 (recency ordering) and #56 (budget sizing, `5000` / `0.8`), bootstrap reliably injects the **newest** project records — but newest is not the same as **relevant**. The most recent live audit (the [#65 context audit](../logs/sessions/2026-06-20-qrm9-65-context-audit.md)) shows the defect concretely:

- The B1 bootstrap into the developer delivered `63-project-notes`, `63-design-notes`, a billing doc, and a `qrm6-rerun-elicit-A` crumb — **none of them `#65`-relevant**. The developer ignored the block and read the ticket + code directly. The audit's verdict: *"Honest recency, not task-relevance."*
- The accreting append-only log (330+ project records, no compaction) means recency increasingly surfaces *whatever was written last*, regardless of the task at hand. As the index grows, a recency-ordered project block is progressively less likely to carry the records relevant to the current ticket.

The retrieval machinery to fix this already exists and **already works** — the QRM8 audit found project *search* returned relevant, well-ranked hits 9/9 — but bootstrap doesn't use it; it calls `getAll` + a recency bin-pack. The gap is not search quality; it is that the **push channel has no notion of what the invocation is about**.

**Risk of not doing it:** bootstrap's project budget (4000 tok since #56) is spent on recency noise. The synthesis records #56 enlarged the budget to admit (`*-project-notes` / `*-design-notes`) ride in only when they happen to be newest — exactly the cross-ticket reuse the budget bump was meant to enable is left to chance.

## Design Context

The decisive design question is "what query does a *push* channel search with?" Bootstrap runs server-side in the broker, before the agent starts — there is no agent query. The answer: the moderator, an LLM, already authors a natural-language description of every task in `invoke_agent.action`. We make it author a **dedicated, retrieval-shaped one-sentence query** as a sibling field.

**Why a moderator-authored field, not server-side distillation of `action`:**

- **Empirical:** a sample of the last 28 `invoke_agent` actions (extracted from moderator `ToolCall` logs across the last ~5 sessions; 134 found total) shows ~22 already lead with both the **ticket id** and the **feature concept** — e.g. *"Implement ticket #61 … search-budget top-hit floor fix"*, *"#59 … agent-scope role-keyed partition"*. The signal the search needs is present; the LLM is well-placed to emit a clean version of it.
- **The `/code-review` conflict rules out "first sentence of action".** ~25% of invocations must lead with a literal slash command (`/code-review …`) so the agent's CC CLI dispatches the skill (see [moderator persona — Skill Dispatch](../docker/moderator/CLAUDE.md)). That first token cannot simultaneously be a clean concept query. A separate field keeps `action` free-form (commands, multi-step instructions, hashes) and the query clean.
- **Vector quality belongs to the LLM, the MCP stays trivial.** Embedding a long, multi-topic `action` dilutes the single pooled vector (`mxbai-embed-large`, one 1024-d vector, k-NN leg weighted 70%) and risks silent 512-token truncation; the query prefix is literally *"Represent this sentence for searching relevant passages: "* (`embedding.service.ts:8`) — built for a sentence. A short LLM-authored query sidesteps both. The server side becomes `query = request.searchQuery ?? null` — deterministic and unambiguous.

**Why this is the right fix vs. re-tuning the ratio:** lowering `BOOTSTRAP_PROJECT_RATIO` (the obvious knob) shrinks the very project budget #56 enlarged so synthesis notes fit — re-creating #56's problem. Relevance ranking attacks the actual defect (recency ≠ relevance) without sacrificing synthesis-record reuse. The ratio stays a secondary lever.

## Implementation Details

### 1. `searchQuery` — a caller-set, broker-consumed field

Add an optional `searchQuery` to the `invoke_agent` tool schema (`apps/mcp-server/src/mcp/mcp.service.ts:297`, alongside `action`) and to `InvokeRequest` (`libs/common/src/messaging/invoke.types.ts:89`). Semantics:

- **Set by the moderator**, consumed by the broker at bootstrap-assembly time, and **never forwarded to the target agent**. It is the inverse of `bootstrapContext` (`invoke.types.ts:98` — broker-set, agent-read); `searchQuery` is caller-set, broker-read.
- Wire it into the `InvokeRequest` built at `mcp.service.ts:379`.

Suggested description (drives both retrieval legs without leaking mechanism):

    searchQuery: z.string().optional().describe(
      'One-sentence description of this task’s domain concept, used to retrieve ' +
      'the most relevant prior decisions into the target’s starting context. ' +
      'Include exact identifiers (ticket #, feature/file name) and a plain-language ' +
      'concept description; omit slash commands, commit hashes, and branch names.')

**Schema-drift correction (architect re-review, binding).** The framing above is stale as of QRM7-002 (Option B): the agent no longer has a separate `/invoke` schema — it imports the SAME shared `invokeRequestSchema` from `libs/common/src/messaging/invoke.types.ts` (`invocation.controller.ts:9,20`, `.safeParse(body)`). Adding `searchQuery` to that shared schema means the agent's parse **accepts** it, and `http-agent-connection.ts` (`body: JSON.stringify(request)`) **delivers** it — there is no schema-drift bug to sidestep here; the field is not silently dropped, it is silently *forwarded* unless something explicitly removes it. To meet AC2 (absent from the delivered payload), the **Message Broker** must explicitly strip `searchQuery` after passing it to `assemble()` and before `agent.handle()` — implemented as `delete request.searchQuery` in `message-broker.service.ts`, unconditionally (fresh and resumed sessions alike), right before `deliverWithTimeout`. This is a new "caller-set, broker-read, stripped-before-delivery" contract that no prior ticket owns (`bootstrapContext` is the mirror-image "broker-set, agent-read" contract) — #70 owns it. The payload-omission test (`message-broker.service.spec.ts`) pins the broker-side strip, not schema behavior; a companion test in `invocation.controller.spec.ts` documents that the shared schema does *not* strip `searchQuery` on its own, so the broker strip is load-bearing.

### 2. `assemble(correlationId, query?)` — relevance for project, recency for conversation

In `BootstrapContextService.assemble` (`apps/mcp-server/src/messaging/bootstrap-context.service.ts:20`):

- **Project scope (Step 3/5):** when `query` is present *and the backend is OpenSearch* (see correction 3 below), replace `getAll(project)` + recency `applyBudget` with `contextStore.search(ContextScope.project, query, undefined, projectBudget)` (the existing method, `opensearch-store.ts:202`) — it is already scope-filtered and token-budgeted, returns relevance-ranked items, and (since #61) returns at least the top hit even when it exceeds the budget. **Correction (architect re-review, binding):** the `ContextStore.search` signature is `search(scope, query, id?, maxTokens?, onTrace?)` — the token budget is the **4th** positional argument, not the 3rd; calling `search(ContextScope.project, query, projectBudget)` binds `projectBudget` to the `id` parameter, filters project items by a non-`'_'` id, returns zero hits, and silently falls back to recency — the feature would never activate. Pass `undefined` explicitly for `id`. `search` returns `ContextItem[]` (not a `Record`) — map each hit's `{key, value}` into the `selected` record shape and sum `estimateTokens(item.value)` for the Step-6 reclaim (the `estimateTokens` formula, `Math.ceil(JSON.stringify(value).length / 4)`, is identical across `BootstrapContextService`, `OpenSearchStore`, and `InMemoryStore`, so re-summing here is consistent with the budget the search call itself enforced).
- **Conversation scope (Step 7):** unchanged — it is `correlationId`-partitioned, so every record is already on-task; keep `getAll` + recency. Ranking buys nothing.
- **Budget reclaim (Step 6):** **Correction (team-lead code review of PR #71, AC5, binding) — "unchanged" was wrong.** The pre-existing formula `conversationBudget += projectBudget - projectTokensUsed` silently assumed `projectTokensUsed <= projectBudget`, which recency `applyBudget` always guaranteed. The search path breaks that assumption: the #61 top-hit floor means `search` can return a single hit larger than `projectBudget` (it guarantees at least the top hit even when oversized), so `projectTokensUsed` can now exceed `projectBudget`. Unclamped, the reclaim term goes negative and (in the extreme, where the oversized hit is large enough that `projectTokensUsed` exceeds the *entire* bootstrap `maxTokens`) drives `conversationBudget` below zero — which makes `applyBudget`'s greedy loop reject every conversation item regardless of size, silently dropping ALL conversation-scope context. The fix clamps the reclaim at `Math.max(0, projectBudget - projectTokensUsed)`: an oversized project selection reclaims nothing (rather than subtracting), so conversation always keeps at least its base allocation (`maxTokens - projectBudget`). `applyBudget`'s own `budget` parameter is additionally floored at `Math.max(0, budget)` as defense-in-depth so a negative value can never reach it from any caller, present or future. One accepted consequence, unchanged from the original design: when the oversized hit is large enough, `meta.estimatedTokens` (project + conversation) can still exceed `BOOTSTRAP_MAX_TOKENS` in total — that is the same #61 "return at least the top hit even when oversized" trade-off already accepted for the search path itself, not a new regression; what the clamp guarantees is that conversation is never collaterally zeroed out by it.

### 3. Pass the query from the broker

At the assembly call site (`message-broker.service.ts:112`), pass `request.searchQuery` into `assemble(correlationId, request.searchQuery)`.

### 4. Fallback — never worse than today

Recency `getAll` selection is retained and used whenever any of these hold, so the change is strictly additive:

- `searchQuery` is absent (older moderators, non-relevant tasks);
- the store backend is `InMemoryStore` (its `search` is substring-only, not ranked);
- `search` throws or returns empty (embedding service down is already handled inside `search` via BM25-only, `opensearch-store.ts:257`; a true empty result falls back to recency).

Assembly is already non-fatal (`message-broker.service.ts:113-118`); the fallback extends that posture.

**Correction 3 (architect re-review, binding) — backend discriminator was not exposed.** `contextStoreConfig.backend` (`'inmemory' | 'opensearch'`, `context-store.config.ts`) was registered in `ConfigModule.forRoot` (consumed directly by `OpenSearchStore`/`InMemoryStore` via `@Inject(contextStoreConfig.KEY)`) but was **not** exposed on `McpServerConfigService` — only `app`/`bootstrap`/`broker`/`context` were. `BootstrapContextService` only injects `McpServerConfigService`, so it had no way to read the backend to gate the search path. Fixed by adding a fourth `@Inject(contextStoreConfig.KEY) public readonly contextStore` getter to `McpServerConfigService` (`mcp-server-config.service.ts`) — no new module wiring needed since the config was already loaded, only the getter was missing.

### 5. Moderator persona instruction

In [docker/moderator/CLAUDE.md](../docker/moderator/CLAUDE.md) (near **Context Management** / **Skill Dispatch**), instruct the moderator to pass `searchQuery` on every `invoke_agent`. Teach the **contract and purpose**, not BM25/k-NN internals:

- one sentence, ~10–25 words;
- include exact identifiers (ticket #, feature/file) **and** a plain-language concept description;
- omit slash commands, commit hashes, branch names, and process boilerplate;
- it feeds keyword + semantic retrieval that seeds the next agent's starting context.

Call out the `/code-review` case explicitly: `action` keeps the literal `/code-review …`; `searchQuery` carries the clean concept (e.g. `"ticket #65 worktree commit/push hardening — agent commits orphan in shared clone"`).

### 6. Docs

Update [docs/context-management.md](../docs/context-management.md) "Bootstrap Context Injection" to describe task-aware project selection and the `searchQuery` input; add the #70 row to the epic [Tasks table](49-stabilization/49-stabilization.md) and note design-conclusion #4 is now addressed.

## Acceptance Criteria

- [x] `invoke_agent` accepts an optional `searchQuery`; `InvokeRequest` carries it.
- [x] `searchQuery` is consumed by the broker at assembly and is **absent** from the delivered agent payload (asserted by test).
- [x] When `searchQuery` is present and the backend is OpenSearch, project-scope bootstrap is selected via `ContextStore.search` (relevance-ranked) within the project budget; conversation scope remains recency `getAll`.
- [x] When `searchQuery` is absent, the store is InMemory, or `search` errors/returns empty, project selection falls back to the current recency behavior (no regression).
- [x] Project→conversation budget reclaim still works with the search path.
- [x] Moderator persona instructs authoring `searchQuery` (contract + purpose + `/code-review` carve-out), without retrieval internals.
- [x] `docs/context-management.md` and the epic Tasks table updated.
- [x] `npm run build` / `npm run lint` / `npm run test` green; new tests cover the search path, the recency fallback, and the payload-omission guard.

## Dependencies and References

- **Builds on:** #55 (recency ordering), #56 (budget `5000`/`0.8`) — both Done. Inherits #61's "return-at-least-the-top-hit" floor on the `search` path.
- **Realizes:** epic [#49](49-stabilization/49-stabilization.md) design-conclusion #4; supersedes the #55 recency-stopgap caveat noted there for project bootstrap.
- **Guards against:** the InvokeRequest schema-drift class (QRM6-BUG-014) in spirit, but not by sidestepping the schema (see correction under Implementation Details §1) — `searchQuery` IS declared on the shared schema and DOES reach the agent's parsed request; the guarantee it never reaches the agent's *delivered payload* comes from an explicit Message Broker strip, tested directly.
- **Touchpoints:** `apps/mcp-server/src/mcp/mcp.service.ts` (tool schema + request build), `libs/common/src/messaging/invoke.types.ts` (InvokeRequest), `apps/mcp-server/src/messaging/message-broker.service.ts` (assemble call + strip), `apps/mcp-server/src/messaging/bootstrap-context.service.ts` (selection), `apps/mcp-server/src/config/mcp-server-config.service.ts` (backend discriminator getter), `apps/mcp-server/src/context-store/opensearch/opensearch-store.ts` (`search`, reused), `apps/mcp-server/src/embedding/embedding.service.ts` (query prefix / model constraints), `docker/moderator/CLAUDE.md`, `docs/context-management.md`.
- **Evidence:** [#65 context audit](../logs/sessions/2026-06-20-qrm9-65-context-audit.md) (B1 recency-vs-relevance); 28-action `searchQuery`-feasibility sample (this session).

## Implementation Notes

**Files modified:**
- `libs/common/src/messaging/invoke.types.ts` — added optional `searchQuery: z.string().optional()` to `invokeRequestSchema`, sibling to `action`, documented as the inverse contract of `bootstrapContext` (caller-set/broker-read vs broker-set/agent-read).
- `apps/mcp-server/src/mcp/mcp.service.ts` — added `searchQuery` to the `invoke_agent` `inputSchema` (next to `action`) and to the `InvokeRequest` build (`request.searchQuery = args.searchQuery`).
- `apps/mcp-server/src/config/mcp-server-config.service.ts` — added a fourth constructor param, `@Inject(contextStoreConfig.KEY) public readonly contextStore`, exposing `backend` for gating.
- `apps/mcp-server/src/messaging/bootstrap-context.service.ts` — `assemble(correlationId?, query?)`; new private `selectProjectItems(query, projectBudget)` implements the search-then-fallback logic described in corrections 1 and 3; `assemble`'s Step 3/5 now delegates to it.
- `apps/mcp-server/src/messaging/message-broker.service.ts` — `this.bootstrapContext.assemble(correlationId, request.searchQuery)`; added `delete request.searchQuery` unconditionally (both fresh and resumed-session branches) immediately before `deliverWithTimeout`.
- `docker/moderator/CLAUDE.md` — Context Management section: instructs authoring `searchQuery` on every `invoke_agent` (one sentence, ~10–25 words, identifiers + concept, no slash/hash/branch), plus an explicit `/code-review` carve-out example.
- `docs/context-management.md` — "Pattern 4: Bootstrap Context Injection" sequence diagram and prose updated to show the search-vs-recency branch and the broker-side strip; config table unchanged (no new env var — `CONTEXT_STORE_BACKEND` already existed).
- `tickets/49-stabilization/49-stabilization.md` — added the #70 row (PR #71, Done) to the Tasks table; annotated design-conclusion #4 as addressed.
- Tests: `bootstrap-context.service.spec.ts` (+9: search-path call shape incl. budget arg position, no-getAll-when-searching, token re-sum for reclaim, 4 fallback triggers), `message-broker.service.spec.ts` (+5, +1 updated assertion for the new 2-arg `assemble` call: searchQuery forwarded to assemble, absent from delivered payload with/without bootstrapContext, stripped on resumed sessions, undefined-passthrough when never set), `mcp.service.spec.ts` (+2: searchQuery flows into the built request when present/absent), `mcp-server-config.service.spec.ts` (+1, +1 updated: `contextStore` getter defined and backend is a valid enum value), `invocation.controller.spec.ts` (+1: shared schema does NOT strip `searchQuery` — documents why the broker-side strip is load-bearing).

**Deviations from the literal ticket text (all per architect design-notes corrections, applied before implementation):**
1. `search` called as `search(ContextScope.project, query, undefined, projectBudget)` — budget is the 4th positional arg, not 3rd as the ticket's original example showed.
2. The "schema-drift sidestep" framing was corrected: `searchQuery` is declared on the one shared `invokeRequestSchema`, reaches the agent's parsed request, and is removed only by an explicit broker-side `delete` — not by schema omission.
3. Added the `contextStore` getter to `McpServerConfigService` (not previously exposed) so `BootstrapContextService` can gate on `backend === 'opensearch'`.

**Post-review fix (team-lead code review of PR #71, AC5 — blocking, addressed):** the initial implementation's Step-6 reclaim (`conversationBudget += projectBudget - projectTokensUsed`) did not account for the search path's ability to return `projectTokensUsed > projectBudget` (the #61 top-hit floor). Fixed in `bootstrap-context.service.ts`:
- Step 6 now clamps the reclaim term: `conversationBudget += Math.max(0, projectBudget - projectTokensUsed)` — an oversized project selection reclaims nothing rather than subtracting from `conversationBudget`.
- `applyBudget`'s `budget` parameter is floored at `Math.max(0, budget)` internally as defense-in-depth, so a negative value can never reach its greedy-selection loop from any caller (present or future), even though the Step 6 clamp already prevents it from happening today.
- Added `bootstrap-context.service.spec.ts` describe block `'over-budget top hit (#61 interaction — review fix)'` (+2 tests): (a) a top hit exceeding the *entire* bootstrap budget (150 tokens vs. 100 total) — asserts conversation context survives intact with its full base allocation rather than being silently dropped, and documents that `meta.estimatedTokens` legitimately exceeds `BOOTSTRAP_MAX_TOKENS` in this extreme case (an accepted, pre-existing #61 trade-off, not a new regression); (b) a modestly over-budget top hit (90 vs. 80-token project share, realistic `#61` magnitude) — asserts total `estimatedTokens` stays within `BOOTSTRAP_MAX_TOKENS` and conversation context is preserved. Updated Implementation Details §2's "Budget reclaim (Step 6): unchanged" claim, which this review proved false — see the corrected text above.

**Verification (post-fix):** `npm run build` clean (3 webpack bundles). `npm run lint` clean (no new warnings). `npm run test`: 48 suites / 899 tests, all green.