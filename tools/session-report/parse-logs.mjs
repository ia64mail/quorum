#!/usr/bin/env node
/**
 * Quorum Session Log Parser
 *
 * Parses raw JSONL logs from a Quorum session into a structured digest
 * suitable for Claude Code to generate a session report.
 *
 * Usage:
 *   node tools/session-report/parse-logs.mjs [SESSION_SUFFIX]
 *   node tools/session-report/parse-logs.mjs 20260402T194601
 *   node tools/session-report/parse-logs.mjs --latest
 *   node tools/session-report/parse-logs.mjs --list
 *
 * Options:
 *   --latest        Auto-detect the most recent session (default if no arg)
 *   --list          List all available sessions with basic info
 *   --logs-dir DIR  Override logs directory (default: logs/)
 *   --verbose       Include individual tool call details in agent activity
 *
 * Output: Structured markdown digest to stdout.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_LOGS_DIR = resolve(REPO_ROOT, 'logs');

// Known roles — used to identify agent log files vs mcp-server/terminal
const AGENT_ROLES = ['architect', 'developer', 'teamlead', 'qa', 'productowner'];
const SYSTEM_ROLES = ['mcp-server', 'terminal'];
const ALL_ROLES = [...SYSTEM_ROLES, ...AGENT_ROLES, 'unknown', 'moderator'];

// ─── Helpers ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    session: null,
    list: false,
    verbose: false,
    noAdapter: false,
    logsDir: DEFAULT_LOGS_DIR,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') opts.list = true;
    else if (args[i] === '--latest') opts.session = null;
    else if (args[i] === '--verbose') opts.verbose = true;
    else if (args[i] === '--no-adapter') opts.noAdapter = true;
    else if (args[i] === '--logs-dir' && args[i + 1]) opts.logsDir = resolve(args[++i]);
    else if (!args[i].startsWith('-')) opts.session = args[i];
  }

  return opts;
}

function readJsonl(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _parseError: true, _line: idx + 1, _raw: line };
      }
    });
  } catch {
    return [];
  }
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtTime(isoStr) {
  return isoStr?.replace(/^.*T/, '').replace(/\.\d+Z$/, '');
}

// ─── Session Discovery ───────────────────────────────────────────────

function discoverSessions(logsDir) {
  const files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
  // Group by timestamp suffix: role-TIMESTAMP.jsonl
  const sessions = new Map();

  for (const f of files) {
    const match = f.match(/^(.+)-(\d{8}T\d{6})\.jsonl$/);
    if (!match) continue;
    const [, role, timestamp] = match;
    if (!sessions.has(timestamp)) sessions.set(timestamp, []);
    sessions.get(timestamp).push({ role, file: f });
  }

  return sessions;
}

function findMatchingSessions(logsDir, sessionSuffix) {
  const sessions = discoverSessions(logsDir);

  if (!sessionSuffix) {
    // Latest: find the most recent mcp-server timestamp
    const mcpSessions = [...sessions.entries()]
      .filter(([, files]) => files.some(f => f.role === 'mcp-server'))
      .sort(([a], [b]) => b.localeCompare(a));

    if (mcpSessions.length === 0) return null;

    // The most recent mcp-server timestamp, and find all agent files
    // that are within ~10s of it (they start together but have slightly different timestamps)
    const [mcpTs] = mcpSessions[0];
    return findSessionGroup(sessions, mcpTs);
  }

  // Exact match
  if (sessions.has(sessionSuffix)) return findSessionGroup(sessions, sessionSuffix);

  // Partial match
  const matches = [...sessions.keys()].filter(k => k.includes(sessionSuffix));
  if (matches.length === 1) return findSessionGroup(sessions, matches[0]);
  if (matches.length > 1) {
    console.error(`Ambiguous session suffix "${sessionSuffix}". Matches: ${matches.join(', ')}`);
    process.exit(1);
  }

  console.error(`No session found matching "${sessionSuffix}"`);
  process.exit(1);
}

function findSessionGroup(sessions, mcpTimestamp) {
  // MCP server starts a few seconds before agents. Find agent logs within ~30s window.
  const mcpTime = parseTimestamp(mcpTimestamp);
  const group = { mcpTimestamp, files: [] };

  // Find the next mcp-server session start (upper bound for moderator grouping)
  const mcpTimestamps = [...sessions.entries()]
    .filter(([, files]) => files.some(f => f.role === 'mcp-server'))
    .map(([ts]) => parseTimestamp(ts))
    .sort((a, b) => a - b);
  const nextMcpTime = mcpTimestamps.find(t => t > mcpTime) || Infinity;

  for (const [ts, files] of sessions) {
    const t = parseTimestamp(ts);
    // Agent containers start within ~30s of mcp-server
    if (Math.abs(t - mcpTime) < 30000) {
      for (const f of files) {
        group.files.push({ ...f, timestamp: ts });
      }
    // Moderator files can start minutes/hours after mcp-server — group them
    // if their timestamp falls between this mcp-server session and the next.
    } else if (t > mcpTime && t < nextMcpTime) {
      const moderatorFiles = files.filter(f => f.role === 'moderator');
      for (const f of moderatorFiles) {
        group.files.push({ ...f, timestamp: ts });
      }
    }
  }

  return group;
}

function parseTimestamp(ts) {
  // 20260402T194601 → Date
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return 0;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
}

// ─── Log Parsing ─────────────────────────────────────────────────────

function parseSession(logsDir, sessionGroup, verbose) {
  const result = {
    mcpTimestamp: sessionGroup.mcpTimestamp,
    logFiles: sessionGroup.files.map(f => f.file),
    registrations: [],
    unregistrations: [],
    invocations: [],
    contextOps: [],
    errors: [],
    warnings: [],
    agentActivity: new Map(), // correlationId → { role, turns, tools[], responses[] }
    startTime: null,
    endTime: null,
    contextLoadCount: 0,
    contextSaveCount: 0,
  };

  // Parse MCP server log
  const mcpFile = sessionGroup.files.find(f => f.role === 'mcp-server');
  if (mcpFile) {
    const entries = readJsonl(resolve(logsDir, mcpFile.file));
    parseMcpServerLog(entries, result);
  }

  // Parse agent logs
  for (const f of sessionGroup.files) {
    if (f.role === 'mcp-server' || f.role === 'terminal' || f.role === 'unknown') continue;
    const entries = readJsonl(resolve(logsDir, f.file));
    // Moderator adapted logs use different contexts than agent logs
    if (f.role === 'moderator') {
      parseModeratorLog(entries, result);
    } else {
      parseAgentLog(entries, f.role, result, verbose);
    }
  }

  return result;
}

function parseMcpServerLog(entries, result) {
  for (const e of entries) {
    if (e._parseError) continue;
    const { timestamp, context, message, level } = e;

    if (!result.startTime || timestamp < result.startTime) result.startTime = timestamp;
    if (!result.endTime || timestamp > result.endTime) result.endTime = timestamp;

    // Registrations
    if (context === 'AgentRegistry' && message?.startsWith('Registered agent:')) {
      const role = message.replace('Registered agent: ', '');
      result.registrations.push({ timestamp, role });
    }
    if (context === 'AgentRegistry' && message?.startsWith('Unregistered agent:')) {
      const role = message.replace('Unregistered agent: ', '');
      result.unregistrations.push({ timestamp, role });
    }

    // Invocations
    if (context === 'McpService' && message?.startsWith('invoke_agent:')) {
      const m = message.match(/invoke_agent: (\w+) → (\w+) \[depth=(\d+), correlationId=([^\]]+)\]/);
      if (m) {
        result.invocations.push({
          startTime: timestamp,
          endTime: null,
          caller: m[1],
          target: m[2],
          depth: parseInt(m[3]),
          correlationId: m[4],
          success: null,
          duration: null,
        });
      }
    }

    if (context === 'MessageBroker' && message?.startsWith('Completed:')) {
      const m = message.match(/correlationId=([^\s]+) target=(\w+) success=(true|false)/);
      if (m) {
        // Find matching invocation (last one with this correlationId and target)
        const inv = [...result.invocations].reverse().find(
          i => i.correlationId === m[1] && i.target === m[2] && i.endTime === null
        );
        if (inv) {
          inv.endTime = timestamp;
          inv.success = m[3] === 'true';
          inv.duration = new Date(timestamp) - new Date(inv.startTime);
        }
      }
    }

    // Context operations
    if (context === 'InMemoryStore') {
      if (message?.includes('Context loaded:')) {
        const countMatch = message.match(/(\d+) items/);
        result.contextLoadCount = countMatch ? parseInt(countMatch[1]) : 0;
        result.contextOps.push({ timestamp, op: 'load', message });
      }
      if (message?.includes('Context saved:')) {
        const countMatch = message.match(/(\d+) items/);
        result.contextSaveCount = countMatch ? parseInt(countMatch[1]) : 0;
        result.contextOps.push({ timestamp, op: 'save', message });
      }
    }

    // Errors and warnings
    if (level === 'error') result.errors.push({ timestamp, context, message });
    if (level === 'warn') result.warnings.push({ timestamp, context, message });
  }
}

function parseAgentLog(entries, role, result, verbose) {
  let currentCorrelation = null;

  for (const e of entries) {
    if (e._parseError) continue;
    const { timestamp, context, message, level } = e;

    if (!result.endTime || timestamp > result.endTime) result.endTime = timestamp;

    // Track invocations
    if (context === 'InvocationHandler' && message?.startsWith('Invocation received:')) {
      const m = message.match(/correlationId=([^\s]+)/);
      if (m) currentCorrelation = m[1];
      const actionMatch = message.match(/action="([^"]*)/);
      const action = actionMatch ? actionMatch[1] : '';

      const key = `${currentCorrelation}:${role}:${timestamp}`;
      result.agentActivity.set(key, {
        role,
        correlationId: currentCorrelation,
        startTime: timestamp,
        action: action.slice(0, 150),
        turns: 0,
        toolCalls: [],
        toolErrors: [],
        responses: [],
        mcpToolCalls: [],
        cost: null,
        durationMs: null,
        reportedTurns: null,
        success: null,
      });
    }

    if (!currentCorrelation) continue;

    const key = [...result.agentActivity.keys()].reverse().find(
      k => k.startsWith(`${currentCorrelation}:${role}:`)
    );
    if (!key) continue;
    const activity = result.agentActivity.get(key);

    // SDK events
    if (context === 'ClaudeCodeService') {
      if (message?.startsWith('SDK response:')) {
        activity.turns++;
        if (verbose) {
          activity.responses.push(message.replace('SDK response: ', '').slice(0, 200));
        }
      }

      if (message?.startsWith('SDK tool start:')) {
        const m = message.match(/SDK tool start: (\S+)/);
        if (m) {
          const toolName = m[1];
          activity.toolCalls.push(toolName);
          if (toolName.startsWith('mcp__quorum__')) {
            const mcpTool = toolName.replace('mcp__quorum__', '');
            activity.mcpToolCalls.push({ timestamp, tool: mcpTool });
          }
        }
      }

      if (message?.startsWith('SDK tool failed:')) {
        activity.toolErrors.push(message.replace('SDK tool failed: ', '').slice(0, 200));
      }

      if (message?.startsWith('SDK reasoning:')) {
        // Count tool calls from reasoning lines too
        const m = message.match(/\[calls (\S+)\]/);
        if (m && !verbose) {
          // Already counted via tool start in verbose mode
        }
      }
    }

    // Invocation completion (cost, turns, duration)
    if (context === 'InvocationHandler' && message?.startsWith('Invocation complete:')) {
      const costMatch = message.match(/cost=\$([0-9.]+)/);
      const durMatch = message.match(/duration=(\d+)ms/);
      const turnsMatch = message.match(/turns=(\d+)/);
      if (costMatch) activity.cost = parseFloat(costMatch[1]);
      if (durMatch) activity.durationMs = parseInt(durMatch[1]);
      if (turnsMatch) activity.reportedTurns = parseInt(turnsMatch[1]);
      activity.success = true;
    }
    if (context === 'InvocationHandler' && message?.startsWith('Invocation failed:')) {
      const costMatch = message.match(/cost=\$([0-9.]+)/);
      const durMatch = message.match(/duration=(\d+)ms/);
      if (costMatch) activity.cost = parseFloat(costMatch[1]);
      if (durMatch) activity.durationMs = parseInt(durMatch[1]);
      activity.success = false;
    }

    // Errors and warnings from agents
    if (level === 'error') result.errors.push({ timestamp, context: `${role}/${context}`, message });
    if (level === 'warn') result.warnings.push({ timestamp, context: `${role}/${context}`, message });
  }
}

function parseModeratorLog(entries, result) {
  // Moderator adapted logs have QuorumLogger shape with contexts:
  // UserPrompt, ModeratorResponse, ToolCall, ToolResult, SessionSummary, Elicitation
  if (entries.length === 0) return;

  const firstEntry = entries.find(e => !e._parseError && e.timestamp);
  if (!firstEntry) return;

  const key = `moderator-session:moderator:${firstEntry.timestamp}`;
  const activity = {
    role: 'moderator',
    correlationId: 'moderator-session',
    startTime: firstEntry.timestamp,
    action: '',
    turns: 0,
    toolCalls: [],
    toolErrors: [],
    responses: [],
    mcpToolCalls: [],
    cost: null,
    durationMs: null,
    reportedTurns: null,
    success: null,
  };

  for (const e of entries) {
    if (e._parseError) continue;
    const { timestamp, context, message } = e;

    if (!result.endTime || timestamp > result.endTime) result.endTime = timestamp;

    if (context === 'UserPrompt') {
      activity.turns++;
      // Use first user prompt as the action/task description
      if (!activity.action && message) {
        activity.action = message.slice(0, 150);
      }
    }

    if (context === 'ModeratorResponse') {
      activity.turns++;
    }

    if (context === 'ToolCall') {
      activity.turns++;
      // Extract tool names from the message — format: "Tool calls: Name({...}), Name({...})"
      // Match word characters before an opening paren, anywhere in the message
      const toolNames = [];
      const toolNameRegex = /\b([A-Za-z_][\w]*)\(\{/g;
      let match;
      while ((match = toolNameRegex.exec(message)) !== null) {
        // Skip "calls" from "Tool calls:" prefix
        if (match[1] !== 'calls') toolNames.push(match[1]);
      }
      for (const tool of toolNames) {
        activity.toolCalls.push(tool);
        if (tool.startsWith('mcp__quorum__')) {
          activity.mcpToolCalls.push({ timestamp, tool: tool.replace('mcp__quorum__', '') });
        }
      }
    }

    if (context === 'ToolResult') {
      // Tool results are counted but not as separate turns
    }

    if (context === 'SessionSummary') {
      activity.turns++;
    }

    if (context === 'Elicitation') {
      activity.turns++;
    }
  }

  // Calculate duration from first to last entry
  const lastEntry = [...entries].reverse().find(e => !e._parseError && e.timestamp);
  if (firstEntry && lastEntry) {
    activity.durationMs = new Date(lastEntry.timestamp) - new Date(firstEntry.timestamp);
  }

  result.agentActivity.set(key, activity);
}

// ─── Output Formatting ──────────────────────────────────────────────

function formatDigest(session) {
  const lines = [];
  const ln = (s = '') => lines.push(s);

  // Header
  const date = session.mcpTimestamp.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const duration = session.startTime && session.endTime
    ? fmtDuration(new Date(session.endTime) - new Date(session.startTime))
    : 'unknown';

  ln(`# Session Log Digest`);
  ln();
  ln(`**Date:** ${date}`);
  ln(`**Session:** ${session.mcpTimestamp}`);
  ln(`**Duration:** ${fmtTime(session.startTime)} - ${fmtTime(session.endTime)} UTC (~${duration})`);
  ln(`**Log files:** ${session.logFiles.join(', ')}`);

  // Correlation IDs
  const correlationIds = [...new Set(session.invocations.map(i => i.correlationId))];
  if (correlationIds.length) {
    ln(`**Correlation IDs:** ${correlationIds.map(c => '`' + c.slice(0, 8) + '`').join(', ')}`);
  }

  // ─── Registrations ─────────────────────────────────────────
  ln();
  ln(`## Agent Registrations`);
  ln();
  ln('```');
  for (const r of session.registrations) {
    ln(`${fmtTime(r.timestamp)}  ${r.role.padEnd(14)} REGISTERED`);
  }
  if (session.unregistrations.length) {
    ln(`---`);
    for (const r of session.unregistrations) {
      ln(`${fmtTime(r.timestamp)}  ${r.role.padEnd(14)} UNREGISTERED`);
    }
  }
  ln('```');

  // ─── Invocations ───────────────────────────────────────────
  ln();
  ln(`## Invocations (${session.invocations.length} total)`);
  ln();

  if (session.invocations.length === 0) {
    ln('_No invocations recorded._');
  } else {
    ln('| # | Time | Caller → Target | CorrelationId | Duration | Success |');
    ln('|---|------|-----------------|---------------|----------|---------|');
    session.invocations.forEach((inv, idx) => {
      const dur = inv.duration != null ? fmtDuration(inv.duration) : '—';
      const success = inv.success === null ? '—' : inv.success ? 'YES' : '**NO**';
      const cid = inv.correlationId.slice(0, 8);
      ln(`| ${idx + 1} | ${fmtTime(inv.startTime)} | ${inv.caller} → ${inv.target} | \`${cid}\` | ${dur} | ${success} |`);
    });
  }

  // ─── Agent Activity ────────────────────────────────────────
  ln();
  ln(`## Agent Activity`);

  const activities = [...session.agentActivity.values()];
  // Group by role
  const byRole = new Map();
  for (const a of activities) {
    if (!byRole.has(a.role)) byRole.set(a.role, []);
    byRole.get(a.role).push(a);
  }

  for (const [role, acts] of byRole) {
    ln();
    ln(`### ${role}`);
    for (const a of acts) {
      const cid = a.correlationId?.slice(0, 8) || '?';
      ln();
      ln(`**Invocation** \`${cid}\` at ${fmtTime(a.startTime)}`);
      if (a.action) ln(`**Task:** "${a.action}${a.action.length >= 150 ? '...' : ''}"`);
      const costStr = a.cost != null ? `$${a.cost.toFixed(2)}` : '—';
      const durStr = a.durationMs != null ? fmtDuration(a.durationMs) : '—';
      const turnsStr = a.reportedTurns ?? a.turns;
      const statusStr = a.success === false ? ' **FAILED**' : '';
      ln(`**Turns:** ${turnsStr} | **Cost:** ${costStr} | **Duration:** ${durStr}${statusStr}`);

      // Tool usage summary
      const toolCounts = {};
      for (const t of a.toolCalls) {
        toolCounts[t] = (toolCounts[t] || 0) + 1;
      }
      if (Object.keys(toolCounts).length) {
        const toolSummary = Object.entries(toolCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([name, count]) => `${name}(${count})`)
          .join(', ');
        ln(`**Tools:** ${toolSummary}`);
      }

      // MCP tool calls
      if (a.mcpToolCalls.length) {
        ln(`**MCP tools:** ${a.mcpToolCalls.map(m => `${m.tool} @${fmtTime(m.timestamp)}`).join(', ')}`);
      }

      // Tool errors
      if (a.toolErrors.length) {
        ln(`**Tool errors:**`);
        for (const err of a.toolErrors) {
          ln(`  - ${err}`);
        }
      }

      // Verbose responses
      if (a.responses.length) {
        ln(`**Responses:**`);
        for (const r of a.responses) {
          ln(`  > ${r}`);
        }
      }
    }
  }

  // ─── Context Store ─────────────────────────────────────────
  if (session.contextOps.length) {
    ln();
    ln(`## Context Store`);
    ln();
    ln(`- Loaded at startup: ${session.contextLoadCount} items`);
    ln(`- Saved at shutdown: ${session.contextSaveCount} items`);
    for (const op of session.contextOps) {
      ln(`- ${fmtTime(op.timestamp)}: ${op.message}`);
    }
  }

  // ─── Errors & Warnings ────────────────────────────────────
  if (session.errors.length) {
    ln();
    ln(`## Errors (${session.errors.length})`);
    ln();
    for (const e of session.errors) {
      ln(`- **${fmtTime(e.timestamp)}** [${e.context}] ${e.message?.slice(0, 300)}`);
    }
  }

  if (session.warnings.length) {
    ln();
    ln(`## Warnings (${session.warnings.length})`);
    ln();
    for (const e of session.warnings) {
      ln(`- **${fmtTime(e.timestamp)}** [${e.context}] ${e.message?.slice(0, 300)}`);
    }
  }

  // ─── Cost Summary ──────────────────────────────────────────
  const activitiesWithCost = activities.filter(a => a.cost != null);
  if (activitiesWithCost.length) {
    ln();
    ln(`## Cost Summary`);
    ln();
    ln('| Agent | Task | Cost | Duration | Turns |');
    ln('|-------|------|------|----------|-------|');
    for (const a of activitiesWithCost) {
      const taskShort = a.action?.slice(0, 50) || '—';
      const dur = a.durationMs != null ? fmtDuration(a.durationMs) : '—';
      const status = a.success === false ? ' (FAILED)' : '';
      ln(`| ${a.role} | ${taskShort}${a.action?.length > 50 ? '...' : ''} | $${a.cost.toFixed(2)} | ${dur} | ${a.reportedTurns ?? a.turns} |`);
    }
    const totalCost = activitiesWithCost.reduce((sum, a) => sum + a.cost, 0);
    ln(`| **Total** | | **$${totalCost.toFixed(2)}** | | |`);
  }

  // ─── Summary Stats ─────────────────────────────────────────
  ln();
  ln(`## Summary Stats`);
  ln();
  const successful = session.invocations.filter(i => i.success === true).length;
  const failed = session.invocations.filter(i => i.success === false).length;
  const pending = session.invocations.filter(i => i.success === null).length;
  ln(`- Total invocations: ${session.invocations.length} (${successful} succeeded, ${failed} failed${pending ? `, ${pending} pending` : ''})`);
  ln(`- Unique agents invoked: ${[...new Set(session.invocations.map(i => i.target))].join(', ') || 'none'}`);
  ln(`- Agents registered: ${session.registrations.map(r => r.role).join(', ')}`);
  ln(`- Total errors: ${session.errors.length}`);
  ln(`- Total warnings: ${session.warnings.length}`);

  const totalTurns = activities.reduce((sum, a) => sum + (a.reportedTurns ?? a.turns), 0);
  ln(`- Total LLM turns (across all agents): ${totalTurns}`);
  const totalCostAll = activitiesWithCost.reduce((sum, a) => sum + a.cost, 0);
  if (totalCostAll > 0) ln(`- Total cost: $${totalCostAll.toFixed(2)}`);

  return lines.join('\n');
}

// ─── List Mode ───────────────────────────────────────────────────────

function listSessions(logsDir) {
  const sessions = discoverSessions(logsDir);
  const sorted = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b));

  console.log(`Found ${sorted.length} sessions in ${logsDir}\n`);
  console.log('TIMESTAMP        ROLES                                    FILES');
  console.log('─'.repeat(75));

  for (const [ts, files] of sorted) {
    const roles = files.map(f => f.role).sort().join(', ');
    const date = ts.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const time = ts.slice(9).replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3');
    console.log(`${date} ${time}  ${roles.padEnd(40)} ${files.length} files`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

function runAdapterIfNeeded(opts) {
  if (opts.noAdapter) return;

  const sessionsDir = resolve(REPO_ROOT, 'logs/moderator-sessions');
  if (!existsSync(sessionsDir)) return;

  const adapterPath = resolve(__dirname, 'cc-session-adapter.mjs');
  if (!existsSync(adapterPath)) {
    console.error('Warning: cc-session-adapter.mjs not found, skipping moderator log adaptation.');
    return;
  }

  try {
    console.log('Running CC CLI session adapter...');
    execFileSync(process.execPath, [adapterPath, '--sessions-dir', sessionsDir, '--output-dir', opts.logsDir], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`Warning: cc-session-adapter failed: ${err.message}`);
  }
}

function main() {
  const opts = parseArgs();

  // Auto-invoke the CC CLI session adapter before session discovery
  runAdapterIfNeeded(opts);

  if (opts.list) {
    listSessions(opts.logsDir);
    return;
  }

  const sessionGroup = findMatchingSessions(opts.logsDir, opts.session);
  if (!sessionGroup) {
    console.error('No sessions found.');
    process.exit(1);
  }

  const session = parseSession(opts.logsDir, sessionGroup, opts.verbose);
  const digest = formatDigest(session);
  console.log(digest);
}

main();