# #31 Tool-Guard Namespaced Skill Matching — Context-Access Audit

**Date compiled:** 2026-06-11
**Parent index:** [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) (§3 "#31")
**Ticket:** `tickets/31-tool-guard-namespaced-skill-matching.md` · **PR:** #32
**Audit scope:** every Context Store access point (bootstrap injection / search / get / write) touched on behalf of ticket #31, chronologically, with the saved text or query + returned result rendered RAW, followed by a quality / re-usability / added-value assessment of each touch.

## Scope correction vs the index

The index lists **one** invocation for #31 (the 05-24 review). The full log sweep finds **five** teamlead invocations — the ticket also had a first review round and three empirical probes, all with context activity (bootstrap at minimum). Implementation itself predates the agent session entirely (host-side commits; **no developer-agent invocation exists for #31**), which makes #31 the session's only *review-only* context specimen.

| # | Time (UTC) | correlationId | Purpose | Agent log | Context events |
|---|---|---|---|---|---|
| I1 | 05-23 03:05:31 → 03:10:01 | `e8b1672f-0385-4586-b4f0-896355a9da8f` | `/code-review` round 1 (pre-revert state) | `teamlead-20260523T030410.jsonl` | bootstrap **E1** · write **E2** · **zero searches** |
| I2 | 05-23 03:17:12 → 03:17:22 | `331694f8-35fb-4f01-b4e9-0d00452a2243` | probe (Test A), 1 turn | `teamlead-20260523T031532.jsonl` | bootstrap **E3** only |
| I3 | 05-23 03:21:26 → 03:21:41 | `21e07e34-f43d-4a1f-8641-042469314f47` | probe (Test A re-run), 1 turn | `teamlead-20260523T031933.jsonl` | bootstrap **E4** only |
| I4 | 05-24 00:25:50 → 00:26:10 | `ec694b40-f156-402a-ad77-fc94aa2c086a` | "DIAGNOSTIC PROBE for #31" (Test B), 3 turns | `teamlead-20260524T002402.jsonl` | bootstrap **E5** only |
| I5 | 05-24 00:36:42 → 00:45:28 | `d19221c5-c194-4a62-b593-ff5b81b0c637` | `/code-review:code-review` round 2 — the live test + final accept | `teamlead-20260524T003432.jsonl` | bootstrap **E6** · search **E7** (trace L1) · write **E8** |

No conversation-scope or agent-scope reads/writes occurred for #31 at any point — unique among the session's tickets. The moderator issued no `context_query` for #31 either (its only two store reads of the session were both for #11).

**Key version fact the index misses:** `project:_:31-project-notes` exists in **two versions**. v1 was written by I1 at 05-23 03:09 (embedded `mcp-server-20260523T030404.jsonl:162`); I5's search at 05-24 00:37 retrieved **v1**; I5 then **overwrote** it with v2 at 00:45 (`mcp:226`). Only v2 survives in OpenSearch today.

---

## Data recovery method

Logs alone cannot render the RAW saved values: `ClaudeCodeService` truncates `SDK tool start` payloads at ~246 chars, the MCP server logs writes as bare `Embedded document [key]` events (index gap G3), and the trace stream stores ~200-char snippets. Full document bodies were recovered by **starting the stopped `quorum-opensearch-1` container** (data volume `quorum_opensearch-data` intact) and querying the `quorum-context` index directly:

```bash
docker start quorum-opensearch-1
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"terms":{"key":["31-project-notes","QRM5-BUG-002-project-notes","29-project-notes"]}},
       "_source":{"excludes":["embedding"]}}'
```

Limitation: OpenSearch keeps only the **latest** version per key. v1 of `31-project-notes` is overwritten and survives only as three fragments (log prefix, trace snippet, token estimate) — rendered at E2. Everything else below is verbatim-complete.

