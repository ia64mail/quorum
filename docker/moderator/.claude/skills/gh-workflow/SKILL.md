---
name: gh-workflow
description: Create and manage GitHub issues, epics, sub-issues, branches, and PRs for the Quorum repo, in lockstep with the ticket library and per-epic GitHub milestones.
allowed-tools: Bash(gh *) Bash(git *) Read Glob Grep
argument-hint: a short description of where in the workflow you are — e.g., "draft an epic for X", "promote draft ticket to issue", "branch for #42", "open PR"
---

# Quorum — GitHub Workflow

This skill describes how work travels from a requirement to a merged PR in the Quorum repo. It is a **reference for reasoning**, not a fixed automation. When invoked, study the user's situation, work out the exact steps and `gh`/`git` invocations that fit, and confirm the plan with the user before executing.

---

## Milestone Convention

Quorum is a single-repo, single-developer project. Grouping and progress tracking happen via **GitHub milestones**, not Projects v2. The model is intentionally lightweight:

- **One milestone per major initiative (epic).** Title format: `{Marker} — {Title}` (e.g., `QRM8 — Workspace Isolation`). The `Marker` is the milestone tag carried through the ticket library; the `Title` mirrors the epic issue's title.
- **The epic and every one of its sub-issues attach to the same milestone.** This is what makes the milestone's progress bar meaningful — `closed / total` counts the whole wave.
- **Standalone bugs and one-off tasks usually skip milestones.** Attach one only when the bug belongs to a follow-up wave on an existing initiative (e.g., a QRM8-era regression fix joining the QRM8 milestone).
- **No Projects v2 board, no custom fields.** Status is expressed via issue Open/Closed, the linked PR's state, and (optionally) `status: …` labels if a finer-grained signal is wanted.

Milestones in the GitHub UI live at `https://github.com/ia64mail/quorum/milestones`, with each milestone page showing its progress bar and the filtered list of attached issues.

---

## Typical Workflow

Nearly every change in this repo travels along one of two paths:

1. **Epic lifecycle** — a multi-step initiative split across several sub-issues
2. **Bug / standalone lifecycle** — a single, self-contained unit of work

Pick the path that matches the request, locate the user's current stage within it, sketch the concrete steps, get sign-off, and only then execute.

### Epic Lifecycle — From Requirements to Sub-Issues

An epic moves through several distinct stages — from rough requirement, to spec, to GitHub issue, to staging branch, to merged sub-issues. The stages below are the map; before acting on anything, locate where the user currently stands and plan from that point forward.

#### 1. Requirements Intake

A feature or larger initiative arrives. It may show up as:
- A short user story or task description
- A **milestone plan** — a file that scopes the next release. The roadmap lists candidate tickets and frames the milestone's theme; each row in its breakdown is a future sub-issue.

#### 2. Epic Ticket Drafting

Take the incoming requirements, settle on a design direction, work out which areas of the system will need to move, and capture it all in a Markdown file under `tickets/`. Drafting happens on `main`, and the file follows the repo's existing ticket-library style (see `tickets/README.md`).

This is also the moment to call scope: a single, well-bounded ticket stays a standalone issue; anything that fans out into multiple coordinated changes becomes an epic. The draft itself usually already suggests how it would split.

**Why this split matters:** the Markdown file is the deep end — full design rationale, subtask table, API impact, diagrams. The GitHub issue that comes next is only the shallow summary — *what* the work is and *why* it matters. Implementation reasoning never lands on GitHub.

#### 3. Epic Issue Creation

Once the draft has been reviewed:

1. **Open the GitHub epic issue** with the draft's summary and motivation as its body. No implementation detail, no design notes — those stay in the ticket file.
2. **Stamp the `Epic` issue type** (the org/repo-native field).
3. **Attach the issue to the epic's milestone.** Create the milestone first if it doesn't exist yet (`{Marker} — {Title}`, e.g. `QRM8 — Workspace Isolation`).
4. **Decide whether staging is needed:**
   - Use staging when the epic will produce **two or more** sub-issues' worth of code that should land together — they need a single integration branch to mature on.
   - In that case, cut a `{issue-number}-{slug}-staging` branch off `main`. The branch name's `-staging` suffix is the only marker — no separate field flag is used.
   - A single-sub-issue epic skips staging entirely — that one sub-issue just branches off `main` and merges back to it.

#### 4. Promote the Draft Ticket and Open the Staging PR

Now that there's a real issue number to anchor against:

1. **Rename** `draft-{slug}.md` → `{issue-number}-{slug}.md` so the filename lines up with the planned branch.
2. **Edit the H1 inside the file** so the title carries the issue reference, e.g. `# #136: Multi-agent Conversation Routing`.
3. **Commit straight onto the staging branch** when there is one — the spec file is its first commit. (Without staging, commit onto a fresh `main`-rooted branch instead.) Don't spin up a side-branch just to land the spec.
4. **Open the PR against the epic issue.** For staging epics this is the eventual `staging → main` merge — it doubles as both the spec delivery and the vehicle that lands every sub-issue change later.

#### 5. Sub-Issue Creation

The epic's breakdown table is the source list. Walk through it, and for each row:

1. **File a sub-issue** carrying that row's title and description — summary plus acceptance criteria only, no implementation detail.
2. **Stamp the type** — `Task` for ordinary work, `Bug` if the row is fixing a defect.
3. **Hang it off the epic** via GitHub's native sub-issue (parent-child) link.
4. **Attach it to the same milestone as the parent epic** so the milestone's progress bar counts the whole wave.

A sub-issue does not need a PR right away — it can sit in "To Do" until someone takes it.

#### 6. Per-Sub-Issue Developer Flow

When a sub-issue is picked up and shifts into "In Progress":

1. **Cut a branch** from the staging branch (`{epic-number}-{slug}-staging`) for staging epics, or from `main` otherwise.
2. **Open a PR** targeting that same base.
3. **Wire the PR to the sub-issue** with a `Resolves:` line.
4. **Make the first commit a ticket file** holding implementation notes. The only carve-out is a truly trivial one- or two-line change.
5. From there: build → review → merge.

### Bug / Standalone Issue Lifecycle

A lighter path: no staging, no sub-issues, no breakdown. Used for any one-off fix or piece of work, regardless of who originates it.

#### 1. Starting Point

The trigger comes in one of two shapes:
- **An issue already exists** on GitHub — surfaced during code review, caught during UAT, or opened by the user directly.
- **No issue yet** — the report arrived via chat, email, or a passing remark.

Either way, the immediate next move is to draft a ticket file.

#### 2. Ticket Drafting

Open a fresh ticket under `tickets/` on `main`. How deep the draft goes depends on who will act on it:
- **Full spec** when the same person will both write and implement it — include problem statement, root cause, and a worked-out plan.
- **Problem statement plus a chosen design** when implementation will be left to whoever picks the work up.

#### 3. GitHub Issue

- **Already an issue?** Reuse it as-is — no new issue is needed. Skip ahead to Step 4 with the existing number.
- **No issue yet?** Open one in the repo using the ticket's summary and problem statement — never any implementation detail.

Then, in both cases, make sure the issue:
- **Has a type** — `Bug` for defects, `Task` for any other discrete piece of work.
- **Is attached to a milestone** only when it belongs to a larger initiative's wave (e.g., a QRM8-era regression fix). Pure one-offs stay milestone-free.
- **Has an assignee** when the right person is already obvious.

#### 4. Ticket Rename, Branch & PR

1. **Rename** `draft-{slug}.md` → `{issue-number}-{slug}.md`.
2. **Update the H1** inside so the title carries the issue reference, e.g. `# #512: Fix calendar event timezone handling`.
3. **Cut a branch** off `main`: `{issue-number}-{short-slug}` — these never use staging.
4. **Commit** the renamed ticket, **push**, and **open a PR** with the `Resolves:` line linking the issue.

#### 5. Implementation

The branch then runs the usual course: implement → code review → merge into `main`.

---

## Core Conventions

These conventions apply across both lifecycles. Treat them as constraints when building any plan.

### Issue Content

- Issues contain **Summary, Motivation, and Problem Statement only** — the "what" and the "why."
- **Never include implementation details** in issue descriptions. Those belong in the PR body or the ticket Markdown file.
- **Never prefix GitHub issue titles with external IDs.** GitHub issues have their own numbering. External references (Jira-style IDs, ADR numbers, etc.) belong inside the issue body as a link.
- Motivation and reasoning describe the task in general and should stay stable; implementation details change as work progresses.
- If a detailed spec exists in `tickets/*.md`, reference it from the issue body: `See tickets/<filename>.md for full spec`.

### Branch Naming

- Pattern: `{issue-number}-{short-slug}` (e.g., `42-multi-agent-router`).
- Slug: lowercase, hyphens, 3–6 words, derived from the issue title.
- No `feature/`, `bugfix/`, or `issue-` prefixes — just number and slug.
- Staging branches add a `-staging` suffix: `{issue-number}-{slug}-staging`. The suffix is what marks the branch as protected.

### PR Conventions

- **Title:** `#{issue-number}: {Issue title}` (e.g., `#42: Multi-agent conversation routing`).
- **Body:** Implementation details, design decisions, and a test plan.
- **Closing keyword:** the **first line of the PR body** must be `Resolves: https://github.com/<owner>/<repo>/issues/{issue-number}`.
- **Push** with `-u` to set tracking on first push.

