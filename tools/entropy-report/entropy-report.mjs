#!/usr/bin/env node
/**
 * Source Code Entropy Report Generator
 *
 * Computes Halstead complexity metrics across git history and generates
 * an interactive HTML report with Chart.js visualizations.
 *
 * Usage:
 *   node tools/entropy-report/entropy-report.mjs
 *
 * Outputs:
 *   tools/entropy-report/reports/entropy-{timestamp}.html  — interactive report
 *   tools/entropy-report/reports/entropy-{timestamp}.txt   — LLM prompt + raw data
 *
 * Post-processing:
 *   Feed the .txt file to an LLM, then inject the HTML summary into the report.
 *   See README.md for details.
 *
 * Requires: git, Node.js 20+
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const REPORTS_DIR = resolve(__dirname, 'reports');
const SOURCE_DIRS = ['apps/', 'libs/'];

// Timestamp for output filenames
const now = new Date();
const TIMESTAMP = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

mkdirSync(REPORTS_DIR, { recursive: true });

const HTML_FILE = resolve(REPORTS_DIR, `entropy-${TIMESTAMP}.html`);
const TXT_FILE = resolve(REPORTS_DIR, `entropy-${TIMESTAMP}.txt`);

// ============================================================================
// HALSTEAD TOKENIZER
// ============================================================================

const TS_KEYWORD_OPERATORS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'var', 'let', 'const',
  'function', 'class', 'interface', 'type', 'enum', 'namespace', 'module',
  'declare', 'async', 'await', 'yield', 'new', 'delete', 'typeof',
  'instanceof', 'void', 'in', 'of', 'extends', 'implements', 'static',
  'public', 'private', 'protected', 'abstract', 'readonly', 'override',
  'get', 'set', 'super', 'import', 'export', 'from', 'default', 'as',
  'keyof', 'is', 'infer', 'satisfies',
]);

const TS_LITERAL_OPERANDS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
]);

// Symbol operators sorted by length (longest first for correct matching)
const SYMBOL_OPERATORS = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '...',
  '>>>', '?.', '>>', '<<', '**', '==', '!=', '<=', '>=', '&&', '||', '??',
  '=>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '=', '!', '<', '>', '&', '|', '^', '~',
  '?', ':', ';', ',', '.', '(', ')', '{', '}', '[', ']', '@',
];

const SYMBOL_RE_PART = SYMBOL_OPERATORS
  .map(op => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// Combined tokenizer regex — processes strings, numbers, symbols, and words
// in a single pass. Order matters: strings first (to avoid matching operators
// inside strings), then numbers, then multi-char symbols, then words.
const TOKEN_RE = new RegExp(
  [
    // Group 1: String/template literals
    '(`(?:[^`\\\\]|\\\\.)*`|\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*")',
    // Group 2: Numeric literals (hex, octal, binary, decimal, bigint)
    '(\\b(?:0x[\\da-fA-F]+|0o[0-7]+|0b[01]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?n?)\\b)',
    // Group 3: Symbol operators
    `(${SYMBOL_RE_PART})`,
    // Group 4: Words (identifiers / keywords)
    '(\\b[a-zA-Z_$][\\w$]*\\b)',
  ].join('|'),
  'g',
);

/**
 * Strip comments while preserving strings.
 * Uses a single-pass regex that matches strings (preserved) and comments (removed).
 */
function stripComments(source) {
  return source.replace(
    /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, str) => str || ' ',
  );
}

/**
 * Tokenize TypeScript source and return raw operator/operand maps.
 */
function tokenize(source) {
  const cleaned = stripComments(source);

  const operators = new Map();   // operator -> count
  const operands = new Map();    // operand -> count

  const addOperator = (op) => operators.set(op, (operators.get(op) || 0) + 1);
  const addOperand = (op) => operands.set(op, (operands.get(op) || 0) + 1);

  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(cleaned)) !== null) {
    const [, stringLit, numLit, symbol, word] = match;

    if (stringLit) {
      addOperand(stringLit);
    } else if (numLit) {
      addOperand(numLit);
    } else if (symbol) {
      addOperator(symbol);
    } else if (word) {
      if (TS_KEYWORD_OPERATORS.has(word)) {
        addOperator(word);
      } else if (TS_LITERAL_OPERANDS.has(word)) {
        addOperand(word);
      } else {
        addOperand(word);
      }
    }
  }

  return { operators, operands };
}

