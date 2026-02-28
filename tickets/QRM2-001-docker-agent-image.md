# QRM2-001: Docker Agent Image — Toolchain & Hardening

## Summary

Rebuild the agent container image with all tools required for Claude Code operation (git, ripgrep, bash, curl) and harden containers against host exposure — non-root execution, dropped capabilities, read-only root filesystem, and no privilege escalation paths. This is infrastructure foundation: agents can't use Claude Code's built-in tools if the container doesn't have the binaries, and they shouldn't run as root when operating semi-autonomously.

## Problem Statement

The current `Dockerfile` uses `node:24-alpine` — a bare Node.js runtime with no development tools. Claude Code's built-in tools (`Bash`, `Grep`, `Glob`, `Edit`) depend on system binaries that don't exist in the image: `git` for version tracking, `ripgrep` (`rg`) for fast code search, `bash` for shell execution (Alpine ships `ash` by default), and `curl` for web fetches.

Additionally, QRM1 containers run as root with no capability restrictions. When agents gain autonomous code execution via Claude Code, an uncontained root process could modify the host filesystem, install arbitrary packages, or escalate privileges. Semi-autonomous operation demands defense-in-depth at the container level.

## Design Context

### Base Image Decision

Two viable paths:

| Option | Pros | Cons |
|--------|------|------|
| `node:24-alpine` + `apk add` | Smaller image (~200MB), current base | Alpine uses musl libc — some npm packages with native bindings may fail; ripgrep requires community repo |
| `node:24-bookworm-slim` + `apt-get` | glibc-based (better npm compat), ripgrep in official repos | Larger image (~350MB), different package manager |

**Recommendation:** Stay with `node:24-alpine` and install packages via `apk`. The agent image doesn't have native binary dependencies that would break on musl, and the smaller image size benefits the multi-container deployment. If compatibility issues surface during QRM2-002 testing, fall back to `bookworm-slim`.

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
RUN apk add --no-cache git bash ripgrep curl jq openssh-client

# Create non-root user
RUN addgroup -g 1000 quorum && adduser -u 1000 -G quorum -s /bin/bash -D quorum

# Ensure writable directories exist
RUN mkdir -p /app/logs /tmp/.claude && chown -R quorum:quorum /app/logs /tmp/.claude

USER quorum
```

Key decisions:
- **bash over ash**: Claude Code's Bash tool expects `/bin/bash`. Alpine's default `ash` has incompatible syntax for some CC-generated commands.
- **openssh-client**: Git operations over SSH (e.g., `git clone` from private repos) need an SSH client. Not strictly required for QRM2 workspace operations but prevents a common CC failure mode.
- **No sudo**: The `quorum` user has no privilege escalation path. `sudo` is not installed. CC cannot `apt-get install` or `apk add` at runtime.
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

The MCP server doesn't run Claude Code — it stays on the current slim image. No security hardening beyond what exists.

The terminal is user-facing and interactive — hardening it would interfere with stdin/stdout. Keep current configuration. Revisit in QRM2-007 if terminal migrates to CC SDK.

## Acceptance Criteria

- [ ] Agent Dockerfile installs `git`, `bash`, `ripgrep`, `curl`, `jq`, `openssh-client`
- [ ] Agent containers run as non-root `quorum` user (UID 1000)
- [ ] `sudo` is not available inside agent containers
- [ ] `docker-compose.yml` agent services include `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, `read_only: true`
- [ ] tmpfs mounts configured for `/tmp` and Claude Code cache directories
- [ ] Workspace volume (`/mnt/quorum/workspace`) is writable by `quorum` user
- [ ] Logs volume (`/app/logs`) is writable by `quorum` user
- [ ] MCP server image remains unchanged (no CC toolchain, no hardening changes)
- [ ] `docker compose build` completes successfully
- [ ] `docker compose up` — all agents start, register with MCP server, health checks pass
- [ ] Inside a running agent container: `git --version`, `rg --version`, `bash --version`, `curl --version` all succeed
- [ ] Inside a running agent container: `whoami` returns `quorum`, `sudo` returns command not found

## Dependencies and References

### Prerequisites
- QRM1-011 — Docker containerization (current Dockerfile, docker-compose.yml)
- QRM1-012 — Smoke test runbook (verification patterns)

### What This Blocks
- QRM2-008 — E2E integration smoke test (needs hardened containers)

### References
- [Docker security best practices](https://docs.docker.com/engine/security/)
- [Alpine package index](https://pkgs.alpinelinux.org/packages)
- Current `Dockerfile` at project root
- Current `docker-compose.yml` at project root