### PR-to-Issue Linking — IMPORTANT

GitHub's `Resolves:` keyword only auto-links a PR to an issue when the PR targets the **default branch** (`main`). PRs targeting non-default branches (e.g., a staging branch) are silently ignored — no Development sidebar link, no auto-close on merge.

**Workaround for staging PRs — always use this two-step sequence:**

1. **Create the PR targeting `main` first** — this triggers the `Resolves:` auto-link and populates the Development sidebar.
2. **Immediately switch the base to the staging branch** — the link survives the base change.

```bash
# Step 1: create targeting main (auto-link fires)
gh pr create --base main --head {branch} --title "..." --body "Resolves: ..."

# Step 2: retarget to staging (link persists)
gh pr edit {pr-number} --base {staging-branch}
```

This applies to **any PR that targets a non-default branch**: epic spec PRs that go staging-to-staging, sub-issue PRs that target a staging branch, etc. Never skip it — without it, the issue and PR are disconnected in the GitHub UI.

### Ticket File Naming

- When promoting a draft ticket after issue creation: rename `draft-{slug}.md` to `{issue-number}-{slug}.md`.
- The slug is preserved from the draft filename (minus the `draft-` prefix).
- Update the title inside the file so the first H1 references the issue number.

### Issue Type

Issue classification is carried entirely by the **Issue Type** field — a repo/org-native, label-free mechanism. Don't use repo labels to encode classification.

| Type   | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| `Epic` | Major initiative — parent of multiple sub-issues          |
| `Bug`  | An unexpected problem or behavior                         |
| `Task` | A specific piece of work (default for sub-issues)         |

`gh issue create` has no `--type` flag (as of CLI 2.x), so setting the type is a second step:

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/{issue-number} -f type=Epic   # or Bug, Task
```

Reading the type back:

```bash
gh issue view {issue-number} --json issueType -q .issueType.name
```

### Epic / Sub-Issue Hierarchy

- An **epic** is a GitHub issue with **issue type `Epic`**.
- **Sub-issues** are linked to it via GitHub's native parent-child sub-issue feature; each sub-issue carries its own type (`Task` or `Bug`).
- The epic body may list its sub-issues for visibility, but the parent-child link is the source of truth.
- `gh issue edit --add-parent` does not exist; the link is established via GraphQL:

  ```bash
  EPIC_ID=$(gh issue view {epic-number} --json id -q .id)
  SUB_ID=$(gh issue view {sub-number}  --json id -q .id)
  gh api graphql -f query='mutation { addSubIssue(input: {issueId: "'"$EPIC_ID"'", subIssueId: "'"$SUB_ID"'"}) { issue { id } } }'
  ```

### Staging Workflow

- **Staging is per-epic, not per-ticket.** It's used when an epic produces 2+ pieces of integrated work that should land together.
- **Staging signal:** carried entirely by the branch name. There is no separate field or label — the `-staging` suffix on the integration branch and the epic body's wording are the source of truth.
- **Staging branch:** `{epic-number}-{slug}-staging`, created from `main`. The `-staging` suffix is what makes it protected.
- **Sub-issues under a staging epic:** branch from and PR into the staging branch, not into `main`.
- **Staging PR (epic):** the staging branch's PR targets `main` — this is the final merge that lands everything for the epic.
- **Non-staging issues:** branch from and PR into `main` directly.

---

## Important Rules

- **Never put implementation details in issue descriptions.** If the user offers them, suggest moving them into the PR body or a `tickets/*.md` file.
- **Always confirm before creating anything.** Show the user a preview of what's about to happen — title, body, issue type, target branch base, link targets — and wait for approval.
- **Always report back** the new issue number, the issue type that was applied, and (for sub-issues) the parent epic.
- When creating multiple sub-issues for an epic at once, create them sequentially, report each with its number, and confirm before adding the next so the user can adjust the roadmap as they go.

---

## How to Use This Skill

When this skill is invoked:

1. **Locate the user in the workflow.** Are they drafting an epic, promoting a draft into a GH issue, opening sub-issues, starting work on an existing issue, opening a PR, or something else? Ask if it's not obvious.
2. **Map the situation to the steps above.** Pick the lifecycle (epic vs. standalone) and the step or steps that apply.
3. **Draft a concrete plan.** Spell out the exact `gh`/`git`/file operations you intend to run, in order, with the values filled in (issue title, body, type, branch name, PR title/body, etc.).
4. **Confirm with the user before executing.** Present the plan, wait for approval, then run it. Stop and re-check whenever something diverges from the plan.
5. **Report back** what was created, with full references (issue number, PR number, branch name, ticket file path) so the user can update the roadmap and ticket library.