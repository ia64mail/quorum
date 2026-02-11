# QRM1 Roadmap — Initial Implementation Milestone

## Goal

Functional prototype where **moderator, architect, team lead, and developer** agents run in Docker containers, connect to the MCP server, register themselves, communicate with each other via `invoke_agent`, and build/share context through the Context Store.

Each agent is an LLM (Anthropic API) instructed via role-specific system prompt — no Claude Code integration, no filesystem access, no business use cases. The milestone validates the **communication and context-sharing infrastructure**.

## Success Criteria

- `docker compose up` brings up MCP server + 4 agent containers (moderator/terminal, architect, teamlead, developer)
- All agents register with the MCP server on startup
- User can chat with moderator via terminal
- Moderator can invoke architect, architect can invoke teamlead, etc.
- Agents can store and query context through MCP tools
- Multi-hop invocation chains work with safeguards (depth limit, circular call prevention, timeouts)

## Scope Exclusions

- QA and Product Owner roles (deferred to QRM2)
- Claude Code integration (agents are plain LLM API calls)
- Filesystem/workspace access
- Ink-based terminal UI (basic stdin/stdout for now)
- Production context store (OpenSearch — InMemoryStore is sufficient)
- Business logic in agent prompts

---

## Milestone Scope

### QRM1-001 — Package Research
Installed core dependencies: `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `ink`, `react`, `zod`. Set up `.env.example` with required environment variables.

### QRM1-002 — Context Store (InMemoryStore)
Abstract `ContextStore` class + `InMemoryStore` POC. Three scopes (project, conversation, agent), lazy TTL expiration, substring search with token budget, change event emission via `@nestjs/event-emitter`.

### QRM1-003 — NestJS Configuration Management
Per-app config services with Zod-validated `registerAs` factories. Shared factories (`app`, `anthropic`, `mcp`) in `libs/common`, app-specific factories in each app. Full env var coverage with defaults.

### QRM1-004 — Message Broker Core
`AgentRegistry` (register/unregister/lookup), `MessageBroker` with 4 safeguards: depth limit, circular call prevention, agent availability check, role-based timeouts. Shared types: `AgentRole` enum, `InvokeRequest`/`InvokeResponse`.

### QRM1-005 — MCP Server Bootstrap
`McpService` wrapping `@modelcontextprotocol/sdk` with 5 tools (`invoke_agent`, `context_store`, `context_query`, `context_summarize`, `context_stats`) and 2 resources (`context://project`, `context://conversation/{id}`). `McpController` with Streamable HTTP transport + session management.

### QRM1-006 — Structured Logger
Configurable logger replacing NestJS default `ConsoleLogger` with dual-transport output: human-readable console + JSON lines to file. JSON logs enable cross-container timeline reconstruction when analysing multi-agent sessions.

- `LoggerBuilder` in `libs/common` — fluent factory that produces a NestJS `LoggerService`
  - `.withConsole()` — coloured, human-readable output (default NestJS style)
  - `.withJsonFile(path)` — append-only JSON-lines file, one object per log entry
  - `.build()` → returns `LoggerService` ready for `NestFactory.create(Module, { logger })`
- **JSON schema per line**: `{ timestamp, level, context, message, correlationId?, agentRole?, extra? }`
  - `correlationId` ties log entries to an invocation chain across containers
  - `agentRole` identifies the emitting container (`mcp-server`, `architect`, `developer`, …)
  - `timestamp` is ISO-8601 for deterministic cross-container sort
- Logging config factory (`logger.config.ts`) in `libs/common/src/config/` — env vars for log level, file path, enable/disable transports
- Swap in all 3 `main.ts` bootstraps: `NestFactory.create(Module, { logger: builder.build() })`
- Existing `new Logger(ClassName.name)` calls continue to work unchanged (they delegate to the app-level logger)
- Log file rotation out of scope (container ephemeral storage or external log collector)

**Depends on:** QRM1-003

### QRM1-007 — Agent-to-Server Connection
Implement the agent-side MCP client that connects to the server and enables bidirectional communication.

- Concrete `AgentConnection` implementation (Streamable HTTP transport)
- Agent app creates MCP client, connects to server's `/mcp` endpoint on startup
- Registration flow: agent announces its role to the server, server adds to `AgentRegistry`
- Invocation handler: agent receives `invoke_agent` calls routed by the broker
- Reconnection logic (basic retry on disconnect)
- Graceful shutdown: unregister on `SIGTERM`

**Depends on:** QRM1-004, QRM1-005, QRM1-006

### QRM1-008 — Agent LLM Integration
Wire the Anthropic SDK into the agent's invocation handler so it can generate intelligent responses.

- Agent receives invocation → builds message array with system prompt + invocation context
- Calls Anthropic `messages.create()` with tool definitions
- Tool-use loop: if LLM returns tool calls (`invoke_agent`, `context_*`), execute via MCP client and feed results back
- Final text response becomes the `InvokeResponse.result`
- Error handling: API failures, token limits, malformed responses

**Depends on:** QRM1-007

### QRM1-009 — Role Prompt System
Define system prompts that instruct the LLM to behave as a specific agent role.

- Prompt templates for: moderator, architect, teamlead, developer
- Each prompt defines: role identity, responsibilities, communication style, available tools, constraints
- Prompt loading based on `AGENT_ROLE` env var
- Prompts are collaboration-focused (not task-focused) — they define *how* the agent communicates, not *what* it builds
- Store prompts as injectable config (not hardcoded strings)

**Depends on:** QRM1-008

### QRM1-010 — Terminal Moderator Bootstrap
The terminal app functions as the moderator — the user-facing entry point to the system.

- Chat loop: read user input from stdin, display LLM responses to stdout
- Moderator uses Anthropic API with moderator system prompt
- LLM can call MCP tools via the terminal's own MCP client connection
- Conversation tracking: maintain message history, pass `correlationId` through invocation chains
- Basic output formatting (markdown-ish, no Ink rendering yet)

**Depends on:** QRM1-007, QRM1-009

### QRM1-011 — Docker Containerization
Package all apps into containers and orchestrate with Docker Compose.

- Multi-stage Dockerfile (build + runtime) shared across apps
- Update `docker-compose.yml`: build contexts, health checks, startup ordering
- MCP server starts first (`healthcheck`), agents wait with `depends_on: condition: service_healthy`
- Environment variable pass-through: `ANTHROPIC_API_KEY`, `AGENT_ROLE`, `MCP_SERVER_URL`
- Network: all containers on `quorum-net`, agents resolve `mcp-server` by hostname
- Shared log volume for JSON log files across all containers

**Depends on:** QRM1-010

### QRM1-012 — End-to-End Connectivity Smoke Test
Verify the full system works as an integrated whole.

- All 4 agents register with MCP server (check registry state)
- Moderator invokes architect → receives response
- Architect stores context → developer queries it → gets result
- Multi-hop chain: moderator → architect → teamlead (depth tracking works)
- Safeguards fire: circular call rejected, depth limit enforced, timeout triggers
- Verify JSON logs: correlationId traces an invocation chain across container log files
- Document manual verification steps and expected outputs

**Depends on:** QRM1-011