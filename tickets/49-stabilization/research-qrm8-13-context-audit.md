# #13 Branch-in-Flight Guard — Context-Access Audit

**Date compiled:** 2026-06-13
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#13")
**Ticket:** `tickets/13-branch-in-flight-guard.md` · **PR:** #40
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #13, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

> **Why this ticket matters.** #13 is the session's **negative-space control** — the one and only QRM8-session ticket that ran with **zero searches**. No agent issued a single `context_query mode=search` on #13's behalf; the entire flow (setup → implement → review → polish) ran on the ticket file + PR + moderator prompt + bootstrap. It is also the only audited ticket whose developers wrote **zero agent-scope checkpoints**, so even F2's "write-only agent memory" pattern is absent on the write side — only the empty *read* reflex fired. That makes #13 the floor against which #11's richness and #12's waste are measured: it answers the question "what did the store contribute when **nothing queried it**?" The short answer is *one bootstrap delivery that became relevant only at the trivial final invocation* — but the data also surfaces the audit set's cleanest live evidence that the bootstrap head is **not** static (it moved within the 24-minute window) and a direct **correction of #31-B2/#56**: a concise `{ticket}-project-notes` record *does* fit the 600-token budget and *was* bootstrapped (B1).

## Scope correction vs the index

The index lists **5** rows for #13 and the full log sweep (`grep 'Invocation received' logs/{teamlead,developer}-2026052*.jsonl | grep -i '#13\|PR #40\|branch-in-flight'`) confirms the set is complete and clean: **5 agent invocations** (teamlead ×3 incl. one ENOSPC failure, developer ×2), **no probes, no productive duplicates, no concurrent fan-out**. This is a strictly sequential pipeline — unlike #11/#12/#14, #13 has no transport-retry double-dispatch that *ran productively*; its one duplicate (I1) died at 216 ms before doing anything but a bootstrap. Three facts worth foregrounding:

1. **Zero searches, confirmed at both layers.** No `context_query mode=search` appears for any of the 5 correlationIds in `mcp-server-20260524T003426.jsonl`, and no #13 record exists in `context-search-20260524T003426.jsonl` (which holds all 22 session traces, none touching #13). The index's quality note ("zero searches on this ticket") is exact.
2. **Zero agent-scope writes.** Both developer invocations (I3, I5) ran the prescribed agent-scope `get-all` start-of-task read (E5, E10) and both got **0** — but neither wrote anything back to agent scope. #13's four writes are 3 conversation + 1 project, no `agent:*:*` at all. This is unique among the multi-invocation tickets (#11/#12/#14 all produced agent checkpoints).
3. **The ENOSPC setup is a genuine failure, not a retry artifact.** I1 (`b9d4a52d`) is the disk-exhaustion failure that triggered the 05-25 container restart (the index's "post-restart" log split begins right after it); it produced a bootstrap and then `Claude Code process exited with code 1` at **216 ms**. The real setup (I2, `5d4c681b`) ran 3 minutes later on the restarted container.

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-25 00:12:41 → 00:12:41 (**FAILED, ENOSPC, 216 ms**) | `b9d4a52d-bbdd-4acc-8f4c-76b744cc7a6f` | teamlead / setup (died before any work) | `teamlead-20260524T003432.jsonl` (pre-restart) | bootstrap **E1** only |
| I2 | 00:15:42 → 00:18:?? | `5d4c681b-1a42-400a-944b-b2b6c420900b` | teamlead / setup (PR #40 drafted) | `teamlead-20260525T001458.jsonl` | bootstrap **E2** · write **E3** (`conversation:…:13-ticket-setup`) |
| I3 | 00:25:25 → 00:28:?? | `b64fb2f5-71d1-4a0e-811d-544f403efc96` | developer / implement | `developer-20260525T002445.jsonl` | bootstrap **E4** · agent get-all **E5** (→0) · write **E6** (`conversation:…:13-implementation-result`) |
| I4 | 00:29:22 → 00:31:?? | `b82e7c95-7158-4b2b-b891-51852ccc0bf1` | teamlead / review (manual accept) | `teamlead-20260525T001458.jsonl` | bootstrap **E7** · write **E8** (`project:_:13-project-notes`) |
| I5 | 00:36:12 → 00:37:?? | `642f7b7e-7f43-4a1b-a50f-c54b03d70b0c` | developer / polish (JSDoc on Map keys) | `developer-20260525T002445.jsonl` | bootstrap **E9** (**changed head**) · agent get-all **E10** (→0) · write **E11** (`conversation:…:13-map-key-comments`) |

**Versions.** All four writes are single-version (`updatedAt: null`; OpenSearch returns one record per key, no overwrite markers). Unlike #31 (v1→v2, B3), nothing was overwritten — every RAW render below is verbatim-complete from OpenSearch. The total #13 store footprint: **5 bootstraps + 2 zero-return agent reads + 4 writes = 11 access points**, the lightest multi-invocation ticket in the audited set.

---

## Data recovery method

Same toolkit as the #31/#17/#16/#14/#11 audits. RAW write bodies recovered by querying the running `quorum-opensearch-1` container (data volume intact) with the embedding vector excluded:

```bash
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=30' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["13-ticket-setup","13-implementation-result",
       "13-project-notes","13-map-key-comments"]}},"_source":{"excludes":["embedding"]}}'
```

All four documents returned complete bodies plus `createdAt`/`createdBy`/`scope`/`id` — none with an `updatedAt`. Bootstrap item *keys and full text* (gap G2) recovered from each role log's `=== Initial prompt for correlationId=… ===` debug line, which embeds the rendered `## Prior Decisions` block verbatim — done for **all 5** invocations. The decisive find is that the block is **not** byte-identical across the five (contrast #11's static head): I1–I4 carry one head, I5 carries a different one (E9 below). Write timings anchored to the `EmbeddingPipelineService "Embedded document"` events in `mcp-server-20260524T003426.jsonl` (E3 = 00:18:00, E6 = 00:28:35, E8 = 00:31:37, E11 = 00:36:58) and the `createdAt` epochs (`13-project-notes` `createdAt 1779669097210` ↔ 00:31:37Z). Code claims in the writes were checked against the live tree (`apps/mcp-server/src/messaging/message-broker.service.ts`).

---

## Chronological access-point audit

### E1 — Bootstrap injection, setup ENOSPC (I1, 00:12:41) — and the static head across I1–I4

`BootstrapContextService` assembled **4 items, 588 tokens, scopes=[project, conversation]** (`mcp:8230`). Conversation leg empty (fresh `b9d4a52d`), so all 4 are project scope. **The identical 4-item head was injected into I1–I4** (E1/E2/E4/E7 — verified byte-identical via each invocation's initial-prompt block); it is the *same* head the #11 and #14 windows carried. Rendered:

```
## Prior Decisions

### Project Context
- 14-project-notes: "PR #36 code review accepted for ticket #14 (moderator becomes standalone git
  client). Two-comment review protocol completed: (1) Initial /code-review skill found a volume-seed
  bug … (6) Pattern note: when adding directories under a Docker volume mount point, be aware Docker
  seeds empty named volumes from image layers — build-time directories at mount points will appear in
  the volume and can break tools expecting an empty directory."                          [≈345 tok]
- draft-pr-based-workflow-bootstrap-design-notes: "PR-based workflow bootstrap ticket drafted …
  (1) gh CLI is NOT installed … (7) Step 1 (GH_TOKEN) must land first …"                 [≈222 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                       [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                              [≈10 tok]
```

**Quality feedback:**
- **Quality: off-topic for #13.** #13 is a `MessageBroker` concurrency-guard ticket; the head is the Docker-volume-seeding note (#14) plus the gh-CLI bootstrap note plus the two month-old QRM6 elicitation strings. Item #1 (`14-project-notes`) is the *previous* ticket's note and shares nothing with branch-locking; `draft-pr-…` is unrelated; the elicitation pair is the usual residue (injected in all 34 session bootstraps). **0/4 slots relevant to #13** — the polar opposite of #11, where the freshest-note slot happened to land on the exact note #11 needed.
- **Re-usability: delivery only, no consumer.** I1 died at 216 ms (ENOSPC) before reading anything; this bootstrap was pure overhead on a doomed invocation.
- **Added value beyond `docs/`+`tickets/`: zero.** Nothing here informs a branch-lock ticket. The 588 tokens are the standing session tax.

### E2 — Bootstrap injection, setup (I2, 00:15:42)

**4 items, 588 tokens** (`mcp:8294`) — byte-identical to E1. The setup teamlead's actual context for drafting `tickets/13-branch-in-flight-guard.md` came entirely from the **moderator's dispatch prompt**, which is exceptionally detailed: it spells out the `branchLocks` field signature, the insertion point ("after the existing safeguards … before delivery"), the `callChains` lifecycle to mirror, the error-message format, the scope guards, and even the two-step PR-retarget trick ("you got this right on #11, do it again"). The prompt also points the agent at the spec sources (`gh issue view 13`, `tickets/8-workspace-isolation.md` D6, the current `message-broker.service.ts`). **The store contributed nothing the prompt didn't already carry.**

**Quality feedback:**
- **Quality: same off-topic head as E1.** No #13-relevant record existed to inject (this is the setup — #13 had written nothing yet).
- **Re-usability: nil.** The teamlead ran zero queries (it had a fully-specified prompt) and drafted the ticket from the prompt + D6.
- **Added value: zero.** The ticket spec is a near-verbatim expansion of the dispatch prompt; the bootstrap head played no part.

### E3 — Write `conversation:5d4c681b…:13-ticket-setup` (I2, 00:18:00)

The setup completion record, 803 chars, `createdBy=teamlead`. RAW (complete):

```
Ticket #13 (Branch-in-Flight Guard in MessageBroker) Phase 1 setup complete. Ticket file at
tickets/13-branch-in-flight-guard.md. Branch 13-branch-in-flight-guard created off
8-workspace-isolation-staging. PR #40 opened and retargeted to staging branch. Build/lint/test all
pass (46 suites, 798 tests). Architect review NOT needed — design fully specified in D6, mirrors
existing callChains pattern, no new abstractions. Key implementation details: new branchLocks Map
field on MessageBroker, inserted after safeguard 3 (circular call) and callChains tracking, before
try block. Lock acquired before delivery, released in finally block. Error message includes branch
name, in-flight target role, and correlationId. 8 acceptance criteria covering lock acquire, release
on success/error, error message, concurrent same-branch rejection, concurrent different-branch
success, and empty map verification.
```

**Quality feedback:**
- **Quality: accurate, decision-flavored, and a faithful summary of the drafted ticket.** Every claim matches the ticket file (branch off staging, PR #40, 46 suites / 798 tests baseline, the safeguard-4 insertion point, the 8 ACs). The "Architect review NOT needed" rationale is the operative routing datum.
- **Re-usability: zero — dead-end partition `conversation:5d4c681b…` (F1).** No agent ever read it. The moderator *could* have pulled it via `get-all id=5d4c681b…` before dispatching the developer (as it did for #11's setup note, B3 there) — but for #13 it did not; the developer's dispatch (I3) carried the spec inline instead. So #13 never exercised the one conversation-scope channel that worked once in #11.
- **Added value beyond `docs/`+`tickets/`: thin.** The AC count and implementation summary duplicate the ticket file the developer reads anyway; nothing store-unique.

### E4 — Bootstrap injection, implement (I3, 00:25:25)

**4 items, 588 tokens** (`mcp:8434`) — byte-identical to E1/E2. Notably, `13-ticket-setup` (written by I2 at 00:18, in conversation scope) is **not** here — bootstrap pulls project + the *invocation's own* conversation partition, and I3's conversation partition (`b64fb2f5`) is fresh/empty. So the developer's bootstrap shows last-ticket's `14-project-notes`, not #13's own setup note.

**Quality feedback:** same off-topic head as E1; **re-usability** delivery-only (the developer implemented from the ticket file + the moderator's implement prompt + the worktree); **added value zero**.

### E5 — Read `agent get-all id=b64fb2f5…` → **0** (I3, 00:25:35)

`context_query{scope:agent, mode:get-all, correlationId:"b64fb2f5…"}` → **0 items** (`mcp:8435`). The prescribed D7 "on retry, query agent scope first" reflex (the role prompt's *Progress Checkpointing* section), fired at task start.

**Quality feedback:**
- **Quality of the query: structurally empty by construction (F1/F2).** It reads the developer's own fresh correlationId partition, which nothing has written to. For #13 this is **doubly** empty: not only is the partition fresh, but **no agent-scope record exists anywhere for #13** — no prior invocation wrote one and this invocation won't either. There is not even a hypothetical sibling record to miss (contrast #11-B4, where a 2-minute-old concurrent sibling checkpoint existed but was unreachable).
- **Re-usability: nil. Added value: negative** — one round-trip retrieving nothing, against a scope #13 never populates.

### E6 — Write `conversation:b64fb2f5…:13-implementation-result` (I3, 00:28:35)

The implementation completion record, 717 chars, `createdBy=developer`. RAW (complete):

```
Ticket #13 (branch-in-flight guard) implemented. Two commits pushed to 13-branch-in-flight-guard:
0e769d3 (code + tests) and 1410493 (ticket update). Added branchLocks map to MessageBroker as
safeguard 4 between callChains tracking and the try block. Lock acquired before delivery, released
in finally block. One deviation from ticket spec: the guard exempts same-correlationId invocations
(existingLock.correlationId !== correlationId) because nested calls within the same chain are
sequential and do not race on push — confirmed by two pre-existing tests that use same-branch nested
calls. Six new tests added in a dedicated describe block. Verification: build clean, lint clean,
804 tests passed (798 baseline + 6 new).
```

**Quality feedback:**
- **Quality: accurate and carries the one genuinely store-worthy datum of the ticket — the same-correlationId exemption rationale.** Verified against the shipped code: `message-broker.service.ts:85-87` reads `const existingLock = this.branchLocks.get(request.branch)` and rejects only when the lock is held by a *different* correlationId; the deviation note's reasoning ("nested calls within the same chain are sequential and do not race") matches the ticket's "Deviation from ticket" section verbatim. The commit SHAs (`0e769d3`, `1410493`) and the 804-test count are correct.
- **Re-usability: zero — dead-end partition `conversation:b64fb2f5…` (F1).** The review invocation (I4) is a different correlationId and ran no conversation search, so this record was never read. The review re-derived the deviation from the PR diff and the updated ticket file's "Deviation from ticket" section.
- **Added value beyond `docs/`+`tickets/`: thin-to-moderate at write time.** The exemption rationale is real engineering judgment, but the developer *also wrote it into the ticket file* (the "Deviation from ticket" paragraph) in the same invocation — so the store copy is a duplicate of a ticket section, not a store-unique fact. Store-unique residue: the two commit SHAs.

### E7 — Bootstrap injection, review (I4, 00:29:22)

**4 items, 588 tokens** (`mcp:8493`) — **still byte-identical to E1**: `14-project-notes` as item #1. The review of #13 was injected with last-ticket's volume-seed note, not #13's own setup or implementation records (those are in conversation partitions; project scope still showed the stale `14`/`draft-pr` head because **`13-project-notes` did not exist yet** — I4 writes it 2¼ minutes *after* its own bootstrap, at E8). Same pattern as #11's review bootstrap (E31 there).

**Quality feedback:** off-topic head (0/4 #13-relevant); **delivery-only**; the review ran from the PR diff + ticket + moderator prompt. **Added value zero.**

### E8 — Write `project:_:13-project-notes` (I4, 00:31:37)

The review verdict synthesis, 1,605 chars (**≈400 tok**), `createdBy=teamlead`, single-version. RAW (complete):

```
PR #40 code review accepted for ticket #13 (branch-in-flight guard in MessageBroker). Single manual
review — no /code-review skill dispatch needed for this well-scoped single-file change.

Key patterns established: (1) branchLocks map added to MessageBroker as a concurrent-access guard,
mirroring the callChains lifecycle pattern (acquire before try, release in finally). This is the
fourth safeguard in the invoke() pipeline, after depth limit, agent availability, and circular call
prevention. (2) Same-correlationId exemption: the guard only blocks cross-correlationId invocations
targeting the same branch. Within a single correlationId, calls are sequential (handler chain), so no
push race exists. This exemption is load-bearing — the circular call test and elicitation bypass test
both use same-branch nested calls within the same correlationId.

Integration points: branchLocks is a private Map on MessageBroker. No new exports, no new modules, no
cross-module contracts changed. The guard is transparent to callers — it returns the standard
{ success: false, error } rejection pattern.

Test coverage: 804 tests across 46 suites (798 baseline + 6 new). New tests in
describe('branch-in-flight guard') block: same-branch rejection, different-branch coexistence, lock
release on success, lock release on error, empty-map invariant, callChains cleanup on rejection.

Dependency graph: #13 depended on #11 (branch field in InvokeRequest). #13 is now complete — no
downstream tickets were blocked on it specifically, but it completes the broker-level safety net for
the worktree-per-invocation model.
```

**Quality feedback — checked against the shipped code:**
- **Accuracy: verified high, no defects.** Every claim matches the tree: `branchLocks` is a private `Map` declared at `message-broker.service.ts:20`; the guard is **Safeguard 4** at `:82`, after depth (`:40`), availability (`:47`), and circular-call (`:64`); the error string at `:87` is `Branch '${request.branch}' is already in-flight (target=${existingLock.target}, correlationId=${existingLock.correlationId})`; the lock acquires at `:98` (before the `try`), releases at `:170` (in `finally`); the rejection path cleans up `callChains` at `:89-92`. No factual error (contrast #16-E7), no premature-then-reverted synthesis (contrast #31-E2/B3). This is the cleanest project-note in the audited set.
- **Re-usability: bootstrap self-loop only.** `13-project-notes` was never searched or key-read by any agent (no searches happened on #13). Its *one* downstream appearance is as **bootstrap item #1 in I5** (E9), the same ticket's own polish invocation 4½ minutes later — see B1. It was therefore "consumed" exactly once, in-context, by a 2-line JSDoc edit that needed no prior knowledge. The dependency-graph line ("no downstream tickets were blocked on it specifically") is itself the reason #13 produced no cross-ticket transfer like #14→#11: nothing semantically adjacent followed it in-session.
- **Added value beyond `docs/`+`tickets/`: thin.** Patterns (1)–(2) condense the ticket's Implementation Details + "Deviation" section; integration-points and test-coverage restate the ticket's Implementation Notes. The only store-unique datum is the framing "completes the broker-level safety net for the worktree-per-invocation model" — a one-line milestone summary, not deep knowledge.

### E9 — Bootstrap injection, polish (I5, 00:36:12) — **the head moved**

**4 items, 549 tokens** (`mcp:8576`) — and for the **first and only time in #13's window, a different head**:

```
## Prior Decisions

### Project Context
- 13-project-notes: "PR #40 code review accepted for ticket #13 (branch-in-flight guard in
  MessageBroker). … (1) branchLocks map added to MessageBroker … mirroring the callChains lifecycle
  … (2) Same-correlationId exemption … This exemption is load-bearing … Dependency graph: #13
  depended on #11 … #13 is now complete …"                                              [≈400 tok]
- two-tier-billing-docs: "Documented the two-tier billing split in docs/system-design.md (line 377,
  after the x-shared-env table). Agents authenticate via ANTHROPIC_API_KEY … the moderator via
  CLAUDE_CODE_OAUTH_TOKEN … Commit 9a65379 on QRM7-000-roadmap-staging."                [≈120 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                      [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                             [≈10 tok]
```

Between I4's bootstrap (00:29:22, head = `14-project-notes`/`draft-pr-…`) and I5's (00:36:12), exactly one project write occurred: `13-project-notes` at 00:31:37 (E8). I5's head now leads with `13-project-notes` and has **dropped both `14-project-notes` and `draft-pr-…`**, with `two-tier-billing-docs` taking the second slot. **Three of four slots turned over on a single intervening write.** This is the audit set's clearest live demonstration that the bootstrap head is not static and that a fresh `{ticket}-project-notes` *can* be bootstrapped — analyzed as B1.

**Quality feedback:**
- **Quality: on-topic for once — but circularly.** Item #1 is #13's *own* review verdict, fed back into #13's own follow-up invocation. It is accurate (it's E8) and maximally relevant to the polish task by definition. The remaining 3 slots are residue (`two-tier-billing-docs` is unrelated; the elicitation pair is noise).
- **Re-usability: available, not load-bearing.** The polish task (I5) was "add JSDoc comments labelling the Map key types" — a 2-line cosmetic edit fully specified by the moderator prompt. `13-project-notes` was in-context but the edit needed nothing from it. So this is a *self-loop delivery* (the store returning to #13 what #13 just wrote), not a knowledge transfer that changed an outcome.
- **Added value beyond `docs/`+`tickets/`: zero in effect.** Even though the head was finally relevant, it carried no information the polish invocation acted on; the content also lived in the ticket the developer could read.

### E10 — Read `agent get-all id=642f7b7e…` → **0** (I5, 00:36:19)

`context_query{scope:agent, mode:get-all, correlationId:"642f7b7e…"}` → **0 items** (`mcp:8577`). Identical to E5: the polish developer's start-of-task reflex against its own fresh, never-written agent partition.

**Quality feedback:** structurally empty (F1/F2); **re-usability nil**; **added value negative** — a second wasted round-trip on a scope #13 never populates.

### E11 — Write `conversation:642f7b7e…:13-map-key-comments` (I5, 00:36:58)

The polish completion record, 257 chars, `createdBy=developer`, single-version. RAW (complete):

```
Added inline JSDoc comments on callChains and branchLocks Map declarations in
message-broker.service.ts to label the key types: callChains keyed by correlationId, branchLocks
keyed by branch name. Two-line diff, no logic changes. 804 tests pass. Commit 6bc29c6 pushed to
13-branch-in-flight-guard.
```

**Quality feedback:**
- **Quality: accurate but trivial.** Matches the tree — `message-broker.service.ts:18/20` carry the `callChains`/`branchLocks` Map declarations with the documented key semantics; commit `6bc29c6` is the 2-line JSDoc diff. It is the smallest write of the ticket and arguably below the threshold worth storing.
- **Re-usability: zero — dead-end partition `conversation:642f7b7e…` (F1).** Never read; #13 had no further invocations.
- **Added value beyond `docs/`+`tickets/`: zero.** A code-comment changelog whose entire content is visible in `git show 6bc29c6`; the store copy adds nothing.

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — The bootstrap head *moved* mid-ticket, and a concise `13-project-notes` (≈400 tok) both surfaced and *displaced* the prior head — concrete refutation of #31-B2/#56's "project-notes can never be bootstrapped."** Across I1–I4 (00:12→00:29) the project head was the static `{14-project-notes (345 tok), draft-pr-…-design-notes (222), qrm6-rerun-elicit-A (12), elicitation-test-A (10)}` = 588 tokens — the *same* head the #11 and #14 windows carried, and the head the index's session-wide summary treats as near-static. But I5's bootstrap (00:36:12) carried a **different** head: `{13-project-notes (≈400), two-tier-billing-docs (120), qrm6-rerun-elicit-A (12), elicitation-test-A (10)}` = 549 tokens. The only intervening event was the `13-project-notes` write at 00:31:37 (E8). Two compounding mechanisms, both verifiable against `bootstrap-context.service.ts`:
  - *(ordering, #55)* `OpenSearchStore.getAll` issues a filter-only query with **no `sort` clause**, so document order is internal Lucene `_doc` order; `applyBudget` then `.reverse()`s `Object.entries` to "prefer newer." A newly-indexed `13-project-notes` lands in a fresh segment that sorts last in `_doc` → first after reverse → gets packed first. This is the unsorted-`getAll` defect #55, here producing a *desirable* reshuffle (the fresh note leads) rather than the stale ones #17-B1/#16-B1 documented — the same arbitrariness, different roll of the dice.
  - *(budget displacement)* once `13-project-notes` (≈400 tok) consumes the head of the 600-token project budget, only ~200 tokens remain — enough for `two-tier-billing-docs` (120) + the two 10–12-tok elicitation strings, but **not** for `14-project-notes` (345) or `draft-pr-…` (222), which `applyBudget` skips on overflow. So the fresh note doesn't just reorder the head — it **evicts** the previous two large notes via budget pressure. Three of four slots turn over on one write.

  The decisive correction this makes to the prior audits: **#31-B2 (issue #56) overgeneralized.** B2 claimed "A standard `{ticket}-project-notes` record at the teamlead's customary level of detail can never be bootstrapped" because #31's note weighed 674 tokens (> the 600 budget). #13 is the counter-example: `13-project-notes` at ≈400 tokens fits comfortably and **was** bootstrapped into I5 — exactly as `14-project-notes` (345 tok) was bootstrapped throughout #11/#13/#14. The exclusion is real but applies only to **oversized** notes (#31's 674, #11's ≈770), not the family. The actionable refinement for #56: the fix isn't only "raise the budget" — it's that note *size discipline* (keep `{ticket}-project-notes` under ~400 tok) already makes a note bootstrap-eligible under today's 600-token budget; the teamlead's terser notes (#13, #14) self-qualify while its verbose ones (#11, #31) self-exclude. No new issue — this sharpens the already-filed [#55](https://github.com/ia64mail/quorum/issues/55) (the reshuffle is its symptom) and **corrects the scope of [#56](https://github.com/ia64mail/quorum/issues/56)** (the spec ticket on this very branch, `56-bootstrap-budget-sizing`): cite #13 as the specimen proving concise notes already fit and the head is write-sensitive.

**B2 — #13 is the session's pure negative-space control: zero searches, zero agent-scope writes, and the only #13-relevant store delivery was a self-loop into the trivial final invocation.** #13 is the single QRM8-session ticket with **no `context_query mode=search` at all** (confirmed at both the MCP-server and trace-stream layers — §"Scope correction"), and the only multi-invocation ticket whose developers wrote **no agent-scope checkpoint**. The consequence is that #13 exhibits F2 (agent-memory waste) in its *purest, emptiest* form: both developer invocations fired the prescribed D7 agent-scope `get-all` reflex (E5, E10) and both returned 0 — but unlike #11/#12/#14, there was never anything to find, because the role *never wrote* to agent scope this ticket. The reflex is overhead against a scope #13 leaves permanently empty. Tallying the store's net cross-invocation contribution to #13: of 11 access points, 5 are bootstraps (4 carrying an off-topic head, 1 carrying #13's own note back to itself), 2 are zero-return agent reads, and 4 are write-only conversation/project records that no agent read. **Nothing the store carried changed an outcome** — every invocation's working knowledge came from the ticket file, the PR diff, and the moderator's (unusually complete) dispatch prompts. This is the floor the index predicts: the store was pure overhead on #13, useful in this research only as the baseline against which #11's genuine `14→11` transfer and #12's 7-empty-search waste are measured. No issue to file — this is the expected behavior of a small, fully-specified, single-file ticket; the finding *is* that the store added no value when nothing queried it and the work was small enough to need no cross-invocation memory.

**B3 — #13's writes are the most accurate in the audited set, which makes the write-only outcome the sharper indictment.** All four #13 records are verbatim-faithful to the shipped code (E6's exemption rationale, E8's safeguard-4 / error-string / lock-lifecycle claims, E11's JSDoc note — every one cross-checked against `message-broker.service.ts:18-20/40-98/170`), with no factual error (contrast #16-E7's "5 sections" claim, real count 10) and no premature synthesis (contrast #31-E2's accept-then-revert). Yet **accuracy bought no reuse**: 3 of the 4 sit in dead-end conversation partitions never read by any agent (F1), and the 4th (`13-project-notes`) was "consumed" only by the bootstrap self-loop of B1, by an invocation that needed nothing. The store's quality problem on #13 is not *wrong* knowledge — it is *correct knowledge written to addresses no consumer queries*. This is the index's F3 thesis in the negative: where #11 showed that a moderator-supplied **address** (the `11-design-notes` key) makes even a large record consumed 7×, #13 shows that without an address — no key handoff, no search, no semantically-adjacent follow-up ticket — even four accurate records flow nowhere. The bottleneck is addressing, and #13 is the control that holds addressing constant at *zero*. No issue; concrete reinforcement of F1/F3.

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap (I1, ENOSPC) | off-topic head (0/4 #13-relevant) | no (invocation died at 216 ms) | **Zero** — overhead on a doomed invocation |
| E2 | bootstrap (I2 setup) | off-topic head | n/a (delivery; 0 queries) | **Zero** — spec came from the dispatch prompt |
| E3 | write `13-ticket-setup` (conv) | accurate setup summary | **no** — dead-end partition (F1) | **Thin** — duplicates the ticket file |
| E4 | bootstrap (I3 implement) | off-topic head | n/a (delivery) | **Zero** |
| E5 | agent get-all → 0 | structurally empty (F1/F2) | **no** — nothing ever written to scope | **Negative** — wasted round-trip |
| E6 | write `13-implementation-result` (conv) | accurate; exemption rationale | **no** — dead-end partition (F1) | **Thin** — also written into ticket; SHAs only store-unique |
| E7 | bootstrap (I4 review) | off-topic head; `13-project-notes` not yet written | n/a (delivery) | **Zero** |
| E8 | write `13-project-notes` (project) | **highest accuracy in the set** (code-verified) | **once** — bootstrap self-loop into I5 (B1) | **Thin** — condenses the ticket; one milestone-summary line unique |
| E9 | bootstrap (I5 polish) — **head moved** | on-topic at last (`13-project-notes` #1) but circular | item #1 available, not acted on | **Zero in effect** — self-loop, polish needed nothing |
| E10 | agent get-all → 0 | structurally empty (F1/F2) | **no** | **Negative** — second wasted round-trip |
| E11 | write `13-map-key-comments` (conv) | accurate but trivial (2-line diff) | **no** — dead-end partition (F1) | **Zero** — visible in `git show 6bc29c6` |

**Bottom line for the parent research:** #13 is the **negative-space control** and it behaves exactly as a floor should. With zero searches, zero agent-scope writes, no key handoff, and no semantically-adjacent follow-up ticket, the Context Store carried **no knowledge that changed any of the five invocations** — every agent worked from the ticket file, the PR, and the moderator's (unusually complete) prompts. The four writes are the most *accurate* in the audited set, yet that only sharpens the point: correct records written to unaddressed partitions flow nowhere (B3). The one structurally interesting event is **B1** — the bootstrap head visibly *moved* when `13-project-notes` (≈400 tok) was written, surfacing the fresh note and evicting the prior two via budget pressure, which **corrects #31-B2/#56's claim that project-notes can never be bootstrapped** (concise ones can, and do). Set against #11 (the store earned its tokens via the `14→11` transfer + 7× key-handoff) and #12 (the store actively wasted effort via 7 empty searches), #13 is the *neutral* midpoint: the store neither helped nor actively hurt — it was simply **overhead**, ~3.5 k bootstrap tokens + 2 empty agent reads + 4 unread writes, for a ticket small enough to need none of it.

## Appendix — reproduction

```bash
# All five #13 invocations (note the pre-restart / post-restart log split at the ENOSPC failure)
grep -n 'Invocation received' logs/teamlead-20260524T003432.jsonl logs/teamlead-20260525T001458.jsonl \
  logs/developer-20260525T002445.jsonl | grep -iE '#13|PR #40|branch-in-flight'

# Confirm ZERO searches for #13 (both layers)
for c in b9d4a52d 5d4c681b b64fb2f5 b82e7c95 642f7b7e; do
  grep "$c" logs/mcp-server-20260524T003426.jsonl | grep -i 'mode=search'; done   # → empty
grep -i 'ticket 13\|branch.in.flight\|branchlock' logs/context-search-20260524T003426.jsonl  # → empty

# All #13 store events (writes + the two zero-return agent reads), in the window
sed -n '8230,8600p' logs/mcp-server-20260524T003426.jsonl \
  | grep -E 'Embedded document|context_query|Assembled bootstrap'

# Bootstrap head per invocation (gap G2 workaround) — shows I1–I4 identical, I5 changed
for L in 'teamlead-20260524T003432.jsonl b9d4a52d-bbdd-4acc-8f4c-76b744cc7a6f' \
         'teamlead-20260525T001458.jsonl 5d4c681b-1a42-400a-944b-b2b6c420900b' \
         'developer-20260525T002445.jsonl b64fb2f5-71d1-4a0e-811d-544f403efc96' \
         'teamlead-20260525T001458.jsonl b82e7c95-7158-4b2b-b891-51852ccc0bf1' \
         'developer-20260525T002445.jsonl 642f7b7e-7f43-4a1b-a50f-c54b03d70b0c'; do
  set -- $L
  python3 -c "import json,sys
for l in open('logs/$1'):
    if 'Initial prompt for correlationId=$2' in l:
        m=json.loads(l)['message']; i=m.find('## Prior Decisions')
        print('=== $2 ==='); print(m[i:i+1400]); break"
done

# RAW write values (latest version per key; container left running — stop with: docker stop quorum-opensearch-1)
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=30' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["13-ticket-setup","13-implementation-result",
       "13-project-notes","13-map-key-comments"]}},"_source":{"excludes":["embedding"]}}'

# Code verification of the branch-in-flight guard (E8 accuracy)
grep -n 'branchLocks\|Safeguard\|in-flight' apps/mcp-server/src/messaging/message-broker.service.ts
```