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

## Follow-up — Bootstrap search observability

*Authored during QRM9 close-out (2026-07-17), after #70 merged to staging (PR #71) and was verified working live. Spec only — no implementation in this commit. Branch: `70-bootstrap-search-observability` off `49-stabilization`.*

### Problem Statement

The `context_query` tool path emits a per-search `ContextSearchTrace` record (`logs/context-search-*.jsonl`) via the `onTrace` callback — `mcp.service.ts:930-966` passes a 5th `onTrace` arg into `ContextStore.search`, captures the backend `SearchTrace`, and writes a full `ContextSearchTraceRecord` through the injected `ContextSearchTraceLogger`. The bootstrap project-scope search does **not**: `BootstrapContextService.selectProjectItems` calls `search(ContextScope.project, query, undefined, projectBudget)` (`bootstrap-context.service.ts:128-133`) with **no `onTrace` argument**, so the #70 relevance path — the whole point of task-aware bootstrap — produces **zero trace records**. Bootstrap search is the single most consequential ranked query in the system (it seeds every fresh agent's starting context) and is currently the only ranked-search caller with no observability.

**Live evidence (2026-07-17T16:43:33).** A bootstrap dispatch logged only `"OpenSearchStore: Hybrid search for scope=project: ..."` + `"BootstrapContextService: Assembled bootstrap context: 2 items"` — no `ContextSearchTrace` — while tool-invoked `context_query` searches in the same session each produced a full trace record. There is no way to audit *which* project records bootstrap selected, their scores, the engine used (hybrid vs BM25-only degrade), or whether the token budget truncated the result — exactly the diagnostics the trace stream exists to provide.

**Attribution gap.** Even once bootstrap emits a trace, `ContextSearchTraceRecord` (`context-search-trace-logger.service.ts:10-32`) has no field distinguishing a bootstrap-originated search from a `context_query`-originated one. `callerRole` cannot serve this purpose: it means "which agent invoked the tool" (a role enum), and bootstrap is a server-push with no invoking agent — for bootstrap it would be `null`, which is indistinguishable from a `context_query` issued before `register_agent`. A dedicated discriminator is required.

**Scope:** observability only. No change to selection behavior, ranking, budgets, the `searchQuery` contract, or the recency fallback. This does not alter which records bootstrap injects — only whether that decision is traceable.

### Implementation Details

**1. Attribution field on `ContextSearchTraceRecord` (`apps/mcp-server/src/observability/context-search-trace-logger.service.ts`).**
Add a discriminator to the record interface (the observability-layer wrapper — **not** the backend `SearchTrace` in `libs/common/src/context-store/context-store.abstract.ts`, which stays unchanged):

    source: 'context_query' | 'bootstrap';

Place it near `callerRole`. Make it **required** and update the single existing writer (`mcp.service.ts:949` `traceLogger.log({...})`) to set `source: 'context_query'` — there is exactly one existing call site, so a required field is safe and self-documenting. (Optional-with-omit is the alternative if strict backward-compatibility of already-written historical JSONL matters; not required here since the field is additive and old lines are simply missing it. Recommend required.)

**2. Wire `ObservabilityModule` into `MessagingModule` (`apps/mcp-server/src/messaging/messaging.module.ts`).**
`MessagingModule` currently imports only `RegistryModule`; it must add `ObservabilityModule` to `imports` so `ContextSearchTraceLogger` (exported by `ObservabilityModule`) is injectable into `BootstrapContextService`. No circular-dependency risk: `ObservabilityModule` has no imports of its own. `McpModule` already imports both `MessagingModule` and `ObservabilityModule`, so the shared singleton logger instance is reused (one JSONL stream, not two).

**3. Inject the logger and thread `correlationId` (`apps/mcp-server/src/messaging/bootstrap-context.service.ts`).**
- Add a third constructor param: `private readonly traceLogger: ContextSearchTraceLogger` (import from `../observability`).
- `selectProjectItems` currently receives `(query, projectBudget)`; add `correlationId?: string` so the emitted record can populate its `correlationId` field. `assemble` already holds `correlationId` — pass it through at the `selectProjectItems` call site (`:41-42`).

