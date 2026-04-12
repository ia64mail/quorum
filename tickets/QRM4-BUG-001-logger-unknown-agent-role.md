# QRM4-BUG-001: Logger Outputs "unknown" Role for MCP Server and Terminal

## Summary

MCP server and terminal log files are named `unknown-*.jsonl` instead of `mcp-server-*.jsonl` and `terminal-*.jsonl`, and every JSON log line has `"agentRole": "unknown"`. This makes it difficult to distinguish MCP server logs from terminal logs when analyzing multi-agent sessions.

## Problem Statement

The `LoggerBuilder.fromEnv()` resolves the agent role via:

```
process.env.AGENT_ROLE || process.env.APP_NAME || 'unknown'
```

Agent containers set `AGENT_ROLE` in their `environment` block, so their logs are correctly labeled. However, the MCP server and terminal only pass `APP_NAME` as a Docker **build arg** — it is available at image build time but not injected into the runtime environment. At runtime, both `AGENT_ROLE` and `APP_NAME` are undefined, so the logger falls back to `'unknown'`.

**Affected files:**
- `logs/unknown-*.jsonl` — all MCP server and terminal log files across every session since QRM1-011

**Root cause:** `docker-compose.yml` sets `APP_NAME` under `build.args` but not under `environment` for the `mcp-server` and `terminal` services.

## Implementation Details

Add `APP_NAME` to the `environment` block of both services in `docker-compose.yml`:

- `mcp-server`: `APP_NAME: mcp-server`
- `terminal`: `APP_NAME: terminal`

The values must match what is already set under `build.args`. The logger code (`libs/common/src/logger/logger.builder.ts:212` and `libs/common/src/config/logger.config.ts:16`) requires no changes — it already reads `APP_NAME` as a fallback.

## Acceptance Criteria

- [x] `APP_NAME` is set in the `environment` block for both `mcp-server` and `terminal` in `docker-compose.yml`
- [x] After rebuild, MCP server logs are named `mcp-server-*.jsonl` with `"agentRole": "mcp-server"`
- [x] After rebuild, terminal logs are named `terminal-*.jsonl` with `"agentRole": "terminal"`
- [x] Agent container logs remain unaffected (`architect-*.jsonl`, `teamlead-*.jsonl`, `developer-*.jsonl`)

## Dependencies and References

- Discovered during [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md)
- `libs/common/src/logger/logger.builder.ts:205-212` — `fromEnv()` env var priority
- `libs/common/src/config/logger.config.ts:16` — config factory with same fallback
- QRM1-006 (Structured Logger) — original implementation
- QRM1-011 (Docker Containerization) — where `APP_NAME` was added as build arg only

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-28

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `docker-compose.yml` | Modified | Added `APP_NAME` to `environment` for `mcp-server` and `terminal` services |

### Verification

- [x] `./scripts/start.sh` — rebuilt, log filenames now `mcp-server-*.jsonl` and `terminal-*.jsonl`
- [x] JSON log content verified: `"agentRole":"mcp-server"` and `"agentRole":"terminal"`