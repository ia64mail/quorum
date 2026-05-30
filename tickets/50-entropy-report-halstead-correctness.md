# #50: Entropy report — Halstead score & chart calculation correctness

## Summary

A code review of `tools/entropy-report/entropy-report.mjs` confirmed the Halstead formulas themselves are correct, but the **lexical input** feeding those formulas and the **aggregation choices** behind the per-app charts produce systematically biased numbers. This ticket fixes the tokenizer gaps, the inconsistent project-vs-per-app aggregation, and a small set of headline figures that disagree between the HTML report and the LLM prompt. Operational issues surfaced in the same review (shell injection, XSS, error swallowing) are out of scope here and tracked separately.

## Problem Statement

The script's Halstead math (lines 141–155 — `V = N·log₂(η)`, `D = (η₁/2)·(N₂/η₂)`, `E = D·V`) matches Halstead 1977. The numbers it produces are unreliable for two independent reasons:

1. **Tokenizer bias** — several real TypeScript token classes are mis-classified, causing systematic under-/over-counting of operators and operands.
2. **Aggregation inconsistency** — project-level Volume is computed from union maps, but per-app Volume is summed from per-file Volumes. The two methods produce different totals at the same commit, so the "Volume by Application" stacked area chart top ≠ the "Halstead Volume" line at the same x-position.

Compounding both: the LLM prompt and the HTML report anchor "growth" calculations at different commits, so the LLM sees figures the human reader never sees.

These distortions matter because the report's job is to make complexity trends legible. Trend *direction* survives the noise, but absolute numbers and any cross-file comparison (per-app distribution, Difficulty headline, estimated bugs) are biased low or high in ways that compound as the codebase grows.

## Findings to Fix

### F1 — Template literal `${…}` interpolations are swallowed as a single operand

`tools/entropy-report/entropy-report.mjs:79` (and the matching pattern in `stripComments` at `:96`)

The string-literal arm of `TOKEN_RE` matches an entire backtick string greedily, so every operator and identifier inside `${…}` is invisible to Halstead. `buildLlmPrompt` itself is one 28-line backtick string with ~30 `${…}` interpolations doing arithmetic, `.toFixed()`, `Math.max(...)`, ternaries — all collapse into one operand. NestJS codebases use template literals heavily for prompts, log messages, and error strings, so this is the largest single source of bias.

