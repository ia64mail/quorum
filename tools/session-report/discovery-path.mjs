#!/usr/bin/env node
// discovery-path.mjs — reconstruct an agent's knowledge-discovery path from session logs.
//
// The agent JSONL logs capture every tool INPUT (grep pattern+path, glob, the file+region of
// each Read, every Bash command) and the agent's reasoning narration between steps
// (`SDK response`). They do NOT capture tool OUTPUTS — `SDK tool done` is a bare marker — and
// they do NOT descend into sub-agents (the `Agent` tool spawns a nested context logged elsewhere).
// This tool turns the inputs+narration into an ordered search→read→conclude→re-search trace,
// renders it as text or a Mermaid DAG, and can optionally re-execute greps/reads against a
// commit to recover the outputs the agent actually saw.
//
// Usage:
//   node tools/session-report/discovery-path.mjs                         # list invocations, latest session
//   node tools/session-report/discovery-path.mjs <sessionTs>             # list invocations for a session
//   node tools/session-report/discovery-path.mjs <sessionTs> <corrId>    # annotated trace for one invocation
//   node tools/session-report/discovery-path.mjs <sessionTs> <corrId> --mermaid
//   node tools/session-report/discovery-path.mjs <sessionTs> <corrId> --recover <commit>
// Options: --logs-dir <dir> (default logs/) · --repo-dir <dir> (default cwd, for --recover) · --max <n>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const AGENT_ROLES = ['developer', 'teamlead', 'architect', 'qa', 'productowner', 'moderator'];
const fileRe = new RegExp(`^(${AGENT_ROLES.join('|')})-(\\d{8}T\\d{6})\\.jsonl$`);

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { logsDir: 'logs', repoDir: '.', mermaid: false, recover: null, max: Infinity, list: false };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mermaid') opt.mermaid = true;
  else if (a === '--list') opt.list = true;
  else if (a === '--recover') opt.recover = argv[++i];
  else if (a === '--logs-dir') opt.logsDir = argv[++i];
  else if (a === '--repo-dir') opt.repoDir = argv[++i];
  else if (a === '--max') {
    const n = Number(argv[++i]);
    if (!Number.isInteger(n) || n < 1) { console.error(`--max expects a positive integer, got "${argv[i]}"`); process.exit(2); }
    opt.max = n;
  }
  else pos.push(a);
}
// Positionals are <sessionTs> <corrId>, but a lone arg is disambiguated by shape: a YYYYMMDDThhmmss
// token is the session (newest is used otherwise), anything else is a corrId against the latest session.
const TS_RE = /^\d{8}T\d{6}$/;
let sessionArg, corrArg;
if (pos.length === 1 && !TS_RE.test(pos[0])) corrArg = pos[0];
else [sessionArg, corrArg] = pos;