/**
 * Compute Halstead metrics from operator/operand maps.
 */
function halsteadFromMaps(operators, operands) {
  const eta1 = operators.size;       // unique operators
  const eta2 = operands.size;        // unique operands
  const N1 = [...operators.values()].reduce((a, b) => a + b, 0);  // total operators
  const N2 = [...operands.values()].reduce((a, b) => a + b, 0);   // total operands

  const N = N1 + N2;                         // program length
  const eta = eta1 + eta2;                   // vocabulary
  const volume = eta > 0 ? N * Math.log2(eta) : 0;
  const difficulty = eta2 > 0 ? (eta1 / 2) * (N2 / eta2) : 0;
  const effort = difficulty * volume;
  const estimatedBugs = volume / 3000;

  return { N1, N2, eta1, eta2, N, eta, volume, difficulty, effort, estimatedBugs };
}

/**
 * Merge a source map into a target map (additive counts).
 */
function mergeMaps(target, source) {
  for (const [key, count] of source) {
    target.set(key, (target.get(key) || 0) + count);
  }
}

/**
 * Tokenize TypeScript source and compute Halstead metrics.
 */
function computeHalstead(source) {
  const { operators, operands } = tokenize(source);
  return halsteadFromMaps(operators, operands);
}

/**
 * Count lines of code (non-empty, non-comment lines).
 */
function countLoc(source) {
  const stripped = stripComments(source);
  return stripped.split('\n').filter(line => line.trim().length > 0).length;
}

// ============================================================================
// GIT OPERATIONS
// ============================================================================

function exec(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
}

function getCommits() {
  const log = exec('git log --reverse --format="%H|%aI|%s"');
  return log.trim().split('\n').filter(Boolean).map(line => {
    const [hash, date, ...msgParts] = line.split('|');
    return { hash, date, message: msgParts.join('|'), shortHash: hash.slice(0, 7) };
  });
}

function getFilesAtCommit(hash) {
  try {
    const dirArgs = SOURCE_DIRS.map(d => `"${d}"`).join(' ');
    const output = exec(`git ls-tree -r --name-only ${hash} -- ${dirArgs} 2>/dev/null`);
    return output.trim().split('\n')
      .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  } catch {
    return [];
  }
}

function getFileContent(hash, path) {
  try {
    return exec(`git show ${hash}:"${path}" 2>/dev/null`);
  } catch {
    return '';
  }
}

// ============================================================================
// ANALYSIS ENGINE
// ============================================================================

function classifyApp(filePath) {
  if (filePath.startsWith('apps/terminal/')) return 'terminal';
  if (filePath.startsWith('apps/mcp-server/')) return 'mcp-server';
  if (filePath.startsWith('apps/agent/')) return 'agent';
  if (filePath.startsWith('libs/common/')) return 'common';
  return 'other';
}

function analyzeCommit(hash) {
  const files = getFilesAtCommit(hash);

  let totalLoc = 0;
  const perApp = {};

  // Aggregate operator/operand maps across all files (avoids cross-file stripComments bugs)
  const aggOperators = new Map();
  const aggOperands = new Map();

  for (const file of files) {
    const content = getFileContent(hash, file);
    if (!content) continue;

    const loc = countLoc(content);
    const { operators, operands } = tokenize(content);
    const halstead = halsteadFromMaps(operators, operands);
    const app = classifyApp(file);

    totalLoc += loc;

    // Merge per-file maps into aggregate
    mergeMaps(aggOperators, operators);
    mergeMaps(aggOperands, operands);

    if (!perApp[app]) perApp[app] = { files: 0, loc: 0, volume: 0 };
    perApp[app].files++;
    perApp[app].loc += loc;
    perApp[app].volume += halstead.volume;
  }

  // Compute aggregate Halstead from merged maps
  const halstead = aggOperators.size > 0
    ? halsteadFromMaps(aggOperators, aggOperands)
    : { N1: 0, N2: 0, eta1: 0, eta2: 0, N: 0, eta: 0,
        volume: 0, difficulty: 0, effort: 0, estimatedBugs: 0 };

  return {
    files: files.length,
    loc: totalLoc,
    halstead,
    perApp,
  };
}

