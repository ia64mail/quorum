#!/usr/bin/env node
/**
 * CC CLI Session Adapter — QRM7-005
 *
 * Reads raw Claude Code CLI session JSONL files from logs/moderator-sessions/
 * (recursively, across project-slug subdirectories) and emits one
 * logs/moderator-{timestamp}.jsonl per session in QuorumLogger shape:
 *   { timestamp, level, context, message, agentRole: 'moderator' }
 *
 * Idempotent: safe to re-run — each output file is re-emitted from scratch
 * on every invocation (simple and correct for the expected data sizes).
 *
 * Usage:
 *   node tools/session-report/cc-session-adapter.mjs
 *   node tools/session-report/cc-session-adapter.mjs --sessions-dir <path>
 *   node tools/session-report/cc-session-adapter.mjs --output-dir <path>
 *   node tools/session-report/cc-session-adapter.mjs --dry-run
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_SESSIONS_DIR = resolve(REPO_ROOT, 'logs/moderator-sessions');
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, 'logs');

// ─── CLI Args ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    sessionsDir: DEFAULT_SESSIONS_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sessions-dir' && args[i + 1]) opts.sessionsDir = resolve(args[++i]);
    else if (args[i] === '--output-dir' && args[i + 1]) opts.outputDir = resolve(args[++i]);
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`CC CLI Session Adapter — converts CC CLI session JSONL to QuorumLogger format.

Usage:
  node cc-session-adapter.mjs [options]

Options:
  --sessions-dir DIR  Input directory (default: logs/moderator-sessions/)
  --output-dir DIR    Output directory (default: logs/)
  --dry-run           Show what would be written without writing
  --help, -h          Show this help`);
      process.exit(0);
    }
  }

  return opts;
}

// ─── File Discovery ─────────────────────────────────────────────────

/**
 * Recursively find all .jsonl files under the sessions directory.
 * CC CLI writes to <project-slug>/<sessionId>.jsonl.
 */
function discoverSessionFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === '.jsonl') {
        // Skip .gitkeep and other non-session files
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ─── Event Mapping ──────────────────────────────────────────────────

/**
 * Classify a CC CLI JSONL entry into a QuorumLogger context category.
 * Returns null if the entry should be dropped.
 * Returns { context, message, level } for entries to emit.
 */
function mapEvent(entry) {
  const { type } = entry;

  // Drop silently: CC CLI internal state
  if (type === 'permission-mode') return null;

  // Drop silently: internal bookkeeping types
  if (type === 'queue-operation') return null;
  if (type === 'ai-title') return null;
  if (type === 'last-prompt') return null;
  if (type === 'attachment') return null;

  // Summary entries
  if (type === 'summary') {
    const summary = entry.summary || entry.message?.content || JSON.stringify(entry);
    return {
      context: 'SessionSummary',
      message: typeof summary === 'string' ? summary.slice(0, 2000) : JSON.stringify(summary).slice(0, 2000),
      level: 'log',
    };
  }

  // Result/metadata entries — map to SessionMeta
  if (type === 'result') {
    const result = entry.result || entry.message?.content || JSON.stringify(entry);
    return {
      context: 'SessionMeta',
      message: typeof result === 'string' ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000),
      level: 'log',
    };
  }

  // User messages
  if (type === 'user') {
    const msg = entry.message;
    if (!msg) return null;

    const content = msg.content;

    // String content → UserPrompt
    if (typeof content === 'string') {
      return {
        context: 'UserPrompt',
        message: content.slice(0, 5000),
        level: 'log',
      };
    }

    // Array content — inspect block types
    if (Array.isArray(content)) {
      const hasToolResult = content.some(b => b.type === 'tool_result');
      if (hasToolResult) {
        // Summarize tool results
        const summaries = content
          .filter(b => b.type === 'tool_result')
          .map(b => {
            const resultContent = typeof b.content === 'string'
              ? b.content.slice(0, 500)
              : Array.isArray(b.content)
                ? b.content.map(c => c.text || c.type || '').join(' ').slice(0, 500)
                : JSON.stringify(b.content).slice(0, 500);
            return `tool_use_id=${b.tool_use_id}: ${resultContent}`;
          });
        return {
          context: 'ToolResult',
          message: summaries.join('\n'),
          level: 'log',
        };
      }

      // Text-only blocks → UserPrompt
      const textBlocks = content.filter(b => b.type === 'text');
      if (textBlocks.length > 0) {
        return {
          context: 'UserPrompt',
          message: textBlocks.map(b => b.text).join('\n').slice(0, 5000),
          level: 'log',
        };
      }
    }

    // Fallback for user type with unrecognized content structure
    return {
      context: 'UserPrompt',
      message: JSON.stringify(content).slice(0, 2000),
      level: 'log',
    };
  }

  // Assistant messages
  if (type === 'assistant') {
    const msg = entry.message;
    if (!msg) return null;

    const content = msg.content;

    if (Array.isArray(content)) {
      const hasToolUse = content.some(b => b.type === 'tool_use');

      if (hasToolUse) {
        // Extract tool call details
        const toolCalls = content
          .filter(b => b.type === 'tool_use')
          .map(b => {
            const inputSummary = b.input
              ? JSON.stringify(b.input).slice(0, 300)
              : '';
            return `${b.name}(${inputSummary})`;
          });
        // Also capture any text that accompanies tool calls
        const textParts = content
          .filter(b => b.type === 'text' && b.text?.trim())
          .map(b => b.text.trim());
        const messageParts = [];
        if (textParts.length) messageParts.push(textParts.join('\n'));
        messageParts.push('Tool calls: ' + toolCalls.join(', '));

        return {
          context: 'ToolCall',
          message: messageParts.join('\n').slice(0, 5000),
          level: 'log',
        };
      }

      // Text-only (may include thinking blocks — skip thinking, emit text)
      const textBlocks = content.filter(b => b.type === 'text' && b.text?.trim());
      if (textBlocks.length > 0) {
        return {
          context: 'ModeratorResponse',
          message: textBlocks.map(b => b.text).join('\n').slice(0, 5000),
          level: 'log',
        };
      }

      // Thinking-only blocks — skip (internal reasoning, not session-relevant)
      const hasOnlyThinking = content.every(b => b.type === 'thinking');
      if (hasOnlyThinking) return null;
    }

    // String content (rare for assistant)
    if (typeof content === 'string') {
      return {
        context: 'ModeratorResponse',
        message: content.slice(0, 5000),
        level: 'log',
      };
    }

    return null;
  }

  // Elicitation entries (shape TBD — CC CLI may log these distinctly in future)
  if (type === 'elicitation') {
    const content = entry.message?.content || entry.content || JSON.stringify(entry);
    return {
      context: 'Elicitation',
      message: typeof content === 'string' ? content.slice(0, 2000) : JSON.stringify(content).slice(0, 2000),
      level: 'log',
    };
  }

  // Unrecognized type → warn and skip
  console.warn(`cc-session-adapter: unrecognized CC CLI event type "${type}" — skipping`);
  return null;
}