// ---- file resolution -----------------------------------------------------
function allAgentFiles() {
  return fs.readdirSync(opt.logsDir)
    .map((f) => { const m = f.match(fileRe); return m ? { f, role: m[1], ts: m[2] } : null; })
    .filter(Boolean);
}
function tsToMs(ts) { // 20260617T012133 -> epoch-ish ordering value
  return Date.parse(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`);
}
function resolveSessionFiles() {
  const files = allAgentFiles();
  if (!files.length) { console.error(`No agent logs in ${opt.logsDir}`); process.exit(1); }
  // pick anchor: the requested session, else the newest run (ts format is lexicographically monotonic)
  const anchorTs = sessionArg || files.map((x) => x.ts).sort().at(-1);
  const anchorMs = tsToMs(anchorTs);
  if (!Number.isFinite(anchorMs)) {
    console.error(`"${sessionArg}" is not a valid session timestamp (expected YYYYMMDDThhmmss). Run with no args to list sessions.`);
    process.exit(2);
  }
  // include role logs within a 20-minute window of the anchor (one run boots its agents together)
  const windowed = files.filter((x) => Math.abs(tsToMs(x.ts) - anchorMs) <= 20 * 60 * 1000);
  if (!windowed.length) {
    const known = [...new Set(files.map((x) => x.ts))].sort();
    console.error(`No agent logs within 20 min of ${anchorTs}. Known session timestamps:\n  ${known.join('\n  ')}`);
    process.exit(2);
  }
  // resolved session label = earliest ts in the window (closest to session boot, matches the mcp-server stamp)
  const sessionTs = windowed.map((x) => x.ts).sort()[0];
  return { files: windowed, sessionTs };
}

// ---- parse ---------------------------------------------------------------
function parseEvents(file) {
  const out = [];
  for (const line of fs.readFileSync(path.join(opt.logsDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    out.push({ ts: (o.timestamp || '').slice(11, 19), full: o.timestamp, ctx: o.context || '', msg: o.message || '' });
  }
  return out;
}
function splitInvocations(events, role) {
  // The moderator is a CC CLI session, not a dispatched invocation — it has no `Invocation received`
  // boundaries. Segment it by user turn (UserPrompt) instead; each turn is one discovery episode.
  if (role === 'moderator') return splitModeratorTurns(events);
  const invs = [];
  let cur = null;
  for (const e of events) {
    const recv = e.msg.match(/^Invocation received: correlationId=([0-9a-f-]{36}) action="([\s\S]*?)"\s*$/)
      || e.msg.match(/^Invocation received: correlationId=([0-9a-f-]{36}) action="([\s\S]*)/);
    if (recv) { cur = { role, corrId: recv[1], short: recv[1].slice(0, 8), action: recv[2].replace(/\s+/g, ' ').slice(0, 90), events: [], start: e.ts }; invs.push(cur); continue; }
    if (e.msg.startsWith('Invocation complete') || e.msg.startsWith('Invocation failed')) { if (cur) cur.end = e.ts; cur = null; continue; }
    if (cur) cur.events.push(e);
  }
  return invs;
}
function splitModeratorTurns(events) {
  const turns = [];
  let cur = null; let n = 0;
  for (const e of events) {
    if (e.ctx === 'UserPrompt') {
      cur = { role: 'moderator', corrId: `turn${++n}`, short: `turn${n}`, action: e.msg.replace(/\s+/g, ' ').trim().slice(0, 90), events: [], start: e.ts, isModerator: true };
      turns.push(cur);
      continue;
    }
    if (cur) { cur.events.push(e); cur.end = e.ts; }
  }
  return turns;
}

// ---- node extraction -----------------------------------------------------
// Strip the container mount prefixes so paths render repo-relative: agents run in per-invocation
// worktrees (/var/agent-worktrees/<uuid>/), the moderator in the shared workspace (/mnt/quorum/workspace/).
function stripWorktree(p) { return (p || '').replace(/^.*\/agent-worktrees\/[0-9a-f-]+\//, '').replace(/^\/mnt\/quorum\/workspace\//, ''); }
// The logger truncates large tool inputs (Edit's old_string/new_string), so full JSON.parse can
// fail mid-object. Fall back to regex-extracting the leading scalar fields, which always survive.
function field(msg, name) { const m = msg.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? m[1].replace(/\\(["\\/])/g, '$1') : undefined; }
function toolInput(msg) {
  const i = msg.indexOf('{'); if (i < 0) return {};
  try { return JSON.parse(msg.slice(i)); } catch { /* truncated — recover scalars below */ }
  const o = {};
  for (const k of ['file_path', 'path', 'pattern', 'output_mode', 'command', 'description', 'prompt', 'scope', 'mode', 'query']) { const v = field(msg, k); if (v !== undefined) o[k] = v; }
  const off = msg.match(/"offset"\s*:\s*(\d+)/); if (off) o.offset = Number(off[1]);
  const lim = msg.match(/"limit"\s*:\s*(\d+)/); if (lim) o.limit = Number(lim[1]);
  return o;
}

function buildPath(inv) {
  if (inv.isModerator) return buildModeratorPath(inv);
  const nodes = [];
  for (const e of inv.events) {
    const m = e.msg;
    if (m.startsWith('SDK response: ')) {
      const txt = m.slice(14).replace(/\s+/g, ' ').trim();
      if (txt.length > 12) nodes.push({ kind: 'knowledge', ts: e.ts, text: txt });
    } else if (m.startsWith('SDK tool start: ')) {
      const tool = m.slice(16).split(' ')[0];
      const inp = toolInput(m);
      if (tool === 'Read') nodes.push({ kind: 'read', ts: e.ts, file: stripWorktree(inp.file_path), region: inp.offset ? `@${inp.offset}+${inp.limit || ''}` : '', raw: inp });
      else if (tool === 'Grep') nodes.push({ kind: 'grep', ts: e.ts, pattern: inp.pattern, path: stripWorktree(inp.path) || '.', mode: inp.output_mode || 'files', raw: inp });
      else if (tool === 'Glob') nodes.push({ kind: 'glob', ts: e.ts, pattern: inp.pattern });
      else if (tool === 'Bash') nodes.push({ kind: 'bash', ts: e.ts, cmd: (inp.command || '').replace(/\s+/g, ' ').trim() });
      else if (tool === 'Edit') nodes.push({ kind: 'edit', ts: e.ts, file: stripWorktree(inp.file_path || inp.path) });
      else if (tool === 'Agent') nodes.push({ kind: 'agent', ts: e.ts, desc: inp.description || (inp.prompt || '').slice(0, 50) });
      else if (tool.startsWith('mcp__quorum__')) nodes.push({ kind: 'mcp', ts: e.ts, tool: tool.replace('mcp__quorum__', ''), inp: JSON.stringify(inp).slice(0, 80) });
    }
  }
  return nodes;
}
// Moderator CC CLI shape: `ToolCall` ("Tool calls: <Tool>({…})"), `ToolResult` (the actual output —
// which agent logs lack), `ModeratorResponse` (reasoning). Results have no id and arrive in call order,
// so pair them FIFO. This is why the moderator trace shows search→RESULT→conclude without --recover.
function buildModeratorPath(inv) {
  const nodes = [];
  const pending = []; // calls awaiting their ToolResult, oldest first
  for (const e of inv.events) {
    if (e.ctx === 'ModeratorResponse') {
      const txt = e.msg.replace(/\s+/g, ' ').trim();
      if (txt.length > 12) nodes.push({ kind: 'knowledge', ts: e.ts, text: txt });
    } else if (e.ctx === 'ToolCall') {
      const mm = e.msg.match(/^Tool calls:\s*([\w.]+)\(/);
      if (!mm) continue;
      const tool = mm[1]; const inp = toolInput(e.msg);
      let node;
      if (tool === 'Read') node = { kind: 'read', ts: e.ts, file: stripWorktree(inp.file_path), region: inp.offset ? `@${inp.offset}+${inp.limit || ''}` : '', raw: inp };
      else if (tool === 'Grep') node = { kind: 'grep', ts: e.ts, pattern: inp.pattern, path: stripWorktree(inp.path) || '.', mode: inp.output_mode || 'files', raw: inp };
      else if (tool === 'Glob') node = { kind: 'glob', ts: e.ts, pattern: inp.pattern };
      else if (tool === 'Bash') node = { kind: 'bash', ts: e.ts, cmd: (inp.command || '').replace(/\s+/g, ' ').trim() };
      else if (tool === 'Edit' || tool === 'Write') node = { kind: 'edit', ts: e.ts, file: stripWorktree(inp.file_path || inp.path) };
      else if (tool.startsWith('mcp__quorum__')) node = { kind: 'mcp', ts: e.ts, tool: tool.replace('mcp__quorum__', ''), inp: JSON.stringify(inp).slice(0, 80) };
      else node = { kind: 'tool', ts: e.ts, name: tool, inp: (inp.query || inp.description || '').slice(0, 60) };
      nodes.push(node); pending.push(node);
    } else if (e.ctx === 'ToolResult') {
      const target = pending.shift();
      if (target) target.result = e.msg.replace(/^tool_use_id=\S+:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  return nodes;
}

// ---- output recovery (re-execute against a commit) -----------------------
function recover(node, commit) {
  try {
    if (node.kind === 'grep') {
      const args = ['-C', opt.repoDir, '--no-pager', 'grep', '-n', '-I', '-e', node.pattern, commit];
      if (node.path && node.path !== '.') args.push('--', node.path);
      const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split('\n').filter(Boolean);
      return `${lines.length} hit(s)` + (lines.length ? `: ${lines.slice(0, 3).map((l) => l.split(':').slice(1, 3).join(':')).join(' | ')}${lines.length > 3 ? ' …' : ''}` : '');
    }
    if (node.kind === 'read' && node.file) {
      const out = execFileSync('git', ['-C', opt.repoDir, 'show', `${commit}:${node.file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const all = out.split('\n');
      const start = node.raw?.offset ? node.raw.offset - 1 : 0;
      // preview the head of the region the agent actually read, capped at PREVIEW_LINES so output stays compact
      const PREVIEW_LINES = 5;
      const span = Math.min(node.raw?.limit || PREVIEW_LINES, PREVIEW_LINES);
      const slice = all.slice(start, start + span).map((l) => l.trim()).filter(Boolean);
      return `${all.length} lines; head: ${slice.join(' / ').slice(0, 100)}`;
    }
  } catch { return 'recover: not available at commit'; }
  return null;
}

