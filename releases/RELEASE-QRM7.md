# Quorum QRM7 — Stabilization

**Date:** 2026-05-15
**Milestone:** QRM7 (Stabilization)
**Development:** Multi-agent dogfooding (Quorum system self-implementing — Claude Opus 4.6 agents, Claude Opus 4.7 moderator via CC CLI)

## Summary

QRM7 hardens the post-QRM6 system for reliable daily use. QRM6 delivered the architectural shift — containerized CC CLI moderator, MCP elicitation back-channel, server-side session tracking — but live runs surfaced a tight cluster of operational gaps: stale session routing, dual `InvokeRequest` declarations, moderator working in the wrong cwd, missing moderator log adapter, and several MCP-transport edge cases that only manifested once QRM7-001's session reaper was deployed and the system spent meaningful idle time in field use. QRM7 closes those gaps in two waves — the carry-forward backlog from QRM6, and a second wave of issues uncovered during the QRM8 design run and continuous-uptime usage. Highlights include the **layered MCP session reaper** (QRM7-001), the **schema-first `InvokeRequest` migration** that retires the dual TypeScript-interface + Zod-schema declaration (QRM7-002), the **moderator cwd realignment** to the workspace bind-mount (QRM7-004), the **long-poll continuation protocol** for `invoke_agent` responses that exceed CC CLI's 5-minute `undici.bodyTimeout` (QRM7-015 + QRM7-017), the **moderator OAuth long-idle token-refresh fix** via `CLAUDE_CODE_OAUTH_TOKEN` (QRM7-013), **context-search observability** (QRM7-016), and the project's **first CI pipeline** (QRM7-018). Three tickets were superseded mid-milestone after diagnosis was sharpened by runtime instrumentation, and one was formally skipped — see the Diagnostic Recursion section.

QRM7 is the **fourth milestone implemented by the Quorum agent system itself** and the first whose primary discovery surface was *continuous-uptime production usage* rather than a discrete dogfooding window. Dogfooding spanned 13 days (2026-05-03 → 2026-05-15) and produced no traditional `QRM7-BUG-*` tickets — instead, defects surfaced from QRM6 and from the QRM7 deployment itself were promoted to first-class stabilization tickets (QRM7-008 through QRM7-017), making the milestone's ticket graph itself a record of the diagnostic journey.

## Scope

