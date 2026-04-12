# Quorum QRM4 — Bootstrap Context Injection

**Date:** 2026-04-11
**Milestone:** QRM4 (Bootstrap Context Injection)
**Development:** Multi-agent dogfooding (Quorum system self-implementing, Claude Opus 4.6)

## Summary

QRM4 makes agents context-aware from the first token by injecting bootstrap context at the Message Broker level. When the broker delivers an invocation, it now queries the Context Store for project-scope and conversation-scope decisions and attaches them to the request — eliminating the discovery phase where agents wasted turns querying for background they should already have. This milestone also delivers moderator prompt caching, cost tracking, context store search fixes, agent commit discipline, and incremental checkpointing guidance.

QRM4 is the **first milestone implemented by the Quorum agent system itself**, serving as a real-world dogfooding test of the multi-agent collaboration workflow. The system's own agents (developer, team lead, architect) implemented features, reviewed code, and committed changes across 12 orchestrated runs spanning 15 days. This dogfooding exercise surfaced 15 operational bugs — none in QRM4's feature code, all in pre-existing integration gaps and workflow inefficiencies exposed by sustained real usage.

## Scope

| ID | Title | Status |
|----|-------|--------|
| QRM4-001 | Extend InvokeRequest with bootstrapContext Field | Complete |
| QRM4-002 | Bootstrap Context Assembly Service | Complete |
| QRM4-003 | Message Broker Integration | Complete |
| QRM4-004 | Agent-Side Prompt Rendering | Complete |
| QRM4-005 | Unit Tests | Complete |
| QRM4-006 | Configuration & Documentation | Complete |

6/6 feature tickets completed. Bootstrap context injection validated end-to-end through dogfooding runs.

## Bug Tickets

| ID | Title | Discovered | Root Cause |
|----|-------|------------|------------|
| QRM4-BUG-001 | Logger Outputs "unknown" Role | Kickoff session | `APP_NAME` set as build arg but not runtime env var in docker-compose.yml. Logger fallback found neither `AGENT_ROLE` nor `APP_NAME` at runtime. Fixed by adding to `environment` block. |
| QRM4-BUG-002 | MCP Client Timeout Causes Duplicate Invocations | Kickoff session | MCP HTTP transport's ~60s default timeout fires before broker's role-based timeout (up to 30min). Client retries, broker continues → duplicate sessions. Fixed with configurable `MCP_REQUEST_TIMEOUT_MS` and custom fetch wrapper with `AbortSignal.timeout()`. |
| QRM4-BUG-003 | `nest` CLI Not Available in Agent Containers | Kickoff session | `ENV NODE_ENV=production` in agent Dockerfile caused `npm install` to skip devDependencies. Compounded by `node_modules/.bin` not in `$PATH` and npm cache on read-only filesystem. Fixed by removing `NODE_ENV=production`, adding PATH entry, redirecting cache to tmpfs. |
| QRM4-BUG-004 | Git Identity Not Configured in Agents | Kickoff session | No `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars in docker-compose.yml. Agents wasted 2+ turns self-recovering from "Author identity unknown" on every commit. Fixed by adding identity vars to `x-shared-env`. |
| QRM4-BUG-005 | Moderator Activity Feed | Kickoff session | `ChatService.processWithLoop()` executed tools silently — 5+ min black box during multi-agent invocations. Added `→`/`←` status lines around tool execution showing tool name, args, result summary, duration, and cost. |
| QRM4-BUG-006 | Error Reporting — Empty String Hides Failure Subtype | Run 5 | `??` (nullish coalescing) instead of `\|\|` (logical OR) in error handling. `errors: []` joined to `""` (falsy), but `??` only triggers on null/undefined → `message.subtype` never reached. Also added `numTurns` to failure logs. |
| QRM4-BUG-007 | Per-Role maxTurns Configuration | Run 5 | **Deferred.** SDK `maxTurns` semantics unclear — agents completing 30-40 turns despite `maxTurns: 20`. Implementing calibrated limits risks introducing tighter constraints than the SDK's effective default. |
| QRM4-BUG-008 | Incremental Context Checkpointing | Run 5 | Agent prompts only instructed context storage at task end. Long tasks that fail mid-run lose all progress. Added checkpointing guidance to system preamble and developer prompt. Prompt-only change. |
| QRM4-BUG-009 | Project-Scope Context Enrichment | Runs 4–6 | Only 1 project-scope item after 6 runs — no agent synthesized design decisions into project memory. Added architect review step and team lead synthesis responsibility to prompts. Prompt/workflow change. |
| QRM4-BUG-010 | maxTurns Default and Turn Waste | Runs 5, 7 | Hardcoded `maxTurns: 20` fallback conflicted with SDK semantics. TodoWrite consumed ~29% of turns. Removed hardcoded default (let SDK manage), disabled TodoWrite for developer role, added verification command chaining. |
| QRM4-BUG-011 | Moderator Cannot Discover Agent Checkpoints | Run 7 | `InMemoryStore.search()` only matched values, not keys. Moderator's `context_query(mode=search)` returned 0 items for valid checkpoints. Extended search to match against item keys, added DEBUG logging to context_query handler. |
| QRM4-BUG-012 | Moderator Prompt Caching and Cost Tracking | Gap analysis | Moderator sent full system prompt uncached on every API call; costs invisible. Added `cache_control: { type: 'ephemeral' }` to system prompt, created `pricing.ts` with `calculateCostUsd()`, added `($X.XX)` cost display to moderator output. |
| QRM4-BUG-013 | Moderator Multi-Turn Conversation Caching | Run 10 | System prompt cached (BUG-012), but conversation messages and tool definitions re-sent uncached. ~65% of moderator cost from message replay. Added cache breakpoints to tool definitions and last user message. Estimated ~60% cost reduction. |
| QRM4-BUG-014 | Context Store Search Mode Non-Functional | Runs 9, 10 | `String.includes()` required contiguous substring match. Single-word queries worked, but multi-word queries agents actually use ("QRM4 bootstrap context design") never matched. Changed to whitespace-split AND semantics: all terms must appear. |
| QRM4-BUG-015 | Agents Do Not Commit Work Before Returning | Run 10 | No instruction to agents to commit; 7 invocations modified 7+ files with 0 commits. Added commit message convention to `quorum.md`, `## Git Discipline` section to system preamble, and post-invocation `git status --porcelain` warning check. |

