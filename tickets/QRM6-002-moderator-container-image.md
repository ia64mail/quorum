# QRM6-002: Moderator Container Image & Compose Service

## Summary

Add a `moderator` build target to the Dockerfile and a `moderator` service to `docker-compose.yml`, creating the Docker infrastructure for running the moderator as a containerized Claude Code CLI instance. The container installs CC CLI globally, bakes MCP connection config and D7 tool restrictions into `~/.claude/settings.json`, and runs with an exec-attach lifecycle (`docker compose up -d` starts, `docker compose exec -it moderator claude` attaches).

## Problem Statement

The moderator currently runs as a custom NestJS terminal app (`apps/terminal/`), separate from the Docker-containerized agents. QRM6 replaces this with a Claude Code CLI moderator running in its own container — but that container doesn't exist yet.

**Current state:** The Dockerfile has two runtime targets: `default` (alpine, for mcp-server/terminal) and `agent` (bookworm-slim, with git/bash/ripgrep toolchain + NestJS app). Neither installs CC CLI or configures it as an MCP client. There is no moderator-specific service in `docker-compose.yml`.

**What this ticket creates:** The third Dockerfile target (`moderator`) and its Compose service — the foundational infrastructure that QRM6-003 through QRM6-010 build on. Without this, there is no container to test elicitation routing, caller identity injection, or the CLAUDE.md prompt migration against.

**Risks of deferral:** Every downstream QRM6 ticket needs a running moderator container for integration testing. Delaying this blocks the entire parallel track.

## Design Context

This ticket implements three roadmap design decisions:

- **D2 (Exec-Attach Lifecycle):** `docker compose up -d` starts all services including the moderator. The moderator container stays running (idle). The user attaches via `docker compose exec -it moderator claude`, which launches CC CLI interactively inside the already-running container. Detaching leaves the container alive for reattach.

- **D7 (Deny Write by Default):** The moderator's role boundary ("delegate, do not implement") becomes mechanically enforced. CC CLI launches with `Write`, `Edit`, and `NotebookEdit` denied in the baked `settings.json`. Read, Grep, Glob, Bash (with role-appropriate restrictions), and MCP tools remain available. Users who want a "power moderator" can override settings at runtime.

- **D9 (Third Build Target):** The `moderator` target sits alongside `default` and `agent` in the unified Dockerfile. It shares the agent's base image (`node:24-bookworm-slim`) and toolchain (git, bash, ripgrep, curl, jq) because CC CLI's filesystem tools need them. Unlike the agent target, it does **not** copy a NestJS app build — it installs `@anthropic-ai/claude-code` globally via npm instead.

### Key Differences from Agent Target

| Aspect | Agent target | Moderator target |
|--------|-------------|-----------------|
| Application | NestJS app (`dist/main.js`) from builder stage | CC CLI installed globally (`npm i -g @anthropic-ai/claude-code`) |
| Entry point | `node dist/main.js` | `tail -f /dev/null` (idle; user attaches via `exec`) |
| MCP role | Server (exposes `POST /invoke` callback) | Client (connects to `http://mcp-server:3000/mcp`) |
| Settings | No `settings.json` needed | Baked `settings.json` with MCP config + tool restrictions |
| Interaction | Non-interactive; invoked by broker | Interactive; user attaches via TTY |

## Implementation Details

### 1. Dockerfile — `moderator` Target

Add a new stage after the existing `agent` stage. The moderator target does **not** depend on the `builder` stage — there is no NestJS app to build.

```dockerfile
FROM node:24-bookworm-slim AS moderator
```

**System packages:** Same as agent — `git bash ripgrep curl jq openssh-client ca-certificates`. The moderator needs these because CC CLI's built-in tools (Bash, Grep, Glob) shell out to them.

**User setup:** Same `quorum` user pattern as the agent target — `groupmod`/`usermod` to rename the `node` user with `HOST_UID`/`HOST_GID` build args. This ensures volume-mounted files have correct ownership.

