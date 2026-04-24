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

### Always included (from OpenSearch `quorum-context` index)
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
| **OpenSearch `quorum-context` index** | Context Store items — full JSON payloads stored by agents during session | Query OpenSearch (QRM5-009 replaced the legacy `quorum.context` JSON dump). See "Context Store Dump" below for the curl recipe. |
| **User context** | Session goal, run number, known bugs to verify | User provides when requesting the report |

The **terminal stdout** is critical because the terminal JSON log is empty for successful sessions (the moderator's orchestration is rendered to the console UI only). Terminal stdout contains:
- The user's prompt (what they asked the moderator to do)
- `→ invoke_agent → {role}:` lines showing what the moderator told each agent
- `← {role} ({duration}, ${cost}):` lines showing agent responses (truncated) and failures
- `→ context_query` / `→ context_store` lines from the moderator's own MCP calls
- Confirmation pauses (visible as gaps between `←` and `→` lines)

### Context Store Dump

Context items now live in OpenSearch (index `quorum-context`). The legacy `quorum.context` JSON file is only read by the one-time QRM5-007 migration service on first startup; do not use it for new sessions. Connection details (from `docker-compose.yml`): host `opensearch:9200` inside the Docker network, no auth (security plugin disabled for local dev).

**Query from the host.** Port 9200 is not exposed to the host by default. Start the container if it's down (`docker compose up -d opensearch`), then exec through it:

```bash
# All items from a session (by full correlationId — the digest truncates to 8 chars)
docker exec quorum-opensearch-1 curl -s \
  "http://localhost:9200/quorum-context/_search?size=100" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {"prefix": {"id": "d7de590f"}},
    "_source": {"excludes": ["embedding", "embeddingText"]},
    "sort": [{"createdAt": "asc"}]
  }'

# All items created during a session window (epoch ms)
docker exec quorum-opensearch-1 curl -s \
  "http://localhost:9200/quorum-context/_search?size=100" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {"range": {"createdAt": {"gte": 1776824000000, "lte": 1776826500000}}},
    "_source": {"excludes": ["embedding", "embeddingText"]},
    "sort": [{"createdAt": "asc"}]
  }'

# Count carried items (everything created before session start)
docker exec quorum-opensearch-1 curl -s \
  "http://localhost:9200/quorum-context/_count" \
  -H "Content-Type: application/json" \
  -d '{"query": {"range": {"createdAt": {"lt": 1776824000000}}}}'
```

Always exclude `embedding` (1024-d float vector) and `embeddingText` (rendered search text) via `_source.excludes` — they bloat output and aren't needed for the report.

**Document shape.** Each hit's `_source` has: `key`, `scope` (`project`|`conversation`|`agent`), `id` (`_` for project, correlationId for conversation, agentId for agent), `value` (the stored JSON payload — may be a string or object), `createdBy` (agent role), `createdAt` (epoch ms), optional `expiresAt`. The document `_id` is `{scope}:{id}:{key}`.

To write the section:
1. **Separate carried vs new items** — the session-window range query (second recipe above) returns only new items; a `_count` with `createdAt < session_start` gives the carried total.
2. **Group new items by correlation ID and phase** — matches the invocation phases in the timeline. Agents typically write one item per phase boundary (task-breakdown, workflow-state, research, implementation, review-v1, review-fix, review-v2, project-notes).
3. **Show the JSON `value` payload** for each item (truncate long values with `...` for readability).
4. **Write an Analysis paragraph** — describe the audit trail (ticket → implementation → review), note any new patterns (e.g., first project-scope item), and highlight cross-agent context flow (e.g., developer consumed teamlead's ticket status, or an `agent`-scope research note that stayed private).

### Semantic Search Usage (post-QRM5)

Since QRM5, `context_query` supports `mode=search` (hybrid BM25 + k-NN over the `embeddingText`/`embedding` fields). Worth reporting per-session:
- Count of `mode=search` vs `mode=get-all` calls — grep `mcp-server-*.jsonl` for `context_query: scope=… mode=search`.
- Whether queries returned hits (zero-hit queries may indicate prompt drift or embedding gaps).
- Whether the embedding pipeline kept up (`EmbeddingPipelineService` logs should show `Embedded document […]` for each new item within ~90s).
- Whether any degraded-to-BM25 fallback was logged (Ollama unreachable).

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