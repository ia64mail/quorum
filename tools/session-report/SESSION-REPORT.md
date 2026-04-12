# Session Report Tool

Parses raw JSONL logs from Quorum Docker sessions into a structured digest, then Claude Code writes the final session report.

## Quick Start

```bash
# 1. Parse logs into a digest
node tools/session-report/parse-logs.mjs                    # latest session
node tools/session-report/parse-logs.mjs 20260402T194555    # specific session
node tools/session-report/parse-logs.mjs --list             # list all sessions

# 2. Feed digest to Claude Code to write the report
node tools/session-report/parse-logs.mjs > /tmp/digest.md
# Then ask Claude Code: "Write a session report from /tmp/digest.md"
```

## parse-logs.mjs

**Input:** JSONL log files from `logs/` (bind-mounted from Docker containers).

**Output:** Structured markdown digest to stdout with these sections:

| Section | Content |
|---------|---------|
| Header | Date, session ID, duration, log files, correlation IDs |
| Agent Registrations | Who registered/unregistered and when |
| Invocations | Table: caller→target, correlationId, duration, success/fail |
| Agent Activity | Per-invocation: task description, turns, tool usage breakdown, MCP tool calls, tool errors |
| Context Store | Load/save counts and timestamps |
| Cost Summary | Table: per-invocation cost, duration, turns, total |
| Errors & Warnings | Timestamped error/warning entries |
| Summary Stats | Totals: invocations, agents, turns, cost, errors |

**Options:**

| Flag | Description |
|------|-------------|
| `--latest` | Auto-detect most recent session (default) |
| `--list` | List all available sessions with roles and file counts |
| `--verbose` | Include SDK response text in agent activity |
| `--logs-dir DIR` | Override logs directory (default: `logs/`) |

## Writing Session Reports

The digest provides the raw data. Claude Code adds narrative analysis. The standard report structure (see `logs/sessions/` for examples) is:

### Always included (from digest)
1. **Header** — date, correlation IDs, duration, goal, log files, user prompt
2. **Agents** — table with role, status, invocation count, total cost
3. **Timeline** — startup + orchestration events in chronological order
4. **Outcomes** — what succeeded, what failed
5. **Cost Summary** — per-invocation and total

### Always included (from quorum.context)
6. **Context Store Dump** — items added during the session, with analysis of the audit trail

### Include only when relevant
7. **Bug Fix Verification** — only when verifying known bug fixes
8. **Issues** — only when errors, failures, or notable problems occurred
9. **Comparison Across Sessions** — only when explicitly requested
10. **Action Items** — only when explicitly requested

### Input sources

A complete session report requires **three** inputs:

| Source | What it provides | How to get it |
|--------|-----------------|---------------|
| **parse-logs.mjs digest** | Structured data: invocations, tool calls, costs, errors | `node tools/session-report/parse-logs.mjs` |
| **Terminal stdout** | User prompt, moderator decisions, agent response summaries, confirmation pauses | `docker attach quorum-terminal-1` during session, or user pastes into conversation |
| **quorum.context** | Context Store items — full JSON payloads stored by agents during session | Read `$WORKSPACE_PATH/quorum.context` (see `.env` for path). JSON array of `[key, item]` pairs with scope, value, timestamps. |
| **User context** | Session goal, run number, known bugs to verify | User provides when requesting the report |

The **terminal stdout** is critical because the terminal JSON log is empty for successful sessions (the moderator's orchestration is rendered to the console UI only). Terminal stdout contains:
- The user's prompt (what they asked the moderator to do)
- `→ invoke_agent → {role}:` lines showing what the moderator told each agent
- `← {role} ({duration}, ${cost}):` lines showing agent responses (truncated) and failures
- `→ context_query` / `→ context_store` lines from the moderator's own MCP calls
- Confirmation pauses (visible as gaps between `←` and `→` lines)

### Context Store Dump

Read `$WORKSPACE_PATH/quorum.context` (path from `.env` `WORKSPACE_PATH`). The file is a JSON array of `[compositeKey, item]` pairs. Each item has `key`, `value`, `scope`, `createdAt` (epoch ms), and `id` (correlationId).

To write the section:
1. **Separate carried vs new items** — compare `createdAt` timestamps against the session's start time. Items created before the session were loaded at startup; items created during the session are new.
2. **Group new items by correlation ID** — matches the invocation phases in the timeline.
3. **Show the JSON `value` payload** for each item (truncate long values with `...` for readability).
4. **Write an Analysis paragraph** — describe the audit trail (ticket → implementation → review), note any new patterns (e.g., first project-scope item), and highlight cross-agent context flow (e.g., developer consumed teamlead's ticket status).

### Tips for Claude Code
- The **Goal** and **User Prompt** come from terminal stdout — ask the user to paste it if not provided
- Correlation IDs group related invocations (e.g., `132641f7` = roadmap+ticket phase, `9d574a22` = implementation+review phase)
- A failed invocation followed by a retry to the same agent on the same correlationId = moderator retry
- Cost data comes from agent-side `InvocationHandler` logs; the digest extracts it automatically
- The workspace is at `AGENT_WORKSPACE_DIR` (typically `/mnt/quorum/workspace`) — commits exist there, not in the host repo

## Log Format Reference

All logs are JSONL with fields: `timestamp`, `level`, `context`, `message`, `agentRole`.

**Key contexts by source:**

| Source | Context | Signals |
|--------|---------|---------|
| mcp-server | `AgentRegistry` | register/unregister |
| mcp-server | `McpService` | `invoke_agent: caller → target` |
| mcp-server | `MessageBroker` | `Invoke:` (start), `Completed:` (end + success) |
| mcp-server | `InMemoryStore` | context load/save counts |
| agent | `InvocationHandler` | `Invocation received:`, `Invocation complete:` (cost, turns, duration), `Invocation failed:` |
| agent | `ClaudeCodeService` | `Session started:`, `SDK response:`, `SDK tool start/done/failed:`, `SDK reasoning:` |
| agent | `McpClientService` | connection, registration, tool discovery |