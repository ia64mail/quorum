# #20: PR-based Ticket Workflow Bootstrap

## Summary

Bootstrap the GitHub PR-based development workflow that QRM8 and all future milestones will use. This is a process-infrastructure ticket: it wires `GH_TOKEN` into all containers, installs the `gh` CLI where missing, adds GitHub workflow and Moderator role sections to `quorum.md`, and lays out the plan for renumbering the QRM8 roadmap to use GitHub issue numbers. No application code changes — only Docker config, environment plumbing, prompt/convention updates, and a skill-discovery verification step.

This ticket is ordered first in QRM8 because the moderator needs `gh` auth before it can drive the PR-based workflow for all subsequent tickets. The user will rebuild and restart the moderator container immediately after this ticket lands, giving the moderator GitHub auth to orchestrate the rest of the milestone.

## Problem Statement

**Current situation:** The Quorum system has no GitHub CLI integration in any container. The `gh-workflow` skill (`docker/moderator/.claude/skills/gh-workflow/SKILL.md`) defines a comprehensive PR-based process — epic and standalone lifecycles, milestone conventions, branch naming, PR linking — but the moderator cannot execute it because:

1. **No `gh` CLI installed.** The moderator Dockerfile stage (lines 93-95) installs `git`, `bash`, `ripgrep`, `curl`, `jq`, `openssh-client` — but not `gh`. The agent stage (lines 47-49) has the same package list and also lacks `gh`.
2. **No `GH_TOKEN` in any container.** `docker-compose.yml` does not pass a GitHub token to any service. Without auth, even if `gh` were installed, it couldn't create issues, PRs, or milestones.
3. **No GitHub workflow section in `quorum.md`.** Agents (architect, team lead, developer, QA) have no shared mental model of the PR-based process. Only the moderator has access to the full skill doc via `/gh-workflow`.
4. **No Moderator role section in `quorum.md`.** The moderator's ticket lifecycle — spec review pause, implementation, final review pause — is undefined in the shared conventions file. Agents don't know the moderator's workflow.
5. **QRM8 roadmap uses internal `QRM8-00X` IDs.** The roadmap on the `8-workspace-isolation-staging` branch references `QRM8-001` through `QRM8-008`, but GH issues for these sub-tasks may already exist with their own numbers. The ticket library and roadmap should use GH issue numbers, not internal IDs, once the PR workflow is active.

**Why now:** This is the entry point for QRM8. Every subsequent ticket in the milestone will be created, branched, PR'd, reviewed, and merged using the workflow this ticket establishes. Deferring it means QRM8 work would follow the old ad-hoc commit-to-staging pattern, which contradicts the gh-workflow skill the project has already adopted.

**Risk of not doing it:** QRM8 implementation proceeds without standardized PR workflow. Tickets are committed directly to the staging branch without issue tracking, PRs, or review gates. The spec-review and final-review pause points — critical for user oversight — don't exist. The transition to PR-based workflow happens mid-milestone, creating inconsistency.

## Design Context

The gh-workflow skill (`docker/moderator/.claude/skills/gh-workflow/SKILL.md`) is the canonical reference. It defines two lifecycles (epic and standalone), milestone conventions, branch naming (`{issue-number}-{slug}`), PR conventions (`Resolves:` linking, the two-step retarget trick for non-default-branch PRs), and ticket file naming (`draft-{slug}.md` promoted to `{issue-number}-{slug}.md`).

