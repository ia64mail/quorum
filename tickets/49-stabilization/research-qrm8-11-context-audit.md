# #11 Git Worktree Per Invocation — Context-Access Audit

**Date compiled:** 2026-06-12
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#11")
**Ticket:** `tickets/11-worktree-per-invocation.md` · **PR:** #38
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #11, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

> **Why this ticket matters.** #11 is the session's **richest specimen** — the central QRM8 deliverable, run as an 8-invocation pipeline (setup → architect design review → revise → two concurrent Pass-A developers + Pass-B → two concurrent reviews). It exercises **every** store channel the session has: project-scope search (5 queries across teamlead/moderator/architect), the session's single most-consumed record (`11-design-notes`, read **7×** by `mode=keys`), the session's **only** successful conversation-scope read (the moderator's `get-all`), three agent-scope research checkpoints (all unread), and ten writes across all three scopes. It is also the **consumer side** of the #14→#11 transfer that the [#14 audit](research-qrm8-14-context-audit.md) (B1) documented from the producer side: this audit shows `14-project-notes` was bootstrap **item #1 in all 8** #11 invocations and was the architect's L14 search hit, then propagated into `11-design-notes` and the shipped ticket. The verdict, in short: the store carried real signal on #11 — but every load-bearing cross-invocation transfer was **addressed by the moderator's prompt** (exact key or explicit correlationId), while every channel that depended on an agent *finding* knowledge on its own (semantic search for not-yet-written notes, agent-scope checkpoint re-reads) failed exactly as F1–F5 predict.

## Scope correction vs the index

The index lists **10** rows for #11 and the full log sweep (`grep 'Invocation received' logs/{teamlead,developer,architect}-20260524T003432.jsonl`) confirms the agent set is complete: **8 agent invocations** (teamlead ×4, developer ×3, architect ×1) plus **2 distinct moderator context actions** the index renders as two rows. No probes were missed. Three structural facts the index states but are worth foregrounding:

1. **The moderator acted on the store twice, separately:** at 17:55 it ran search L12 **and** a `get-all c5096d29` (E4/E5, before dispatching the architect); at 18:06 it ran a `mode=keys [11-design-notes]` read (E11, before dispatching the revise). These are two different moderator turns, not one.
2. **The two Pass-A developers ran concurrently in one container.** `43e6122e` (started 18:24:08, ran to the **turns=100 cap**, completed 18:33:33) and `cd2957eb` (started 18:26:59, completed 18:32:49) overlapped — `cd2957eb` started *after* and finished *before* `43e6122e`. The index labels `43e6122e` the "DUPLICATE (ran productively)" and `cd2957eb` "primary"; both did full research + writes, into **separate** agent/conversation partitions (B4). Their developer-log lines interleave — the authoritative partition assignment is the MCP-server `Embedded document [scope:id:key]` event, not the agent log (same caveat as #14).
3. **The two review invocations also forked from one dispatch.** `0430b72b` (18:37:41 → completed 18:48:53, wrote `11-project-notes`) and `07c58b95` (18:41:59 → **never completed — ENOSPC**, no completion line in the log) are a transport-retry double-dispatch of a single `/code-review` (same `wait_invocation` retry pattern as #14-B2 / #39). `07c58b95` still ran a full bootstrap + key-read (E34/E35) before dying.

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 17:40:00 → 17:47:40 | `c5096d29-78fa-4d5c-873a-b8273a3e0a8a` | teamlead / setup (PR #38) | `teamlead-20260524T003432.jsonl` | bootstrap **E1** · search **E2** (L11) · write **E3** |
| I2 | 17:55:03 → 17:55:04 | — (null in trace; moderator) | moderator / pre-architect pull | `b0b5645f…jsonl` | search **E4** (L12) · read get-all **E5** (→1, the one working conv read) |
| I3 | 17:56:57 → 18:02:01 | `b424f21d-3585-4e75-9447-6a1863f6d41e` | architect / design review | `architect-20260524T003432.jsonl` | bootstrap **E6** · searches **E7** (L13) **E8** (L14) **E9** (L15) · write **E10** (`project:_:11-design-notes`) |
| I4 | 18:06:42 | — (moderator) | moderator / pre-revise pull | `b0b5645f…jsonl` | read keys **E11** (→1) |
| I5 | 18:09:15 → 18:12:06 | `ecd11908-e863-4aae-82ea-4d964dd8ac5d` | teamlead / revise per design review | `teamlead-20260524T003432.jsonl` | bootstrap **E12** · read keys **E13** (→1) · write **E14** |
| I6 | 18:24:08 → 18:33:33 | `43e6122e-a3a1-4ede-bfd8-149dec530c8b` | developer / Pass A **DUPLICATE** (turns=100 cap) | `developer-20260524T003432.jsonl` | bootstrap **E15** · read keys **E16** (→1) · agent get-all **E17** (→0) · conv get-all **E18** (→0) · write **E19** (agent) · write **E20** (conv) |
| I7 | 18:26:59 → 18:32:49 | `cd2957eb-9526-469e-8b81-afab208df599` | developer / Pass A primary | `developer-20260524T003432.jsonl` | bootstrap **E21** · read keys **E22** (→1) · agent get-all **E23** (→0) · write **E24** (agent) · write **E25** (conv) |
| I8 | 18:33:24 → 18:37:10 | `649092c8-5fc2-47cf-a24f-43f14f95c2bc` | developer / Pass B (container infra) | `developer-20260524T003432.jsonl` | bootstrap **E26** · read keys **E27** (→1) · agent get-all **E28** (→0) · write **E29** (agent) · write **E30** (conv) |
| I9 | 18:37:41 → 18:48:53 | `0430b72b-f8f3-4d8f-904e-d503de6ea2db` | teamlead / `/code-review` (path-traversal advisory) | `teamlead-20260524T003432.jsonl` | bootstrap **E31** · read keys **E32** (→1) · write **E33** (`project:_:11-project-notes`) |
| I10 | 18:41:59 → **(ENOSPC, no completion)** | `07c58b95-6130-49b6-813c-7c2ab507badd` | teamlead / `/code-review` **FAILED DUPLICATE** | `teamlead-20260524T003432.jsonl` | bootstrap **E34** · read keys **E35** (→1) |

**Versions.** All ten writes are single-version (no `updatedAt`; verified — OpenSearch returns one record per key, none with overwrite markers). Unlike #31 (v1→v2 overwrite, B3), `11-project-notes` records the *accepted, post-fix* state from its only write at I9 18:48:40 — no premature-then-superseded copy. Every RAW render below is verbatim-complete.

**Carried in from the #14 audit (B1).** The #14 audit documented `14-project-notes` reaching the #11 architect via bootstrap + L14 search and propagating into `11-design-notes`. This audit **closes that transfer from the consumer side** and extends it: `14-project-notes` was bootstrap **item #1 in all 8** #11 invocations, not only the architect's (B1 below).

---

## Data recovery method

Same toolkit as the #31/#17/#16/#14 audits. RAW write bodies recovered by querying the running `quorum-opensearch-1` container (data volume intact) with the embedding vector excluded:

```bash
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=30' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["11-ticket-setup","11-design-notes","11-ticket-revision",
       "11-research-checkpoint","11-implementation-decisions","11-pass-a-research",
       "11-pass-a-implementation","11-passB-research","11-passB-implementation","11-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'
```

All ten documents returned complete bodies plus `createdAt`/`createdBy`/`scope`/`id`. Bootstrap item *keys and full text* (gap G2) recovered from each role log's `=== Initial prompt for correlationId=… ===` debug line, which embeds the rendered `## Prior Decisions` block verbatim — done for **all 8** invocations (they are byte-identical; see E1). Search traces (full 100-hit scored arrays) from `context-search-20260524T003426.jsonl` by `queryId`. The moderator's two context actions (E4/E5/E11) were recovered from the raw CC CLI session log `b0b5645f…jsonl` (the trace stream logs them with `callerRole=null`, gap G1) and cross-checked against the MCP-server `context_query:` summary lines, which carry the returned item counts. `createdAt` epochs were anchored to the `11-design-notes` embed log line (`mcp-server…:2949` = `2026-05-24T18:01:46Z` ↔ `createdAt 1779645705685`) and used to time every write to the second — all ten land just before their invocation's completion line, confirming the partition assignments.

---

## Chronological access-point audit

### E1 — Bootstrap injection, setup (I1, 17:40:00) — and the identical head across all 8 invocations

`BootstrapContextService` assembled **4 items, ≈589 tokens, scopes=[project, conversation]** (`mcp:2658`). The conversation leg was empty (fresh `c5096d29`), so all 4 are project scope. **The same 4-item head was injected byte-identically into every one of the 8 #11 invocations** (E1/E6/E12/E15/E21/E26/E31/E34 — verified via each invocation's initial-prompt block); the project head never moved across the entire #11 window (17:40 → 18:42, ~62 min). Rendered:

```
## Prior Decisions

### Project Context
- 14-project-notes: "PR #36 code review accepted for ticket #14 (moderator becomes standalone git
  client). Two-comment review protocol completed: (1) Initial /code-review skill found a volume-seed
  bug — the Dockerfile moderator stage ran mkdir -p /mnt/quorum/workspace/.claude at build time,
  causing Docker to seed the named volume with non-empty content that made git clone fail on first
  boot. (2) Developer applied fix commit 752b95a (Option D) … (6) Pattern note: when adding
  directories under a Docker volume mount point, be aware Docker seeds empty named volumes from image
  layers — build-time directories at mount points will appear in the volume and can break tools
  expecting an empty directory."                                                      [≈345 tok]
- draft-pr-based-workflow-bootstrap-design-notes: "PR-based workflow bootstrap ticket drafted …
  (1) gh CLI is NOT installed in either the moderator or agent Dockerfile stages … (7) Step 1
  (GH_TOKEN) must land first so the moderator gets gh auth on rebuild."               [≈222 tok]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                   [≈12 tok]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                         [≈10 tok]
```

**Quality feedback:**
- **Quality: for once, the bootstrap head is genuinely on-topic — item #1 is the single most relevant project-note that existed for #11.** `14-project-notes` item (6) is the Docker-volume-seeding pattern that #11 must obey (the ticket's section 4 "Volume-seed bug warning (from #14)" and section 6 "CRITICAL: Do NOT create any sub-content inside `/var/agent-repo/`" are the direct application). This is the **only** session bootstrap where the freshest-note slot landed on a record the ticket actually needed — the same arbitrary-`getAll` luck mechanism (index B1 / #55) that usually surfaces noise here surfaced the right note, because `14-project-notes` (345 tok, written 17:19, ~20 min before setup) was both fresh *and* small enough for the 600-token project budget (#56). `draft-pr-…` is a faint adjacency (gh/clone wiring); the two QRM6 elicitation strings are the usual month-old residue (2/4 slots noise, as everywhere).
- **Re-usability: delivery channel, with one proven consumer.** Of the 8 invocations that received this head, the **architect (E6) is the confirmed consumer** — it also retrieved `14-project-notes` by semantic search (E8/L14) and wrote its lesson into `11-design-notes` (B1). For the other 7, `14-project-notes` was *available* in-context; the volume-seed warning reached the shipped ticket through the architect→design-notes→revise chain rather than provably from each bootstrap. The setup/revise/dev/review agents otherwise ran off the ticket file + moderator prompt + worktree.
- **Added value beyond `docs/`+`tickets/`: moderate (item #1), zero (rest).** `14-project-notes` item (6)'s generalized pattern is store-unique knowledge that the ticket's own author needed — real value. The remaining 3 items added nothing.

### E2 — Search L11, project scope (I1, 17:40:?) — `queryId a17ea4b7`

The setup teamlead's retrieval: `context_query{scope:project, mode:search, query:"worktree invocation ticket 11 agent repository infrastructure"}`. Hybrid, `maxTokens=2000`, 100 raw → **4 returned**, `truncatedByTokenBudget=true`:

```
1.00   ✓ QRM8-direction-workspace-isolation   194 tok
0.7908 ✓ QRM4-BUG-015-project-notes           358
0.6188 ✓ QRM4-004-design-notes                583
0.5747 ✓ 29-project-notes                     428
---- cut (budget: 194+358+583+428 = 1,563; rank-5 QRM7-001-design-notes 633 → 2,196 > 2,000) ----
0.5538   QRM7-001-design-notes                633
0.5528   qrm7-015-redesign-complete           241   … (96 more, all includedInResult=false)
```

**Quality feedback:**
- **Quality: the #1 hit is a bullseye; the rest is milestone-process filler.** `QRM8-direction-workspace-isolation` (1.00) is, verbatim, #11's entire design at the milestone level — *"workspace isolation via `git worktree` per invocation … each invocation creates a worktree at /var/agent-worktrees/<correlationId> … Branch passed via InvokeRequest. Commit/push happens in the InvocationHandler, not inside the SDK loop."* That is the spec the teamlead was about to write. Rank-2 `QRM4-BUG-015-project-notes` (0.79) is mostly off-topic (commit-message convention) with one genuinely adjacent line ("Post-invocation uncommitted changes check in InvocationHandler") — the `checkUncommittedChanges` keyword pulled it; moderate relevance. `QRM4-004-design-notes` and `29-project-notes` are weak neighbors (no `11-*` record existed yet — this is the setup).
- **Re-usability: corroborating, not load-bearing.** The teamlead's draft correctly frames #11 against the D1 worktree design and the section structure mirrors `QRM8-direction-workspace-isolation` — but that record's content is also in `tickets/8-workspace-isolation.md`, which the teamlead read directly. The search confirmed the direction was already synthesized in the store.
- **Added value beyond `docs/`+`tickets/`: low-moderate.** `QRM8-direction-workspace-isolation` is a store-only milestone-direction record (not a ticket file) — surfacing it is real but its content duplicates the roadmap the teamlead opened anyway.

### E3 — Write `conversation:c5096d29…:11-ticket-setup` (I1, 17:47:27)

The setup completion record, 912 chars (`createdBy=teamlead`). RAW (complete):

```
Ticket #11 (Git Worktree Per Invocation) setup complete. Ticket file at
tickets/11-worktree-per-invocation.md. Branch 11-worktree-per-invocation off
8-workspace-isolation-staging. PR #38 opened with Resolves two-step retarget (main -> staging).
Commit a828b38. 15 acceptance criteria covering: schema change (branch required field + MCP tool),
cwd parameterization, worktree lifecycle (fetch/add/execute/remove), entrypoint extension (clone +
prune + plugin path update), Dockerfile mount points (empty dirs, volume-seed prevention),
docker-compose (bind mount removal, named volumes, tmpfs), config semantics, E2E validation. Key
design decisions: tmpfs for worktrees (self-healing orphan cleanup), entrypoint reordering (clone
before plugin seed), plugin path migration. Architect review strongly recommended -- non-trivial SDK
surface changes, volume layout decisions, Docker infrastructure across 4 services.
```

**Quality feedback:**
- **Quality: accurate, decision-flavored, and — uniquely — actually consumed (via the moderator, E5).** The "15 acceptance criteria" count is the pre-revision number (the architect's blocker + refinements bumped it to 19, E14). The "Architect review strongly recommended" closing sentence is the operative datum: it is the **only** part of this record that left the partition.
- **Re-usability: this is the session's ONE working conversation-scope read — but via the moderator, not an agent (B3).** The moderator's `get-all c5096d29` (E5) pulled this record and **quoted its closing phrase verbatim into the architect's dispatch** (see E5). No agent ever read it (the architect/dev invocations key their own correlationIds; F1). So the record was re-used exactly once, through the one actor that can address an arbitrary conversation partition.
- **Added value beyond `docs/`+`tickets/`: moderate via the propagated phrase.** The AC list and design-decision summary duplicate the ticket; the store-unique, *consumed* value is the review-recommendation flag that got the architect engaged on the right surfaces.

### E4 — Search L12, project scope (I2, moderator, 17:55:03) — `queryId 4dc2d8a0`

The moderator's pre-architect retrieval: `query:"ticket 11 worktree per invocation agent repo infrastructure"` (near-identical to E2/L11). Trace logs `callerRole=null` (G1); recovered as moderator from `b0b5645f…jsonl`. 100 raw → **6 returned**, truncated:

```
0.9435 ✓ QRM8-direction-workspace-isolation   194
0.7350 ✓ QRM4-BUG-015-project-notes           358
0.7118 ✓ qrm7-015-redesign-complete           241
0.6911 ✓ QRM4-004-design-notes                583
0.6485 ✓ qrm7-017-session-intent              177
0.5850 ✓ qrm7-017-project-notes               310
```

**Quality feedback:**
- **Quality: same head as E2 (workspace-isolation direction at the top), with a different mid-tail** (`qrm7-015/017` records surface here, `29-project-notes` drops below cut) — concrete evidence that the same query at a different moment returns a near-static head but a reshuffled tail (the k-NN k-cap matches everything; index F4). Nothing #11-specific that the moderator didn't already know.
- **Re-usability: nil — the moderator did not act on these hits.** The moderator's *actionable* pull this turn was E5 (the get-all), not this search. The search was a redundant "what's in the store about #11" probe; it found only the milestone-direction cluster the moderator had itself written.
- **Added value: zero.** Duplicate of E2's value, consumed by no one.

### E5 — Read `conversation get-all id=c5096d29…` → **1 item** (I2, moderator, 17:55:04) — the one working conversation read

`context_query{scope:conversation, mode:get-all, correlationId:"c5096d29…"}` → **1 item** (`mcp:2844`): the teamlead's `11-ticket-setup` (E3). The moderator passed the *prior* invocation's correlationId explicitly — the only way to reach a foreign conversation partition.

**Quality feedback:**
- **Quality: a clean, deliberate cross-invocation handoff — and it propagated.** Two minutes later the architect's dispatch (E6 task block) reads: *"The team lead has drafted the spec and explicitly flagged it for your review: 'non-trivial SDK surface changes, volume layout decisions, Docker infrastructure across 4 services.'"* — a **verbatim** quote of `11-ticket-setup`'s closing sentence. The moderator pulled the setup note (E5) and inlined its review-recommendation into the architect prompt.
- **Re-usability: HIGH for this specific datum, and structurally unique.** This is the session's **only** conversation-scope read that returned data *and* drove a downstream effect (index F1 noted the read returned 1 item; this audit establishes the propagation). It works only because the moderator holds prior correlationIds and `get-all` accepts an explicit `id` — the mechanism agents lack (F1). See B3.
- **Added value beyond `docs/`+`tickets/`: real but small.** The quoted flag is store-sourced, but it is a one-sentence review-routing hint, not deep knowledge — the architect would likely have reviewed the SDK surface regardless. Still, it is a genuine instance of the conversation scope doing its intended job, once, under moderator orchestration.

### E6 — Bootstrap injection, architect (I3, 17:56:57)

**4 items, ≈589 tokens** (`mcp:2874`) — **identical head to E1**, `14-project-notes` as item #1. This is the bootstrap channel of the #14→#11 transfer: `14-project-notes` arrived here *and* was independently re-found by search at E8. (#14 audit B1 recovered this same block.)

**Quality feedback:** same content as E1. **Re-usability HIGH for item #1** — the architect is the proven consumer (E8/E10/B1). Note the structural point: the architect was reviewing #11's design and the most useful possible bootstrap record (a prior worktree/volume note) *did* land as item #1 — the first time in the session the bootstrap head matched the task by more than luck-of-the-tail. Added value: moderate (item #1), zero (rest).

### E7 — Search L13, project scope (I3, architect) — `queryId af79231b` — the "design notes that didn't exist yet" specimen

`query:"ticket 11 worktree design notes"`. 100 raw → **1 returned**, truncated:

```
0.8427 ✓ QRM4-BUG-009-project-notes           414
---- cut: rank-2 QRM5-005-design-notes is 1,879 tok → 414+1,879 = 2,293 > 2,000 ----
0.8358   QRM5-005-design-notes                1879
0.7409   QRM8-001-design-notes                185   ← relevant, starved
0.7136   QRM4-004-design-notes                583   ← relevant, starved
0.4876   QRM8-direction-workspace-isolation   194   ← the bullseye, ranked 16th here
```

**Quality feedback:**
- **Quality: a double failure mode in one query.** (a) The architect searched for `11-design-notes` **before writing it** (the record is created 5 min later at E10) — index F5's inverse specimen, now concrete. (b) The lone returned hit, `QRM4-BUG-009-project-notes` (0.84), is *meta*-relevant but not *content*-relevant: it describes the **convention** of architects writing `{ticket-id}-design-notes` ("Architect reviews each ticket before implementation and stores project-scope design notes") — i.e. the search for "worktree design notes" returned the note that *defines design-note-writing*, not any worktree design. There is no "nothing relevant" floor: min-max normalization forces the top hit to 0.84-of-1.00 (F4), so the architect had no signal that this was a process note rather than substance.
- **The sharper finding (B2): a single oversized rank-2 doc collapsed the result to 1 item and starved 3 genuinely relevant ones.** `QRM5-005-design-notes` (1,879 tok) at rank 2 alone breaches the 2,000-token budget, so `applyBudget` cut everything after rank 1 — hiding `QRM8-001-design-notes` (0.74), `QRM4-004-design-notes` (0.71), and the actual bullseye `QRM8-direction-workspace-isolation` (which the *same architect's* L14 query ranks 1.00). The budget, not relevance, decided the architect saw one process note instead of three design notes (F4, concretized).
- **Re-usability: nil.** The architect wrote its design from the ticket spec + its own analysis, not from `QRM4-BUG-009`. The query returned nothing it used.
- **Added value: zero / mildly negative** — one off-target hit, three relevant hits suppressed by budget packing.

### E8 — Search L14, project scope (I3, architect) — `queryId 7fbd3ee1` — the #14→#11 consumer hit

`query:"worktree tmpfs volume agent repository clone"` (no ticket number, no "moderator" — a pure-semantic phrasing). 100 raw → **5 returned**, truncated:

```
1.00   ✓ QRM8-direction-workspace-isolation   194
0.7019 ✓ QRM8-memory-policy                    269
0.6712 ✓ 14-project-notes                      345   ← the #14→#11 transfer
0.6579 ✓ 16-project-notes                      313
0.6502 ✓ session-resume-fix-options            661
```

**Quality feedback:**
- **Quality: the session's cleanest genuine k-NN win.** The query carries no ticket number and no key-name tokens, so BM25 contributes little — the `14-project-notes` hit at rank 3 (0.67) is semantic neighborhood (volume/mount-content adjacency), exactly index-F7's prized category. `QRM8-direction-workspace-isolation` tops it again (1.00); `16-project-notes` (the agent-memory note) and `session-resume-fix-options` are weaker neighbors.
- **Re-usability: HIGH — this is the producer-confirmed #14→#11 reuse, seen from the consumer.** `14-project-notes` (0.67, `includedInResult=true`) was read here *and* delivered via bootstrap (E6), and its volume-seed pattern was then written into `11-design-notes` as a named, acted-upon constraint (E10: *"Volume-seed bug prevention (from #14) … Check `14-project-notes` in context store"*). The #14 dispatch never named #14 or its key (verified, `b0b5645f…jsonl`) — so this was discovery-by-neighborhood, **not** moderator-orchestrated, the one un-prompted cross-ticket retrieval that worked. (See #14-B1; this audit is its consumer-side closure.)
- **Added value beyond `docs/`+`tickets/`: high.** `14-project-notes` item (6) is store-unique knowledge (the generalized Docker-volume-seeding lesson, not in any ticket file at search time) that materially shaped #11's Dockerfile/entrypoint design.

### E9 — Search L15, project scope (I3, architect) — `queryId fcddb03a`

`query:"draft PR workflow bootstrap gh CLI installation"`. 100 raw → **6 returned**, truncated:

```
1.00   ✓ draft-pr-based-workflow-bootstrap-design-notes   222
0.5424 ✓ 20-followup-project-notes                         356
0.4191 ✓ QRM8-git-auth-decision                            226
0.3945 ✓ 27-project-notes                                  348
0.3451 ✓ 15-project-notes                                  389
0.3244 ✓ 29-project-notes                                  428
```

**Quality feedback:**
- **Quality: a focused, correct lookup of the gh-auth/clone lineage #11's entrypoint builds on.** The top hit is the draft-PR bootstrap note (also bootstrap item #2 everywhere); the cluster (`27`/`15`/`29`/`QRM8-git-auth-decision`) is precisely the credential-bootstrap chain the agent entrypoint's `git clone` depends on (#15 gh auth → #29 plugin seed → #11 clone). A deliberate adjacent-lineage query, like #14's L5.
- **Re-usability: corroborating.** The architect's DECISION 4 (entrypoint ordering) and the "PATTERNS TO REUSE → Capture-unset-pipe pattern for GH_TOKEN (from #27)" line in `11-design-notes` reflect this cluster — though the architect also read `entrypoint.sh` directly.
- **Added value beyond `docs/`+`tickets/`: moderate.** `QRM8-git-auth-decision` and the draft-PR note are store-only; the `{15,27,29}-project-notes` restate ticket files.

### E10 — Write `project:_:11-design-notes` (I3, 18:01:46) — the central record of the ticket

The architect's design review, **8,098 chars (~2,000 tokens)** — the single largest write of the session (`createdBy=architect`). RAW (key sections; full body in OpenSearch):

```
Architect design review for ticket #11 (Git Worktree Per Invocation). Reviewed 2026-05-24.
Overall: APPROVED with one blocking fix and two recommended refinements.

BLOCKING — Default-branch worktree conflict: … A regular clone checks out the default branch
(main). `git worktree add ... main` then fails with "fatal: 'main' is already checked out at
'/var/agent-repo'". … Fix: add `git checkout --detach` in the entrypoint immediately after the
first-boot clone. …

DECISION 1 — tmpfs for worktrees: APPROVED. The self-healing property is decisive. …
DECISION 2 — cwd parameterization via ExecuteParams: APPROVED. … update `checkUncommittedChanges()`
  in InvocationHandler (line 220) to accept the worktree path as a parameter …
DECISION 3 — Per-role named volumes: APPROVED. …
DECISION 4 — Entrypoint ordering: APPROVED with refinement. … Add `cd /var/agent-repo &&
  git checkout --detach && cd /app` immediately after the clone block …
DECISION 5 — Plugin scope under worktrees: REFINEMENT RECOMMENDED. … change … to `scope: "global"` …
DECISION 6 — Error handling for git worktree add: APPROVED. …
DECISION 7 — Moderator-side ramifications: IN SCOPE, NO SPLIT NEEDED. …
ADDITIONAL CONCERN — node_modules availability in worktrees: … Recommend option (b) … the PATH line
  should either be updated … or removed entirely. …

PATTERNS TO REUSE:
- Volume-seed bug prevention (from #14): Dockerfile must only create empty mount-point dirs at
  `/var/agent-repo/` and `/var/agent-worktrees/`. NO sub-content. Check `14-project-notes` in context store.
- Capture-unset-pipe pattern for GH_TOKEN (from #27): already in entrypoint.sh. Don't touch this block.
- SDK env allowlist (from #15): already in claude-code.service.ts. …

INTEGRATION POINTS:
- invoke.types.ts: Add `branch: z.string().min(1, "branch is required")` …
- mcp.service.ts ~line 282: Add `branch` to invoke_agent tool inputSchema … construction at ~line 368.
- claude-code.service.ts line 131: Change `cwd: this.config.agent.workspaceDir` to
  `cwd: params.cwd ?? this.config.agent.workspaceDir`.
- agent.config.ts line 14: Change default from '/mnt/quorum/workspace' to '/var/agent-repo'. …
CONSTRAINTS: Do NOT touch checkUncommittedChanges() beyond updating its cwd … Do NOT add
  branch-in-flight guard (#13) … Do NOT modify moderator container (#14) … Do NOT touch
  role-tool-profiles.ts (#12). …
```

**Quality feedback — checked against the shipped code:**
- **Accuracy: verified high, line-precise.** Every integration-point line number matches the current tree: `claude-code.service.ts:131` is exactly `cwd: params.cwd ?? this.config.agent.workspaceDir`; `agent.config.ts:14` defaults to `/var/agent-repo`; `ExecuteParams.cwd` exists (`claude-code.types.ts:17`); `invoke.types.ts` has `branch: z.string()…min(1, 'branch is required …')`. The BLOCKING fix shipped verbatim — `docker/agent/entrypoint.sh:49` is `cd /var/agent-repo && git checkout --detach && cd /app`; plugin `scope: "global"` at `:72`; `worktree prune` at `:90`. The ticket's Implementation Notes record "Deviations: None." This is the most accurate, most operational write in the session.
- **Re-usability: the session's most-consumed record, by a wide margin — but 100% addressed by the moderator's prompt (B2).** `11-design-notes` was read **7×** by `mode=keys [11-design-notes]`: moderator (E11), revise (E13), Pass-A-dup (E16), Pass-A-primary (E22), Pass-B (E27), review (E32), review-ENOSPC (E35). Every consuming prompt contains the literal instruction `context_query(scope='project', mode='keys', keys=['11-design-notes'])` — the moderator embedded the key in each dispatch. The exact-key channel works flawlessly (project scope is a global address, `id=_`); contrast the architect's own *unprompted* search for the same notes (E7/L13), which failed. #11 thus contains both the success and the failure of the same addressing problem side-by-side: **prompted exact-key handoff succeeds 7/7; unprompted semantic search for the same record fails.**
- **Added value beyond `docs/`+`tickets/`: high at write time, then folded into the ticket.** At E10, the design notes carried decisions (the `git checkout --detach` blocker, plugin-scope global, PATH removal) that the ticket spec did **not** yet contain — they were the architect's net-new contribution. The revise step (E14) then wrote them *into* the ticket file. So `11-design-notes` is the rare store record that was both store-unique **and** load-bearing: it was the transport for the architect→teamlead→ticket flow. After E14, its content also lives in the ticket — but the store copy is what carried it there, read 7× along the way.

### E11 / E13 / E16 / E22 / E27 / E32 / E35 — Read `mode=keys [11-design-notes]` → 1 item (×7)

The seven exact-key reads of `11-design-notes`, all returning the single project record (E10), all moderator-prompted:

```
E11  18:06:42  moderator   (mcp:3002)   before dispatching the revise
E13  18:09:25  teamlead    (mcp:3031)   revise — applies the blocker + 2 refinements
E16  18:24:16  developer   (mcp:3182)   Pass A dup
E22  18:27:07  developer   (mcp:3241)   Pass A primary
E27  18:33:31  developer   (mcp:3357)   Pass B
E32  18:37:50  teamlead    (mcp:3439)   review
E35  18:42:09  teamlead    (mcp:3515)   review (ENOSPC dup — still read before dying)
```

**Quality feedback:**
- **Quality of the channel: perfect — 7/7 hits, exact content, zero ambiguity.** This is index F3's purest specimen and the strongest single argument in the dataset for **stable-address retrieval over semantic search**. The record is large (~2,000 tok) and authoritative; the agents that needed it got it deterministically because the key was handed to them.
- **Re-usability: maximal, and visibly acted on.** The revise (E13→E14) applied all three architect items and bumped the AC count 14→19; both Pass-A developers and Pass-B implemented the `git checkout --detach`/global-scope/PATH decisions; the review verified them. Every consumer used the content.
- **Added value beyond `docs/`+`tickets/`: high until E14, declining after.** Before the revise folded the design into the ticket (E14), `11-design-notes` was the *only* place the architect's decisions lived — so E11/E13 consumed genuinely store-unique knowledge. After E14, the same decisions are in the ticket file the dev/review invocations also read, so E16/E22/E27/E32/E35 increasingly duplicated the ticket — but the key-read was still the cheapest, most authoritative path to them, and avoided re-reading the architect's reasoning from a diff. **Caveat (B5):** E35 is the ENOSPC-doomed duplicate review — it paid a full bootstrap + key-read for an invocation that produced nothing.

### E12 / E15 / E21 / E26 / E31 / E34 — Bootstrap injections, the remaining 6 invocations

Each **4 items, ≈589 tokens** (`mcp:3030, 3177, 3240, 3356, 3438, 3507`) — **identical head to E1/E6**, `14-project-notes` #1. The head was static for the whole 62-min window. Delivery-only; the consuming knowledge for these invocations came from `11-design-notes` (key-read) + the ticket + worktree, not the bootstrap. As everywhere, the notable absence at the review bootstraps (E31/E34) is `11-project-notes` itself — written *by* I9 at 18:48, after its own bootstrap, so the review of #11 is injected with last-ticket's `14-project-notes` instead. Added value: moderate (item #1 carried #14's pattern into-context), zero (rest).

### E14 — Write `conversation:ecd11908…:11-ticket-revision` (I5, 18:11:55)

The revise completion record, 1,437 chars (`createdBy=teamlead`). RAW (complete):

```
Ticket #11 revised per architect design review (commit eeeef66, branch 11-worktree-per-invocation,
PR #38). Three categories of changes applied:

BLOCKER FIX — Default-branch worktree conflict: Added `git checkout --detach` step in entrypoint
immediately after clone. … New AC added. Entrypoint order updated to 7 steps (was 6).
REFINEMENT 1 — Plugin scope: Changed from `scope: "project"` … to `scope: "global"` … PLUGIN_SRC
updated to `/var/agent-repo/docker/plugins/code-review`. Two new ACs added. …
REFINEMENT 2 — PATH removal: Decision made to REMOVE `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"`
entirely … New AC added. …
OTHER ABSORBED NOTES: (1) checkUncommittedChanges() AC made explicit … (2) MCP server line refs made
explicit … (3) tmpfs size=1g already present … AC count went from 14 to 19.
```

**Quality feedback:**
- **Quality: accurate change-log of the architect→ticket fold.** It is the receipt proving E10/E13 were consumed and applied (AC 14→19, commit `eeeef66`). Store-unique datum: the revision commit SHA.
- **Re-usability: zero — dead-end partition `conversation:ecd11908…`.** Never read (F1). The downstream consumers (the developers) read the *revised ticket* and `11-design-notes`, not this record.
- **Added value beyond `docs/`+`tickets/`: thin.** The change categories are visible in the ticket's git history (`git show eeeef66`) and its updated AC list.

### E17 / E18 / E23 / E28 — Agent/conversation get-all → 0 (the dev start-of-task reflex)

Four zero-return reads at the developers' task starts:

```
E17  18:24:16  43e6122e  agent         get-all → 0   (mcp:3185)
E18  18:24:16  43e6122e  conversation  get-all → 0   (mcp:3188)
E23  18:27:07  cd2957eb  agent         get-all → 0   (mcp:3244)
E28  18:33:31  649092c8  agent         get-all → 0   (mcp:3360)
```

**Quality feedback:**
- **Quality of the queries: the prescribed "check for prior research" reflex (D7 agent-memory policy), structurally empty by construction.** Each reads its own fresh correlationId partition (F1/F2). **E23 is the sharpest specimen in the session (B4):** `cd2957eb`'s agent get-all at 18:27:07 returned 0 even though `43e6122e`'s `11-research-checkpoint` (E19) had been written 2m11s earlier at **18:24:56** — a same-ticket, same-role (both developer), *concurrently running* sibling's checkpoint, existing and fresh, but unreachable because agent scope keys on the per-invocation correlationId with no role dimension.
- **Re-usability: nil by construction.** **Added value: negative** — round-trips retrieving nothing, while the data the policy wanted existed in a sibling partition.

### E19 / E24 / E29 — Agent-scope research checkpoints (3 writes, 0 reads)

The three agent-scope checkpoints — index F2's #11 instances. RAW:

**E19 `agent:43e6122e…:11-research-checkpoint`** (Pass-A dup, 18:24:56, 980 chars) — the most detailed of the three, a full file+line inventory:
```
Pass A research complete. All 7 source files and 4 spec files read. Key findings: (1) invoke.types.ts
invokeRequestSchema at line 68 needs branch field. (2) mcp.service.ts invoke_agent inputSchema at
~L282 … (5) invocation-handler.service.ts runInvocation() at L94 needs worktree lifecycle … (7) Test
files: invocation-handler.service.spec.ts baseRequest at L34 … claude-code.service.spec.ts … L322 …
```
**E24 `agent:cd2957eb…:11-pass-a-research`** (Pass-A primary, 18:28:08, 593 chars):
```
Research complete for ticket #11 Pass A. Units 1+2 (branch field …) are already implemented in working
tree but not committed. Files modified: invoke.types.ts … mcp.service.ts … mcp.service.spec.ts (16
tests updated …) … Units 3-7 still need implementation. On branch 11-worktree-per-invocation.
```
**E29 `agent:649092c8…:11-passB-research`** (Pass-B, 18:34:00, 665 chars):
```
Pass B research complete. … Files to modify: (1) docker/agent/entrypoint.sh — add clone+detach+
worktree-prune … (2) docker-compose.yml … (3) Dockerfile agent stage … Architect blocker: git
checkout --detach after clone on every boot. Plugin scope: global not project. PATH: remove entirely.
```

**Quality feedback:**
- **Quality: genuinely useful episodic checkpoints — exactly what the D7 policy wants captured** (E19 especially: a line-precise modification map). All three are accurate against the shipped commits.
- **Re-usability: zero — and #11 is F2's worst case (B4).** E19 and E24 are **two independent researches of the identical Pass-A surface**, produced concurrently because the moderator's transport-retry spawned two Pass-A developers; neither could see the other's checkpoint (different agent partitions), so the same 7-file/spec inventory was derived twice in parallel. None of the three checkpoints was ever read (the only realistic consumers — the next Pass / the review — query their own partitions). The `agent:<correlationId>:*` addressing makes role-continuity impossible (#16-B2, issue #59).
- **Added value beyond `docs/`+`tickets/`: thin and moot** — the content restates the ticket's Implementation Details; its only value would have been retry/continuation resumption, which the addressing model precludes. E19's effort was almost entirely redundant with E24.

### E20 / E25 / E30 — Conversation-scope implementation records (3 writes, 0 reads)

The three implementation records, all `createdBy=developer`, all into dead-end conversation partitions:

**E20 `conversation:43e6122e…:11-implementation-decisions`** (18:33:18, 972 chars) — Pass-A-dup's decision log (WORKTREE_BASE constant, deterministic `/var/agent-worktrees/<correlationId>` path, fail-before-execute on fetch/add errors, `checkUncommittedChanges` optional cwd). **E25 `conversation:cd2957eb…:11-pass-a-implementation`** (18:32:39, 1,599 chars) — Pass-A-primary's 5-commit log with SHAs (`c4063db`/`2353884`/`35a4bf7`/`67c52b1`/`c697493`) and per-commit detail. **E30 `conversation:649092c8…:11-passB-implementation`** (18:36:57, 1,195 chars) — Pass-B's 4-commit log (`462ba78`/`f1e288f`/`6c84adc`/`ca537d4`).

**Quality feedback:**
- **Quality: accurate, code-verified, SHA-bearing.** E25's five Pass-A SHAs and E30's four Pass-B SHAs match the ticket's Implementation Notes commit tables exactly; all claims (branch field required, worktree lifecycle, global plugin scope, PATH removal, "46 suites, 798 tests") check out against the tree.
- **Re-usability: zero — three dead-end partitions.** E20 and E25 again document the *same* Pass A from two concurrent invocations (B4); the review (I9) ran no conversation search and is in a different partition regardless. None read (F1).
- **Added value beyond `docs/`+`tickets/`: thin** — the commit SHAs are the only store-unique data; everything else is in the ticket's Implementation Notes (which these writes fed) and `git log`.

### E33 — Write `project:_:11-project-notes` (I9, 18:48:40)

The review verdict synthesis, 3,077 chars (~770 tokens), `createdBy=teamlead`. RAW (key parts):

```
PR #38 code review accepted for ticket #11 (Git Worktree Per Invocation + Agent-Side Repository
Infrastructure). Two-comment review protocol completed on PR #38.

Patterns established:
(1) Worktree-per-invocation lifecycle in InvocationHandler.runInvocation(): git fetch origin →
git worktree add /var/agent-worktrees/<correlationId> <branch> → execute({cwd: worktreePath}) →
git worktree remove --force in finally block. … File: apps/agent/src/connection/invocation-handler.service.ts.
(2) ExecuteParams.cwd parameterization … `params.cwd ?? this.config.agent.workspaceDir` …
(3) Agent entrypoint boot sequence: gh auth → mkdir debug → git clone (first-boot idempotent) →
git checkout --detach … → plugin seed (global scope …) → git worktree prune … → exec node.
(4) Per-role named volumes … Worktrees on tmpfs at /var/agent-worktrees (1g, self-healing …).
(5) Plugin scope changed from "project" to "global" …

Integration points created:
- InvokeRequest.branch is now a required field … This unblocks #13 …
- agent.config.workspaceDir now semantically means "base repo clone path" …
- REPO_URL env var added to x-shared-env …
- Workspace bind mount removed from all agent services …

Test coverage: 798 tests across 46 suites. …
Dependency graph: #11 is now complete. Unblocked: #12 …, #13 …

Advisory note from code review: correlationId is used as a filesystem path component
(/var/agent-worktrees/<correlationId>) without UUID format validation. Currently safe because callers
are internal … Recommend follow-up hardening ticket to add z.string().uuid() validation on
correlationId in the invoke_agent tool schema and/or shell-escape values in execAsync calls.
```

**Quality feedback — checked against the shipped code:**
- **Accuracy: verified high, no defects.** Every pattern matches the tree (worktree lifecycle in `invocation-handler.service.ts`; `cwd: params.cwd ?? …` at `claude-code.service.ts:131`; entrypoint sequence at `docker/agent/entrypoint.sh:49/60/72/90`; per-role volumes + tmpfs in `docker-compose.yml`; `branch` required in `invoke.types.ts`). Like #14's E19 and unlike #16's E7, there is **no factual error**. Single-version, no premature-then-superseded copy (contrast #31-B3).
- **Re-usability: zero to date — never read through end of coverage (05-28).** No search, key-read, or get touched `11-project-notes` after this write. It can ride a bootstrap (~770 tok > the 600 project budget → in fact it **cannot**; #56/B2 applies — it is too large to bootstrap), and its only realistic future consumer is a later ticket's semantic search landing on it as a worktree/lifecycle neighbor (the channel that worked for #14→#11).
- **Added value beyond `docs/`+`tickets/`: moderate, with one travelling — and since-resolved — datum.** Patterns (1)–(5) condense the ticket; the store-unique, *consequential* content is the **advisory note** — the correlationId path-traversal / shell-injection concern. That advisory did **not** sit idle: it became **ticket #39** ("Harden correlationId — UUID validation and shell-safe worktree paths"), whose Problem Statement cites PR #38's review-comment URLs directly, and **#39 has since been resolved** (839 tests / 47 suites). The fix is live in the tree: `correlationId` is now `z.string().uuid()` at both schema sites (`invoke.types.ts:70`, `mcp.service.ts:311`), and the worktree `git` commands use `execFileAsync` with an argv array — `invocation-handler.service.ts:119` is `execFileAsync('git', ['worktree','add', worktreePath, request.branch], …)`, `:220` the matching `remove --force`. The path string at `:101` (`${WORKTREE_BASE}/${request.correlationId}`) is still interpolated, but `correlationId` is now UUID-guarded upstream, so `../` traversal is structurally impossible. The point for the research stands and is in fact stronger: the actionable knowledge propagated to *resolution* via the **PR comment → ticket → fix** pipeline, while the store's own copy of the advisory (this `11-project-notes`) was, like every project-note in the session save `14-project-notes`, write-only (B5).

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — `14-project-notes` was bootstrap item #1 in ALL 8 #11 invocations and is the consumer-side closure of the session's one cross-ticket project-note reuse.** The #14 audit (B1) established `14-project-notes` reaching the #11 *architect* via bootstrap + L14 search and propagating into `11-design-notes`. This audit shows the bootstrap delivery was **not architect-specific**: the same 4-item head with `14-project-notes` as item #1 was injected into every #11 invocation (setup, architect, revise, both Pass-A devs, Pass-B, both reviews — verified via all 8 initial-prompt blocks), and the head never moved across the 62-minute window. The mechanism is the same arbitrary-`getAll` "freshest note" luck (#55) the audits keep flagging — but here it landed on the *right* note, because `14-project-notes` (345 tok) was both the freshest project-note and small enough for the 600-token budget (#56). The proven consumption + propagation chain runs **architect bootstrap item #1 (E6) + architect search L14 (E8, genuine k-NN, 0.67) → `11-design-notes` "Volume-seed bug prevention (from #14) … Check `14-project-notes`" (E10) → revise folds it into the ticket (E14) → shipped ticket §4/§6 "CRITICAL: Do NOT create any sub-content inside `/var/agent-repo/`" → Dockerfile creates empty mount-point dirs only (`Dockerfile:84/86`, verified)**. This is the **complete episodic→semantic→reuse→applied-in-code cycle** the parent research targets (`research-knowledge-management-analysis.md` §"Memory Taxonomy"), now traced end-to-end from both ends. It both *strengthens* index F5 and *confirms* the #14 audit's correction of the "write-only store" framing: project-scope retrieval is not uniformly dead — it delivers when a downstream task is semantically adjacent to a prior distilled note (#14 moderator-volume-isolation → #11 agent-volume-isolation is exactly that adjacency). No issue to file — this is the canonical positive specimen; carry it into the index as the "store earned its tokens" case alongside #14.

**B2 — #11 contains the success and the failure of the *same* addressing problem, side by side: prompted exact-key handoff (7/7) vs unprompted semantic search (0/1 useful).** `11-design-notes` was the single most-consumed record of the session — read **7×** by `mode=keys` (E11/E13/E16/E22/E27/E32/E35), every read returning the exact authoritative record, because the moderator embedded the literal `context_query(scope='project', mode='keys', keys=['11-design-notes'])` instruction in each dispatch (index F3, here at maximal scale). In the *same ticket*, the architect's **own unprompted search** for that record (E7/L13, "ticket 11 worktree design notes") failed two ways: (a) it ran before the record existed (F5 inverse), and (b) even setting timing aside, its lone budget-admitted hit was a *process* note (`QRM4-BUG-009`, which defines the design-note-writing convention) at a min-max-forced 0.84, with **no "nothing relevant" floor** to warn the agent (F4). A third, sharper facet: a single oversized rank-2 doc (`QRM5-005-design-notes`, 1,879 tok) alone breached the 2,000-token budget and **collapsed L13's returned set to 1 item**, suppressing three genuinely relevant workspace-isolation design notes ranked just below it (`QRM8-001` 0.74, `QRM4-004` 0.71, and the bullseye `QRM8-direction-workspace-isolation`). The lesson for the KB design is the index's F3 thesis in concentrated form: **the bottleneck is addressing, not storage** — when the moderator supplied the address, retrieval was deterministic and perfect; when an agent had to discover the address by meaning, it got a budget-starved process note. No new issue (the budget-packing pathology is a facet of the documented F4 truncation behavior and the already-filed #56 budget work; the missing relevance floor is an inherent consequence of min-max normalization, flagged like #31-B3 without a separate filing) — but it is the strongest single argument in the dataset for **stable-address (KB-key) retrieval over pure semantic search**.

**B3 — The moderator's `get-all c5096d29` (E5) is the session's ONLY working conversation-scope read, and #11 proves it propagated — empirically answering index F1's open sub-question (b).** F1 asked whether the write-only conversation/agent scopes reflect (a) a scoping-model defect, (b) a moderator-orchestration gap, or (c) an argument for project-scope-by-default. #11 supplies the (b) data point: the moderator **can** bridge a foreign conversation partition by passing the prior invocation's correlationId to `get-all`, and **did** — pulling `11-ticket-setup` (E3) and quoting its "non-trivial SDK surface changes, volume layout decisions, Docker infrastructure across 4 services" review flag **verbatim** into the architect's dispatch (E5→E6, confirmed in `b0b5645f…jsonl`). This is the one time in the entire session a conversation-scope write was read back and acted upon — and it required the moderator to (i) hold the producer's correlationId and (ii) use the `get-all`-by-explicit-id path agents lack. So the conversation scope is not *inherently* dead; it is dead *for agents* (who only ever query their own fresh partition) and *alive only through deliberate moderator orchestration*, which happened exactly once. This makes the case that the gap is fixable at the orchestration layer (the moderator could pass prior correlationIds far more often, or write cross-invocation handoffs to project scope) — consistent with #59's addressing critique but distinct from it: #59 is about the *key shape*, B3 is about *who can supply the address*. No new issue; concrete evidence for F1's resolution.

**B4 — #11 is index-F2's worst case: two concurrently-running same-role developers redundantly researched the identical surface, and one's checkpoint was unreachable by the other despite being 2 minutes old.** The moderator's transport-retry (B5/#39) spawned two Pass-A developers — `43e6122e` (ran to the turns=100 cap) and `cd2957eb` — running concurrently in one container. Both executed the prescribed agent-scope start-of-task read (E17, E23) and both got **0**; both then re-derived the *same* 7-source-file/4-spec-file modification inventory (E19 `11-research-checkpoint` vs E24 `11-pass-a-research`) and wrote *separate* implementation records (E20 vs E25). The decisive timing: `43e6122e` wrote `11-research-checkpoint` at **18:24:56**; `cd2957eb`'s agent get-all ran at **18:27:07** — 2m11s later — and returned 0, because `agent:cd2957eb…` ≠ `agent:43e6122e…` (no role dimension in the key; `mcp.service.ts:789/848`). This is strictly sharper than #14-B3 (a 20-minute-apart sequential miss): here the data was 2 minutes old, the consumer was the same role, and the two were running *simultaneously* — the exact scenario the D7 agent-memory policy was meant to serve, failing in real time. Direct, dated evidence for the already-filed [#59](https://github.com/ia64mail/quorum/issues/59)/PR #60 (agent scope keyed on correlationId cannot persist role knowledge across — or here, *between concurrent* — invocations). No new issue; #11 should be cited in #59 as the concurrency specimen.

**B5 — The review's most actionable output reached a follow-up ticket — and full resolution — via the PR-comment channel, not the store; separately, the transport-retry forked the review and exhausted disk.** Two independent facets. (1) `11-project-notes`'s advisory note (correlationId path-traversal / shell-injection) became **ticket [#39](https://github.com/ia64mail/quorum/issues/39)** ("Harden correlationId — UUID validation and shell-safe worktree paths"), whose Problem Statement quotes PR #38's review-comment URLs — and **#39 is now resolved** (`z.string().uuid()` at `invoke.types.ts:70` + `mcp.service.ts:311`; `git worktree add`/`remove` and `git push` converted to `execFileAsync`; 839 tests / 47 suites). So the load-bearing channel for an actionable finding was *review-comment → ticket → shipped fix*, end to end — while the store's copy of the same advisory (this `11-project-notes`) is, like every project-note but `14-project-notes`, write-only. This is the cleanest demonstration in the dataset that the **ticket/PR substrate, not the Context Store, is where consequential knowledge actually flows and gets acted on**; the store rode along. (2) Separately, the review was a transport-retry double-dispatch: `0430b72b` (productive, wrote `11-project-notes`) and `07c58b95` (**ENOSPC death**, no completion) both ran a full bootstrap + `11-design-notes` key-read (E34/E35) before `07c58b95` died — the same `wait_invocation`-retry store-pollution-plus-wasted-compute pattern as #14-B2 (whose §4 cost accounting tracks it), here with a genuine disk-exhaustion failure on top. No new issue: facet (1) is closed (#39 resolved); facet (2) is the already-known transport-retry behavior #14-B2 documents.

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 / E6 / E12 / E15 / E21 / E26 / E31 / E34 | bootstrap ×8 (identical head) | **item #1 (`14-project-notes`) genuinely on-topic**; 2/4 slots noise | item #1 consumed by architect (E8/B1) | **Moderate** (item #1 carries #14's pattern) / Zero (rest) |
| E2 | project search L11 | #1 hit a bullseye (`QRM8-direction…` 1.00); rest filler | corroborating | **Low-moderate** — direction record store-only |
| E3 | write `11-ticket-setup` (conv) | accurate, decision-flavored | **YES — once, via moderator get-all (E5/B3)** | **Moderate** — review-flag propagated |
| E4 | project search L12 (moderator) | ≡ E2 head; reshuffled tail | nil | **Zero** |
| **E5** | **read conv get-all → 1 (moderator)** | clean cross-invocation pull | **YES — quoted into architect dispatch (B3)** | **Moderate — the session's one working conv read** |
| E7 | project search L13 (architect) | searched a not-yet-written record; 1 process-note hit, 3 relevant starved by budget (B2) | nil | **Zero / mildly negative** |
| **E8** | **project search L14 (architect)** | **genuine k-NN win — `14-project-notes` 0.67, no key tokens** | **YES — into `11-design-notes` (B1)** | **High — #14 volume-seed pattern** |
| E9 | project search L15 (architect) | focused gh-auth/clone lineage cluster | corroborating | **Moderate** — git-auth-decision store-only |
| **E10** | **write `11-design-notes` (project)** | **accurate, line-precise; the central record** | **YES — read 7× by `mode=keys` (B2); applied in revise/impl/review** | **High — store-unique architect decisions, transported to ticket** |
| E11/E13/E16/E22/E27/E32/E35 | keys-read ×7 | exact, authoritative, deterministic | **YES — most-consumed record of session (B2)** | **High→declining** (store-unique until E14 folds into ticket) |
| E14 | write `11-ticket-revision` (conv) | accurate fold receipt (AC 14→19) | **never** — dead-end | **Thin** — revise SHA only |
| E17/E18/E23/E28 | scoped get-all ×4 → 0 | reflex reads of own empty partition; E23 = 2-min-old sibling miss (B4) | — (0/0) | **Negative** |
| E19/E24/E29 | agent checkpoints ×3 | useful inventories; E19≈E24 redundant (B4) | **never** — F2; concurrency-unreachable | **Thin/moot** |
| E20/E25/E30 | conv impl records ×3 | accurate, SHA-bearing; E20≈E25 redundant | **never** — dead-end | **Thin** — SHAs only |
| **E33** | **write `11-project-notes` (project)** | **accurate, no defects; advisory note actionable** | **never** (advisory traveled via PR→#39, since **resolved**, B5) | **Moderate** — patterns + the #39-seed advisory |

**Bottom line for the parent research.** #11 ran on the usual two primary channels — the ticket file (full spec, named in every dispatch) and the moderator prompt (commit progression, the explicit `mode=keys` instructions, the review checklist) — but it is also where the Context Store contributed the **most**, and the *shape* of that contribution is the dataset's clearest statement of the research thesis. Everything the store did well was **addressed**: `11-design-notes`, handed to consumers by exact key, was read 7× with perfect fidelity and carried the architect's decisions into the implementation (E10/B2); `14-project-notes`, delivered by bootstrap item #1 and re-found by a genuine semantic neighbor query, completed the #14→#11 episodic→semantic→reuse→code cycle (E6/E8/B1); the moderator's `get-all`-by-correlationId bridged the one conversation handoff that mattered and quoted it into the architect's brief (E5/B3). Everything the store did badly was **un-addressed**: the architect's own search for its design notes returned a budget-starved process note with no relevance floor (E7/B2); three agent-scope checkpoints — two of them redundant researches of the identical surface, produced two minutes and one partition apart — were written and never read (E19/E24/E29, E23/B4); five conversation/agent writes died in dead-end partitions (F1); and the review's one actionable advisory traveled to a follow-up ticket through the PR comment thread, not the store it was also written to (E33/B5). #11's lesson, reinforcing #14's: the store earns its tokens on the **project scope with a stable key**, and only when something — usually the moderator's prompt, occasionally a semantically-adjacent later task — supplies the address. The conversation and agent scopes paid their write cost and returned, between them, exactly one read this ticket (E5, moderator-mediated). The addressing bottleneck (index F3) is not a nuance here; it is the whole story.

---

## Appendix — reproduction

```bash
# 0. Start the stopped store (data volume intact); stop with: docker stop quorum-opensearch-1
docker start quorum-opensearch-1

# 1. Confirm the #11 agent set (8 invocations: teamlead ×4, developer ×3, architect ×1; note 43e6122e turns=100, 07c58b95 ENOSPC no-completion)
grep -hE 'Invocation (received|complete)' \
  logs/teamlead-20260524T003432.jsonl logs/developer-20260524T003432.jsonl logs/architect-20260524T003432.jsonl \
  | python3 -c "import sys,json;[print(json.loads(l)['message'][:95]) for l in sys.stdin]" | grep -iE '#11|worktree'

# 2. Bootstrap head for all 8 #11 invocations (gap G2) — all identical, 14-project-notes as item #1
for spec in c5096d29:teamlead b424f21d:architect ecd11908:teamlead 43e6122e:developer cd2957eb:developer 649092c8:developer 0430b72b:teamlead 07c58b95:teamlead; do
  cid="${spec%%:*}"; role="${spec##*:}"
  python3 -c "import json,re
for l in open('logs/${role}-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=$cid' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print('$cid', re.findall(r'^- ([\w-]+):', m[i:i+2600], re.M)); break"
done

# 3. The five #11 search traces (L11 teamlead, L12 moderator, L13/L14/L15 architect) with scores + budget cut
for q in a17ea4b7 4dc2d8a0 af79231b 7fbd3ee1 fcddb03a; do
  echo "== $q =="
  jq -r --arg q "$q" 'select(.extra.queryId|startswith($q)) | .extra |
    "\(.callerRole) \(.scope) raw=\(.hitCountRaw) ret=\(.hitCountReturned) q=\(.queryText)",
    (.results[]? | select(.includedInResult) | "  \(.score|tostring[0:6]) \(.tokensEstimate)t \(.key)")' \
    logs/context-search-20260524T003426.jsonl
done

# 4. RAW written values — all ten #11 records, single-version
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search?size=30' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["11-ticket-setup","11-design-notes","11-ticket-revision",
       "11-research-checkpoint","11-implementation-decisions","11-pass-a-research",
       "11-pass-a-implementation","11-passB-research","11-passB-implementation","11-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'

# 5. B1 — 14-project-notes consumed by the #11 architect: bootstrap item #1 + L14 hit + propagation into 11-design-notes
python3 -c "import json
for l in open('logs/architect-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=b424f21d' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print(m[i:i+120]); break"
jq -r 'select(.extra.queryId|startswith("7fbd3ee1")) | .extra.results[] | select(.key=="14-project-notes")
  | "L14 14-project-notes score=\(.score) included=\(.includedInResult)"' logs/context-search-20260524T003426.jsonl
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' -d '{"query":{"term":{"key":"11-design-notes"}},"_source":{"excludes":["embedding"]}}' \
  | jq -r '.hits.hits[]._source.value' | grep -iE 'from #14|14-project-notes'

# 6. B2 — 11-design-notes read 7× by mode=keys; the architect's own search (L13) failed
grep -nE 'mode=keys id=_ keys=\[11-design-notes\]' logs/mcp-server-20260524T003426.jsonl   # 7 hits

# 7. B3 — moderator get-all pulled 11-ticket-setup, then quoted it into the architect dispatch
python3 -c "
for l in open('logs/moderator-sessions/-mnt-quorum-workspace/b0b5645f-0241-4585-9a6b-d0946c9c8231.jsonl'):
 if 'context_query' in l and 'c5096d29' in l: print('moderator get-all c5096d29')" | head -1
grep -o 'Architect review strongly recommended[^\"]*services' <(docker exec quorum-opensearch-1 curl -s \
  'http://localhost:9200/quorum-context/_search' -H 'Content-Type: application/json' \
  -d '{"query":{"term":{"key":"11-ticket-setup"}},"_source":{"excludes":["embedding"]}}')

# 8. B4 — concurrent same-role checkpoint unreachable: 43e6122e wrote 11-research-checkpoint 2 min before cd2957eb's agent get-all returned 0
grep -nE '43e6122e.*11-research-checkpoint|cd2957eb.*scope=agent mode=get-all' logs/mcp-server-20260524T003426.jsonl

# 9. B5 — the path-traversal advisory became ticket #39, which is now RESOLVED (correlationId UUID-validated; worktree git calls use execFileAsync)
grep -nE 'z.string\(\)|\.uuid\(\)' libs/common/src/messaging/invoke.types.ts | head      # correlationId: z.string().uuid()
grep -n '.uuid()' apps/mcp-server/src/mcp/mcp.service.ts | head                          # invoke_agent tool schema
grep -nE "execFileAsync\('git', \['worktree'" apps/agent/src/connection/invocation-handler.service.ts  # argv, no shell
grep -nE '\[x\]|Verification' tickets/39-harden-correlation-id.md | head                 # ACs checked, 839 tests/47 suites

# 10. E10/E33 code verification — design-notes/project-notes claims are live
grep -n 'params.cwd ?? this.config.agent.workspaceDir' apps/agent/src/llm/claude-code.service.ts   # :131
grep -nE 'checkout --detach|scope.*global' docker/agent/entrypoint.sh                                # :49, :72
grep -n "workspaceDir: process.env.AGENT_WORKSPACE_DIR || '/var/agent-repo'" apps/agent/src/config/agent.config.ts  # :14

# (store left running; stop with: docker stop quorum-opensearch-1)
```