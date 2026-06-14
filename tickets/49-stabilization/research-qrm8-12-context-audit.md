# #12 Handler-Controlled Commit & Push — Context-Access Audit

**Date compiled:** 2026-06-13
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#12")
**Ticket:** `tickets/12-handler-commit-push.md` · **PR:** #41
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #12, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

> **Why this ticket matters.** #12 is the session's **clearest waste case** — the index's own prediction, here confirmed at the trace level. It ran **7 scoped searches, every one returning 0/0** (the session's largest empty-search count, traces L16–L22), and the agent-side memory channel failed in its most expensive form: the **fix invocation 12 hours later** (`e0728f86`) searched conversation scope and read agent scope for the Pass A/B implementation context — which **genuinely existed** in the store — and got nothing, then re-derived the entire commit-message-extraction chain from the PR diff and the review comment. Where #13 was the *neutral floor* (the store carried nothing because almost nothing was written or queried) and #11 was the *success* (a real `14→11` transfer plus a 7× key handoff), #12 is the *negative*: the store was written to **eleven times** — more writes than any ticket but #11 — and **not one of those records was ever read by an agent**. It is the dataset's strongest evidence that the store did not merely sit idle but *actively absorbed effort that flowed nowhere*. Two structural facts make it sharp: (a) the ticket's own `12-project-notes` is **617 tokens — oversized** — so it never entered a single bootstrap, not even its own fix/re-review invocations (B1, extending #13-B1/#56), and (b) #12 reproduces #11-B4's **concurrent same-role** pattern (two Pass-A developers), with cross-sibling coordination happening via git state, never the store (B3). It also resolves the index's open **G4** question (the `12-rereview-verdict` double-embed) — a write-path/backfill-sweep race, not a duplicate logical write (B5).

## Scope correction vs the index

The index lists **8** rows for #12. The full log sweep —

```bash
grep 'Invocation received' logs/{teamlead-20260525T001458,developer-20260525T002445}.jsonl \
  | grep -iE '#12|PR #41|commit.*push'
```