**CC CLI installation:** Install `@anthropic-ai/claude-code` globally via npm. Pin the version explicitly (use the version from QRM6-001 spike findings: 2.1.117 or the latest stable at implementation time). Global install puts the `claude` binary on `PATH`.

**Directory structure:**

```
/home/quorum/.claude/           # CC CLI config + session history
/home/quorum/.claude/settings.json  # MCP config + tool restrictions (baked)
/mnt/quorum/workspace/          # Workspace mount point
/mnt/quorum/workspace/.claude/  # Project-level CC CLI config
```

Create and chown these directories for the `quorum` user. The pattern mirrors the agent target's directory setup at Dockerfile lines 60–64.

**Baked settings.json:** Copy a `docker/moderator/settings.json` file into `/home/quorum/.claude/settings.json` during the build. This file configures:

1. **MCP server connection** — The moderator connects to the Quorum MCP server as a client. The `mcpServers` key in settings.json configures this (CC CLI reads it at startup):

    ```json
    {
      "mcpServers": {
        "quorum": {
          "type": "url",
          "url": "http://mcp-server:3000/mcp"
        }
      }
    }
    ```

    The exact `url` value must match the MCP server's Streamable HTTP endpoint. The URL uses the Docker Compose service name `mcp-server` which resolves via the `quorum-net` network.

2. **Tool restrictions (D7)** — Deny write tools by default:

    ```json
    {
      "permissions": {
        "deny": ["Write", "Edit", "NotebookEdit"]
      }
    }
    ```

    The exact key/structure for tool restrictions depends on the CC CLI settings schema — the developer should verify against CC CLI 2.1.117's settings format. The intent is that the moderator can read, grep, glob, and run restricted bash commands, but cannot write or edit files.

**Note on MCP URL:** The URL may need to be injected at runtime rather than baked at build time, since the MCP server hostname could vary. Consider using an entrypoint script that substitutes `MCP_SERVER_URL` into the settings file on container start. However, if the Docker Compose network name is stable (`mcp-server`), a baked URL is simpler and preferred.

**CMD:** The container needs to stay running so the user can `exec` into it. Use `tail -f /dev/null` or `sleep infinity` as the idle command. The user's `docker compose exec -it moderator claude` then launches CC CLI as a separate process inside the running container.

### 2. Docker Compose — `moderator` Service

Add a `moderator` service to `docker-compose.yml`. Pattern follows the existing agent services but with key differences.

**Build configuration:**

```yaml
moderator:
  build:
    context: .
    dockerfile: Dockerfile
    target: moderator
    args:
      HOST_UID: ${HOST_UID:-1000}
      HOST_GID: ${HOST_GID:-1000}
```

Note: No `APP_NAME` build arg — the moderator target doesn't use the builder stage.

**TTY and stdin:** Required for `docker compose exec -it` to work:

```yaml
  stdin_open: true
  tty: true
```

**Dependencies:** Wait for the MCP server to be healthy before starting:

```yaml
  depends_on:
    mcp-server:
      condition: service_healthy
```

**Environment variables:** Use the `*shared-env` anchor for `ANTHROPIC_API_KEY` and common vars. Override `ANTHROPIC_MODEL` to default to `claude-sonnet-4-5-20250929` (or whichever model the roadmap specifies — the roadmap mentions `claude-opus-4-7` but defer to the shared env default unless the architect specifies otherwise). Add moderator-specific vars as needed.

**Volumes:**

- `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` — workspace mount, read-write (moderator needs read for inspection; write permission is present but tool-level restrictions from D7 prevent actual file writes via CC CLI)
- `./logs:/app/logs` — shared log volume
- A volume or bind-mount for `/home/quorum/.claude` to persist CC CLI session history across container restarts. Options:
  - Named volume: `moderator-claude-data:/home/quorum/.claude` — simple, Docker-managed
  - Bind-mount: `./data/moderator-claude:/home/quorum/.claude` — visible on host, easier to inspect
  - The named volume approach is cleaner; add it to the `volumes:` top-level section

