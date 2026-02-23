# QRM1-011: Docker Containerization

## Summary

Package all three Quorum apps into production-ready containers and update Docker Compose orchestration with health checks, startup ordering, environment variable pass-through, and shared log volumes. Consolidate the three near-identical per-app Dockerfiles into a single parameterized Dockerfile, add a health endpoint to the MCP server for readiness gating, and scope the compose file to the four QRM1 agents.

## Problem Statement

The Docker infrastructure exists as scaffolding but has never been validated against the functional codebase. Each gap blocks the milestone's primary success criterion — `docker compose up` brings up MCP server + 4 agent containers that register and communicate:

- **No health checks or startup ordering** — `depends_on` in docker-compose.yml only waits for the container to *start*, not for the application to be *ready*. Agents that boot faster than the MCP server will attempt `connectAndRegister()` against a server that hasn't opened its port yet. The MCP client's retry logic (10 attempts, 2s backoff) may absorb this, but it's fragile and wastes 20 seconds of retries in the best case. A health check with `condition: service_healthy` eliminates the race entirely.
- **Missing environment variables** — `ANTHROPIC_API_KEY` is not passed to any service in docker-compose.yml. Without it, both the terminal and agent containers fail at Anthropic SDK initialization. `PORT` is not overridden per service, so all containers default to 3000 — this works because they're in separate network namespaces, but it conflicts with the Dockerfile `EXPOSE` declarations (terminal:3001, agent:3002) and the `AGENT_CALLBACK_URL` derivations that use `PORT`. Logger env vars (`LOG_JSON_DIR`, `LOG_LEVEL`) are absent, disabling JSON log output.
- **No `AGENT_CALLBACK_URL` per agent** — Agents default `callbackUrl` to `http://localhost:${PORT}`. In Docker, `localhost` resolves to the container itself, not the Docker network. The MCP server would POST invocations to `localhost:3000` inside *its own* container, never reaching the target agent. Each agent needs `AGENT_CALLBACK_URL=http://{service_name}:{port}` using the Docker hostname.
- **No shared log volume** — QRM1-006 designed the logger for cross-container timeline reconstruction via shared JSON log directory. Without a volume mount, each container's logs are isolated in ephemeral storage and lost on container removal.
- **Three redundant Dockerfiles** — The three per-app Dockerfiles are identical except for the app name in the build command, the `EXPOSE` port, and a default `AGENT_ROLE` in the agent's file. This violates the roadmap spec ("Multi-stage Dockerfile shared across apps") and creates a maintenance burden where build process changes must be replicated three times.
- **Out-of-scope services** — docker-compose.yml includes `qa` and `productowner` services. QRM1 scope explicitly excludes these roles (deferred to QRM2). Their presence is misleading — they would start, register, but have no prompt templates or testing.
- **No MCP server health endpoint** — Docker's `healthcheck` needs an HTTP endpoint that returns 200 when the server is ready. The MCP server's only route (`/mcp`) speaks MCP protocol, not plain HTTP. A simple `GET /health` is needed.
- **Terminal callback URL uses `localhost`** — The terminal's `McpClientService` hardcodes `http://localhost:${port}` for registration. In Docker, this should be the service hostname (`http://terminal:${port}`). While no agent invokes the moderator in QRM1, the registry entry should be accurate for system state verification in QRM1-012.

## Design Context

### Unified Dockerfile with Build Arg

The three Dockerfiles differ only in the app name passed to `nest build` and cosmetic details (`EXPOSE`, default env). A single root-level `Dockerfile` parameterized by `APP_NAME` eliminates the redundancy. Docker Compose passes the build arg per service:

    build:
      context: .
      dockerfile: Dockerfile
      args:
        APP_NAME: terminal

The multi-stage structure stays the same: builder stage installs deps and runs `nest build ${APP_NAME}`, runtime stage copies the webpack bundle and `node_modules`. `EXPOSE` becomes a build arg too — purely documentary, but useful for `docker compose ps` output.

### Health Check Strategy