**4. Capture and emit the trace in the search path (`selectProjectItems`, `bootstrap-context.service.ts:126-153`).**
Mirror the `context_query` capture pattern exactly:
- Declare `let capturedTrace: SearchTrace | undefined;` before the `search` call (import `SearchTrace` from `@app/common`).
- Pass a 5th arg to `search`: `(trace) => { capturedTrace = trace; }`.
- After the `try` block's search work — and critically **also on the catch path** — if `capturedTrace` is defined, call `this.traceLogger.log({...})`. The catch-path emit matters: per QRM7-016, `OpenSearchStore.search` fires `onTrace` with `errorMessage` set even when it throws after `embedQuery` succeeds, so a bootstrap search that throws can still have a capturable trace. Structure the capture so the record is emitted whether search returns or throws (e.g. build the record in a `finally`, or emit at both the success and catch sites guarded by `if (capturedTrace)`). Use `randomUUID()` (from `node:crypto`) for `queryId` and `new Date().toISOString()` for `timestamp`, matching `mcp.service.ts`.
- Record field mapping for the bootstrap emit:
  - `source: 'bootstrap'`
  - `queryId`: fresh `randomUUID()`
  - `correlationId`: the threaded `correlationId ?? null`
  - `callerRole: null` (server-push, no invoking agent)
  - `scope: 'project'`, `id: null`
  - `queryText: query`, `maxTokens: projectBudget`
  - `engine`, `durationMs`, `hitCountRaw`, `hitCountReturned`, `truncatedByTokenBudget`, `results`, `errorMessage`: copied from `capturedTrace`, identical to the `context_query` mapping.

**5. Fallback paths emit no trace — by design (parity with `context_query`).**
When the recency fallback runs (no `query`, InMemory backend, empty result, or `canSearch === false`), no ranked `search` executes, so no trace is emitted — this matches `context_query`, which only logs when `capturedTrace` is present. Document this in the trace section of `docs/context-management.md` so an absent bootstrap trace is correctly read as "recency fallback / no ranked search ran," not "observability broken."

**SearchTrace shape considerations.** The backend `SearchTrace` interface (`context-store.abstract.ts:24-32`) and both stores' `onTrace` implementations are **unchanged** — bootstrap reuses the identical callback contract `context_query` already exercises. All attribution lives in the MCP/observability-layer `ContextSearchTraceRecord`. The only new type surface is the `source` field on that wrapper.

**Docs.** Update `docs/context-management.md` (the QRM7-016 context-search-trace / observability section, and the "Bootstrap Context Injection" section) to note that bootstrap project-scope search now emits `ContextSearchTrace` records tagged `source: "bootstrap"`, and that recency-fallback selection emits none.

### Acceptance Criteria

- [x] Bootstrap project-scope relevance search emits a `ContextSearchTrace` record to the `logs/context-search-*.jsonl` stream (the same sink `context_query` uses), including engine, per-hit scores/snippets, `truncatedByTokenBudget`, and `errorMessage`.
- [x] The emitted record is attributable to bootstrap via `source: 'bootstrap'`, distinct from `context_query` records (`source: 'context_query'`); the single existing `context_query` writer is updated to set `source` and remains correct.
- [x] The bootstrap trace populates `correlationId` (when the invocation carries one), `queryText`, `maxTokens` (= project budget), `scope: 'project'`, `callerRole: null`.
- [x] A traceable failure inside `search` (post-`embedQuery` throw) still emits a record carrying `errorMessage`, mirroring `context_query`.
- [x] Recency-fallback selection (absent query / InMemory backend / empty result / search throws before any trace) emits **no** trace record — behavior and rationale documented.
- [x] Selection behavior, ranking, budgets, the `searchQuery` contract, and the recency fallback are unchanged (observability-only; no diff to which records bootstrap injects).
- [x] New test coverage: `bootstrap-context.service.spec.ts` — (a) search path calls `traceLogger.log` once with `source: 'bootstrap'` and the mapped fields (scope, queryText, correlationId, budget); (b) recency-fallback path does **not** call `traceLogger.log`; (c) error-with-captured-trace path still logs. `mcp.service.spec.ts` — existing `context_query` trace assertion updated for `source: 'context_query'`. `messaging.module` DI resolves `BootstrapContextService` with the new dependency.
- [x] `npm run build` / `npm run lint` / `npm run test` green.

### Dependencies and References

- **Builds on:** #70 (this ticket — bootstrap task-aware selection), QRM7-016 (`onTrace` callback, `ContextSearchTraceLogger`, `context-search-*.jsonl` stream, budget-exhausted/error-path trace semantics).
- **Touchpoints:** `apps/mcp-server/src/observability/context-search-trace-logger.service.ts` (`source` field), `apps/mcp-server/src/messaging/messaging.module.ts` (import `ObservabilityModule`), `apps/mcp-server/src/messaging/bootstrap-context.service.ts` (inject logger, thread `correlationId`, capture + emit trace), `apps/mcp-server/src/mcp/mcp.service.ts` (set `source: 'context_query'` on the existing emit), `docs/context-management.md`.
- **Evidence:** live bootstrap dispatch 2026-07-17T16:43:33 (no trace) vs. concurrent `context_query` searches (full traces) during QRM9 close-out.

