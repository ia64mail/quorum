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

A complete session report requires **four** inputs:

| Source | What it provides | How to get it |
|--------|-----------------|---------------|
| **parse-logs.mjs digest** | Structured data: agent invocations, tool calls, costs, errors. **Includes moderator activity** — the adapter runs automatically (see below). | `node tools/session-report/parse-logs.mjs` |
| **Moderator CC CLI session log (raw)** | User prompts, moderator's text replies, MCP tool results, retry/re-register narration | Bind-mounted at `logs/moderator-sessions/` — auto-adapted by `parse-logs.mjs` |
| **OpenSearch `quorum-context` index** | Context Store items — full JSON payloads stored by agents during session | Query OpenSearch (QRM5-009 replaced the legacy `quorum.context` JSON dump). See "Context Store Dump" below for the curl recipe. |
| **User context** | Session goal, run number, known bugs to verify | User provides when requesting the report |

### Moderator Session Log (post-QRM7-005)

The moderator is Claude Code CLI running inside the `quorum-moderator-1` container. CC CLI writes one JSONL file per session under `/home/quorum/.claude/projects/<project-slug>/<sessionId>.jsonl`. A nested bind-mount in `docker-compose.yml` shadows the named volume's `projects/` subtree onto the host at `logs/moderator-sessions/`, so raw session files are directly accessible — no `docker exec` or alpine container needed.

**Automatic ingestion:** `parse-logs.mjs` auto-runs `cc-session-adapter.mjs` before parsing when `logs/moderator-sessions/` exists. The adapter reads CC CLI session JSONLs and emits `logs/moderator-{timestamp}.jsonl` files in QuorumLogger format, which the parser then ingests as first-class agent activity. Use `--no-adapter` to skip:

```bash
# Normal use — adapter runs automatically
node tools/session-report/parse-logs.mjs

# Skip adapter (e.g., if you already ran it manually)
node tools/session-report/parse-logs.mjs --no-adapter

# Run adapter standalone (debugging, incremental analysis)
node tools/session-report/cc-session-adapter.mjs
node tools/session-report/cc-session-adapter.mjs --dry-run
```

**Event mapping:** The adapter maps CC CLI event types to QuorumLogger contexts:

| CC CLI shape | Adapter context | Notes |
|---|---|---|
| `type: "user"` with string content or text-only blocks | `UserPrompt` | User's input to the moderator |
| `type: "user"` with `tool_result` content blocks | `ToolResult` | Tool execution results |
| `type: "assistant"` with text blocks | `ModeratorResponse` | Moderator's user-facing narration |
| `type: "assistant"` with `tool_use` blocks | `ToolCall` | Includes tool name and input |
| `type: "summary"` | `SessionSummary` | Session summary entries |
| `type: "elicitation"` | `Elicitation` | Agent-to-user clarification (when CC CLI logs these) |

Internal types (`queue-operation`, `ai-title`, `last-prompt`, `attachment`, `permission-mode`) are dropped silently. Thinking-only assistant messages are also dropped. Unrecognized types produce a `console.warn` and are skipped.

### Multiple moderator registrations are normal

Expect multiple `Registered agent: moderator` entries in the mcp-server log per run:

1. The legacy `apps/terminal/` app registers at startup (~`01:51:26` style timestamp). This is the dead-code shell; it just sits idle.
2. The CC CLI moderator registers when the user first attaches (`docker compose exec -it moderator claude` triggers `register_agent` per the systemPrompt enforcement in `docker/moderator/settings.json`).
3. Each subsequent `--continue`/re-attach triggers another `register_agent`. The moderator may also re-register mid-session if it detects MCP session loss (the moderator narrates "Session identity was lost. Let me re-register and retry.").

When you see two registrations close in time at session start, take the second one — that's the live CC CLI moderator. Re-registrations later in the run are signals worth investigating: they typically indicate transport instability (QRM5-BUG-003 / QRM6-BUG-007 pattern).

### CorrelationIds rotate via `new_conversation`

Per QRM6-005, the moderator calls `new_conversation` at the start of each user turn, minting a fresh `correlationId`. A single session can therefore have multiple `correlationId`s — one per turn. Group invocations by correlationId to see the work for one user prompt; an invocation with a brand-new correlationId near the end of the run usually marks a fresh turn (or a re-attach after a session loss).

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

### Context Search Trace Stream (post-QRM7-016)

A dedicated JSONL stream at `logs/context-search-{startupTimestamp}.jsonl` captures full detail for every `context_query mode=search` invocation. Each record includes the verbatim query, engine choice (`hybrid`/`bm25-only`/`memory`), per-hit scores and snippets, token-budget truncation flag, timing, and error surface. The main MCP log retains a single-line breadcrumb with `queryId` linking to the detailed record.

This stream is **not** consumed by `parse-logs.mjs` today. For ad-hoc search quality analysis:

```bash
# Score distribution
jq -c '.extra.results[] | {score, key}' logs/context-search-*.jsonl

# BM25-only fallbacks (embedding service degraded)
jq -c 'select(.extra.engine == "bm25-only") | {queryId: .extra.queryId, query: .extra.queryText}' logs/context-search-*.jsonl

# Token-budget truncations
jq -c 'select(.extra.truncatedByTokenBudget == true) | {queryId: .extra.queryId, raw: .extra.hitCountRaw, returned: .extra.hitCountReturned}' logs/context-search-*.jsonl
```

### Tips for Claude Code
- The **Goal** and **User Prompt** are now first-class entries in the digest as `UserPrompt` and `ModeratorResponse` contexts — the adapter extracts them automatically from the CC CLI session log
- Correlation IDs group related invocations within a single user turn; expect a new correlationId per turn (`new_conversation` rotates it)
- A second invocation with the **same** correlationId, target, and prompt body is a retry. Inspect the moderator log around that timestamp — a "Session identity was lost" narration confirms an MCP transport drop; otherwise look for the agent's first response failing to render in the moderator transcript
- Cost data comes from agent-side `InvocationHandler` logs; the digest extracts it automatically. Note: `parse-logs.mjs` keys agent-activity entries by `correlationId:role:startTime`, so two invocations with the same correlationId+role surface as separate rows but the second row's "reportedTurns/cost" can race the parser — cross-check with the agent JSONL directly for retries
- The workspace is at `AGENT_WORKSPACE_DIR` (typically `/mnt/quorum/workspace`, defaulted to the host repo via `WORKSPACE_PATH=.`); commits land in the host repo
- Agent-side commits referenced in moderator narration (e.g. `commit 13fce4e`) may not be reachable from the current `HEAD` if the agent worked on a different branch — `git fsck --lost-found` and the reflog can help locate them

## Log Format Reference

All logs are JSONL with fields: `timestamp`, `level`, `context`, `message`, `agentRole`.

**Key contexts by source:**

| Source | Context | Signals |
|--------|---------|---------|
| mcp-server | `AgentRegistry` | register/unregister |
| mcp-server | `McpService` | `invoke_agent: caller → target` |
| mcp-server | `MessageBroker` | `Invoke:` (start), `Completed:` (end + success) |
| mcp-server | `InMemoryStore` | context load/save counts |
| mcp-server (trace) | `ContextSearchTrace` | per-search detail: query, engine, scores, truncation (separate stream: `context-search-*.jsonl`) |
| agent | `InvocationHandler` | `Invocation received:`, `Invocation complete:` (cost, turns, duration), `Invocation failed:` |
| agent | `ClaudeCodeService` | `Session started:`, `SDK response:`, `SDK tool start/done/failed:`, `SDK reasoning:` |
| agent | `McpClientService` | connection, registration, tool discovery |