The MCP server needs a `GET /health` endpoint returning 200. A dedicated `HealthController` at the root path (`/health`) keeps concerns separated from the MCP protocol controller (`/mcp`). The controller is trivially small — a single `@Get()` returning `{ status: 'ok' }`.

Docker Compose uses the health check to gate agent startup:

    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s

Using Node.js `fetch()` (available in Node 24) avoids installing `curl` or `wget` in the Alpine image. The agents then use:

    depends_on:
      mcp-server:
        condition: service_healthy

### Terminal Callback URL

The terminal hardcodes `http://localhost:${port}` as its registration callback. In Docker, this needs to be the service hostname. Two options:

1. **Add `TERMINAL_CALLBACK_URL` env var** — new config field, mirrors agent's `AGENT_CALLBACK_URL` pattern
2. **Reuse the existing pattern** — the terminal's `McpClientService` doesn't use a config field for callback URL; it constructs it inline

Option 2 requires a code change to the terminal's `McpClientService` to read the callback URL from config (or an env var) instead of hardcoding `localhost`. This aligns with the agent's pattern where `AGENT_CALLBACK_URL` overrides the default. The env var name `MCP_CALLBACK_URL` works for the terminal since `AGENT_CALLBACK_URL` implies an agent-specific context.

### Environment Variable Strategy

Environment variables fall into three categories:

| Category | Strategy | Examples |
|----------|----------|---------|
| **Secrets** | Host `.env` file, not in compose | `ANTHROPIC_API_KEY` |
| **Per-service config** | Inline in compose `environment` block | `PORT`, `AGENT_ROLE`, `AGENT_CALLBACK_URL` |
| **Shared defaults** | `x-shared-env` YAML anchor or `.env` file | `ANTHROPIC_MODEL`, `LOG_LEVEL`, `LOG_JSON_DIR` |

Docker Compose reads `.env` automatically for variable interpolation (`${VAR}`). Secrets like `ANTHROPIC_API_KEY` use this mechanism — the key appears in `environment:` as `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}` and resolves from the host's `.env` file.

### Shared Log Volume

A named Docker volume `quorum-logs` mounted at `/app/logs` in every container. All containers set `LOG_JSON_DIR=/app/logs`. Each container's logger produces a uniquely named file (`{agentRole}-{timestamp}.jsonl`), so there are no filename collisions. After a session, the volume can be inspected with `docker compose exec` or mounted into an analysis container.

### QRM1 Service Scope

The compose file is scoped to the four QRM1 roles: terminal (moderator), mcp-server, architect, teamlead, developer. The `qa` and `productowner` services are removed — they can be re-added in QRM2 when their prompt templates and testing exist. This matches the roadmap success criteria: "4 agent containers (moderator/terminal, architect, teamlead, developer)."

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| Single parameterized Dockerfile at project root | CI/CD pipeline (GitHub Actions, image registry) |
| Remove per-app Dockerfiles | Multi-arch builds (ARM/x86) |
| Health endpoint for MCP server | Health endpoints for agent or terminal |
| `docker-compose.yml` health checks and startup ordering | Kubernetes / Helm charts |
| Environment variable pass-through for all services | Docker secrets management |
| Shared log volume | Log rotation or external log collectors |
| `AGENT_CALLBACK_URL` per agent service | SSL/TLS between containers |
| Terminal callback URL from env var | Resource limits (memory/CPU) |
| Scope to QRM1's 4 agents (remove qa/productowner) | Docker Compose profiles or override files |
| `docker compose build` + `docker compose up` verification | Automated integration testing in containers |
| `.env.example` updates | Production deployment documentation |

## Implementation Details

### 1. Health Endpoint — `apps/mcp-server/src/health/`

A minimal `HealthController` with a single `GET /health` route that returns `{ status: 'ok' }` with a 200 status code. Wired through a `HealthModule` imported by `McpServerModule`.

No `@nestjs/terminus` — the POC doesn't need database readiness, disk space checks, or other terminus features. A plain controller is sufficient. The health check confirms "NestJS is listening and routing requests," which is the relevant readiness signal for agents.

### 2. Unified Dockerfile — `Dockerfile` (project root)