The QRM8 epic already has a GitHub issue (#8) and a staging branch (`8-workspace-isolation-staging`). The roadmap at `tickets/8-workspace-isolation.md` on that branch lists 8 sub-tasks (QRM8-001 through QRM8-008). These sub-tasks reference the gh-workflow convention of GH-issue-numbered tickets but currently use internal `QRM8-00X` identifiers. The renumbering step (Step 6) brings them into alignment.

The moderator container mounts `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` (pre-isolation — bind mount still active), so `git`/`gh` operations inside the container land directly on the host workspace. This is acceptable for now; QRM8-005 will transition the moderator to its own git clone.

**Token sharing:** User confirmed it's fine to share the same `GH_TOKEN` between moderator and agents. The token is a fine-grained PAT scoped to the quorum repo only. The QRM8 roadmap (D5) plans env-filtering for the agent SDK subprocess in QRM8-006; for this bootstrap ticket, the token simply needs to be present in the container environment so `gh` can authenticate.

## Implementation Details

**ORDER MATTERS** — Step 1 must land first because the user will rebuild/restart containers immediately after this ticket merges. The moderator needs `gh` auth on its very first post-rebuild session to drive the PR workflow for remaining QRM8 tickets.

### Step 1: Thread `GH_TOKEN` env var into all services

Add `GH_TOKEN: ${GH_TOKEN}` to the environment blocks of every service that needs GitHub access:

- **moderator** — add alongside existing `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}`. Note: the moderator deliberately does NOT inherit `*shared-env` (see QRM7-007 comment at line 159), so `GH_TOKEN` must be added explicitly to the moderator's environment block.
- **x-shared-env anchor** — add `GH_TOKEN: ${GH_TOKEN}` to the `x-shared-env` block (line 7-16), which propagates to architect, teamlead, developer services automatically.
- **qa and productowner** — these services are not currently defined in `docker-compose.yml`. If they are added before this ticket merges, include `GH_TOKEN` via `*shared-env`. Otherwise, note the gap for when they're defined.

Update `.env.example` to include:

```
# === GitHub CLI Auth (all containers, QRM8) ===
# Fine-grained PAT scoped to the Quorum repo. Required for gh CLI operations
# (issues, PRs, milestones). Agents receive it in process.env for handler-level
# git operations; the moderator uses it for gh auth login in entrypoint.sh.
# See tickets/8-workspace-isolation.md D5 for the full PAT flow design.
GH_TOKEN=ghp_...
```

### Step 2: Install `gh` CLI 2.92.0+ in Dockerfile stages

**Moderator stage** (line ~93-95): Add `gh` to the `apt-get install` line. Debian Bookworm **does** ship a `gh` package (`gh 2.23.0+dfsg1-1`, from the Debian Go Packaging Team, 2023) and apt will prefer it over a third-party source unless explicitly pinned. Add the official GitHub CLI keyring + apt source **and** an apt preferences pin so `apt-get install gh` resolves to the upstream release (≥ 2.92.0):

```dockerfile
# Before the existing apt-get install block:
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && printf 'Package: gh\nPin: origin cli.github.com\nPin-Priority: 1000\n' \
      > /etc/apt/preferences.d/github-cli
```

Then include `gh` in the subsequent `apt-get update && apt-get install` block.

**Agent stage** (line ~47-49): Same approach. Although QRM8-006 (D5) plans to filter `GH_TOKEN` out of the SDK subprocess env, the `gh` binary is still useful for handler-level operations in `InvocationHandler` and for future agent-side PR/issue queries.

**Audit finding:** `gh` is **not** currently available in either the agent or moderator stage. Both stages install the same package set: `git bash ripgrep curl jq openssh-client ca-certificates`. The agent container I'm running in confirms: `which gh` returns empty.

**Phase-1 review finding (this PR):** The pre-PR implementation already on staging (commit `3d07e03`) adds the keyring and apt source but **omits** the apt preferences pin. Result: `apt-get install gh` resolves to Debian's `gh 2.23.0+dfsg1-1`, which is too old to drive the workflow reliably — `gh pr edit --base` fails silently on the Projects-classic GraphQL deprecation (observed while opening PR #21). Phase-2 implementation must add the apt preferences pin shown above so the upstream `gh` ≥ 2.92.0 wins, then rebuild.

### Step 3: Verify `/gh-workflow` skill discovery in moderator

After rebuild, verify inside the moderator's CC CLI session:

1. Type `/gh` and confirm autocomplete shows `/gh-workflow`
2. Run `/gh-workflow check the deploy workflow` (or any invocation) and confirm the skill loads without error

**Empirical verification already performed by the user:** The user confirmed `/gh-workflow` is discoverable in the moderator's autocomplete. This step is an acceptance check, not a code change. The skill symlink chain is:

```
.claude/skills/gh-workflow/SKILL.md (workspace root)
  -> docker/moderator/.claude/skills/gh-workflow/SKILL.md (canonical)
```

The moderator's `WORKDIR /mnt/quorum/workspace` ensures CC CLI discovers `.claude/skills/` at the workspace root.

### Step 4: Add "GitHub Workflow" section to `quorum.md`

Add a new top-level section after "Development Workflow" and before "Codebase Conventions". This is a **tight summary** of the full skill doc — agents need the shared mental model but the canonical reference stays in `SKILL.md`.

Content to cover:

- **Two lifecycles:** Epic (multi-step initiative with staging branch, sub-issues, milestone) and Standalone (single branch off `main`, no staging).
- **Milestone convention:** One milestone per epic, title format `{Marker} - {Title}`, epic + all sub-issues attach to the same milestone.
- **Branch naming:** `{issue-number}-{slug}` for feature branches; `{issue-number}-{slug}-staging` for epic integration branches. No `feature/` or `bugfix/` prefixes.
- **PR conventions:** Title `#{issue-number}: {Issue title}`. Body starts with `Resolves: https://github.com/ia64mail/quorum/issues/{issue-number}`. Implementation details in PR body, never in issue description.
- **The `Resolves:` two-step retarget trick:** For PRs targeting non-default branches, create targeting `main` first (triggers auto-link), then immediately `gh pr edit` to retarget to the staging branch. The link survives the base change.
- **Ticket file naming:** Draft as `draft-{slug}.md`, promote to `{issue-number}-{slug}.md` after GH issue creation. Update the H1 inside to `# #{issue-number}: {Title}`.
- **Issue content rule:** Issues contain summary, motivation, and problem statement only. Never include implementation details in issue descriptions.
- **Canonical reference:** Point to `docker/moderator/.claude/skills/gh-workflow/SKILL.md` for the full workflow spec.

### Step 5: Add Moderator persona — operational rules to `docker/moderator/CLAUDE.md`, descriptive summary to `quorum.md`

The moderator's ticket lifecycle rules are split across two files based on audience:

**`docker/moderator/CLAUDE.md` — operational rules (new `## Ticket Workflow Discipline` section):**
The moderator persona file gets the full 5-step lifecycle in imperative-directive tone ("do X", "never Y"), including: Phase-1/Phase-2 pause enforcement, `/gh-workflow` infrastructure creation, `Resolves:` retarget trick, dev flow orchestration, and the pre-isolation workspace note. This is what the moderator reads and follows at runtime.

**`quorum.md` — descriptive summary (trimmed `### Moderator` section under Role Configurations):**
A brief (~10-line) summary for other agents' shared understanding: the moderator is the orchestration hub, drives `/gh-workflow`, enforces two-phase user review, does not design/decompose/implement, and cross-references `docker/moderator/CLAUDE.md` for the full operational spec. Mirrors the tone and depth of the existing Architect/TeamLead/Developer role intros.

**Rationale for the split:** Operational workflow rules belong in the moderator persona (`docker/moderator/CLAUDE.md`) because only the moderator needs to follow them step-by-step. `quorum.md` is read by all agents and should describe *what* the moderator does, not *how* it does it — the same pattern used for every other role section.

### Step 7: Symlink `quorum.md` into moderator's user-scope dir so `@quorum.md` resolves

The moderator's `CLAUDE.md` opens with `@quorum.md`, which CC CLI resolves relative to the CLAUDE.md location (`/home/quorum/.claude/`). The workspace `quorum.md` lives at `/mnt/quorum/workspace/quorum.md` (bind mount), not alongside CLAUDE.md. Without a symlink, the `@quorum.md` directive silently fails and the moderator never loads the project conventions.

**Fix:** Add to `docker/moderator/entrypoint.sh` (alongside the existing `~/.claude/` seeding logic, before any check that might depend on quorum.md):

```bash
# Symlink workspace quorum.md into the moderator's user-scope ~/.claude dir
if [ ! -f /mnt/quorum/workspace/quorum.md ]; then
  echo "WARN: /mnt/quorum/workspace/quorum.md not found — @quorum.md will not resolve" >&2
fi
ln -sf /mnt/quorum/workspace/quorum.md /home/quorum/.claude/quorum.md
```

`ln -sf` is idempotent and survives volume state from prior runs. The defensive warning catches workspace mount misconfigurations early.

### Step 6: Audit and renumber QRM8 roadmap

The QRM8 roadmap (`tickets/8-workspace-isolation.md` on the `8-workspace-isolation-staging` branch) uses internal `QRM8-001` through `QRM8-008` identifiers for sub-tasks. These map to the following planned work:

| Internal ID | Title | GH Issue # |
|-------------|-------|------------|
| QRM8-001 | FileSessionStore on Named Volume | TBD |
| QRM8-002 | Git Worktree Per Invocation | TBD |
| QRM8-003 | Handler-Controlled Commit and Push | TBD |
| QRM8-004 | Branch-in-Flight Guard in MessageBroker | TBD |
| QRM8-005 | Moderator Becomes Standalone Git Client | TBD |
| QRM8-006 | PAT Wiring and SDK Environment Filtering | TBD |
| QRM8-007 | Redirect Agent Memory to Context Store | TBD |
| QRM8-008 | MCP Server Bind Mount Removal | TBD |

**Renumbering approach** (to be executed by the moderator once it has `gh` auth):

1. **Create GH sub-issues** for each of the 8 sub-tasks under the #8 epic, using the gh-workflow skill. Attach each to the `QRM8 - Workspace Isolation` milestone. Wire parent-child links via the GraphQL `addSubIssue` mutation.
2. **Record the GH-to-internal mapping.** As each sub-issue gets a real GH number (e.g., `#19`, `#20`, ...), build the mapping table.
3. **Rename ticket files** from `QRM8-00X-{slug}.md` to `{issue-number}-{slug}.md` per gh-workflow convention. (Currently only the roadmap file `8-workspace-isolation.md` exists on the staging branch; sub-task ticket files will be created as work begins.)
4. **Update cross-references** in the roadmap: replace `QRM8-001` etc. with `#{issue-number}` throughout the roadmap's Milestone Scope, Dependency Graph, and Recommended Sequencing sections.
5. **Update `quorum.md` commit message convention** if needed — the current `QRMX-NNN:` prefix convention may need to accommodate GH-issue-numbered commits (e.g., `#19:` or `8-001:` or keep `QRM8-001:` as an alias). This is a convention decision for the architect and user to settle during renumbering.

**Important:** This ticket does NOT execute the renumbering — it defines the approach. The moderator, once restarted with `gh` auth, will execute Steps 1-5 above as part of its first workflow-driven turn. The execution may happen as a standalone follow-up task or as part of the moderator's orientation after rebuild.

**Roadmap file location:** `tickets/8-workspace-isolation.md` on branch `8-workspace-isolation-staging`. The file was moved from `main` in commit `fae141a` ("remove QRM8 roadmap - moved to QRM8 staging branch") and renamed in `77a9735` ("rename roadmap to issue-numbered ticket and update H1").

## Acceptance Criteria

- [x] **Step 1 — GH_TOKEN wiring:** `GH_TOKEN: ${GH_TOKEN}` is present in the moderator service environment block and in the `x-shared-env` anchor (propagating to architect, teamlead, developer). `.env.example` includes a `GH_TOKEN` entry with explanatory comment. *(On staging branch via commit `3d07e03`.)*
- [x] **Step 2 — gh CLI 2.92.0+ installed:** `gh --version` reports a version ≥ 2.92.0 from `https://cli.github.com/packages` (not Debian's `gh 2.23.0+dfsg1`) inside both the moderator container and an agent container after rebuild. Installation uses the official GitHub CLI apt repository, keyring, **and** an apt preferences pin at `/etc/apt/preferences.d/github-cli` so the upstream repo wins over Debian's package. *(Dockerfile change verified in PR; `gh --version` verification requires rebuild.)*
- [x] **Step 3 — Skill discovery verified:** Inside the moderator's CC CLI session, `/gh-workflow` appears in autocomplete and the skill loads successfully when invoked. *(User-confirmed empirically; symlink chain intact.)*
- [x] **Step 4 — GitHub Workflow section in quorum.md:** A new "GitHub Workflow" section exists in `quorum.md` covering: two lifecycles (epic/standalone), milestone convention, branch naming, PR conventions, `Resolves:` retarget trick, ticket file naming, issue content rules. References `docker/moderator/.claude/skills/gh-workflow/SKILL.md` as the canonical source.
- [x] **Step 5 — Moderator persona / conventions split:** Moderator descriptive summary lives in `quorum.md` under `### Moderator`; operational Phase-1/Phase-2 rules live in `docker/moderator/CLAUDE.md` under `## Ticket Workflow Discipline`. Both files reference each other where appropriate.
- [x] **Step 7 — `@quorum.md` resolves in moderator container:** `docker/moderator/entrypoint.sh` creates `/home/quorum/.claude/quorum.md` as a symlink to `/mnt/quorum/workspace/quorum.md` on every container start. Post-rebuild verification: `ls -la /home/quorum/.claude/quorum.md` shows the expected symlink target.
- [x] **Step 6 — Renumbering plan documented:** The renumbering approach is documented in this ticket (see Implementation Details Step 6) with: the current internal-to-GH-issue mapping table (TBD entries), the 5-step execution plan, and the roadmap file location. Actual renumbering execution deferred to post-rebuild moderator session.

## Dependencies and References

### Dependencies
- **Blocks all QRM8 sub-tasks.** This ticket establishes the PR-based workflow every subsequent ticket will use. Must land before any other QRM8 implementation work begins.
- **No code dependencies.** This ticket modifies only Docker config (`Dockerfile`, `docker-compose.yml`, `.env.example`) and convention files (`quorum.md`). No application source code is touched.

### References
- `docker/moderator/.claude/skills/gh-workflow/SKILL.md` — canonical GitHub workflow spec
- `.claude/skills/gh-workflow/SKILL.md` — host-side symlink to the above (workspace root)
- `tickets/8-workspace-isolation.md` (on `8-workspace-isolation-staging`) — QRM8 roadmap with sub-task list
- `docker-compose.yml` — service definitions, environment blocks
- `Dockerfile` — moderator stage (lines 86-121), agent stage (lines 40-83)
- `.env.example` — environment variable template
- `quorum.md` — project conventions read by all agents at runtime
- `docker/moderator/entrypoint.sh` — moderator container startup script (modified: `@quorum.md` symlink; will need `gh auth login` in QRM8-005)
- `tickets/README.md` — ticket library conventions

### Roadmap Adjustments

See the companion "QRM8 Roadmap Audit" section below for analysis of how this ticket interacts with existing QRM8 sub-tasks.

---

## QRM8 Roadmap Audit

This section captures the audit of how inserting this PR-bootstrap ticket as QRM8's first work item affects the existing roadmap.

### Existing Sub-Tasks (from `8-workspace-isolation-staging:tickets/8-workspace-isolation.md`)

| Internal ID | Title | Phase | Dependencies |
|-------------|-------|-------|--------------|
| QRM8-001 | FileSessionStore on Named Volume | 1 (foundations) | Independent |
| QRM8-002 | Git Worktree Per Invocation | 2 (core isolation) | QRM8-006 |
| QRM8-003 | Handler-Controlled Commit and Push | 3 (hardening) | QRM8-002, QRM8-006 |
| QRM8-004 | Branch-in-Flight Guard in MessageBroker | 3 (hardening) | QRM8-002 |
| QRM8-005 | Moderator Becomes Standalone Git Client | 3 (hardening) | QRM8-006 |
| QRM8-006 | PAT Wiring and SDK Environment Filtering | 1 (foundations) | Independent |
| QRM8-007 | Redirect Agent Memory to Context Store | 1 (foundations) | Independent |
| QRM8-008 | MCP Server Bind Mount Removal | 1 (foundations) | Independent |

### Impact Analysis

1. **QRM8-006 (PAT Wiring) overlap.** This bootstrap ticket wires `GH_TOKEN` into `docker-compose.yml` and `.env.example` — which is a subset of QRM8-006's scope. QRM8-006 goes further: it implements SDK env-filtering (allowlist instead of `...process.env`), moderator `gh auth login` in `entrypoint.sh`, and tool-guard deny rules for credential paths. **Recommendation:** QRM8-006's Docker Compose and `.env.example` changes are subsumed by this ticket. When QRM8-006 is picked up, its scope should note that `GH_TOKEN` env wiring is already done and focus on the remaining items: SDK env allowlist, entrypoint auth bootstrap, and credential path deny rules.

2. **QRM8-005 (Moderator Git Client) interaction.** QRM8-005 plans `gh auth login --with-token` in `entrypoint.sh` and tool-guard deny rules. This bootstrap ticket does NOT modify `entrypoint.sh` — the moderator will use `GH_TOKEN` directly from its environment (e.g., `echo $GH_TOKEN | gh auth login --with-token` manually or via prompt guidance) until QRM8-005 automates it. **No conflict.**

3. **`gh` installation not anticipated in roadmap.** Neither QRM8-005 nor QRM8-006 explicitly calls out installing the `gh` binary in the Dockerfile. QRM8-005 lists "Dockerfile moderator stage (ensure git/gh CLI available)" in its Touches section, suggesting it was expected to handle installation. This bootstrap ticket front-loads the installation. **Recommendation:** QRM8-005 Touches should be updated to note `gh` is already installed.

4. **No dependency on FileSessionStore (QRM8-001).** This ticket is purely process infrastructure. QRM8-001 can proceed independently.

5. **Phase 1 independence preserved.** The four independent Phase 1 tickets (QRM8-001, QRM8-006, QRM8-007, QRM8-008) remain independent of each other and of this bootstrap ticket. However, they should all be driven through the new PR workflow once the moderator has `gh` auth.

6. **Renumbering creates a one-time disruption.** Renaming from `QRM8-00X` to GH issue numbers affects the roadmap file, cross-references, and the commit message convention. This is a known, bounded disruption that should happen early — ideally as the moderator's first action after rebuild — before any sub-task implementation generates commits with the old numbering scheme.

### Conclusion

No existing sub-tasks need scope changes or dependency adjustments beyond noting that `GH_TOKEN` Docker Compose wiring and `gh` CLI installation are subsumed by this bootstrap ticket. The insertion is clean — it's purely additive process infrastructure with no code-level conflicts.

---

## Implementation Notes

**Status:** Complete — accepted at code review.

**PR:** #21 (base `8-workspace-isolation-staging`, head `20-pr-based-workflow-bootstrap`).

**Commits (4 on branch):**

| Commit | Description |
|--------|-------------|
| `26845c8` | Phase-1 spec drop — full ticket file |
| `62281cf` | Patch spec — Step 2 upgraded to require `gh 2.92.0+` via apt preferences pin (discovered during Phase-1 review that staging's `3d07e03` omitted the pin, causing Debian's `2.23.0` to win) |
| `2019abc` | Dockerfile change — add apt preferences pin in both agent (line 51-52) and moderator (line 104-105) stages |
| `902b71d` | quorum.md — GitHub Workflow section, Moderator role section, `#<N>:` commit message convention |
| `b02e77b` | Phase-1 review amendment — split moderator persona/conventions, symlink `@quorum.md` |

**Files modified (in PR diff only — excludes staging baseline):**
- `Dockerfile` — 2-line addition per stage (agent + moderator): apt preferences pin at `/etc/apt/preferences.d/github-cli`
- `quorum.md` — GitHub Workflow section, trimmed Moderator summary, commit message convention update
- `docker/moderator/CLAUDE.md` — new `## Ticket Workflow Discipline` section (operational 5-step lifecycle)
- `docker/moderator/entrypoint.sh` — `@quorum.md` symlink creation + defensive warning
- `tickets/20-pr-based-workflow-bootstrap.md` — new file, updated with persona/conventions split and symlink step

**Files modified on staging baseline (commit `3d07e03`, not in PR diff):**
- `docker-compose.yml` — `GH_TOKEN` wiring to moderator env block + `x-shared-env` anchor
- `.env.example` — `GH_TOKEN` entry with explanatory comment
- `Dockerfile` — GitHub CLI keyring + apt source setup (both stages) + `gh` added to install line

**Deviations:** None for commits 1–4. Commit 5 is a Phase-1 review amendment (see below).

**Verification:**
- `npm run build` ✅ | `npm run lint` ✅ | `npm run test` ✅ (45 suites, 758 tests)
- Dockerfile pin syntax verified correct in both stages
- quorum.md content verified as tight distillation of SKILL.md (not a copy)
- Commit messages use the new `#<N>:` convention being introduced by this ticket
- Steps 2-3 require container rebuild for full empirical verification (`gh --version`, skill discovery)

**Phase-1 review amendment (commit 5):** User review surfaced two issues: (1) the moderator's `@quorum.md` import directive doesn't resolve because the workspace file is not alongside `~/.claude/CLAUDE.md`, so the moderator never loads the conventions; (2) operational Phase-1/Phase-2 lifecycle rules belong in the moderator persona (`docker/moderator/CLAUDE.md`), not in the shared `quorum.md` that all agents read. Fix: added `@quorum.md` symlink to `entrypoint.sh`, moved operational rules into a new `## Ticket Workflow Discipline` section in `docker/moderator/CLAUDE.md`, and trimmed `quorum.md`'s `### Moderator` to a brief descriptive summary with cross-reference.