The bootstrap item *keys and full text* (index gap G2) were recovered from the agent-side `=== Initial prompt ===` debug line in each teamlead log, which embeds the rendered `## Prior Decisions` block verbatim.

---

## Chronological access-point audit

### E1 — Bootstrap injection, review round 1 (I1, 05-23 03:05:31)

`BootstrapContextService` assembled **4 items, 573 tokens, scopes=[project, conversation]** (`mcp-server-20260523T030404.jsonl:109`). Conversation partition was empty (fresh correlationId), so all 4 items are project scope. Rendered into the user prompt as:

```
## Prior Decisions

### Project Context
- 29-project-notes: "PR #30 code review accepted for ticket #29 (agent plugin install at
  entrypoint). Key outcomes: (1) Entrypoint plugin seed pattern established for agent containers —
  cp -r from workspace bind mount source (docker/plugins/<name>/) into CC CLI cache path
  (~/.claude/plugins/cache/<org>/<name>/<version>/) plus installed_plugins.json heredoc. This is
  the canonical approach for making CC CLI plugins available on agents' tmpfs. Applies to
  docker/agent/entrypoint.sh. (2) Plugin discovery confirmed: CC CLI finds the seeded plugin and
  registers it in the available skills list as 'code-review:code-review' (plugin-namespaced form:
  {plugin-name}:{command-name}). (3) Pre-existing bug discovered: tool-guard-hook.ts allowedSkills
  uses bare names ('code-review') while CC CLI registers plugin skills in namespaced form
  ('code-review:code-review'). Strict includes() check fails — no agent can dispatch any
  plugin-provided skill despite correct installation. This predates #29 (from QRM5-BUG-002) and
  needs a follow-up ticket. (4) Dockerfile COPY at line 91 bakes plugin to
  /mnt/quorum/workspace/.claude/plugins/code-review, but the workspace bind mount masks this at
  runtime — the baked path doesn't exist in running containers. CODE_REVIEW_PLUGIN in
  role-tool-profiles.ts references this dead path. The entrypoint seed is the only working
  mechanism. (5) No source code changes — shell entrypoint only. Test suite unchanged at 784
  tests, 46 suites. (6) Scope: exactly 2 files (entrypoint.sh + ticket MD). (7) warn-and-continue
  posture when plugin source absent — correct, agent is still useful without /code-review.
  (8) Unblocks end-to-end /code-review dispatch once the allowedSkills mismatch is fixed in a
  follow-up."                                                                  [≈428 tokens]
- two-tier-billing-docs: "Documented the two-tier billing split in docs/system-design.md (line
  377, after the x-shared-env table). Agents authenticate via ANTHROPIC_API_KEY on x-shared-env
  (metered API billing); the moderator authenticates via CLAUDE_CODE_OAUTH_TOKEN in its own
  environment block (flat-rate subscription-seat billing). These are deliberately separate — the
  subscription token must never appear on x-shared-env. References QRM7-007 and QRM7-013 tickets
  inline. Commit 9a65379 on QRM7-000-roadmap-staging."                         [≈120 tokens]
- qrm6-rerun-elicit-A: "QRM6 elicitation round-trip RERUN verified"            [≈12 tokens]
- elicitation-test-A: "QRM6 elicitation round-trip verified"                   [≈10 tokens]
```

**Quality feedback:**
- **Quality: accidentally excellent at the top, garbage at the tail.** `29-project-notes` is the single most relevant record in the entire store for this review — items (2)–(4) state the namespaced-form discovery, the latent tool-guard bug, and the dead Dockerfile path, i.e. the exact problem statement of #31. The two elicitation records are month-old QRM6 test residue (written 04-25 and 05-02) with zero relevance to anything; they rode along in **every one of the session's 34 bootstraps**.
- **Re-usability: high but unattributable to design.** The relevance of `29-project-notes` here is luck, not selection (see cross-cutting finding B1: `getAll` is unsorted under OpenSearch, so "prefer newer" selection is broken; ~110 project docs existed and the budget admits only whichever small-enough docs surface near the tail of an arbitrary ordering).
- **Added value beyond `docs/`+`tickets/`: real for item (3).** At E1 time, the ticket file `31-…md` already restated all of this — but the bootstrap is what carried the *predecessor's* findings into the review before the agent read anything. For the probes (E3–E5) it was the only context they got. The billing record and elicitation strings added nothing: billing is fully documented in `docs/system-design.md` (the record even says so), and the test strings are noise.

