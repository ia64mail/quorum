#!/usr/bin/env node
/**
 * Build the self-contained ticket-graph visualizer.
 *
 * Reads graph.json, strips it down to the fields the app uses, inlines it
 * together with the vendored cytoscape libraries and any saved layout
 * positions, and emits:
 *   dist/graph-viz.html          — standalone page (open locally, host on Pages, iframe into an article)
 *   dist/graph-viz.artifact.html — body-only fragment (for claude.ai Artifact publishing)
 *
 * Usage: node build.mjs [--graph <path>] [--out <dir>]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const graphPath = resolve(argOf('--graph', join(repoRoot, 'tickets/tmp/knowledge-research/data/ticket-graph/graph.json')));
const outDir = resolve(argOf('--out', join(here, 'dist')));

// ---------- data ----------
const raw = JSON.parse(readFileSync(graphPath, 'utf8'));
const ids = new Set(raw.nodes.map((n) => n.id));
const badEdges = raw.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
if (badEdges.length) console.warn(`WARN: ${badEdges.length} edges reference unknown nodes — dropped`);

const data = {
  meta: { corpusCommit: raw.meta?.corpusCommit, schemaVersion: raw.meta?.schemaVersion },
  nodes: raw.nodes.map((n) => ({
    id: n.id, era: n.era, file: n.file, title: n.title, milestone: n.milestone, epic: n.epic,
    lines: n.lines, addedDate: n.addedDate, type: n.type, typeConfidence: n.typeConfidence, summary: n.summary,
  })),
  edges: raw.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => {
    const occ = e.textual?.occurrences ?? [];
    const shared = (e.coChange?.sharedFiles ?? []).slice().sort((a, b) => b.weight - a.weight);
    return {
      from: e.from, to: e.to, channels: e.channels, temporal: e.temporal,
      llm: e.llm ? { kind: e.llm.kind, kindConfidence: e.llm.kindConfidence, rationale: e.llm.rationale } : null,
      quotes: occ.slice(0, 3).map((o) => ({ file: o.file, line: o.line, section: o.section, quote: o.quote })),
      textualCount: occ.length,
      sharedFiles: shared.slice(0, 5).map((f) => ({ path: f.path, weight: f.weight })),
      coScore: Math.round(shared.reduce((s, f) => s + (f.weight || 0), 0) * 100) / 100,
    };
  }),
};

// ---------- saved positions ----------
let positions = {};
const posDir = join(here, 'positions');
if (existsSync(posDir)) {
  for (const f of readdirSync(posDir).filter((f) => f.endsWith('.json')).sort()) {
    try { Object.assign(positions, JSON.parse(readFileSync(join(posDir, f), 'utf8'))); console.log(`positions: inlined ${f}`); }
    catch (err) { console.warn(`WARN: skipping positions/${f}: ${err.message}`); }
  }
}

// ---------- assemble ----------
const nm = join(here, 'node_modules');
const libs = [
  ['layout-base', join(nm, 'layout-base/layout-base.js')],
  ['cose-base', join(nm, 'cose-base/cose-base.js')],
  ['cytoscape', join(nm, 'cytoscape/dist/cytoscape.min.js')],
  ['cytoscape-fcose', join(nm, 'cytoscape-fcose/cytoscape-fcose.js')],
  ['cytoscape-svg', join(nm, 'cytoscape-svg/cytoscape-svg.js')],
];
const libTags = libs.map(([name, p]) => `<script>/* ${name} */\n${readFileSync(p, 'utf8')}\n</script>`).join('\n');

const inlineJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const sub = (s, token, value) => {
  if (!s.includes(token)) throw new Error(`template token missing: ${token}`);
  return s.split(token).join(value);
};

let body = readFileSync(join(here, 'src/template.html'), 'utf8');
body = sub(body, '/*__STYLE__*/', readFileSync(join(here, 'src/style.css'), 'utf8'));
body = sub(body, '<!--__LIBS__-->', libTags);
body = sub(body, '/*__DATA__*/ null', inlineJson(data));
body = sub(body, '/*__POSITIONS__*/ {}', inlineJson(positions));
body = sub(body, '/*__APP__*/', readFileSync(join(here, 'src/app.js'), 'utf8'));

const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quorum ticket graph</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
</head>
<body>
${body.replace(/^<title>.*<\/title>\n/, '')}
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
const outMain = join(outDir, 'graph-viz.html');
const outArtifact = join(outDir, 'graph-viz.artifact.html');
writeFileSync(outMain, standalone);
writeFileSync(outArtifact, body);

const mb = (s) => (Buffer.byteLength(s) / 1024 / 1024).toFixed(2) + ' MB';
console.log(`graph: ${data.nodes.length} nodes, ${data.edges.length} edges (corpus ${data.meta.corpusCommit})`);
console.log(`built: ${outMain} (${mb(standalone)})`);
console.log(`built: ${outArtifact} (${mb(body)})`);
