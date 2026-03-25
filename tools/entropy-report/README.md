# Entropy Report — Source Code Complexity Analysis

Measures Halstead complexity metrics across git history and generates an interactive HTML report.

## Prerequisites

- Node.js 20+
- git

## Usage

### 1. Generate the report

```bash
node tools/entropy-report/entropy-report.mjs
```

This produces two files in `tools/entropy-report/reports/`:

| File | Contents |
|------|----------|
| `entropy-{timestamp}.html` | Interactive HTML report with Chart.js visualizations |
| `entropy-{timestamp}.txt` | LLM analysis prompt + raw JSON data for re-analysis |

### 2. Post-process with LLM summary

The HTML report includes a placeholder for an LLM-generated analysis section. To fill it in:

1. Open the `.txt` file — the top section contains a ready-to-use prompt
2. Feed it to Claude Code (or any LLM):
   ```
   Read tools/entropy-report/reports/entropy-{timestamp}.txt and follow
   the LLM ANALYSIS PROMPT inside it. Then replace the #llm-placeholder
   section in the matching .html file with your analysis.
   ```
3. The LLM should produce HTML-formatted analysis (`<p>` tags, `<strong>` for emphasis) and replace the `<div id="llm-placeholder">` section in the `.html` file

The `.txt` file also contains the full raw JSON dataset under `RAW DATA (JSON)`, enabling re-analysis with different prompts or models without re-running the script.

## Output structure

```
tools/entropy-report/
  entropy-report.mjs       # The script
  README.md                # This file
  reports/
    entropy-20260324-*.html
    entropy-20260324-*.txt
```

## What it measures

**Halstead complexity metrics** (Maurice Halstead, 1977) — information-theoretic measures derived from operator/operand counts in source code:

| Metric | Formula | Meaning |
|--------|---------|---------|
| Volume | V = N × log₂(η) | Information content of the program |
| Difficulty | D = (η₁/2) × (N₂/η₂) | How hard the code is to understand |
| Effort | E = D × V | Mental effort to develop/maintain |
| Estimated Bugs | B = V / 3000 | Halstead's bug predictor |

Where: N = total operators + operands, η = unique operators + operands, η₁ = unique operators, η₂ = unique operands, N₂ = total operands.

## Charts included

1. **Halstead Volume** — total codebase information content over time
2. **Halstead Difficulty** — maintenance complexity trend
3. **Lines of Code & File Count** — growth tracking (dual axis)
4. **Volume per File** — normalized complexity (detects bloat vs healthy growth)
5. **Estimated Bugs** — Halstead's V/3000 predictor
6. **Volume by Application** — stacked area showing per-app complexity distribution
7. **Volume Delta** — per-commit complexity change (red = increase, green = decrease)

## Tokenizer

The script uses a custom regex-based TypeScript tokenizer that classifies tokens as:

- **Operators**: TypeScript keywords (`if`, `class`, `import`, etc.) + symbol operators (`+`, `===`, `=>`, etc.)
- **Operands**: identifiers, string/template literals, numeric literals, boolean literals

Comments are stripped. The tokenizer is optimized for consistency across commits rather than academic precision — trends are meaningful even if absolute numbers differ slightly from a full AST-based parser.

## Fixed: aggregate Halstead collapse at `921d39f`

The report previously showed a dramatic drop in aggregate Volume (609,880 → 194,234) and Difficulty (355 → 218) at commit `921d39f`, caused by `stripComments()` misinterpreting regex literals when all files were concatenated into a single string.

**Fix**: `analyzeCommit()` now tokenizes each file independently and merges the operator/operand `Map`s across files before computing aggregate Halstead metrics. This avoids cross-file `stripComments` interference entirely — the regex never sees content from multiple files at once.

## Scope

Analyzes `.ts` files in `apps/` and `libs/` (excluding `.d.ts`). Per-app breakdown covers:

- `apps/terminal/` — Terminal App
- `apps/mcp-server/` — MCP Server
- `apps/agent/` — Agent App
- `libs/common/` — Common Library

## Appendix: Halstead vs Cyclomatic Complexity

This tool computes **Halstead metrics**. A complementary approach is **cyclomatic complexity** (available via `lizard`). They measure different things:

**Halstead** — measures **information content**. Counts operators and operands, computes Volume/Difficulty/Effort. Answers: "how much stuff is in this code and how hard is it to read?"

**Cyclomatic complexity** — counts **decision paths**. Every `if`, `else`, `switch case`, `&&`, `||`, `for`, `while`, ternary `?` adds +1. Answers: "how many ways can execution flow through this function?"

### Practical difference

| | Halstead | Cyclomatic |
|---|---|---|
| A 200-line function with zero branching | High volume | CC = 1 (trivial) |
| A 20-line function with 15 nested if/else | Low volume | CC = 15 (dangerous) |
| What it catches | Bloat, cognitive load, "too much going on" | Untestable spaghetti, missed branches |
| Actionable signal | "This file is getting dense, refactor" | "This function needs N+1 tests to cover all paths" |

### Complementary, not competing

Halstead tracks **growth trends** well — "is the codebase getting harder to maintain over time?" That is what this entropy report does (macro lens).

Cyclomatic catches **individual problem functions** — "this 40-line handler has CC=25, it's a bug magnet." That is what lizard does (micro lens).

### Available tools comparison

| Feature | This script (Halstead) | lizard (cyclomatic) |
|---|---|---|
| Metrics | Volume, Difficulty, Effort, Est. Bugs | Cyclomatic complexity, NLOC, token count, param count, nesting depth |
| Scope | Codebase-wide trends across git history | Per-function snapshot |
| TypeScript support | Yes (custom tokenizer) | Yes (native) |
| Git history | Yes (built-in) | No (single snapshot) |
| Output | HTML + Chart.js, TXT | XML, CSV, HTML |
| Maintenance | In-house | Active open-source (2.3k stars) |