### E2 — Write `project:_:31-project-notes` **v1** (I1, 05-23 03:09:48)

The review-round-1 verdict synthesis, written by the teamlead after accepting the **pre-revert** state of PR #32 (the state that still included the "remove dead SDK plugins-param machinery" commit `59b81e4`). RAW value is **only partially recoverable** — overwritten by E8. The three surviving fragments:

Fragment 1 — agent-log tool-call prefix (`teamlead-20260523T030410.jsonl:123`, logger-truncated):

```
mcp__quorum__context_store {"scope":"project","key":"31-project-notes","value":"PR #32 code
review accepted for ticket #31 (tool-guard namespaced skill matching + dead-path cleanup).
Key outcomes:\n\n(1) Plugin-namespace…
```

Fragment 2 — trace-stream snippet of the same doc as returned at E7 (~200 chars):

```
"PR #32 code review accepted for ticket #31 (tool-guard namespaced skill matching + dead-path
cleanup). Key outcomes:\n\n(1) Plugin-namespaced skill normalization established in
tool-guard-hook.ts. Th
```

Fragment 3 — metadata: `tokensEstimate=674` (trace L1), embedded 05-23 03:09:50.124 (`mcp-server-20260523T030404.jsonl:162`), `createdBy=teamlead`.

**Quality feedback:**
- **Quality: defective at the knowledge level — it recorded an acceptance of a state that was disconfirmed hours later.** The title fragment "dead-path cleanup" shows v1 blessed the over-aggressive machinery removal that smoke verification then disproved (revert `9a1cb8c`). The store had no mechanism to flag, supersede, or retract it; it sat as the top-scoring authority on #31 for 21 hours.
- **Re-usability: consumed exactly once (E7) — by the invocation whose job was to re-review the state v1 misdescribed.** The staleness was harmless only because the consumer's mandate ("the branch had a revert mid-history… the final approach in 6b72f29 is the live one") came from the **moderator's prompt**, not from the store. Had a different agent searched "plugin path" knowledge between 05-23 and 05-24, v1 would have served confirmed-wrong guidance ("dead code removed, accepted") at score 1.0.
- **Added value beyond `docs/`+`tickets/`: negative at time of writing.** The ticket file in the same repo state was the accurate spec; v1 added a parallel, soon-to-be-wrong summary of it. This is the audit's clearest specimen of the *premature synthesis* failure mode: project-notes written at "accept" time inherit any error in the accept verdict and have no revision trail (the overwrite at E8 destroyed v1 entirely — this audit could not even recover it).

### E3 / E4 / E5 — Bootstrap injections into the probes (I2, I3, I4)