Replaces `apps/terminal/Dockerfile`, `apps/mcp-server/Dockerfile`, `apps/agent/Dockerfile`.

Key structure:
- Global `ARG APP_NAME` with no default (forces explicit specification)
- Builder stage: `npm ci`, `npx nest build ${APP_NAME}`
- Runtime stage: copies `dist/apps/${APP_NAME}` and `node_modules`, sets `NODE_ENV=production`
- `CMD ["node", "dist/main.js"]`

Uses `npx nest build` instead of `npm run build` to make the build-arg substitution explicit and avoid npm arg-passing ambiguity.

No `EXPOSE` — each app listens on its `PORT` env var and Docker Compose handles port mapping. `EXPOSE` is purely documentary and varies per app, making it awkward with a shared Dockerfile. Omitting it has no functional impact.

No default `AGENT_ROLE` in the Dockerfile — the compose file sets it explicitly per service, which is clearer than baking a default into the image.

### 3. Docker Compose Overhaul — `docker-compose.yml`

**Removed:** `version` key (deprecated in Compose V2), `qa` service, `productowner` service.

**Added:**

YAML extension `x-shared-env` anchor for environment variables common to terminal and agents (avoids repetition):

    x-shared-env: &shared-env
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      ANTHROPIC_MODEL: ${ANTHROPIC_MODEL:-claude-sonnet-4-5-20250929}
      ANTHROPIC_MAX_TOKENS: ${ANTHROPIC_MAX_TOKENS:-4096}
      MCP_SERVER_URL: http://mcp-server:3000
      LOG_JSON_DIR: /app/logs
      LOG_LEVEL: ${LOG_LEVEL:-log}

**Service updates:**

`mcp-server`:
- Build via root `Dockerfile` with `APP_NAME: mcp-server`
- `healthcheck` using Node.js `fetch()` against `/health`
- Environment: `PORT=3000`, `LOG_JSON_DIR=/app/logs`, `LOG_LEVEL`
- Log volume mount

`terminal`:
- Build via root `Dockerfile` with `APP_NAME: terminal`
- `depends_on.mcp-server.condition: service_healthy`
- Environment: `<<: *shared-env` + `PORT=3001`, `MCP_CALLBACK_URL=http://terminal:3001`
- Log volume mount
- `stdin_open: true`, `tty: true` (retained for interactive use)

Agent services (`architect`, `teamlead`, `developer`):
- Build via root `Dockerfile` with `APP_NAME: agent`
- `depends_on.mcp-server.condition: service_healthy`
- Environment: `<<: *shared-env` + `PORT=3002`, `AGENT_ROLE`, `AGENT_CALLBACK_URL=http://{service}:3002`
- Log volume + workspace volume mounts

**Named volumes:**

    volumes:
      quorum-logs:

### 4. Terminal Callback URL — `apps/terminal/src/connection/mcp-client.service.ts`

The terminal's `register()` method currently hardcodes `callbackUrl: \`http://localhost:${this.config.app.port}\``. Update to read from `MCP_CALLBACK_URL` env var with the localhost fallback.

Two approaches:
1. **Add a config field** to `TerminalConfigService` — follows the established pattern but adds a Zod schema, config factory, and tests for a single env var
2. **Read env var directly** in `McpClientService.register()` — `process.env.MCP_CALLBACK_URL || \`http://localhost:${port}\``

Option 2 is simpler for a single field that only the Docker deployment cares about. The agent app's `AGENT_CALLBACK_URL` went through config because it's part of the agent's identity (used in multiple places, tested with Zod). The terminal's callback URL is used in exactly one line.

However, for consistency with the established pattern and testability, option 1 (config field) is preferred. Add `callbackUrl` to the terminal's config, defaulting to `http://localhost:${PORT}`, overrideable via `MCP_CALLBACK_URL`.

### 5. `.env.example` Update

Add a Docker Compose section with guidance:

    # === Logging (all apps) ===
    LOG_LEVEL=log
    LOG_JSON_DIR=
    LOG_CONSOLE=true

    # === Docker Compose ===
    # ANTHROPIC_API_KEY must be set in .env for docker compose
    # WORKSPACE_PATH — host path mounted into agent containers
    WORKSPACE_PATH=/path/to/target/project

