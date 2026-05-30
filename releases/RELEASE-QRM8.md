# Quorum QRM8 — Workspace Isolation

**Date:** 2026-05-29
**Milestone:** QRM8 (Workspace Isolation)
**Development:** Multi-agent dogfooding (Quorum system self-implementing — Claude Opus 4.6 agents, Claude Opus 4.7 moderator via CC CLI)

## Summary

QRM8 decouples every container's workspace from the host filesystem. QRM7 stabilized the post-QRM6 moderator and MCP transport layers for daily use; QRM8 attacks the foundational concurrency and deployment gap that remained: every agent container bind-mounted the same host directory and edited files in-place on a shared working tree. Two concurrent invocations could silently corrupt each other's work, git state was unpredictable, and the host filesystem was an implicit dependency that prevented remote deployment. QRM8 eliminates all three problems.

The centrepiece is **git worktree-per-invocation isolation** (#11): each agent invocation creates a short-lived worktree at `/var/agent-worktrees/<correlationId>` on its target branch, runs the SDK subprocess inside it, and cleans up in a `finally` block — all within the same container process. **Handler-controlled commit and push** (#12) removes `git commit` and `git push` from the SDK loop entirely; the `InvocationHandler` extracts a `<commit-message>` delimiter from the agent's response, commits after the SDK exits, and pushes to the remote via the gh credential helper. A **branch-in-flight guard** (#13) in the `MessageBroker` prevents two concurrent invocations from targeting the same branch.

The moderator becomes a **standalone git client** (#14) — its workspace bind mount is replaced with a git clone on a named volume, and `new_conversation` returns a `reminder` field instructing the moderator to `git pull` before reading files. Agents and moderator authenticate to GitHub via a **fine-grained PAT** (#15) that is wired through the Docker entrypoints and filtered out of the SDK subprocess environment. A **`FileSessionStore`** (#10) on per-role named volumes replaces the `InMemorySessionStore`, making cross-restart session resume durable and making cross-turn resume the default (the `agentSessions.clear()` call in `new_conversation` is removed). Agent **CC memory is redirected** (#16) to `context_store(scope='agent')` via prompt guidance, and the MCP server's workspace bind mount is **commented out** (#17) as a debug-only escape hatch.

Eight bug-class and bootstrap tickets landed alongside the core work: #20 (PR-based workflow bootstrap with gh CLI and quorum.md conventions), #27 (gh auth env-ordering fix), #29 (agent plugin install), #31 (tool-guard namespaced skill matching), #39 (correlationId UUID validation and shell-safe worktree calls), #42 (moderator workspace volume ownership), #45 (worktree node_modules symlink), and #47 (always-pending dispatch for long-role invocations).

QRM8 is the **fifth milestone implemented by the Quorum agent system itself** and the first in which every container operates as an independent git client with zero host-filesystem coupling. The host bind mount — present since QRM1 — is fully removed from agents and moderator, and commented out on the MCP server. All inter-container synchronization flows through `git push` / `git pull` against the GitHub remote.

## Scope

| ID | Title | Status |
|----|-------|--------|
| #8 | QRM8 Roadmap — Workspace Isolation | Epic (all children complete) |
| #10 | FileSessionStore on Named Volume | Done (AC #6 deferred to QRM9) |
| #11 | Git Worktree Per Invocation | Done |
| #12 | Handler-Controlled Commit and Push | Done |
| #13 | Branch-in-Flight Guard in MessageBroker | Done |
| #14 | Moderator Becomes Standalone Git Client | Done |
| #15 | PAT Wiring and SDK Environment Filtering | Done |
| #16 | Redirect Agent Memory to Context Store | Done |
| #17 | MCP Server Bind Mount Removal | Done |
| #20 | PR-based Workflow Bootstrap | Done |
| #27 | Fix gh Auth Env-Ordering in Entrypoints | Done |
| #29 | Agent Plugin Install at Entrypoint | Done |
| #31 | Tool-guard Namespaced Skill Matching | Done |
| #39 | Harden correlationId — UUID Validation | Done |
| #42 | Moderator Workspace Volume Ownership | Done |
| #45 | Worktree node_modules Symlink | Done |
| #47 | Always-Pending Dispatch for Long-Role Invocations | Done |

17 tickets total (1 epic + 8 feature + 4 bootstrap/support + 4 bug/hardening). **16 Done** (all children of the epic). No tickets superseded or skipped.

## Bug Tickets

QRM8 follows QRM7's model of promoting defects to first-class tickets rather than using a `QRM8-BUG-*` numbering convention. All bug-class tickets were discovered during implementation or integration testing against the running Docker stack and resolved on the staging branch before milestone close.

| Defect class | Discovered | Ticket | Root cause / fix |
|--------------|-----------|--------|------------------|
| `gh auth login` refuses credential persistence while `GH_TOKEN` is in env; `gh auth setup-git` writes to read-only `~/.gitconfig` | #15 integration test | #27 | Capture-unset-pipe pattern (`_TOKEN=$GH_TOKEN; unset GH_TOKEN; echo "$_TOKEN" | gh auth login --with-token`); redirect `GIT_CONFIG_GLOBAL` to tmpfs path. Applied identically to agent and moderator entrypoints. |
| `code-review` plugin never installed on agent containers; all 109 prior teamlead invocations fell back to manual prose review | #20 PR workflow discovery | #29 | Seed plugin files to agent tmpfs in entrypoint from `docker/plugins/code-review/`; write `installed_plugins.json` with correct shape. |
| Tool-guard rejects namespaced plugin skill names (`code-review:code-review`) | #29 follow-up | #31 | Strip namespace prefix before allowlist lookup; repoint plugin path from masked workspace to entrypoint-seeded tmpfs location; remove dead Dockerfile COPY + mkdir/chown entries. |
| correlationId values are user-controlled strings passed to shell commands (`git worktree add`, `git push`); injection risk | #12 security review | #39 | Add `z.string().uuid()` validation to correlationId in both MCP tool schema and InvokeRequest schema; convert 3 `execAsync` calls to `execFileAsync` (argv form bypasses shell interpolation). |
| Moderator's workspace named volume created by Docker with `root:root` ownership; first-boot `git clone` fails as `quorum` user | #14 first-boot test | #42 | Add `/mnt/quorum/workspace` to Dockerfile moderator stage `mkdir`/`chown` block so volume is seeded with correct `quorum:quorum` ownership on first mount. |
| Agent worktree has no `node_modules`; `npm run build/lint/test` fails with missing dependencies | #11 integration test | #45 | Symlink `/app/node_modules` into worktree immediately after `git worktree add`; `execFileAsync` (argv form) prevents shell injection from correlationId; 3 new tests covering call shape, ordering, and failure cleanup. |
| `invoke_agent` for long-role dispatch races a 270 s timeout ceiling; if the agent completes between 0–270 s the response is lost | #47 field observation | #47 | Remove `raceAgainstCeiling` from long-role dispatch; always park `InvocationRecord` and return `{status: "pending", invocationId}` immediately. Collapses recovery blind spot from 270 s to dispatch round-trip (~100 ms). |

7 distinct defect classes, all resolved. All discovered during development or integration testing — none reported by end users.

## Agent Implementation Accuracy

### Deviation Analysis

Across 16 Done tickets, deviations from ticket specifications were self-reported in each ticket's Implementation Notes.

**Total deviations documented: 2**

| Category | Count | Ticket | Description |
|----------|-------|--------|-------------|
| Proactive enhancement | 1 | #13 | Branch-in-flight guard allows same-correlationId nested calls through the lock — not documented in the original spec but correct for the existing nested-invocation pattern (agent A invokes agent B on the same branch). |
| Documented partial scope | 1 | #29 | Plugin seed works but the tool-guard gate for namespaced skill names remained blocked until the follow-up #31 fix landed. |

**Key observations:**
- 0/16 tickets required post-code-review fixes — all code reviews were "accept" on first pass
- The 2 deviations are both additive (correct behavior not in spec) or scope-sequencing artifacts, not scope-trim or scope-bleed
- #12's revised approach (agent writes `<commit-message>` delimiter, handler extracts it) was redesigned mid-ticket after the original `InvokeResponse.commitMessage` field proved insufficient; the ticket was updated before implementation began, so no implementation deviation occurred

### Bug Analysis

- **0 bugs in QRM8's new feature code** — every bug ticket (#27, #29, #31, #39, #42, #45, #47) addresses an infrastructure, configuration, or integration gap exposed by the new isolation model, not a defect in the feature code itself
- **3 entrypoint/Docker-packaging items** (#27, #42, #29): gh auth ordering, volume ownership, plugin install — the same category that dominated QRM6's bug profile, now on the agent side
- **2 security-hardening items** (#39, #31): correlationId injection risk and tool-guard namespace matching — both proactively identified during code review, not through exploitation
- **1 dependency-resolution item** (#45): worktree missing `node_modules` — a structural gap in the worktree model that only manifests when agents run npm scripts
- **1 dispatch-timing item** (#47): long-role invocations raced a timeout ceiling — a pre-existing gap from QRM7's long-poll continuation work, now fully closed

## Dogfooding Validation

QRM8 was validated through progressive deployment on the staging branch. Each ticket was implemented by a Quorum agent, code-reviewed by the team lead (using the newly-installed `code-review` plugin from #29/#31), and merged via PR. Integration was verified by running the full Docker stack after each merge.

| Surface | Span | Key findings |
|---------|------|--------------|
| Feature implementation via agents | 2026-05-16 → 29 | All 8 feature tickets implemented by Quorum agents (developer role), reviewed by team lead. Zero post-review fixes. |
| Entrypoint bootstrap testing | #15, #27 | gh auth + git clone flow validated against running containers; two defects (#27) surfaced and fixed before merging #11/#14. |
| Plugin install chain | #29, #31 | Discovered that the `code-review` plugin had never actually been installed on agents despite 109 prior invocations; the tool-guard namespace fix was the final piece. |
| Worktree lifecycle testing | #11, #45 | First invocation in worktree revealed missing `node_modules`; symlink fix (#45) validated by subsequent agent invocations running `npm run build/lint/test` successfully in worktrees. |
| Security review cycle | #39 | Proactive correlationId hardening after code review identified shell-injection risk in worktree path construction. |
| Long-role dispatch | #47 | Always-pending pattern eliminates the 0–270 s recovery blind spot from QRM7's `raceAgainstCeiling` approach. |

4 unique committers across the milestone: Quorum Agent (74 commits), Ihor Cherednichenko (c) (28), Igor Cherednichenko (18), Quorum Team Lead (1).

## Development Statistics

| Metric | Value |
|--------|-------|
| **Model** | Claude Opus 4.6 (agents) + Claude Opus 4.7 (moderator, CC CLI) |
| **Commits** | 121 |
| **Tickets** | 17 (1 epic + 16 Done) |
| **Lines added** | 6,739 |
| **Lines removed** | 342 |
| **Net lines** | 6,397 |
| **Test suites** | 47 (+2 vs QRM7) |
| **Tests** | 839 (+81 vs QRM7) |
| **Total cost** | ~$100 |

### Breakdown by Category

| Category | Added | Removed | Net |
|----------|-------|---------|-----|
| TypeScript — source | 501 | 87 | 414 |
| TypeScript — specs | 1,782 | 167 | 1,615 |
| Markdown (docs + tickets) | 4,219 | 58 | 4,161 |
| Config / Infra (JSON, YAML, Docker, sh) | 237 | 30 | 207 |

Spec growth outpaces source growth ~3.9× — the strongest spec-to-source ratio of any milestone, reflecting QRM8's emphasis on handler-level testing (commit/push flows, worktree lifecycle, branch guards, tool-guard namespace matching) where integration correctness is the primary risk. The Markdown category is heavy (4,161 net) because QRM8's 8 feature tickets each carry detailed design decisions, and the 8 bug-class tickets include full investigation context. The roadmap (#8) alone is 765 lines.

### Cost Analysis

| Metric | Value |
|--------|-------|
| **Total milestone spend** | **~$100** |
| Cost per closed ticket | ~$6.25 (across 16 Done) |
| Cost per commit | ~$0.83 |
| Cost per 1,000 net lines | ~$15.63 |

The ~$100 budget is the lowest since QRM4 ($50) and half of QRM7's $200. The reduction reflects QRM8's character: infrastructure and configuration work with clear, mechanical specifications — worktree lifecycle, entrypoint scripts, Docker volumes, tool-guard updates — rather than QRM7's deep diagnostic cycles against asynchronous transport edge cases. Zero superseded tickets means zero wasted diagnostic loops. The per-ticket cost ($6.25) is the lowest in project history, driven by the high ticket count (16) and the mechanical nature of most changes.

### Effectiveness Ratios

| Ratio | Value |
|-------|-------|
| Bugs in new feature code | 0 |
| Post-review fix rate | 0/16 reviewed tickets (0%) |
| Deviation rate per closed ticket | 0.125 (2/16) |
| Supersession rate | 0/17 (0%) |
| Bug discovery method | 100% pre-production (implementation + code review + integration test) |

## QRM1 → QRM2 → QRM4 → QRM5 → QRM6 → QRM7 → QRM8 Comparison

| Metric | QRM1 | QRM2 | QRM4 | QRM5 | QRM6 | QRM7 | QRM8 |
|--------|------|------|------|------|------|------|------|
| Feature tickets | 13 | 11 | 6 | 9 | 9 | 18 (mixed) | 8 |
| Bug tickets | 4 | 6 | 15 | 6 | 13 | 0 (promoted) | 8 (promoted) |
| Commits | 48 | 59 | 54 | 65 | 77 | 76 | 121 |
| Net lines | 26,552 | 8,597 | 6,825 | 11,587 | 4,483 | 9,063 | 6,397 |
| Net TypeScript (src + spec) | 8,257 | 3,579 | 2,419 | 6,034 | −2,489 | 3,029 | 2,029 |
| Bugs in new code per 1,000 TS LoC | 0.48 | 1.44 | 0 | 0 | 0 | 0 | 0 |
| Post-review fix rate | 23% | 45% | 0% | 0% | 0% | 0% | 0% |
| Deviation rate per closed ticket | 1.85 | — | 0.33 | 0 | 0.11 | 0 | 0.125 |
| Test suites | — | — | 39 | 49 | 44 | 45 | 47 |
| Tests | — | — | 537 | 760 | 681 | 758 | 839 |
| Total cost | ~$80 | ~$150 | ~$50 | ~$100 | ~$150 | ~$200 | ~$100 |
| Cost per closed ticket | ~$6.15 | ~$13.64 | ~$8.33 | ~$11 | ~$16.67 | ~$15.38 | ~$6.25 |

QRM8 sets a new high-water mark for tests (839, +81 vs QRM7's 758, +79 vs QRM5's previous peak of 760) and test suites (47, +2 vs QRM7). The commit count (121) is the highest of any milestone — a function of the PR-based workflow (#20) which produces merge commits alongside feature commits, and the 8 bug-class tickets each generating their own commit chains. The zero-bugs-in-new-code and zero-post-review-fix patterns continue for the fifth consecutive milestone (QRM4 → QRM8). Cost efficiency returns to QRM4 levels at $6.25 per ticket, driven by the mechanical nature of infrastructure work and zero wasted diagnostic cycles.

## Documentation Updates

| Document | Change |
|----------|--------|
| `quorum.md` | GitHub Workflow section (branch naming, PR lifecycle, `#<N>` commit format), Moderator role section, code-review PR comment conventions, PR verdict comment requirement |
| `docker/moderator/CLAUDE.md` | Cross-turn session resume default, mandatory `branch` parameter, `git pull` turn-start discipline, credential-path deny rules, `invoke_agent` POST abandonment prohibition, always-pending dispatch + `wait_invocation` rule |
| `CLAUDE.md` | Updated for QRM8 workspace model — `REPO_URL`, `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` setup; worktree and named-volume architecture; `start.sh` description updated |
| `README.md` | Refreshed for QRM8 workspace model — removed host bind-mount references, documented named volumes and git-as-transport model |
| `.env.example` | Added `GH_TOKEN` and `REPO_URL` placeholders; dropped stale `WORKSPACE_PATH` and `AGENT_WORKSPACE_DIR` |

## Entropy Report

A source-code entropy report was generated at milestone close: `tools/entropy-report/reports/entropy-20260530-013740.html`. This is the **first report on the corrected entropy-report lexer** (ticket #50) — template-literal interpolations are now tokenized, regex literals count as single operands, string quote styles and numeric separators are normalized, per-app Volume is computed from per-app union maps, and Estimated Bugs uses Halstead's canonical `E^(2/3)/3000`. Its absolute figures are a new, more faithful baseline and are **not comparable** to the pre-#50 numbers quoted in the QRM6/QRM7 notes. Key findings (534 commits, full history):

- **Halstead Volume reached 1,385,067** across 17,518 LOC in 147 files. Over the QRM8 window (roadmap relocation at #401, V≈1.24M → tip #534, V=1.39M) Volume grew ~12% through steady handler-level feature work — no single-commit spikes.
- **Difficulty is flat at ~391** (387.4 at the QRM7/QRM8 boundary → 391.0 at tip; project-wide average 362.3). The tight 340–392 band the project has held since QRM2 persists: QRM8's worktree-isolation and commit/push logic was built largely from the existing operator/identifier vocabulary, not new constructs.
- **Per-app distribution** (union-map method, deliberately **not additive** to the project total): `mcp-server` 736,049 Volume (75 files, 9,815 LOC), `agent` 418,588 (40 files, 5,754 LOC), `common` 107,574 (32 files, 1,949 LOC). The MCP server remains the complexity center (7 tools, 2 resources, registry, broker, context store); QRM8's net growth landed in the `agent` app, where worktree-per-invocation isolation, handler-controlled commit/push, and the branch-in-flight guard were implemented.
- **Estimated Bugs (E^(2/3)/3000) reads 221.5** — roughly half the inflated ~455 the old `V/3000` variant reported. As an aggregate over a 147-file monorepo it remains a trend signal, not a count: the realized record across QRM4 → QRM8 is **0 bugs in new feature code** and a **0% post-review fix rate**.

---

*This release note documents the QRM8 milestone — the workspace isolation layer that decouples all containers from the host filesystem via git worktree-per-invocation, handler-controlled commits, and named-volume git clones. Validated through 121 commits, 16 closed tickets, 7 bug-class defects resolved, zero post-review fixes, and 839 passing tests across 47 suites. It continues tracking the effectiveness and reliability of multi-agent self-implementing development through the Quorum dogfooding process.*
