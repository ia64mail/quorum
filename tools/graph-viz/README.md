# Ticket-Graph Visualizer

Interactive rendering of the ticket knowledge graph
(`tickets/tmp/knowledge-research/data/ticket-graph/graph.json`) — a research
instrument for connection analysis and an illustration engine for article
figures. Built on [Cytoscape.js](https://js.cytoscape.org/) with the fcose
layout and SVG export extensions, bundled into a single self-contained HTML
file (no server, no CDN).

## Build

```bash
cd tools/graph-viz
npm install          # once — vendors cytoscape, cytoscape-fcose, cytoscape-svg
node build.mjs       # or: npm run build
```

Outputs (gitignored):

| File | Purpose |
|------|---------|
| `dist/graph-viz.html` | Standalone page — open locally, host on GitHub Pages, or `<iframe>` into an article |
| `dist/graph-viz.artifact.html` | Body-only fragment for claude.ai Artifact publishing |

Options: `--graph <path>` (alternate graph.json), `--out <dir>`.

## Features

- **Layouts** — `Force (fcose)` for exploration; `Timeline × milestone`
  (x = `addedDate`, swimlane = milestone) for article figures.
- **Encoding** — node color + shape = ticket type (double-encoded, CVD-safe:
  both palettes validated all-pairs with the dataviz six-checks validator);
  node size = degree; edge color = LLM `kind` (`discovered-during` shares the
  red family with `fixes-defect-in`, split by dotted line style); dashed gray =
  untyped; edge opacity drops for `mentions` and low-confidence kinds.
- **Filters** — checkboxes for node types, edge kinds, evidence channel
  (textual / co-change), temporal direction, milestones; time slider replays
  graph growth by `addedDate`; "hide unconnected nodes".
- **Highlighting** — click a node for k-hop neighborhood, upstream (what it
  references) or downstream (what references it); shift-click a second node
  for the shortest path between them; Esc clears.
- **Inspection** — hover tooltips; details panel with ticket summary, incident
  edges grouped by kind (click-through), edge rationale, textual-evidence
  quotes with `file:line`, and top co-changed files with weights.
- **Export** — PNG at 3× scale and vector SVG of the full graph (current
  filters/highlights apply), background matches the active theme.
- **Reproducible figures** — "Save positions" downloads a positions JSON; drop
  it into `positions/` and rebuild to inline it as the default layout, so
  regenerated figures don't shift.
- **Deep links** — `#layout=timeline&theme=dark&focus=QRM6-009&mode=up&depth=2`
  restores a view (useful for sharing and for headless screenshots).
- **Themes** — light/dark, follows the OS or an embedding page's `data-theme`
  stamp, with a manual override.

## Headless figure generation

```bash
google-chrome --headless=new --disable-gpu --window-size=1600,950 \
  --virtual-time-budget=15000 --hide-scrollbars \
  --screenshot=fig.png \
  "file://$PWD/dist/graph-viz.html#layout=timeline&theme=light"
```

For print-quality figures prefer the in-app SVG export.

## Data contract

`build.mjs` strips graph.json to the fields the app uses (node identity/type/
dates/summary; edge kind/channels/temporal/rationale, first 3 textual quotes,
top 5 co-changed files). Nothing else is required — schema changes beyond
these fields won't break the build. Edges referencing unknown node ids are
dropped with a warning.