Identical assembly each time: **4 items, 573 tokens** (`mcp-server-20260523T030404.jsonl:342, :483, :6818`) — byte-identical item set to E1 (verified via the initial-prompt debug line in each probe's log). Probes performed zero context reads/writes of their own; I2/I3 completed in 1 turn, I4 in 3 turns.

**Quality feedback:**
- **Quality/re-usability: not applicable — the probes were instructed empirical tests** ("do not perform any co[de work]…"), their value was the side-channel observation of whether `code-review:code-review` appeared in the skills list.
- **Added value: zero; pure overhead.** 3 × 573 ≈ 1.7k tokens of injected context for invocations that by design needed none. Notably the probe protocol and Test A/B results — the most distinctive empirical knowledge #31 produced (SDK loads `plugins:` path directly, no `installed_plugins.json` fallback) — were **never written to the store by anyone**; they survive only in the ticket's Implementation Notes. The store captured the verdicts but not the experiment.

### E6 — Bootstrap injection, review round 2 (I5, 05-24 00:36:42)

**4 items, 573 tokens** (`mcp:120`) — the **same four items again**, rendered verbatim as in E1. The critical observation is what's missing: `31-project-notes` **v1 existed for 21 hours by now and was not injected**, while two QRM6 test strings were.

This is mechanically explained (cross-cutting finding B1/B2 below): the project-scope bootstrap budget is `1000 × 0.6 = 600` tokens; v1 weighs ≈674 tokens; `applyBudget` *skips* over-budget items and keeps filling with smaller ones (`bootstrap-context.service.ts:104-111`). **A standard `{ticket}-project-notes` record at the teamlead's customary level of detail can never be bootstrapped.** The only reason the review still had its predecessor context was that the 428-token `29-project-notes` fits under 600.

**Quality feedback:** same content assessment as E1, plus the structural finding — the bootstrap channel systematically excludes exactly the record family the role prompt tells the teamlead to write for cross-ticket reuse. Items are delivered newest-ish-first only by accident of index ordering; 2/4 slots wasted on noise; relevance is not query-aware (this is by design — bootstrap is assembled before the task is known to the store).

### E7 — Search, trace L1 (I5, 05-24 00:37:11)

The only deliberate retrieval of #31's lifecycle. The agent's tool call (`teamlead-20260524T003432.jsonl:48`):

```
mcp__quorum__context_query {"scope":"project","mode":"search",
                            "query":"ticket 31 tool-guard skill-name matching plugin namespaced"}
```

Engine `hybrid` (BM25 0.3 + k-NN 0.7), 499 ms, `maxTokens=2000`. 100 raw hits (k-cap — every doc in the index matches the k-NN leg), **3 returned**, `truncatedByTokenBudget=true`. Budget math: 674 + 568 + 428 = 1,670 consumed; rank-4 (583 tokens) would breach 2,000 → cut.

**Returned item 1 — `31-project-notes` (v1), score 1.00, 674 tokens.** Stale self-lineage; full text unrecoverable, fragments at E2.

**Returned item 2 — `QRM5-BUG-002-project-notes`, score 0.65, 568 tokens** (written 2026-04-16 by teamlead — 38 days earlier). RAW value (JSON-structured, recovered from OpenSearch):

```json
{
  "ticket": "QRM5-BUG-002",
  "status": "accepted",
  "summary": "SDK skills subsystem enabled; code-review plugin vendored; per-role skill filtering implemented",
  "deviations": "Plugin installed via COPY of vendored files instead of npx — claude-agent-sdk has no CLI bin entry. .dockerignore exceptions added for plugin files.",
  "patterns": {
    "per_role_skill_filtering": "Tool guard hook (tool-guard-hook.ts) now checks Skill tool calls against role's allowedSkills array. Early-return before bash/write checks. Pattern: add skill names to RoleToolProfile.allowedSkills.",
    "plugin_wiring": "Plugins pass through RolePermissionService.getPlugins() → InvocationHandler → ClaudeCodeService.execute() → SDK query(). Pattern: add { type: 'local', path } to RoleToolProfile.plugins.",
    "vendored_plugins": "External plugins are vendored in docker/plugins/<name>/ and COPY'd into agent image at /mnt/quorum/workspace/.claude/plugins/<name>. Requires .dockerignore exceptions for *.md and *.json files.",
    "slash_command_dispatch": "Actions starting with '/' bypass 'Task: ' prefix in InvocationHandler.buildPrompt() for direct SDK skill dispatch. Moderator prompt has routing table."
  },
  "integration_points": {
    "RoleToolProfile": "Now has allowedSkills: string[] and plugins: Array<{type,path}>. All 5 deployable roles configured.",
    "RolePermissionService": "New getPlugins() method — injectable via existing DI.",
    "InvocationHandler": "Wires plugins from permissions; detects slash-command actions for verbatim passthrough.",
    "ClaudeCodeService": "Accepts optional plugins in ExecuteParams; settingSources now ['project'] for all roles.",
    "Moderator_prompt": "New 'Skill Dispatch' section with routing table for /code-review and /simplify.",
    "invoke_agent_tool": "Action field description updated to document slash-command syntax."
  },
  "test_coverage": {
    "new_tests": 35,
    "new_suites": "tool-guard-hook (5 skill tests), role-tool-profiles (10 skill/plugin tests), role-permission.service (2 getPlugins tests), claude-code.service (2 plugin tests), invocation-handler (6 plugin+slash-command tests)",
    "total_tests": 593
  },
  "open_items": [
    "Zod v4 .describe() metadata verification — requires live agent invocation with debugFile",
    "ICEBOX session resume re-evaluation — requires sequential same-role invocations to test caching"
  ]
}
```

**Returned item 3 — `29-project-notes`, score 0.58, 428 tokens.** Byte-identical to the bootstrap item rendered at E1 — the full 428 tokens entered the same context window **twice**, eight minutes apart.

Below the cut (never seen by the agent): `QRM4-004-design-notes` 0.40, then a `QRM6-BUG-014-*` cluster at 0.29–0.33, `QRM5-005-design-notes` 0.27, … (97 more, all `includedInResult=false`).

**Quality feedback:**
- **Quality: the ranking is a genuine hybrid-search success — the top-3 are precisely the three-generation lineage of the defect** (#31 ← #29 ← QRM5-BUG-002, matching the ticket's own "Root Cause" attribution: "a QRM5-BUG-002-era latent defect… dormant until #29"). The query was well-formed for it (ticket number anchors BM25; "tool-guard / skill-name / plugin namespaced" carries the semantics). The index's F7 caveat applies: BM25 key-matching does much of the lifting; but rank-2 at 0.65 is a real semantic win — `QRM5-BUG-002-project-notes` shares no ticket number with the query.
- **But the index's "success case" framing needs a correction: the #1 hit was stale-wrong (v1, E2) and nothing signals it.** Scores are min-max normalized per query (top ≡ 1.00 — index F4), `createdAt` is not surfaced to the agent, and overwrite history doesn't exist. The agent had no way to see that its most authoritative hit described a reverted approach. Mitigated this time purely by the moderator's prompt.
- **Re-usability/added value of what was actually consumed:** Item 2 is the search's entire marginal value, and it's substantial: the four wiring patterns and six integration points are operational knowledge that exists in `tickets/QRM5-BUG-002-…md` but would never be *found* there — the agent had no reason to open a 5-week-old ticket file by name. Discovery-by-semantic-neighborhood is the added value, not content novelty. Note items now stale inside it: pattern `vendored_plugins` describes exactly the mechanism #29/#31 dismantled, and `total_tests: 593` vs the then-current 784 — partially decayed knowledge served without a freshness signal. Item 3's marginal value was **zero** (bootstrap duplicate). Net: of 1,670 returned tokens, ≈568 were new-and-useful, ≈674 new-but-stale, ≈428 duplicate.

### E8 — Write `project:_:31-project-notes` **v2** (I5, 05-24 00:45:12) — overwrite

The final synthesis, written 15 s before invocation completion. RAW value (complete, from OpenSearch; `createdAt=1779583512737` = 05-24T00:45:12.737Z, `createdBy=teamlead`):

```
PR #32 code review accepted for ticket #31 (tool-guard namespaced skill matching + plugin path
repoint). This is the SECOND review round — the first round reviewed a now-reverted
over-aggressive cleanup. This round reviews the final corrected state.

Key outcomes:

(1) Plugin-namespaced skill normalization established in tool-guard-hook.ts. The pattern: extract
bare name via `skillName.slice(skillName.lastIndexOf(':') + 1)` before checking against
allowedSkills. Role profiles use bare-name allowlists (e.g., `['code-review', 'simplify']`) and
any plugin providing a skill with that bare name is automatically permitted. The denial reason
preserves the original namespaced form for debuggability.

(2) CODE_REVIEW_PLUGIN.path repointed from the masked workspace path
(`/mnt/quorum/workspace/.claude/plugins/code-review`) to the entrypoint-seeded tmpfs location
(`/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown`). The SDK
requires this path to load plugin.json directly — it does NOT fall back to
~/.claude/plugins/installed_plugins.json discovery.

(3) Dead Dockerfile bake removed: COPY docker/plugins/code-review to
/mnt/quorum/workspace/.claude/plugins/code-review was always masked by the workspace bind mount
at runtime. The paired mkdir/chown entries also removed.

(4) SDK plugins-param machinery RETAINED as load-bearing: RoleToolProfile.plugins interface
field, plugins: [CODE_REVIEW_PLUGIN] entries for teamlead/architect,
RolePermissionService.getPlugins(), ExecuteParams.plugins, the params.plugins SDK spread, and the
InvocationHandler call site. The revert (9a1cb8c) corrected the initial over-aggressive removal.

(5) Test evolution: 46 suites, 788 tests (baseline 784 + 4 new skill-name tests in
tool-guard-hook.spec.ts). New tests cover: namespaced-allowed, multi-segment namespace,
namespaced-denied with reason, empty-allowlist with namespaced name.

(6) LIVE TEST PROOF: This review invocation was the first successful end-to-end
/code-review:code-review dispatch in the system's history. The moderator dispatched the
plugin-namespaced skill to teamlead → tool-guard accepted it → SDK loaded plugin from
entrypoint-seeded path → 5 parallel Sonnet auditors + 4 Haiku confidence scorers ran →
structured review posted on PR #32. This empirically closes the #15 → #27 → #29 → #31 bootstrap
chain.

(7) Minor observations (below review threshold, not blocking): trailing-colon edge case in
bareName extraction (empty string bypasses guard — theoretical, model won't generate this);
makeProfile test helper dropped plugins:[] default (type-only, zero runtime impact); hardcoded
"unknown" version segment duplicated between entrypoint.sh and role-tool-profiles.ts (future
fragility, not current bug).

(8) Forward compatibility: any future CC CLI plugin installed on agents only needs its bare
skill name added to the relevant role profile's allowedSkills array — no namespaced-form entries
needed.
```

**Quality feedback — checked against the shipped code and the ticket:**
- **Accuracy: verified high.** Every code claim matches the current tree: the bare-name extraction is at `apps/agent/src/config/tool-guard-hook.ts:35-37` exactly as described; `CODE_REVIEW_PLUGIN.path` is the seeded tmpfs path (`role-tool-profiles.ts:37-40`); the retained-machinery inventory in (4) matches reality. The trailing-colon observation in (7) is real and still present today: `'foo:'` → `bareName === ''` → falsy → `if (bareName && …)` short-circuits → **allowed** (`tool-guard-hook.ts:38`) — the note's risk triage ("theoretical, model won't generate this") is fair but it is a genuine allowlist bypass for a malformed input. One nit: the ticket promises *5* Haiku confidence scorers, v2 reports *4 ran* — v2 is the empirical record and is the more trustworthy of the two.
- **Quality as a record: the best-written project-note in this ticket's lineage, and a direct fix of v1's failure mode.** Leading with "SECOND review round — the first round reviewed a now-reverted over-aggressive cleanup" is exactly the supersession marker v1 lacked; a future reader of v2 cannot inherit the v1 error. Prose format follows the role-prompt guidance (embeds well), keys named per convention.
- **Added value beyond `docs/`+`tickets/`: thin — roughly 70 % of v2 restates the ticket file.** Items (1)–(5) and (8) are condensations of `tickets/31-…md` (Design, Implementation Notes, ACs), which any agent could read from the worktree. Unique-to-store content: (6) the live-test execution record with the actual pipeline composition (the ticket only promised this as future proof — written *post-merge*, the ticket's checkbox 10 remained `[~] pending`), and (7) the three below-threshold review observations, which appear **nowhere else** — not in the ticket, not in the PR comments' verdict summary's scope guard, not in docs. Ironically the store's most distinctive #31 knowledge is the part flagged "below review threshold."
- **Re-usability: zero to date.** No search, keys-read, or get has touched `31-project-notes` v2 in any trace/log through end of coverage (2026-05-28), and it can never enter a bootstrap (674-token v1 / ~830-token v2 vs the 600-token project budget — finding B2). Its realistic consumption channels are a future ticket's project-scope search landing on it as a lineage neighbor (plausible — that is exactly how this ticket consumed #29's and QRM5-BUG-002's notes) or a human/audit read like this one.

---

## Cross-cutting findings (new — beyond the index's F1–F7)

**B1 — Bootstrap "prefer newer" is broken under the OpenSearch backend.** *(Filed 2026-06-11: issue [#55](https://github.com/ia64mail/quorum/issues/55), spec `tickets/55-bootstrap-getall-recency-ordering.md`, PR #57.)* `BootstrapContextService.applyBudget` reverses `Object.entries(items)` "to prefer newer items (later in Map insertion order)" (`bootstrap-context.service.ts:101-102`) — an InMemoryStore assumption. The production path `OpenSearchStore.getAll` issues a filter-only query with **no `sort` clause** (`opensearch-store.ts:171-178`): document order is internal Lucene `_doc` order — insertion-correlated at best, scrambled by segment merges, and never contractual. The observed effect across all 34 session bootstraps: a near-static 4-item set (549–598 tokens) regardless of what was written meanwhile. Fix is one line (`sort: [{ createdAt: 'desc' }]` + drop the `.reverse()` for that backend), worth a ticket before the next measurement session.

**B2 — The bootstrap budget structurally excludes the records agents are told to reuse.** *(Filed 2026-06-11: issue [#56](https://github.com/ia64mail/quorum/issues/56), spec `tickets/56-bootstrap-budget-sizing.md`, PR #58 — depends on #55. Resolution: `BOOTSTRAP_MAX_TOKENS` 5000 + `BOOTSTRAP_PROJECT_RATIO` 0.8; Opus 4.8 cost ~$0.10/long invocation.)* Project budget = `BOOTSTRAP_MAX_TOKENS(1000) × BOOTSTRAP_PROJECT_RATIO(0.6) = 600` tokens (`bootstrap.config.ts`), while the teamlead's role prompt mandates `{ticket-id}-project-notes` synthesis records that in practice weigh 425–674+ tokens each. `applyBudget` skips any item that would overflow and **continues** filling with smaller ones (`bootstrap-context.service.ts:106-108`) — so big fresh synthesis notes lose their slot to small stale residue (`elicitation-test-A`, 10 tokens, written 04-25, injected in all 34 bootstraps). Either budget ↑, ratio rebalance, per-item cap awareness at write time, or bootstrap-targeted record curation is needed.

**B3 — Project-notes overwrite destroys revision history and this matters in practice.** #31 is an existence proof: v1 recorded a wrong acceptance, was the store's top-ranked #31 authority for 21 h, and was then silently replaced — this audit could not recover its full text from any source. Anything that consumed v1 in that window has an untraceable provenance. A `createdAt`/supersedes surface in search results (or append-with-version keys) would make staleness at least visible; v2's prose supersession marker is the manual workaround done right.

**B4 — The store captured verdicts, not experiments.** #31's most valuable, hardest-won knowledge — the Test 0/A/B probe matrix proving the SDK loads `plugins:` paths directly with no `installed_plugins.json` fallback — exists only in the ticket file. Three probe invocations ran (I2–I4) and wrote nothing. If the ticket file had been lost or the finding needed by another container's debugging session, the store offers only v2's one-line echo of the conclusion in item (2). The "store decisions so others can find them" prompt guidance is consistently honored for *outcomes* and consistently ignored for *evidence*.

**B5 — Within-window duplication: bootstrap and search are not deduplicated against each other.** E6 injected `29-project-notes` (428 tokens); E7 returned it again 8 minutes later in the same context window. With the search budget at 2,000 and the duplicate occupying 26 % of the returned payload, a `excludeKeys=[bootstrapped…]` parameter (or result-side dedup by the MCP server, which knows both) is a cheap win.

## Verdict summary — every touch graded

| Event | Type | Knowledge quality | Re-used? | Added value beyond docs/+tickets/ |
|---|---|---|---|---|
| E1 | bootstrap read | top item excellent, 2/4 items noise | n/a (delivery) | **High** — carried #29's discovery into round 1 unprompted |
| E2 | write v1 | **defective** — premature accept of reverted state | once (E7), as a stale hit | **Negative** — wrong parallel summary of an accurate ticket |
| E3–E5 | bootstrap reads ×3 | same as E1 | n/a | **Zero** — probes needed no context; ~1.7k tokens overhead |
| E6 | bootstrap read | same as E1; missing the one #31-specific record (B2) | n/a | Moderate — repeat of E1's value for round 2 |
| E7 | project search | ranking excellent (lineage top-3); #1 hit stale-wrong, unsignaled | — | **Moderate-high** — QRM5-BUG-002 wiring patterns via semantic discovery; 26 % of payload duplicated bootstrap |
| E8 | write v2 | high accuracy (code-verified); explicit supersession marker | **never** (through 05-28) | **Thin** — ~70 % ticket restatement; unique: live-test record + 3 below-threshold code observations |

**Bottom line for the parent research:** #31's review pipeline ran on three channels — ticket file (spec + history), moderator prompt (commit list, revert warning, focus areas), and Context Store. The store's net contribution was one genuinely valuable semantic-neighborhood retrieval (QRM5-BUG-002 patterns) and one lucky-but-broken bootstrap hit (#29 notes), purchased at the cost of a stale top-ranked record, ~30 % duplicated/noise payload tokens, and two synthesis writes of which one was wrong-then-destroyed and the other is so far write-only. The addressing bottleneck thesis (index F3) holds here in inverted form: nothing pointed at `31-project-notes`, so nothing ever read it back.

## Appendix — reproduction

```bash
# All five #31 invocations
grep -n 'Invocation received' logs/teamlead-20260523T0304*.jsonl logs/teamlead-20260523T031*.jsonl \
  logs/teamlead-20260524T002402.jsonl logs/teamlead-20260524T003432.jsonl | grep -i '31\|PR #32'

# Bootstrap item keys+text for any invocation (gap G2 workaround):
# the '=== Initial prompt ===' debug line embeds the rendered '## Prior Decisions' block
python3 -c "import json;[print(json.loads(l)['message']) for l in open('logs/teamlead-20260524T003432.jsonl') if 'Initial prompt for correlationId=d19221c5' in l]" | sed -n '/## Prior Decisions/,/^\/code-review/p'

# Full L1 trace with all 100 scored hits
jq -c 'select(.extra.queryId|startswith("e6cc58bb"))' logs/context-search-20260524T003426.jsonl

# Live store retrieval (container left running after this audit; stop with: docker stop quorum-opensearch-1)
docker exec quorum-opensearch-1 curl -s 'http://localhost:9200/quorum-context/_search' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"term":{"key":"31-project-notes"}},"_source":{"excludes":["embedding"]}}'
```