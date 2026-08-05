# #17 MCP Server Bind Mount Removal — Context-Access Audit

**Date compiled:** 2026-06-12
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#17")
**Ticket:** `tickets/17-mcp-server-bind-mount.md` · **PR:** #34
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #17, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

## Scope correction vs the index

The index lists **three** invocations for #17 and the full log sweep confirms exactly three — no probes, no duplicates, no ENOSPC failures. **#17 is the first ticket in the session where the index's per-ticket row count is complete** (contrast #31, where the index listed 1 and the sweep found 5). The invocation set below matches the index §3 row verbatim; the only thing the index undercounts is the *bootstrap content*, which it summarizes as a "near-static 4-item set" — for #17 the project-scope head actually **changed mid-ticket** (E1 vs E3/E7, finding B1).

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-24 01:46:41 → 01:48:38 | `1528efbf-224d-4b35-ab5b-61519f6b58dc` | teamlead / Phase-1 ticket setup (draft `17-…md` + open PR #34) | `teamlead-20260524T003432.jsonl` | bootstrap **E1** · write **E2** · **zero searches** |
| I2 | 05-24 01:51:42 → 01:52:53 | `d2d35c43-721f-4333-8452-d1c4e6b7c472` | developer / implement | `developer-20260524T003432.jsonl` | bootstrap **E3** · search **E4** (agent, trace L2) · search **E5** (conversation, trace L3) · write **E6** |
| I3 | 05-24 01:53:23 → 01:58:16 | `2c54cce7-1240-4632-b51f-ea7d5a217f98` | teamlead / `/code-review:code-review` | `teamlead-20260524T003432.jsonl` | bootstrap **E7** · write **E8** · **zero searches** |

No architect invocation exists for #17 (the ticket itself records "Architect review: Not needed — trivial two-line docker-compose change"). The moderator issued **no `context_query`** for #17 and passed **no context key** in any of its three dispatches — each `invoke_agent` carried only `target / callerRole / sessionId / action`, and the developer dispatch pointed at the ticket file (`tickets/17-mcp-server-bind-mount.md`, "already on the branch") as the spec channel, not the store (verified in `b0b5645f…jsonl`). The moderator's only two store reads of the entire session were both for #11.

**Key version facts (no overwrites this ticket):** all three writes are single-version. `17-ticket-created`, `ticket-17-implementation-result`, and `17-project-notes` each exist exactly once in OpenSearch with no `updatedAt` — unlike #31's `31-project-notes` v1→v2 overwrite, nothing about #17 was superseded in-session, so every write below is verbatim-complete.

---

## Data recovery method

Same toolkit as the #31 audit. RAW write bodies were recovered by querying the running `quorum-opensearch-1` container (data volume intact, container `Up … (healthy)`) against the `quorum-context` index, `_source` excluding the embedding vector:

```bash
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["17-ticket-created","ticket-17-implementation-result","17-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'
```

All three documents returned complete bodies plus `createdAt`/`createdBy`/`embeddingText` (no truncation, no missing versions — OpenSearch's "latest version only" limitation does not bite here because nothing was overwritten).

Bootstrap item *keys and full text* (index gap G2) were recovered from the agent-side `=== Initial prompt ===` debug line in each role log, which embeds the rendered `## Prior Decisions` block verbatim. The two scoped search traces (E4/E5) were pulled from the trace stream by `queryId`; both carry the full request (`queryText`, `scope`, `id`) and an empty `results` array — empty partitions, so there is nothing below a token-budget cut to recover.

---

## Chronological access-point audit

### E1 — Bootstrap injection, ticket setup (I1, 05-24 01:46:41)

`BootstrapContextService` assembled **4 items, 573 tokens, scopes=[project, conversation]** (`mcp-server-20260524T003426.jsonl:1051`). Conversation partition empty (fresh correlationId), so all 4 are project scope. Rendered into the user prompt as:

```
## Prior Decisions

### Project Context
- 29-project-notes: "PR #30 code review accepted for ticket #29 (agent plugin install at
  entrypoint). … (3) Pre-existing bug discovered: tool-guard-hook.ts allowedSkills uses bare
  names … (4) Dockerfile COPY at line 91 bakes plugin to /mnt/quorum/workspace/.claude/plugins/
  code-review, but the workspace bind mount masks this at runtime … (8) Unblocks end-to-end
  /code-review dispatch once the allowedSkills mismatch is fixed in a follow-up."  [≈428 tok]
- two-tier-billing-docs: "Documented the two-tier billing split in docs/system-design.md
  (line 377) … the subscription token must never appear on x-shared-env …"            [≈120 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                    [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                           [≈10 tok]
```

(This is byte-identical to the bootstrap set #31 received an hour earlier — the same four records, same order.)

**Quality feedback:**
- **Quality: none of it is about #17.** #17 is a two-line `docker-compose.yml` bind-mount removal. `29-project-notes` is about plugin install at the agent entrypoint; its one tangential token — "bake plugin to `/mnt/quorum/workspace/…`, but the workspace bind mount masks this" — name-drops *a* bind mount, but the agent's plugin mount, not the mcp-server mount #17 removes. The billing record and the two QRM6 elicitation strings are month-old residue with zero relevance (the elicitation pair rode along in all 34 session bootstraps — index E1/B2). Net: a 573-token injection that delivered no #17 signal.
- **Re-usability: delivery channel, not a read.** Whether any of it was *used* is unknowable from the trace, but the setup task (draft the ticket, open the PR) needs the ticket's own design — which came from the moderator prompt and the roadmap (`tickets/8-workspace-isolation.md`), not from these four records.
- **Added value beyond `docs/`+`tickets/`: zero.** Everything injected is either already in `docs/system-design.md` (billing) or specific to other tickets (#29) or pure noise (elicitation).

### E2 — Write `conversation:1528efbf…:17-ticket-created` (I1, 05-24 01:48:37.764)

The setup completion record, written by the teamlead after drafting the ticket and opening PR #34. RAW value (complete, from OpenSearch; `createdBy=teamlead`):

```
Ticket #17 (MCP Server Bind Mount Removal) created and PR opened. Ticket file:
tickets/17-mcp-server-bind-mount.md. Branch: 17-mcp-server-bind-mount off
8-workspace-isolation-staging. PR #34 (https://github.com/ia64mail/quorum/pull/34) targeting
8-workspace-isolation-staging. Resolves-link auto-linked to issue #17. Verification: build passes
(3 webpack compilations), lint passes (0 errors/warnings), test passes (788 tests, 46 suites).
Architect review not needed — trivial two-line docker-compose change following established D8
design decision. This is a Phase 1 independent ticket with no upstream or downstream dependencies
within QRM8.
```

**Quality feedback:**
- **Quality: accurate but a status echo.** Every fact (branch, PR number, build/lint/test counts, "architect review not needed") is correct and matches the ticket's own Implementation Notes. It is a state snapshot, not a decision record.
- **Re-usability: zero — written into a dead-end partition.** It lives under `conversation:1528efbf…`. The very next invocation (the developer, I2) searched conversation scope for exactly this ticket (E5) but keyed its own correlationId `d2d35c43…`, so this record was unreachable (finding B2, index F1). Nothing ever read it.
- **Added value beyond `docs/`+`tickets/`: thin-to-zero.** The PR URL is the only datum not in the ticket file, and that is discoverable via `gh pr view`. Had the moderator forwarded `1528efbf` as the developer's conversation `id`, this record *would* have given the developer the PR link and the "no dependencies / no architect review" framing in one read — but the addressing was never wired (B2).

### E3 — Bootstrap injection, implement (I2, 05-24 01:51:42)

**4 items, 591 tokens** (`mcp:1127`) — and the project-scope head is a **different set than E1**, rendered as:

```
## Prior Decisions

### Project Context
- 27-project-notes: "PR #28 code review accepted for ticket #27 (gh auth env ordering fix).
  Key outcomes: (1) Capture-unset-pipe pattern for GH_TOKEN handling in container entrypoints …
  (2) GIT_CONFIG_GLOBAL redirect pattern … (5) Scope: exactly 3 files changed (2 entrypoints +
  ticket MD). Unblocks #11, #12, #13, #14 …"
- draft-pr-based-workflow-bootstrap-design-notes: "PR-based workflow bootstrap ticket drafted …
  (1) gh CLI is NOT installed in either the moderator or agent Dockerfile stages … (2) GH_TOKEN
  must be added to moderator env block … (7) Step 1 (GH_TOKEN) must land first …"
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                    [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                           [≈10 tok]
```

Between E1 (01:46) and E3 (01:51) the project-scope head **swapped** `{29-project-notes, two-tier-billing-docs}` → `{27-project-notes, draft-pr-based-workflow-bootstrap-design-notes}`, with **no intervening project-scope write** (the only store mutation in that window was E2, a *conversation*-scope write). This is the concrete mechanism of finding B1.

**Quality feedback:**
- **Quality: still nothing about #17, and now actively misleading-adjacent.** `27-project-notes` (gh-auth env ordering) and `draft-pr-…-design-notes` (gh CLI installation) are both Docker/entrypoint records, so they *look* topically near a docker-compose ticket — but #17 touches neither gh auth nor the Dockerfile, only the mcp-server service's mount and env block. A reader leaning on bootstrap would be steered toward the agent/moderator entrypoint surface, the opposite of #17's scope.
- **Re-usability: delivery only; and note the conversation leg was empty.** The developer's bootstrap had no conversation items — `17-ticket-created` (E2, written 3 min earlier) sits under `1528efbf…`, not the developer's `d2d35c43…`, so even the bootstrap channel could not carry the setup record forward (F1 manifesting in bootstrap, not just search).
- **Added value beyond `docs/`+`tickets/`: zero.** The implement task ran entirely off the ticket spec (which the moderator prompt named) plus the worktree.

### E4 / E5 — Searches, traces L2 (agent) + L3 (conversation) (I2, 05-24 01:51:50)

The developer's two retrieval attempts, issued ~8 s apart, **identical query text, different scope** (`developer-20260524T003432.jsonl`). RAW trace records:

```
L2  queryId 1644303c · scope=agent        · id=d2d35c43… · query="ticket 17 mcp server bind mount"
    engine=hybrid · 59 ms · hitCountRaw=0 · returned=0 · truncatedByTokenBudget=false · results=[]
L3  queryId 5f549ae0 · scope=conversation · id=d2d35c43… · query="ticket 17 mcp server bind mount"
    engine=hybrid · 58 ms · hitCountRaw=0 · returned=0 · truncatedByTokenBudget=false · results=[]
```

**Quality feedback:**
- **Quality of the query: excellent — and that is what makes this the session's cleanest F1 specimen.** "ticket 17 mcp server bind mount" is a well-formed hybrid query: the ticket number anchors BM25, the noun phrase carries the semantics. There were two documents in the store that match it almost perfectly — `17-ticket-created` (E2) and the developer's *own* `ticket-17-implementation-result` (E6), whose `embeddingText` literally begins `"ticket-17-implementation-result\n\nTicket #17 (MCP Server Bind Mount Removal) implemented …"`. Both are textbook BM25+k-NN hits. **The 0/0 is 100% addressing, 0% relevance:** the agent-scope partition `agent:d2d35c43…` is empty (this invocation has written nothing yet), and the conversation-scope partition `conversation:d2d35c43…` is empty too — `17-ticket-created` lives under the *setup's* correlationId, and `ticket-17-implementation-result` is not written until 70 s later (E6, 01:52:53). `hitCountRaw=0` (not the project-scope k-cap of 100) confirms the partitions genuinely held nothing.
- **Re-usability: nil by construction.** Reads happen at task start, before this invocation's own writes and inside its own (fresh) partition — the structural F1 failure.
- **Added value: negative — ~117 ms and two tool round-trips spent retrieving nothing.** The fix lever is concrete and cheap: the moderator held `1528efbf` (it dispatched the setup) and could have passed it as the conversation `id`, which would have turned E5 into a hit on `17-ticket-created`. It passed only `target/callerRole/sessionId/action` (B2; index F3 "moderator-orchestration gap").

### E6 — Write `conversation:d2d35c43…:ticket-17-implementation-result` (I2, 05-24 01:52:53.247)

The implementation record, written by the developer at task end. RAW value (complete, from OpenSearch; `createdBy=developer`):

```
Ticket #17 (MCP Server Bind Mount Removal) implemented on branch 17-mcp-server-bind-mount. Two
changes to docker-compose.yml, no source code modified. (1) Removed MCP_WORKSPACE_DIR env var from
mcp-server service (was line 112). (2) Commented out the workspace bind mount with inline debug
note (was line 135). Verification: build, lint, and all 788 tests pass. Commit 8eb8bfb for the
docker-compose change, commit e532f1d for the ticket AC flip and Implementation Notes. Both pushed.
```

**Quality feedback:**
- **Quality: accurate and appropriately scoped.** Matches the shipped change exactly (verified: `docker-compose.yml:136` is the commented mount with the inline note; `MCP_WORKSPACE_DIR` is gone from the mcp-server env). Carries the two commit SHAs, which the ticket file does not.
- **Re-usability: zero, and self-defeating.** It is written into the developer's own partition 70 s *after* the developer's own searches (E4/E5) already failed — so the one invocation whose query it would have answered had already given up. The reviewer (I3, E7/E8) ran no search and is in a different partition anyway. Through end of coverage no trace/log touches this key.
- **Added value beyond `docs/`+`tickets/`: thin.** The commit SHAs (`8eb8bfb`, `e532f1d`) are the only store-unique data, and they are recoverable from `git log`. The change description duplicates the ticket's Implementation Notes.

### E7 — Bootstrap injection, review (I3, 05-24 01:53:23)

**4 items, 591 tokens** (`mcp:1164`) — **identical item set to E3** (`27-project-notes`, `draft-pr-…-design-notes`, the two elicitation strings). The project head has stabilized on set B and stays there for the rest of the #17 window.

**Quality feedback:** same content assessment as E3 — Docker/entrypoint-adjacent records, none about the mcp-server mount, plus 22 tokens of elicitation noise. The critical structural observation is the same as #31's E6: a `{ticket}-project-notes` record for the ticket under review would be the obviously-relevant thing to inject, and the channel never carries it. Here it is doubly impossible — at review time `17-project-notes` does not exist yet (it is written 5 min later at E8), and even retroactively it could only surface via the broken unsorted `getAll` (B1). 2/4 slots wasted on noise; not query-aware (by design — bootstrap is assembled before the task is known).

### E8 — Write `project:_:17-project-notes` (I3, 05-24 01:58:15.722)

The review verdict synthesis, the only project-scope record #17 produced. RAW value (complete, from OpenSearch; `createdBy=teamlead`):

```
PR #34 code review accepted for ticket #17 (MCP server bind mount removal). Key outcomes:

(1) Vestigial infrastructure removal pattern established — when a backend migration (InMemoryStore
→ OpenSearch) makes env vars and mounts dead code, the mount is commented out with an inline debug
note rather than deleted, and the env var is removed entirely. The source code fallback
(context-store.config.ts:14 ?? '.') absorbs the missing env var gracefully.

(2) docker-compose.yml mcp-server service no longer has a workspace bind mount or MCP_WORKSPACE_DIR
env var. The only remaining mcp-server volume is ./logs:/app/logs.

(3) MigrationService ENOENT handling confirmed safe — when quorum.context is absent,
migration.service.ts:78-80 logs and returns without error. The existingCount guard at line 65 means
migration is skipped entirely on any restart after initial OpenSearch population.

(4) Scope: exactly 1 file changed (docker-compose.yml), 1 insertion, 2 deletions. No source code
modifications. Test suite unchanged at 788 tests, 46 suites.

(5) This implements Design Decision D8 from QRM8 roadmap. The mcp-server mount was the first of
three workspace mounts to be addressed — moderator (#14) and agent (#11) mounts are separate
concerns.

(6) docs/context-store.md still documents MCP_WORKSPACE_DIR in its config table — this is
technically accurate (the code still reads it) but may warrant a doc update when the architect next
revises docs/ for QRM8.
```

**Quality feedback — checked against the shipped code:**
- **Accuracy: verified high.** Item (1)'s claimed fallback is present verbatim at `apps/mcp-server/src/config/context-store.config.ts:14` (`path.join(process.env.MCP_WORKSPACE_DIR ?? '.', 'quorum.context')`); item (2)'s mount is commented at `docker-compose.yml:136` with the exact inline note and `MCP_WORKSPACE_DIR` is gone from the mcp-server env block. Items (4)/(5) match the ticket. No defects in the record.
- **Quality as a record: the best-written note in #17's lineage, and the one with a genuine pattern in it.** Item (1) generalizes the change into a reusable "vestigial infrastructure removal" convention (comment-don't-delete + rely on the `?? '.'` fallback), which is exactly the episodic→semantic distillation the parent research wants (`research-knowledge-management-analysis.md` §"Three Knowledge Domains"). Item (6) is forward-looking maintenance debt — see B3.
- **Added value beyond `docs/`+`tickets/`: moderate, and concentrated in two items.** Items (2)–(5) condense the ticket file. The store-**unique** content is item (1)'s named pattern and item (6)'s doc-staleness TODO — neither appears in `tickets/17-…md` or the PR. Item (6) in particular is real, actionable knowledge that existed nowhere else (B3).
- **Re-usability: zero to date — but for once *not* because of budget.** No search/keys-read/get touches `17-project-notes` through end of coverage (2026-05-28). Unlike #31's 674-token note, this record is small (≈470 tokens) and **would fit** the 600-token project bootstrap budget — yet it still never surfaced, because the unsorted `getAll` (B1) never ranks it into the 4-item head. #17 is therefore the cleaner proof that **ordering (B1), not budget (B2), is the binding constraint** for at least some project-notes.

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — The bootstrap project-head is temporally unstable *within a single ticket*, with a same-window in-session demonstration.** The index's B1 (`getAll` unsorted under OpenSearch — issue [#55](https://github.com/ia64mail/quorum/issues/55)/PR #57) was inferred from the set looking "near-static." #17 supplies the disproving specimen: the project-scope head flipped `{29-project-notes, two-tier-billing-docs}` (E1, 01:46) → `{27-project-notes, draft-pr-…-design-notes}` (E3/E7, 01:51–01:53) across a **5-minute window with no intervening project-scope write** — the only store mutation between the two bootstraps was E2, a *conversation*-scope write. Code-grounding: `OpenSearchStore.getAll` issues a filter-only bool query with **no `sort` clause** (`apps/mcp-server/src/context-store/opensearch-store.ts:160-187`, `query: { bool: { filter: filters } }`), so iteration follows Lucene `_doc` order; any write + index refresh — even to a different scope in the same index — can reshuffle the segment layout the bootstrap depends on. *New angle vs index-B1:* the instability is observable across a single ticket and is triggered by a different-scope write, and it is the **sole** reason #17's own `17-project-notes` (small enough to fit the budget) can never be injected. No new issue — strengthens the existing #55; the fix (`sort: [{ createdAt: 'desc' }]`) resolves both the index's and this ticket's symptom.

**B2 — #17 is the session's cleanest demonstration that scoped-search failure is pure addressing, not relevance.** Two documents in the store matched the developer's query "ticket 17 mcp server bind mount" almost perfectly — `17-ticket-created` (E2) and the developer's own `ticket-17-implementation-result` (E6, whose `embeddingText` opens with the ticket title) — yet E4/E5 returned `hitCountRaw=0`. The cause is entirely partition addressing: agent/conversation scopes key on the invocation's own fresh correlationId (`d2d35c43…`), so the setup's record (under `1528efbf…`) is unreachable and the dev's own record is not yet written. This is index-F1, but #17 is the specimen where the *embedding quality is provably irrelevant* (the matching text is verbatim), isolating the defect to the scoping model. The concrete fix lever is index-F3's moderator-orchestration gap: the moderator held `1528efbf` and could have passed it as the conversation `id` for the developer's query, converting E5 into a hit — it passed only `target/callerRole/sessionId/action` (verified in the moderator session log). No new defect; sharpens F1/F3 with a verbatim-match counter-example.

**B3 — The store captured a genuine, store-unique doc-staleness TODO — which was later resolved through a *different* channel, leaving the store record write-only.** `17-project-notes` item (6) flagged: "docs/context-store.md still documents MCP_WORKSPACE_DIR … may warrant a doc update when the architect next revises docs/." This forward-looking maintenance note appears nowhere in the ticket file or PR — it is real store-unique knowledge of exactly the kind the KB vision wants captured. **It was acted upon:** `docs/context-store.md:356` today reads "`MCP_WORKSPACE_DIR` … Not set in `docker-compose.yml` since QRM8 #17 (the workspace bind mount was removed)" (and lines 266/355 are correspondingly updated). But the store record was **never read back** (no trace/log touches `17-project-notes` through end of coverage), and project-notes can't enter a bootstrap under B1 — so the doc fix was delivered by a human/architect doc revision reading the *ticket/PR*, not by the store. The audit's lesson: even when the store holds the highest-value, store-unique item a ticket produced, the *consumption channel* is the bottleneck — the right knowledge reached its consumer in parallel, by luck, never through the store. No issue to file (the doc is already correct as of 2026-06-12); this is a positive-knowledge / dead-channel specimen, the mirror image of #31's B4 ("store captured verdicts, not experiments").

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap read (setup) | accurate but 0% #17-relevant; 2/4 slots noise | n/a (delivery) | **Zero** — #29 plugin notes + billing + elicitation, none on the mount |
| E2 | write `17-ticket-created` (conv) | accurate status echo | **never** — dead-end partition (B2) | **Thin** — only the PR URL is store-unique |
| E3 | bootstrap read (implement) | set *changed* vs E1 (B1); Docker-adjacent but off-scope; conv leg empty | n/a (delivery) | **Zero** — gh-auth/gh-CLI notes, not the mcp-server mount |
| E4 | agent search (L2) | query well-formed; partition empty by construction | — (0/0) | **Negative** — retrieved nothing; matching docs unreachable (B2) |
| E5 | conversation search (L3) | identical query; partition empty (setup record under another id) | — (0/0) | **Negative** — verbatim-match target existed, addressing missed it (B2) |
| E6 | write `ticket-17-implementation-result` (conv) | accurate; carries 2 commit SHAs | **never** — written after its own failed search | **Thin** — SHAs recoverable from git |
| E7 | bootstrap read (review) | ≡ E3; missing the one #17 record (doesn't exist yet / B1) | n/a (delivery) | **Zero** — same off-scope set as E3 |
| E8 | write `17-project-notes` (project) | high accuracy (code-verified); names a reusable pattern + a real doc TODO | **never** (through 05-28) — though small enough to bootstrap, blocked by B1 | **Moderate** — item (1) pattern + item (6) doc-staleness TODO are store-unique (B3) |

**Bottom line for the parent research:** #17's pipeline ran on two channels — the ticket file (full spec; the moderator named it in the dispatch) and the moderator prompt (commit list, "no architect review", PR linkage). **The Context Store's net retrieval contribution was zero:** every bootstrap delivered off-scope records (and the set silently changed mid-ticket — B1), and both scoped searches returned 0/0 against partitions that structurally could not hold the answer even though two verbatim-matching documents existed elsewhere in the store (B2). The store's *writes* were better than its reads — `17-project-notes` (E8) is an accurate, pattern-bearing synthesis with one genuinely store-unique doc TODO (B3) — but none of the four written records was ever read back, and the one high-value item reached its consumer (a later doc fix) through a parallel ticket/PR channel, not the store. #17 is thus the session's purest "**write-only store**" specimen: trivially-scoped enough that the store's retrieval dysfunction cost the work nothing, but precisely because of that, the store earned none of its ~1.75k injected bootstrap tokens. The addressing-bottleneck thesis (index F3) holds in its starkest form here — the answer was in the store, perfectly phrased, and nothing was pointed at it.

---

## Appendix — reproduction

```bash
# 1. Confirm the #17 invocation set is complete (3 invocations, no probes/dups/ENOSPC)
grep -h 'Invocation received' logs/teamlead-20260524T003432.jsonl logs/developer-20260524T003432.jsonl \
  | python3 -c "import sys,json;[print(json.loads(l)['message'][:90]) for l in sys.stdin]" | grep -i '#17\|17 '

# 2. Bootstrap item keys+text for any #17 invocation (gap G2 workaround) — note E1 set ≠ E3/E7 set
for cid in 1528efbf d2d35c43 2c54cce7; do
  echo "== $cid =="
  python3 -c "import json
for l in open('logs/teamlead-20260524T003432.jsonl'):
 pass" 2>/dev/null
  python3 -c "import json
src='logs/teamlead-20260524T003432.jsonl' if '$cid'!='d2d35c43' else 'logs/developer-20260524T003432.jsonl'
for l in open(src):
 if 'Initial prompt for correlationId=$cid' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print(m[i:i+1400]); break"
done

# 3. Full scoped-search traces L2 (agent) + L3 (conversation), both 0/0
jq -c 'select(.extra.queryId|startswith("1644303c") or (.extra.queryId|startswith("5f549ae0")))' \
  logs/context-search-20260524T003426.jsonl

# 4. RAW written values (all single-version, no overwrites)
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["17-ticket-created","ticket-17-implementation-result","17-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'

# 5. Everything the three invocations did against the store (MCP side)
grep -nE 'Assembled bootstrap|Embedded document' logs/mcp-server-20260524T003426.jsonl \
  | sed -n '/1528efbf\|d2d35c43\|2c54cce7\|17-/p'

# 6. B1 grounding — OpenSearchStore.getAll has no sort clause
grep -n 'getAll\|sort\|bool: { filter' apps/mcp-server/src/context-store/opensearch-store.ts | sed -n '1,8p'

# 7. B3 grounding — the doc TODO from 17-project-notes item (6) is now resolved
grep -n 'MCP_WORKSPACE_DIR' docs/context-store.md   # line 356: "Not set … since QRM8 #17"

# (store left running; stop with: docker stop quorum-opensearch-1)
```