async function analyzeAll(commits) {
  const results = [];
  const total = commits.length;

  for (let i = 0; i < total; i++) {
    const commit = commits[i];
    const pct = ((i + 1) / total * 100).toFixed(0);
    process.stdout.write(`\r  Analyzing commit ${i + 1}/${total} (${pct}%) ${commit.shortHash}`);

    const metrics = analyzeCommit(commit.hash);
    results.push({ ...commit, metrics });
  }
  process.stdout.write('\n');
  return results;
}

// ============================================================================
// LLM PROMPT BUILDER
// ============================================================================

function buildLlmPrompt(data) {
  const first = data[0];
  const last = data[data.length - 1];

  const deltas = data.map((d, i) => ({
    index: i,
    shortHash: d.shortHash,
    message: d.message,
    volumeDelta: i > 0 ? d.metrics.halstead.volume - data[i - 1].metrics.halstead.volume : 0,
    locDelta: i > 0 ? d.metrics.loc - data[i - 1].metrics.loc : 0,
  })).filter(d => d.index > 0).sort((a, b) => Math.abs(b.volumeDelta) - Math.abs(a.volumeDelta));

  const topChanges = deltas.slice(0, 10).map(d =>
    `  ${d.shortHash} "${d.message}" (Volume Δ${d.volumeDelta > 0 ? '+' : ''}${d.volumeDelta.toFixed(0)}, LOC Δ${d.locDelta > 0 ? '+' : ''}${d.locDelta})`
  ).join('\n');

  const finalApps = Object.entries(last.metrics.perApp)
    .map(([app, m]) => `  ${app}: ${m.files} files, ${m.loc} LOC, Volume ${m.volume.toFixed(0)}`)
    .join('\n');

  const diffSamples = data.filter((_, i) => i % 10 === 0 || i === data.length - 1)
    .map(d => `  #${data.indexOf(d) + 1} (${d.shortHash}): D=${d.metrics.halstead.difficulty.toFixed(1)}, V=${d.metrics.halstead.volume.toFixed(0)}`)
    .join('\n');

  return `You are analyzing source code complexity metrics for "Quorum" — a multi-agent AI orchestration system (NestJS/TypeScript monorepo). The entire codebase was written by Claude Code (AI) in a "vibe coding" mode, with a human developer providing ticket-level control and careful code review.

The project has ${data.length} commits spanning ${first.date.split('T')[0]} to ${last.date.split('T')[0]}, across eight milestones (QRM1: NestJS/MCP infrastructure; QRM2: Claude Code SDK integration; QRM4: agent hardening; QRM5: semantic-search context store; QRM6: moderator/MCP transport stabilization; QRM7: long-poll transport + moderator daily-use stabilization; QRM8: workspace isolation — git worktree-per-invocation, handler-controlled commits, named-volume git clones).

METRICS SUMMARY:
- LOC: ${first.metrics.loc} → ${last.metrics.loc} (${((last.metrics.loc / Math.max(first.metrics.loc, 1) - 1) * 100).toFixed(0)}% growth)
- Files: ${first.metrics.files} → ${last.metrics.files}
- Halstead Volume: ${first.metrics.halstead.volume.toFixed(0)} → ${last.metrics.halstead.volume.toFixed(0)}
- Halstead Difficulty: ${first.metrics.halstead.difficulty.toFixed(1)} → ${last.metrics.halstead.difficulty.toFixed(1)}
- Estimated Bugs (V/3000): ${first.metrics.halstead.estimatedBugs.toFixed(1)} → ${last.metrics.halstead.estimatedBugs.toFixed(1)}

TOP 10 COMMITS BY VOLUME CHANGE:
${topChanges}

PER-APP FINAL STATE:
${finalApps}

DIFFICULTY TREND (sampled):
${diffSamples}

Provide a concise analysis (4-5 paragraphs) covering:
1. Overall complexity trajectory — linear growth, exponential, or stabilizing? Any inflection points?
2. The relationship between Volume and Difficulty — is the code getting harder to maintain or just larger?
3. Quality assessment — how do the estimated bugs and difficulty compare to typical human-authored TypeScript projects?
4. Per-app distribution — is complexity balanced or concentrated?
5. What this reveals about AI-generated code entropy and any recommendations.

Use specific numbers from the data. Be analytical, not generic. Format for HTML (use <p> tags, <strong> for emphasis).`;
}

