# QRM7-018: GitHub Actions CI Pipeline (Lint / Build / Test)

**Status:** Open

## Summary

Add a GitHub Actions workflow that runs `npm run lint`, `npm run build`, and `npm run test` on every push to `main` and every pull request targeting `main`. Surface the workflow status as a badge in `README.md` so contributors can see CI health at a glance. No production behavior changes — this ticket is pure repo plumbing.

## Problem Statement

The repository has no continuous integration today. Every quality signal we have — lint, build, the ~760-test Jest suite — depends on contributors remembering to run them locally before pushing. In practice that's lossy:

- Branches occasionally land with lint or type-check regressions that only surface when the next contributor pulls and runs `npm run build` themselves.
- The Jest baseline drifts: someone adds a test that passes locally but breaks under a clean install on a different Node version.
- PR reviewers have no automated "green check" — they read the diff and trust the author's claim that `npm run test` passed.

The cost of adding CI is low (a single workflow file, free for public-or-org GitHub usage on `ubuntu-latest`) and the payoff is high: every push and every PR gets a deterministic, reproducible verification.

## Design Context

This ticket sits outside the runtime architecture — it touches no agent, no MCP plumbing, no Docker. It's a repository-level guardrail. Two design choices are worth recording:

**Triggers.** Run on both `push` to `main` and `pull_request` targeting `main`. The push trigger catches direct commits and merge commits (the user's stated requirement: "on every commit into master"). The PR trigger gives early feedback before merge, which is the higher-leverage signal. Both are cheap on a single-job workflow.

**Scope.** Lint / build / test only. Explicitly *not* included:

- `npm run test:e2e` — the script in `package.json` points to `./apps/quorum/test/jest-e2e.json`, but `apps/quorum/` does not exist in this repo (the apps are `agent` and `mcp-server`). The script is dead; resurrecting it is out of scope here.
- Docker image build — `./scripts/start.sh` requires `WORKSPACE_PATH` and pulls real images for OpenSearch, Ollama, and Claude Code. Running it in CI would be slow, brittle, and offers no value over the Jest suite for verification of code correctness.
- Coverage reporting, dependency caching beyond npm's built-in setup-node cache, Slack/Discord notifications, matrix testing across Node versions — all worthwhile follow-ups, none required for the baseline guardrail.

## Implementation Details

### Workflow file

One file: `.github/workflows/ci.yml`. Single job, single OS, single Node version. Mirrors the user's local dev loop so a green CI run means "this would also be green on a fresh checkout."

Skeleton:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    name: Lint / Build / Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm run test
```

Notes on the shape:

- **Node 24** matches `engines.node` in `package.json`. Pinning to the same major the project declares avoids `engine-strict` install warnings and keeps CI honest about the supported runtime.
- **`npm ci`** rather than `npm install` — deterministic from `package-lock.json`, fails fast on lockfile drift, and is the documented norm for CI environments.
- **`actions/setup-node` cache: npm** — built-in caching of the npm cache directory, keyed off `package-lock.json`. Cuts cold install time roughly in half on subsequent runs. No custom cache action needed.
- **No `continue-on-error`** anywhere — every step is a hard gate. Lint fails the job, build fails the job, test fails the job.
- **No `concurrency` block** for now. The repo doesn't have enough PR throughput to need cancel-in-progress yet; can be added later if Actions minutes start to bite.

The `lint` script uses `--fix`, which mutates files. That's fine in CI: file mutations are discarded with the workspace, and `eslint --fix` still exits non-zero on unfixable errors, which is what the job needs to fail on. We do **not** add a `git diff --exit-code` check after lint — that would block CI on auto-fixable formatting drift, which is noise, not signal.

### README badge

Add a single line just under the H1 heading in `README.md`:

```markdown
[![CI](https://github.com/ia64mail/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/ia64mail/quorum/actions/workflows/ci.yml)
```

Owner/repo derived from `git remote -v` (`git@github.com:ia64mail/quorum.git`). The badge SVG comes from the actions API, links to the workflow run list, and updates automatically when the workflow file or default-branch status changes. No further README restructuring — the badge sits above the existing intro paragraph.

### Sequencing

Independent. No dependencies on any other QRM7 ticket. Land at any time; the first CI run becomes the baseline for "green main."

### Touches

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/ci.yml` | Created | Single-job workflow: checkout → setup-node@24 → npm ci → lint → build → test |
| `README.md` | Modified | Add CI badge below the H1 heading |

## Acceptance Criteria

- [ ] `.github/workflows/ci.yml` exists and is valid YAML (passes `yamllint` and GitHub's own workflow parser)
- [ ] Workflow triggers on `push` to `main` and `pull_request` against `main`
- [ ] Job runs `npm ci`, `npm run lint`, `npm run build`, `npm run test` in that order, each as a hard gate
- [ ] Node version matches `package.json` `engines.node` (currently `24`)
- [ ] npm cache via `actions/setup-node` is enabled
- [ ] First workflow run on `main` is green (or, if not, the failure is investigated and either fixed or explicitly noted in the ticket's Implementation Notes)
- [ ] `README.md` has a CI status badge above the intro paragraph, linking to the workflow run list
- [ ] No changes to runtime code, Docker config, or test fixtures

## Dependencies and References

**Depends on:** —

**Blocks:** —

**References:**

- `package.json` — `scripts.lint`, `scripts.build`, `scripts.test`, `engines.node`
- [GitHub Actions: Building and testing Node.js](https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-nodejs) — official setup-node + npm ci pattern
- [actions/setup-node](https://github.com/actions/setup-node) — `cache: 'npm'` documentation
- `README.md` — badge insertion point (directly under the H1)