### 6. Remove Per-App Dockerfiles

Delete:
- `apps/terminal/Dockerfile`
- `apps/mcp-server/Dockerfile`
- `apps/agent/Dockerfile`

### 7. File Structure

```
Dockerfile                                    # NEW — unified, parameterized by APP_NAME
docker-compose.yml                            # MODIFIED — health checks, env vars, volumes, scoped services
.env.example                                  # MODIFIED — logging and Docker sections
.dockerignore                                 # EXISTING — no changes needed

apps/mcp-server/src/
  health/                                     # NEW
    health.controller.ts                      # GET /health → { status: 'ok' }
    health.controller.spec.ts                 # Tests
    health.module.ts                          # HealthModule
    index.ts                                  # Barrel export
  mcp-server.module.ts                        # MODIFIED — import HealthModule

apps/terminal/src/
  config/
    terminal.config.ts                        # MODIFIED — add callbackUrl field
    terminal.config.spec.ts                   # MODIFIED — test callbackUrl parsing
  connection/
    mcp-client.service.ts                     # MODIFIED — read callbackUrl from config
    mcp-client.service.spec.ts                # MODIFIED — test configurable callbackUrl

apps/terminal/Dockerfile                      # REMOVED
apps/mcp-server/Dockerfile                    # REMOVED
apps/agent/Dockerfile                         # REMOVED
```

### 8. Testing Strategy

**HealthController tests** (`health.controller.spec.ts`):
- `GET /health` returns `{ status: 'ok' }` with 200 status

**Terminal config tests** (`terminal.config.spec.ts`):
- `callbackUrl` defaults to `http://localhost:${PORT}` when `MCP_CALLBACK_URL` is not set
- `callbackUrl` reads from `MCP_CALLBACK_URL` env var when set
- Invalid URL rejected by Zod validation

**Terminal McpClientService tests** (`mcp-client.service.spec.ts`):
- Registration uses `callbackUrl` from config (not hardcoded localhost)

**Docker verification** (manual):
- `docker compose build` — all three images build successfully
- `docker compose up` — MCP server starts and becomes healthy, terminal and agents start after
- `docker compose ps` — all 5 services running (mcp-server, terminal, architect, teamlead, developer)
- `docker compose logs mcp-server` — shows health check route being hit
- Log volume contains JSON log files from all containers

## Acceptance Criteria

