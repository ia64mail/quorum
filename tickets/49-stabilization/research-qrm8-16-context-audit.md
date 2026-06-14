# #16 Redirect Agent Memory to Context Store — Context-Access Audit

**Date compiled:** 2026-06-12
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#16")
**Ticket:** `tickets/16-redirect-agent-memory.md` · **PR:** #35
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #16, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

> **Why this ticket is special.** #16 is the ticket that *created* the agent-scope memory policy the rest of the session data measures (index F2): it appends a "## Agent Memory" paragraph to `SYSTEM_PREAMBLE` telling every agent role to persist durable knowledge in `context_store(scope='agent')`. This audit therefore grades the **birth of the mechanism** — and finds it dead on arrival (B2).

## Scope correction vs the index

The index lists **three** invocations for #16 and the full log sweep confirms exactly three — no probes, no duplicates, no ENOSPC failures. Like #17 (and unlike #31, where the index listed 1 and the sweep found 5), **the index's per-ticket row count is complete.** The invocation set below matches the index §3 row verbatim. The one thing the index summarizes loosely is, again, the *bootstrap content*: it calls the session's bootstraps a "near-static 4-item set, 549–598 tokens," but #16's bootstrap is a **3-item, 598-token** set whose project head is *different from every prior ticket's* — and, critically, it contains `17-project-notes`, written 15 minutes earlier, which the #17 audit concluded "can never be injected" (finding B1, a cross-audit correction).

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-24 02:13:50 → 02:16:07 | `d14b97a0-d76e-4e4e-82ac-f8eff322339e` | teamlead / Phase-1 ticket setup (draft `16-…md` + open PR #35) | `teamlead-20260524T003432.jsonl` | bootstrap **E1** · write **E2** · **zero searches** |
| I2 | 05-24 02:34:24 → 02:35:52 | `6c5350ae-5c00-41f9-b216-ae1a8aedb27e` | developer / implement | `developer-20260524T003432.jsonl` | bootstrap **E3** · **agent get-all E4 → 0** · write **E5** · **zero searches** |
| I3 | 05-24 02:36:18 → 02:37:23 | `1e8c7b6d-6eb2-4161-9e03-862bcdbb3ad2` | teamlead / lightweight review (PR #35) | `teamlead-20260524T003432.jsonl` | bootstrap **E6** · write **E7** · **zero searches** |

No architect invocation exists for #16 (the ticket records "No architect review needed — trivial prompt change"). The moderator issued **no `context_query`** for #16 and passed **no context key and no `id`** in any of its three dispatches — each `invoke_agent` carried only `{action, callerRole, sessionId, target}`, with `sessionId: ""` (fresh session every time), and the developer dispatch named the ticket file (`tickets/16-redirect-agent-memory.md`) as the spec channel, not the store (verified in `b0b5645f…jsonl`). The moderator's only two store reads of the entire session were both for #11.

**The agent-scope dog that didn't bark.** #16 *authored* the "use `context_store(scope='agent')`" guidance, yet **#16 produced zero agent-scope writes.** A store-wide `prefix:"16-"` query returns exactly three documents — `conversation:16-ticket-setup`, `conversation:16-implementation-result`, `project:16-project-notes` — none in agent scope. The developer (I2) *read* agent scope (E4, get-all → 0) but wrote its result to **conversation** scope (E5). The mechanism's first agent-scope *writes* came later in the session (#14's `ticket-14-research`, #11's checkpoints — index F2), never read by anyone. See B2.

**Key version facts (no overwrites this ticket):** all three writes are single-version. `16-ticket-setup`, `16-implementation-result`, and `16-project-notes` each exist exactly once in OpenSearch with no `updatedAt` — unlike #31's `31-project-notes` v1→v2 overwrite, nothing about #16 was superseded in-session, so every write below is verbatim-complete.

---

## Data recovery method

Same toolkit as the #31/#17 audits. RAW write bodies were recovered by querying the running `quorum-opensearch-1` container (data volume intact, `Up … (healthy)`) against the `quorum-context` index, `_source` excluding the embedding vector:

```bash
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["16-ticket-setup","16-implementation-result","16-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'
```

All three documents returned complete bodies plus `createdAt`/`createdBy`/`embeddingText` (no truncation, no missing versions — OpenSearch's "latest version only" limitation does not bite here because nothing was overwritten). The absence of any agent-scope `16-*` doc was confirmed with a `prefix:"16-"` query (3 hits, all conversation/project) and a `terms:{id:[<3 cids>]}` query (2 hits, both conversation).

Bootstrap item *keys and full text* (index gap G2) were recovered from the agent-side `=== Initial prompt ===` debug line in each role log, which embeds the rendered `## Prior Decisions` block verbatim — all three #16 invocations carry a byte-identical 3-item block. The chicken-and-egg fact at E4 (the developer's own preamble did **not** yet contain the "## Agent Memory" guidance it was implementing) was confirmed by scanning the System-Prompt portion of the developer's initial-prompt line: its `##`-headers stop at "Progress Checkpointing," with no "Agent Memory" section and no "ephemeral … tmpfs" string.

---

## Chronological access-point audit

### E1 — Bootstrap injection, ticket setup (I1, 05-24 02:13:50)

`BootstrapContextService` assembled **3 items, 598 tokens, scopes=[project, conversation]** (`mcp-server-20260524T003426.jsonl:1442`). Conversation partition empty (fresh correlationId), so all 3 are project scope. Rendered into the user prompt as (long records abbreviated; full text of `17-project-notes` is rendered at the #17 audit's E8):

```
## Prior Decisions

### Project Context
- 17-project-notes: "PR #34 code review accepted for ticket #17 (MCP server bind mount removal).
  Key outcomes: (1) Vestigial infrastructure removal pattern established — when a backend migration
  (InMemoryStore → OpenSearch) makes env vars and mounts dead code, the mount is commented out with
  an inline debug note rather than deleted … (5) This implements Design Decision D8 from QRM8
  roadmap. The mcp-server mount was the first of three workspace mounts to be addressed — moderator
  (#14) and agent (#11) mounts are separate concerns. (6) docs/context-store.md still documents
  MCP_WORKSPACE_DIR … may warrant a doc update …"                                       [≈470 tok]
- draft-pr-based-workflow-bootstrap-design-notes: "PR-based workflow bootstrap ticket drafted at
  tickets/draft-pr-based-workflow-bootstrap.md. Key findings: (1) gh CLI is NOT installed in either
  the moderator or agent Dockerfile stages … (2) GH_TOKEN must be added to moderator env block …
  (7) Step 1 (GH_TOKEN) must land first so the moderator gets gh auth on rebuild."
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"                     [≈12 tok]
```

The project head here is **a third distinct set** in the session's evolving sequence: `{29-project-notes, two-tier-billing-docs}` at #31/#17-E1 (01:46) → `{27-project-notes, draft-pr-…}` at #17-E3/E7 (01:51–01:53) → `{17-project-notes, draft-pr-…}` now (02:13), with only `qrm6-rerun-elicit-A` carried through and `elicitation-test-A` dropped (the set is 3, not 4, because `17-project-notes` is large). **No project-scope write happened between #17's review (01:58) and now** except E2 of #17's own lineage — the head still reshuffled. This is finding B1.

**Quality feedback:**
- **Quality: none of it is about #16.** #16 is a prompt-only `SYSTEM_PREAMBLE` edit redirecting agent memory to `context_store(scope='agent')`. `17-project-notes` is about an mcp-server docker-compose mount; `draft-pr-…-design-notes` is about gh-CLI install; `qrm6-rerun-elicit-A` is a month-old QRM6 test string. None mentions memory, `~/.claude/`, tmpfs, or the agent scope — the exact subject of the ticket. Net: a 598-token injection with zero #16 signal. (There is a faint thematic echo — `17-project-notes` item (1)'s "vestigial infrastructure removal pattern" is also a *removal/redirect* convention — but it is about commenting out a docker mount, not about memory persistence, and nothing connects them for the agent.)
- **Re-usability: delivery channel, not a read.** The setup task (draft the ticket, open the PR) ran off the moderator prompt and the roadmap's D7 paragraph (`tickets/8-workspace-isolation.md`), not these three records.
- **Added value beyond `docs/`+`tickets/`: zero.** `17-project-notes` is last ticket's record; `draft-pr` is documented in its own draft ticket; `qrm6-rerun-elicit-A` is noise.

### E2 — Write `conversation:d14b97a0…:16-ticket-setup` (I1, 05-24 02:16:06.214)

The setup completion record, written by the teamlead after drafting the ticket and opening PR #35. RAW value (complete, from OpenSearch; `createdBy=teamlead`):

```
Ticket #16 (Redirect Agent Memory to Context Store) setup complete. Ticket file:
tickets/16-redirect-agent-memory.md. Branch: 16-redirect-agent-memory (off
8-workspace-isolation-staging). PR: #35 (https://github.com/ia64mail/quorum/pull/35), retargeted to
8-workspace-isolation-staging via two-step trick. Commit: c6b231a. Verification: build/lint/test all
pass (46 suites, 788 tests). This is a Phase 1 independent ticket — prompt-only change to
SYSTEM_PREAMBLE in libs/common/src/prompts/role-prompt-templates.ts. No architect review needed
(trivial prompt change). Implementation: add D7 memory redirect paragraph after the Progress
Checkpointing section (line 104). Moderator memory unchanged.
```

**Quality feedback:**
- **Quality: accurate but a status echo.** Every fact (branch, base, PR #35, commit `c6b231a`, the two-step retarget trick, build/lint/test counts, "no architect review", the target line 104) is correct and matches the ticket's own Implementation Notes. It is a state snapshot, not a decision record — and it pre-states the implementation plan ("add D7 paragraph after Progress Checkpointing, line 104"), which is genuinely the most useful thing it carries forward.
- **Re-usability: zero — written into a dead-end partition.** It lives under `conversation:d14b97a0…`. The next invocation (the developer, I2) keyed its own correlationId `6c5350ae…`, so this record was unreachable (finding F1) — and indeed the developer's bootstrap (E3) had an empty conversation leg and the developer ran no conversation search at all. Nothing ever read it.
- **Added value beyond `docs/`+`tickets/`: thin.** The PR URL and commit `c6b231a` are the only store-unique data, both recoverable via `gh pr view` / `git log`. Had the moderator forwarded `d14b97a0` as the developer's conversation `id`, this record *would* have handed the developer the exact implementation target ("line 104, after Progress Checkpointing") in one read — but the addressing was never wired (index F3; B2 below sharpens the addressing story for agent scope specifically).

### E3 — Bootstrap injection, implement (I2, 05-24 02:34:24)

**3 items, 598 tokens** (`mcp:1705`) — **byte-identical item set to E1** (`17-project-notes`, `draft-pr-…-design-notes`, `qrm6-rerun-elicit-A`), verified via the initial-prompt debug line. The conversation leg is empty (the setup's `16-ticket-setup` sits under `d14b97a0…`, not the developer's `6c5350ae…`).

**Quality feedback:**
- **Quality: still nothing about #16.** Same three off-topic project records as E1.
- **Re-usability: delivery only, and the conversation channel was empty** — `16-ticket-setup` (E2, 18 min earlier) could not ride the bootstrap forward because it is in a different partition (F1 manifesting in bootstrap, not just search). The implement task ran off the ticket spec (named in the moderator prompt) plus the worktree.
- **Added value beyond `docs/`+`tickets/`: zero.**

### E4 — Read `agent:6c5350ae…` get-all → **0 items** (I2, 05-24 02:34:34.823)

The developer's only retrieval attempt: a get-all against its own **agent**-scope partition (`mcp:1713`), returning 0. This is the **first runtime exercise of the very mechanism #16 ships** — and it failed, structurally.

Two facts make this the audit's centrepiece specimen:

1. **The read came from standard pull-context behavior, not from #16's policy.** The developer's *own* `SYSTEM_PREAMBLE` at invocation time did **not** contain the "## Agent Memory" paragraph — that paragraph is the artifact this very invocation is about to add to the source. Its preamble's `##` sections stopped at "Progress Checkpointing." So the agent-scope get-all is the generic "query context before starting work" reflex (Shared Context / Context Management guidance), aimed at a partition the new policy will later tell agents to use. The policy's author ran the policy's read path before the policy existed — and got nothing.
2. **It returned 0 by construction.** `agent:6c5350ae…` is the invocation's own fresh partition; at task start it holds nothing (this invocation has written nothing yet, and no other invocation can write into *this* correlationId's partition). `0 item(s)` — not a k-capped search miss, a genuinely empty partition.

**Quality feedback:**
- **Quality of the operation: correct intent, impossible target.** Checking durable agent memory before implementing is exactly what the D7 policy will prescribe. But the scope it checks can never hold another invocation's knowledge (B2).
- **Re-usability: nil by construction** — the structural F1/F2 failure, here exercised against the scope #16 is about to bless as the durable channel.
- **Added value: negative — a tool round-trip retrieving nothing,** and worse, a *self-refuting demonstration*: the ticket establishing `context_store(scope='agent')` as durable role memory opens with its implementer querying that scope and finding it empty.

### E5 — Write `conversation:6c5350ae…:16-implementation-result` (I2, 05-24 02:35:51.000)

The implementation record, written by the developer at task end — **into conversation scope, not the agent scope #16 is establishing.** RAW value (complete, from OpenSearch; `createdBy=developer`):

```
Ticket #16 (Redirect Agent Memory to Context Store) implemented. Single file changed:
libs/common/src/prompts/role-prompt-templates.ts — added '## Agent Memory' section to
SYSTEM_PREAMBLE after Progress Checkpointing. D7 paragraph inserted verbatim with escaped backticks.
Prompt-only change, no mechanical deny rules. Moderator unaffected (SYSTEM_PREAMBLE is agent-only).
Verification: build, lint, 788 tests all pass. Two commits: ed7d6d8 (code change) and f4756ef
(ticket AC flip + Implementation Notes). Both pushed to 16-redirect-agent-memory branch.
```

**Quality feedback:**
- **Quality: accurate and appropriately scoped.** Matches the shipped change exactly (verified: the `## Agent Memory` section is at `libs/common/src/prompts/role-prompt-templates.ts:120`, the last section of `SYSTEM_PREAMBLE`, text verbatim from roadmap D7 — see E7 verification). Carries the two commit SHAs, which the ticket file's Implementation Notes also list.
- **Re-usability: zero, and self-defeating in the same way as #17's E6** — written into the developer's own partition *after* the developer's own retrieval (E4) already came up empty, so the one invocation whose context it would have answered had already given up. The reviewer (I3) ran no search and is in a different partition anyway. Nothing ever read it.
- **Added value beyond `docs/`+`tickets/`: thin.** Commit SHAs (`ed7d6d8`, `f4756ef`) are the only store-unique data, recoverable from `git log`. **The telling detail is the scope choice:** the agent implementing "persist role-level knowledge in `scope='agent'`" filed its *own* output under `conversation` scope — the session's universal `*-implementation-result` convention. Whether by habit or because conversation is the de-facto handoff scope, the record is the cleanest evidence that the new agent-scope guidance changed no behavior even in the hands of its own author (B2).

### E6 — Bootstrap injection, review (I3, 05-24 02:36:18)

**3 items, 598 tokens** (`mcp:1748`) — **identical item set to E1/E3.** The project head has held on set `{17-project-notes, draft-pr-…, qrm6-rerun-elicit-A}` across the whole #16 window (02:13–02:37).

**Quality feedback:** same content assessment as E1/E3 — three off-topic project records, none about agent memory. The structural observation matches #31-E6 and #17-E7: the obviously-relevant record to inject for a review would be a `{ticket}-project-notes` for the ticket under review, and the channel never carries it — here doubly impossible, since `16-project-notes` does not exist yet (written 65 s later at E7). Notably, the **fresh** `17-project-notes` *is* present (B1), so freshness is not uniformly broken — it is *arbitrary*: last ticket's note surfaced, this ticket's never could.

### E7 — Write `project:_:16-project-notes` (I3, 05-24 02:37:22.637)

The review verdict synthesis, the only project-scope record #16 produced. RAW value (complete, from OpenSearch; `createdBy=teamlead`):

```
PR #35 code review accepted for ticket #16 (redirect agent memory to context store). Key outcomes:
(1) Prompt-only change — a 4-line "## Agent Memory" section was appended to SYSTEM_PREAMBLE in
libs/common/src/prompts/role-prompt-templates.ts, after the existing "Progress Checkpointing"
section. (2) The paragraph explains CC memory (~/.claude/) is ephemeral on agent containers (tmpfs,
lost on restart) and directs agents to use context_store(scope='agent') for persistent role-level
knowledge. (3) Moderator memory is unaffected — SYSTEM_PREAMBLE is consumed only by
getRolePromptTemplate() for agent roles; the moderator prompt lives in docker/moderator/CLAUDE.md
and does not import this constant. (4) No mechanical deny rules or auto-memory stripping introduced
— this is prompt guidance only. (5) Implements Design Decision D7 from QRM8 roadmap
(tickets/8-workspace-isolation.md). (6) Build/lint/test: 3 webpack compilations, 0 lint errors, 788
tests passed across 46 suites. (7) Pattern note: the SYSTEM_PREAMBLE constant now has 5 sections —
General Guidelines, Capabilities, Autonomous Operation, Shared Context, Progress Checkpointing, and
Agent Memory. Future SYSTEM_PREAMBLE additions should append after the Agent Memory section.
```

**Quality feedback — checked against the shipped code:**
- **Accuracy: high on items (1)–(6), but item (7) is wrong.** Items (1)–(5) match the tree exactly: the `## Agent Memory` section is the last section of `SYSTEM_PREAMBLE` (`role-prompt-templates.ts:120`), its body is **verbatim** the D7 "Memory Redirect" paragraph from `tickets/8-workspace-isolation.md:387` (confirmed character-for-character, including the `context_store(scope='agent')` span and the "patterns learned, preferences, architectural constraints discovered" list); item (3)'s moderator-exclusion claim is correct (`getRolePromptTemplate()` is agent-only; the moderator prompt is `docker/moderator/CLAUDE.md`). **Item (7) is a factual defect:** it says "5 sections" then lists **six** names, and the actual `SYSTEM_PREAMBLE` has **ten** `##` sections (The Team, Capabilities, Workspace, Communication, Autonomous Operation, Shared Context — Pull Don't Push, General Guidelines, Git Discipline, Progress Checkpointing, Agent Memory). The inventory is both internally inconsistent (5 vs 6) and wrong against the source (misses four sections). The *actionable* half of (7) — "append after the Agent Memory section" — happens to be correct (Agent Memory is genuinely last), but it rests on a miscount. This is the #16 analog of #31's "5 vs 4 Haiku scorers" nit, except baked into the authoritative project record as forward guidance (B3).
- **Quality as a record: well-structured, role-prompt-conformant prose, keyed per convention.** No supersession issues (single version). It is the best-written record in #16's lineage — but it is also ~85% a restatement of the ticket, and its one piece of genuinely synthesized "pattern" knowledge (item 7) is the one part that is wrong.
- **Added value beyond `docs/`+`tickets/`: thin.** Items (1)–(6) condense `tickets/16-…md`. There is no store-unique, *correct* knowledge here that the ticket file lacks (contrast #17-E8 item (1)'s "vestigial infrastructure removal" pattern and item (6)'s doc-TODO, both real and unique). The only store-unique content — item (7)'s section inventory + append rule — is the defective part.
- **Re-usability: zero to date.** No search/keys-read/get touches `16-project-notes` through end of coverage (2026-05-28). At ≈300 tokens it *would* fit the 600-token project bootstrap budget — yet, exactly as with #17's `17-project-notes`, it never surfaces, because the unsorted `getAll` (B1) governs what reaches the 3–4-item head. (And by the same token, the fact that the equally-fitting `17-project-notes` *did* surface in #16's bootstraps shows the constraint is ordering-arbitrariness, not size.)

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — The bootstrap project-head reshuffled again, and this time it surfaced a *fresh* project-note — directly correcting the #17 audit.** The #17 audit (E8 / its own B1) concluded that `17-project-notes` "never surfaced … because the unsorted `getAll` (B1) never ranks it into the … head" and called it "the cleaner proof that **ordering, not budget, is the binding constraint**," asserting it "can never be injected" through 05-28. **The #16 data disproves the over-broad half of that claim:** `17-project-notes` (written 01:58:15) is present in **all three** #16 bootstraps (E1 02:13, E3 02:34, E6 02:36), ~15 minutes after it was written. The #17 audit's *narrow* point stands — `17-project-notes` never helped #17 itself, because at #17's own bootstraps (01:46–01:53) it did not yet exist — but "never injected anywhere through 05-28" is wrong: it was injected three times into the very next ticket. The corrected reading *strengthens* the index's B1 / issue [#55](https://github.com/ia64mail/quorum/issues/55): the unsorted `OpenSearchStore.getAll` (`apps/mcp-server/src/context-store/opensearch-store.ts`, filter-only bool query, no `sort` clause) is not uniformly stale but **arbitrary** — the same record is absent from one ticket's bootstraps and present in the next, governed by Lucene `_doc` / segment order, not recency. The session's three-step head evolution `{29,billing}`(01:46) → `{27,draft-pr}`(01:51) → `{17,draft-pr}`(02:13), with no monotonic relationship to write time, is the in-session demonstration. No new issue — this is concrete evidence for #55, and a correction to a sibling audit's conclusion that should be carried into the index if F-findings are ever revised.

**B2 — The redirect target `context_store(scope='agent')` is architecturally incapable of cross-invocation role persistence: agent scope is implemented identically to conversation scope.** *(Filed 2026-06-12: issue [#59](https://github.com/ia64mail/quorum/issues/59), spec `tickets/59-agent-scope-role-keyed-partition.md`, PR [#60](https://github.com/ia64mail/quorum/pull/60) → `49-stabilization`; sub-issue of QRM9 epic #49.)* #16 ships prompt guidance to persist "role-level knowledge … that should survive across invocations" in `scope='agent'`. But in `McpService`, **both** `context_store` (write) and `context_query` (read) resolve the agent-scope partition id to the per-invocation correlationId, exactly as for conversation scope:

```ts
// write — apps/mcp-server/src/mcp/mcp.service.ts:787-789
// Project scope is global — never include an id in the key.
// Conversation/agent scopes use correlationId as the id partition.
const id = scope === ContextScope.project ? undefined : correlationId;

// read — apps/mcp-server/src/mcp/mcp.service.ts:848 (identical line in context_query)
const id = scope === ContextScope.project ? undefined : correlationId;
```

`correlationId` is `args.correlationId ?? state?.correlationId` (`:764`, `:845`) — for an agent invocation, its own fresh session correlationId. So an agent-scope write lands in `agent:<thisInvocationCorrId>:<key>`, and the **next** invocation of the same role queries `agent:<aDifferentCorrId>:…` — a different, empty partition. There is **no role dimension** anywhere in the agent-scope key; the literal prefix string `"agent"` vs `"conversation"` is the *only* difference between the two scopes, and neither carries the role. The scope #16 designates as durable role memory is mechanically a per-invocation scratch partition. This is the code-level root cause beneath the index's session-wide F2 ("the partition key makes them invisible to the next invocation of the same role") — F2 observed the *symptom* across 7 unread checkpoints; B2 pins it to two lines and shows it is a *type* error in the scope model, not a usage gap. **The #16 audit is where this matters most**, because #16 is the ticket that promotes this scope to first-class durable storage, and its own implementer (E4/E5) both read the empty partition and declined to write to it. *New angle vs F2:* the QRM8 roadmap's deferral of the fix to QRM9 names "background summarization, agent-scope bootstrap injection, decay/TTL" (`tickets/8-workspace-isolation.md:423,589`) — **none of these addresses the addressing defect.** Summarization, TTL, and even "agent-scope bootstrap injection" all still need a *stable partition to inject from*; with the id keyed on correlationId there is no role-stable partition to summarize, expire, or inject. The minimal fix is to key agent scope by **role** (`agent:<role>:<key>`) rather than correlationId — a genuinely different change from anything QRM9 currently plans, which is why this warrants its own issue rather than folding into the QRM9 quality-upgrade bucket.

**B3 — The store accepted a self-describing record that is factually wrong, as forward guidance, with no validation path.** `16-project-notes` item (7) states the `SYSTEM_PREAMBLE` constant "has 5 sections" (then lists 6; the real count is 10) and instructs "Future SYSTEM_PREAMBLE additions should append after the Agent Memory section." The append rule is correct by luck (Agent Memory is last), but the inventory it rests on is wrong and internally inconsistent. This is store-unique content — it appears nowhere in the ticket or PR — and it is the *only* store-unique content in #16's highest-value record, which makes it a sharp specimen: the one thing the project-note adds beyond `docs/`+`tickets/` is an inaccurate structural claim that a future agent searching "SYSTEM_PREAMBLE sections" would retrieve at score 1.0 with no freshness or correctness signal. No code defect, so no issue to file (mirror of #17's B3, but inverted: #17's store-unique item was *correct and useful*; #16's store-unique item is *wrong*). The lesson for the parent research: "store the decision so others can find it" without a verification or supersession surface lets premature/sloppy synthesis become the authoritative record — the same failure family as #31's B3 (overwrite destroys history) seen from the write-quality side.

---

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap read (setup) | accurate but 0% #16-relevant; 1/3 slots noise; head reshuffled to a fresh-but-off-topic set (B1) | n/a (delivery) | **Zero** — #17 mount notes + gh-CLI draft + elicitation, none about agent memory |
| E2 | write `16-ticket-setup` (conv) | accurate status echo; carries the impl target (line 104) | **never** — dead-end partition (F1) | **Thin** — only PR URL + commit `c6b231a` store-unique |
| E3 | bootstrap read (implement) | ≡ E1; conv leg empty (B1/F1) | n/a (delivery) | **Zero** |
| E4 | **agent get-all → 0** | correct intent, impossible target — first run of #16's own mechanism, empty by construction (B2) | — (0 items) | **Negative** — self-refuting: the scope #16 blesses returns nothing to its own author |
| E5 | write `16-implementation-result` (**conv**, not agent) | accurate; 2 commit SHAs | **never** — written after its own failed read | **Thin** — and filed under conversation scope by the very agent enacting the agent-scope policy (B2) |
| E6 | bootstrap read (review) | ≡ E1/E3; the one #16 record doesn't exist yet; fresh `17-project-notes` present (B1) | n/a (delivery) | **Zero** |
| E7 | write `16-project-notes` (project) | items (1)–(6) code-verified accurate; **item (7) factually wrong** (5/6/10 sections) (B3) | **never** (through 05-28) — fits budget but blocked by ordering (B1) | **Thin/Negative** — ~85% ticket restatement; its only store-unique content (item 7) is the defective part |

**Bottom line for the parent research:** #16's pipeline ran on two channels — the ticket file (full spec; the moderator named it) and the moderator prompt (commit format, scope guards, "no architect review"). **The Context Store's net retrieval contribution was zero**, and #16 is a stronger "write-only store" specimen than #17 in two compounding ways. First, the retrieval that *did* fire — the developer's agent-scope get-all (E4) — was aimed at the scope this very ticket was promoting to durable role memory, and it returned empty by construction; the implementer then wrote its own output to conversation scope (E5), so even the policy's author did not use the policy. Second, of the three records #16 wrote, two are unreachable conversation-scope echoes and the third (`16-project-notes`) is the rare specimen whose *only* store-unique content is **incorrect** (B3). The deeper finding (B2) is architectural and is the reason #16 matters out of proportion to its two-line change: the ticket establishes `context_store(scope='agent')` as the durable replacement for ephemeral CC memory, but agent scope is implemented exactly like conversation scope (correlationId-keyed, no role dimension — `mcp.service.ts:789/848`), so the replacement cannot persist anything across invocations, and the QRM9 quality-upgrade plan does not fix the addressing. #16 thus did not just *fail to use* the store well — it **shipped a policy pointing at a structurally dead channel.** The addressing-bottleneck thesis (index F3) reaches its sharpest form here: the bottleneck is not that nothing was pointed at the right record, but that the new policy points every agent at a scope that, by construction, can never hold another invocation's knowledge.

---

## Appendix — reproduction

```bash
# 1. Confirm the #16 invocation set is complete (3 invocations, no probes/dups/ENOSPC)
grep -h 'Invocation received' logs/teamlead-20260524T003432.jsonl logs/developer-20260524T003432.jsonl \
  | python3 -c "import sys,json;[print(json.loads(l)['message'][:90]) for l in sys.stdin]" | grep -i '#16\|16 '

# 2. Bootstrap item keys+text for any #16 invocation (gap G2 workaround) — all three share one 3-item block
for spec in "d14b97a0:teamlead" "6c5350ae:developer" "1e8c7b6d:teamlead"; do
  cid="${spec%%:*}"; role="${spec##*:}"
  python3 -c "import json
for l in open('logs/${role}-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=$cid' in l:
  m=json.loads(l)['message']; i=m.find('## Prior Decisions'); print('== $cid =='); print(m[i:i+1500]); break"
done

# 3. Confirm E4: the developer's OWN preamble did NOT yet contain the Agent Memory guidance (chicken/egg)
python3 -c "import json
for l in open('logs/developer-20260524T003432.jsonl'):
 if 'Initial prompt for correlationId=6c5350ae' in l:
  m=json.loads(l)['message']; print('preamble has ephemeral/tmpfs memory text:', 'ephemeral' in m[:m.find('Task:')].lower()); break"

# 4. RAW written values (all single-version, no overwrites) + proof of NO agent-scope 16-* write
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"prefix":{"key":"16-"}},"_source":{"includes":["key","scope","id","createdBy"]}}'

# 5. Everything the three invocations did against the store (MCP side)
grep -nE 'Assembled bootstrap|Embedded document|context_query' logs/mcp-server-20260524T003426.jsonl \
  | grep -E 'd14b97a0|6c5350ae|1e8c7b6d'

# 6. B2 grounding — agent scope keyed on correlationId, identically to conversation scope
grep -n "scope === ContextScope.project ? undefined : correlationId" apps/mcp-server/src/mcp/mcp.service.ts  # :789 (write) and :848 (read)

# 7. B3 grounding — actual SYSTEM_PREAMBLE section count (10, not the note's "5"/6)
awk '/^export const SYSTEM_PREAMBLE/,/^`;/' libs/common/src/prompts/role-prompt-templates.ts | grep -cE '^## '

# 8. E7 verbatim-D7 check — shipped paragraph == roadmap D7 "Memory Redirect"
sed -n '/## Agent Memory/,/^`;/p' libs/common/src/prompts/role-prompt-templates.ts | head -4
grep -n -A2 'Claude Code memory' tickets/8-workspace-isolation.md | head

# (store left running; stop with: docker stop quorum-opensearch-1)
```