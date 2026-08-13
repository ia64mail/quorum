# #96: Ticket-graph rendering tool for knowledge-base research (tools/graph-viz)

## Summary

Build `tools/graph-viz/` — an interactive visualizer for the ticket knowledge graph
reconstructed in #95 — following the research-tools convention (`tools/entropy-report`,
`tools/session-report`). One build script inlines the graph data and all libraries into a
**single self-contained HTML file** that serves three consumption modes: local research
instrument, publication-quality figure export (PNG/SVG), and a potential live embed on an
article page (GitHub Pages iframe or claude.ai Artifact).

## Problem Statement

The #95 graph (155 nodes / 960 typed edges, corpus `daa9188`) exists only as JSON. The QRM10
research questions — awareness gaps, edge-kind distributions, milestone-crossing dependency
chains, knowledge growth over time — need visual inspection with filtering and evidence
drill-down, and the article series needs reproducible figures. The intended projections were
pre-registered in the research doc (`tickets/tmp/knowledge-research/02-ticket-graph.md` §5):
(a) a time-ordered DAG (x = `addedDate`, swimlane = milestone), plus an interactive force
view; rendering tooling was explicitly out of scope for the collection phase and lands here.

## Design Context

- **Library: Cytoscape.js** (+ `cytoscape-fcose` layout, `cytoscape-svg` export). At 155/960
  a canvas renderer is comfortable; sigma.js (WebGL, 10k+ nodes) is overkill with a more rigid
  styling model; d3-force would mean hand-building selection/export/hit-testing.
- **Single-file output.** `build.mjs` inlines vendored UMDs (one `<script>` per library — a
  shared block would let one library's top-level `"use strict"` break the others' `this`-based
  global attachment), stripped graph data (`</`-escaped JSON), and optional saved positions.
  No server, no CDN — the same file works locally, on Pages, and as an Artifact fragment.
- **Input stays out of git.** The tool reads `graph.json` from the gitignored research folder
  (`tickets/tmp/knowledge-research/data/ticket-graph/`, override via `--graph`); `dist/` and
  `node_modules/` are gitignored. Only sources land in the repo — consistent with #95 keeping
  data artifacts out of git until the schema settles.
- **Encoding.** Node color + shape double-encode ticket type; edge color = LLM kind. The two
  5-hue categorical palettes (light/dark) were found by combinatorial search over
  OKLCH-generated candidates scored with a color-vision-deficiency validator — both pass
  all-pairs separation checks outright. No 6th hue can pass, so `discovered-during` shares the
  red family with `fixes-defect-in`, split by dotted line style; `mentions`/untyped recede to
  grays. Timeline renders as a diagonal staircase (milestones are sequential in time) — a
  truthful artifact of the data, not a layout defect.

## Implementation Details

1. **Scaffold** `tools/graph-viz/`: `package.json` (private; deps `cytoscape`,
   `cytoscape-fcose`, `cytoscape-svg`), `.gitignore` (`node_modules/`, `dist/`), `README.md`.
2. **`build.mjs`** — reads graph.json; strips it to the consumed fields (node identity /
   type / dates / summary; edge kind / channels / temporal / rationale, first 3 textual
   quotes, top-5 co-changed files by weight); drops edges with unknown endpoints (warn);
   merges `positions/*.json`; emits `dist/graph-viz.html` (standalone document) and
   `dist/graph-viz.artifact.html` (body-only fragment).
3. **App** (`src/app.js`, `src/style.css`, `src/template.html`):
   - Layouts: fcose force; Timeline × milestone (x = `addedDate` at 7 px/day, 9 milestone
     lanes with in-lane collision stagger and lane labels).
   - Filters: node types, edge kinds, evidence channel (textual / co-change), temporal
     direction, milestones, hide-unconnected; time slider over unique `addedDate` values.
   - Interaction: click → neighborhood / upstream (outgoing refs) / downstream (incoming)
     highlight with depth 1/2/3/∞; shift-click second node → shortest path; search over
     id/title; hover tooltips; details panel with ticket summary, incident edges grouped by
     kind (click-through), edge rationale, textual quotes with `file:line`, co-changed files.
   - Export: PNG at 3× scale, vector SVG, background matching active theme.
   - Reproducible figures: "Save positions" downloads a JSON; dropped into `positions/` it is
     inlined at next build as the default preset layout.
   - Deep links: `#layout=…&theme=…&focus=…&mode=…&depth=…` (also enables headless figure
     generation via `google-chrome --headless=new --screenshot`).
   - Themes: light/dark tokens; follows OS `prefers-color-scheme` and an embedding page's
     `data-theme` stamp, manual override wins.
   - Boot console self-check line (`graph-viz ready … svg export ok; fcose ok`) for headless
     smoke-testing.
4. **Register** the tool in CLAUDE.md (project-structure tree + Research Tools table).

## Acceptance Criteria

- [ ] `npm install && node build.mjs` in `tools/graph-viz/` produces a self-contained
      `dist/graph-viz.html` (< 2 MB) with no external network dependency
- [ ] Force and timeline layouts render all 155 nodes / 960 edges; timeline shows labeled
      milestone lanes
- [ ] All filter groups, the time slider, and highlight modes (neighborhood / upstream /
      downstream / path) work; details panel shows edge evidence (quotes with `file:line`,
      co-changed files with weights)
- [ ] PNG ×3 and SVG export produce usable figures in both themes; saved-positions round-trip
      (save → `positions/` → rebuild) yields identical layouts
- [ ] Node/edge categorical palettes pass the CVD validator in both themes (documented in
      README); node type additionally encoded by shape
- [ ] Headless smoke test passes: boot log reports node/edge counts, `svg export ok`,
      `fcose ok`, no uncaught errors
- [ ] Tool registered in CLAUDE.md research-tools table; README documents build, features,
      headless figure recipe, and the data contract

## Dependencies and References

- #95 — produces `graph.json` (schema + metrics); this tool consumes it read-only
- [tickets/94-knowledge-base-management/94-knowledge-base-management.md](94-knowledge-base-management/94-knowledge-base-management.md) — QRM10 roadmap epic
- `tickets/tmp/knowledge-research/02-ticket-graph.md` §5 (gitignored research doc) —
  pre-registered projections and metric consumers
- [tools/entropy-report/README.md](../tools/entropy-report/README.md) ·
  [tools/session-report/SESSION-REPORT.md](../tools/session-report/SESSION-REPORT.md) —
  research-tools convention this follows