- [x] Single `Dockerfile` at project root with `APP_NAME` build arg — builds all three apps
- [x] Per-app Dockerfiles removed (`apps/terminal/Dockerfile`, `apps/mcp-server/Dockerfile`, `apps/agent/Dockerfile`)
- [x] MCP server has `GET /health` endpoint returning `{ status: 'ok' }` with 200
- [x] `HealthModule` imported by `McpServerModule`
- [x] `docker-compose.yml` uses root `Dockerfile` with build args per service
- [x] `mcp-server` service has `healthcheck` configuration
- [x] Terminal and agent services use `depends_on` with `condition: service_healthy`
- [x] `ANTHROPIC_API_KEY` passed through from host `.env` to terminal and agent services
- [x] `PORT` set explicitly per service (mcp-server:3000, terminal:3001, agents:3002)
- [x] `AGENT_CALLBACK_URL` set per agent service using Docker hostname (`http://{service}:3002`)
- [x] Terminal reads `MCP_CALLBACK_URL` from config, defaults to `http://localhost:${PORT}`
- [x] Shared `quorum-logs` volume mounted at `/app/logs` in all containers
- [x] `LOG_JSON_DIR=/app/logs` set in environment for all services
- [x] `qa` and `productowner` services removed (QRM2 scope)
- [x] `ANTHROPIC_MODEL` and `ANTHROPIC_MAX_TOKENS` configurable via `.env` with sensible defaults
- [x] `.env.example` updated with logging and Docker Compose variables
- [x] `docker compose build` succeeds for all services
- [x] Unit tests: HealthController, terminal config callbackUrl, McpClientService registration
- [x] Existing tests unaffected — `npm run test` passes
- [x] `npm run build` succeeds, `npm run lint` passes

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-22

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `Dockerfile` | Created (renamed from `apps/agent/Dockerfile`) | Global `ARG APP_NAME` (no default — forces explicit specification). Builder stage: `npm ci` + `npx nest build ${APP_NAME}`. Runtime stage: copies `dist/apps/${APP_NAME}` + `node_modules`, sets `NODE_ENV=production`. `ARG` re-declared in each stage (Docker multi-stage scoping requirement). No `EXPOSE` — port varies per app, compose handles mapping. No default `AGENT_ROLE` — set explicitly per service. Uses `npx nest build` instead of `npm run build` to make build-arg substitution explicit |
| `apps/agent/Dockerfile` | Renamed | Became root `Dockerfile` (see above) |
| `apps/mcp-server/Dockerfile` | Removed | Replaced by root `Dockerfile` |
| `apps/terminal/Dockerfile` | Removed | Replaced by root `Dockerfile` |
| `docker-compose.yml` | Modified | Removed `version` key (deprecated in Compose V2). Removed `qa` and `productowner` services (QRM2 scope). Added `x-shared-env` YAML anchor for `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`, `MCP_SERVER_URL`, `LOG_JSON_DIR`, `LOG_LEVEL`. All 5 services inherit via `<<: *shared-env`. Each service builds via root `Dockerfile` with `APP_NAME` build arg. `mcp-server`: `healthcheck` using Node.js `fetch()` against `/health` (no curl/wget in Alpine), `PORT=3000`. Terminal: `depends_on` with `condition: service_healthy`, `PORT=3001`, `MCP_CALLBACK_URL=http://terminal:3001`. Agents: `depends_on` with `service_healthy`, `PORT=3002`, per-service `AGENT_CALLBACK_URL` using Docker hostname. Named `quorum-logs` volume mounted at `/app/logs` in all services. Workspace volume on agent services only |
| `apps/mcp-server/src/health/health.controller.ts` | Created | `@Controller('health')` with single `@Get()` returning `{ status: 'ok' }`. No `@nestjs/terminus` — plain controller suffices for readiness gating |
| `apps/mcp-server/src/health/health.controller.spec.ts` | Created | 1 test: return value is `{ status: 'ok' }` |
| `apps/mcp-server/src/health/health.module.ts` | Created | `HealthModule` with `HealthController` |
| `apps/mcp-server/src/health/index.ts` | Created | Barrel export for `HealthModule` and `HealthController` |
| `apps/mcp-server/src/mcp-server.module.ts` | Modified | Added `HealthModule` to imports |
| `apps/terminal/src/config/terminal.config.ts` | Created | `registerAs('terminal')` config factory with Zod schema. `callbackUrl`: reads `MCP_CALLBACK_URL` env var, falls back to `http://localhost:${PORT \|\| '3000'}`. Validates with `z.string().url()` |
| `apps/terminal/src/config/terminal-config.module.ts` | Modified | Added `terminalConfig` to `ConfigModule.forRoot({ load: [...] })` |
| `apps/terminal/src/config/terminal-config.service.ts` | Modified | Added `@Inject(terminalConfig.KEY) public readonly terminal` field |
| `apps/terminal/src/config/terminal-config.service.spec.ts` | Modified | 3 new tests: `terminal` namespace populated, `callbackUrl` defaults to `http://localhost:${PORT}`, `callbackUrl` reads from `MCP_CALLBACK_URL`, invalid URL rejected by Zod |
| `apps/terminal/src/connection/mcp-client.service.ts` | Modified | `register()` reads `this.config.terminal.callbackUrl` instead of hardcoded `http://localhost:${port}` |
| `apps/terminal/src/connection/mcp-client.service.spec.ts` | Modified | Added `terminal: { callbackUrl: 'http://terminal:3001' }` to mock config. Registration assertion updated from `http://localhost:3001` to `http://terminal:3001` |
| `.env.example` | Modified | Added `ANTHROPIC_MAX_TOKENS`, logging section (`LOG_LEVEL`, `LOG_JSON_DIR`, `LOG_CONSOLE`), Docker Compose section with guidance comments. Removed `DEVELOPER_COUNT` (no longer referenced by compose) |
| `docs/system-design.md` | Modified | Updated "NestJS Monorepo Structure" — removed per-app Dockerfiles, added root `Dockerfile`, updated directory trees to reflect actual module structure. Updated "Docker Compose Configuration" — shows `x-shared-env` anchor, unified Dockerfile with build args, `healthcheck`, `service_healthy` ordering, QRM1 scope note. Updated "Network Communication" — agents all on port 3002 with Docker hostnames, bidirectional arrows showing MCP server POST /invoke delivery |

