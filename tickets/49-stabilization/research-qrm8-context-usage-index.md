# QRM8 Reference Session — Context Usage Data Index

**Date compiled:** 2026-06-11
**Session window:** 2026-05-24T00:36Z → 2026-05-27T01:43Z (the "ref QRM8 session")
**Parent research:** [../research-knowledge-management-analysis.md](../research-knowledge-management-analysis.md)
**Companion report:** [../articles/data/2026-05-27-qrm8-session-report.md](../articles/data/2026-05-27-qrm8-session-report.md) (costs, durations, full invocation timeline)

## Purpose

Raw-data index for per-ticket analysis of **knowledge quality** (what agents wrote to the Context Store) and **search quality** (what they queried and what the hybrid engine returned) during the QRM8 reference session. Every ticket section aggregates: the ticket file, the invocation timeline with correlation IDs, the exact log files and line numbers for each context event, and the search traces with returned keys/scores. Use it to jump straight from a research question ("did the developer find the design notes?") to the verbatim trace record.

All log paths are host paths under `logs/` (the in-container `/app/logs/` in the session report maps 1:1).

> **Doing a per-ticket deep audit?** Follow [§8 Per-ticket deep-audit playbook](#8-per-ticket-deep-audit-playbook), using [research-qrm8-31-context-audit.md](research-qrm8-31-context-audit.md) as the worked example (also done: [#17](research-qrm8-17-context-audit.md), [#16](research-qrm8-16-context-audit.md), [#14](research-qrm8-14-context-audit.md), [#11](research-qrm8-11-context-audit.md), [#13](research-qrm8-13-context-audit.md), [#12](research-qrm8-12-context-audit.md)). **All §3 reference-session tickets are now audited** — remaining coverage would extend into the §6 pre-trace QRM8 tickets (#10/#15/#20/#27/#29) with partial/no search-trace data.

---

## 1. Data sources

| Artifact | Path | Covers |
|----------|------|--------|
| Session cost/timeline report | `tickets/tmp/articles/data/2026-05-27-qrm8-session-report.md` | §7 has the authoritative correlationId ↔ ticket ↔ phase mapping |
| **Moderator CC CLI session log (raw)** | `logs/moderator-sessions/-mnt-quorum-workspace/b0b5645f-0241-4585-9a6b-d0946c9c8231.jsonl` | **Entire session** (2026-05-24T00:35:57Z → 05-27T02:12:22Z). Bind-mounted CC CLI session JSONL (post-QRM7-005, see `tools/session-report/SESSION-REPORT.md` §"Moderator Session Log"); contains every session correlationId, all `invoke_agent`/`context_query` tool calls the moderator issued, and the user/moderator dialogue. Sibling dir `b0b5645f…/tool-results/` holds oversized tool outputs. Adjacent files: `0723c723….jsonl` (pre-session stub, 00:25–00:26Z), `29302436….jsonl` (follow-up session 05-27→05-28 where the session report itself was written) |
| Moderator log, QuorumLogger format | `logs/moderator-{timestamp}.jsonl` (regenerate) | Adapter output of the raw file above — existing `moderator-*.jsonl` stop at 05-22 only because the adapter hasn't been re-run; `node tools/session-report/parse-logs.mjs` auto-runs `cc-session-adapter.mjs` and emits them as first-class agent activity |
| Moderator conversation transcript | `tickets/tmp/articles/data/2026-05-27-021206-we-have-completed-tickets31-tool-guard-namespace.txt` | Plain-text export of the same conversation — convenient for reading the narrative; use the raw JSONL for tool-call analysis |
| MCP server log | `logs/mcp-server-20260524T003426.jsonl` | **Entire session** (2026-05-24T00:34 → 05-27T02:12). All `context_query`, bootstrap-assembly, and `Embedded document` (= store write) events. Line numbers below refer to this file unless noted |
| **Search trace stream** | `logs/context-search-20260524T003426.jsonl` | All 22 search traces of the session (`ContextSearchTrace`, one JSON record per `context_query mode=search`, full results array with scores/snippets). `L<n>` below = line n of this file |
| Team lead agent log | `logs/teamlead-20260524T003432.jsonl` | 05-24 invocations (ends 05-25T00:14 at the ENOSPC restart) |
| Team lead agent log (post-restart) | `logs/teamlead-20260525T001458.jsonl` | 05-25 → 05-27 invocations (#13, #12) |
| Developer agent log | `logs/developer-20260524T003432.jsonl` | 05-24 invocations (#17, #16, #14, #11) |
| Developer agent log (post-restart) | `logs/developer-20260525T002445.jsonl` | 05-25 invocations (#13, #12) |
| Architect agent log | `logs/architect-20260524T003432.jsonl` | Single invocation (#11 design review) |
| Tickets | `tickets/<N>-<slug>.md` | Per-ticket below |

**Join keys:** `correlationId` links session-report rows ↔ agent logs ↔ MCP server events ↔ search traces. `queryId` links an MCP `context_query` log line to its full trace record in the search-trace stream. Conversation/agent scope partitions are keyed by the correlationId (`conversation:<correlationId>:<key>`, `agent:<correlationId>:<key>`); project scope is global (`project:_:<key>`).

**Mechanism docs:** `docs/context-store.md` (hybrid search pipeline §"Search" — BM25 0.3 + k-NN 0.7, min-max normalized; trace stream spec at lines ~398–430, shipped in QRM7-016 commits `74f7480`/`e46e924`), `docs/context-management.md` (scopes, bootstrap injection), `docs/knowledge-management.md` (three-domain philosophy).

---

## 2. Session-wide context activity summary

| Activity | Count | Outcome |
|----------|------:|---------|
| Bootstrap context assemblies | 34 (one per invocation, incl. duplicates/failures) | Always `scopes=[project, conversation]`, 3–4 items, 549–598 tokens. **Item keys are not logged** — only counts/tokens (see §5, gap G2) |
| Searches — **project** scope | 9 | **9/9 returned hits.** Always `hitCountRaw=100` (engine k-cap), truncated by the 2000-token budget to 1–6 returned items, `truncatedByTokenBudget=true` on all 9 |
| Searches — **conversation** scope | 7 | **0/0 hits on all 7** |
| Searches — **agent** scope | 6 | **0/0 hits on all 6** |
| Reads — `mode=keys` | 7 | All for `11-design-notes`, all 1 item. The only deliberate cross-invocation key handoff of the session |
| Reads — `mode=get-all` conversation | 2 | 1 hit (moderator pulling `c5096d29`'s setup notes), 0 for the other (own empty partition) |
| Reads — `mode=get-all` agent | 7 | **0 items on all 7** |
| Writes (`Embedded document`) | 40 events / 39 records | project 8, conversation 25 (24 unique — `12-rereview-verdict` written twice), agent 7 |

The headline pattern for the research: **project scope was the only functioning retrieval channel.** Every conversation- and agent-scope search/get-all by an agent returned zero because those partitions are keyed by the invocation's own (fresh) correlationId — reads happen at task start, before anything was ever written into that partition. The 7 agent-scope "research checkpoint" writes (the #16 memory-redirect feature, first exercised in this very session) were never read back by anyone. Details in §5.

---

## 3. Per-ticket data index

Phases, durations and costs are from the session report §7; line references: `mcp:<n>` = `logs/mcp-server-20260524T003426.jsonl`, `trace:L<n>` = `logs/context-search-20260524T003426.jsonl`.

### #31 — Tool-guard namespaced skill matching (review-only)

- **Ticket:** `tickets/31-tool-guard-namespaced-skill-matching.md` · **PR:** #32 (implementation predates session)
- **Agent log:** `logs/teamlead-20260524T003432.jsonl`
- **Deep audit:** [research-qrm8-31-context-audit.md](research-qrm8-31-context-audit.md) — full RAW renders of every context touch (incl. 4 pre-session invocations this index omits: first review round 05-23 + 3 probes), recovered store values via OpenSearch, and new findings B1–B5 (bootstrap getAll unsorted under OpenSearch — filed as [#55](https://github.com/ia64mail/quorum/issues/55)/PR #57; 600-token project budget excludes all `*-project-notes` records — filed as [#56](https://github.com/ia64mail/quorum/issues/56)/PR #58; `31-project-notes` has an overwritten stale v1)

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 05-24 00:36:42 → 00:45:28 | teamlead / review | `d19221c5-c194-4a62-b593-ff5b81b0c637` | bootstrap 4 items / 573 tok (mcp:120) · search trace:L1 (mcp:127) · write `project:_:31-project-notes` (mcp:226) |

**Search trace L1** — `queryId e6cc58bb`, project scope, *"ticket 31 tool-guard skill-name matching plugin namespaced"*, hybrid, 499 ms, 100 raw → 3 returned (budget-truncated):
`31-project-notes` 1.00 ✓ · `QRM5-BUG-002-project-notes` 0.65 ✓ · `29-project-notes` 0.58 ✓ · then below cut: `QRM4-004-design-notes` 0.40, `QRM6-BUG-014-*` ~0.29–0.33.
Quality note: top-3 are precisely the plugin-install/skill lineage (#31 ← #29 ← QRM5-BUG-002 vendoring) — a strong semantic-neighbor result worth citing as a hybrid-search success case.

### #17 — MCP server bind mount removal

- **Ticket:** `tickets/17-mcp-server-bind-mount.md` · **PR:** #34
- **Deep audit:** [research-qrm8-17-context-audit.md](research-qrm8-17-context-audit.md) — index's 3-invocation list confirmed complete (no probes/dups, unlike #31); all 3 writes RAW-recovered (single-version). Findings B1 (project-head **changed mid-ticket** 01:46→01:51 with no intervening project write — concrete in-session evidence for the unsorted-`getAll` defect #55), B2 (cleanest F1 specimen: two verbatim-matching docs existed yet scoped searches returned 0/0 — pure partition addressing), B3 (`17-project-notes` item (6) recorded a store-unique doc-staleness TODO, since resolved via the ticket/PR channel, not the store — write-only)

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 01:46:41 | teamlead / setup | `1528efbf-224d-4b35-ab5b-61519f6b58dc` | bootstrap 4/573 (mcp:1051) · no queries · write `conversation:1528efbf…:17-ticket-created` (mcp:1080) |
| 01:51:42 | developer / implement | `d2d35c43-721f-4333-8452-d1c4e6b7c472` | bootstrap 4/591 (mcp:1127) · searches trace:L2 agent + trace:L3 conversation, both *"ticket 17 mcp server bind mount"* → **0/0** (mcp:1129, 1133) · write `conversation:d2d35c43…:ticket-17-implementation-result` (mcp:1151) |
| 01:53:23 | teamlead / review | `2c54cce7-1240-4632-b51f-ea7d5a217f98` | bootstrap 4/591 (mcp:1164) · no queries · write `project:_:17-project-notes` (mcp:1237) |

Quality note: the developer's two scoped searches could not have hit anything — the setup notes lived in `conversation:1528efbf…`, a different partition. The ticket file itself (read from the worktree) carried the spec instead.

### #16 — Redirect agent memory to context store

- **Ticket:** `tickets/16-redirect-agent-memory.md` · **PR:** #35
- **Deep audit:** [research-qrm8-16-context-audit.md](research-qrm8-16-context-audit.md) — index's 3-invocation list confirmed complete (no probes/dups); all 3 writes RAW-recovered (single-version); **#16 produced zero agent-scope writes** despite authoring the agent-memory policy. Findings B1 (the fresh `17-project-notes` **was** injected into all 3 #16 bootstraps — corrects the #17 audit's "never injected"; the unsorted `getAll` is *arbitrary*, not uniformly stale; strengthens #55), B2 (the redirect target `context_store(scope='agent')` is keyed on correlationId identically to conversation scope — `mcp.service.ts:789/848` — so it cannot persist role knowledge across invocations; root cause beneath F2; QRM9's deferral plan doesn't fix the addressing — filed as [#59](https://github.com/ia64mail/quorum/issues/59)/PR #60), B3 (`16-project-notes` item (7) is factually wrong — claims "5 sections," the real count is 10 — store-unique-but-incorrect synthesis)

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 02:13:50 | teamlead / setup | `d14b97a0-d76e-4e4e-82ac-f8eff322339e` | bootstrap 3/598 (mcp:1442) · write `conversation:d14b97a0…:16-ticket-setup` (mcp:1478) |
| 02:34:24 | developer / implement | `6c5350ae-5c00-41f9-b216-ae1a8aedb27e` | bootstrap 3/598 (mcp:1705) · read agent get-all → **0** (mcp:1713) · write `conversation:6c5350ae…:16-implementation-result` (mcp:1735) |
| 02:36:18 | teamlead / review | `1e8c7b6d-6eb2-4161-9e03-862bcdbb3ad2` | bootstrap 3/598 (mcp:1748) · write `project:_:16-project-notes` (mcp:1764) |

Research relevance: this ticket *created* the agent-scope memory policy whose runtime behavior the rest of the session data measures (see §5, finding F2).

### #14 — Moderator standalone git client

- **Ticket:** `tickets/14-moderator-git-client.md` · **PR:** #36 (stray duplicate PR #37 closed)
- **Deep audit:** [research-qrm8-14-context-audit.md](research-qrm8-14-context-audit.md) — index's 6-invocation list confirmed complete (incl. the `a3cafd1e` setup duplicate). **The session's one positive specimen:** all 7 writes RAW-recovered; `14-project-notes` (E19) is the **only project-note in the session read back and propagated** — consumed by the #11 architect via bootstrap (item #1) **and** semantic search (L14, 0.67) and written into `11-design-notes` as a named volume-seed constraint, with no moderator orchestration. Findings B1 (the episodic→semantic→reuse cycle works for project scope when a downstream ticket is semantically adjacent — corrects the over-broad "write-only" framing of #31/#17/#16; strengthens F5), B2 (the MCP transport-drop retry forks the setup record into two unreachable conversation partitions — store-pollution facet of #39, beyond its compute cost), B3 (F2's first worked instance: `ticket-14-research` (E9) unreachable even by the same-ticket same-role fix invocation's agent-scope search — direct evidence for [#59](https://github.com/ia64mail/quorum/issues/59))

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 02:47:03 | teamlead / setup **DUPLICATE** | `a3cafd1e-8ae2-4f51-a06d-dd059be73d9f` | bootstrap 4/556 (mcp:1891) · write `conversation:a3cafd1e…:14-ticket-setup` (mcp:1965) |
| 02:49:45 | teamlead / setup primary | `18ed3c06-9a1e-4272-b85a-efd57920a804` | bootstrap 4/556 (mcp:1939) · searches trace:L4 + trace:L5 (mcp:1948, 1952) · write `conversation:18ed3c06…:14-ticket-setup-complete` (mcp:1985) |
| 16:55:09 | developer / implement | `1fae3154-70cd-4c2a-a7e6-c2ad517461d4` | bootstrap 4/556 (mcp:2147) · search trace:L6 agent *"ticket 14 moderator git client implementation"* → **0/0** (mcp:2149) · writes `agent:1fae3154…:ticket-14-research` (mcp:2159), `conversation:1fae3154…:ticket-14-implementation-result` (mcp:2197) |
| 17:07:19 | teamlead / review (caught volume-seed bug) | `9d2845f9-9689-451b-ba25-27588b8efef3` | bootstrap (mcp:2278) · searches trace:L7 project (identical query+results to L4) + trace:L8 conversation *"…code review"* → **0/0** (mcp:2280, 2284) |
| 17:15:46 | developer / fix | `ae5d227d-be41-4ac7-8c8d-fe6218848629` | bootstrap (mcp:2377) · searches trace:L9 agent *"…first-boot clone"* → **0/0**, trace:L10 conversation *"…PR 36"* → **0/0** (mcp:2379, 2383) · write `conversation:ae5d227d…:14-first-boot-volume-seed-fix` (mcp:2411) |
| 17:18:47 | teamlead / re-review | `68384836-22b3-4bcf-a624-8cd04d0ec591` | bootstrap (mcp:2423) · writes `project:_:14-project-notes` (mcp:2435), `conversation:68384836…:14-review-verdict` (mcp:2438) |

**Search traces** — L4 `ec8b21d1` *"ticket 14 moderator git client workspace isolation"* → 100 raw / 6 returned: `QRM8-direction-workspace-isolation` 1.00 ✓ · `QRM8-005-design-notes` 0.72 ✓ · `20-project-notes` 0.60 ✓ · `27-project-notes` 0.58 ✓ · `QRM8-D10-turn-start-reminder` 0.56 ✓. L5 `a27d5189` *"ticket 15 PAT wiring gh auth entrypoint"* → 100/5: `15-project-notes` 0.92 ✓ · `27-project-notes` 0.90 ✓ · `QRM8-git-auth-decision` 0.87 ✓ · `20-followup-project-notes` 0.68 ✓ · `draft-pr-based-workflow-bootstrap-design-notes` 0.64 ✓.
Quality note: L5 is a deliberate adjacent-ticket lookup (#15 PAT lineage feeding #14's entrypoint design) with high-relevance returns — a second success case. Note no top-scoring `14-*` key existed yet for L4; the query leaned on milestone-direction records.

### #11 — Git worktree per invocation

- **Ticket:** `tickets/11-worktree-per-invocation.md` · **PR:** #38
- **Deep audit:** [research-qrm8-11-context-audit.md](research-qrm8-11-context-audit.md) — the session's richest specimen, 35 access points across 8 invocations + 2 moderator actions. **The #14→#11 transfer closed from the consumer side:** `14-project-notes` was bootstrap **item #1 in all 8** #11 invocations (not just the architect — extends #14-B1) *and* the architect's L14 hit (genuine k-NN, 0.67), then propagated into `11-design-notes` → revise → shipped ticket → Dockerfile. Findings B1 (the full episodic→semantic→reuse→code cycle, both ends traced), B2 (#11 holds the **success and failure of the same addressing problem side by side**: `11-design-notes` read 7× by prompted `mode=keys` with perfect fidelity vs the architect's *own* unprompted search for it (L13) collapsing to 1 budget-starved process-note hit — a single 1,879-tok rank-2 doc suppressed 3 relevant design notes), B3 (the moderator's `get-all c5096d29` is the session's **only** working conversation read and it **propagated** — `11-ticket-setup`'s review flag quoted verbatim into the architect dispatch; answers F1's open sub-question (b)), B4 (F2's worst case — two *concurrent* same-role Pass-A devs redundantly researched the identical surface; `cd2957eb`'s agent get-all returned 0 on a sibling checkpoint **2 min old**; direct evidence for [#59](https://github.com/ia64mail/quorum/issues/59)), B5 (the path-traversal advisory reached follow-up ticket [#39](https://github.com/ia64mail/quorum/issues/39) via the **PR-comment** channel, not the store — and #39 is now **resolved**: `correlationId` is `z.string().uuid()` at both schema sites and the worktree `git` calls use `execFileAsync`; the store's own copy stayed write-only). Index-row corrections the audit makes authoritative: L14 returned **5** items (not 6), L13's top hit is *meta*-relevant (defines the design-note convention) not "questionable," and its 1-item result is a **budget-packing** artifact.

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 17:40:00 | teamlead / setup | `c5096d29-78fa-4d5c-873a-b8273a3e0a8a` | bootstrap 4/588 (mcp:2658) · search trace:L11 (mcp:2688) · write `conversation:c5096d29…:11-ticket-setup` (mcp:2753) |
| 17:55:03 | **moderator** (between invocations) | — (null in trace) | search trace:L12 (mcp:2841) · read conversation get-all `id=c5096d29…` → **1 item** (mcp:2844) — pulls the teamlead's setup notes before dispatching the architect |
| 17:56:57 | architect / design-review | `b424f21d-3585-4e75-9447-6a1863f6d41e` | bootstrap 4/588 (mcp:2874) · searches trace:L13, L14, L15 (mcp:2888, 2892, 2896) · write **`project:_:11-design-notes`** (mcp:2949) |
| 18:06:42 | moderator | — | read `mode=keys [11-design-notes]` → 1 (mcp:3002) |
| 18:09:15 | teamlead / revise | `ecd11908-e863-4aae-82ea-4d964dd8ac5d` | bootstrap (mcp:3030) · read keys `11-design-notes` (mcp:3031) · write `conversation:ecd11908…:11-ticket-revision` (mcp:3059) |
| 18:24:08 | developer / Pass A **DUPLICATE** (ran productively) | `43e6122e-a3a1-4ede-bfd8-149dec530c8b` | bootstrap (mcp:3177) · read keys `11-design-notes` (mcp:3182) · agent get-all → 0 (mcp:3185) · conversation get-all → 0 (mcp:3188) · writes `agent:43e6122e…:11-research-checkpoint` (mcp:3198), `conversation:43e6122e…:11-implementation-decisions` (mcp:3353) |
| 18:26:59 | developer / Pass A primary | `cd2957eb-9526-469e-8b81-afab208df599` | bootstrap (mcp:3240) · read keys `11-design-notes` (mcp:3241) · agent get-all → 0 (mcp:3244) · writes `agent:cd2957eb…:11-pass-a-research` (mcp:3268), `conversation:cd2957eb…:11-pass-a-implementation` (mcp:3339) |
| 18:33:24 | developer / Pass B | `649092c8-5fc2-47cf-a24f-43f14f95c2bc` | bootstrap (mcp:3356) · read keys `11-design-notes` (mcp:3357) · agent get-all → 0 (mcp:3360) · writes `agent:649092c8…:11-passB-research` (mcp:3374), `conversation:649092c8…:11-passB-implementation` (mcp:3416) |
| 18:37:41 | teamlead / review (path-traversal advisory) | `0430b72b-f8f3-4d8f-904e-d503de6ea2db` | bootstrap (mcp:3438) · read keys `11-design-notes` (mcp:3439) · write `project:_:11-project-notes` (mcp:3629) |
| 18:41:59 | teamlead / review **FAILED DUPLICATE** (ENOSPC) | `07c58b95-6130-49b6-813c-7c2ab507badd` | bootstrap (mcp:3507) · read keys `11-design-notes` (mcp:3515) |

**Search traces** — L11 `a17ea4b7` (teamlead) *"worktree invocation ticket 11 agent repository infrastructure"* → 100/4: `QRM8-direction-workspace-isolation` 1.00 ✓ · `QRM4-BUG-015-project-notes` 0.79 ✓ · `QRM4-004-design-notes` 0.62 ✓ · `29-project-notes` 0.57 ✓. L12 `4dc2d8a0` (moderator, near-identical query) → 100/6, same head plus `qrm7-015-redesign-complete` 0.71 ✓. L13 `af79231b` (architect) *"ticket 11 worktree design notes"* → 100/**1**: `QRM4-BUG-009-project-notes` 0.84 ✓ — searching for design notes **that didn't exist yet** (the architect was about to write them); the lone returned hit is questionable relevance. L14 `7fbd3ee1` *"worktree tmpfs volume agent repository clone"* → 100/6: `QRM8-direction-workspace-isolation` 1.00 ✓ · `QRM8-memory-policy` 0.70 ✓ · `14-project-notes` 0.67 ✓ · `16-project-notes` 0.66 ✓ — retrieved knowledge written **earlier in this same session** (#14/#16 project notes). L15 `fcddb03a` *"draft PR workflow bootstrap gh CLI installation"* → 100/5: `draft-pr-based-workflow-bootstrap-design-notes` 1.00 ✓ et al.

Quality note: #11 is the session's richest specimen — search (3 architect queries), exact-key handoff (`11-design-notes` read 7×: moderator, revise, Pass A ×2, Pass B, review ×2), agent-scope checkpoints (3, never read), and conversation-scope records (4, never read by agents). The key handoff was orchestrated by moderator prompting, **not** discovered via search.

### #13 — Branch-in-flight guard

- **Ticket:** `tickets/13-branch-in-flight-guard.md` · **PR:** #40
- **Agent logs:** teamlead `logs/teamlead-20260525T001458.jsonl`, developer `logs/developer-20260525T002445.jsonl`
- **Deep audit:** [research-qrm8-13-context-audit.md](research-qrm8-13-context-audit.md) — the session's **negative-space control** (the only ticket with zero searches *and* zero agent-scope writes; 5 invocations confirmed complete, clean sequential set). All 4 writes RAW-recovered (single-version) and the most code-accurate in the set. Findings B1 (the bootstrap head **moved** mid-ticket — `13-project-notes` ≈400 tok surfaced into I5's bootstrap and **displaced** `14-project-notes`/`draft-pr-…` via budget pressure; **corrects #31-B2/[#56](https://github.com/ia64mail/quorum/issues/56)** — concise `{ticket}-project-notes` *do* fit the 600-tok budget; only oversized notes (#31's 674, #11's ≈770) are excluded; sharpens [#55](https://github.com/ia64mail/quorum/issues/55)), B2 (pure negative-space control — the store carried nothing that changed any of 5 invocations; F2's emptiest form — agent `get-all` reflex fired into a scope #13 *never wrote*), B3 (highest write accuracy in the set, yet all write-only — the addressing bottleneck (F3) shown in the negative)

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 05-25 00:12:41 | teamlead / setup **FAILED** (ENOSPC, 216 ms) | `b9d4a52d-bbdd-4acc-8f4c-76b744cc7a6f` | bootstrap (mcp:8230) only — log in pre-restart `teamlead-20260524T003432.jsonl` |
| 00:15:42 | teamlead / setup | `5d4c681b-1a42-400a-944b-b2b6c420900b` | bootstrap 4/588 (mcp:8294) · write `conversation:5d4c681b…:13-ticket-setup` (mcp:8326) |
| 00:25:25 | developer / implement | `b64fb2f5-71d1-4a0e-811d-544f403efc96` | bootstrap (mcp:8434) · agent get-all → 0 (mcp:8435) · write `conversation:b64fb2f5…:13-implementation-result` (mcp:8475) |
| 00:29:22 | teamlead / review | `b82e7c95-7158-4b2b-b891-51852ccc0bf1` | bootstrap (mcp:8493) · write `project:_:13-project-notes` (mcp:8518) |
| 00:36:12 | developer / polish | `642f7b7e-7f43-4a1b-a50f-c54b03d70b0c` | bootstrap 4/549 (mcp:8576) · agent get-all → 0 (mcp:8577) · write `conversation:642f7b7e…:13-map-key-comments` (mcp:8587) |

Quality note: zero searches on this ticket — the entire flow ran on ticket file + PR + bootstrap alone.

### #12 — Handler-controlled commit & push

- **Ticket:** `tickets/12-handler-commit-push.md` · **PR:** #41
- **Agent logs:** teamlead `logs/teamlead-20260525T001458.jsonl`, developer `logs/developer-20260525T002445.jsonl`
- **Deep audit:** [research-qrm8-12-context-audit.md](research-qrm8-12-context-audit.md) — the session's **clearest waste case**, confirmed: 8 invocations (index complete, no probes/ENOSPC), **7 scoped searches all 0/0**, **11 writes none read by any agent**. All ten keys RAW-recovered (the two `ticket-12-pass-a-implementation` records survive in separate partitions — concurrency, not overwrite). Findings B1 (the bootstrap head was **frozen** across all 8 invocations incl. the +12 h fix and +2 d re-review, because `12-project-notes` is **617 tok — oversized**, so it never bootstrapped even into its own downstream invocations; third oversized specimen joining #31/#11, and sharpens #55 to "arbitrary *and* sticky against oversized writes" — strengthens [#55](https://github.com/ia64mail/quorum/issues/55)/[#56](https://github.com/ia64mail/quorum/issues/56)), B2 (the keystone waste: the +12 h **fix invocation** ran an on-target agent get-all + conversation search for Pass A/B context that genuinely existed and the dead-code finding already in `12-project-notes`, got 0 from every channel, and re-derived `extractCommitMessage` from the PR diff — dated case study for [#59](https://github.com/ia64mail/quorum/issues/59)), B3 (#11-B4's **concurrent same-role** failure reproduced developer-side: two Pass-A devs overlapping 01:07–01:10, the duplicate's searches 0/0, coordination via git state → duplicate-key store pollution), B4 (`12-project-notes` item (3)'s "follow-up ticket needed" claim was resolved **in-session** by the fix and the correction went to the ticket file/git, not the store — stale write-only synthesis, #17-B3/#13-B3 pattern), B5 (**G4 resolved**: the `12-rereview-verdict` double-embed is a write-path/backfill-sweep race — one record, two Ollama embeds, `embedding-pipeline.service.ts:76-83`; benign, low-priority efficiency note, not filed)

| Time (UTC) | Role / phase | correlationId | Context events |
|---|---|---|---|
| 05-25 00:40:03 | teamlead / setup | `1c914324-67d0-4826-87c6-ec51215ce5bd` | bootstrap (mcp:8622) · write `conversation:1c914324…:12-ticket-setup` (mcp:8653) |
| 00:51:36 | teamlead / revise (user feedback: delegate commit msg) | `f05a064b-e9de-4da6-9e57-1ba4addf7960` | bootstrap (mcp:8738) · write `conversation:f05a064b…:12-revision-summary` (mcp:8765) |
| 01:03:05 | developer / Pass A primary | `b03aa795-beca-4f7e-91e2-45f8b75d7ea8` | bootstrap (mcp:8857) · searches trace:L16 agent *"ticket 12 handler commit push progress"* → **0/0**, trace:L17 conversation → **0/0** (mcp:8863, 8867) · writes `agent:b03aa795…:ticket-12-research` (mcp:8872), `conversation:b03aa795…:ticket-12-pass-a-implementation` (mcp:8954) |
| 01:07:16 | developer / Pass A **DUPLICATE** (no-op'd) | `b73c9f7b-e1b3-457d-8390-c0ca73c9d4ac` | bootstrap (mcp:8928) · searches trace:L18 agent → **0/0**, trace:L19 conversation → **0/0** (mcp:8930, 8934) · write `conversation:b73c9f7b…:ticket-12-pass-a-implementation` (mcp:8985) — the duplicate "saw work done" via **git state**, not via context store (its conversation search for the primary's record returned 0 — different partition) |
| 01:29:30 | developer / Pass B | `de7a525f-ec9b-4369-a6c5-eec42fa2565a` | bootstrap (mcp:9271) · searches trace:L20 agent *"…pass B"* → **0/0**, trace:L21 conversation → **0/0** (mcp:9273, 9277) · writes `agent:de7a525f…:pass-b-research` (mcp:9290), `conversation:de7a525f…:12-pass-b-result` (mcp:9354) |
| 01:34:48 | teamlead / review (caught dead-code primary path) | `8a551bf6-4502-4f8a-819c-bee10c281853` | bootstrap (mcp:9382) · write `project:_:12-project-notes` (mcp:9688) |
| 13:25:59 | developer / fix (`<commit-message>` wiring) | `e0728f86-fc39-476c-92ae-6ddf1657f981` | bootstrap (mcp:10364) · agent get-all → 0 (mcp:10365) · search trace:L22 conversation *"ticket 12 commit message handler"* → **0/0** (mcp:10369) · writes `agent:e0728f86…:12-research-findings` (mcp:10398), `conversation:e0728f86…:12-delimiter-extraction-impl` (mcp:10423) |
| 05-27 01:41:22 | teamlead / re-review | `df3d7b8e-8a21-4fbc-97c0-92370bc3836c` | bootstrap (mcp:30079) · write `conversation:df3d7b8e…:12-rereview-verdict` **twice** (mcp:30096, 30098) |

Quality note: #12 had the most scoped-search attempts (7) and every single one returned 0 — including the fix invocation (e0728f86) searching for the Pass A/B context that genuinely existed but in unreachable partitions. The fix agent re-derived everything from the PR diff and review comments. This is the clearest waste case for the research: ~5 written records about #12 implementation were invisible to the very invocation that needed them most.

---

## 4. Search quality dataset — all 22 traces

For score-distribution work, the full per-trace results arrays (up to 100 hits each, with snippet + tokensEstimate + includedInResult) are in `logs/context-search-20260524T003426.jsonl`, one record per line, L1–L22 in chronological order:

| L | queryId | caller | scope | query | raw→ret | trunc |
|---|---------|--------|-------|-------|---------|-------|
| 1 | `e6cc58bb` | teamlead | project | ticket 31 tool-guard skill-name matching plugin namespaced | 100→3 | ✓ |
| 2 | `1644303c` | developer | agent | ticket 17 mcp server bind mount | 0→0 | |
| 3 | `5f549ae0` | developer | conversation | ticket 17 mcp server bind mount | 0→0 | |
| 4 | `ec8b21d1` | teamlead | project | ticket 14 moderator git client workspace isolation | 100→6 | ✓ |
| 5 | `a27d5189` | teamlead | project | ticket 15 PAT wiring gh auth entrypoint | 100→5 | ✓ |
| 6 | `605ddb58` | developer | agent | ticket 14 moderator git client implementation | 0→0 | |
| 7 | `10086bba` | teamlead | project | ticket 14 moderator git client workspace isolation | 100→6 | ✓ |
| 8 | `fa4d4dcf` | teamlead | conversation | ticket 14 moderator git client code review | 0→0 | |
| 9 | `fc8d3100` | developer | agent | ticket 14 moderator git client first-boot clone | 0→0 | |
| 10 | `310c2e71` | developer | conversation | ticket 14 moderator git client PR 36 | 0→0 | |
| 11 | `a17ea4b7` | teamlead | project | worktree invocation ticket 11 agent repository infrastructure | 100→4 | ✓ |
| 12 | `4dc2d8a0` | **null (moderator)** | project | ticket 11 worktree per invocation agent repo infrastructure | 100→6 | ✓ |
| 13 | `af79231b` | architect | project | ticket 11 worktree design notes | 100→1 | ✓ |
| 14 | `7fbd3ee1` | architect | project | worktree tmpfs volume agent repository clone | 100→6 | ✓ |
| 15 | `fcddb03a` | architect | project | draft PR workflow bootstrap gh CLI installation | 100→5 | ✓ |
| 16 | `1c4db9cf` | developer | agent | ticket 12 handler commit push progress | 0→0 | |
| 17 | `cf373513` | developer | conversation | ticket 12 handler commit push | 0→0 | |
| 18 | `56e8ac99` | developer | agent | ticket 12 handler commit push implementation | 0→0 | |
| 19 | `68d9c657` | developer | conversation | ticket 12 handler commit push | 0→0 | |
| 20 | `6b907e1a` | developer | agent | ticket 12 handler commit push pass B | 0→0 | |
| 21 | `81c038d1` | developer | conversation | ticket 12 handler commit push | 0→0 | |
| 22 | `2fc3192a` | developer | conversation | ticket 12 commit message handler | 0→0 | |

All searches ran `engine=hybrid` (Ollama embedding available throughout — no `bm25-only` fallbacks). Project-scope latency: 78–499 ms; empty scoped searches: 53–414 ms.

---

## 5. Findings — entry points for the knowledge-quality analysis

These are observed patterns in the data, framed as research hypotheses to verify against the store implementation, not conclusions.

**F1 — Conversation/agent scopes were write-only this session (13/13 searches and 9/9 agent-side get-alls returned zero).** Both scopes partition by correlationId, and every invocation ran a fresh session (`sessionId: ""` per the session report). An invocation's reads (at task start) always precede any write into its own partition, and other invocations' partitions are unreachable by scoped query. Net effect: 32 of 39 written records (25 conversation + 7 agent) were never retrieved by any agent. The only successful conversation-scope read was the moderator's explicit `get-all id=c5096d29…` (mcp:2844) — possible because the moderator passes an arbitrary id. Decide whether this is (a) a scoping-model defect, (b) a moderator-orchestration gap (it could pass prior correlationIds as conversation ids but didn't), or (c) an argument for project-scope-by-default writes.

**F2 — The #16 agent-memory redirect produced 7 research checkpoints with zero consumption.** `agent:<correlationId>:*` writes (`ticket-14-research`, `11-research-checkpoint`, `11-pass-a-research`, `11-passB-research`, `ticket-12-research`, `pass-b-research`, `12-research-findings`) were intended as durable agent memory, but the partition key makes them invisible to the next invocation of the same role. Direct evidence for the research doc's "redundant discovery" theme: Pass A's research could not feed Pass B (18:27 → 18:33, 6 minutes apart), nor the #12 fix invocation 12 hours later.

**F3 — Exact-key handoff outperformed search as the cross-invocation channel.** `project:_:11-design-notes` was read 7× by `mode=keys` across 6 invocations + moderator — the single most-consumed record of the session — because the moderator embedded the key in prompts. Searches never had to find it. Suggests the bottleneck is *addressing* (knowing what to ask for), supporting the KB-with-stable-addresses direction over pure semantic retrieval.

**F4 — Project-scope search always returns `hitCountRaw=100` with min-max-normalized scores (top hit ≡ 1.00).** The k-NN leg matches everything in the index (k-cap 100), so raw hit count carries no signal, and absolute scores are not comparable across queries. Search-precision analysis must use rank order + the `includedInResult` token-budget cut (1–6 items at 2000 tokens), not score thresholds. Also: 9/9 project searches were budget-truncated — the budget, not relevance, decides what the agent sees beyond rank ~5.

**F5 — Same-session project-scope freshness worked.** The architect's L14 query (18:01) retrieved `14-project-notes` and `16-project-notes` written 41 min and 5.5 h earlier in the same session — the ~300 ms async embedding pipeline (docs/context-store.md) held up. Query L13 is the inverse specimen: searching for `11-design-notes` *before it existed* returned a weak 0.84 hit (`QRM4-BUG-009-project-notes`) with no "nothing relevant" signal to the agent.

**F6 — Trace/observability gaps to fix before the next measurement session.**
- **G1**: Moderator-issued queries log `correlationId/callerRole/sessionId = null` in the trace stream (trace L12) — the trace alone can't attribute them. They *are* recoverable by timestamp-joining against the raw moderator CC CLI session log (`logs/moderator-sessions/…/b0b5645f….jsonl`), where the originating `mcp__quorum__context_query` tool call appears verbatim — but the trace record itself should carry the caller.
- **G2**: `BootstrapContextService` logs only counts/tokens ("4 items, 573 tokens"), never the item keys — you cannot tell *which* project/conversation records were injected without diffing the agent-side prompt in the role JSONL. This blocks measuring bootstrap-vs-search overlap.
- **G3**: Store writes are only observable via the debug-level `EmbeddingPipelineService "Embedded document"` event — no value/size/TTL metadata, no caller role.
- **G4**: `12-rereview-verdict` embedded twice in 1 s (mcp:30096, 30098) — duplicate write or re-embed worth a look.

**F7 — Query phrasing is ticket-number-anchored** ("ticket N …" in 19/22 queries), which makes BM25 key-name matching do much of the work and reliably pulls the `N-project-notes` family. The genuinely semantic wins (L1's QRM5-BUG-002 lineage, L5's PAT/auth cluster, L14's tmpfs/volume cluster) are the cases to grade when judging whether the 0.7 k-NN weight earns its keep.

---

## 6. Appendix — coverage beyond the reference session

The trace stream (QRM7-016) only exists from **2026-05-15**; QRM8 tickets implemented before then (#10 partially, #15, #20 partially, #27, #29) have limited or no search-trace coverage. All other trace records in the QRM8 window, for extending the per-ticket analysis:

| Trace file | Records | Tickets touched | Sample |
|------------|--------:|-----------------|--------|
| `context-search-20260515T031118.jsonl` | 2 | #47-era research | moderator(?) project "long-poll continuation design rationale" 99→6; developer project "OpenSearch hybrid search engine choice" 99→3 |
| `context-search-20260518T180925.jsonl` | 2 | #20 | teamlead conversation + developer agent, both **0/0** |
| `context-search-20260519T002015.jsonl` | 1 | #10 | developer project "FileSessionStore session store design notes ticket 10" 100→2 |
| `context-search-20260522T021256.jsonl` | 1 | #15 | developer project "ticket 15 pat wiring design notes" 100→1 |
| `context-search-20260523T003723.jsonl` | 1 | #29 | teamlead project "ticket 29 agent plugin code-review entrypoint" 100→4 |
| `context-search-20260527T021423.jsonl` | 2 | #39, #45 | developer agent searches, both **0/0** |
| `context-search-20260528T020129.jsonl` | 2 | #39 | developer agent + conversation, both **0/0** |

The scoped-search-always-empty pattern (F1) holds across every file: **project 7/7 with hits, conversation/agent 8/8 empty** outside the session too. Matching MCP server / role logs for those windows follow the same `{role}-{bootTimestamp}.jsonl` naming; session narratives for the earlier QRM8 runs are in `logs/sessions/2026-05-06-qrm8-roadmap-run.md` and `logs/sessions/2026-05-22-qrm8-15-pat-wiring.md`.

## 7. Analysis recipes

```bash
# Full trace record for one query (by short queryId prefix)
jq -c 'select(.extra.queryId | startswith("e6cc58bb"))' logs/context-search-20260524T003426.jsonl

# Score/key table for one query, including below-cut hits
jq -r 'select(.extra.queryId|startswith("a17ea4b7")) | .extra.results[] | [.score, .key, .includedInResult] | @tsv' \
  logs/context-search-20260524T003426.jsonl

# Everything one invocation did against the store (MCP side)
grep -n 'cd2957eb-9526-469e-8b81-afab208df599' logs/mcp-server-20260524T003426.jsonl | grep -E 'context_query|Embedded|bootstrap'

# Full agent transcript for one invocation
grep -h 'cd2957eb-9526-469e-8b81-afab208df599' logs/developer-20260524T003432.jsonl

# All store writes in the session
grep -n 'Embedded document' logs/mcp-server-20260524T003426.jsonl

# Which records a given write produced vs. who (never) read them
grep -n '11-pass-a-research' logs/mcp-server-20260524T003426.jsonl

# Moderator-side view of one ticket (dispatch prompts, context_query calls, user dialogue)
grep -n 'c5096d29-78fa-4d5c-873a-b8273a3e0a8a' \
  logs/moderator-sessions/-mnt-quorum-workspace/b0b5645f-0241-4585-9a6b-d0946c9c8231.jsonl

# Regenerate QuorumLogger-format moderator-*.jsonl from the raw CC CLI session files
node tools/session-report/parse-logs.mjs
```

---

## 8. Per-ticket deep-audit playbook

The reference output of this process is [research-qrm8-31-context-audit.md](research-qrm8-31-context-audit.md) — the **#31** audit. This section generalizes its method so the same audit can be produced for any ticket in §3. **Read the #31 audit first**: it is the worked example every step below points back to.

**Deliverable.** One file `research-qrm8-<N>-context-audit.md` per ticket, with this fixed skeleton (mirror the #31 headings exactly):

1. **Header block** — date, parent-index link to the §3 row, ticket + PR, one-line audit scope.
2. **`## Scope correction vs the index`** — the index row is a *summary*; the audit is authoritative. Re-sweep the logs and list **every** invocation (incl. probes, duplicates, ENOSPC failures) in a table: `I1…In | time | correlationId | purpose | agent log | context events`. State up front anything the index missed (extra invocations, key versions).
3. **`## Data recovery method`** — note which RAW values you recovered and how (see toolkit below); call out any value that is only partially recoverable (overwritten keys).
4. **`## Chronological access-point audit`** — number every store touch `E1…En` in time order. For each: render the RAW content (bootstrap `## Prior Decisions` block / search query+results with scores / written value), then a **`**Quality feedback:**`** block on three axes (see rubric).
5. **`## Cross-cutting findings (new — beyond the index's F1–F7)`** — `B<n>` findings specific to this ticket that the index's session-wide F1–F7 don't already cover. Verify each against the shipped code (cite `file:line`); if it's a real defect, file an issue + spec ticket and link them inline (the #31 audit filed [#55](https://github.com/ia64mail/quorum/issues/55)/[#56](https://github.com/ia64mail/quorum/issues/56)).
6. **`## Verdict summary — every touch graded`** — one table row per `E<n>`: `Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/`, then a **bottom-line** paragraph aimed at the parent research question (did the store earn its tokens for this ticket?).
7. **`## Appendix — reproduction`** — the exact commands that regenerate this audit's evidence (parameterized for `<N>`).

**Per-touch quality rubric (step 4).** Grade each access point on the same three axes the #31 audit uses:
- **Quality** — is the content accurate, relevant, current? (Flag stale/wrong/premature-synthesis records.)
- **Re-usability** — was it actually read back, by whom, and was any relevance by *design* or by *luck*? (Cross-reference F1/F3/B1.)
- **Added value beyond `docs/` + `tickets/`** — did the store carry something the ticket file and project docs didn't already say? Grade High / Moderate / Thin / Zero / Negative.

**Recovery toolkit (the non-obvious steps that make RAW rendering possible).**

```bash
# 0. PREREQUISITE for RAW write values — start the stopped store (data volume is intact).
#    Logs only carry truncated fragments (G3); OpenSearch holds the full body, LATEST version only.
docker start quorum-opensearch-1     # stop with: docker stop quorum-opensearch-1 when done

# 1. Full invocation sweep — do NOT trust the index's per-ticket row count.
#    Sweep every role log in the window for the ticket number / PR.
grep -n 'Invocation received' logs/{teamlead,developer,architect}-2026052*.jsonl | grep -i '17\|PR #34'

# 2. Bootstrap item keys+text (gap G2 workaround) — recovered from the agent-side
#    '=== Initial prompt ===' debug line, which embeds the rendered '## Prior Decisions' block.
python3 -c "import json;[print(json.loads(l)['message']) for l in open('logs/developer-20260524T003432.jsonl') if 'Initial prompt for correlationId=<corrId>' in l]" | sed -n '/## Prior Decisions/,/^---/p'

# 3. Full search trace (all 100 scored hits) for a query by short queryId.
jq -c 'select(.extra.queryId|startswith("<queryId>"))' logs/context-search-20260524T003426.jsonl

# 4. RAW written values — query the live index by key (excludes the embedding vector).
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["17-project-notes","17-ticket-created"]}},"_source":{"excludes":["embedding"]}}'

# 5. Everything one invocation did against the store (MCP side).
grep -n '<corrId>' logs/mcp-server-20260524T003426.jsonl | grep -E 'context_query|Embedded|bootstrap'
```

**Invariants & gotchas (learned from #31).**
- **The index undercounts.** #31 listed 1 invocation; the sweep found 5. Always re-sweep — probes, duplicates, and failed (ENOSPC) invocations all produce context events and belong in the audit.
- **OpenSearch keeps only the latest version per key.** If a `<N>-project-notes` was overwritten in-session, its earlier version survives only as log/trace fragments — render what you can and flag the gap (the #31 v1/v2 case, finding B3).
- **The F1–F7 baseline is given.** Don't re-derive the session-wide findings; the audit's job is the ticket-specific `B<n>` deltas on top of them.
- **This is internal research, not article copy** — real correlationIds, real keys, real issue numbers (the §11 anonymization rule binds the *articles*, not these audit files).

**Acceptance checklist** — the audit is done when every store touch has an `E<n>` with RAW render + 3-axis feedback, every invocation (including the ones the index omits) is accounted for, each `B<n>` is code-verified and (if a defect) filed, and the verdict table covers all `E<n>`.

**Queue.** Done: #31 (worked example), [#17](research-qrm8-17-context-audit.md), [#16](research-qrm8-16-context-audit.md), [#14](research-qrm8-14-context-audit.md), [#11](research-qrm8-11-context-audit.md), [#13](research-qrm8-13-context-audit.md) (the zero-search negative-space control — confirmed: store carried nothing that changed an outcome; bonus B1 corrects #56's budget-exclusion claim), [#12](research-qrm8-12-context-audit.md) (the waste case — confirmed: 11 writes, 0 reads; 7 empty searches; the fix invocation re-derived a finding the store already held). **All §3 reference-session tickets are now audited.** Any further work extends into §6 pre-trace tickets (#10/#15/#20/#27/#29 — partial/no search-trace coverage) or rolls the seven per-ticket audits up into the parent [knowledge-management analysis](../research-knowledge-management-analysis.md).

> **#13 done — prediction held, with one surprise.** The [#13 audit](research-qrm8-13-context-audit.md) confirmed the negative-space-control thesis: zero searches, zero agent-scope writes, 4 single-version writes, both agent get-alls returned 0 (F2's emptiest form), and the store carried nothing that changed any of the 5 invocations — pure overhead, the floor as predicted. The surprise that the prediction got *wrong*: the bootstrap head is **not** uniformly off-topic/static. I1–I4 carried the `14`-family head as expected, but once `13-project-notes` (≈400 tok) was written, it **surfaced into I5's bootstrap and displaced** `14-project-notes`/`draft-pr-…` via budget pressure (B1) — which **corrects #31-B2/[#56](https://github.com/ia64mail/quorum/issues/56)**: a concise `{ticket}-project-notes` *does* fit the 600-tok budget and *does* get bootstrapped; only oversized notes (#31's 674, #11's ≈770) are structurally excluded.
>
> **Starting #12:** the index §3 lists 8 invocations (incl. the `b73c9f7b` no-op'd Pass-A duplicate and the `df3d7b8e` re-review that double-wrote `12-rereview-verdict`, gap G4). #12 is the **clearest waste case**: 7 scoped searches, **all 0/0** (traces L16–L22), including the 13-hours-later fix invocation (`e0728f86`) searching for Pass A/B context that genuinely existed but in unreachable partitions. The audit's job: render all 7 empty searches with their queries, RAW-recover the ~5+ implementation/research records they failed to find (`ticket-12-research`, `ticket-12-pass-a-implementation` ×2 across `b03aa795`/`b73c9f7b`, `pass-b-research`, `12-pass-b-result`, `12-research-findings`, `12-delimiter-extraction-impl`), confirm the no-op duplicate "saw work done" via git state not the store, investigate G4's double-write of `12-rereview-verdict` (1 s apart, mcp:30096/30098 — duplicate vs re-embed), and carry forward #11-B4's concurrency angle (does #12 have concurrent same-role siblings like #11's two Pass-A devs?). Likely verdict: the dataset's strongest evidence that the store *actively wasted* effort — the fix invocation re-derived everything from the PR diff because every record it needed was write-only in a foreign partition.
>
> **#12 done — prediction held in full, plus four resolutions.** The [#12 audit](research-qrm8-12-context-audit.md) confirmed the waste-case thesis exactly: **8 invocations** (index complete — no probes, no ENOSPC), **7 scoped searches all 0/0**, **1 agent get-all → 0**, and **11 writes, none read by any agent**. Every predicted record was RAW-recovered (the two `ticket-12-pass-a-implementation` copies survive in separate partitions — concurrency, not overwrite). The four open threads all closed: (1) the **fix invocation** (`e0728f86`, +12 h) ran an on-target get-all + conversation search for Pass A/B context that genuinely existed *and* for a dead-code finding already sitting in `12-project-notes`, got 0 everywhere, and re-derived `extractCommitMessage` from the PR diff (B2 — the keystone). (2) The no-op Pass-A duplicate (`b73c9f7b`) ran **concurrently** with the primary (overlapping 01:07–01:10) and "saw work done" via the primary's three pushed commits, not the store — #11-B4 reproduced developer-side (B3). (3) **G4 resolved**: the `12-rereview-verdict` double-embed is a write-path/periodic-backfill-sweep race (`embedding-pipeline.service.ts:76-83`) — one record (`updatedAt=null`), two Ollama embeds; benign, ~550 ms compute waste, low-priority/not filed (B5). (4) New surprise the prediction didn't anticipate: the bootstrap head was **frozen across all 8 invocations** (incl. the +12 h fix and the +2 d cross-session re-review) because `12-project-notes` is **617 tokens — oversized** — so it never entered a bootstrap, not even its own ticket's downstream invocations. This is the **third oversized specimen** (joining #31's 674, #11's ≈770), it sharpens [#55](https://github.com/ia64mail/quorum/issues/55) from "arbitrary order" to "arbitrary *and sticky against oversized writes*," and it pairs with #13-B1 to prove the head moves *only* when an under-budget note is written — a clean argument for [#56](https://github.com/ia64mail/quorum/issues/56) (`56-bootstrap-budget-sizing`, this branch): the teamlead's thorough review notes systematically overshoot the budget, so the more valuable the note, the less likely it is ever read (B1, B4).