15 bugs total — 14 resolved, 1 deferred. All discovered during development and dogfooding runs (none reported by end users).

## Agent Implementation Accuracy

### Deviation Analysis

Across 6 feature tickets, deviations from ticket specifications were self-reported in each ticket's "Implementation Notes / Deviation Log" section.

**Total deviations documented: 2**

| Category | Count | Examples |
|----------|-------|---------|
| **Algorithm refinement** | 1 | `continue` over `break` in greedy bin-packing to maximize item count within budget (QRM4-002) |
| **Test hygiene** | 1 | Added explicit `mockClear()` in broker safeguard rejection tests for correct `not.toHaveBeenCalled()` assertions (QRM4-005) |

**Key observations:**
- QRM4 had the lowest deviation rate of any milestone (0.33 per ticket vs. 1.85 in QRM1)
- Zero deviations from type, API, or convention categories that dominated QRM1/QRM2 — the codebase conventions are now well-established and the agent follows them consistently
- 0/6 tickets required post-review fixes, down from 23% (QRM1) and 45% (QRM2) — the agent's first-pass accuracy has improved significantly with richer specifications and accumulated prompt guidance

### Bug Analysis

- **0 bugs in QRM4's bootstrap context feature code** — all 15 bugs were pre-existing issues or workflow gaps exposed by dogfooding
- **7 integration/runtime bugs** (BUG-001 through BUG-006, BUG-011, BUG-014): pre-existing issues in QRM1/QRM2-era code invisible in unit tests, surfaced only by sustained multi-agent usage in Docker containers
- **5 workflow/prompt improvements** (BUG-008, BUG-009, BUG-010, BUG-012, BUG-015): process refinements discovered by observing agent behavior across repeated runs
- **2 cost optimizations** (BUG-012, BUG-013): moderator prompt caching and conversation caching, reducing orchestration cost by ~60%
- **1 deferred** (BUG-007): SDK `maxTurns` semantics require clarification before implementing per-role limits
- The traditional "bugs per kloc" metric doesn't apply — QRM4's value was in stress-testing the full system, not just the new code

## Dogfooding Validation

QRM4 replaced the structured smoke test runbook of QRM1/QRM2 with dogfooding: the system implemented its own features across 12 orchestrated runs. This provided deeper validation than scripted scenarios — agents encountered real integration friction, resource constraints, and failure modes that synthetic tests wouldn't cover.