### Deviations from Ticket Spec

- **`mcp-server` uses `x-shared-env` anchor.** The ticket's design context shows `x-shared-env` as "environment variables common to terminal and agents" with the MCP server setting `LOG_JSON_DIR` and `LOG_LEVEL` separately. The implementation gives `mcp-server` the full `<<: *shared-env` merge. Rationale: the MCP server will need `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` when LLM-powered context summarization is added (future enhancement noted in `docs/context-store.md`). Passing unused env vars has no side effects, and it eliminates the env duplication asymmetry.

- **`npx nest build` instead of `npm run build`.** The ticket notes this in its design but the original Dockerfiles used `npm run build agent`. Changed to `npx nest build ${APP_NAME}` because `npm run build` requires `--` to forward the app name argument, and the behavior varies across npm versions. `npx nest build` accepts the app name as a direct positional argument, making the build-arg substitution explicit and reliable.

- **No `EXPOSE` in Dockerfile.** The ticket design context mentions `EXPOSE` as a build arg ("purely documentary, but useful for `docker compose ps` output"). The implementation omits it entirely — each app's port is set via `PORT` env var in compose, and `EXPOSE` has no functional effect. Omitting it avoids the complexity of a second build arg for a purely documentary directive.

### Post-Review Fixes

- **`mcp-server` switched to `x-shared-env`.** Original commit had `mcp-server` with manually duplicated `LOG_JSON_DIR` and `LOG_LEVEL`. Changed to `<<: *shared-env` merge for forward-compatibility with planned MCP server LLM integration.

- **Removed unused `DEVELOPER_COUNT` from `.env.example`.** The old compose used `deploy.replicas: ${DEVELOPER_COUNT:-1}` but the new compose doesn't reference it. Removed to avoid confusion.

- **Added missing Zod rejection test.** The ticket spec's testing strategy required "Invalid URL rejected by Zod validation" but the original commit omitted it. Added test confirming `z.string().url()` rejects `'not-a-url'`.

- **Updated `docs/system-design.md`.** Three sections were stale after the Docker overhaul: (1) "NestJS Monorepo Structure" still showed per-app Dockerfiles, (2) "Docker Compose Configuration" showed the old `version: '3.8'` structure with `qa`/`productowner`, (3) "Network Communication" diagram showed unique ports per agent (3002–3006) instead of the actual shared port 3002 with Docker hostname disambiguation. All three updated to match the implementation.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 251 tests passing (4 new + 247 existing, 0 regressions)

## Dependencies and References

### Prerequisites
- QRM1-006 — Logger with `LOG_JSON_DIR`, dual-transport output, auto-named files
- QRM1-007 — Agent `AGENT_CALLBACK_URL` config, `McpClientService` connection/registration pattern
- QRM1-010 — Terminal moderator with MCP client, chat loop, functional app

### What This Blocks
- QRM1-012 — End-to-End Connectivity Smoke Test (requires all containers running and communicating)

### References
- [docs/system-design.md](../docs/system-design.md) — Docker Compose configuration, network diagram, container components
- [docs/message-broker.md](../docs/message-broker.md) — Agent availability, callback URL delivery mechanism
- QRM1-006 Implementation Notes — Logger env vars, JSON log file naming, shared directory design
- QRM1-007 Implementation Notes — `AGENT_CALLBACK_URL`, `HttpAgentConnection` POST to callback URL
- QRM1-010 Implementation Notes — Terminal `McpClientService` hardcoded localhost callback