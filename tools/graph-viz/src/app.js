/* Quorum ticket-graph visualizer.
 * Self-contained: expects window.GRAPH_DATA, window.SAVED_POSITIONS and the
 * cytoscape / fcose / svg UMD globals to be present (inlined by build.mjs).
 */
(function () {
  'use strict';

  const DATA = window.GRAPH_DATA;
  const SAVED = window.SAVED_POSITIONS || {};
  if (!DATA) { document.getElementById('gvMeta').textContent = 'No graph data inlined — run build.mjs'; return; }

  try { cytoscape.use(window.cytoscapeFcose); } catch (e) { /* already registered */ }
  try { cytoscape.use(window.cytoscapeSvg); } catch (e) { /* already registered */ }

  // ---------- palette (validated with the dataviz six-checks validator) ----------
  const THEMES = {
    light: {
      surface: '#fcfcfb', page: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e',
      muted: '#898781', grid: '#e1e0d9', hairline: 'rgba(11,11,11,0.25)', accent: '#16558c',
      node: { feature: '#16558c', bug: '#84343f', roadmap: '#8557c8', runbook: '#219576', research: '#906f0f' },
      edge: {
        'depends-on': '#16558c', 'fixes-defect-in': '#84343f', supersedes: '#8557c8',
        refines: '#219576', 'follow-up-of': '#906f0f', 'discovered-during': '#84343f',
        mentions: '#898781', untyped: '#b5b4ad',
      },
    },
    dark: {
      surface: '#1a1a19', page: '#0d0d0d', ink: '#ffffff', ink2: '#c3c2b7',
      muted: '#898781', grid: '#2c2c2a', hairline: 'rgba(255,255,255,0.3)', accent: '#3987e5',
      node: { feature: '#316ca5', bug: '#bc5051', roadmap: '#9d82cc', runbook: '#3ba888', research: '#b58a3a' },
      edge: {
        'depends-on': '#316ca5', 'fixes-defect-in': '#bc5051', supersedes: '#9d82cc',
        refines: '#3ba888', 'follow-up-of': '#b58a3a', 'discovered-during': '#bc5051',
        mentions: '#898781', untyped: '#4c4c48',
      },
    },
  };
  const NODE_SHAPES = { feature: 'ellipse', bug: 'diamond', roadmap: 'hexagon', runbook: 'round-rectangle', research: 'triangle' };
  const EDGE_STYLE = { 'discovered-during': 'dotted', untyped: 'dashed' }; // default solid
  const KIND_ORDER = ['depends-on', 'fixes-defect-in', 'follow-up-of', 'refines', 'supersedes', 'discovered-during', 'mentions', 'untyped'];
  const TYPE_ORDER = ['feature', 'bug', 'roadmap', 'runbook', 'research'];

  // ---------- elements ----------
  const day = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000);
  const degree = {};
  for (const e of DATA.edges) { degree[e.from] = (degree[e.from] || 0) + 1; degree[e.to] = (degree[e.to] || 0) + 1; }

  const msNum = (m) => parseInt(String(m).replace(/\D/g, ''), 10) || 0;
  const MILESTONES = [...new Set(DATA.nodes.map((n) => n.milestone))].sort((a, b) => msNum(a) - msNum(b));
  const DATES = [...new Set(DATA.nodes.map((n) => n.addedDate))].sort();

  const elements = [];
  for (const n of DATA.nodes) {
    elements.push({
      group: 'nodes',
      data: {
        id: n.id, label: n.era === 'issue' ? '#' + n.id : n.id, type: n.type, tconf: n.typeConfidence,
        milestone: n.milestone, era: n.era, date: n.addedDate, dayN: day(n.addedDate), lines: n.lines,
        title: n.title, summary: n.summary, file: n.file, epic: n.epic,
        deg: degree[n.id] || 0, size: Math.min(46, 13 + 3.4 * Math.sqrt(degree[n.id] || 0)),
      },
    });
  }
  for (const m of MILESTONES) {
    elements.push({ group: 'nodes', data: { id: '__lane_' + m, laneLabel: true, label: m }, selectable: false, grabbable: false, classes: 'lane hidden' });
  }
  for (let i = 0; i < DATA.edges.length; i++) {
    const e = DATA.edges[i];
    const kind = (e.llm && e.llm.kind) || 'untyped';
    const conf = (e.llm && e.llm.kindConfidence) || null;
    const dual = e.channels.length > 1;
    elements.push({
      group: 'edges',
      data: {
        id: 'e' + i, source: e.from, target: e.to, kind, conf,
        channels: e.channels, temporal: e.temporal,
        w: (kind === 'mentions' || kind === 'untyped' ? 1.1 : 1.9) + (dual ? 0.7 : 0),
        op: kind === 'mentions' ? 0.45 : kind === 'untyped' ? 0.5 : conf === 'low' ? 0.55 : 0.85,
        rationale: e.llm && e.llm.rationale, quotes: e.quotes || [], textualCount: e.textualCount || 0,
        sharedFiles: e.sharedFiles || [], coScore: e.coScore || 0,
      },
    });
  }

  // ---------- theme ----------
  const root = document.getElementById('gvRoot');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function effectiveTheme() {
    const sel = document.getElementById('gvTheme').value;
    if (sel !== 'auto') return sel;
    const stamp = document.documentElement.getAttribute('data-theme');
    if (stamp === 'dark' || stamp === 'light') return stamp;
    return media.matches ? 'dark' : 'light';
  }

  function cyStyle(t) {
    const P = THEMES[t];
    return [
      { selector: 'node', style: {
        shape: (n) => NODE_SHAPES[n.data('type')] || 'ellipse',
        width: 'data(size)', height: 'data(size)',
        'background-color': (n) => P.node[n.data('type')] || P.muted,
        'border-width': 1, 'border-color': P.hairline,
        label: 'data(label)', color: P.ink2, 'font-size': 9, 'min-zoomed-font-size': 8,
        'text-valign': 'bottom', 'text-margin-y': 4,
        'text-outline-width': 2, 'text-outline-color': P.surface, 'text-outline-opacity': 0.85,
      } },
      { selector: 'edge', style: {
        'curve-style': 'bezier', 'control-point-step-size': 26,
        width: 'data(w)', opacity: 'data(op)',
        'line-color': (e) => P.edge[e.data('kind')] || P.muted,
        'line-style': (e) => EDGE_STYLE[e.data('kind')] || 'solid',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.75,
        'target-arrow-color': (e) => P.edge[e.data('kind')] || P.muted,
      } },
      { selector: 'node[?laneLabel]', style: {
        shape: 'rectangle', width: 1, height: 1, 'background-opacity': 0, 'border-width': 0,
        label: 'data(label)', 'font-size': 15, 'font-weight': 600, color: P.muted,
        'text-valign': 'center', 'text-halign': 'left', 'text-outline-width': 0, events: 'no', 'min-zoomed-font-size': 0,
      } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': P.accent, 'border-opacity': 1 } },
      { selector: 'edge:selected', style: { width: 4, opacity: 1 } },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: 'node.faded', style: { opacity: 0.08, 'text-opacity': 0 } },
      { selector: 'edge.faded', style: { opacity: 0.04 } },
      { selector: 'node.hl', style: { 'border-width': 2.5, 'border-color': P.ink, 'border-opacity': 0.9 } },
    ];
  }

  // ---------- init ----------
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements, style: cyStyle(effectiveTheme()),
    wheelSensitivity: 0.25, pixelRatio: 'auto',
  });

  // meta line
  const meta = DATA.meta || {};
  document.getElementById('gvMeta').textContent =
    DATA.nodes.length + ' tickets · ' + DATA.edges.length + ' edges · corpus ' + (meta.corpusCommit || '?');

  // ---------- layouts ----------
  let currentLayout = 'fcose';
  let layoutRun = null;

  function timelinePositions() {
    const minDay = Math.min(...DATA.nodes.map((n) => day(n.addedDate)));
    const PX_PER_DAY = 7, SUB = 27, SUBROWS = 6, LANE_H = SUB * SUBROWS + 36, MIN_DX = 48;
    const laneIdx = Object.fromEntries(MILESTONES.map((m, i) => [m, i]));
    const lanes = MILESTONES.map(() => new Array(SUBROWS).fill(-1e9));
    const laneMinX = {};
    const pos = {};
    const ordered = [...DATA.nodes].sort((a, b) => day(a.addedDate) - day(b.addedDate) || String(a.id).localeCompare(String(b.id)));
    for (const n of ordered) {
      const x = (day(n.addedDate) - minDay) * PX_PER_DAY;
      const lane = lanes[laneIdx[n.milestone]];
      let sub = lane.findIndex((last) => x - last >= MIN_DX);
      if (sub === -1) sub = lane.indexOf(Math.min(...lane));
      lane[sub] = x;
      pos[n.id] = { x, y: laneIdx[n.milestone] * LANE_H + sub * SUB };
      if (laneMinX[n.milestone] == null) laneMinX[n.milestone] = x;
    }
    for (const m of MILESTONES) {
      pos['__lane_' + m] = { x: (laneMinX[m] || 0) - 50, y: laneIdx[m] * LANE_H + (SUB * (SUBROWS - 1)) / 2 };
    }
    return pos;
  }

  function runLayout(name, opts) {
    if (layoutRun) layoutRun.stop();
    const o = opts || {};
    cy.nodes('.lane').toggleClass('hidden', name !== 'timeline');
    if (!o.force && SAVED[name]) {
      const saved = SAVED[name];
      const tl = name === 'timeline' ? timelinePositions() : null; // lane labels aren't in saved files
      layoutRun = cy.layout({ name: 'preset', positions: (n) => { const p = saved[n.id()]; return p ? { x: p[0], y: p[1] } : (tl ? tl[n.id()] : undefined); }, fit: true, padding: 30 });
    } else if (name === 'timeline') {
      const pos = timelinePositions();
      layoutRun = cy.layout({ name: 'preset', positions: (n) => pos[n.id()], fit: true, padding: 30 });
    } else {
      layoutRun = cy.elements('[!laneLabel]').layout({ name: 'fcose', quality: 'proof', randomize: o.force || !SAVED.fcose, animate: false, nodeSeparation: 90, idealEdgeLength: 70, fit: true, padding: 30 });
    }
    layoutRun.run();
    hint(SAVED[name] && !o.force ? 'Layout: saved positions (' + name + ')' : 'Layout: ' + name);
  }

  // ---------- filters ----------
  const state = {
    types: new Set(TYPE_ORDER), kinds: new Set(KIND_ORDER),
    channels: new Set(['textual', 'co-change']), temporal: new Set(['forward', 'backward', 'same-day']),
    milestones: new Set(MILESTONES), maxDateIdx: DATES.length - 1, hideIsolated: false,
  };

  function applyFilters() {
    const cutoff = DATES[state.maxDateIdx];
    cy.batch(() => {
      cy.nodes('[!laneLabel]').forEach((n) => {
        const ok = state.types.has(n.data('type')) && state.milestones.has(n.data('milestone')) && n.data('date') <= cutoff;
        n.toggleClass('hidden', !ok);
      });
      cy.edges().forEach((e) => {
        const chOk = e.data('channels').some((c) => state.channels.has(c));
        const ok = state.kinds.has(e.data('kind')) && chOk && state.temporal.has(e.data('temporal'));
        e.toggleClass('hidden', !ok);
      });
      if (state.hideIsolated) {
        cy.nodes('[!laneLabel]').not('.hidden').forEach((n) => {
          const has = n.connectedEdges().not('.hidden').some((e) => !e.source().hasClass('hidden') && !e.target().hasClass('hidden'));
          if (!has) n.addClass('hidden');
        });
      }
    });
    const vn = cy.nodes('[!laneLabel]').not('.hidden').length;
    const ve = cy.edges().not('.hidden').filter((e) => !e.source().hasClass('hidden') && !e.target().hasClass('hidden')).length;
    document.getElementById('gvStats').textContent = vn + ' / ' + DATA.nodes.length + ' tickets · ' + ve + ' / ' + DATA.edges.length + ' edges visible';
    document.getElementById('gvTimeLabel').textContent = 'up to ' + cutoff + (state.maxDateIdx === DATES.length - 1 ? ' (all)' : '');
  }

  // ---------- filter UI ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function checkboxRow(setKey, value, labelHtml, count) {
    const l = document.createElement('label');
    l.className = 'gv-check';
    l.innerHTML = '<input type="checkbox" checked />' + labelHtml + '<span class="count">' + count + '</span>';
    l.querySelector('input').addEventListener('change', (ev) => {
      state[setKey][ev.target.checked ? 'add' : 'delete'](value);
      applyFilters();
    });
    return l;
  }

  function nodeSwatch(type, theme) {
    const c = THEMES[theme].node[type];
    const clip = {
      feature: 'circle(50%)', bug: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
      roadmap: 'polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%)',
      runbook: 'inset(8% round 4px)', research: 'polygon(50% 0,100% 100%,0 100%)',
    }[type];
    return '<span class="gv-swatch-node" style="background:' + c + ';clip-path:' + clip + '"></span>';
  }

  function buildFilterPanels() {
    const t = effectiveTheme();
    const P = THEMES[t];
    const typeCounts = {}, kindCounts = {}, chCounts = {}, tmpCounts = {}, msCounts = {};
    DATA.nodes.forEach((n) => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; msCounts[n.milestone] = (msCounts[n.milestone] || 0) + 1; });
    cy.edges().forEach((e) => {
      kindCounts[e.data('kind')] = (kindCounts[e.data('kind')] || 0) + 1;
      e.data('channels').forEach((c) => { chCounts[c] = (chCounts[c] || 0) + 1; });
      tmpCounts[e.data('temporal')] = (tmpCounts[e.data('temporal')] || 0) + 1;
    });

    const nt = document.getElementById('gvNodeTypes'); nt.innerHTML = '';
    TYPE_ORDER.forEach((ty) => nt.appendChild(checkboxRow('types', ty, nodeSwatch(ty, t) + esc(ty), typeCounts[ty] || 0)));

    const ek = document.getElementById('gvEdgeKinds'); ek.innerHTML = '';
    KIND_ORDER.forEach((k) => {
      const style = EDGE_STYLE[k] || 'solid';
      const sw = '<span class="gv-swatch-edge ' + style + '" style="border-top-color:' + P.edge[k] + '"></span>';
      ek.appendChild(checkboxRow('kinds', k, sw + esc(k), kindCounts[k] || 0));
    });

    const ch = document.getElementById('gvChannels'); ch.innerHTML = '';
    ['textual', 'co-change'].forEach((c) => ch.appendChild(checkboxRow('channels', c, esc(c) + ' evidence', chCounts[c] || 0)));

    const tp = document.getElementById('gvTemporal'); tp.innerHTML = '';
    ['backward', 'forward', 'same-day'].forEach((c) => tp.appendChild(checkboxRow('temporal', c, esc(c) + ' in time', tmpCounts[c] || 0)));

    const ms = document.getElementById('gvMilestones'); ms.innerHTML = '';
    MILESTONES.forEach((m) => ms.appendChild(checkboxRow('milestones', m, esc(m), msCounts[m] || 0)));
  }

  document.getElementById('gvMsAll').addEventListener('click', () => {
    state.milestones = new Set(MILESTONES);
    document.querySelectorAll('#gvMilestones input').forEach((i) => { i.checked = true; });
    applyFilters();
  });
  document.getElementById('gvMsNone').addEventListener('click', () => {
    state.milestones.clear();
    document.querySelectorAll('#gvMilestones input').forEach((i) => { i.checked = false; });
    applyFilters();
  });
  document.getElementById('gvHideIsolated').addEventListener('change', (ev) => { state.hideIsolated = ev.target.checked; applyFilters(); });

  const timeEl = document.getElementById('gvTime');
  timeEl.max = String(DATES.length - 1);
  timeEl.value = String(DATES.length - 1);
  timeEl.addEventListener('input', () => { state.maxDateIdx = +timeEl.value; applyFilters(); });

  // ---------- highlight ----------
  let lastTapped = null;
  function clearFocus() {
    cy.elements().removeClass('faded hl');
    cy.elements().unselect();
    document.getElementById('gvDetails').classList.remove('open');
    lastTapped = null;
  }

  function focusCollection(coll) {
    cy.elements('[!laneLabel]').addClass('faded');
    coll.removeClass('faded');
    coll.nodes().addClass('hl');
  }

  function reach(node, dir, depth) {
    const vis = cy.elements().not('.hidden');
    let acc = node.union(cy.collection());
    let frontier = node.union(cy.collection());
    for (let d = 0; d < depth && frontier.length; d++) {
      const step = dir === 'up' ? frontier.outgoers() : dir === 'down' ? frontier.incomers() : frontier.openNeighborhood();
      const fresh = step.intersection(vis).difference(acc);
      acc = acc.union(fresh);
      frontier = fresh.nodes();
    }
    return acc;
  }

  function highlightFrom(node) {
    const mode = document.getElementById('gvHlMode').value;
    const depth = +document.getElementById('gvDepth').value;
    const dir = mode === 'up' ? 'up' : mode === 'down' ? 'down' : 'hood';
    focusCollection(reach(node, dir, depth));
  }

  cy.on('tap', 'node', (ev) => {
    const n = ev.target;
    if (ev.originalEvent && ev.originalEvent.shiftKey && lastTapped && lastTapped.id() !== n.id()) {
      const vis = cy.elements().not('.hidden');
      const path = vis.aStar({ root: lastTapped, goal: n, directed: false });
      if (path.found) { focusCollection(path.path); hint('Path ' + lastTapped.id() + ' ↔ ' + n.id() + ': ' + (path.path.nodes().length - 1) + ' hops'); showNodeDetails(n); return; }
      hint('No path between ' + lastTapped.id() + ' and ' + n.id() + ' in the visible graph');
      return;
    }
    lastTapped = n;
    highlightFrom(n);
    showNodeDetails(n);
  });
  cy.on('tap', 'edge', (ev) => { showEdgeDetails(ev.target); });
  cy.on('tap', (ev) => { if (ev.target === cy) clearFocus(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') clearFocus(); });

  // ---------- tooltip ----------
  const tip = document.getElementById('gvTip');
  function showTip(html, pos) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const box = document.getElementById('cy').getBoundingClientRect();
    tip.style.left = Math.min(pos.x + 14, box.width - 360) + 'px';
    tip.style.top = (pos.y + 12) + 'px';
  }
  cy.on('mouseover', 'node', (ev) => {
    const d = ev.target.data();
    showTip('<b>' + esc(d.label) + '</b> · ' + esc(d.type) + ' · ' + esc(d.milestone) + '<div class="t2">' + esc(d.title) + '</div>', ev.renderedPosition);
  });
  cy.on('mouseover', 'edge', (ev) => {
    const d = ev.target.data();
    showTip(esc(d.source) + ' <b>' + esc(d.kind) + '</b> → ' + esc(d.target) + '<div class="t2">' + esc(d.channels.join(' + ')) + ' · ' + esc(d.temporal) + '</div>', ev.renderedPosition);
  });
  cy.on('mouseout tapstart drag zoom pan', () => { tip.style.display = 'none'; });

  // ---------- details ----------
  const details = document.getElementById('gvDetails');
  function typeBadge(type) {
    return '<span class="gv-badge" style="background:' + THEMES[effectiveTheme()].node[type] + '">' + esc(type) + '</span>';
  }
  function openDetails(html) { details.innerHTML = html + ''; details.classList.add('open'); details.querySelector('.close').addEventListener('click', clearFocus); }

  function showNodeDetails(n) {
    const d = n.data();
    const inc = n.connectedEdges().not('.hidden');
    const groups = {};
    inc.forEach((e) => {
      const out = e.source().id() === d.id;
      const other = out ? e.target() : e.source();
      if (other.hasClass('hidden')) return;
      const k = e.data('kind');
      (groups[k] = groups[k] || []).push({ other: other.id(), out });
    });
    let links = '';
    for (const k of KIND_ORDER) {
      if (!groups[k]) continue;
      links += '<li><span class="kindword">' + esc(k) + '</span></li>' + groups[k].map((g) =>
        '<li>' + (g.out ? '→ ' : '← ') + '<a data-goto="' + esc(g.other) + '">' + esc(g.other) + '</a></li>').join('');
    }
    openDetails(
      '<h2>' + esc(d.label) + ' ' + typeBadge(d.type) + '<button class="close">✕</button></h2>' +
      '<div class="meta">' + esc(d.milestone) + ' · added ' + esc(d.date) + ' · ' + d.lines + ' lines · degree ' + d.deg + '</div>' +
      '<div class="file">' + esc(d.file) + '</div>' +
      '<p>' + esc(d.summary) + '</p>' +
      '<div class="meta">' + inc.length + ' visible edges</div><ul class="links">' + links + '</ul>'
    );
    details.querySelectorAll('a[data-goto]').forEach((a) => a.addEventListener('click', () => {
      const t = cy.$id(a.getAttribute('data-goto'));
      if (t.length) { cy.animate({ center: { eles: t }, duration: 250 }); lastTapped = t; highlightFrom(t); showNodeDetails(t); }
    }));
  }

  function showEdgeDetails(e) {
    const d = e.data();
    const quotes = (d.quotes || []).map((q) =>
      '<div class="quote"><span class="src">' + esc(q.file) + ':' + q.line + (q.section ? ' · ' + esc(q.section) : '') + '</span>' + esc(q.quote) + '</div>').join('');
    const shared = (d.sharedFiles || []).slice(0, 5).map((f) =>
      '<div class="quote"><span class="src">w=' + (f.weight != null ? f.weight.toFixed(2) : '?') + '</span>' + esc(f.path) + '</div>').join('');
    openDetails(
      '<h2>' + esc(d.source) + ' → ' + esc(d.target) + '<button class="close">✕</button></h2>' +
      '<div class="meta"><b>' + esc(d.kind) + '</b>' + (d.conf ? ' (' + esc(d.conf) + ' confidence)' : '') +
      ' · ' + esc(d.channels.join(' + ')) + ' · ' + esc(d.temporal) + ' in time</div>' +
      (d.rationale ? '<p>' + esc(d.rationale) + '</p>' : '') +
      (quotes ? '<div class="meta">textual evidence (' + d.textualCount + ' total)</div>' + quotes : '') +
      (shared ? '<div class="meta">co-changed files</div>' + shared : '')
    );
  }

  // ---------- search ----------
  const dl = document.getElementById('gvIds');
  dl.innerHTML = DATA.nodes.map((n) => '<option value="' + esc(n.id) + '">' + esc(n.title) + '</option>').join('');
  document.getElementById('gvSearch').addEventListener('change', (ev) => {
    const q = ev.target.value.trim().toLowerCase().replace(/^#/, '');
    if (!q) return;
    let hit = DATA.nodes.find((n) => String(n.id).toLowerCase() === q) ||
      DATA.nodes.find((n) => n.title.toLowerCase().includes(q)) ||
      DATA.nodes.find((n) => String(n.id).toLowerCase().includes(q));
    if (!hit) { hint('No ticket matches "' + ev.target.value + '"'); return; }
    const n = cy.$id(hit.id);
    cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.2), duration: 300 });
    lastTapped = n;
    highlightFrom(n);
    showNodeDetails(n);
  });

  // ---------- export ----------
  function download(name, blobOrUrl) {
    const a = document.createElement('a');
    a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = name;
    a.click();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => currentLayout + '-' + effectiveTheme();
  document.getElementById('gvPng').addEventListener('click', () => {
    download('ticket-graph-' + stamp() + '.png', cy.png({ output: 'blob', full: true, scale: 3, bg: THEMES[effectiveTheme()].surface }));
  });
  document.getElementById('gvSvg').addEventListener('click', () => {
    const svg = cy.svg({ full: true, scale: 1, bg: THEMES[effectiveTheme()].surface });
    download('ticket-graph-' + stamp() + '.svg', new Blob([svg], { type: 'image/svg+xml' }));
  });

  // ---------- positions ----------
  document.getElementById('gvSavePos').addEventListener('click', () => {
    const pos = {};
    cy.nodes('[!laneLabel]').forEach((n) => { const p = n.position(); pos[n.id()] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; });
    const out = {}; out[currentLayout] = pos;
    download('positions.json', new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    hint('Saved — drop into tools/graph-viz/positions/ and rebuild to make it the default');
  });
  document.getElementById('gvLoadPos').addEventListener('click', () => document.getElementById('gvPosFile').click());
  document.getElementById('gvPosFile').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    f.text().then((txt) => {
      const obj = JSON.parse(txt);
      const pos = obj[currentLayout] || obj;
      cy.batch(() => cy.nodes().forEach((n) => { const p = pos[n.id()]; if (p) n.position({ x: p[0], y: p[1] }); }));
      cy.fit(undefined, 30);
      hint('Applied positions from ' + f.name);
    }).catch((err) => hint('Could not read positions file: ' + err.message));
  });

  // ---------- toolbar / view controls ----------
  function hint(msg) { document.getElementById('gvHint').textContent = msg; }
  document.getElementById('gvLayout').addEventListener('change', (ev) => { currentLayout = ev.target.value; runLayout(currentLayout); });
  document.getElementById('gvRelayout').addEventListener('click', () => runLayout(currentLayout, { force: true }));
  document.getElementById('gvFit').addEventListener('click', () => cy.fit(undefined, 30));

  function applyTheme() {
    const sel = document.getElementById('gvTheme').value;
    root.setAttribute('data-gv-theme', sel);
    cy.style(cyStyle(effectiveTheme()));
    buildFilterPanels(); // swatch colors follow the theme
    syncCheckboxes();
  }
  function syncCheckboxes() {
    // rebuilt panels default to checked; restore unchecked state
    const restore = (containerSel, set, values) => {
      document.querySelectorAll(containerSel + ' input').forEach((inp, i) => { inp.checked = set.has(values[i]); });
    };
    restore('#gvNodeTypes', state.types, TYPE_ORDER);
    restore('#gvEdgeKinds', state.kinds, KIND_ORDER);
    restore('#gvChannels', state.channels, ['textual', 'co-change']);
    restore('#gvTemporal', state.temporal, ['backward', 'forward', 'same-day']);
    restore('#gvMilestones', state.milestones, MILESTONES);
  }
  document.getElementById('gvTheme').addEventListener('change', applyTheme);
  media.addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- boot ----------
  // Optional deep-link state: #layout=timeline&theme=dark&focus=QRM6-009&mode=up&depth=2
  const hash = Object.fromEntries(new URLSearchParams(location.hash.replace(/^#/, '')));
  if (hash.layout === 'timeline' || hash.layout === 'fcose') {
    currentLayout = hash.layout;
    document.getElementById('gvLayout').value = hash.layout;
  }
  if (hash.theme === 'light' || hash.theme === 'dark') document.getElementById('gvTheme').value = hash.theme;
  if (hash.mode) document.getElementById('gvHlMode').value = hash.mode === 'up' ? 'up' : hash.mode === 'down' ? 'down' : 'hood';
  if (hash.depth) document.getElementById('gvDepth').value = hash.depth;

  applyTheme();
  applyFilters();
  runLayout(currentLayout);
  if (hash.focus) {
    const n = cy.$id(hash.focus);
    if (n.length) { lastTapped = n; highlightFrom(n); showNodeDetails(n); cy.center(n); }
  }
  console.log('graph-viz ready: ' + DATA.nodes.length + ' nodes, ' + DATA.edges.length + ' edges; svg export ' +
    (typeof cy.svg === 'function' ? 'ok' : 'MISSING') + '; fcose ' + (window.cytoscapeFcose ? 'ok' : 'MISSING'));
})();