// ============================================================================
// TXT OUTPUT (prompt + raw data)
// ============================================================================

function buildTxtOutput(data, prompt) {
  const jsonData = data.map(d => ({
    commit: d.shortHash,
    date: d.date.split('T')[0],
    message: d.message,
    files: d.metrics.files,
    loc: d.metrics.loc,
    volume: Math.round(d.metrics.halstead.volume),
    difficulty: +d.metrics.halstead.difficulty.toFixed(1),
    effort: Math.round(d.metrics.halstead.effort),
    estimatedBugs: +d.metrics.halstead.estimatedBugs.toFixed(2),
    perApp: Object.fromEntries(
      Object.entries(d.metrics.perApp).map(([k, v]) => [k, {
        files: v.files, loc: v.loc, volume: Math.round(v.volume),
      }])
    ),
  }));

  return `${'='.repeat(60)}
LLM ANALYSIS PROMPT
${'='.repeat(60)}

${prompt}

${'='.repeat(60)}
RAW DATA (JSON)
${'='.repeat(60)}

${JSON.stringify(jsonData, null, 2)}
`;
}

// ============================================================================
// HTML REPORT GENERATOR
// ============================================================================

function generateHtml(data, llmSummary) {
  const first = data.find(d => d.metrics.files > 0) || data[0];
  const last = data[data.length - 1];
  const firstIdx = data.indexOf(first);

  const labels = data.map((d, i) => `#${i + 1}`);
  const shortHashes = data.map(d => d.shortHash);
  const dates = data.map(d => d.date.split('T')[0]);
  const messages = data.map(d => d.message.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 80));

  const volumes = data.map(d => d.metrics.halstead.volume.toFixed(2));
  const difficulties = data.map(d => d.metrics.halstead.difficulty.toFixed(2));
  const locs = data.map(d => d.metrics.loc);
  const fileCounts = data.map(d => d.metrics.files);
  const bugs = data.map(d => d.metrics.halstead.estimatedBugs.toFixed(3));
  const volumePerFile = data.map(d => d.metrics.files > 0
    ? (d.metrics.halstead.volume / d.metrics.files).toFixed(2) : '0');

  // Volume deltas
  const volumeDeltas = data.map((d, i) =>
    i > 0 ? (d.metrics.halstead.volume - data[i - 1].metrics.halstead.volume).toFixed(2) : '0');

  // Per-app volumes
  const apps = ['terminal', 'mcp-server', 'agent', 'common'];
  const perAppVolumes = {};
  for (const app of apps) {
    perAppVolumes[app] = data.map(d =>
      (d.metrics.perApp[app]?.volume || 0).toFixed(2));
  }

  const volumeGrowth = first.metrics.halstead.volume > 0
    ? ((last.metrics.halstead.volume / first.metrics.halstead.volume - 1) * 100).toFixed(0)
    : 'N/A';

  const avgDifficulty = (data.reduce((s, d) => s + d.metrics.halstead.difficulty, 0) / data.length).toFixed(1);

  const llmSection = llmSummary
    ? `<div class="card llm-summary">
        <h2>LLM Analysis</h2>
        <div class="llm-content">${llmSummary}</div>
       </div>`
    : `<div class="card llm-summary" id="llm-placeholder">
        <h2>LLM Analysis</h2>
        <div class="llm-content">
          <p style="color: var(--text-muted); font-style: italic;">
            Summary not yet generated. Feed the companion <code>.txt</code> file to an LLM
            and replace this placeholder with the output.
            See <code>tools/entropy-report/README.md</code> for instructions.
          </p>
        </div>
       </div>`;

  // Build the data table rows
  const tableRows = data.map((d, i) => {
    const delta = i > 0
      ? d.metrics.halstead.volume - data[i - 1].metrics.halstead.volume
      : 0;
    const deltaStr = i > 0
      ? `<span class="${delta >= 0 ? 'delta-pos' : 'delta-neg'}">${delta >= 0 ? '+' : ''}${delta.toFixed(0)}</span>`
      : '—';
    return `<tr>
      <td>${i + 1}</td>
      <td><code>${d.shortHash}</code></td>
      <td>${d.date.split('T')[0]}</td>
      <td class="msg-cell" title="${d.message.replace(/"/g, '&quot;')}">${d.message.slice(0, 60)}${d.message.length > 60 ? '…' : ''}</td>
      <td>${d.metrics.files}</td>
      <td>${d.metrics.loc.toLocaleString()}</td>
      <td>${d.metrics.halstead.volume.toFixed(0)}</td>
      <td>${d.metrics.halstead.difficulty.toFixed(1)}</td>
      <td>${deltaStr}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quorum — Source Code Entropy Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2129;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --blue: #58a6ff;
    --cyan: #79c0ff;
    --green: #3fb950;
    --yellow: #d29922;
    --orange: #db6d28;
    --red: #f85149;
    --purple: #bc8cff;
    --pink: #f778ba;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  header {
    text-align: center;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  header h1 {
    font-size: 1.8rem;
    font-weight: 600;
    margin-bottom: 0.3rem;
  }

  header .subtitle {
    color: var(--text-muted);
    font-size: 0.95rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.2rem;
    text-align: center;
  }

  .stat-card .label {
    color: var(--text-muted);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.3rem;
  }

  .stat-card .value {
    font-size: 1.6rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .stat-card .detail {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 0.2rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .card h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-muted);
  }

  .chart-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }

  @media (max-width: 900px) {
    .chart-grid { grid-template-columns: 1fr; }
  }

  .chart-container {
    position: relative;
    height: 300px;
  }

  .chart-container.large {
    height: 400px;
  }

  .llm-summary {
    border-left: 3px solid var(--purple);
  }

  .llm-content {
    color: var(--text);
    font-size: 0.92rem;
    line-height: 1.7;
  }

  .llm-content p { margin-bottom: 0.8rem; }
  .llm-content strong { color: var(--cyan); }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }

  thead th {
    background: var(--surface2);
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    padding: 0.7rem 0.6rem;
    text-align: left;
    position: sticky;
    top: 0;
    border-bottom: 1px solid var(--border);
  }

  tbody td {
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  tbody tr:hover { background: var(--surface2); }

  .msg-cell {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 350px;
    color: var(--text-muted);
  }

  code {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.85em;
    color: var(--cyan);
  }

  .delta-pos { color: var(--red); }
  .delta-neg { color: var(--green); }

  .table-scroll {
    max-height: 500px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  footer {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
</style>
</head>
<body>

<header>
  <h1>Quorum — Source Code Entropy Report</h1>
  <div class="subtitle">
    ${data.length} commits &middot;
    ${dates[firstIdx]} &rarr; ${dates[dates.length - 1]} &middot;
    Halstead complexity analysis of AI-generated TypeScript
  </div>
</header>

<div class="stats-grid">
  <div class="stat-card">
    <div class="label">Halstead Volume</div>
    <div class="value" style="color: var(--blue)">${last.metrics.halstead.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
    <div class="detail">${volumeGrowth}% growth from first source commit</div>
  </div>
  <div class="stat-card">
    <div class="label">Lines of Code</div>
    <div class="value" style="color: var(--green)">${last.metrics.loc.toLocaleString()}</div>
    <div class="detail">${last.metrics.files} TypeScript files</div>
  </div>
  <div class="stat-card">
    <div class="label">Avg Difficulty</div>
    <div class="value" style="color: var(--yellow)">${avgDifficulty}</div>
    <div class="detail">D = (&eta;&#8321;/2) &times; (N&#8322;/&eta;&#8322;)</div>
  </div>
  <div class="stat-card">
    <div class="label">Estimated Bugs</div>
    <div class="value" style="color: var(--red)">${last.metrics.halstead.estimatedBugs.toFixed(1)}</div>
    <div class="detail">B = V / 3000 (Halstead predictor)</div>
  </div>
  <div class="stat-card">
    <div class="label">Volume per File</div>
    <div class="value" style="color: var(--cyan)">${last.metrics.files > 0 ? (last.metrics.halstead.volume / last.metrics.files).toFixed(0) : 0}</div>
    <div class="detail">Normalized complexity</div>
  </div>
</div>

${llmSection}

<!-- Main Chart: Halstead Volume -->
<div class="card">
  <h2>Halstead Volume &mdash; Total Codebase Information Content</h2>
  <div class="chart-container large">
    <canvas id="volumeChart"></canvas>
  </div>
</div>

<!-- Grid: Difficulty + LOC -->
<div class="chart-grid">
  <div class="card">
    <h2>Halstead Difficulty &mdash; Maintenance Complexity</h2>
    <div class="chart-container">
      <canvas id="difficultyChart"></canvas>
    </div>
  </div>
  <div class="card">
    <h2>Lines of Code &amp; File Count</h2>
    <div class="chart-container">
      <canvas id="locChart"></canvas>
    </div>
  </div>
</div>

<!-- Grid: Volume per file + Estimated Bugs -->
<div class="chart-grid">
  <div class="card">
    <h2>Volume per File &mdash; Normalized Complexity</h2>
    <div class="chart-container">
      <canvas id="vpfChart"></canvas>
    </div>
  </div>
  <div class="card">
    <h2>Estimated Bugs (V / 3000)</h2>
    <div class="chart-container">
      <canvas id="bugsChart"></canvas>
    </div>
  </div>
</div>

<!-- Per-App Breakdown -->
<div class="card">
  <h2>Volume by Application &mdash; Complexity Distribution</h2>
  <div class="chart-container large">
    <canvas id="appChart"></canvas>
  </div>
</div>

<!-- Volume Delta -->
<div class="card">
  <h2>Volume Delta &mdash; Complexity Change per Commit</h2>
  <div class="chart-container">
    <canvas id="deltaChart"></canvas>
  </div>
</div>

<!-- Data Table -->
<div class="card">
  <h2>Commit Details</h2>
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>#</th><th>Hash</th><th>Date</th><th>Message</th>
          <th>Files</th><th>LOC</th><th>Volume</th><th>Difficulty</th><th>&Delta; Volume</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
</div>

<footer>
  Generated ${new Date().toISOString().split('T')[0]} by entropy-report.mjs &middot;
  Halstead metrics: V = N &times; log&#8322;(&eta;), D = (&eta;&#8321;/2)(&eta;&#8322;/N&#8322;), E = D &times; V, B = V/3000
</footer>

<script>
// Chart.js global defaults for dark theme
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const labels = ${JSON.stringify(labels)};
const hashes = ${JSON.stringify(shortHashes)};
const commitDates = ${JSON.stringify(dates)};
const commitMessages = ${JSON.stringify(messages)};

const commonTooltip = {
  callbacks: {
    title: function(items) {
      const i = items[0].dataIndex;
      return hashes[i] + ' — ' + commitDates[i];
    },
    afterTitle: function(items) {
      return commitMessages[items[0].dataIndex];
    }
  },
  backgroundColor: '#161b22',
  borderColor: '#30363d',
  borderWidth: 1,
  titleFont: { family: "'SF Mono', 'Consolas', monospace", size: 11 },
  bodyFont: { size: 12 },
  padding: 10,
};

const commonScales = {
  x: {
    ticks: { maxTicksLimit: 20, font: { size: 10 } },
    grid: { display: false },
  },
  y: {
    grid: { color: 'rgba(48, 54, 61, 0.5)' },
    ticks: { font: { size: 11 } },
  }
};

// 1. Halstead Volume
new Chart(document.getElementById('volumeChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Halstead Volume',
      data: ${JSON.stringify(volumes)},
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88, 166, 255, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 1.5,
      pointHoverRadius: 5,
      borderWidth: 2,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip, legend: { display: false } },
    scales: commonScales,
  }
});

// 2. Difficulty
new Chart(document.getElementById('difficultyChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Difficulty',
      data: ${JSON.stringify(difficulties)},
      borderColor: '#d29922',
      backgroundColor: 'rgba(210, 153, 34, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 1.5,
      pointHoverRadius: 5,
      borderWidth: 2,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip, legend: { display: false } },
    scales: commonScales,
  }
});

// 3. LOC + File Count
new Chart(document.getElementById('locChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Lines of Code',
        data: ${JSON.stringify(locs)},
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63, 185, 80, 0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: 1.5,
        borderWidth: 2,
        yAxisID: 'y',
      },
      {
        label: 'File Count',
        data: ${JSON.stringify(fileCounts)},
        borderColor: '#8b949e',
        borderDash: [4, 4],
        tension: 0.3,
        pointRadius: 1,
        borderWidth: 1.5,
        yAxisID: 'y1',
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip },
    scales: {
      x: commonScales.x,
      y: {
        ...commonScales.y,
        position: 'left',
        title: { display: true, text: 'LOC', color: '#3fb950', font: { size: 11 } },
      },
      y1: {
        position: 'right',
        grid: { display: false },
        title: { display: true, text: 'Files', color: '#8b949e', font: { size: 11 } },
        ticks: { font: { size: 11 } },
      }
    }
  }
});

// 4. Volume per File
new Chart(document.getElementById('vpfChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Volume / File',
      data: ${JSON.stringify(volumePerFile)},
      borderColor: '#79c0ff',
      backgroundColor: 'rgba(121, 192, 255, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 1.5,
      pointHoverRadius: 5,
      borderWidth: 2,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip, legend: { display: false } },
    scales: commonScales,
  }
});

// 5. Estimated Bugs
new Chart(document.getElementById('bugsChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Estimated Bugs',
      data: ${JSON.stringify(bugs)},
      borderColor: '#f85149',
      backgroundColor: 'rgba(248, 81, 73, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 1.5,
      pointHoverRadius: 5,
      borderWidth: 2,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip, legend: { display: false } },
    scales: commonScales,
  }
});

// 6. Per-App Volume (Stacked Area)
new Chart(document.getElementById('appChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Terminal',
        data: ${JSON.stringify(perAppVolumes['terminal'])},
        borderColor: '#58a6ff',
        backgroundColor: 'rgba(88, 166, 255, 0.3)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      },
      {
        label: 'MCP Server',
        data: ${JSON.stringify(perAppVolumes['mcp-server'])},
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63, 185, 80, 0.3)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      },
      {
        label: 'Agent',
        data: ${JSON.stringify(perAppVolumes['agent'])},
        borderColor: '#d29922',
        backgroundColor: 'rgba(210, 153, 34, 0.3)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      },
      {
        label: 'Common Lib',
        data: ${JSON.stringify(perAppVolumes['common'])},
        borderColor: '#bc8cff',
        backgroundColor: 'rgba(188, 140, 255, 0.3)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      },
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip },
    scales: {
      ...commonScales,
      y: { ...commonScales.y, stacked: true },
    }
  }
});

// 7. Volume Delta (Bar)
const deltaData = ${JSON.stringify(volumeDeltas)}.map(Number);
const deltaColors = deltaData.map(v => v >= 0 ? 'rgba(248, 81, 73, 0.7)' : 'rgba(63, 185, 80, 0.7)');
const deltaBorders = deltaData.map(v => v >= 0 ? '#f85149' : '#3fb950');

new Chart(document.getElementById('deltaChart'), {
  type: 'bar',
  data: {
    labels,
    datasets: [{
      label: 'Volume Delta',
      data: deltaData,
      backgroundColor: deltaColors,
      borderColor: deltaBorders,
      borderWidth: 1,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { tooltip: commonTooltip, legend: { display: false } },
    scales: {
      ...commonScales,
      y: { ...commonScales.y, title: { display: true, text: 'Volume Change', color: '#8b949e', font: { size: 11 } } },
    }
  }
});
</script>
</body>
</html>`;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const t0 = Date.now();
  console.log('Quorum Source Code Entropy Report');
  console.log('=================================\n');

  console.log('1. Collecting git history...');
  const commits = getCommits();
  console.log(`   Found ${commits.length} commits\n`);

  console.log('2. Analyzing Halstead metrics per commit...');
  const data = await analyzeAll(commits);
  console.log();

  const prompt = buildLlmPrompt(data);

  console.log('3. Generating HTML report...');
  const html = generateHtml(data, null);
  writeFileSync(HTML_FILE, html, 'utf-8');
  console.log(`   ${HTML_FILE}\n`);

  console.log('4. Saving prompt + data...');
  const txt = buildTxtOutput(data, prompt);
  writeFileSync(TXT_FILE, txt, 'utf-8');
  console.log(`   ${TXT_FILE}\n`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
  console.log(`\nNext: feed the .txt file to an LLM to generate the analysis summary.`);
  console.log(`See tools/entropy-report/README.md for post-processing instructions.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});