— confirms the set is **complete and clean: 8 agent invocations** (teamlead ×4 incl. setup, revise, /code-review, re-review; developer ×4 incl. Pass A primary, Pass A duplicate, Pass B, fix). **No ENOSPC failures, no probes** (unlike #31's 5-vs-1 undercount). The one wrinkle the index already names is present and confirmed: the `b73c9f7b` Pass-A is a **transport-retry duplicate that ran productively** (it pushed nothing new but wrote a near-identical record — see I4/E13), and the `df3d7b8e` re-review **double-embedded** `12-rereview-verdict` (G4 — see E27/B5). Four facts worth foregrounding:

1. **Seven scoped searches, all empty — the session maximum.** Traces L16–L22 (`context-search-20260524T003426.jsonl`) are all `hitCountRaw=0`, `results=[]`, `engine=hybrid` (Ollama up — no `bm25-only` fallback). The MCP-server side confirms each (`mcp:8863/8867/8930/8934/9273/9277/10369`). No `mode=search` on #12 ever returned anything.
2. **The Pass-A duplicate ran concurrently with the primary.** `b03aa795` (primary) booted 01:03:05 and wrote its implementation record at 01:08:19; `b73c9f7b` (duplicate) booted 01:07:16 — *while the primary was still running* — and wrote at 01:10:14. This is #11-B4's concurrent-same-role scenario, repeated (B3).
3. **The fix invocation is the waste case's centre.** `e0728f86` (13:25, ~12 h after Pass B) ran the prescribed agent-scope `get-all` (→0) **and** a conversation search (L22 →0/0) looking for prior #12 work, found nothing, and re-derived the fix from the PR diff + the `/code-review` comment. The ~6 records it needed all existed, write-only, in foreign partitions.
4. **The bootstrap head never moved across the entire ticket.** All 8 invocations carried the identical 4-item / **549-token** head led by `13-project-notes` — including the cross-day fix (05-25 13:25) and the cross-*session* re-review (05-27 01:41). The ticket's own `12-project-notes` (617 tok) is **too large for the 600-token project budget** and so never displaced it (B1).

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-25 00:40:03 | `1c914324-67d0-4826-87c6-ec51215ce5bd` | teamlead / setup (PR #41 drafted) | `teamlead-20260525T001458.jsonl` | bootstrap **E1** · write **E2** (`conversation:…:12-ticket-setup`) |
| I2 | 00:51:36 | `f05a064b-e9de-4da6-9e57-1ba4addf7960` | teamlead / revise (user: delegate commit msg to agent) | `teamlead-20260525T001458.jsonl` | bootstrap **E3** · write **E4** (`conversation:…:12-revision-summary`) |
| I3 | 01:03:05 | `b03aa795-beca-4f7e-91e2-45f8b75d7ea8` | developer / Pass A **primary** | `developer-20260525T002445.jsonl` | bootstrap **E5** · search **E6** (L16 agent →0/0) · search **E7** (L17 conv →0/0) · write **E8** (`agent:…:ticket-12-research`) · write **E9** (`conversation:…:ticket-12-pass-a-implementation`) |
| I4 | 01:07:16 | `b73c9f7b-e1b3-457d-8390-c0ca73c9d4ac` | developer / Pass A **DUPLICATE** (ran concurrently, pushed nothing new) | `developer-20260525T002445.jsonl` | bootstrap **E10** · search **E11** (L18 agent →0/0) · search **E12** (L19 conv →0/0) · write **E13** (`conversation:…:ticket-12-pass-a-implementation`) |
| I5 | 01:29:30 | `de7a525f-ec9b-4369-a6c5-eec42fa2565a` | developer / Pass B (tool-guard deny rules + prompt) | `developer-20260525T002445.jsonl` | bootstrap **E14** · search **E15** (L20 agent →0/0) · search **E16** (L21 conv →0/0) · write **E17** (`agent:…:pass-b-research`) · write **E18** (`conversation:…:12-pass-b-result`) |
| I6 | 01:34:48 → 01:55:57 | `8a551bf6-4502-4f8a-819c-bee10c281853` | teamlead / **/code-review** (caught dead-code primary path) | `teamlead-20260525T001458.jsonl` | bootstrap **E19** · write **E20** (`project:_:12-project-notes`) |
| I7 | 13:25:59 | `e0728f86-fc39-476c-92ae-6ddf1657f981` | developer / fix (`<commit-message>` extraction wiring) | `developer-20260525T002445.jsonl` | bootstrap **E21** · agent get-all **E22** (→0) · search **E23** (L22 conv →0/0) · write **E24** (`agent:…:12-research-findings`) · write **E25** (`conversation:…:12-delimiter-extraction-impl`) |
| I8 | 05-27 01:41:22 | `df3d7b8e-8a21-4fbc-97c0-92370bc3836c` | teamlead / re-review (fix accepted) | `teamlead-20260525T001458.jsonl` | bootstrap **E26** · write **E27** (`conversation:…:12-rereview-verdict`, **embedded twice** — G4) |

**Versions.** All ten distinct written keys are single-version (`updatedAt: null`; OpenSearch returns one record per key, no overwrite markers — unlike #31's v1→v2). The two `ticket-12-pass-a-implementation` records are **not** an overwrite — they live in *different* conversation partitions (`b03aa795…` and `b73c9f7b…`), so both survive in OpenSearch (B3). The `12-rereview-verdict` double-embed (E27) is **two embeddings of one document**, not two records (B5). Total #12 store footprint: **8 bootstraps + 7 empty searches + 1 zero-return get-all + 11 writes = 27 access points** — the second-heaviest in the audited set after #11, and the one with the lowest realized return.

---

## Data recovery method

Same toolkit as the #31/#17/#16/#14/#11/#13 audits. RAW write bodies recovered by querying the running `quorum-opensearch-1` container (data volume intact) with the embedding vector excluded:

```bash
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=40' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["12-ticket-setup","12-revision-summary","ticket-12-research",
       "ticket-12-pass-a-implementation","pass-b-research","12-pass-b-result","12-project-notes",
       "12-research-findings","12-delimiter-extraction-impl","12-rereview-verdict"]}},
      "_source":{"excludes":["embedding"]},"sort":[{"createdAt":{"order":"asc"}}]}'
```

All ten keys returned complete bodies plus `createdAt`/`createdBy`/`scope`/`id`; the `terms` query returned **eleven hits** because `ticket-12-pass-a-implementation` exists twice (different `id`/partition) — both rendered below (E9, E13). Bootstrap item *keys and full text* (gap G2) recovered from each role log's `=== Initial prompt for correlationId=… ===` debug line, which embeds the rendered `## Prior Decisions` block verbatim — done for **all 8** invocations; the block is **byte-identical across all eight** (E1 below; the others reference it). Search traces (all 100-slot result arrays, here empty) pulled by `queryId` from `context-search-20260524T003426.jsonl`. Write timings anchored to the `EmbeddingPipelineService "Embedded document"` events in `mcp-server-20260524T003426.jsonl` and the `createdAt` epochs. **The G4 double-write was diagnosed** by reading the MCP-server log around `mcp:30090–30099`, which shows the synchronous embed, then a `Backfilling embeddings for 1 document(s)` sweep, then a second embed of the same key 547 ms later. All code claims in the writes were checked against the live tree (`apps/agent/src/connection/invocation-handler.service.ts`, `apps/agent/src/llm/claude-code.service.ts`, `libs/common/src/messaging/invoke.types.ts`, `apps/agent/src/config/role-tool-profiles.ts`, `apps/mcp-server/src/embedding/embedding-pipeline.service.ts`).

---

## Chronological access-point audit

### E1 — Bootstrap injection, setup (I1, 00:40:03) — and the static head across all 8 invocations

`BootstrapContextService` assembled **4 items, 549 tokens, scopes=[project, conversation]** (`mcp:8622`). Conversation leg empty (fresh `1c914324`), so all 4 are project scope. **The identical 4-item / 549-token head was injected into all eight #12 invocations** (E1/E3/E5/E10/E14/E19/E21/E26 — verified byte-identical via each invocation's initial-prompt block, including the cross-day fix and the cross-session re-review). It is the *same* head #13's final invocation (I5/E9 in the [#13 audit](research-qrm8-13-context-audit.md)) moved to after `13-project-notes` was written — i.e. #12 inherited #13's post-write head and **kept it for the entire ticket**. Rendered:

```
## Prior Decisions

### Project Context
- 13-project-notes: "PR #40 code review accepted for ticket #13 (branch-in-flight guard in
  MessageBroker). … (1) branchLocks map added to MessageBroker … mirroring the callChains lifecycle
  … (2) Same-correlationId exemption … This exemption is load-bearing … Dependency graph: #13
  depended on #11 … #13 is now complete …"                                              [≈401 tok]
- two-tier-billing-docs: "Documented the two-tier billing split in docs/system-design.md (line 377,
  after the x-shared-env table). Agents authenticate via ANTHROPIC_API_KEY … the moderator via
  CLAUDE_CODE_OAUTH_TOKEN … Commit 9a65379 on QRM7-000-roadmap-staging."                [≈120 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                      [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                             [≈10 tok]
```

**Quality feedback:**
- **Quality: off-topic for #12 (0/4 slots relevant).** #12 is a handler-side commit/push + tool-guard ticket. Item #1 (`13-project-notes`) is the *previous* ticket's branch-lock note — adjacent in the broker/worktree milestone but sharing no surface with commit-message delegation or git deny-rules; `two-tier-billing-docs` is about auth env-vars; the elicitation pair is the month-old QRM6 residue present in all 34 session bootstraps. Note the near-miss: `12` semantically depends on `#15` (PAT wiring) and `#11` (worktree cwd), yet neither `15-*` nor `11-*` is in the head — the head is governed by the *unsorted-`getAll` + budget* mechanics (B1), not relevance.
- **Re-usability: delivery only.** The setup teamlead drafted `tickets/12-handler-commit-push.md` from the **moderator's dispatch prompt** (which carries the D2 spec — commit-message format, push error handling, order of operations, the `deriveCommitMessage` helper vs correlationId fallback). The head played no part.
- **Added value beyond `docs/`+`tickets/`: zero.** The 549 tokens are the standing session tax.

### E2 — Write `conversation:1c914324…:12-ticket-setup` (I1, 00:42:44)

Setup completion record, `createdBy=teamlead`, single-version. RAW (complete):

```
Ticket #12 (Handler-Controlled Commit and Push) setup complete. Branch 12-handler-commit-push
created off 8-workspace-isolation-staging. Ticket file at tickets/12-handler-commit-push.md
committed (dd143d6). PR #41 opened targeting 8-workspace-isolation-staging (retarget trick applied).
Build/lint/test all pass (46 suites, 798 tests). This is the final Phase 3 ticket of QRM8. Architect
review NOT recommended — the design is fully specified in D2 (commit message format, push error
handling, order of operations). The only design decision surface is commit message derivation, which
is explicitly documented with two clear paths (ticket-ID prefix vs correlationId fallback) and a pure
helper function for testability. No new abstractions, no cross-cutting patterns, no ambiguity.
Straightforward implementation within well-defined boundaries.
```

**Quality feedback:**
- **Quality: accurate at write time, but describes a design that was overturned 9 minutes later.** Every claim matched the just-drafted ticket (branch off staging, PR #41, dd143d6, 798-test baseline, the "ticket-ID prefix vs correlationId fallback" derivation). But the "two clear paths … pure helper function" design is exactly what I2 (revise) **deletes** — see E4. As a point-in-time snapshot it is correct; as a durable record it was stale within the same ticket and was never updated (single-version).
- **Re-usability: zero — dead-end partition `conversation:1c914324…` (F1).** No agent read it. The revise invocation (I2, different correlationId) carried its instructions from the moderator's prompt, not this record.
- **Added value beyond `docs/`+`tickets/`: thin.** Duplicates the drafted ticket file's framing; store-unique residue is the dd143d6 SHA only.

### E3 — Bootstrap injection, revise (I2, 00:51:36)

**4 items, 549 tokens** (`mcp:8738`) — byte-identical to E1. The revise teamlead's actual instruction (drop the regex `deriveCommitMessage` helper; add a `commitMessage` field on `InvokeResponse`; rewrite SYSTEM_PREAMBLE Git Discipline) came from the **moderator's revise prompt relaying user feedback** ("delegate commit-message authoring to the agent"). The store contributed nothing the prompt didn't carry.

**Quality feedback:** off-topic head (0/4); **delivery-only** (no queries); **added value zero**.

### E4 — Write `conversation:f05a064b…:12-revision-summary` (I2, 00:53:54)

Revision record, `createdBy=teamlead`, single-version. RAW (complete):

```
Ticket #12 revised to delegate commit message authoring from handler to agent. Core change: instead
of the handler scanning request.action with regex to derive a commit message (brittle — action
strings are multi-paragraph and may reference unrelated ticket numbers), agents now populate an
optional commitMessage field on InvokeResponse. The handler uses it verbatim. If missing, a minimal
fallback "(no-message/<corrId-short>): changes from <target> invocation" is used with a WARN log.
New implementation section added for InvokeResponse schema change (section 1) and SYSTEM_PREAMBLE Git
Discipline rewrite (section 5). The old deriveCommitMessage() exported helper and its regex-based
ticket-ID scanning are dropped entirely. Acceptance criteria updated: added ACs for schema field,
verbatim use, fallback+WARN path, and prompt template update. Removed ACs for commit message
truncation and ticket-ID regex matching. Out of scope section added covering multi-commit, per-role
format differences, and handler-side message validation.
```

**Quality feedback:**
- **Quality: accurate and genuinely decision-flavoured — the single most store-worthy write of the ticket.** It captures the *rationale* for the architecture #12 actually shipped (the "action strings are multi-paragraph and may reference unrelated ticket numbers" brittleness argument is the real "why" behind the agent-authored `commitMessage` contract). Verified against the tree: the fallback string at `invocation-handler.service.ts:340` is verbatim `(no-message/${corrIdShort}): changes from ${request.target} invocation` with a `logger.warn` (`:341`); `commitMessage?` is on `InvokeResponse` (`invoke.types.ts:174`); no `deriveCommitMessage` symbol survives anywhere in the tree.
- **Re-usability: zero — dead-end partition `conversation:f05a064b…` (F1).** This is the cruel one: the Pass-A developers (I3/I4) needed *exactly* this rationale and the new contract, and **searched for it** (E7/E12 conversation searches) — and got 0/0, because it sat in `f05a064b…`, not their partitions. The information they re-derived from the (revised) ticket file instead.
- **Added value beyond `docs/`+`tickets/`: moderate at write time — but the same content was simultaneously written into the ticket file** (the revise invocation's whole job was rewriting the ticket's implementation sections + ACs). So the store copy duplicates the ticket the developers read anyway; it is not store-unique. The "why regex is brittle" sentence is the closest thing to store-unique reasoning, and even it is implied by the ticket's Out-of-Scope notes.

### E5 — Bootstrap injection, Pass A primary (I3, 01:03:05)

**4 items, 549 tokens** (`mcp:8857`) — byte-identical to E1. Note `12-ticket-setup`/`12-revision-summary` (written by I1/I2 into conversation scope) are **not** here: bootstrap pulls project + the *invocation's own* conversation partition, and I3's (`b03aa795`) is fresh. So the developer's bootstrap shows last-ticket's `13-project-notes`, not #12's own setup/revision notes.

**Quality feedback:** off-topic head; **delivery-only** (the developer implemented from the ticket file + moderator prompt + worktree); **added value zero**.

### E6 — Search L16 `agent` → **0/0** (I3, 01:03:12)

`context_query{scope:agent, mode:search, queryId:1c4db9cf, query:"ticket 12 handler commit push progress"}` → `hitCountRaw=0`, `results=[]`, hybrid, 414 ms (`mcp:8863`). The prescribed D7 "query agent scope first" start-of-task reflex.

**Quality feedback:**
- **Quality of the query: well-formed but structurally doomed (F1/F2).** It reads the developer's own fresh correlationId partition; nothing has written there, and no #12 agent-scope record exists *anywhere* yet (this is the first #12 developer). Even a future one would be unreachable (different correlationId).
- **Re-usability: nil. Added value: negative** — a 414 ms round-trip retrieving nothing.

### E7 — Search L17 `conversation` → **0/0** (I3, 01:03:13)

`context_query{scope:conversation, mode:search, queryId:cf373513, query:"ticket 12 handler commit push"}` → 0/0, 70 ms (`mcp:8867`).

**Quality feedback:**
- **Quality: the textbook F1 specimen.** The records that would answer this — `12-ticket-setup` (E2) and especially `12-revision-summary` (E4, the new contract) — **existed**, written 20 and 9 minutes earlier, but in partitions `1c914324…`/`f05a064b…`, not `b03aa795…`. The verbatim-relevant docs were one partition-address away and the scoped search could not reach them. This is the pure-addressing failure #17-B2 named, here with a *materially useful* target the agent actually wanted.
- **Re-usability: nil. Added value: negative.**

### E8 — Write `agent:b03aa795…:ticket-12-research` (I3, 01:03:33)

Pass-A research checkpoint, `createdBy=developer`, single-version. RAW (complete):

```
Ticket #12 Pass A research complete. Files to modify: (1) libs/common/src/messaging/invoke.types.ts
— add commitMessage to InvokeResponse interface at line 168. (2)
apps/agent/src/connection/invocation-handler.service.ts — replace checkUncommittedChanges (lines
272-291) with commitAndPush, wire into runInvocation. Uses execAsync for git commands with argv-style
quoting. (3) apps/agent/src/connection/invocation-handler.service.spec.ts — rework 'uncommitted
changes check' block (lines 920-1029) into 'commit and push' tests. Barrel export at
libs/common/src/messaging/index.ts already exports InvokeResponse as a type — no changes needed.
Branch: 12-handler-commit-push (confirmed). No prior work found in agent or conversation context.
```

**Quality feedback:**
- **Quality: accurate research synthesis.** The modification inventory matches the shipped change (`commitMessage?` landed on `InvokeResponse` — now at `:174` after the doc comment; `checkUncommittedChanges` was indeed replaced by `commitAndPush` at `invocation-handler.service.ts:318`). The closing sentence "**No prior work found in agent or conversation context**" is the developer *documenting its own E6/E7 misses* — an in-record fossil of F1.
- **Re-usability: zero (F2's exact target).** This is the canonical agent-memory checkpoint the #16 redirect policy was built for — and it was read by no one: not the concurrent Pass-A duplicate (I4, whose E11 agent search ran 4 min later → 0/0), not Pass B, not the fix invocation 12 h later (E22 get-all → 0). `agent:b03aa795…` is unreachable to every other correlationId.
- **Added value beyond `docs/`+`tickets/`: thin.** The file/line inventory is real reconnaissance, but it duplicates what the ticket's Implementation sections (rewritten in I2) already specify, and it went stale at write-time addresses no one queries.

### E9 — Write `conversation:b03aa795…:ticket-12-pass-a-implementation` (I3, 01:08:19)

Pass-A primary implementation record, `createdBy=developer`, single-version. RAW (complete):

```
Ticket #12 Pass A implementation complete. Three commits pushed to branch 12-handler-commit-push
(PR #41):\n\n1. a635a3d — Extended InvokeResponse interface with optional commitMessage field (inline
doc comment, barrel export unchanged since it already re-exports the type).\n\n2. d9c60e9 — Replaced
checkUncommittedChanges() with commitAndPush(cwd, request, response) in InvocationHandler. New
method: checks git status --porcelain; if changes and commitMessage present, uses verbatim; if
missing, synthesizes fallback '(no-message/<corrId-short>): changes from <target> invocation' and
logs WARN; stages with git add -A, commits with shellQuote helper, pushes to origin. Push failure
throws and surfaces as InvokeResponse { success: false, error: 'Commit/push failed: push rejected:
...' }. commitAndPush is only called when result.success is true (no commit on SDK failure). Worktree
remove in finally still runs.\n\n3. 4f5250c — Replaced 'uncommitted changes check' test block (5
tests) with 'commit and push' block (7 tests): no-changes path, verbatim commitMessage, fallback with
WARN, push rejection, no commit on SDK failure, multi-line passthrough, status check in worktree.
Also extended ExecuteResult with optional commitMessage field to enable the flow from SDK result to
handler response.\n\nDeviations from task description: (1) Added commitMessage to ExecuteResult
(success branch) in claude-code.types.ts … (2) Used shellQuote helper (private method) … Verification:
npm run build && npm run lint && npm run test all pass. 46 suites, 800 tests (798 baseline + 7 new -
5 removed).
```

**Quality feedback:**
- **Quality: high and code-verified.** `commitAndPush(cwd, request, response)` exists at `invocation-handler.service.ts:318`; it runs `git status --porcelain` (`:323`), uses `response.commitMessage` verbatim (`:335-336`), else the fallback + WARN (`:340-341`), `git add -A` (`:345`), commits via `shellQuote` (`:346`/`:365`), pushes via `execFileAsync('git', ['push', …])` (`:351`), and is gated on `result.success` with worktree removal in `finally`. The `ExecuteResult.commitMessage` deviation is real (`claude-code.types.ts`). The escaped `\n` literals are an artefact of how the agent JSON-encoded its own newlines into the record — a minor formatting wart, harmless.
- **Re-usability: zero — dead-end partition (F1).** Never read. Most pointedly, the **fix invocation** (I7) needed precisely this commit history (a635a3d/d9c60e9/4f5250c) to understand what to fix — and its conversation search (E23) returned 0/0; it read the commits from the PR instead.
- **Added value beyond `docs/`+`tickets/`: moderate-but-trapped.** The 3-commit narrative with rationale and the deviation notes are genuine engineering record — better than the ticket file at this point — but written to an address no consumer queries.

### E10 — Bootstrap injection, Pass A duplicate (I4, 01:07:16)

**4 items, 549 tokens** (`mcp:8928`) — byte-identical to E1. I4 (`b73c9f7b`) is the transport-retry duplicate; its conversation partition is fresh, so it sees the same `13`-led head, not the primary's E8/E9 records written minutes earlier.

**Quality feedback:** off-topic head; **delivery-only**; **added value zero**.

### E11 — Search L18 `agent` → **0/0** (I4, 01:07:22) · E12 — Search L19 `conversation` → **0/0** (I4, 01:07:24)

`queryId 56e8ac99` *"ticket 12 handler commit push implementation"* (agent, 65 ms, `mcp:8930`) and `queryId 68d9c657` *"ticket 12 handler commit push"* (conversation, 69 ms, `mcp:8934`), both 0/0.

**Quality feedback:**
- **Quality: the sharpest F1 instance in the ticket.** At 01:07, the primary's `ticket-12-research` (E8, 01:03:33) and — moments later — `ticket-12-pass-a-implementation` (E9, 01:08:19) were being written *by a concurrently-running sibling on the same branch*. The duplicate searched both scopes for "Pass A implementation" and got nothing, because `agent:b73c9f7b…`/`conversation:b73c9f7b…` ≠ the primary's partitions. It then discovered the work was already done **via git state** (the primary's three pushed commits), not the store — and wrote E13 to say so. This is #11-B4's concurrency failure reproduced (B3).
- **Re-usability: nil. Added value: negative** — two round-trips against partitions a sibling's data could never reach.

### E13 — Write `conversation:b73c9f7b…:ticket-12-pass-a-implementation` (I4, 01:10:14)

Duplicate Pass-A record (same key as E9, different partition), `createdBy=developer`, single-version. RAW (complete):

```
Pass A of ticket #12 (Handler-Controlled Commit and Push) is complete on branch
12-handler-commit-push. Three commits pushed:

Commit 1 (a635a3d): Extended InvokeResponse interface with optional commitMessage field in
invoke.types.ts. Inline doc comment describes agent-authored semantics with minimal fallback.

Commit 2 (d9c60e9): Replaced checkUncommittedChanges with commitAndPush in InvocationHandler. New
method runs git status --porcelain, uses response.commitMessage verbatim if present, synthesizes
fallback (no-message/corrId-short) with WARN log if missing, and throws on push rejection. Wired into
runInvocation — only called when result.success is true. Push rejection surfaces as InvokeResponse {
success: false, error: "Commit/push failed: push rejected: ..." }. Worktree cleanup in finally still
runs regardless. Private shellQuote helper escapes single quotes for safe argv-form commit messages.

Commit 3 (4f5250c): Replaced 5 old uncommitted-changes-check tests with 7 new commit-and-push tests
… Also extended ExecuteResult success branch with optional commitMessage … Verification: 46 suites,
800 tests all passing. Build and lint clean. Net test delta: +2 (5 removed, 7 added). Branch fully
pushed to origin/12-handler-commit-push.
```

**Quality feedback:**
- **Quality: accurate but fully redundant with E9.** It describes the *same three commits* the primary already recorded — because the duplicate inspected the same pushed git state. The two records agree on every SHA and the 800-test count. This is the store faithfully recording **redundant work**, not new knowledge.
- **Re-usability: zero — dead-end partition (F1).** Never read.
- **Added value beyond `docs/`+`tickets/`: zero, arguably negative.** It is a second copy of E9's content in a second unreachable partition: it *adds store entries without adding information*. The pair (E9+E13) is the dataset's cleanest example of concurrency-induced store pollution (cf. #14-B2's transport-retry fork, here on the developer side).

### E14 — Bootstrap injection, Pass B (I5, 01:29:30)

**4 items, 549 tokens** (`mcp:9271`) — byte-identical to E1.

**Quality feedback:** off-topic head; **delivery-only** (Pass B did the tool-guard deny rules + SYSTEM_PREAMBLE rewrite from the ticket's Pass-B section + moderator prompt); **added value zero**.

### E15 — Search L20 `agent` → **0/0** (I5, 01:29:37) · E16 — Search L21 `conversation` → **0/0** (I5, 01:29:38)

`queryId 6b907e1a` *"ticket 12 handler commit push pass B"* (agent, 371 ms, `mcp:9273`) and `queryId 81c038d1` *"ticket 12 handler commit push"* (conversation, 64 ms, `mcp:9277`), both 0/0.

**Quality feedback:**
- **Quality: F2 in its intended-use form.** Pass B explicitly searched agent scope for "pass B" research and conversation scope for prior implementation — i.e. it tried to pick up where Pass A left off. Pass A's `ticket-12-research` (E8) and `ticket-12-pass-a-implementation` (E9/E13) existed but in foreign partitions → 0/0. Pass B re-established context from the branch's 3 commits + the ticket's Pass-B section.
- **Re-usability: nil. Added value: negative.**

### E17 — Write `agent:de7a525f…:pass-b-research` (I5, 01:30:01)

Pass-B research checkpoint, `createdBy=developer`, single-version. RAW (complete):

```
Pass B research complete. On branch 12-handler-commit-push. 3 Pass A commits already on branch
(a635a3d, d9c60e9, 4f5250c). Four tasks: (1) Update deniedBashCommands in role-tool-profiles.ts —
developer needs git commit/push/checkout-b/branch added (replacing force-push-only entries), teamlead
same, architect needs git branch added, qa needs git checkout -b and git branch added, productowner
is no-op. (2) Rewrite Git Discipline in SYSTEM_PREAMBLE at role-prompt-templates.ts lines 89-98. (3)
Add tool guard tests in tool-guard-hook.spec.ts for newly denied commands. (4) Flip ACs + add
Implementation Notes in ticket file. Prefix matching via normaliseBashCommand (collapse whitespace,
strip sudo, lowercase) + startsWith check on denied prefixes.
```

**Quality feedback:**
- **Quality: accurate and confirms cross-pass awareness via git, not store.** The "3 Pass A commits already on branch (a635a3d, d9c60e9, 4f5250c)" line proves Pass B knew of Pass A's work — but it learned that from the *branch*, not from E8/E9 (which its E15/E16 searches missed). The task list matches the shipped deny rules: `role-tool-profiles.ts:60-63` (developer), `:73-76` (architect), `:88-91` (teamlead), `:102-105` (qa) all deny `git commit`/`git push`/`git checkout -b`/`git branch`; productowner has `deniedBashCommands: []` with Bash disabled at tool level (`:121`).
- **Re-usability: zero (F2).** Never read.
- **Added value beyond `docs/`+`tickets/`: thin.** Restates the ticket's Pass-B section; the `normaliseBashCommand` detail is the only near-store-unique note, and it duplicates existing tool-guard code.

### E18 — Write `conversation:de7a525f…:12-pass-b-result` (I5, 01:33:44)

Pass-B completion record, `createdBy=developer`, single-version. RAW (complete):

```
Pass B of ticket #12 (Handler-Controlled Commit and Push) implemented and pushed on branch
12-handler-commit-push. Four commits: 8f62cef (deny rules across all role profiles), 6d73d9e (Git
Discipline prompt rewrite), b1a4e31 (tool guard tests + prompt template test updates), cb415d4 (AC
flips + Implementation Notes). All pushed to remote. Verification: 813 tests across 46 suites, build
clean, lint clean. The SYSTEM_PREAMBLE Git Discipline rewrite is agent-affecting — post-merge
container rebuild required. No deviations from spec.
```

**Quality feedback:**
- **Quality: accurate; one genuinely operational datum.** Commits and the 813-test count check out. The store-unique value is the **operational flag** "the SYSTEM_PREAMBLE rewrite is agent-affecting — post-merge container rebuild required" — a deploy consequence that the ticket file states but which is easy to lose; this is the kind of fact the KB vision wants surfaced.
- **Re-usability: zero — dead-end partition (F1).** No agent read it; the rebuild requirement, if acted on, was acted on from the ticket/PR, not the store.
- **Added value beyond `docs/`+`tickets/`: thin** (the rebuild flag is also in the ticket's Implementation Notes that cb415d4 added).

### E19 — Bootstrap injection, /code-review (I6, 01:34:48)

**4 items, 549 tokens** (`mcp:9382`) — byte-identical to E1. At review time (01:34) `12-project-notes` did not exist yet — I6 writes it 21 minutes later at E20 (the `/code-review` skill run is long). So the review's own bootstrap shows the `13`-led head, not any #12 record.

**Quality feedback:** off-topic head; **delivery-only** (the review ran the `/code-review` skill over the PR diff); **added value zero**.

### E20 — Write `project:_:12-project-notes` (I6, 01:55:57)

The review verdict synthesis — **2,471 chars ≈ 617 tokens**, `createdBy=teamlead`, single-version. The largest project-note in the audited set (> #31's 674-char/674-tok and #11's ≈770-tok ballpark in *token weight*). RAW (complete):

```
PR #41 code review accepted for ticket #12 (handler-controlled commit and push). Two-comment review
posted: raw /code-review skill output + verdict summary.

Key patterns established: (1) commitAndPush() method in InvocationHandler replaces
checkUncommittedChanges(). The method runs git status --porcelain, stages with git add -A, commits
with agent-provided commitMessage (or synthesized fallback), and pushes to origin. This is the
post-SDK-execution commit pipeline, gated on result.success. (2) shellQuote() private helper for safe
shell string construction — wraps in single quotes with embedded quote escaping. Used for commit
messages. (3) InvokeResponse.commitMessage optional field — the agent-to-handler contract for commit
message delegation. Currently always undefined in production (ClaudeCodeService doesn't extract it
from SDK results), so the fallback path executes with a WARN log. A follow-up ticket is needed to
wire extraction. (4) Comprehensive deny rules across all roles: developer, teamlead, architect, and
qa all deny git commit, git push, git checkout -b, git branch. Productowner unchanged (Bash fully
disabled). The git branch prefix blocks all variants including read-only listing.

Integration points: commitMessage flows from ExecuteResult (claude-code.types.ts) through
InvokeResponse (invoke.types.ts) to commitAndPush() in InvocationHandler. The SYSTEM_PREAMBLE Git
Discipline section instructs agents to populate commitMessage. The deny rules in role-tool-profiles.ts
enforce the mechanical prohibition. These three layers (prompt instruction, tool guard enforcement,
handler commit pipeline) form a complete handler-controlled git model.

Test coverage: 813 tests across 46 suites. New tests: 7 commit-and-push handler tests … 13 tool guard
tests … Updated prompt template tests …

Dependency graph: #12 depended on #11 (worktree cwd) and #15 (PAT wiring), both merged. #12 completes
the handler-controlled git model — the final Phase 3 ticket of QRM8. No downstream tickets were
blocked on #12 specifically, but it enables the full workspace isolation model to function end-to-end.
```

**Quality feedback — checked against the shipped code:**
- **Quality: accurate, and item (3) is the most valuable single datum #12 produced — the live dead-code finding.** It correctly diagnoses that `commitMessage` was "currently always undefined in production (ClaudeCodeService doesn't extract it from SDK results), so the fallback path executes" — this is the `/code-review` catch that triggered the fix invocation. The three-layer model (prompt / tool-guard / handler) is an accurate architectural summary; the integration-points chain is verified (`ExecuteResult.commitMessage` → `InvokeResponse.commitMessage` → `commitAndPush`). **But item (3)'s forward claim — "A follow-up ticket is needed to wire extraction" — went stale within the same session:** the wiring was done ~12 h later *inside #12* by the fix invocation (I7: `extractCommitMessage` at `claude-code.service.ts:276`, now called from the `result/success` branch at `:246-255`), not by a follow-up ticket. The note was never corrected (B4).
- **Re-usability: zero — and uniquely so for a project-note.** Unlike `14-project-notes` (consumed by #11) or `13-project-notes` (bootstrap self-loop), `12-project-notes` **never appeared in any bootstrap or search** — because at **617 tokens it overflows the 600-token project budget** and is skipped by `applyBudget` (B1). It is the only audited project-note that not even its *own* downstream same-ticket invocations (the fix I7, the re-review I8) ever saw, despite both booting after it was written.
- **Added value beyond `docs/`+`tickets/`: moderate, trapped twice over.** The dead-code finding (item 3) is real, store-unique-quality knowledge — but it was *also* the published `/code-review` PR comment (the channel that actually drove the fix), and the store copy was both unread and budget-excluded from bootstrap. Highest-value content, lowest-reach address.

### E21 — Bootstrap injection, fix (I7, 13:25:59, ~12 h later)

**4 items, 549 tokens** (`mcp:10364`) — **still byte-identical to E1**: `13-project-notes` #1. Twelve hours and one project write (`12-project-notes`, E20) after the head was set, the fix invocation's bootstrap is unchanged — `12-project-notes` (617 tok) never entered, and nothing else displaced `13-project-notes`. The invocation that most needed #12 context booted with last-but-one ticket's branch-lock note.

**Quality feedback:**
- **Quality: off-topic and now actively misleading by omission.** The fix's task is "wire commit-message extraction" — the head carries none of #12's own design, contract, or the dead-code finding that motivated the fix; it carries `13`'s branch-lock note.
- **Re-usability: delivery-only.** The fix read the `/code-review` comment + PR diff from GitHub.
- **Added value beyond `docs/`+`tickets/`: zero.**

### E22 — Read `agent get-all id=e0728f86…` → **0** (I7, 13:26:08)

`context_query{scope:agent, mode:get-all, correlationId:"e0728f86…"}` → **0 items** (`mcp:10365`). The D7 reflex against the fix invocation's own fresh agent partition.

**Quality feedback:**
- **Quality: structurally empty (F1/F2), and the most consequential empty read in the dataset.** The fix needed Pass A's `ticket-12-research` (E8) and Pass B's `pass-b-research` (E17) — both genuine agent-scope checkpoints, both authored by the *same role* (developer) earlier in the same ticket — and the get-all returned 0 because `agent:e0728f86…` ≠ their partitions. This is the precise scenario the #16 agent-memory redirect was meant to serve, failing at the 12-hour cross-invocation distance.
- **Re-usability: nil. Added value: negative.**

### E23 — Search L22 `conversation` → **0/0** (I7, 13:26:12)

`context_query{scope:conversation, mode:search, queryId:2fc3192a, query:"ticket 12 commit message handler"}` → 0/0, 375 ms (`mcp:10369`).

**Quality feedback:**
- **Quality: the waste case's keystone.** This query is *exactly on target* — "ticket 12 commit message handler" is what the fix is about — and the matching records existed: `ticket-12-pass-a-implementation` (E9/E13, describing `commitAndPush`), `12-pass-b-result` (E18), and the revision rationale `12-revision-summary` (E4). All in foreign conversation partitions → 0/0. The fix re-derived the entire `SDK result → ExecuteResult → InvokeResponse → commitAndPush` chain from the PR diff (it documents exactly that re-derivation in E24).
- **Re-usability: nil. Added value: negative.**

### E24 — Write `agent:e0728f86…:12-research-findings` (I7, 13:28:33)

Fix-invocation research checkpoint, `createdBy=developer`, single-version. RAW (complete):

```
Research complete for #12 dead-code fix. The chain is: SDK result text (message.result) →
processMessage() builds ExecuteResult (line 244-253) → ExecuteResult.commitMessage mapped to
InvokeResponse.commitMessage (handler line 159) → commitAndPush() reads response.commitMessage
(handler line 302). The gap: processMessage() never populates commitMessage. Fix: add
extractCommitMessage() static method, wire into processMessage success case, update SYSTEM_PREAMBLE
to instruct agents to use <commit-message> blocks, update prompt template tests (line 103 assertion
needs to check for commit-message instead of commitMessage), add 6 new tests in
claude-code.service.spec.ts. Branch: 12-handler-commit-push, current HEAD: cb415d4.
```

**Quality feedback:**
- **Quality: accurate and high-value — but it is a *re-derivation* of knowledge the store already held.** The "gap: processMessage() never populates commitMessage" is the same finding `12-project-notes` item (3) already recorded (E20) — the fix agent re-discovered it from code because it could not read the prior note (E21–E23 all missed it). The fix plan matches the shipped change: `extractCommitMessage` (`claude-code.service.ts:276`) wired into the `result/success` case (`:246-255`).
- **Re-usability: zero (F2).** Never read (no further #12 developer invocation).
- **Added value beyond `docs/`+`tickets/`: moderate-but-duplicative.** Genuinely good engineering trace, but it duplicates E20's diagnosis and the work it documents is itself a duplication of analysis the store could have served for free. This record is the *cost* of F1/F2 made legible.

### E25 — Write `conversation:e0728f86…:12-delimiter-extraction-impl` (I7, 13:30:48)

Fix implementation record, `createdBy=developer`, single-version. RAW (complete):

```
Implemented commit-message delimiter extraction for ticket #12 (PR #41 code-review fix). Added
extractCommitMessage() static method to ClaudeCodeService that parses <commit-message> blocks from
SDK result text using regex (case-insensitive, DOTALL via [\\s\\S]*?, last-block-wins for
multi-block). Wired into processMessage() success path — block content populates
ExecuteResult.commitMessage, tags stripped from result text. Updated SYSTEM_PREAMBLE Git Discipline
to instruct agents to output <commit-message> blocks. 6 new tests (819 total). Four commits pushed to
12-handler-commit-push: c469fa5, 71afefe, f7ea851, 725576c.
```

**Quality feedback:**
- **Quality: accurate, code-verified.** `extractCommitMessage` uses `/<commit-message>([\s\S]*?)<\/commit-message>/gi` with `matchAll` and last-block-wins (`claude-code.service.ts:276-291`); it populates `ExecuteResult.commitMessage` and strips tags from `result` (`:246-255`, `:290`). The four commits exist on the branch (`git log`: `c469fa5` extract, `71afefe` tests, `f7ea851` prompt, `725576c` ticket-notes update); 819-test count consistent.
- **Re-usability: zero — dead-end partition (F1).** The re-review (I8) read the PR, not this record.
- **Added value beyond `docs/`+`tickets/`: thin.** Commit 725576c ("update ticket notes — primary path is now wired") put the same resolution into the *ticket file*; the store copy is a duplicate, and notably **the store's `12-project-notes` item (3) was *not* correspondingly updated** — the correction flowed through the ticket/git channel, leaving the store note stale (B4).

### E26 — Bootstrap injection, re-review (I8, 05-27 01:41:22, cross-session)

**4 items, 549 tokens** (`mcp:30079`) — **still byte-identical to E1**, two days and a full session boundary later. `13-project-notes` remains item #1; `12-project-notes` (617 tok) still excluded.

**Quality feedback:** off-topic head (the re-review verified the fix from the PR commits); **delivery-only**; **added value zero**.

### E27 — Write `conversation:df3d7b8e…:12-rereview-verdict` (I8, 01:42:48) — **embedded twice (G4)**

Re-review verdict, `createdBy=teamlead`, single-version in OpenSearch but **two `Embedded document` events** 547 ms apart. RAW (complete):

```
Re-review of PR #41 fix commits (c469fa5, 71afefe, f7ea851, 725576c) confirmed the original
/code-review finding is resolved. The commitMessage dead-code issue is fixed: extractCommitMessage()
in ClaudeCodeService parses commit-message delimiter blocks from SDK result text, populates
ExecuteResult.commitMessage, and the handler uses it verbatim. Prompt updated with concrete block
syntax. 6 new tests. Build/lint/test all green at 819 tests. PR comment posted:
https://github.com/ia64mail/quorum/pull/41#issuecomment-4550514048
```

**Quality feedback:**
- **Quality: accurate; closes the dead-code loop.** Confirms the fix against the four fix commits; the verdict matches the shipped state. This is the record that *should* have updated `12-project-notes` item (3) ("follow-up ticket needed" → "resolved in-session") but instead lives in its own conversation partition; the project-note remains stale (B4).
- **Re-usability: zero — dead-end partition (F1).** End of the #12 chain; never read.
- **Added value beyond `docs/`+`tickets/`: thin** (duplicates the published PR comment it links to) — **and it cost two embeddings** (B5): the synchronous write embed at 01:42:48.993, then a periodic backfill sweep (`Backfilling embeddings for 1 document(s)` at 01:42:49.138) re-embedded the same key at 01:42:49.540. One redundant Ollama call; the store holds a single record (`updatedAt=null`).

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — The bootstrap head was *frozen* for the entire ticket, and `12-project-notes` (617 tok) self-excluded — confirming and extending #13-B1/[#56](https://github.com/ia64mail/quorum/issues/56) with a third oversized specimen and a new "stickiness" observation.** All eight #12 invocations — across a 12-hour gap (setup 00:40 → fix 13:25) and a two-day, cross-session boundary (→ re-review 05-27 01:41) — carried the **byte-identical** 549-token head `{13-project-notes (≈401 tok), two-tier-billing-docs (≈120), qrm6-rerun-elicit-A (12), elicitation-test-A (10)}`. Two mechanisms, both code-verified, explain the freeze:
  - *(oversized self-exclusion, [#56](https://github.com/ia64mail/quorum/issues/56))* `12-project-notes` weighs **617 tokens** (`docker exec … _search` → 2,471 chars). The project budget is 600 tokens, so `applyBudget` skips it entirely — it never enters a bootstrap, not even its own ticket's fix/re-review invocations that booted *after* it was written (E21/E26). This is the **third** oversized-note specimen, joining #31's 674-tok note and #11's ≈770-tok `11-project-notes`, and it is the cleanest yet because we can watch two same-ticket downstream invocations boot without it. It directly **vindicates #13-B1's refinement of #56**: concise notes (#13's 401, #14's 345) bootstrap; only oversized ones (#31, #11, **#12**) self-exclude. The actionable refinement stands — *size discipline* (keep `{ticket}-project-notes` ≤ ~400 tok) already makes a note bootstrap-eligible under today's budget — and #12 is now the strongest evidence that the teamlead's *verbose-review* notes systematically exceed it (the more thorough the review, the less likely its note ever reaches a reader).
  - *(stickiness under unsorted `getAll`, [#55](https://github.com/ia64mail/quorum/issues/55))* because the one newer eligible-by-recency project write (`12-project-notes`) was budget-excluded, **nothing displaced `13-project-notes`** for the whole ticket. Contrast #13-B1, where writing a *concise* `13-project-notes` (401 tok) reshuffled the head within one ticket. The pair #13/#12 makes the dependency explicit: the head moves **only when an under-budget project note is written**; an over-budget write leaves the head frozen. This sharpens #55 from "order is arbitrary" to "order is arbitrary *and* sticky against oversized writes" — a newer high-value note can be simultaneously the most relevant record in the store and structurally invisible.

  No new issue — this is concrete reinforcement for [#55](https://github.com/ia64mail/quorum/issues/55) and the spec ticket on this very branch, [#56](https://github.com/ia64mail/quorum/issues/56) (`56-bootstrap-budget-sizing`): cite `12-project-notes` (617 tok, excluded from its own fix/re-review bootstraps) as the specimen proving the teamlead's review notes routinely overshoot the budget, and the #13/#12 contrast as proof the head is write-sensitive *only* for under-budget notes.

**B2 — #12 is the dataset's clearest "store actively wasted effort" case: 7 on-target scoped searches all returned 0/0, the matching records existed write-only in foreign partitions, and the fix invocation re-derived everything the store already held.** This is index-F1/F2 at maximum cost. Tally the realized return on #12's eleven writes: **every one was read by no agent** (F1) — the two `ticket-12-pass-a-implementation` copies (E9/E13), the three agent-scope checkpoints (E8/E17/E24, F2), the setup/revision/Pass-B/fix/re-review conversation records, and the budget-excluded `12-project-notes`. Against that, the consumers tried *hard*: 7 scoped searches (E6/E7/E11/E12/E15/E16/E23) + 1 agent get-all (E22), each well-phrased and on-topic, all empty. The keystone is the **fix invocation** (I7): its agent get-all and conversation search (E22/E23) targeted Pass A/B context that genuinely existed (`ticket-12-research`, `pass-b-research`, `ticket-12-pass-a-implementation`, `12-revision-summary`) and the *same finding it was about to re-derive was already in `12-project-notes`* — yet it read 0 from every channel and rebuilt the `extractCommitMessage` plan from the PR diff (E24 documents the re-derivation explicitly). #12 thus demonstrates the failure mode #13 (the floor) could not: #13 wrote little and queried nothing, so the store was *neutral overhead*; #12 wrote heavily and queried repeatedly, so the store became *negative* — it absorbed eleven writes and eight reads of effort and returned nothing, while the work it could have saved was redone. No new issue — this is the canonical, dated case study for the already-filed [#59](https://github.com/ia64mail/quorum/issues/59) (agent-scope addressing) and the F1 conversation-partition defect; #12 should be cited as *the* waste exemplar in the parent research.

**B3 — #12 reproduces #11-B4's concurrent same-role failure on the developer side, with cross-sibling coordination via git state, never the store.** The moderator's transport-retry spawned two Pass-A developers running **concurrently**: `b03aa795` (primary, booted 01:03:05, wrote its implementation at 01:08:19) and `b73c9f7b` (duplicate, booted 01:07:16 — *while the primary was still executing* — wrote at 01:10:14). The duplicate ran its prescribed agent + conversation searches (E11/E12, 01:07:22–24) for "Pass A implementation" and got **0/0**, because the primary's just-written `ticket-12-research`/`ticket-12-pass-a-implementation` lived in `agent:b03aa795…`/`conversation:b03aa795…`, not the duplicate's partitions. The duplicate instead discovered the work was done **via git state** (the primary's three pushed commits a635a3d/d9c60e9/4f5250c — quoted verbatim in E13) and wrote a redundant second `ticket-12-pass-a-implementation` (E13). This is strictly the #11-B4 scenario (two simultaneous same-role devs, sub-minute-old sibling data unreachable) reproduced on a second ticket — *direct, dated, developer-side corroboration* for [#59](https://github.com/ia64mail/quorum/issues/59). Two deltas from #11-B4 worth recording: (a) #12's duplicate wrote **no** agent-scope checkpoint (only the conversation impl record), so the redundancy is one duplicate key in two conversation partitions rather than #11's research-checkpoint fan-out; (b) the *recovery* channel was identical — **git, not the store** — confirming F3's thesis that the consequential cross-invocation substrate is the repo, with the store riding along. No new issue; cite #12 alongside #11 in #59 as the second concurrency specimen.

**B4 — `12-project-notes`'s forward-looking claim was invalidated *within the same session* and the correction flowed through the ticket/git channel, leaving the store record stale — the #17-B3/#13-B3 pattern, sharpened by budget-exclusion.** E20's item (3) recorded a genuine, store-unique-quality finding ("`commitMessage` currently always undefined in production … **A follow-up ticket is needed to wire extraction**"). That claim was **resolved ~12 hours later inside #12 itself**: the fix invocation (I7) added `extractCommitMessage` and wired it (commits `c469fa5`…`725576c`), and crucially `725576c` is titled *"update ticket notes — primary path is now wired"* — the resolution was written into the **ticket file**, while the store's `12-project-notes` was **never updated** (single-version, `updatedAt=null`; confirmed against OpenSearch). So the store now permanently asserts a "follow-up ticket needed" state that ceased to be true the same session. This is the #17-B3 write-only-TODO pattern and the #13-B3 "accurate-but-unaddressed" pattern combined, with a #12-specific twist that makes it worse: because the note is **617 tokens it never bootstrapped** (B1), it could not even have *warned* the fix invocation it was about to re-derive a finding the store already held. The lesson for the parent research: the store's freshness problem is not only that records go unread (F1) but that records that *would* mislead a reader are never corrected, while the ticket/PR substrate is — the canonical, self-updating channel is the repo, not the store. No new issue (the ticket file is correct as of this audit); this reinforces F1/F3 and is a concrete argument, for [#56](https://github.com/ia64mail/quorum/issues/56)/[#59](https://github.com/ia64mail/quorum/issues/59), that point-in-time syntheses without an update path actively decay.

**B5 — G4 resolved: the `12-rereview-verdict` double-write is a write-path/periodic-backfill-sweep race, not a duplicate logical write — one record, two embeddings.** The index's open G4 ("`12-rereview-verdict` embedded twice in 1 s, mcp:30096/30098 — duplicate write or re-embed worth a look") is the latter. The MCP-server log shows the sequence: synchronous embed at `01:42:48.993`, then `Backfilling embeddings for 1 document(s)` at `01:42:49.138`, then a second embed of the **same key** at `01:42:49.540`. `EmbeddingPipelineService` runs a periodic backfill sweep on a `setInterval` (`apps/mcp-server/src/embedding/embedding-pipeline.service.ts:76-83`) that re-embeds documents carrying `embeddingText`; here the sweep fired in the ~550 ms window after the synchronous write and re-embedded the just-written doc before the write path's embedding state had settled. **Net effect on the store is nil** — OpenSearch holds a single `12-rereview-verdict` record with `updatedAt=null` (verified) — so this is *not* data duplication and *not* the schema-drift/duplicate-write class; it is **one redundant Ollama embedding call** (~300–550 ms of wasted compute), benign for correctness. It is also not unique to #12: any write whose embedding overlaps a sweep tick will double-embed; #12 is simply where the trace caught it. **Severity: low** (compute waste, no correctness impact). Recommendation: a small guard (skip backfill for a doc whose synchronous embed is already in flight, or dedupe by `key`+content-hash within a sweep) would remove the redundant call — but given it is harmless and the embedding pipeline is on the QRM9 deferral track, this is a *fileable-if-desired* efficiency note rather than a correctness defect. **Not filed** pending a decision on whether to bundle it into existing embedding-pipeline work; flagged here so G4 can be closed as "re-embed, benign."

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap (I1 setup) | off-topic head (0/4 #12-relevant), 549 tok | n/a (delivery; spec from prompt) | **Zero** — standing session tax |
| E2 | write `12-ticket-setup` (conv) | accurate, but describes the design I2 overturns | **no** — dead-end partition (F1) | **Thin** — duplicates drafted ticket; SHA only |
| E3 | bootstrap (I2 revise) | off-topic head | n/a (delivery) | **Zero** |
| E4 | write `12-revision-summary` (conv) | **best write of the ticket** — agent-authored-commitMessage rationale | **no** — Pass A *searched for this* (E7) and missed it (F1) | **Moderate-but-trapped** — also written to ticket |
| E5 | bootstrap (I3 Pass A primary) | off-topic head | n/a (delivery) | **Zero** |
| E6 | search L16 agent → 0/0 | well-formed, structurally doomed (F1/F2) | **no** | **Negative** — 414 ms round-trip |
| E7 | search L17 conv → 0/0 | textbook F1 — target (E4) existed, unreachable | **no** | **Negative** |
| E8 | write `ticket-12-research` (agent) | accurate; records its own E6/E7 misses | **no** (F2) — unread by dup/Pass B/fix | **Thin** |
| E9 | write `ticket-12-pass-a-implementation` (conv) | high, code-verified 3-commit narrative | **no** — fix (E23) searched for it, missed | **Moderate-but-trapped** |
| E10 | bootstrap (I4 Pass A dup) | off-topic head | n/a (delivery) | **Zero** |
| E11 | search L18 agent → 0/0 | sharpest F1 — concurrent sibling's data unreachable (B3) | **no** | **Negative** |
| E12 | search L19 conv → 0/0 | same (B3) | **no** | **Negative** |
| E13 | write `ticket-12-pass-a-implementation` (conv, dup) | accurate but fully redundant with E9 | **no** — dead-end partition (F1) | **Zero/negative** — concurrency store pollution |
| E14 | bootstrap (I5 Pass B) | off-topic head | n/a (delivery) | **Zero** |
| E15 | search L20 agent → 0/0 | F2 intended-use form — Pass A checkpoints unreachable | **no** | **Negative** |
| E16 | search L21 conv → 0/0 | same | **no** | **Negative** |
| E17 | write `pass-b-research` (agent) | accurate; cross-pass awareness via git not store | **no** (F2) | **Thin** |
| E18 | write `12-pass-b-result` (conv) | accurate; store-unique "rebuild required" flag | **no** — dead-end partition (F1) | **Thin** |
| E19 | bootstrap (I6 /code-review) | off-topic head; `12-project-notes` not yet written | n/a (delivery) | **Zero** |
| E20 | write `12-project-notes` (project, **617 tok**) | **highest-value content** (dead-code finding) but item (3) went stale (B4) | **no** — budget-excluded from *its own* bootstraps (B1) | **Moderate, trapped twice** (unread + un-bootstrappable) |
| E21 | bootstrap (I7 fix, +12 h) | off-topic, frozen head; misleading by omission | n/a (delivery) | **Zero** |
| E22 | agent get-all → 0 | most consequential empty read — Pass A/B checkpoints unreachable | **no** (F1/F2) | **Negative** |
| E23 | search L22 conv → 0/0 | **keystone** — on-target, matching records existed | **no** | **Negative** — drives the re-derivation |
| E24 | write `12-research-findings` (agent) | accurate but **re-derives** E20's finding | **no** (F2) | **Moderate-but-duplicative** — the cost of F1/F2 made legible |
| E25 | write `12-delimiter-extraction-impl` (conv) | accurate, code-verified | **no** — dead-end partition (F1) | **Thin** — ticket updated via git (725576c), not store |
| E26 | bootstrap (I8 re-review, +2 d) | off-topic, frozen head (cross-session) | n/a (delivery) | **Zero** |
| E27 | write `12-rereview-verdict` (conv) — **2× embed (G4/B5)** | accurate; closes loop; should have corrected E20 | **no** — dead-end partition (F1) | **Thin** + one redundant embedding (B5) |

**Bottom line for the parent research:** #12 is the **waste case the index predicted, confirmed at the trace level — the negative pole of the audited set.** Where #13 was the *neutral floor* (the store carried nothing because nearly nothing was written or queried) and #11 was the *success* (a real `14→11` semantic transfer plus a moderator-addressed 7× key handoff), #12 shows the store **doing harm by omission at scale**: eleven accurate writes, seven on-target searches, one get-all — and **zero realized reads by any agent**. The two consumers who most needed the store — the concurrent Pass-A duplicate (B3) and the 12-hour-later fix invocation (B2) — both queried it correctly, both got nothing, and both fell back to **git state and the PR diff**, re-deriving knowledge the store demonstrably held. Three structural defects compound on this one ticket: F1's conversation-partition addressing (every cross-invocation read missed a record that existed), F2's correlationId-keyed agent scope (#59 — three checkpoints, zero consumption, one of them missed by the same role 12 h later), and the bootstrap budget (B1/#56 — the ticket's single highest-value record, the `/code-review` dead-code finding, weighed 617 tokens and so never reached even its own downstream invocations, which is *why* the fix re-derived it). The store's content quality on #12 is genuinely good — E4's delegation rationale and E20's dead-code diagnosis are exactly what a KB should capture — which is precisely what makes #12 the indictment: the bottleneck is never knowledge *quality*, it is **addressing and reach**. The repo (branches, commits, PR comments, ticket file) carried every consequential signal end-to-end; the Context Store was ~4.4 k bootstrap tokens, eight empty reads, and eleven unread writes of pure overhead — and, uniquely in the set, it cost real *re-derivation* effort that a working retrieval channel would have saved.

## Appendix — reproduction

```bash
# All eight #12 invocations (post-restart logs; no ENOSPC/probe rows — confirmed complete)
grep 'Invocation received' logs/teamlead-20260525T001458.jsonl logs/developer-20260525T002445.jsonl \
  | grep -iE '#12|PR #41|commit.*push'

# The 7 empty scoped searches (all hitCountRaw=0, results=[])
for q in 1c4db9cf cf373513 56e8ac99 68d9c657 6b907e1a 81c038d1 2fc3192a; do
  jq -c --arg q "$q" 'select(.extra.queryId|startswith($q))
    | {queryId:.extra.queryId, caller:.extra.callerRole, scope:.extra.scope,
       query:.extra.queryText, raw:.extra.hitCountRaw, ret:(.extra.results|length)}' \
    logs/context-search-20260524T003426.jsonl
done

# Every store event per #12 correlationId (bootstrap / query / write), chronological
for c in 1c914324 f05a064b b03aa795 b73c9f7b de7a525f 8a551bf6 e0728f86 df3d7b8e; do
  echo "--- $c ---"
  grep "$c" logs/mcp-server-20260524T003426.jsonl \
    | grep -E 'Assembled bootstrap|context_query|Embedded document'
done
# Project write has no corrId in its key:
grep -n 'project:_:12-project-notes' logs/mcp-server-20260524T003426.jsonl

# Bootstrap head per invocation (gap G2 workaround) — shows all 8 byte-identical, 13-project-notes #1
for L in 'teamlead-20260525T001458.jsonl 1c914324-67d0-4826-87c6-ec51215ce5bd' \
         'developer-20260525T002445.jsonl e0728f86-fc39-476c-92ae-6ddf1657f981' \
         'teamlead-20260525T001458.jsonl df3d7b8e-8a21-4fbc-97c0-92370bc3836c'; do
  set -- $L
  python3 -c "import json
for l in open('logs/$1'):
    if 'Initial prompt for correlationId=$2' in l:
        m=json.loads(l)['message']; i=m.find('## Prior Decisions')
        print('=== $2 ==='); print(m[i:i+1500]); break"
done

# RAW write values (latest version per key; container left running — stop with: docker stop quorum-opensearch-1)
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=40' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["12-ticket-setup","12-revision-summary","ticket-12-research",
       "ticket-12-pass-a-implementation","pass-b-research","12-pass-b-result","12-project-notes",
       "12-research-findings","12-delimiter-extraction-impl","12-rereview-verdict"]}},
      "_source":{"excludes":["embedding"]},"sort":[{"createdAt":{"order":"asc"}}]}'

# 12-project-notes size proof (617 tok > 600 budget → B1 exclusion)
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["12-project-notes","13-project-notes"]}},"_source":["key","value"]}' \
  | jq -r '.hits.hits[] | "\(._source.key): \(._source.value|length) chars (~\((._source.value|length)/4|floor) tok)"'

# G4/B5 double-embed (synchronous embed → backfill sweep → re-embed, 547 ms apart)
sed -n '30090,30099p' logs/mcp-server-20260524T003426.jsonl \
  | grep -E 'Embedded document|Backfilling'
grep -n 'backfill\|Backfill' apps/mcp-server/src/embedding/embedding-pipeline.service.ts

# Code verification of the shipped #12 surface
grep -nE 'commitAndPush|shellQuote|commitMessage' apps/agent/src/connection/invocation-handler.service.ts
grep -nE 'extractCommitMessage|commit-message' apps/agent/src/llm/claude-code.service.ts
grep -nE 'commitMessage' libs/common/src/messaging/invoke.types.ts
grep -nE 'git (commit|push|checkout|branch)' apps/agent/src/config/role-tool-profiles.ts
git log --oneline --all | grep -E 'c469fa5|71afefe|f7ea851|725576c'
```