# QRM2-001: Docker Agent Image — Toolchain & Hardening

## Summary

Rebuild the agent container image with all tools required for Claude Code operation (git, ripgrep, bash, curl) and harden containers against host exposure — non-root execution, dropped capabilities, read-only root filesystem, and no privilege escalation paths. This is infrastructure foundation: agents can't use Claude Code's built-in tools if the container doesn't have the binaries, and they shouldn't run as root when operating semi-autonomously.

## Problem Statement

The current `Dockerfile` uses `node:24-alpine` — a bare Node.js runtime with no development tools and musl libc (which can cause subtle incompatibilities with Claude Code's toolchain). Claude Code's built-in tools (`Bash`, `Grep`, `Glob`, `Edit`) depend on system binaries that don't exist in the image: `git` for version tracking, `ripgrep` (`rg`) for fast code search, `bash` for shell execution (Alpine ships `ash` by default), and `curl` for web fetches.

Additionally, QRM1 containers run as root with no capability restrictions. When agents gain autonomous code execution via Claude Code, an uncontained root process could modify the host filesystem, install arbitrary packages, or escalate privileges. Semi-autonomous operation demands defense-in-depth at the container level.

## Design Context

### Base Image Decision

Two viable paths:

| Option | Pros | Cons |
|--------|------|------|
| `node:24-alpine` + `apk add` | Smaller image (~200MB), current base | Alpine uses musl libc — some npm packages with native bindings may fail; ripgrep requires community repo |
| `node:24-bookworm-slim` + `apt-get` | glibc-based (better npm compat), ripgrep in official repos | Larger image (~350MB), different package manager |

**Recommendation:** Switch to `node:24-bookworm-slim`. Claude Code's built-in tools (Bash, Grep, Glob, Edit) are developed and tested against glibc-based Linux — musl libc differences in Alpine can cause subtle, hard-to-diagnose failures in ripgrep regex behavior, bash builtins, and any native npm bindings the SDK may pull in. The ~150MB image size increase is negligible compared to debugging musl-specific edge cases in a semi-autonomous agent runtime. Bookworm-slim also provides ripgrep and all required packages in official Debian repos without needing community/edge channels.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Agent image toolchain (git, ripgrep, bash, curl, jq) | MCP server image changes (doesn't run CC) |
| Non-root user creation, `USER` directive | AppArmor/seccomp custom profiles |
| `docker-compose.yml` security directives | Network policy enforcement (Kubernetes-level) |
| Volume permission setup (workspace, logs) | Secret management (env vars remain as-is) |
| tmpfs mounts for transient directories | Log rotation or external log collectors |
| `read_only` rootfs for agent containers | Terminal container hardening (user-facing, different threat model) |

## Implementation Details

### Dockerfile Changes

The Dockerfile needs a two-phase update. The builder stage stays the same. The runtime stage switches from bare node to a tooled, locked-down image.

**Runtime stage additions:**

```dockerfile
# Install CC runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash ripgrep curl jq openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1000 quorum && useradd -u 1000 -g quorum -s /bin/bash -m quorum

# Ensure writable directories exist
RUN mkdir -p /app/logs /tmp/.claude && chown -R quorum:quorum /app/logs /tmp/.claude

USER quorum
```

Key decisions:
- **bookworm-slim over alpine**: glibc-based runtime avoids musl libc edge cases with CC tools and native npm bindings. Bash ships by default — no separate install needed, but listed explicitly for clarity.
- **`--no-install-recommends`**: Keeps image lean by skipping suggested packages.
- **`ca-certificates`**: Required for HTTPS calls (Anthropic API, web fetches). Bookworm-slim doesn't always include them.
- **openssh-client**: Git operations over SSH (e.g., `git clone` from private repos) need an SSH client. Not strictly required for QRM2 workspace operations but prevents a common CC failure mode.
- **No sudo**: The `quorum` user has no privilege escalation path. `sudo` is not installed. CC cannot `apt-get install` at runtime.
- **UID 1000**: Conventional non-root UID. Matches typical host user for volume permission alignment.

### Docker Compose Security Directives

Add security configuration to agent services (architect, teamlead, developer). The MCP server and terminal have different threat models and don't need the same restrictions.

Per agent service:

```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
read_only: true
tmpfs:
  - /tmp:size=512m
  - /home/quorum/.claude:size=256m
```

- **`no-new-privileges`**: Prevents setuid/setgid binaries from granting elevated privileges. Essential when running untrusted code.
- **`cap_drop: ALL`**: Drops all Linux capabilities. The agent needs none — it reads/writes files and makes HTTP calls, which work without capabilities.
- **`read_only: true`**: Makes the root filesystem immutable. Combined with tmpfs mounts, this ensures CC can only write to designated locations (workspace, logs, tmp).
- **tmpfs mounts**: `/tmp` for general scratch, `/home/quorum/.claude` for CC's session cache and configuration.

### Volume Permissions

The workspace and logs volumes must be writable by the `quorum` user (UID 1000):

```yaml
volumes:
  - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace
  - ./logs:/app/logs
```

On the host side, ensure the directories are owned by UID 1000 or world-writable. Document this as a setup step in the smoke test runbook.

