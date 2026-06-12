# Entropy Report — Source Code Complexity Analysis

Measures source-code complexity across two complementary lenses. A complete analysis runs **both** scripts (see [Halstead vs Cyclomatic](#appendix-halstead-vs-cyclomatic-complexity)):

| Script | Lens | Scope |
|--------|------|-------|
| `entropy-report.mjs` | Halstead information density | Whole git history, per commit → interactive HTML report |
| `cyclomatic-report.mjs` | Cyclomatic decision paths | Single snapshot of current HEAD → aggregate stats |

Both read the **same source set** — `SOURCE_DIRS`, `EXCLUDE_PATHS`, and the `.ts`/`.d.ts` rules are defined once in `entropy-report.mjs` and imported by `cyclomatic-report.mjs`, so the two reports always describe exactly the same files.

## Prerequisites

- Node.js 20+
- git
- [`lizard`](https://github.com/terryyin/lizard) — only for `cyclomatic-report.mjs` (`pipx install lizard` or `pip install --user lizard`); must be on `PATH`

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

### 3. Generate the cyclomatic complexity snapshot

A complete analysis is **both** reports. Halstead density alone cannot tell *concise* dense code from *overloaded* dense code — the cyclomatic snapshot supplies the decision-path dimension over the identical source set, so always run it as part of the analysis:

```bash
node tools/entropy-report/cyclomatic-report.mjs
```

This produces `reports/cyclomatic-{timestamp}.txt` — anonymous **aggregate** statistics only (no file or function names), matching the entropy report's anonymity contract:

| Field | Meaning |
|-------|---------|
| `avgCcn` / `medianCcn` / `p90Ccn` / `p99Ccn` / `maxCcn` | Cyclomatic complexity distribution across all functions |
| `pctFnCcnOver10` / `over15` / `over25` | Share of functions above each risk threshold |
| `functionsPerFile` (derived) | Decomposition — how finely the code is split into units |
| `avgFunctionNloc` / `maxFunctionNloc` | Function-length distribution |
| `avgParams` / `maxParams` | Interface width |

Read the two reports **together**: Halstead answers "is the codebase trending denser/harder over time?" (macro, whole-history); cyclomatic answers "is that density branchy or just expressive?" (micro, current snapshot). Neither is conclusive alone — see [Halstead vs Cyclomatic](#appendix-halstead-vs-cyclomatic-complexity).

## Output structure

```
tools/entropy-report/
  entropy-report.mjs       # Halstead history report (also exports the shared scope config)
  cyclomatic-report.mjs    # Cyclomatic HEAD snapshot (imports scope from entropy-report.mjs)
  entropy-report.test.mjs  # Tokenizer tests
  README.md                # This file
  reports/
    entropy-20260324-*.html
    entropy-20260324-*.txt
    cyclomatic-20260324-*.txt
```

## What it measures

**Halstead complexity metrics** (Maurice Halstead, 1977) — information-theoretic measures derived from operator/operand counts in source code:

| Metric | Formula | Meaning |
|--------|---------|---------|
| Volume | V = N × log₂(η) | Information content of the program |
| Difficulty | D = (η₁/2) × (N₂/η₂) | How hard the code is to understand |
| Effort | E = D × V | Mental effort to develop/maintain |
| Estimated Bugs | B = E^(2/3) / 3000 | Halstead's delivered-bugs predictor |

Where: N = total operators + operands, η = unique operators + operands, η₁ = unique operators, η₂ = unique operands, N₂ = total operands.

## Charts included

1. **Halstead Volume** — total codebase information content over time
2. **Halstead Difficulty** — maintenance complexity trend
3. **Lines of Code & File Count** — growth tracking (dual axis)
4. **Volume per File** — normalized complexity (detects bloat vs healthy growth)
5. **Estimated Bugs** — Halstead's E^(2/3)/3000 predictor
6. **Volume by Application** — overlaid (non-stacked) lines of per-app complexity. Each app's Volume is computed from its own union vocabulary, so the lines are **not additive** to the project total
7. **Volume Delta** — per-commit complexity change (red = increase, green = decrease)

## Tokenizer

The script uses a custom character-scanning TypeScript lexer (`tokenizeInto`) that classifies tokens as:

- **Operators**: TypeScript keywords (`if`, `class`, `import`, etc.) + symbol operators (`+`, `===`, `=>`, etc.)
- **Operands**: identifiers, string/template literals, regex literals, numeric literals, boolean literals

The lexer scans comments inline (no separate strip pass) and handles the cases a flat regex tokenizer got wrong (ticket #50):

- **Template-literal interpolations** are tokenized — operators and identifiers inside `${…}` are counted, not swallowed into one operand.
- **Regex literals** (`/[-:]/g`) count as a single operand instead of being split into operator soup; a precedes-token heuristic distinguishes regex-open from division.
- **String operands are quote-normalized** — `'foo'`, `"foo"` and `` `foo` `` collapse to one entry.
- **Numeric literals** accept `_` separators, BigInt suffixes on all bases, and leading-dot decimals (`1_000_000`, `0xffn`, `.5`) as single operands.

The lexer is optimized for consistency across commits rather than academic precision — trends are meaningful even if absolute numbers differ slightly from a full AST-based parser.

### Tests

Tokenizer behaviour is covered by `entropy-report.test.mjs`:

```bash
node --test tools/entropy-report/entropy-report.test.mjs
```

## Fixed: aggregate Halstead collapse at `921d39f`

The report previously showed a dramatic drop in aggregate Volume (609,880 → 194,234) and Difficulty (355 → 218) at commit `921d39f`, caused by `stripComments()` misinterpreting regex literals when all files were concatenated into a single string.

**Fix**: `analyzeCommit()` now tokenizes each file independently and merges the operator/operand `Map`s across files before computing aggregate Halstead metrics. This avoids cross-file `stripComments` interference entirely — the regex never sees content from multiple files at once.

## Fixed (#50): Halstead lexing & aggregation correctness

A follow-up review found the formulas were right but the lexical input and some aggregation choices were systematically biased. Ticket #50 replaced the regex tokenizer with the character-scanning lexer described under [Tokenizer](#tokenizer) and corrected the report wiring:

- **Per-app Volume** is now computed from per-app union maps (same method as the project total), not summed from per-file Volumes — so the "Volume by Application" chart no longer understates. Per-app lines are overlaid, not stacked, because they don't sum to the project total.
- **A single `first` anchor** (the first source-bearing commit) is shared by both the LLM prompt and the HTML report, so their growth figures agree.
- **Avg Difficulty** excludes empty leading (scaffolding) commits.
- **Estimated Bugs** uses Halstead's canonical `B = E^(2/3) / 3000` rather than the simplified `V/3000`, which overstated as Volume grew.

Reports generated before this fix carry an in-report banner and are not numerically comparable to later ones; the first corrected report is `reports/entropy-20260530-013740.html`.

## Scope

Analyzes `.ts` files in `apps/` and `libs/` (excluding `.d.ts`). Per-app breakdown covers:

- `apps/terminal/` — Terminal App (legacy; removed in QRM6-009, still classified for historical commits)
- `apps/mcp-server/` — MCP Server
- `apps/agent/` — Agent App
- `libs/common/` — Common Library

## Appendix: Halstead vs Cyclomatic Complexity

The two scripts here compute **Halstead metrics** (`entropy-report.mjs`) and **cyclomatic complexity** (`cyclomatic-report.mjs`, via `lizard`). They measure different things, which is why a complete analysis runs both:

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

### The two scripts

| Feature | `entropy-report.mjs` (Halstead) | `cyclomatic-report.mjs` (cyclomatic, via `lizard`) |
|---|---|---|
| Metrics | Volume, Difficulty, Effort, Est. Bugs | Cyclomatic complexity, NLOC, token count, param count, nesting depth |
| Scope | Codebase-wide trends across git history | Per-function distribution, current HEAD |
| TypeScript support | Yes (custom tokenizer) | Yes (`lizard` native) |
| Git history | Yes (built-in) | No (single snapshot) |
| Output | HTML + Chart.js, TXT | TXT (anonymous aggregate JSON) |
| Engine | In-house tokenizer | `lizard` (active open-source, 2.3k stars) driven by in-house script |