### Implementation Notes (follow-up, implemented)

**Files modified:**
- `apps/mcp-server/src/observability/context-search-trace-logger.service.ts` — added required `source: 'context_query' | 'bootstrap'` field to `ContextSearchTraceRecord`, placed next to `callerRole`. Backend `SearchTrace` (`libs/common/src/context-store/context-store.abstract.ts`) untouched, as specified.
- `apps/mcp-server/src/mcp/mcp.service.ts` — the existing `traceLogger.log({...})` call in `registerContextQueryTool` now sets `source: 'context_query'`.
- `apps/mcp-server/src/messaging/messaging.module.ts` — added `ObservabilityModule` to `imports` (alongside the existing `RegistryModule`). No circular-dependency risk, confirmed: `ObservabilityModule` has no imports of its own.
- `apps/mcp-server/src/messaging/bootstrap-context.service.ts` — added `ContextSearchTraceLogger` as a third constructor param; `selectProjectItems` gained a `correlationId?: string` param, passed from `assemble()`; the search call now passes a 5th `onTrace` arg capturing a `SearchTrace`; a new private `emitBootstrapSearchTrace()` helper builds and logs the `ContextSearchTraceRecord` (`source: 'bootstrap'`, `callerRole: null`, `scope: 'project'`, `id: null`, fresh `queryId`/`timestamp`), called from both the success branch (hits used) and the catch branch (if a trace was captured before the throw).
- `docs/context-store.md` — "Search Observability" section updated: trace record description now mentions `source`; architecture step 2 split into `context_query`/bootstrap enrichment paths; step 3 notes `MessagingModule` also imports `ObservabilityModule` so both callers share one `ContextSearchTraceLogger` singleton (one JSONL stream). Added a `source == "bootstrap"` jq example.
- `docs/context-management.md` — "Pattern 4: Bootstrap Context Injection" sequence diagram and prose updated to show the `onTrace` arg and when a trace is (not) emitted.
- Tests: `bootstrap-context.service.spec.ts` (+6: updated search-call-shape assertion for the 5th `onTrace` arg; new `search observability (#70 follow-up)` describe block — success path logs `source: 'bootstrap'` with mapped fields, `correlationId: null` when absent, error-with-captured-trace still logs; plus one added fallback-describe test asserting no log call when `onTrace` fires but hits are empty), `mcp.service.spec.ts` (updated existing trace assertion to check `source: 'context_query'`), new `messaging.module.spec.ts` (+2: compiles the *real* `MessagingModule` + `ContextStoreModule.forRoot()` + `McpServerConfigModule` and resolves `BootstrapContextService`/`ContextSearchTraceLogger`/`MessageBroker` from the actual DI graph — the other specs in this directory fully mock `BootstrapContextService`'s dependencies and never exercise Nest's module wiring, so this is the one test that would catch a missing/wrong `ObservabilityModule` import).

**Clarification vs. the literal spec text (not a behavior deviation — the AC and the narrative implementation-detail text disagreed, and the AC is authoritative):** §Implementation Details step 4/5 read ambiguously about the case where the ranked search *executes and calls `onTrace`* but returns zero hits (a real completed search that matched nothing, as opposed to "no ranked search executes"). Tracing `OpenSearchStore.search()` shows `onTrace` fires with `hitCountRaw: 0` in exactly this case, so a trace *could* be emitted here consistent with "mirror the context_query capture pattern exactly" (step 4). However Acceptance Criterion 5 explicitly lists "empty result" alongside "absent query" / "InMemory backend" as a no-trace case, with no "before any trace" qualifier (unlike its "search throws" clause, which does carry that qualifier) — implying blanket no-trace-on-empty-result. Implemented per the AC: `selectProjectItems` only emits a trace when the ranked search's hits are actually used for the returned selection, or when it throws after capturing a trace; a search that completes normally with zero hits falls through to recency with no trace, even though a `SearchTrace` was technically captured. Test `'should not log a trace when search completes (onTrace fires) but returns zero hits'` pins this reading. If future review prefers the "trace whenever onTrace fired" reading instead, the one-line fix is to call `emitBootstrapSearchTrace` unconditionally after the `search()` call rather than only inside `if (hits.length > 0)`.

**Verification:** `npm run build` clean (3 webpack bundles). `npm run lint` clean (no new warnings). `npm run test`: 49 suites / 946 tests, all green — up from 48 suites on this branch pre-change (new `messaging.module.spec.ts` suite, +2 tests; several new/updated cases in `bootstrap-context.service.spec.ts` and one updated assertion in `mcp.service.spec.ts`).