// ─── Timestamp Extraction ───────────────────────────────────────────

/**
 * Extract a timestamp from a CC CLI JSONL entry.
 * Entries may have a top-level `timestamp` field (ISO string).
 */
function extractTimestamp(entry) {
  if (entry.timestamp) return entry.timestamp;
  if (entry.message?.timestamp) return entry.message.timestamp;
  return null;
}

/**
 * Format an ISO timestamp into the YYYYMMDDTHHMMSS format used by
 * QuorumLogger log filenames.
 */
function isoToFilenameTimestamp(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  } catch {
    return null;
  }
}

// ─── Session Processing ─────────────────────────────────────────────

function processSessionFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    console.warn(`cc-session-adapter: cannot read ${filePath}: ${err.message}`);
    return null;
  }

  if (!content) return null;

  const lines = content.split('\n');
  const outputLines = [];
  let firstTimestamp = null;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      // Skip unparseable lines
      continue;
    }

    const ts = extractTimestamp(entry);
    if (ts && !firstTimestamp) firstTimestamp = ts;

    const mapped = mapEvent(entry);
    if (!mapped) continue;

    const outputEntry = {
      timestamp: ts || new Date().toISOString(),
      level: mapped.level,
      context: mapped.context,
      message: mapped.message,
      agentRole: 'moderator',
    };

    outputLines.push(JSON.stringify(outputEntry));
  }

  if (outputLines.length === 0) return null;

  const fileTs = isoToFilenameTimestamp(firstTimestamp);
  if (!fileTs) return null;

  return {
    filename: `moderator-${fileTs}.jsonl`,
    content: outputLines.join('\n') + '\n',
    lineCount: outputLines.length,
    sourceFile: filePath,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (!existsSync(opts.sessionsDir)) {
    console.log(`cc-session-adapter: sessions directory not found: ${opts.sessionsDir}`);
    console.log('Nothing to adapt.');
    return;
  }

  const sessionFiles = discoverSessionFiles(opts.sessionsDir);
  if (sessionFiles.length === 0) {
    console.log('cc-session-adapter: no session files found.');
    return;
  }

  console.log(`cc-session-adapter: found ${sessionFiles.length} session file(s) in ${opts.sessionsDir}`);

  let written = 0;
  let skipped = 0;

  for (const file of sessionFiles) {
    const result = processSessionFile(file);
    if (!result) {
      skipped++;
      continue;
    }

    const outputPath = resolve(opts.outputDir, result.filename);

    if (opts.dryRun) {
      console.log(`  [dry-run] would write ${result.filename} (${result.lineCount} entries from ${file})`);
    } else {
      writeFileSync(outputPath, result.content, 'utf-8');
      console.log(`  wrote ${result.filename} (${result.lineCount} entries)`);
    }
    written++;
  }

  console.log(`cc-session-adapter: ${written} file(s) written, ${skipped} skipped.`);
}

main();
