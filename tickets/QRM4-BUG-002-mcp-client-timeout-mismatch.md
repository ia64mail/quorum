# QRM4-BUG-002: MCP Client Timeout Mismatch Causes Duplicate Agent Invocations

## Summary

The terminal app's MCP client uses a default ~60-second request timeout for `invoke_agent` tool calls, while the Message Broker's role-based timeouts are much longer (teamlead: 10min, developer: 30min). The MCP SDK transport layer times out the request before the broker timeout fires, causing the moderator to retry and spawn duplicate concurrent agent sessions.

## Problem Statement

When the moderator invokes an agent via `invoke_agent`, the call flows through the MCP client's Streamable HTTP transport. This transport has a ~60-second default request timeout at the HTTP level. The broker's role-based timeouts (`ROLE_TIMEOUTS` in `message-broker.service.ts`) are configured for realistic agent work durations:

| Role | Broker Timeout |
|------|---------------|
| architect | 5 min |
| teamlead | 10 min |
| developer | 30 min |
| qa | 15 min |
| productowner | 2 min |

The mismatch means any invocation exceeding ~60 seconds triggers an MCP-level timeout error (`-32001: Request timed out`) at the terminal, while the original invocation continues running on the broker side. The moderator interprets this as a failure and retries, spawning a second concurrent session for the same agent on the shared workspace.

**Observed impact (QRM4 kick-off session, 2026-03-28):**
- Teamlead: timed out at 60s (01:51:39), retried → two concurrent sessions ($1.10 combined, 2nd found ticket already written by 1st)
- Developer: timed out at 60s (01:53:40), retried → two concurrent sessions operating on same working tree
- ~$1.10 in wasted API costs from duplicate sessions
- Risk of file corruption if concurrent sessions write conflicting changes (avoided by luck in this session — edits were identical)

**Root cause:** The MCP client in `apps/terminal/src/connection/mcp-client.service.ts:76` instantiates `StreamableHTTPClientTransport` without specifying a request timeout:

```typescript
this.transport = new StreamableHTTPClientTransport(new URL(serverUrl));
```

The SDK's default timeout (~60s) applies, which is far too short for agent invocations.

## Design Context

The terminal's MCP client timeout must be at least as long as the broker's longest role timeout (currently developer at 30 min) to prevent the transport layer from timing out before the broker does. The broker's own timeout is the authoritative deadline — the client should defer to it rather than racing against it.

The agent app's MCP client (`apps/agent/src/connection/mcp-client.service.ts:88`) has the same issue but is lower priority — agent-to-agent calls are typically shorter. Still, both should be fixed for consistency.

## Implementation Details

Add an `MCP_REQUEST_TIMEOUT_MS` env var (default: `1800000` = 30 min) to both the terminal and agent config. The `StreamableHTTPClientTransport` constructor accepts `StreamableHTTPClientTransportOptions` which includes `requestInit?: RequestInit` — use `AbortSignal.timeout()` to set a request timeout derived from the env var.

Since `invoke_agent` is the only long-running tool the moderator calls, a generous global timeout is acceptable — the broker's per-role timeouts remain the precise enforcement layer. Short-duration operations (`register_agent`, `context_query`, etc.) complete well within the budget and are unaffected.

### Terminal MCP client (`apps/terminal/src/connection/mcp-client.service.ts`)

```typescript
this.transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  requestInit: {
    signal: AbortSignal.timeout(config.mcpRequestTimeoutMs),
  },
});
```

### Agent MCP client (`apps/agent/src/connection/mcp-client.service.ts`)

Same pattern — apply for consistency. Agent-to-agent calls are typically shorter, but the broker's role-based timeouts remain the authoritative deadline regardless.

### Configuration

Add `MCP_REQUEST_TIMEOUT_MS` to the existing MCP config factory in each app, validated with Zod:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_REQUEST_TIMEOUT_MS` | `1800000` (30 min) | HTTP-level request timeout for MCP client transport |

Wire the env var in `docker-compose.yml` under `x-shared-env` so all services (terminal + agents) inherit it.

### Config injection

Both `McpClientService` classes already inject their app's config service. Add `mcpRequestTimeoutMs` to the existing config and read it during transport instantiation.

### Note on duplicate invocation prevention

Fixing the timeout mismatch eliminates the primary trigger for duplicate invocations, but retries from genuine transport errors remain unguarded. Tracked in [ICEBOX #1](ICEBOX.md#1-duplicate-invocation-prevention-message-broker).

## Acceptance Criteria

- [ ] Terminal MCP client (`apps/terminal/src/connection/mcp-client.service.ts`) configures a request timeout that exceeds the broker's longest role timeout (currently 30 min for developer)
- [ ] Timeout is configurable via environment variable (`MCP_REQUEST_TIMEOUT_MS` or similar)
- [ ] Agent MCP client (`apps/agent/src/connection/mcp-client.service.ts`) applies the same timeout configuration
- [ ] `docker-compose.yml` sets the timeout env var for terminal and all agent services
- [ ] Invocations that run longer than 60 seconds no longer produce `-32001` timeout errors at the client
- [ ] Existing short-duration MCP operations (register, context_query, etc.) are unaffected

## Dependencies and References

- Discovered during [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md) — Issues #1 and #5
- `apps/terminal/src/connection/mcp-client.service.ts:76` — terminal transport instantiation (no timeout)
- `apps/agent/src/connection/mcp-client.service.ts:88` — agent transport instantiation (no timeout)
- `apps/mcp-server/src/messaging/message-broker.service.ts:61-62` — broker role-based timeout resolution
- `libs/common/src/messaging/invoke.types.ts` — `ROLE_TIMEOUTS` constants
- MCP SDK `StreamableHTTPClientTransport` — accepts `requestInit` in options