### Network Considerations

No changes to the existing `quorum-net` bridge network. Agents can reach:
- `mcp-server` (internal, by hostname) — required for MCP tool calls
- External internet (via Docker's default NAT) — required for CC's `WebSearch`/`WebFetch` and Anthropic API calls

Inter-agent direct connections don't exist in the architecture (all communication routes through MCP server), so no additional network isolation is needed at the Docker Compose level.

### MCP Server and Terminal Images

The MCP server and terminal don't run Claude Code — they stay on `node:24-alpine`. No CC toolchain is installed. However, both run as the non-root `quorum` user (UID 1000) as a baseline security measure — network-exposed services shouldn't run as root regardless of CC.

## Acceptance Criteria

- [x] Agent Dockerfile uses `node:24-bookworm-slim` base and installs `git`, `bash`, `ripgrep`, `curl`, `jq`, `openssh-client`, `ca-certificates`
- [x] Agent containers run as non-root `quorum` user (UID 1000)
- [x] `sudo` is not available inside agent containers
- [x] `docker-compose.yml` agent services include `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, `read_only: true`
- [x] tmpfs mounts configured for `/tmp` and Claude Code cache directories
- [x] Workspace volume (`/mnt/quorum/workspace`) is writable by `quorum` user
- [x] Logs volume (`/app/logs`) is writable by `quorum` user
- [x] MCP server and terminal images stay on `node:24-alpine`, no CC toolchain, but run as non-root `quorum` user
- [x] `docker compose build` completes successfully
- [x] `docker compose up` — all agents start, register with MCP server, health checks pass
- [x] Inside a running agent container: `git --version`, `rg --version`, `bash --version`, `curl --version` all succeed
- [x] Inside a running agent container: `whoami` returns `quorum`, `sudo` returns command not found

## Dependencies and References

### Prerequisites
- QRM1-011 — Docker containerization (current Dockerfile, docker-compose.yml)
- QRM1-012 — Smoke test runbook (verification patterns)

### What This Blocks
- QRM2-008 — E2E integration smoke test (needs hardened containers)

### References
- [Docker security best practices](https://docs.docker.com/engine/security/)
- [Debian Bookworm packages](https://packages.debian.org/bookworm/)
- Current `Dockerfile` at project root
- Current `docker-compose.yml` at project root

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-28

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `Dockerfile` | Modified | Converted from single runtime stage to multi-target build. Builder stage unchanged. New `default` target (`node:24-alpine`) for mcp-server/terminal — creates non-root `quorum` user (UID 1000) by deleting Alpine's default `node` user and recreating from scratch (Alpine lacks `groupmod`/`usermod`). New `agent` target (`node:24-bookworm-slim`) — installs CC toolchain (`git`, `bash`, `ripgrep`, `curl`, `jq`, `openssh-client`, `ca-certificates`) via `apt-get` with `--no-install-recommends`, renames existing `node` user to `quorum` in-place via `groupmod`/`usermod` (Bookworm ships shadow utils). Both targets set `USER quorum`, own all copied files via `--chown=quorum:quorum`. Agent target creates `/tmp/.claude` for CC session cache. |
| `docker-compose.yml` | Modified | Added `x-agent-security` YAML anchor with `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, `read_only: true`, and tmpfs mounts (`/tmp:size=512m`, `/home/quorum/.claude:size=256m`). Applied anchor to all three agent services (architect, teamlead, developer) via `<<: *agent-security`. Added `target: default` to mcp-server and terminal builds, `target: agent` to agent builds. Workspace volumes marked explicit `:rw` for clarity against `read_only` rootfs. |
| `tickets/QRM2-001-docker-agent-image.md` | Modified | Updated ticket spec to reflect Alpine → Bookworm-slim pivot: base image recommendation, package manager commands (`apk` → `apt-get`), user creation commands (`addgroup`/`adduser` → `groupadd`/`useradd`), key decisions rationale, acceptance criteria (added `ca-certificates`, non-root for mcp-server/terminal), and references. |

### Deviations from Ticket Spec

- **User creation strategy differs between targets.** The ticket spec shows `groupadd`/`useradd` (Debian commands) for user creation. The `default` (Alpine) target uses `deluser`/`delgroup` + `addgroup`/`adduser` instead, because Alpine's BusyBox userland doesn't ship `groupmod`/`usermod`. The `agent` (Bookworm) target renames the existing `node` user via `groupmod`/`usermod` rather than creating from scratch — fewer layers, same UID 1000 result. Inline comments explain the difference in each stage.

- **Workspace volume marked `:rw` explicitly.** Not in the original spec, but given `read_only: true` on agent containers, making the read-write intent explicit prevents confusion when reading the compose file.

### Verification

- `docker compose build` — all targets build successfully
- `docker compose up` — all services start, agents register with MCP server, health checks pass
- Agent container toolchain: `git 2.39.5`, `rg 13.0.0`, `bash 5.2.15`, `curl 7.88.1`, `jq 1.6`
- Agent container identity: `whoami` → `quorum`, `id` → `uid=1000(quorum) gid=1000(quorum)`, `sudo` → `not found`
