# QRM3-001: Code Quality Metrics Tooling

## Summary

Introduce a code quality metrics pipeline for the Quorum project. This covers the custom Halstead entropy report (`tools/entropy-report/`), its aggregate-metrics bug fix, and the post-QRM2 baseline analysis. Created post-factum to capture work already completed and frame future quality tooling under QRM3.

## Problem Statement

As the codebase grew through QRM1 (infrastructure) and QRM2 (Claude Code SDK integration), there was no systematic way to track complexity trends across commits. Manual code review catches local quality issues but misses macro-level signals like vocabulary explosion, difficulty creep, or uneven complexity distribution across apps.

A custom Halstead entropy report was built to fill this gap. During analysis, a bug was discovered where aggregate metrics collapsed at commit `921d39f` due to `stripComments()` misinterpreting regex literals in concatenated source. This has been fixed.

## Implementation Details

### 1. Entropy Report Script — `tools/entropy-report/entropy-report.mjs`

*To be implemented.* — Already implemented.

- Custom regex-based TypeScript tokenizer classifying operators and operands
- Git history traversal computing Halstead Volume, Difficulty, Effort, and Estimated Bugs per commit
- Per-app breakdown (agent, mcp-server, terminal, common)
- Interactive HTML output with 7 Chart.js visualizations
- Companion `.txt` output with LLM analysis prompt and raw JSON dataset

### 2. Aggregate Halstead Bug Fix

*To be implemented.* — Already implemented.

- **Root cause**: `analyzeCommit()` concatenated all `.ts` file contents into one string before computing Halstead. The `stripComments()` regex does not handle JS regex literals (`/pattern/`), causing cross-file token corruption when a file contained regex with quote characters.
- **Fix**: Refactored `computeHalstead()` into `tokenize()` (returns raw Maps) + `halsteadFromMaps()` (derives metrics) + `mergeMaps()` (additive merge). `analyzeCommit()` now tokenizes each file independently and merges operator/operand Maps, eliminating cross-file interference.
- **Validation**: Volume at commit `921d39f` corrected from 194,234 (broken) to 628,870 (expected).

### 3. Post-QRM2 Baseline Report

*To be implemented.* — Already implemented.

- Generated report: `tools/entropy-report/reports/entropy-20260325-031531.html` (pre-#50 lexer — absolute figures biased; see Implementation Notes and the in-report banner)
- LLM analysis section populated with 5-paragraph assessment covering complexity trajectory, Volume/Difficulty relationship, estimated bugs, per-app distribution, and AI code entropy observations.
- Report titled "Post QRM2 Analysis" to mark the milestone boundary.

### 4. Future Quality Tooling (Not Yet Implemented)

*To be implemented.*

- Cyclomatic complexity integration (e.g., `lizard`) for per-function hotspot detection
- CI gate or pre-merge report generation to catch complexity regressions
- Trend alerting when Difficulty reverses its current downward trajectory
- Per-file Volume threshold monitoring (flag files exceeding 5,000 Volume)

## Acceptance Criteria

- [x] Entropy report script runs successfully across all 110 commits
- [x] Aggregate Halstead metrics are correct (no collapse at `921d39f`)
- [x] Post-QRM2 HTML report generated with LLM analysis section populated
- [ ] Future: cyclomatic complexity tooling integrated
- [ ] Future: CI quality gate or automated trend monitoring

## Implementation Notes

- **2026-05-29 — Halstead correctness pass** ([#50](50-entropy-report-halstead-correctness.md)): a follow-up review found the formulas were right but the *lexical input* and *aggregation* were systematically biased. Fixed in that ticket: the regex/`stripComments` tokenizer was replaced with a character-scanning lexer that recurses into template-literal `${…}` interpolations, recognises regex literals as single operands, normalises string quote styles and numeric separators, and computes per-app Volume from per-app union maps (so the "Volume by Application" chart is honest about not summing to the project total). The LLM prompt and HTML report now share one first-source-commit anchor, `Avg Difficulty` skips empty leading commits, and Estimated Bugs uses Halstead's canonical `B = E^(2/3) / 3000`. Tokenizer behaviour is now covered by `tools/entropy-report/entropy-report.test.mjs`.