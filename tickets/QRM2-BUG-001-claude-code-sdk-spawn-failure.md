# QRM2-BUG-001: Claude Code SDK Spawn Failure in Agent Containers

**Status: Resolved**

## Summary

Agent containers fail to execute Claude Code SDK invocations. Three independent bugs prevent the SDK from spawning its CLI subprocess: (1) the `env` option replaces the entire process environment, stripping `PATH`; (2) the SDK's debug logger crashes Node when `/home/quorum/.claude/debug/` doesn't exist under the tmpfs mount; (3) the tmpfs mounts are owned by root, so the `quorum` user cannot create directories.

## Problem Statement

After the QRM2-006 migration of `InvocationHandler` to `ClaudeCodeService.execute()`, all agent invocations fail immediately with:

```
[InvocationHandler] Invocation failed: correlationId=fe6260ad-... error="Claude Code executable not found at /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js. Is options.pathToClaudeCodeExecutable set?" cost=$0.0000 duration=8ms
```

Followed by an unhandled exception that crashes the container:

```
Error: ENOENT: no such file or directory, open '/home/quorum/.claude/debug/448cae8a-...txt'
    at Object.writeFileSync (node:fs:2413:20)
    at Module.appendFileSync (file:///app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:17:7570)
    at Timeout.z [as _onTimeout] (file:///app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:17:12176)
```

Even after addressing root causes 1 and 2, containers crash at startup:

```
mkdir: cannot create directory '/home/quorum/.claude/debug': Permission denied
```

This is a **blocking bug** — no agent can process any invocation. The moderator receives error responses for every delegated task.

### Root Cause 1: `env` option strips `PATH`

`ClaudeCodeService.execute()` passes a minimal env object to the SDK:

```typescript
// apps/agent/src/llm/claude-code.service.ts:41
env: { ANTHROPIC_API_KEY: this.config.anthropic.apiKey },
```

The SDK destructures this with a default: `env:B={...process.env}`. When `env` is provided, the default is not applied — the SDK uses the caller's object verbatim as the child process environment. With only `ANTHROPIC_API_KEY` present, there is no `PATH`, so `spawn("node", [...])` fails with `ENOENT` (the OS cannot locate the `node` binary).

The error handler interprets this ENOENT as "cli.js not found" because it cannot distinguish between the executable and the script being missing.

### Root Cause 2: Missing debug directory on tmpfs

The SDK writes debug logs to `~/.claude/debug/` via a `Timeout` callback using `appendFileSync`. The Dockerfile creates a tmpfs at `/home/quorum/.claude` but never creates the `debug/` subdirectory. When the SDK's debug timer fires, `appendFileSync` throws ENOENT (missing parent directory), and since the throw occurs inside a `Timeout` callback, it becomes an unhandled exception that crashes Node.

### Root Cause 3: tmpfs mounts owned by root

Docker tmpfs mounts default to `root:root` ownership. The agent container runs as `quorum` (uid 1000), so the startup CMD `mkdir -p /home/quorum/.claude/debug` fails with `Permission denied` because the tmpfs at `/home/quorum/.claude` is not writable by the `quorum` user.

## Design Context

The `env` passthrough was intentionally minimal — QRM2-002 designed `ClaudeCodeService` to explicitly control which environment variables reach the SDK subprocess for security isolation. The oversight was not accounting for system-level variables (`PATH`, `HOME`, `NODE_ENV`, etc.) that the child process needs to function.

The debug directory issue is a gap between QRM2-001's container hardening (tmpfs mounts, read-only rootfs) and the SDK's runtime expectations. The SDK assumes `~/.claude/` is a persistent, fully populated directory structure.

The tmpfs ownership issue is a Docker default — tmpfs mounts are root-owned unless `uid`/`gid` options are specified.

## Implementation Details

### Fix 1: Spread `process.env` in SDK options

| File | Change |
|------|--------|
| `apps/agent/src/llm/claude-code.service.ts` | Change `env` to spread `process.env` and override `ANTHROPIC_API_KEY` |

```typescript
// Before
env: { ANTHROPIC_API_KEY: this.config.anthropic.apiKey },

// After
env: { ...process.env, ANTHROPIC_API_KEY: this.config.anthropic.apiKey },
```

This preserves `PATH`, `HOME`, `NODE_ENV`, and other system variables while ensuring the API key is always set from config (overriding any inherited value).

### Fix 2: Create debug directory at container startup

| File | Change |
|------|--------|
| `Dockerfile` | Add `/home/quorum/.claude/debug` to the `RUN mkdir` chain; change agent `CMD` to create the debug directory at startup |

```dockerfile
# Image layer (fallback if tmpfs removed)
RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude/debug \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude

# Startup (required because tmpfs overlays the image layer, starting empty)
CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]
```

The tmpfs mount at `/home/quorum/.claude` overlays the image layer at runtime, so the `RUN mkdir` only matters if the tmpfs is removed. The `CMD` wrapper creates the directory on every boot before starting the app.

### Fix 3: Set tmpfs ownership to `quorum` user

| File | Change |
|------|--------|
| `docker-compose.yml` | Add `uid=1000,gid=1000` to tmpfs mount options |

```yaml
# Before
tmpfs:
  - /tmp:size=512m
  - /home/quorum/.claude:size=256m

# After
tmpfs:
  - /tmp:size=512m,uid=1000,gid=1000
  - /home/quorum/.claude:size=256m,uid=1000,gid=1000
```

This ensures the `quorum` user (uid/gid 1000) owns the tmpfs mounts and can create subdirectories at startup.

### Test update

| File | Change |
|------|--------|
| `apps/agent/src/llm/claude-code.service.spec.ts` | Update `env` assertion from exact match to `objectContaining` + `PATH` check |

The test previously asserted `env` was exactly `{ ANTHROPIC_API_KEY: 'sk-ant-test-key' }`. Updated to verify the API key is present and `process.env` keys (e.g. `PATH`) are inherited.

## Acceptance Criteria

- [x] `ClaudeCodeService.execute()` passes full `process.env` (with API key override) to the SDK
- [x] Agent containers create `/home/quorum/.claude/debug/` at startup
- [x] tmpfs mounts are owned by `quorum` user (uid 1000)
- [x] No ENOENT or Permission denied errors at container startup
- [x] `npm run test` passes with no regressions (382/382)
- [ ] `docker compose up` with all agents running — invoke an agent via terminal and receive a valid response *(blocked by QRM2-BUG-002)*

## Dependencies and References

### Prerequisites
- QRM2-002 — Claude Code SDK Service Layer (introduced `ClaudeCodeService`)
- QRM2-006 — InvocationHandler Migration (switched to SDK-based invocations)
- QRM2-001 — Docker Agent Image hardening (introduced tmpfs mounts, read-only rootfs)

### What This Blocks
- QRM2-BUG-002 — SDK subprocess silent failure (discovered during BUG-001 verification)
- QRM2-007 — Prompt Adaptation (cannot test prompt changes without working invocations)
- QRM2-009 — E2E Integration Smoke Test

### References
- [tickets/QRM2-002-claude-code-sdk-service-layer.md](QRM2-002-claude-code-sdk-service-layer.md) — SDK service design
- [tickets/QRM2-001-docker-agent-image.md](QRM2-001-docker-agent-image.md) — Container hardening decisions
- Claude Agent SDK source: `sdk.mjs` spawn logic and debug logger