**Security settings:** Apply the `*agent-security` anchor (read-only rootfs, no-new-privileges, cap_drop ALL, tmpfs mounts). The moderator has the same security posture as agents. However, verify that the read-only rootfs doesn't interfere with CC CLI's runtime needs — CC CLI may write to paths not covered by the tmpfs mounts. If it does, either add additional tmpfs entries or relax `read_only` for the moderator (document the deviation).

**Important consideration on read_only rootfs + baked settings.json:** The agent target uses `read_only: true` with tmpfs for `/home/quorum/.claude`. The moderator bakes `settings.json` into `/home/quorum/.claude/` at build time — but if `read_only: true` is active, that directory is overlaid by a tmpfs and the baked file disappears at runtime. Two approaches:
- Bake settings.json into a different build-time path (e.g., `/etc/claude/settings.json`) and copy it into the tmpfs via an entrypoint script
- Use `read_only: true` but mount settings.json as a bind-mount from a `docker/moderator/` directory

The developer should evaluate which approach is cleanest. The entrypoint script approach is recommended because it also solves the MCP URL runtime substitution need.

**Network:**

```yaml
  networks:
    - quorum-net
```

### 3. `docker/moderator/` Configuration Directory

Create `docker/moderator/settings.json` (the source file baked into the image or copied at runtime). This file is the single source of truth for the moderator's CC CLI configuration.

Content as described in Section 1 above — MCP server connection + tool restrictions.

### 4. Entrypoint Script

Create `docker/moderator/entrypoint.sh` — a lightweight shell script that:

1. Copies the baked settings.json template into the writable `/home/quorum/.claude/` directory (which is tmpfs when `read_only: true`)
2. Substitutes `${MCP_SERVER_URL}` in the settings file if the env var is set (allows runtime override of the MCP server URL)
3. Execs the idle command (`exec tail -f /dev/null` or `exec sleep infinity`)

This solves both the read-only rootfs issue and the runtime URL substitution need.

### 5. `scripts/moderator.sh` — Convenience Wrapper