**Fix direction:** match backtick boundaries explicitly, then re-enter the tokenizer for the contents of each `${…}` segment. The literal text between `${…}` segments remains one operand per segment (preserves Halstead's "string literal = one operand" intent). Same fix has to apply to `stripComments` so that interpolation contents aren't stripped as if they were comments.

### F2 — Regex literals are chopped into operator soup

`tools/entropy-report/entropy-report.mjs:76` — no regex-literal arm in `TOKEN_RE`

`/[-:]/g` becomes operators `/`, `[`, `-`, `:`, `]`, `/` + identifier `g`. In regex-dense files (validators, parsers, sanitizers) this materially inflates N₁ and η₁ and biases Difficulty `(η₁/2)·(N₂/η₂)` upward.

**Fix direction:** add a regex-literal arm to `TOKEN_RE` and to `stripComments`. The tricky part is distinguishing `/` as division from `/` as regex-open — a small precedes-token heuristic (regex-open after `(`, `,`, `=`, `:`, `return`, etc.) is sufficient for the level of accuracy this tool reports.

### F3 — `stripComments` deletes the body of regex literals containing `//` or `/* … */`

`tools/entropy-report/entropy-report.mjs:96`

Source like `const re = /\/\*foo\*\//;` has the inner `/* … */` consumed by the block-comment alternation, deleting code before tokenization. Lower frequency than F1/F2 but produces silent under-counts when it triggers.

**Fix direction:** falls out of F2 — once regex literals are recognized as a top-level alternative in `stripComments`, their bodies are preserved.

### F4 — String operands are keyed by raw lexeme including quote style

`tools/entropy-report/entropy-report.mjs:118-119`

`'foo'` and `"foo"` (and `` `foo` ``) register as three distinct unique operands. Per Halstead, one unique *literal value* = one operand regardless of delimiter. Inflates η₂ in any file that mixes quote styles.

**Fix direction:** normalize the operand key — strip outer delimiters and unescape before using as the Map key. Keep the lexeme for display if needed.

### F5 — Numeric edge cases mis-tokenize

`tools/entropy-report/entropy-report.mjs:81` — `\b(?:0x[\da-fA-F]+|0o[0-7]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?n?)\b`

- `0xffn` (BigInt hex) → operand `0xff` + operand `n` (the `n?` suffix is only in the decimal arm)
- `1_000_000` (numeric separator) → operand `1` + operand `_000_000`
- `.5` (leading-dot decimal) → operator `.` + operand `5`

Each splits one numeric operand into two tokens, sometimes shifting between operator and operand categories. Low frequency in this codebase but easy to fix.

**Fix direction:** extend the numeric regex to accept `_` separators between digit groups, attach `n?` to all integer bases, and allow `(?:\d+(?:\.\d*)?|\.\d+)`.

### F6 — Per-app Volume ≠ slice of project Volume (stacked chart lies)

`tools/entropy-report/entropy-report.mjs:257` (`perApp[app].volume += halstead.volume`) vs `:262`

Per-file Volume is `N_i·log₂(η_i)` with small per-file η. Project Volume is `N·log₂(η)` with η = union of all files (much larger; `log₂(η)` jumps). `Σ V_i` is therefore strictly less than project V — typically by 15–30% at this codebase's scale. The "Volume by Application" stacked area chart's top therefore does not equal the headline "Halstead Volume" line at the same commit.

**Fix direction:** compute per-app Halstead from per-app union maps (same method as project-level). Aggregate per-file maps into an `app -> {operators, operands}` structure, then run `halsteadFromMaps` per app. Per-app volumes still won't sum exactly to project volume (the vocabularies are subsets), but each per-app number will be a proper Halstead figure and the stacked chart will be honest about not summing to project total — or convert that chart to a non-stacked overlay.

### F7 — LLM prompt anchors growth at `data[0]`; HTML report anchors at first source-bearing commit

`tools/entropy-report/entropy-report.mjs:295` vs `:389`

If the first commit has zero `.ts` files in `apps/`/`libs/` (typical — initial commits are scaffolding), the LLM prompt computes `((N / Math.max(0, 1) - 1) * 100)` = e.g. **2,999,900% growth** on a 30k-LOC project. The HTML report correctly reports growth from the first source-bearing commit. Two outputs of the same run disagree by orders of magnitude.

**Fix direction:** define `first` once at the top of the pipeline as `data.find(d => d.metrics.files > 0) || data[0]` and pass it into both `buildLlmPrompt` and `generateHtml`. Also use the same `first` for the headline Volume figure: `Volume: 0 → X` in the prompt should be `Volume: X_firstSource → X_last`.

### F8 — Headline `Avg Difficulty` averages across empty leading commits

`tools/entropy-report/entropy-report.mjs:422`

The mean is taken over the full `data` array. Any commits before `apps/`/`libs/` exist contribute `D=0`, dragging the headline figure below the project's typical difficulty.

**Fix direction:** average over `data.filter(d => d.metrics.files > 0)` — consistent with how `first` is selected for the growth figure.

### F9 — `estimatedBugs = volume / 3000` is presented as canonical without caveat

`tools/entropy-report/entropy-report.mjs:152`, HTML footer at `:779`, stat card at `:691`

Halstead's original predictor is `B = E^(2/3) / 3000`; `V / 3000` is a simplified variant that overstates as `V` grows linearly with codebase size. For Quorum's `V ≈ 1M` the headline reads ≈ 333 bugs, which is not a defensible number to publish alongside `D = (η₁/2)(N₂/η₂)` without qualification.

**Fix direction:** switch to `B = Math.pow(effort, 2 / 3) / 3000` and update the footer / stat-card detail line accordingly. (Acceptable alternative: keep `V/3000`, add a footnote and rename the label to "Volume Bug Index" so it's not read as a canonical predictor.)

## Out of Scope

The same review surfaced operational and security findings that are **not** part of this ticket. They should be filed separately:

- Shell injection in `getFileContent` via crafted filenames (`git show ${hash}:"${path}"`)
- HTML/XSS injection of commit messages into report `<td>` cells
- `</script>` escape via `JSON.stringify` of messages
- Empty-repo crash in `buildLlmPrompt` (`data[0]` deref)
- Error swallowing in `getFilesAtCommit` masking real git failures as zero-file commits
- Raw-HTML insertion of LLM summary completing a prompt-injection chain

Mentioned here so the next agent looking at this file knows they're known and tracked elsewhere — do not fix them as drive-by changes in this ticket.

## Acceptance Criteria

- [ ] F1 — Tokenizer recurses into template-literal `${…}` interpolations; verified against a fixture containing arithmetic and identifiers inside an interpolation
- [ ] F2 — Regex literals are recognized as a single operand; verified that `/[-:]/g` produces one operand, not seven tokens
- [ ] F3 — `stripComments` preserves regex bodies containing `//` and `/* … */`; verified via fixture
- [ ] F4 — String operands are quote-normalized; `'foo'`, `"foo"`, `` `foo` `` map to the same η₂ entry
- [ ] F5 — Numeric regex accepts `1_000_000`, `0xffn`, `.5` as single operands
- [ ] F6 — Per-app Volume computed from per-app union maps; chart caption updated if components no longer claim to sum to project total
- [ ] F7 — Single `first` selection used by both prompt and HTML; verified that LLM prompt's growth-% line and the HTML stat-card growth-% line agree
- [ ] F8 — `Avg Difficulty` excludes commits with `files === 0`
- [ ] F9 — Estimated Bugs uses `E^(2/3) / 3000` (or `V/3000` retained with explicit caveat in footer + stat-card detail)
- [ ] Re-run report on current `main`; spot-check at least three commits' Volume and Difficulty by hand or against a reference tool (e.g., `escomplex`, `complexity-report`) to confirm direction and rough magnitude
- [ ] QRM3-001 `Implementation Notes` updated with a back-pointer to this ticket

## Dependencies and References

- Builds on QRM3-001 (`tickets/QRM3-001-code-quality-metrics.md`) — original entropy-report ticket and prior aggregate-collapse fix
- Halstead reference: Halstead 1977, *Elements of Software Science*. Formula summary lives in the HTML footer at `tools/entropy-report/entropy-report.mjs:779`
- Cross-check tool candidate: `lizard` (already noted as complementary in the memory record), or a JS-native Halstead implementation like `escomplex` for sanity-checking a handful of files
- Source file under change: `tools/entropy-report/entropy-report.mjs`
- Latest baseline report (for before/after comparison): `tools/entropy-report/reports/` — the most recent QRM8 milestone HTML