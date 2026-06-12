#!/usr/bin/env node
/**
 * Cyclomatic Complexity Snapshot — current HEAD.
 *
 * Companion to entropy-report.mjs. Halstead Volume measures information DENSITY
 * ("how much is packed into the code"); cyclomatic complexity (CCN) measures
 * DECISION-PATH complexity ("how branchy / how many tests it needs"). Together
 * they separate "concise & dense" from "overloaded & dense" — which Halstead
 * alone cannot do. This tool is a single snapshot of the working tree (HEAD),
 * not a git-history trend.
 *
 * Scope (SOURCE_DIRS, EXCLUDE_PATHS) is imported from entropy-report.mjs so the
 * two reports describe EXACTLY the same source files. Output is ANONYMOUS
 * aggregate statistics only — no file names, no function names — matching the
 * entropy report's anonymity contract.
 *
 * Requires: lizard (`pipx install lizard` or `pip install --user lizard`) on PATH,
 *           Node.js 20+, git.
 * Usage:    node tools/entropy-report/cyclomatic-report.mjs
 * Output:   tools/entropy-report/reports/cyclomatic-{timestamp}.txt  (JSON aggregates)
 */

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_DIRS, EXCLUDE_PATHS, SAMPLE_LABEL } from './entropy-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const REPORTS_DIR = resolve(__dirname, 'reports');
mkdirSync(REPORTS_DIR, { recursive: true });

const now = new Date();
const TIMESTAMP = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const OUT_FILE = resolve(REPORTS_DIR, `cyclomatic-${TIMESTAMP}.txt`);

function git(args) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
}

/**
 * In-scope files at HEAD — identical rule to entropy-report.getFilesAtCommit:
 * .ts under SOURCE_DIRS, excluding .d.ts and EXCLUDE_PATHS prefixes. Using the
 * shared constants guarantees both reports cover the same source.
 */
function inScopeFiles() {
  const dirArgs = SOURCE_DIRS.map(d => `"${d}"`).join(' ');
  const out = git(`ls-tree -r --name-only HEAD -- ${dirArgs}`);
  return out.trim().split('\n')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter(f => !EXCLUDE_PATHS.some(prefix => f.startsWith(prefix)));
}

/**
 * Run lizard over the file list and return one record per function. lizard
 * --csv emits, per function: nloc,ccn,token,param,length,location,... The first
 * five fields are numeric and precede the (name-bearing) quoted fields, so we
 * parse only those with a regex — function/file names are never read.
 */
function runLizard(files) {
  const rows = [];
  const CHUNK = 150; // keep argv well under OS limits
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    let csv = '';
    try {
      csv = execFileSync('lizard', ['-l', 'typescript', '--csv', ...chunk],
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
    } catch (e) {
      // lizard exits non-zero when threshold warnings exist; stdout is still valid.
      csv = e.stdout ? e.stdout.toString() : '';
      if (!csv) throw e;
    }
    for (const line of csv.split('\n')) {
      const m = line.match(/^(\d+),(\d+),(\d+),(\d+),(\d+),/);
      if (m) rows.push({ nloc: +m[1], ccn: +m[2], token: +m[3], param: +m[4], length: +m[5] });
    }
  }
  return rows;
}

const sortNum = arr => [...arr].sort((a, b) => a - b);
const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const pctile = (arr, p) => {
  if (!arr.length) return 0;
  const s = sortNum(arr);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};

function summarize(rows, fileCount) {
  const ccn = rows.map(r => r.ccn);
  const nloc = rows.map(r => r.nloc);
  const params = rows.map(r => r.param);
  const n = rows.length || 1;
  const over = t => ccn.filter(c => c > t).length;
  return {
    sampleLabel: SAMPLE_LABEL,
    filesAnalyzed: fileCount,
    functions: rows.length,
    totalFunctionNloc: nloc.reduce((a, b) => a + b, 0),
    avgCcn: +avg(ccn).toFixed(2),
    medianCcn: pctile(ccn, 0.5),
    p90Ccn: pctile(ccn, 0.90),
    p99Ccn: pctile(ccn, 0.99),
    maxCcn: Math.max(0, ...ccn),
    pctFnCcnOver10: +(100 * over(10) / n).toFixed(1),
    pctFnCcnOver15: +(100 * over(15) / n).toFixed(1),
    pctFnCcnOver25: +(100 * over(25) / n).toFixed(1),
    countFnCcnOver15: over(15),
    avgFunctionNloc: +avg(nloc).toFixed(1),
    maxFunctionNloc: Math.max(0, ...nloc),
    avgParams: +avg(params).toFixed(2),
    maxParams: Math.max(0, ...params),
  };
}

function main() {
  console.log('Cyclomatic Complexity Snapshot (current HEAD)');
  console.log('=============================================\n');
  console.log(`Sample: ${SAMPLE_LABEL}`);

  const files = inScopeFiles();
  console.log(`In-scope files: ${files.length}`);
  if (!files.length) { console.error('No in-scope .ts files found.'); process.exit(1); }

  const rows = runLizard(files);
  if (!rows.length) {
    console.error('\nNo functions parsed. Is lizard installed and on PATH? (pipx install lizard)');
    process.exit(1);
  }

  const summary = summarize(rows, files.length);
  console.log(`\n${JSON.stringify(summary, null, 2)}`);

  writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
  console.log(`\nSaved: ${OUT_FILE}`);
}

main();