Create a shell script that wraps the `docker compose exec` command:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec docker compose exec -it moderator claude "$@"
```

This lets users type `./scripts/moderator.sh` instead of `docker compose exec -it moderator claude`. Pass through any additional args (e.g., `--resume` for session resume).

### 6. Verification Steps

The developer should verify the following before marking implementation complete:

1. `docker compose build moderator` succeeds — image builds without errors
2. `docker compose up -d` starts the moderator container alongside mcp-server and agents
3. `docker compose exec -it moderator claude --version` prints the CC CLI version
4. `docker compose exec -it moderator claude` launches CC CLI interactively
5. CC CLI discovers the Quorum MCP server tools (verify via `/mcp` or tool listing)
6. CC CLI denies Write/Edit operations per D7 restrictions
7. The container stays running after the user detaches (Ctrl+C or detach)
8. `./scripts/moderator.sh` launches the session correctly

**Note:** Full MCP integration (elicitation routing, caller identity) is QRM6-003/004 scope. This ticket only needs to verify that the container runs, CC CLI starts, and the MCP connection is established.

## Acceptance Criteria

- [x] Dockerfile contains a `moderator` target based on `node:24-bookworm-slim` with CC CLI installed globally
- [x] `docker/moderator/settings.json` exists with MCP server connection config and D7 tool restrictions (deny Write, Edit, NotebookEdit)
- [x] `docker-compose.yml` defines a `moderator` service with correct build target, depends_on, volumes, networking, and `stdin_open`/`tty`
- [x] Moderator service applies the `agent-security` anchor (or documents why a deviation is needed)
- [x] `docker compose build moderator` completes successfully
- [x] `docker compose up -d` starts the moderator container; it remains running (idle) until a user attaches
- [x] `docker compose exec -it moderator claude --version` returns the installed CC CLI version
- [x] CC CLI launched via `docker compose exec -it moderator claude` connects to the Quorum MCP server and lists its tools
- [x] Write/Edit/NotebookEdit tools are denied by default in the CC CLI session
- [x] `scripts/moderator.sh` convenience wrapper exists and launches the moderator session
- [x] Container stays running after the user detaches from the exec session
- [x] No changes to `apps/terminal/` — the existing terminal service remains untouched (deletion is QRM6-009)
- [x] `npm run build` and `npm run lint` pass (no regressions from Dockerfile/compose changes)

## Implementation Notes

**Status:** Accepted (re-review after fix)

**Implementation commits:**
- `f9710f2` — Initial implementation (6 deliverables)
- `b9ac714` — Fix: added `.claude.json` symlink to moderator Dockerfile target

**Files modified:**
- `Dockerfile` — Added `moderator` target (lines 76–108): `node:24-bookworm-slim` base, system packages matching agent, `quorum` user via `groupmod`/`usermod` with `HOST_UID`/`HOST_GID`, CC CLI 2.1.117 pinned via `npm install -g`, settings template baked to `/etc/claude/settings.json`, entrypoint at `/usr/local/bin/entrypoint.sh`, `.claude.json` symlink to `/tmp/` for read-only rootfs compatibility
- `docker-compose.yml` — Added `moderator` service (lines 147–169): build target `moderator`, `agent-security` anchor, `stdin_open`/`tty` for exec-attach, `depends_on` mcp-server healthy, `MCP_SERVER_URL` env var, named volume `moderator-claude-data` for `/home/quorum/.claude` persistence, workspace+logs volumes, `quorum-net` network
- `docker/moderator/settings.json` — MCP server connection config (`__MCP_SERVER_URL__` placeholder) + D7 tool deny list (`Write`, `Edit`, `NotebookEdit`)
- `docker/moderator/entrypoint.sh` — Copies baked settings to tmpfs, substitutes `MCP_SERVER_URL` at runtime (default `http://mcp-server:3000/mcp`), execs `tail -f /dev/null`
- `scripts/moderator.sh` — Convenience wrapper: `exec docker compose exec -it moderator claude "$@"`
- `.dockerignore` — Added `!docker/moderator/**` exception

**Deviations from ticket:** None. Implementation follows all six deliverables as specified.

**Review history:**
- v1: Declined — missing `.claude.json` symlink in moderator Dockerfile target (agent target has `ln -s /tmp/.claude.json /home/quorum/.claude.json` at line 64; moderator omitted it, risking EROFS on read-only rootfs)
- v2 (re-review): Accepted — symlink added at Dockerfile line 99, matching agent target pattern exactly

**Verification results:** `npm run build` ✅, `npm run lint` ✅, `npm run test` ✅ (760 tests, 49 suites)

## Dependencies and References

- **Depends on:** QRM6-001 (elicitation spike — GO verdict confirmed)
- **Blocks:** QRM6-003 (elicitation connection needs a running moderator container for integration testing), QRM6-009 (terminal deletion replaces terminal service with moderator service)
- **Parallel with:** QRM6-003 (elicitation connection), QRM6-006 (agent prompt alignment) — these can proceed concurrently once QRM6-002 is complete

**Key references:**
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — D2 (exec-attach), D7 (deny write), D9 (third build target), QRM6-002 section
- [QRM6-001-elicitation-spike.md](QRM6-001-elicitation-spike.md) — GO verdict; CC CLI 2.1.117 confirmed
- `Dockerfile` lines 39–74 — existing `agent` target (pattern to follow)
- `docker-compose.yml` lines 147–169 — existing agent services (pattern to follow)
- `docker/plugins/code-review/` — precedent for `docker/` config directory
- `.claude/settings.json` — existing project-level settings (currently just plugin enablement)