// ---- renderers -----------------------------------------------------------
const ICON = { read: '📖 READ ', grep: '🔎 GREP ', glob: '🗂  GLOB ', bash: '💻 BASH ', edit: '✏️  EDIT ', agent: '⚠  AGENT', mcp: '🧰 MCP  ', tool: '⚙  TOOL ', knowledge: '💡' };
function label(n) {
  switch (n.kind) {
    case 'read': return `${n.file}${n.region}`;
    case 'grep': return `/${n.pattern}/ in ${n.path} (${n.mode})`;
    case 'glob': return n.pattern;
    case 'bash': return n.cmd.slice(0, 100);
    case 'edit': return n.file;
    case 'agent': return `${n.desc}  ⟶ nested context (not in this log)`;
    case 'mcp': return `${n.tool} ${n.inp}`;
    case 'tool': return `${n.name} ${n.inp}`;
    case 'knowledge': return `"${n.text.slice(0, 150)}"`;
  }
}
function renderTrace(inv, nodes, commit) {
  console.log(`\n## ${inv.role}:${inv.short}  (${inv.start}–${inv.end || '?'})  ${inv.action}\n`);
  let shown = 0;
  for (const n of nodes) {
    if (shown++ >= opt.max) { console.log(`   … (${nodes.length - opt.max} more, raise --max)`); break; }
    if (n.kind === 'knowledge') console.log(`${n.ts}            ${ICON.knowledge} ${label(n)}`);
    else {
      console.log(`${n.ts}  ${ICON[n.kind]} ${label(n)}`);
      if (n.result) console.log(`             ↳ ${n.result}`); // moderator: real output, inline (no --recover needed)
      else if (commit && (n.kind === 'grep' || n.kind === 'read')) { const r = recover(n, commit); if (r) console.log(`             ↳ ${r}`); }
    }
  }
}
function renderMermaid(inv, nodes) {
  // spine of knowledge (reasoning) nodes; each action attaches to the knowledge node that preceded it
  const id = (i) => `n${i}`;
  console.log('```mermaid');
  console.log('flowchart TD');
  console.log(`  %% ${inv.role}:${inv.short} — ${inv.action}`);
  let lastK = null;
  const edges = [];
  nodes.forEach((n, i) => {
    let shape;
    const t = label(n).replace(/"/g, "'").slice(0, 70);
    if (n.kind === 'knowledge') shape = `${id(i)}{{"💡 ${t}"}}`;
    else if (n.kind === 'grep' || n.kind === 'glob') shape = `${id(i)}[["🔎 ${t}"]]`;
    else if (n.kind === 'read') shape = `${id(i)}[/"📖 ${t}"/]`;
    else if (n.kind === 'edit') shape = `${id(i)}["✏️ ${t}"]`;
    else if (n.kind === 'agent') shape = `${id(i)}[["⚠ ${t}"]]:::nested`;
    else if (n.kind === 'mcp') shape = `${id(i)}[("🧰 ${t}")]`;
    else shape = `${id(i)}["${n.kind} ${t}"]`;
    console.log(`  ${shape}`);
    if (n.kind === 'knowledge') {
      if (lastK !== null) edges.push(`${id(lastK)} ==> ${id(i)}`); // reasoning spine
      else if (i > 0) edges.push(`${id(i - 1)} --> ${id(i)}`); // first conclusion: link the preceding action chain in
      lastK = i;
    } else if (lastK !== null) edges.push(`${id(lastK)} --> ${id(i)}`);
    else if (i > 0) edges.push(`${id(i - 1)} --> ${id(i)}`);
  });
  edges.forEach((e) => console.log(`  ${e}`));
  console.log('  classDef nested fill:#fee,stroke:#c66,stroke-dasharray:4;');
  console.log('```');
}

// ---- main ----------------------------------------------------------------
const { files, sessionTs } = resolveSessionFiles();
const invocations = files.flatMap(({ f, role }) => splitInvocations(parseEvents(f), role));

if (!corrArg || opt.list) {
  console.log(`# Invocations in session ${sessionTs} (${files.length} agent logs)\n`);
  console.log('corrId    role        when         grep read edit  task');
  for (const inv of invocations) {
    let grep = 0; let read = 0; let edit = 0;
    for (const e of inv.events) {
      const m = inv.isModerator ? e.msg.replace(/^Tool calls:\s*/, 'SDK tool start: ') : e.msg;
      if (m.startsWith('SDK tool start: Grep')) grep++;
      else if (m.startsWith('SDK tool start: Read')) read++;
      else if (m.startsWith('SDK tool start: Edit') || m.startsWith('SDK tool start: Write')) edit++;
    }
    console.log(`${inv.short.padEnd(9)} ${inv.role.padEnd(10)}  ${inv.start}     ${String(grep).padStart(3)} ${String(read).padStart(4)} ${String(edit).padStart(4)}  ${inv.action}`);
  }
  console.log('\nRun again with a corrId for the discovery trace; add --mermaid or --recover <commit>.');
  process.exit(0);
}

const match = invocations.filter((i) => i.corrId.startsWith(corrArg) || i.short === corrArg);
if (!match.length) { console.error(`No invocation matching ${corrArg}`); process.exit(1); }
// A correlationId is NOT unique per invocation — retries and same-turn re-dispatches reuse it. A short
// prefix can also span distinct ids. Surface the ambiguity so concatenated traces aren't read as one.
if (match.length > 1) {
  console.error(`# ${match.length} invocations match "${corrArg}" (correlationIds repeat across retries) — rendering all, newest-task last:`);
  match.forEach((inv, i) => console.error(`#   [${i + 1}] ${inv.role}:${inv.short} @${inv.start}  ${inv.action}`));
  console.error('');
}
for (const inv of match) {
  const nodes = buildPath(inv);
  if (opt.mermaid) renderMermaid(inv, nodes);
  else renderTrace(inv, nodes, opt.recover);
}