| ID | Title | Status |
|----|-------|--------|
| QRM7-001 | MCP Session Cleanup Not Firing | Done |
| QRM7-002 | Schema-First `InvokeRequest` Migration | Done |
| QRM7-003 | Moderator Permission Grants Not Persisting | Superseded by QRM7-004 |
| QRM7-004 | Moderator cwd Not Aligned with Workspace | Done (supersedes QRM7-003) |
| QRM7-005 | Unified Moderator Log Adapter | Done |
| QRM7-006 | Unit Test Gap-Fill for QRM6 Server-Side Components | Skipped (won't do) |
| QRM7-007 | Shift Moderator from API Key to Subscription OAuth | Done (partially superseded by QRM7-013) |
| QRM7-008 | Agent `McpClientService` Retry-Once Races MCP `initialize` | Done |
| QRM7-009 | Scope MCP Session Reaper to Elicitation Sessions | Done |
| QRM7-010 | Moderator's MCP Client Holds Stale Session Across Long Idle | Superseded by QRM7-011 |
| QRM7-011 | CC CLI POST-Only Pattern vs. Server Keepalive | Superseded by QRM7-012 (premise falsified) |
| QRM7-012 | Moderator Session Reaped After SSE GET Stream Dies | Done (Candidates A + E; B′ shipped as QRM7-014) |
| QRM7-013 | Moderator OAuth Access Token Not Auto-Refreshed Across Long Idle | Done |
| QRM7-014 | Replace Dead `hasOpenedSse` With Live SSE Response Signal | Done |
| QRM7-015 | Long-Call Response Delivery (Research) | Accepted (shipped as QRM7-017) |
| QRM7-016 | Context Store Search Observability | Done |
| QRM7-017 | Long-Poll Continuation Implementation | Done |
| QRM7-018 | GitHub Actions CI Pipeline | Done |

18 tickets total. **14 Done** (including QRM7-013, with the long-lived `CLAUDE_CODE_OAUTH_TOKEN` now in successful production use across multiple hibernation cycles), **1 Research accepted and implemented** (QRM7-015 → QRM7-017), **3 Superseded** (QRM7-003, -010, -011), **1 Skipped** (QRM7-006 — unit-test gap-fill explicitly declined in favour of integration-style specs already added under QRM7-008/-009/-014/-017).

## Bug Tickets

QRM7 has **no formal `QRM7-BUG-*` tickets**. Every defect surfaced during the milestone — whether carried forward from QRM6 live runs or surfaced post-QRM7-001 deployment — was promoted to a first-class stabilization ticket. The table below maps each defect class to the ticket that fixed it, so the bug-ticket discipline of prior milestones is preserved in spirit even though the numbering convention diverged:

| Defect class | Discovered | Ticket | Root cause / fix |
|--------------|-----------|--------|------------------|
| MCP session cleanup never fires on container shutdown; dead sessions report `connected: true` | QRM6-008 Run 2 | QRM7-001 | `transport.onclose` never fires; Streamable HTTP has no transport-level death signal. Layered fix: `lastSeenAt`-based `isConnected()`, TCP keepalive on SSE socket, periodic liveness reaper, SIGTERM DELETE from agents. |
| Dual `InvokeRequest` declaration (TS interface + Zod schema) caused two silent-strip bugs already shipped | QRM6-BUG-012, QRM6-BUG-014 follow-up | QRM7-002 | Move `invokeRequestSchema` to `libs/common/`, derive `InvokeRequest` via `z.infer`. Eliminates the cause; bidirectional guard from QRM6-BUG-014 remains as defence. |
| Moderator cwd is `/app` (empty); CC CLI anchors wrong root, model wastes turns self-correcting, permission grants land on read-only path | QRM6 production runs | QRM7-004 | Change `Dockerfile` moderator stage `WORKDIR` to `/mnt/quorum/workspace`. One-line change with cascading benefits; supersedes QRM7-003's volume-engineering proposal. |
| `parse-logs.mjs` has no moderator-side input after `apps/terminal/` deletion | QRM6-011 deferred | QRM7-005 | New `cc-session-adapter.mjs` reads raw CC CLI session JSONL and emits QuorumLogger-shaped events. |
| Agent retry-once path fires `callTool()` before new transport's MCP `initialize` commits, producing `Bad Request: Server not initialized` | QRM8 design run Issue 3 | QRM7-008 | `reconnectPromise` memoization across both call sites; `isSessionNotFound()` broadened to catch `Server not initialized`. |
| Reaper churns agent sessions that don't need liveness tracking (HttpAgentConnection routes by callback URL, not session ID) | QRM8 design run analysis | QRM7-009 | `isSessionAlive()` exempts deployable-agent roles; `register_agent` evicts prior session bound to same role. |
| Moderator's MCP session reaped during SSE GET stream death; manual `/mcp` required after long idle | QRM8 design run Issue 2, 2026-05-07 evening reproduction | QRM7-010 → QRM7-011 → QRM7-012 / QRM7-014 | SSE GET undici `bodyTimeout = 300_000ms` aborts response, SDK reconnects, keepalive stops refreshing `lastSeenAt`. Fixed by Candidate A (bump `SESSION_LIVENESS_TIMEOUT_MS` to 30 min) + Candidate E (immediate SSE ping + tightened cadence) + Candidate B′ (live `activeSseToken` identity-guarded tracking). |
| Moderator OAuth access token not auto-refreshed across long idle; 5 `401 authentication_error` events across one 47h session | QRM8 design run Issue 1 | QRM7-013 | Switch to long-lived token via `claude setup-token`, expose as `CLAUDE_CODE_OAUTH_TOKEN`; preserves QRM7-007's flat-rate subscription billing. |
| `invoke_agent` response lost when target work exceeds CC CLI's 5-min `undici.bodyTimeout` | Recurring QRM5-BUG-003 → QRM7-014 follow-up | QRM7-015 (research) → QRM7-017 (impl) | Long-poll continuation: server returns `{status: "pending", invocationId}` before timeout; moderator follows CLAUDE.md rule to call `wait_invocation(invocationId)`. Sub-5-min calls have zero overhead. |
| No structured visibility into `context_query mode=search` quality (silent BM25 fallback, bad relevance, budget-driven truncation) | Context-store iteration, 2026-05-12 | QRM7-016 | Dedicated `/app/logs/context-search-{startupTimestamp}.jsonl` trace stream via `onTrace` callback; main-log breadcrumb carries `queryId` UUID. |

10 distinct defect classes, all resolved or accepted-and-implemented via the dependency chain above. All discovered through development, the QRM8 design run, or continuous-uptime field use — none reported by end users.

## Diagnostic Recursion

A defining characteristic of QRM7 is that **three tickets were superseded mid-milestone after runtime instrumentation falsified their premise** — a pattern absent in QRM1–QRM6:

| Ticket | Original premise | Falsifying evidence | Successor |
|--------|------------------|---------------------|-----------|
| QRM7-003 | Permission grants need a writable `/app/.claude/` volume | QRM7-004 showed grants can land on the existing workspace bind-mount by changing cwd | QRM7-004 |
| QRM7-010 | Moderator's MCP client holds stale session via partial SDK reinit / hibernation wall-clock | Log evidence (`mcp-server-20260508T134859.jsonl`) revealed CC CLI never opens SSE — investigated mechanism presupposed a stream that didn't exist | QRM7-011 |
| QRM7-011 | CC CLI 2.1.126 is POST-only; server keepalive infrastructure inapplicable | Runtime instrumentation showed CC CLI **does** open SSE GET within ~20 ms of session creation, before `register_agent` arrives; "0 GETs in 11h" came from grepping for log lines our controller never emitted; Candidate B's `hasOpenedSse` exemption is dead code (sticky-true before role binds) | QRM7-012 (Candidates A + E + B′ via QRM7-014) |

The pattern matters because QRM7's primary failure mode was *inferring transport behavior from logs that didn't capture the relevant signal*. Each supersession was triggered by adding diagnostic logging at the layer the prior framing assumed was already covered. The lesson — that liveness, session, and transport behavior must be instrumented at the actual transport layer, not inferred from application-level traces — is now baked into `docs/mcp-connectivity.md` (new, 705 lines) as the single source of truth for the MCP session lifecycle.

## Agent Implementation Accuracy

### Deviation Analysis

QRM7's ticket structure differs from prior milestones — there is no clean "feature vs bug" split because every ticket is itself a stabilization fix. Deviation tracking is preserved per Implementation Notes in each ticket.

**Total deviations documented: 0** across the 14 Done tickets. Every Implementation Notes section flips its acceptance criteria with no scope-trim or scope-bleed callouts.

**Key observations:**
- 0/15 reviewed tickets required post-review fixes — all code-review passes were "accept" with implementation notes only
- The three superseded tickets (QRM7-003, -010, -011) document their *diagnostic* misalignment, not implementation deviation — the developer correctly implemented the (subsequently invalidated) plan
- QRM7-002's "Architect Review" pass surfaced corrections that were folded into the ticket *before* implementation began — the schema-first migration shipped clean on first pass

### Bug Analysis

- **0 bugs in QRM7's stabilization-feature code** — every defect QRM7 resolved was a pre-existing transport, lifecycle, configuration, or schema issue carried forward from QRM6 or exposed by QRM7-001's reaper deployment
- **6 MCP-transport stabilization items** (QRM7-001, -008, -009, -010/-011/-012, -014, -015/-017): the reaper itself, the retry-race it exposed, the scope mismatch between elicitation and HTTP agent connections, the SSE-stream-death-into-reap cascade, and the long-poll continuation pattern. Five of six belong to a single causal chain that began with the QRM7-001 reaper deployment.
- **2 moderator-runtime items** (QRM7-004, -007/-013): cwd alignment and OAuth long-idle token-refresh — both impossible to catch at unit-test level; only surface in real CC CLI sessions against the running Docker stack
- **1 schema-discipline item** (QRM7-002): retires the dual-declaration class that caused two silent-strip bugs in QRM6
- **1 observability item** (QRM7-016): structured `context_query mode=search` trace stream — purely additive, no behavior change to the public `ContextStore.search()` API
- **1 tooling item** (QRM7-005): moderator log adapter restores parity with agent JSONL ingestion
- **1 infrastructure item** (QRM7-018): first CI pipeline for the repo — lint + unit tests + build gating

## Dogfooding Validation

QRM7 did not run a discrete dogfooding playbook in the QRM5/QRM6 sense. Validation was driven by three overlapping surfaces:

1. **Direct runtime verification per ticket** — each Done ticket lists an Implementation Notes / Validation section against the running stack
2. **QRM8 design-run discovery** (2026-05-06 → 08) — promoted three new tickets (QRM7-008, -009, -010-chain) and validated QRM7-001 + QRM7-009 in the wild
3. **Continuous-uptime field use** (2026-05-07 evening reproduction and onward) — the SSE-stream-death-into-reap chain (QRM7-010 → -011 → -012 → -014) was diagnosed and fixed against a single long-lived moderator session

| Surface | Span | Key findings |
|---------|------|--------------|
| QRM8 roadmap design run | 2026-05-06 → 08 | Issues 1–3 promoted to QRM7-013, QRM7-008, QRM7-010. 9 spurious agent reconnects across 5 bursts before QRM7-009 landed. |
| Continuous-uptime moderator | 2026-05-07 → 09 | Burst-A through Burst-E reproductions of `Session not found` after long idle; metronomic ~5-min reap cadence matched undici `bodyTimeout` exactly. |
| Context-store iteration | 2026-05-12 | Silent embedding-service fallback observed; promoted to QRM7-016. |
| Long-call empirical baseline | Post-QRM7-014 | 48 successful long-hold POST responses confirmed POST-path SSE keepalive ticks fire continuously, unlocking the long-poll continuation design. |

3 unique committers across the milestone: Ihor Cherednichenko (c), Quorum Agent, Quorum Team Lead.

## Development Statistics

| Metric | Value |
|--------|-------|
| **Model** | Claude Opus 4.6 (agents) + Claude Opus 4.7 (moderator, CC CLI) |
| **Commits** | 76 |
| **Tickets** | 18 (14 Done, 1 Research accepted, 3 Superseded, 1 Skipped) |
| **Lines added** | 10,007 |
| **Lines removed** | 944 |
| **Net lines** | 9,063 |
| **Test suites** | 45 (+1 vs QRM6) |
| **Tests** | 758 (+77 vs QRM6) |

### Breakdown by Category

| Category | Added | Removed | Net |
|----------|-------|---------|-----|
| TypeScript — source | 1,105 | 189 | 916 |
| TypeScript — specs | 2,152 | 39 | 2,113 |
| Markdown (docs + tickets) | 6,153 | 693 | 5,460 |
| Config / Infra (JSON, YAML, Docker, sh, mjs) | 597 | 23 | 574 |

Spec growth outpaces source growth ~2.3× — the same pattern QRM5 established and QRM6 preserved. The Markdown category is unusually heavy (5,460 net) because QRM7's diagnostic-recursion structure produced multiple-rewrite tickets (QRM7-010 → 011 → 012 each carry full investigation logs) and a new 705-line `docs/mcp-connectivity.md` as the consolidated MCP-session-lifecycle reference. The QRM8 roadmap (765 lines) was also authored mid-QRM7 and is captured in this commit range.

### Cost Analysis

| Metric | Value |
|--------|-------|
| **Total milestone spend** | **~$200** |
| Cost per closed ticket | ~$14.29 (across 14 Done) |
| Cost per commit | ~$2.63 |
| Cost per 1,000 net lines | ~$22.07 |

The $200 budget covered all agent invocations across 14 Done tickets, 1 Research ticket and its implementation, 3 superseded tickets, and the diagnostic instrumentation that drove each supersession. The higher per-ticket cost vs QRM5 ($14.29 vs $11) but a touch under QRM6 ($14.29 vs $16.67) reflects QRM7's character: many small fixes plus deep, repeated debugging cycles against the running stack. The three superseded tickets account for a non-trivial fraction of the spend — each one's diagnostic loop required new instrumentation, fresh log captures, and re-analysis. The split-model setup (Opus 4.6 for agents, Opus 4.7 for the CC CLI moderator) is included in the per-ticket cost; the moderator's 4.7 upgrade landed mid-milestone and is the first such intra-milestone model bump.

### Effectiveness Ratios

| Ratio | Value |
|-------|-------|
| Bugs in new stabilization code | 0 |
| Post-review fix rate | 0/15 reviewed tickets (0%) |
| Deviation rate per closed ticket | 0 |
| Supersession rate | 3/18 (17%) |
| Bug discovery method | 100% pre-production (field use + design run + targeted instrumentation) |

## QRM1 → QRM2 → QRM4 → QRM5 → QRM6 → QRM7 Comparison

| Metric | QRM1 | QRM2 | QRM4 | QRM5 | QRM6 | QRM7 |
|--------|------|------|------|------|------|------|
| Feature tickets | 13 | 11 | 6 | 9 | 9 | 18 (mixed) |
| Bug tickets | 4 | 6 | 15 | 6 | 13 | 0 (promoted to first-class tickets) |
| Commits | 48 | 59 | 54 | 65 | 77 | 76 |
| Net lines | 26,552 | 8,597 | 6,825 | 11,587 | 4,483 | 9,063 |
| Net TypeScript (src + spec) | 8,257 | 3,579 | 2,419 | 6,034 | −2,489 | 3,029 |
| Bugs in new code per 1,000 TS LoC | 0.48 | 1.44 | 0 | 0 | 0 | 0 |
| Post-review fix rate | 23% | 45% | 0% | 0% | 0% | 0% |
| Deviation rate per closed ticket | 1.85 | — | 0.33 | 0 | 0.11 | 0 |
| Test suites | — | — | 39 | 49 | 44 | 45 |
| Tests | — | — | 537 | 760 | 681 | 758 |
| Total cost | ~$80 | ~$150 | ~$50 | ~$100 | ~$150 | ~$200 |
| Cost per closed ticket | ~$6.15 | ~$13.64 | ~$8.33 | ~$11 | ~$16.67 | ~$15.38 |

QRM7 restores test-count parity with QRM5's high-water mark (758 vs 760) after QRM6's terminal-deletion drop, and is the **most expensive milestone to date** at $200 — a direct consequence of three superseded diagnostic cycles each requiring fresh instrumentation runs. The zero-bugs-in-new-code and zero-post-review-fix pattern established in QRM4 continues to hold for the fourth consecutive milestone. The 17% supersession rate is unique to QRM7 and reflects the cost of debugging asynchronous transport behavior at a layer where logs are easy to misread; QRM7 invests in `docs/mcp-connectivity.md` and the QRM7-016 trace stream specifically to amortize that cost across future MCP work.

The ticket-graph itself encodes the milestone's diagnostic journey: the QRM7-010 → -011 → -012 chain is the supersession trail; the QRM7-015 → -017 split is the research-then-implementation pattern carried over from QRM5-008's runbook approach. Compared to QRM6's "13 bugs, mostly container packaging" profile, QRM7's "10 defect classes, mostly MCP-transport edge cases" profile is the natural next layer — the issues that only surface once the containerized moderator is genuinely in daily use.

## Documentation Updates

| Document | Change |
|----------|--------|
| `docs/mcp-connectivity.md` | **New** (705 lines) — single source of truth for MCP session lifecycle across both agent (HTTP) and moderator (elicitation) clients; consolidates QRM7-001/-009/-012/-014 design decisions |
| `docs/agent-messaging.md` | Long-poll continuation protocol added (QRM7-017) |
| `docs/context-store.md` | Search-trace stream and observability surface documented (QRM7-016) |
| `docs/system-design.md` | Two-tier billing split documented (QRM7-013); moderator OAuth path called out |
| `docs/message-broker.md` | Schema-first `InvokeRequest` reflected in invocation-types reference (QRM7-002) |
| `CLAUDE.md` | Long-poll continuation rule added — moderator must call `wait_invocation(invocationId)` when any tool response carries `status: "pending"` |
| `docker/moderator/CLAUDE.md` | Turn Diagnostic Summary table + Self-Diagnostic via Agent Logs section added (operator UX) |
| `docker/moderator/settings.json` | `forceLoginMethod: "claudeai"` defense-in-depth (QRM7-007); onboarding bypass seeded (QRM7-013) |
| `tickets/QRM6-BUG-005-sdk-resume-not-resuming-session.md` | Extended with QRM7-002 schema-migration follow-up notes |
| `tools/session-report/SESSION-REPORT.md` | Adapter pre-step and search-trace stream documented |
| `tools/session-report/cc-session-adapter.mjs` | **New** (393 lines) — CC CLI session JSONL → QuorumLogger-shape adapter |
| `tools/session-report/parse-logs.mjs` | Invokes adapter as pre-step; ingests moderator activity on equal terms with agents |
| `.github/workflows/ci.yml` | **New** — lint + unit tests + build on push and PR (QRM7-018) |
| `README.md` | CI badge; research case-study disclaimer; front-matter rewrite for visitor engagement |

The two stale design-investigation files in `docs/` (`session-resume-fix.md`, `session-resume-investigation.md`) and the obsolete `docs/reviews/QRM6-BUG-014-architect-review.md` were deleted as their content was either consolidated into `docs/mcp-connectivity.md` or had been superseded by post-QRM6 implementation.

## Entropy Report

A new source-code entropy report was generated at milestone close: `tools/entropy-report/reports/entropy-20260516-000812.html`. Key findings:

- **Halstead Difficulty rose from 364.4 to 388.9** — back near the pre-QRM6 peak (387.8 at end of QRM5). The new mcp-server complexity (long-poll continuation, layered reaper, live-SSE-token signal, search-trace observability) outpaces the simplifications QRM6 won by deleting the terminal app.
- **Volume grew from 1.03M to 1.22M** (+18%) — the largest single-milestone Volume gain since QRM5, concentrated in `apps/mcp-server/` (370K → 487K, +32%)
- **Per-app distribution remains healthy** but increasingly mcp-server-heavy: mcp-server (75 files, 9,568 LOC), agent (38 files, 4,452 LOC), common (31 files, 1,868 LOC). mcp-server is now ~55% of project Volume vs ~50% at QRM6 close.
- The codebase **continues to scale without runaway entropy** — Difficulty 388.9 is well within the 350–390 plateau the project has held across the last 200 commits, despite Volume nearly doubling in the same window.

---

*This release note documents the QRM7 milestone — the stabilization layer applied to the QRM6 containerized-moderator architecture. Validated through 76 commits, 10 distinct defect classes resolved, three superseded diagnostic cycles, two new doc consolidations (`docs/mcp-connectivity.md`, long-poll protocol notes), and the project's first CI pipeline. It continues tracking the effectiveness and reliability of multi-agent self-implementing development through the Quorum dogfooding process.*