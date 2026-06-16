# #14 Moderator Becomes Standalone Git Client — Context-Access Audit

**Date compiled:** 2026-06-12
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#14")
**Ticket:** `tickets/14-moderator-git-client.md` · **PR:** #36 (stray duplicate PR #37 closed)
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #14, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

> **Why this ticket matters.** #14 is the session's first **positive** retrieval specimen. Its `14-project-notes` (E19) is the **only project-note in the entire QRM8 session that was demonstrably read back and propagated into a downstream ticket** — the #11 architect both received it via bootstrap *and* retrieved it via semantic search, then wrote its volume-seed lesson into `11-design-notes` as a named design constraint. After three consecutive "write-only store" verdicts (#31, #17, #16), #14 is where the project-scope channel earns its tokens in both directions (B1). The conversation/agent channels stayed as dead as ever (F1/F2).

## Scope correction vs the index

The index lists **six** invocations for #14 and the full log sweep (`grep 'Invocation received' logs/{teamlead,developer,architect}-2026052*.jsonl`) confirms exactly six — no probes, no ENOSPC failures. Like #17/#16 (and unlike #31, where the index listed 1 and the sweep found 5), the index's per-ticket row count is complete. One structural fact the index row states but is worth foregrounding: the **moderator issued only one setup dispatch** (02:47:03, `b0b5645f…jsonl`); the MCP transport-drop retry (session report §4) spawned **two** setup invocations from it — `a3cafd1e` (duplicate, wrote `14-ticket-setup`, created the stray PR #37 that was then closed) and `18ed3c06` (primary, ran searches L4/L5, wrote `14-ticket-setup-complete`, used PR #36). Both ran productively and concurrently in the same teamlead container; their logs interleave (see Data recovery method).

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-24 02:47:03 → 02:51:03 | `a3cafd1e-8ae2-4f51-a06d-dd059be73d9f` | teamlead / setup **DUPLICATE** (MCP retry; stray PR #37) | `teamlead-20260524T003432.jsonl` | bootstrap **E1** · write **E5** · **zero searches** |
| I2 | 05-24 02:49:45 → 02:52:06 | `18ed3c06-9a1e-4272-b85a-efd57920a804` | teamlead / setup primary (PR #36) | `teamlead-20260524T003432.jsonl` | bootstrap **E2** · search **E3** (L4) · search **E4** (L5) · write **E6** |
| I3 | 05-24 16:55:09 → 16:59:26 | `1fae3154-70cd-4c2a-a7e6-c2ad517461d4` | developer / implement (entrypoint + compose + prompt + deny rules) | `developer-20260524T003432.jsonl` | bootstrap **E7** · search **E8** (agent L6, 0/0) · write **E9** (agent) · write **E10** (conv) |
| I4 | 05-24 17:07:19 → 17:14:02 | `9d2845f9-9689-451b-ba25-27588b8efef3` | teamlead / `/code-review:code-review` (**caught the volume-seed bug**) | `teamlead-20260524T003432.jsonl` | bootstrap **E11** · search **E12** (project L7) · search **E13** (conv L8, 0/0) · **no write** |
| I5 | 05-24 17:15:46 → 17:18:22 | `ae5d227d-be41-4ac7-8c8d-fe6218848629` | developer / fix (Dockerfile volume-seed, option D) | `developer-20260524T003432.jsonl` | bootstrap **E14** · search **E15** (agent L9, 0/0) · search **E16** (conv L10, 0/0) · write **E17** (conv) |
| I6 | 05-24 17:18:47 → 17:19:58 | `68384836-22b3-4bcf-a624-8cd04d0ec591` | teamlead / re-review + post verdict | `teamlead-20260524T003432.jsonl` | bootstrap **E18** · write **E19** (`project:_:14-project-notes`) · write **E20** (conv) |

Note the review verdict was **split across two invocations**: I4 ran the structured `/code-review` (no project-notes write — it found a bug and stopped to dispatch the fix), and only I6 (the post-fix re-review) wrote `14-project-notes`. So `14-project-notes` records the *accepted, post-fix* state from the start — it never had a premature-then-superseded v1 (contrast #31's B3). All seven writes are single-version (no `updatedAt` on any), so every RAW render below is verbatim-complete.

**The downstream consumer.** The cross-ticket reuse this audit's headline rests on happens **outside** #14's own invocation set — in the #11 architect design review (`b424f21d`, 05-24 17:56:57 → 18:02:01, `architect-20260524T003432.jsonl`). That invocation is audited as part of #11, but its consumption of `14-project-notes` is documented here at E19 because it is the only evidence that any #14 write was ever read back.

---

## Data recovery method

Same toolkit as the #31/#17/#16 audits. RAW write bodies recovered by **starting the stopped `quorum-opensearch-1` container** (data volume intact) and querying `quorum-context` with the embedding vector excluded:

```bash
docker start quorum-opensearch-1
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=20' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["14-ticket-setup","14-ticket-setup-complete","ticket-14-research",
       "ticket-14-implementation-result","14-first-boot-volume-seed-fix","14-project-notes","14-review-verdict"]}},
       "_source":{"excludes":["embedding"]}}'
```

All seven documents returned complete bodies plus `createdAt`/`createdBy`. **Interleaved-log caveat:** I1 and I2 ran concurrently in one teamlead process, so their JSONL lines interleave and a naive single-stream correlationId tag is unreliable. The **authoritative** partition assignment is the `Embedded document [scope:id:key]` event in the MCP server log, not the agent log — that is what places `14-ticket-setup` under `a3cafd1e` and `14-ticket-setup-complete` under `18ed3c06`, and L4/L5 under `18ed3c06` (confirmed against the trace stream's own `correlationId` field).

Bootstrap item *keys and full text* (gap G2) recovered from each role log's `=== Initial prompt ===` debug line. The #11 architect's consumption of `14-project-notes` was recovered two ways: the architect's `## Prior Decisions` block (verbatim, item 1) and the L14 search trace (`queryId 7fbd3ee1`, `14-project-notes` score 0.67, `includedInResult=true`). The propagation into `11-design-notes` was confirmed by reading that record back from OpenSearch.

---

## Chronological access-point audit

### E1 / E2 — Bootstrap injections, the two setup invocations (I1 02:47:03, I2 02:49:45)

Both assembled **4 items, 556 tokens, scopes=[project, conversation]** (`mcp-server-20260524T003426.jsonl:1891, :1939`), byte-identical item set (verified via each invocation's initial-prompt block):

```
## Prior Decisions

### Project Context
- 16-project-notes: "PR #35 code review accepted for ticket #16 (redirect agent memory to context
  store). … (7) Pattern note: the SYSTEM_PREAMBLE constant now has 5 sections — … Agent Memory.
  Future SYSTEM_PREAMBLE additions should append after the Agent Memory section."   [≈300 tok]
- draft-pr-based-workflow-bootstrap-design-notes: "PR-based workflow bootstrap ticket drafted …
  (1) gh CLI is NOT installed in either the moderator or agent Dockerfile stages … (7) Step 1
  (GH_TOKEN) must land first so the moderator gets gh auth on rebuild."             [≈220 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                  [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                        [≈10 tok]
```

This is the session's **fourth distinct project head**: `{29,billing}`(#31/#17-E1) → `{27,draft-pr}`(#17-E3) → `{17,draft-pr,qrm6}`(#16) → now `{16-project-notes, draft-pr, qrm6-rerun, elicitation}`. The head advanced to include `16-project-notes` (last ticket's note, written 02:37, ~10 min earlier) — again demonstrating the *arbitrary* freshness of the unsorted `getAll` (index B1 / #16-B1): the immediately-prior ticket's note surfaced, exactly as `17-project-notes` surfaced into #16.

**Quality feedback:**
- **Quality: none of it is about #14.** #14 is a moderator entrypoint git-clone + bind-mount removal. `16-project-notes` is the agent-memory prompt change (and carries item (7)'s known factual defect, #16-B3); `draft-pr-…` is gh-CLII install; the two elicitation strings are month-old QRM6 residue. There is a faint adjacency — `draft-pr-…` item (2) discusses `GH_TOKEN` wiring, which #14's clone depends on — but it predates and is superseded by the #15/#27 work the ticket actually builds on. Net: 556 tokens, ~0 #14 signal.
- **Re-usability: delivery channel, not a read.** The setup ran off the moderator prompt + the files the teamlead read directly (it opened `8-workspace-isolation.md`, `entrypoint.sh`, `docker-compose.yml`, `Dockerfile`, `settings.json`, `.env.example`, `10-file-session-store.md` — visible in the agent log), not these four records.
- **Added value beyond `docs/`+`tickets/`: zero.**

### E3 — Search L4, project scope (I2, 05-24 02:50:05) — `queryId ec8b21d1`

The primary setup's first retrieval. Tool call: `context_query{scope:project, mode:search, query:"ticket 14 moderator git client workspace isolation"}`. Hybrid, 438 ms, `maxTokens=2000`, 100 raw → **6 returned**, `truncatedByTokenBudget=true`. Scored results (✓ = included):

```
1.00 ✓ QRM8-direction-workspace-isolation   194 tok
0.72 ✓ QRM8-005-design-notes                 157
0.60 ✓ 20-project-notes                       313
0.58 ✓ 27-project-notes                       348
0.56 ✓ QRM8-D10-turn-start-reminder           116
0.56 ✓ 31-project-notes                        743
---- cut ----
0.55   15-project-notes                        389
0.54   QRM7-005-project-notes / -design-notes  …
```

**Quality feedback:**
- **Quality: a genuine project-scope success.** The top-6 are precisely #14's lineage: the milestone direction record (D4 workspace isolation), the QRM8-005 design notes, the `27-project-notes` gh-auth env-ordering work this ticket builds on, and — notably — `QRM8-D10-turn-start-reminder`, which is exactly the D10 turn-start-pull mechanic #14's prompt update documents. This is the index's F7 "ticket-number-anchored" pattern doing useful work: BM25 keys on "ticket 14" but the semantic phrase "moderator git client workspace isolation" pulls the right milestone cluster. No `14-*` key existed yet (this is the setup), so the query correctly leaned on direction/predecessor records.
- **Re-usability: corroborating, not sole-channel.** The teamlead's ticket draft correctly frames #14 as depending on #15/#27 and referencing D4/D5/D9/D10 — consistent with these hits — but the teamlead also read the underlying files directly, so the search is corroborating rather than load-bearing.
- **Added value beyond `docs/`+`tickets/`: moderate.** `QRM8-direction-workspace-isolation` and `QRM8-D10-turn-start-reminder` are store-only milestone-direction records (not in `tickets/14-…md`); surfacing them by semantic neighborhood is real discovery value for a setup task.

### E4 — Search L5, project scope (I2, 05-24 02:50:05) — `queryId a27d5189`

The primary setup's second retrieval, a **deliberate adjacent-ticket lookup**: `query:"ticket 15 PAT wiring gh auth entrypoint"`. Hybrid, 89 ms, 100 raw → **5 returned**, truncated:

```
0.92 ✓ 15-project-notes                                     389 tok
0.90 ✓ 27-project-notes                                     348
0.87 ✓ QRM8-git-auth-decision                               226
0.68 ✓ 20-followup-project-notes                            356
0.64 ✓ draft-pr-based-workflow-bootstrap-design-notes       222
```

**Quality feedback:**
- **Quality: the strongest semantic specimen in #14's setup.** #14's entrypoint clone sits directly on #15's gh-auth foundation, and the teamlead queried #15's lineage explicitly to ground the dependency. The return is a tight PAT/gh-auth cluster — `15-project-notes` (0.92), `27-project-notes` (0.90, the env-ordering fix), `QRM8-git-auth-decision` (0.87) — all high-relevance. This is the index's "L5 success case" and it holds up: the cluster is the exact credential-bootstrap chain #14's "clone must come after gh auth so the credential helper exists" design choice rests on.
- **Re-usability: real and visible in the artifact.** The shipped ticket's "Depends on: #15 … Provides `GH_TOKEN` env, `gh auth login`, `gh auth setup-git`" and the "Placement after gh auth" design choice mirror exactly this cluster's content. Whether the teamlead internalized it from the search or from reading `15-…md`/`27-…md` is unprovable, but the search at minimum confirmed the dependency was already synthesized in the store.
- **Added value beyond `docs/`+`tickets/`: moderate.** `QRM8-git-auth-decision` and `20-followup-project-notes` are store-only; the rest restate ticket files the teamlead could (and did) open.

### E5 — Write `conversation:a3cafd1e…:14-ticket-setup` (I1, 05-24 02:50:49)

The **duplicate** setup's completion record. RAW (complete, `createdBy=teamlead`):

```
Ticket #14 (Moderator Becomes Standalone Git Client) Phase 1 setup complete. Ticket file at
tickets/14-moderator-git-client.md. Branch: 14-moderator-git-client (off
8-workspace-isolation-staging). PR #36 at https://github.com/ia64mail/quorum/pull/36, retargeted to
8-workspace-isolation-staging. Build/lint/test all pass (788 tests, 46 suites). No architect review
requested — design is fully specified in D4/D5 of the QRM8 roadmap. Key decisions in ticket: (1)
dedicated moderator-workspace named volume (not reusing moderator-claude-data), (2) REPO_URL env var
for project-agnostic clone, (3) entrypoint reordering so clone happens after gh auth but before
quorum.md symlink, (4) prompt updates for D9/D1/D10 reference, (5) deny rule hardening for
tail/grep/cp credential vectors.
```

**Quality feedback:**
- **Quality: accurate, and a *better* setup record than #17/#16's** — items (1)–(5) are genuine design-decision summaries (named-volume choice, REPO_URL rationale, entrypoint ordering), not just a build/PR status echo.
- **Re-usability: zero — dead-end partition, and now a duplicate dead end.** It lives under `conversation:a3cafd1e…`, the *duplicate's* correlationId. Nothing ever read it (F1). See B2: the transport retry didn't just cost a redundant invocation — it forked the setup record into two divergent partitions (`a3cafd1e:14-ticket-setup` here, `18ed3c06:14-ticket-setup-complete` at E6), neither reachable.
- **Added value beyond `docs/`+`tickets/`: thin.** The decision summaries duplicate the ticket file's own Design/Scope sections; the PR URL is the only store-unique datum.

### E6 — Write `conversation:18ed3c06…:14-ticket-setup-complete` (I2, 05-24 02:51:49)

The **primary** setup's completion record — a near-duplicate of E5 written 60 s later into a different partition. RAW (complete, `createdBy=teamlead`):

```
Ticket #14 (Moderator Becomes Standalone Git Client) setup complete. Ticket file:
tickets/14-moderator-git-client.md. Branch: 14-moderator-git-client (off 8-workspace-isolation-staging).
PR #36 open targeting 8-workspace-isolation-staging. Commit: 1c41a34. Build/lint/test all green (788
tests, 46 suites). Ticket covers 7 implementation sections: (1) first-boot git clone in entrypoint.sh,
(2) bind mount removal in docker-compose.yml, (3) dedicated moderator-workspace named volume, (4)
REPO_URL env var, (5) CLAUDE.md prompt updates (D9/D1/D10/Pre-Isolation Note), (6) tool-guard deny rule
hardening, (7) GH_TOKEN confirmation. 12 acceptance criteria. Architect review decision: NOT NEEDED —
design is fully laid out in D4/D5 and the implementation surface is well-defined container/config
changes, not architectural novelty.
```

**Quality feedback:**
- **Quality: accurate; a structural index of the ticket's 7 sections.** Slightly more implementation-flavored than E5 (it enumerates the section list and the commit SHA `1c41a34`).
- **Re-usability: zero.** Dead-end partition `conversation:18ed3c06…`; the implement developer (I3) keyed its own `1fae3154…` and its bootstrap conversation leg was empty. Never read.
- **Added value beyond `docs/`+`tickets/`: thin.** The 7-section list and commit SHA are recoverable from the ticket file and `git log`. Together E5+E6 are the audit's clearest specimen of **F1 compounded by the transport-dup bug**: two accurate, redundant setup records, in two unreachable partitions, total consumption zero (B2).

### E7 — Bootstrap injection, implement (I3, 05-24 16:55:09)

**4 items, 556 tokens** (`mcp:2147`) — **identical set to E1/E2** (`16-project-notes`, `draft-pr-…`, two elicitation strings); the head held static across the ~14 h gap to the implement invocation. Conversation leg empty (the two setup records sit under `a3cafd1e`/`18ed3c06`, not the developer's `1fae3154`).

**Quality feedback:** same as E1/E2 — no #14 signal, delivery-only, zero added value. Worth noting: the implement developer's preamble **did** by now contain the `## Agent Memory` section (#16 had shipped), so this invocation is the first #14 actor operating under the new agent-scope policy — which it exercises at E8/E9 and which fails exactly as #16's B2 predicts.

### E8 — Search L6, agent scope (I3, 05-24 16:55:35) — `queryId 605ddb58`

The implement developer's only retrieval: `{scope:agent, mode:search, query:"ticket 14 moderator git client implementation"}`. Hybrid, 405 ms, `hitCountRaw=0`, **0 returned**, `truncatedByTokenBudget=false`, `results=[]`.

**Quality feedback:**
- **Quality of the query: well-formed; target structurally absent.** This is the standard "query agent scope on start" reflex the role preamble's Context Management section prescribes ("a previous attempt may have left research findings"). But `agent:1fae3154…` is this invocation's own fresh partition — empty at task start by construction (F1/F2). `hitCountRaw=0`, not the project k-cap of 100, confirms a genuinely empty partition.
- **Re-usability: nil by construction.**
- **Added value: negative** — a 405 ms round-trip retrieving nothing. The implement task ran off the ticket spec (named in the moderator dispatch) + the worktree.

### E9 — Write `agent:1fae3154…:ticket-14-research` (I3, 05-24 16:55:47)

The session's **first agent-scope write** (index F2's first instance). RAW (complete, `createdBy=developer`):

```
Ticket 14 research complete. Key files to modify: (1) docker/moderator/entrypoint.sh — add git clone
block after gh auth (line 59), reorder quorum.md symlink block to come after clone. (2)
docker-compose.yml — replace line 173 bind mount with named volume, add moderator-workspace to volumes
section, add REPO_URL env var. (3) .env.example — add REPO_URL entry after GH_TOKEN. (4)
docker/moderator/CLAUDE.md — update Pre-Isolation Note, add D9/D1/D10 notes. (5)
docker/moderator/settings.json — add tail/grep/rg/cp deny rules for ~/.config/gh/. (6)
tickets/14-moderator-git-client.md — flip ACs and add implementation notes. Current branch:
14-moderator-git-client. Three commit plan confirmed.
```

**Quality feedback:**
- **Quality: genuinely useful — a concrete 6-file modification plan with line anchors.** This is exactly the kind of episodic research checkpoint the D7 agent-memory policy (#16) wants captured; arguably the best-formed agent-scope write of the session.
- **Re-usability: zero, and this is index F2's purest demonstration.** The one realistic consumer — the **fix** invocation (I5, ae5d227d) 20 minutes later, a same-ticket same-role follow-up — queried agent scope at E15 and got 0/0, because `agent:ae5d227d…` ≠ `agent:1fae3154…` (no role dimension in the key; #16-B2, issue [#59](https://github.com/ia64mail/quorum/issues/59)). So the checkpoint was unreachable even by the invocation best positioned to want it. (In fairness the fix needed the *review finding*, not this pre-bug research plan — but the channel was dead regardless of content, which is the structural point.)
- **Added value beyond `docs/`+`tickets/`: thin and moot** — the plan restates the ticket's Implementation Details; its value would have been retry-resumption, which the addressing model makes impossible.

### E10 — Write `conversation:1fae3154…:ticket-14-implementation-result` (I3, 05-24 16:59:15)

The implementation record. RAW (complete, `createdBy=developer`):

```
Ticket #14 (Moderator Becomes Standalone Git Client) implemented in 3 commits on branch
14-moderator-git-client. Commit 1 (dc8099b): Reordered entrypoint — gh auth → git clone (new,
idempotent via .git check, uses REPO_URL env) → quorum.md symlink. Replaced moderator bind mount with
moderator-workspace named volume in docker-compose.yml. Added REPO_URL to moderator env and
.env.example. Commit 2 (f597b7c): Updated docker/moderator/CLAUDE.md — replaced Pre-Isolation Note
with Workspace Model section (D10 turn-start pull), added mandatory branch parameter note (D1), added
cross-turn session resume note (D9). Hardened settings.json with 8 new deny rules (tail, grep, rg, cp
for both path forms). Commit 3 (8635a9d): Flipped all 12 ACs, added Implementation Notes … All
verifications passed: 3 webpack compilations, 0 lint errors/warnings, 788 tests across 46 suites.
Agent-side bind mounts NOT touched (that's #11). MCP server NOT touched (#17 already done).
```

**Quality feedback:**
- **Quality: accurate, verified against the tree.** Entrypoint clone block is at `docker/moderator/entrypoint.sh:56-59` (`REPO_URL="${REPO_URL:?…}"`, `.git` idempotency check); `moderator-workspace` volume at `docker-compose.yml:176/262`; `REPO_URL` env at `:174`; **18** total deny rules in `settings.json` (the "8 new" matches — `tail`/`grep`/`rg`/`cp` × two path forms added atop the prior 10). The commit SHAs are store-unique.
- **Re-usability: zero, and self-defeating** — written into the developer's own `1fae3154…` partition *after* its own E8 search already failed; the reviewer (I4) ran no conversation search that could reach it and is in a different partition anyway. Never read.
- **Added value beyond `docs/`+`tickets/`: thin** — the three commit SHAs (`dc8099b`/`f597b7c`/`8635a9d`); everything else restates the ticket's Implementation Notes.

### E11 — Bootstrap injection, review (I4, 05-24 17:07:19)

**4 items, 556 tokens** (`mcp:2278`) — **identical set to E1/E2/E7**. Same off-scope `16-project-notes`/`draft-pr`/elicitation head. As at #31-E6 / #17-E7 / #16-E6, the obviously-relevant record to inject for a review would be `{14}-project-notes` for the ticket under review — which does not exist yet (written 12 min later at E19) and could only ever surface via the arbitrary `getAll` anyway. Delivery-only, zero added value.

### E12 — Search L7, project scope (I4, 05-24 17:07:33) — `queryId 10086bba`

The review's project query: `query:"ticket 14 moderator git client workspace isolation"` — **byte-identical query and result set to E3/L4** (same 6 hits, same scores, 432 ms). The reviewer re-ran the setup's exact search.

**Quality feedback:**
- **Quality: a high-relevance return that is nonetheless near-useless *for a review*.** The 6 hits are the milestone-direction cluster (E3) — appropriate for drafting the ticket, but a code review needs the *diff* and the *ticket's ACs*, which came from the worktree and the moderator's commit list, not from these direction records. The query is identical to the setup's because the agent has no `14-*` record to find yet (its own notes are unwritten).
- **Re-usability: nil for the review's actual job.** The volume-seed bug the review caught (its headline output) came from reading the Dockerfile, not from any store hit.
- **Added value: zero for this invocation** (duplicate of E3's value, consumed at a phase that couldn't use it).

### E13 / E15 / E16 — Empty scoped searches (I4 conv L8; I5 agent L9 + conv L10)

Three more scoped searches, all `hitCountRaw=0 → 0 returned`:

```
L8  fa4d4dcf  teamlead(I4)   conversation  "ticket 14 moderator git client code review"      0/0
L9  fc8d3100  developer(I5)  agent         "ticket 14 moderator git client first-boot clone" 0/0
L10 310c2e71  developer(I5)  conversation  "ticket 14 moderator git client PR 36"            0/0
```

**Quality feedback:** identical to #17-E4/E5 and #16-E4 — well-formed queries against partitions that structurally cannot hold the answer. L8 sought review context in the reviewer's own fresh conversation partition; L9 sought the implement developer's research (E9, which genuinely existed) in the *fix* developer's agent partition; L10 sought the setup/implementation records (E5/E6/E10, which existed) in the fix's own conversation partition. Every target lived under a different correlationId. **L9 is the sharpest specimen:** `ticket-14-research` (E9) is a near-verbatim match for "ticket 14 … first-boot clone," yet 0/0 — pure addressing failure (F1/F2; #16-B2). Net: negative, ~850 ms across three round-trips retrieving nothing.

### E14 / E18 — Bootstrap injections, fix (I5) + re-review (I6)

Both **4 items, 556 tokens** (`mcp:2377, :2423`) — **identical set to all prior #14 bootstraps**. The project head never moved across the entire #14 window (02:47 → 17:19, ~14.5 h). Delivery-only, no #14 signal. (E18's notable absence, as everywhere: `14-project-notes` is written *by this very invocation* 60 s after its own bootstrap, so the review of #14 is itself injected with last-ticket's `16-project-notes` instead.)

### E17 — Write `conversation:ae5d227d…:14-first-boot-volume-seed-fix` (I5, 05-24 17:18:16)

The fix record. RAW (complete, `createdBy=developer`):

```
PR #36 review finding addressed: Dockerfile moderator stage created /mnt/quorum/workspace/.claude at
build time (mkdir + chown), causing Docker to seed the named volume with non-empty content on first
mount. git clone then failed on the non-empty directory, killing the container on every first boot.
Fix: Option D — removed /mnt/quorum/workspace/.claude from mkdir and chown in Dockerfile lines 130-133.
Root cause removal, no entrypoint changes needed. CC CLI creates .claude/ on demand. Idempotency
preserved — second boot .git check still skips clone. Verification: build/lint/test all pass (788 tests,
46 suites). Commits: 752b95a (Dockerfile fix), 08b86f9 (ticket notes).
```

**Quality feedback:**
- **Quality: accurate and root-cause-framed; verified.** `Dockerfile:130-131` today reads `mkdir -p /app/logs /tmp/.claude /home/quorum/.claude /etc/claude /mnt/quorum/workspace` (and the matching `chown -R`) — `/mnt/quorum/workspace/.claude` is gone from both, exactly as described, leaving only the bare mount-point dir. This record carries the generalizable lesson ("Docker seeds the named volume from the image layer") that becomes E19 item (6) and then propagates to #11 (B1).
- **Re-usability: zero — dead-end partition `conversation:ae5d227d…`.** The re-review (I6) ran no conversation search and is in a different partition. Never read directly (though its *content* survives via E19, which is read — see B1).
- **Added value beyond `docs/`+`tickets/`: thin in isolation** — the ticket's "First-boot volume-seed bug fix" Implementation-Notes subsection (added in the same fix) carries the identical narrative. The store copy adds nothing the ticket lacks, but it is the proximate source of the E19 synthesis that *did* travel.

### E19 — Write `project:_:14-project-notes` (I6, 05-24 17:19:49) — **the session's one re-used project-note**

The post-fix review verdict synthesis, 345 tokens (`createdBy=teamlead`). RAW (complete):

```
PR #36 code review accepted for ticket #14 (moderator becomes standalone git client). Two-comment
review protocol completed: (1) Initial /code-review skill found a volume-seed bug — the Dockerfile
moderator stage ran mkdir -p /mnt/quorum/workspace/.claude at build time, causing Docker to seed the
named volume with non-empty content that made git clone fail on first boot. (2) Developer applied fix
commit 752b95a (Option D): removed /mnt/quorum/workspace/.claude from both mkdir -p and chown -R
commands in the Dockerfile moderator stage. Root-cause fix — the directory was never needed at build
time (no COPY targets it, entrypoint doesn't reference it, CC CLI creates .claude/ on demand). (3)
Re-review verified: both Dockerfile lines fixed, no collateral damage … entrypoint .git existence check
preserves idempotency … (4) Build/lint/test: 3 webpack compilations, 0 lint errors, 788 tests passed
across 46 suites. (5) All 12 ACs satisfied. (6) Pattern note: when adding directories under a Docker
volume mount point, be aware Docker seeds empty named volumes from image layers — build-time
directories at mount points will appear in the volume and can break tools expecting an empty directory.
```

**Quality feedback — checked against the shipped code and the downstream record:**
- **Accuracy: verified high, no defects.** Every claim matches the tree (E17 verification + the 18 deny rules + 12 flipped ACs). Critically — unlike #16's E7 item (7) — there is **no factual error** in this synthesis. Item (6) is a correct, genuinely generalizable infrastructure pattern.
- **Re-usability: HIGH — and this is the only project-note in the session that clears that bar.** `14-project-notes` was consumed by the #11 architect design review (`b424f21d`, 17:56→18:02, ~37 min after this write) through **two independent channels**:
  1. **Bootstrap** — it was injected as **item #1** of the architect's `## Prior Decisions` block (recovered verbatim from `architect-20260524T003432.jsonl`). The arbitrary `getAll` happened to surface it because it was the freshest project-note (same luck mechanism as `17-project-notes`→#16; index B1).
  2. **Semantic search** — the architect's L14 query `"worktree tmpfs volume agent repository clone"` (`queryId 7fbd3ee1`) returned `14-project-notes` at **score 0.67, rank 3 of 6, `includedInResult=true`** (345 tok). This is a *genuine k-NN win, not BM25 key-matching* — the query contains no "14" and no "moderator," so the match is purely semantic (volume/mount-content adjacency). It sits in index-F7's prized "genuinely semantic" category, and the moderator did **not** point the architect at the key (the #11 dispatch never mentions #14 or `14-project-notes` — verified in `b0b5645f…jsonl`), so this is discovery-by-neighborhood, not orchestrated handoff.
  Both channels then **propagated** into the architect's output: `11-design-notes` contains *"Volume-seed bug prevention (from #14): Dockerfile must only create empty mount-point dirs at `/var/agent-repo/` and `/var/agent-worktrees/`. NO sub-content. Check `14-project-notes` in context store"* and *"Dockerfile agent stage line 83: Add `/var/agent-repo /var/agent-worktrees` to mkdir and chown. Do NOT add content inside them."* — i.e. #14's item (6) pattern became a named, acted-upon constraint in #11's design. (See B1.)
- **Added value beyond `docs/`+`tickets/`: moderate-to-high.** Items (1)–(5) condense the ticket; the store-**unique** content is item (6)'s generalized Docker-volume-seeding pattern. In #31/#17/#16 the store-unique item was either never read (#17-B3), wrong (#16-B3), or destroyed (#31-B3). Here it was correct, store-unique, **and** it travelled — the single instance in the session of the full episodic→semantic→reuse cycle the parent research targets.

### E20 — Write `conversation:68384836…:14-review-verdict` (I6, 05-24 17:19:50)

A 1-second-later companion to E19, JSON-formatted (`createdBy=teamlead`):

```json
{"pr":36,"fixCommit":"752b95a","tests":"788/788","ticket":"14","build":"pass","verdict":"accept",
 "commentUrl":"https://github.com/ia64mail/quorum/pull/36#issuecomment-4529456830","notesCommit":"08b86f9"}
```

**Quality feedback:**
- **Quality: a compact operational-status record** — the role preamble explicitly sanctions JSON for "operational status records," so the format is correct here (contrast the prose convention for knowledge records).
- **Re-usability: zero** — dead-end partition `conversation:68384836…`; never read. It mirrors the structured-verdict half of #12's `12-rereview-verdict` (which the index flagged at G4 for a double-write); #14's verdict is single-write.
- **Added value beyond `docs/`+`tickets/`: thin** — the `commentUrl` is the only datum not in the ticket/PR, and it points *at* the PR. A near-pure echo.

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — `14-project-notes` is the session's ONLY confirmed cross-ticket project-note reuse, and it propagated a store-unique pattern into a downstream design — the positive counter-specimen to #31/#17/#16's "write-only store" verdicts.** The three prior audits each concluded their `{N}-project-notes` was "never read back through 05-28." #14 breaks the pattern: `14-project-notes` (E19, written 17:19:49) was consumed 37 minutes later by the #11 architect via **both** bootstrap injection (item #1 of its Prior Decisions) **and** semantic search (L14, `queryId 7fbd3ee1`, score 0.67, rank 3, `includedInResult=true`), and its item (6) volume-seed pattern was then written into `11-design-notes` as a named constraint ("Volume-seed bug prevention (from #14) … Check `14-project-notes` in context store"; "Do NOT add content inside [the mount-point dirs]"). This is the complete episodic→semantic→reuse cycle the parent research wants (`research-knowledge-management-analysis.md` §"Cognitive Science — Memory Taxonomy"): a bug discovered in review (episodic) → generalized to a Docker-volume-seeding pattern (semantic distillation, E19 item 6) → retrieved by a semantically-adjacent sibling ticket → applied as design guidance. Three properties make it a *strong* specimen, not a fluke: (a) the search hit was a genuine k-NN match (the query "worktree tmpfs volume agent repository clone" contains no ticket number or "moderator" — pure semantic neighborhood, index-F7's prized category); (b) it was **not** moderator-orchestrated — the #11 dispatch never names #14 or its key (verified in `b0b5645f…jsonl`), unlike #31's F3 exact-key handoff which *was* prompt-driven; (c) the record was accurate and small enough to bootstrap (345 tok < 600 budget) *and* it surfaced via the arbitrary `getAll`, so both delivery channels fired. **Caveat for the index's F-set:** this both *strengthens* F5 ("same-session project-scope freshness worked" — F5 already noted the L14 retrieval at the session level) and *corrects the over-broad framing* of the three write-only audits — project-scope **retrieval is not uniformly dead**; it delivers when a downstream task is semantically adjacent to a prior ticket's distilled note. #14→#11 (moderator-volume-isolation → agent-volume-isolation) is exactly that adjacency. No issue to file — this is the positive evidence the research was looking for; it should be carried into the index as the canonical "store earned its tokens" case if F1–F7 are ever revised.

**B2 — The MCP transport-drop retry did not just double the compute cost — it forked the setup record into two divergent, mutually-unreachable conversation partitions.** The moderator issued **one** setup dispatch (02:47:03); the transport retry spawned `a3cafd1e` and `18ed3c06`, which wrote `14-ticket-setup` (E5) and `14-ticket-setup-complete` (E6) respectively — two accurate-but-different summaries of the same setup, keyed on two different correlationIds, neither ever read. The session report (§4) already tracks the retry's **$1.64 redundant-compute** cost and attributes it to `wait_invocation` retry semantics (follow-up #39). This audit adds the **store-pollution** facet: under the current correlationId-keyed conversation scope (`mcp.service.ts:789`), each duplicate invocation also litters the store with a phantom record that can never be deduplicated against its twin (there is no cross-correlationId reconciliation). It is a second-order symptom of the same #39 root cause, not a new defect — but it means transport-drop duplicates degrade *knowledge quality*, not only cost. No new issue; strengthens #39. (The same forking is visible at #11's two Pass-A duplicates and #12's Pass-A duplicate — index §3 — each of which wrote a separate `*-implementation` record; #14's is the cleanest two-record specimen.)

**B3 — #14 is index-F2's first chronological instance and confirms the agent-scope channel is dead even for the same-ticket same-role consumer it was designed for.** `agent:1fae3154…:ticket-14-research` (E9) is the session's first agent-scope write — a well-formed 6-file research checkpoint, exactly what #16's D7 policy prescribes. The one realistic consumer was the **fix** invocation (I5, `ae5d227d`) 20 minutes later: a same-ticket, same-role (developer) follow-up, which dutifully queried agent scope (E15/L9, "ticket 14 … first-boot clone") and got **0/0** — because agent scope keys on the per-invocation correlationId with no role dimension (`mcp.service.ts:789/848`; #16-B2, issue [#59](https://github.com/ia64mail/quorum/issues/59)/PR #60). This is the concrete same-role re-read that #16-B2 predicted in the abstract: the policy's intended "next invocation of the same role picks up the checkpoint" path was exercised here for the first time and failed structurally. (Content caveat: the fix actually needed the *review finding*, not the pre-bug research plan, so the dead channel cost #14 nothing concrete — but the failure is in the addressing, independent of content, which is the point.) No new issue — direct evidence for the already-filed #59; the index's F2 ("7 research checkpoints, zero consumption") gets its first worked example here.

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap (setup dup) | accurate but 0% #14-relevant; 2/4 slots noise; head = `16-project-notes`+`draft-pr`+elicitation | n/a (delivery) | **Zero** |
| E2 | bootstrap (setup primary) | ≡ E1 | n/a (delivery) | **Zero** |
| E3 | project search L4 | high-relevance milestone-direction cluster (D4/D10/#27 lineage) | corroborating | **Moderate** — direction records store-only |
| E4 | project search L5 | strongest specimen — #15/#27 PAT/gh-auth cluster, all ≥0.64 | corroborating (visible in ticket deps) | **Moderate** — git-auth-decision store-only |
| E5 | write `14-ticket-setup` (conv, **dup**) | accurate design summary | **never** — dead-end + forked (B2) | **Thin** — PR URL only |
| E6 | write `14-ticket-setup-complete` (conv) | accurate; 7-section index + SHA | **never** — dead-end + forked (B2) | **Thin** — SHA only |
| E7 | bootstrap (implement) | ≡ E1; conv leg empty | n/a (delivery) | **Zero** |
| E8 | agent search L6 | well-formed; empty by construction | — (0/0) | **Negative** |
| E9 | write `ticket-14-research` (**agent**) | useful 6-file plan; F2's first instance | **never** — unreachable even by the fix (B3) | **Thin/moot** |
| E10 | write `…implementation-result` (conv) | accurate; code-verified; 3 SHAs | **never** — written after own failed search | **Thin** — SHAs only |
| E11 | bootstrap (review) | ≡ E1; the one #14 record doesn't exist yet | n/a (delivery) | **Zero** |
| E12 | project search L7 | ≡ E3 verbatim; high-relevance but wrong phase | nil for a review | **Zero** (dup of E3) |
| E13/E15/E16 | scoped searches ×3 | well-formed; empty partitions; L9 = verbatim-match miss | — (0/0) | **Negative** |
| E14/E18 | bootstrap (fix, re-review) | ≡ E1; static head all window | n/a (delivery) | **Zero** |
| E17 | write `…volume-seed-fix` (conv) | accurate root-cause record; source of E19 item 6 | **never** directly (content survives via E19) | **Thin** in isolation |
| **E19** | **write `14-project-notes` (project)** | **accurate, no defects; store-unique generalizable pattern (item 6)** | **YES — #11 architect, bootstrap + search L14 → into `11-design-notes` (B1)** | **Moderate-high — the session's one reused note** |
| E20 | write `14-review-verdict` (conv, JSON) | compact op-status record; correct format | **never** — dead-end | **Thin** — commentUrl only |

**Bottom line for the parent research:** #14 ran on the usual two primary channels — the ticket file (full spec, named in every dispatch) and the moderator prompt (commit progression, the explicit fix-option menu, the re-review checklist) — but it is the **first ticket where the Context Store made a net-positive retrieval contribution, and it did so on the project channel in both directions.** Inbound: the setup's two project searches (E3/E4) pulled the correct workspace-isolation + #15/#27 gh-auth lineage that grounds the ticket's dependency framing. Outbound: `14-project-notes` (E19) is the **only** project-note in the entire session that was read back and propagated — its volume-seed pattern travelled into #11's `11-design-notes` via a genuine semantic search hit plus a (lucky) bootstrap injection, with no moderator orchestration (B1). That single cross-ticket transfer is the clearest evidence in the whole dataset that the episodic→semantic→reuse pipeline the research envisions *can* work when a downstream task is semantically adjacent to a prior distilled note. Everything else conformed to the session-wide failure modes: all six bootstraps delivered the same off-scope head (static for 14.5 h, B1-arbitrary), all six conversation/agent scoped searches that targeted real-but-mis-partitioned records returned 0/0 (F1, with L9 a verbatim-match miss), the seven writes split 5-dead-end-conversation / 1-dead-agent / 1-reused-project, and the transport-drop duplicate even forked the setup record into two unreachable partitions (B2). #14's lesson for the KB design: the store's value is concentrated entirely in the **project scope** — that is the one scope with a stable, global address — and it pays off precisely when (a) the writing agent distils a *generalizable pattern* (item 6, not just status), (b) a *semantically adjacent* later task searches for it, and (c) the record is small enough to also ride the bootstrap. When all three align, as #14→#11 shows, the store earns its tokens; the conversation/agent scopes contributed nothing here, as everywhere.

---

## Appendix — reproduction

```bash
# 0. Start the stopped store (data volume intact); stop with: docker stop quorum-opensearch-1
docker start quorum-opensearch-1

# 1. Confirm the #14 invocation set is complete (6 invocations, incl. the a3cafd1e setup dup; no probes/ENOSPC)
grep -h 'Invocation received' logs/teamlead-20260524T003432.jsonl logs/developer-20260524T003432.jsonl \
  | python3 -c "import sys,json;[print(json.loads(l)['message'][:90]) for l in sys.stdin]" | grep -iE '#14|14-moderator'

# 2. Bootstrap item keys for all six #14 invocations (gap G2 workaround) — all identical 4-item set
for spec in a3cafd1e:teamlead 18ed3c06:teamlead 1fae3154:developer 9d2845f9:teamlead ae5d227d:developer 68384836:teamlead; do
  cid="${spec%%:*}"; role="${spec##*:}"
  python3 -c "import json,re
for l in open('logs/${role}-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=$cid' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print('$cid', re.findall(r'^- ([\w-]+):', m[i:i+2500], re.M)); break"
done

# 3. The four #14 search traces with hits (L4/L5 setup, L7 review) + the four empty ones (L6/L8/L9/L10)
for q in ec8b21d1 a27d5189 10086bba 605ddb58 fa4d4dcf fc8d3100 310c2e71; do
  echo "== $q =="
  jq -r --arg q "$q" 'select(.extra.queryId|startswith($q)) | .extra |
    "\(.callerRole) \(.scope) raw=\(.hitCountRaw) ret=\(.hitCountReturned) q=\(.queryText)",
    (.results[]? | "  \(.score|tostring[0:5]) \(.includedInResult) \(.key)")' logs/context-search-20260524T003426.jsonl
done

# 4. RAW written values — all seven #14 records, single-version
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=20' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["14-ticket-setup","14-ticket-setup-complete","ticket-14-research",
       "ticket-14-implementation-result","14-first-boot-volume-seed-fix","14-project-notes","14-review-verdict"]}},
       "_source":{"excludes":["embedding"]}}'

# 5. B1 — `14-project-notes` consumed by the #11 architect: bootstrap item #1 + search L14 hit
python3 -c "import json
for l in open('logs/architect-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=b424f21d' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print(m[i:i+300]); break"
jq -r 'select(.extra.queryId|startswith("7fbd3ee1")) | .extra.results[] | select(.key=="14-project-notes")
  | "L14 14-project-notes score=\(.score) included=\(.includedInResult)"' logs/context-search-20260524T003426.jsonl

# 6. B1 — propagation into 11-design-notes (the volume-seed constraint named "from #14")
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"term":{"key":"11-design-notes"}},"_source":{"excludes":["embedding"]}}' \
  | jq -r '.hits.hits[]._source.value' | grep -iE 'from #14|14-project-notes|mount.point|seed'

# 7. E19/E17 code verification — the Dockerfile volume-seed fix (option D) is live
grep -n 'mkdir -p' Dockerfile | grep workspace          # bare /mnt/quorum/workspace, no /.claude
grep -c '"Bash' docker/moderator/settings.json          # 18 deny rules incl. tail/grep/rg/cp

# 8. B3 — agent scope keyed on correlationId (research checkpoint unreachable by the fix)
grep -n "scope === ContextScope.project ? undefined : correlationId" apps/mcp-server/src/mcp/mcp.service.ts

# (store left running; stop with: docker stop quorum-opensearch-1)
```