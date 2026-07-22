# Quorum QRM9 — Stabilization (Context-Management Rework)

**Date:** 2026-07-21
**Milestone:** QRM9 (Stabilization)
**Development:** Multi-agent dogfooding (Quorum system self-implementing — Claude Code CLI moderator; agents bumped mid-milestone to Claude Opus 4.8 on Claude Agent SDK 0.3.207 / CC CLI 2.1.207 via #68)

## Summary

QRM9 began as a catch-all wave of small, unrelated post-QRM8 correctness and hygiene fixes landing off `main`. A deep audit of the QRM8 reference session (2026-05-24 → 05-27) reclassified the milestone: its central theme became a **broad bugfix/refactor of context management**, because the Context Store — the mechanism every agent relies on to share knowledge across invocations — was found to be **largely non-functional in practice**. The milestone title, GitHub issue (#49), and branch (`49-stabilization`) are unchanged; the scope shift is internal, from "assorted small fixes" to "context-management stabilization, plus residual hygiene."

The audit's headline finding was stark: across one 34-invocation session, **32 of 39 written context records were never read by any agent**. The failure was not semantic-search quality — hybrid BM25 + k-NN retrieval worked whenever data sat in a reachable partition — but **scope addressing**. Three defects made most of the store unreadable in production: **#55** — `OpenSearchStore.getAll()` issues a filter query with no `sort` clause, so bootstrap's "prefer newest" `.reverse()` heuristic (valid only for the in-memory dev store) delivered a quasi-static, month-old 4-item block on all 34 invocations; **#56** — the project bootstrap budget (`1000 × 0.6 = 600` tokens) was structurally smaller than a typical `{ticket}-project-notes` record (425–2180 tok), so the more thorough the note, the less likely it was ever read; and **#59** — agent scope, intended (since QRM8 #16) as durable role memory, was keyed by `correlationId` identically to conversation scope, so every later same-role invocation queried a different, empty partition (6/6 agent searches and 7/7 get-alls returned 0). The context-management wave closes these plus **#61** (search skip-and-stop admission empties the result set when the top-ranked hit alone exceeds the budget — the search-channel analogue of #56), **#63** (moderator-bound `correlationId` reuse so a ticket's collaborating agents share one conversation partition), **#70** (task-aware project-scope bootstrap ranked by a moderator-authored `searchQuery`, realizing the audit's design-conclusion #4), and **#74** (the latent `getAll` 10,000-doc-cap × ascending-sort truncation, closed as superseded by #70's move off `getAll`).

The infrastructure & runtime wave hardens the QRM8 isolation model against live-fire failures: **#65** rewrites `commitAndPush` to push anything ahead of `origin/<branch>` (agent commits were orphaning in the shared clone), with a tokenized deny-guard replacing brittle prefix-matching; **#67** closes a multi-`-c` deny-guard bypass surfaced in #65's review; **#68** bumps the Claude Agent SDK (`0.2.123 → 0.3.207`), CC CLI (`2.1.126 → 2.1.207`), and default model (`claude-sonnet-4-5 → claude-opus-4-8`), absorbing 0.3.x breaking changes; **#78** fixes an `EACCES` on the root-owned session-store volumes that had silently defeated FileSessionStore durability on 0.3.207; **#79** repairs commit-message extraction that corrupted the commit subject when an agent merely *mentioned* the `<commit-message>` marker in prose; **#80** wires a per-role `ANTHROPIC_MODEL` override via environment; **#87** stops the deep-tier `/code-review` skill from silently dying inside a single-shot agent invocation under CC CLI 2.1.207's background-agent default; and **#92** is an operational runbook for rotating a stale `CLAUDE_CODE_OAUTH_TOKEN` that shadows fresh `/login` credentials. Residual hygiene lands the entropy-report Halstead-correctness fix (**#50**), the ticket-library "truth about a change, not the present" consumption discipline (**#51**), the agent-prompt actualization pass (**#76**), the review-tier-drift binding (**#81**), and a doc/runbook drift-cluster cleanup surfaced by #68's verification runbook (**#84**).

QRM9 is the **sixth milestone implemented by the Quorum agent system itself**, and the first whose primary discovery surface was a **forensic audit of a prior milestone's own run logs** — the QRM8 context-usage research vendored alongside the epic — rather than live-run field observation. It is also the first milestone in six to **break the zero-post-review-fix streak** (QRM4 → QRM8): three tickets required post-review corrections, all caught by team-lead code review before merge, all documented below.

## Scope

### Context management (central theme)

| ID | Title | Status |
|----|-------|--------|
| #55 | Bootstrap — recency ordering broken under OpenSearch (`getAll` unsorted) · PR #57 | Done |
| #56 | Bootstrap — token budget excludes project-notes records (depends on #55) · PR #58 | Done |
| #59 | Context Store — agent scope provides no cross-invocation role persistence; role-key the partition · PR #60 | Done |
| #61 | Context search — skip-and-stop budget empties result set on oversized top hit; add return-at-least-one floor · PR #62 | Done |
| #63 | Conversation-scope addressing — moderator-bound `correlationId` reuse across collaborating agents · PR #64 | Done |
| #70 | Bootstrap — task-aware project-scope selection via moderator-authored `searchQuery` · PR #71 (+ observability PR #91) | Done |
| #74 | Bootstrap at scale — `getAll` 10,000-doc cap × ascending sort drops the newest records · PR #75 | Done (closed — superseded by #70) |

### Infrastructure & runtime stabilization

| ID | Title | Status |
|----|-------|--------|
| #65 | Worktree commit/push hardening — agent commits orphan in the shared clone · PR #66 | Done |
| #67 | Deny-guard multi-`-c` bypass + `system-design.md` doc staleness (#65 follow-ups) · PR #90 | Done |
| #68 | Bump Claude Agent SDK + CC CLI to latest; default to Opus 4.8 · PR #69 | Done |
| #72 | Increase teamlead invocation timeout 10 → 15 min for `/code-review` · PR #73 | Done |
| #78 | Session-resume durability broken on SDK 0.3.207: FileSessionStore bypassed, transcripts on tmpfs · PR #83 | Done |
| #79 | Commit-message extraction corrupts commit when an agent mentions the `<commit-message>` marker in prose · PR #86 | Done |
| #80 | Per-role agent model override via environment · PR #85 | Done |
| #87 | Deep-tier `/code-review` skill does not complete inside a single-shot agent invocation · PR #88 | Done |
| #92 | Moderator forced re-login — stale `CLAUDE_CODE_OAUTH_TOKEN` shadows fresh `/login` credentials · PR #93 | Done |

### Residual hygiene

| ID | Title | Status |
|----|-------|--------|
| #50 | Entropy report — Halstead score & chart calculation correctness | Done |
| #51 | Ticket library — "truth about a change, not current state" consumption discipline | Done |
| #76 | Agent prompt actualization — review built-in role prompts + `quorum.md`; land tested ticket-consumption guidance · PR #77 | Done |
| #81 | Review Protocol tier drift — bind review tiers to their skills, ban retroactive skill runs · PR #82 | Done |
| #84 | Doc/runbook drift cluster from #68 verification — 4 stale doc references + Check-10 expected-absent list · PR #89 | Done |

**22 tickets total** (1 epic + 21 sub-issues). **21 Done**, of which **1** (#74) closed without implementation as superseded by #70. No tickets skipped.

## Bug Tickets

QRM9 continues the QRM7/QRM8 model of promoting defects to first-class tickets rather than a `QRM9-BUG-*` numbering convention. Unlike QRM7 (live-run field discovery) and QRM8 (implementation/integration discovery), QRM9's central cluster was surfaced by a **forensic audit of the QRM8 reference session's run logs** — the vendored `research-qrm8-*-context-audit.md` documents alongside the epic. The table maps each defect class to its fixing ticket:

| Defect class | Discovered | Ticket | Root cause / fix |
|--------------|-----------|--------|------------------|
| Bootstrap delivers a stale, quasi-static block; project records written during a session never surface | QRM8 audit (F-series) | #55 | `OpenSearchStore.getAll()` had no `sort` clause; consumer `.reverse()` assumed insertion order (true only for `InMemoryStore`). Added `sort: [{ createdAt: 'asc' }]`, restoring the oldest→newest contract for both backends. |
| Bootstrap budget structurally excludes the very records written for reuse | QRM8 audit (#13 refinement) | #56 | `1000 × 0.6 = 600`-tok project budget < typical `*-project-notes` record. Raised `BOOTSTRAP_MAX_TOKENS`/`BOOTSTRAP_PROJECT_RATIO` defaults to `5000`/`0.8` (4000-tok project budget) in `bootstrap.config.ts`; mirrored in `docker-compose.yml` `:-` defaults. |
| Agent scope is structurally dead — no cross-invocation role persistence | QRM8 audit (#59) | #59 | Agent scope keyed by per-invocation `correlationId` identical to conversation scope (`mcp.service.ts:787-789` write, `:848` read). Added `resolveScopeId()` keying agent scope by `state.role` (`agent:<role>:<key>`). |
| Search returns empty when the top-ranked hit alone exceeds the budget | #56 budget analysis | #61 | `context_query mode=search` used skip-and-stop admission; live `*-design-notes` (~2180 tok) vs 2000 default emptied the set. Added an `isTopHit` return-at-least-one floor in both stores; raised `CONTEXT_DEFAULT_MAX_TOKENS` `2000 → 3000`. |
| Conversation scope is write-only across invocations; only the moderator can reach a foreign partition | QRM8 audit | #63 | Moderator minted a fresh `correlationId` per user turn, fragmenting one ticket's partitions. Rewrote the moderator Turn Lifecycle to a work-unit binding model (mint on new work unit, reuse via explicit `invoke_agent(correlationId=…)`); corrected 3 passages falsely claiming `new_conversation` clears cached sessions. |
| Bootstrap is recency-driven but not task-aware | QRM8 audit (design-conclusion #4) | #70 | Added optional moderator-authored `searchQuery` to `invoke_agent`; `selectProjectItems` now ranks project records via relevance search on OpenSearch (recency `getAll` fallback for InMemory / absent query / empty search); broker strips `searchQuery` before delivery. |
| `getAll` 10k-doc cap × ascending sort silently drops the newest records at scale | #55/#56 seam analysis | #74 | Latent today (~117 records); closed as superseded by #70 moving the primary bootstrap path off `getAll`. Residual seam and an `InMemoryStore.set()` upsert-position defect carried forward. |
| Agent commits orphan in the shared clone instead of reaching origin | #12/#65 integration | #65 | `commitAndPush` returned early on a clean tree and never pushed pre-existing commits. Rewrote to push anything ahead of `origin/<branch>` (`countAhead`/`pushWithRebaseRetry`); worktree reset-to-origin on entry; tokenized deny-guard (`splitShellSegments`/`matchesDeniedVerb`) replacing prefix match; regression test pins `SDK_ENV_ALLOWLIST` to exclude `GH_TOKEN`/`GIT_CONFIG_GLOBAL`. |
| Deny-guard bypassed by ≥2 leading `-c`/`-C` git flags; `system-design.md` stale | #65 code review | #67 | `extractSegmentHead` stripped only the first leading flag. Replaced the single `.replace()` with a repeat-until-stable `do/while` loop; refreshed `system-design.md:161`/`:202` push/allowlist docs. |
| SDK 0.3.207 durability regression — FileSessionStore silently bypassed | #68 runbook (Finding 3) | #78 | `FileSessionStore.append()` hit `EACCES` on root-owned `/var/agent-sessions` volumes (missing from Dockerfile chown). Added the path to `Dockerfile:83-87`; reverted the eager-flush spike; added a `system/mirror_error` warn branch. Phase-3 durability gate PASS (codeword recalled across `--force-recreate`). |
| Commit corrupted when an agent mentions `<commit-message>` in prose | #68 runbook (Finding 4) | #79 | `extractCommitMessage()`'s single non-greedy regex spanned prose→real-close. Rewrote to select the last well-formed pair via `findLastPair()` (`lastIndexOf` scan); iterative right-to-left removal preserves the two-genuine-blocks case. Live instance: commit `baec262` subject `` ` block. ``. |
| Deep-tier `/code-review` silently dies in single-shot invocation on 0.3.207 | #72/#81 review-cost analysis | #87 | CC CLI 2.1.207 runs skill Agent/Task sub-agents in background by default; the single-shot invocation ends at the first `result` frame, killing them. PreToolUse hook rewrites `Agent` calls to `run_in_background: false`; `ScheduleWakeup` added to `COMMON_DISALLOWED_TOOLS`; Guard C returns a non-success envelope on `terminal_reason === 'background_requested'`. |
| Moderator forced re-login every session; fresh `/login` silently shadowed | Field observation | #92 | Stale `CLAUDE_CODE_OAUTH_TOKEN` env var outranks the fresh `/login` `~/.credentials.json`. Operational rotation runbook (issue token → update `.env` → recreate → clear stale credentials → verify); no code change. |

12 distinct defect classes plus 4 hygiene/tooling items (#50, #51, #76, #81, #84) and 2 pure-config/infra enablers (#68 dependency bump, #80 model override). All discovered through the QRM8 audit, implementation, code review, or the #68 verification runbook — none reported by end users.

## Agent Implementation Accuracy

### Deviation Analysis

Across the 20 implemented tickets (excluding #74, closed without code, and #92, runbook-only), deviations from ticket specifications were self-reported in each ticket's Implementation Notes.

**Total documented deviations: 6**

| Category | Count | Ticket | Description |
|----------|-------|--------|-------------|
| Necessary addition | 1 | #68 | Forced peer-dep bump `@anthropic-ai/sdk 0.89 → 0.111` (required by 0.3.207, not in the change-set); Task-family deny expanded to 6 tools vs the 4 originally cited. |
| Implementation mechanism | 1 | #79 | Iterative right-to-left pair removal instead of a single-span strip — required to keep the existing two-genuine-blocks test passing. Net behavior identical. |
| Scope expansion (review-driven) | 1 | #76 | Part 3 (three-tier review model + full-report reporting discipline) added during PR #77 review; an L3 string was found in `invocation-handler.service.ts`, not `bootstrap-context.service.ts` as ticketed. |
| Proactive enhancement | 1 | #51 | Added a fourth discipline bullet ("Read a ticket whole, not a fragment") not in the original spec (spec updated pre-implementation, so delivered docs match). |
| Style / scope-trim | 1 | #72 | Code comment kept terse (`// 15 min — /code-review pipeline`); the spec's proposed inline rationale + #65 reference lives in the ticket instead. |
| Approach change | 1 | #50 | Comments scanned inline by the character lexer rather than via a `stripComments` pre-pass, so regex literals are never mis-eaten. |

**Key observations:**
- #70's three corrections (search-budget positional arg, schema-drift framing, added config getter) were **architect design-note corrections folded into the ticket before implementation began** — like QRM8's #12, they are pre-implementation spec fixes, not implementation deviations.
- All 6 deviations are additive, mechanical, or correctness-preserving; none is scope-trim that dropped required behavior or scope-bleed that added unrequested behavior.
- #56 and #59 recorded "None" while noting review-accepted additions (`docker-compose.yml` defaults for #56; a `context_query` conversation-scope no-`correlationId` guard flagged "acceptable scope creep" for #59) — borderline, folded into the accepted PR without a second round.

### Bug Analysis

- **0 bugs in QRM9's new code** — every defect QRM9 resolved was a pre-existing context-store, transport, packaging, or configuration issue exposed by the QRM8 audit or the #68 SDK/CLI bump, not a defect introduced by the fixes themselves. The post-review corrections below were caught **before merge**, so they never reached the codebase as bugs.
- **The zero-post-review-fix streak (QRM4 → QRM8) breaks.** Three tickets required post-review corrections, all caught by team-lead `/code-review` before merge:
  - **#70 (blocking)** — the Step-6 budget-reclaim `conversationBudget += projectBudget - projectTokensUsed` could go negative under #61's new top-hit floor, zeroing all conversation context; fixed with `Math.max(0, …)` clamps + 2 tests. The ticket's "Step 6: unchanged" claim was proven false and corrected. Its follow-up observability work (PR #91) had a second review correction (emit the trace before the hit-count guard).
  - **#68 (Round-2 blocker)** — post-runbook re-review relocated the agent uid-guard above tmpfs writes (commit `dfc49c4`) and corrected a comment-label typo; Round-2 also spun Findings 3/4 out to #78/#79 and doc drifts to #84.
  - **#76** — Part 3 and three post-review addenda (AC-1 grep-formula correction, a `quorum.md` git-discipline qualifier, a `docs/system-design.md` tool-count replica fix) were added during PR #77 review.
- **6 context-store items** (#55, #56, #59, #61, #63, #70, with #74 superseded): the milestone's core — an addressing/budget rework of the pull- and push-based context channels, validated by a follow-up empirical session (shared vs rotated `correlationId` → handoff vs no handoff, feeding #63).
- **4 packaging/runtime items** (#65, #68, #78, #87): worktree push correctness, the SDK/CLI/model bump, session-volume permissions, and the single-shot `/code-review` background-agent trap — three of them (#78, #79, #87) direct fallout of the #68 upgrade.
- **1 security-hardening item** (#67): the multi-`-c` deny-guard bypass, proactively identified during #65's code review.

## Dogfooding Validation

QRM9 was validated through progressive deployment on the `49-stabilization` staging branch. Each ticket was implemented by a Quorum agent, code-reviewed by the team lead, and merged via PR; integration was verified by running the Docker stack after merges. The distinguishing surface this milestone was **retrospective forensic analysis** — the fixes were driven by, and re-validated against, the QRM8 reference session's own logs.

| Surface | Span | Key findings |
|---------|------|--------------|
| QRM8 context-usage audit | 2026-05-24 → 05-27 (analyzed) | 34 invocations, 40 writes / 39 records, **32/39 never read**. Scoped the entire context-management wave (#55, #56, #59, #61, #63, #70, #74). |
| Context-management implementation | 2026-06-14 → 06-20 | #55/#56/#61/#59/#63 landed and merged (PRs #57/#58/#62/#60/#64); #63's design was confirmed by a shared-vs-rotated `correlationId` empirical session. |
| SDK/CLI/model bump verification | 2026-07-16 (#68 runbook) | The #68 verification runbook (Checks 0–13) surfaced #78 (EACCES), #79 (prose marker), #87 (single-shot `/code-review`), and the #84 doc-drift cluster — a cascade of upgrade fallout. |
| Session-store durability gate | 2026-07-16 | #78 Phase-3 gate PASS — codeword `SALAMANDER-78-EACCES-4471` recalled across `--force-recreate`, confirming FileSessionStore mirror durability on 0.3.207. |
| Review-tier cost calibration | 2026-07-12 → 07-16 | #81/#87 driven by an observed retroactive tier-3 fan-out (\$10.63 vs the \$1.8–\$2.7 band); `/review` tier live-validated at \$2.49, single skill run (PR #83). |

3 unique committers across the milestone: Ihor Cherednichenko (c) (58 commits), Quorum Agent (50), Igor Cherednichenko (23).

## Development Statistics

| Metric | Value |
|--------|-------|
| **Model** | Claude Opus 4.8 (agents, default set by #68) + Claude Code CLI 2.1.207 moderator; SDK/CLI/model bump landed mid-milestone (#68, 2026-07-16) |
| **Commits** | 131 (97 non-merge + 34 merges) |
| **Tickets** | 22 (1 epic + 21 Done; 1 superseded-in-place) |
| **Lines added** | 10,323 |
| **Lines removed** | 467 |
| **Net lines** | 9,856 |
| **Test suites** | 49 (+2 vs QRM8) |
| **Tests** | 948 (+109 vs QRM8) |
| **Total cost** | ~\$150 |

### Breakdown by Category

| Category | Added | Removed | Net |
|----------|-------|---------|-----|
| TypeScript — source | 903 | 199 | 704 |
| TypeScript — specs | 2,516 | 83 | 2,433 |
| Markdown (docs + tickets) | 6,435 | 77 | 6,358 |
| Config / Infra (JSON, YAML, Docker, sh, mjs) | 469 | 108 | 361 |

Spec growth outpaces source growth **~3.5×** — a hair below QRM8's 3.9× and the same handler-and-store-testing emphasis: the context-store rework's risk is integration correctness (budget admission, sort contracts, scope keying, the #61↔#70 budget-reclaim interaction), so the test surface (`bootstrap-context.service.spec.ts` alone +467, `mcp.service.spec.ts` +376) carries the weight. The Markdown category is heavy (6,358 net) because the epic vendors the seven QRM8 context-audit research documents (~2,150 lines) as standalone evidence, and the SDK-bump (#68), single-shot-`/code-review` (#87), and prompt-actualization (#76) tickets each carry deep investigation context.

### Cost Analysis

| Metric | Value |
|--------|-------|
| **Total milestone spend** | **~\$150** |
| Cost per closed ticket | ~\$7.14 (across 21 Done) |
| Cost per commit | ~\$1.15 |
| Cost per 1,000 net lines | ~\$15.22 |

The ~\$150 budget sits between QRM8's \$100 and QRM7's \$200. The rise over QRM8 reflects two cost drivers unique to QRM9: the **forensic audit phase** (reading and cross-referencing a full prior session's logs to scope the context-management wave) and the **three post-review correction cycles** (#70's blocking clamp fix, #68's Round-2 blocker, #76's review-stage additions), each of which re-ran a review pass. The per-ticket cost (\$7.14) remains among the lowest in project history — second only to QRM8 (\$6.25) — because 5 of the 21 tickets are documentation/config-only (#50, #51, #84, #92, #80) and the model bump (#68) itself standardized agents on Opus 4.8, whose faster reasoning offset the deeper review cycles.

### Effectiveness Ratios

| Ratio | Value |
|-------|-------|
| Bugs in new code | 0 |
| Post-review fix rate | 3/21 Done tickets (14%) |
| Deviation rate per closed ticket | 0.29 (6/21) |
| Supersession rate | 1/21 (5%) — #74 superseded by #70 |
| Bug discovery method | 100% pre-production (QRM8 audit + implementation + code review + verification runbook) |

## QRM1 → QRM2 → QRM4 → QRM5 → QRM6 → QRM7 → QRM8 → QRM9 Comparison

| Metric | QRM1 | QRM2 | QRM4 | QRM5 | QRM6 | QRM7 | QRM8 | QRM9 |
|--------|------|------|------|------|------|------|------|------|
| Feature tickets | 13 | 11 | 6 | 9 | 9 | 18 (mixed) | 8 | 21 (mixed) |
| Bug tickets | 4 | 6 | 15 | 6 | 13 | 0 (promoted) | 8 (promoted) | 0 (promoted) |
| Commits | 48 | 59 | 54 | 65 | 77 | 76 | 121 | 131 |
| Net lines | 26,552 | 8,597 | 6,825 | 11,587 | 4,483 | 9,063 | 6,397 | 9,856 |
| Net TypeScript (src + spec) | 8,257 | 3,579 | 2,419 | 6,034 | −2,489 | 3,029 | 2,029 | 3,137 |
| Bugs in new code per 1,000 TS LoC | 0.48 | 1.44 | 0 | 0 | 0 | 0 | 0 | 0 |
| Post-review fix rate | 23% | 45% | 0% | 0% | 0% | 0% | 0% | 14% |
| Deviation rate per closed ticket | 1.85 | — | 0.33 | 0 | 0.11 | 0 | 0.125 | 0.29 |
| Test suites | — | — | 39 | 49 | 44 | 45 | 47 | 49 |
| Tests | — | — | 537 | 760 | 681 | 758 | 839 | 948 |
| Total cost | ~\$80 | ~\$150 | ~\$50 | ~\$100 | ~\$150 | ~\$200 | ~\$100 | ~\$150 |
| Cost per closed ticket | ~\$6.15 | ~\$13.64 | ~\$8.33 | ~\$11 | ~\$16.67 | ~\$15.38 | ~\$6.25 | ~\$7.14 |

QRM9 sets a new high-water mark for tests (**948**, +109 vs QRM8's 839 — the largest single-milestone test gain since QRM5) and ties QRM5 for the top test-suite count (**49**). The commit count (131) is the highest of any milestone, driven by the PR-per-ticket workflow across 21 sub-issues plus the merge commits it generates. Two streaks that held for five consecutive milestones (QRM4 → QRM8) diverge here: **zero-bugs-in-new-code holds** (the three post-review corrections were caught before merge and never landed as defects), but the **zero-post-review-fix streak breaks at 14%**. This is the honest cost of the milestone's hardest ticket interaction — #61's new top-hit budget floor and #70's budget-reclaim math were designed in separate tickets and only collided at review — and of the #68 SDK bump forcing three downstream corrections. Compared to QRM7's "10 defect classes, mostly MCP-transport" and QRM8's "7 defect classes, mostly Docker packaging" profiles, QRM9's "12 defect classes, mostly context-store addressing" profile is the next layer down: the issues that only surface once the isolated, containerized system has *run long enough to be audited*.

## Documentation Updates

| Document | Change |
|----------|--------|
| `docs/context-store.md` | `getAll` ordering contract (#55); agent-scope role-keying (#59); Search Observability section (#70 follow-up); `CONTEXT_DEFAULT_MAX_TOKENS` 2000→3000 (#84) |
| `docs/context-management.md` | Bootstrap budget Pattern 4 (#56); search-floor and `context_summarize` budget (#61); role-keyed scope (#59); task-aware selection (#70) |
| `docs/system-design.md` | Push-gate + allowlist (`:161`, `:202`) now name `GH_TOKEN`/`GIT_CONFIG_GLOBAL` (#67); single-service recreate note (#68); tool-count replica (#76); agent-scope reworded to `agent:<role>:<key>` at `:327` (#84) |
| `docs/claude-code-sdk.md` | `ANTHROPIC_MODEL` default → Opus 4.8 (#68); new `<ROLE>_ANTHROPIC_MODEL` override row (#80) |
| `docs/message-broker.md` | `ROLE_TIMEOUTS` corrected — architect/teamlead 15 min, moderator entry added (#84) |
| `docs/mcp-connectivity.md` | teamlead timeout 10 → 15 min (#84) |
| `CLAUDE.md` (root) | Ticket-consumption discipline pointer (#51); prompt-actualization drift fixes (#76) |
| `quorum.md` | Review-tier↔skill binding, no retroactive skill runs, two-comment reporting carve-out (#81); actualization edits (#76) |
| `docker/moderator/CLAUDE.md` | Work-unit `correlationId` binding + Turn Lifecycle rewrite (#63); Failure Recovery site (#59); ticket-consumption pointer (#51); review-tier consistency (#81); actualization (#76); bootstrap `searchQuery` guidance (#70) |
| `tickets/README.md` | New "A Ticket Is the Truth About a Change, Not About the Present" subsection + whole-ticket-read discipline (#51, #76) |
| `.env.example` | Bootstrap-context and `CONTEXT_DEFAULT_MAX_TOKENS` sections (#56, #61); `ANTHROPIC_MODEL`/`<ROLE>_ANTHROPIC_MODEL` (#68, #80) |
| `docker/moderator/settings.json` | `permissionMode: "default"` (CC CLI 2.1.200 rename, #68); stale QRM5-era "ALWAYS `/code-review`" rule removed (#81) |
| `docker-compose.yml` | Bootstrap budget `:-` defaults (#56); per-role `ANTHROPIC_MODEL` env wiring (#68, #80) |

Two items live only inside their tickets by design: #92's OAuth-rotation runbook (operational, no repo change) and #74's supersession resolution.

## Entropy Report

Source-code entropy and cyclomatic reports were generated at milestone close: `tools/entropy-report/reports/entropy-20260722-024037.html` and `cyclomatic-20260722-024041.txt`. Both run on the post-#50 corrected lexer, so the figures are directly comparable to the QRM8 baseline (`entropy-20260530-013740.html`). Key findings (674 commits, full history):

- **Halstead Volume reached 1,584,775** across 19,838 LOC in 149 files — up from QRM8's 1,385,067 / 17,518 LOC / 147 files, a **+199,708 (+14.4%)** Volume gain over the QRM9 window with no single-commit spikes.
- **Difficulty broke above the plateau for the first time: 391.0 → 412.3 (+21.3).** From QRM2 through QRM8 the project held Difficulty inside a tight 340–392 band even as Volume tripled — the signature of new code built from an already-established vocabulary. QRM9 is the exception, and legibly so: relevance-ranked bootstrap selection, role-keyed scope partitions, budget-floor admission, and task-aware search introduced genuinely new operand vocabulary into `apps/mcp-server`, widening η rather than repeating known constructs. It marks the context-management rework as a true redesign, not incremental feature work.
- **The rise is vocabulary density, not branching** — confirmed by diffing the current cyclomatic snapshot against the prior one (`cyclomatic-20260607-010933.txt`, early-QRM9). Over the window the function count grew **1,521 → 1,718 (+197, ~13%)** and function-NLOC **13,377 → 15,567**, yet the decision-path distribution barely moved: average CCN **1.19 → 1.21**, median and p90 pinned at **1**, and only **one** new function crossed CCN 15 (**2 → 3 of 1,718**; max 25 → 30). Functions stay small (avg 8.8 → 9.1 NLOC, max 85 → 97) with near-zero interface width (avg 0.08 params). So the codebase absorbed a 13% larger function surface with essentially flat branching complexity — information-dense but structurally flat, the profile that stays testable, and consistent with the 948-test suite.
- **Per-app distribution** (union-map method, deliberately **not additive** to the project total): `mcp-server` 831,037 Volume (77 files, 11,042 LOC), `agent` 498,581 (40 files, 6,764 LOC), `common` 114,258 (32 files, 2,032 LOC). The MCP server remains the complexity centre and deepened its lead — its bootstrap-context, OpenSearch-store, and context-query paths absorbed most of the milestone's Volume (+94,988), while the `agent` app's +79,993 landed in the #65 worktree-push, #78 session-store, #79 commit-extraction, and #87 hook changes.
- **Estimated Bugs (E^⅔/3000) reads 251.0** (up from 221.4). As an aggregate over a 149-file monorepo it is a trend signal, not a count: the realized record across QRM4 → QRM9 is **0 bugs in new code**, with QRM9's three post-review corrections caught before merge.

---

*This release note documents the QRM9 milestone — the stabilization layer that reworks Quorum's context-management addressing after a forensic audit found 32 of 39 written context records were never read in practice. Validated through 131 commits, 21 closed tickets (12 context/runtime defect classes plus 5 hygiene items), zero bugs landed in new code, three pre-merge post-review corrections, and 948 passing tests across 49 suites. It is the first milestone whose primary discovery surface was a prior milestone's own run logs, and the first in six to break the zero-post-review-fix streak — an honest record of the cost of reworking a load-bearing subsystem. It continues tracking the effectiveness and reliability of multi-agent self-implementing development through the Quorum dogfooding process.*