| Run | Date | Agents Invoked | Outcome | Bugs Discovered |
|-----|------|----------------|---------|-----------------|
| Kickoff | 2026-03-28 | developer, teamlead | Initial system test, env issues | BUG-001 – BUG-005 |
| Run 2 | 2026-03-29 | developer, teamlead | Stabilization | — |
| Run 3 | 2026-03-31 | developer | Toolchain validation | BUG-003 root cause confirmed |
| Run 4 | 2026-03-31 | developer, teamlead | Feature implementation | — |
| Run 5 | 2026-04-02 | developer, teamlead, architect | QRM4-002 implementation | BUG-006, BUG-007, BUG-008 |
| Run 6 | 2026-04-03 | developer, teamlead, architect | QRM4-003 implementation | BUG-009 |
| Run 7 | 2026-04-03 | developer, teamlead | QRM4-003 retry + completion | BUG-010, BUG-011 |
| Run 8 | 2026-04-10 | developer, teamlead | QRM4-004/005 implementation | — |
| Run 10 | 2026-04-10 | developer, teamlead | QRM4-006 + bug fixes | BUG-013, BUG-014, BUG-015 |
| Runs 11–12 | 2026-04-11 | developer, teamlead | Final validation + acceptance | — |

12 runs across 15 days. 3 unique committers: Ihor Cherednichenko, Quorum Agent, Quorum Team Lead.

## Development Statistics

| Metric | Value |
|--------|-------|
| **Model** | Claude Opus 4.6 |
| **Total cost** | ~$50 |
| **Commits** | 54 |
| **Feature tickets** | 6 |
| **Bug tickets** | 15 (14 resolved, 1 deferred) |
| **Lines added** | 6,946 |
| **Lines removed** | 121 |
| **Net lines** | 6,825 |
| **Test suites** | 39 |
| **Tests** | 537 |

### Breakdown by Category

| Category | Added | Removed | Net |
|----------|-------|---------|-----|
| TypeScript (source + tests) | 2,526 | 107 | 2,419 |
| Markdown (docs + tickets) | 3,800 | 13 | 3,787 |
| Config / Infra (JSON, YAML, Docker, scripts) | 612 | 1 | 611 |

### Effectiveness Ratios

| Ratio | Value |
|-------|-------|
| Cost per net line of code | ~$0.007 |
| Cost per feature ticket | ~$8.33 |
| Bugs in new feature code | 0 |
| Post-review fix rate | 0/6 tickets (0%) |
| Deviation rate (deviations per ticket) | 0.33 |
| Bug discovery method | 100% pre-production (dogfooding) |

## QRM1 → QRM2 → QRM4 Comparison

| Metric | QRM1 | QRM2 | QRM4 |
|--------|------|------|------|
| Feature tickets | 13 | 11 | 6 |
| Bug tickets | 4 | 6 | 15 |
| Commits | 48 | 59 | 54 |
| Total cost | ~$80 | ~$150 | ~$50 |
| Net lines | 26,552 | 8,597 | 6,825 |
| Net TypeScript | 8,257 | 3,579 | 2,419 |
| Cost per net line | ~$0.003 | ~$0.017 | ~$0.007 |
| Cost per feature ticket | ~$6.15 | ~$13.64 | ~$8.33 |
| Bugs in new code per 1,000 TS LoC | 0.48 | 1.44 | 0 |
| Post-review fix rate | 23% | 45% | 0% |
| Deviation rate per ticket | 1.85 | — | 0.33 |
| Test suites | — | — | 39 |
| Tests | — | — | 537 |

QRM4 is the smallest milestone by feature count but produced the most bug tickets — a direct consequence of being the first dogfooding milestone. Running the system against itself for 12 sessions exposed integration friction (timeouts, filesystem constraints, identity configuration) and workflow gaps (context search semantics, checkpointing, commit discipline) that unit tests and scripted smoke tests couldn't reach. The 0% post-review fix rate and zero bugs in feature code suggest that the agent's implementation accuracy has improved significantly as the codebase matured and prompt guidance accumulated.

The cost efficiency ($50 for 6 features + 14 bug fixes) reflects both the low-risk additive nature of the bootstrap context feature and the operational focus of the bug tickets — many were prompt-only or config-only changes that required diagnosis time but minimal code.

---

*This release note documents the QRM4 milestone to track the effectiveness and reliability of multi-agent self-implementing development through the Quorum dogfooding process.*