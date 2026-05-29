# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Scope:** This file is for Claude Code sessions developing the Quorum codebase from outside the system. The in-container moderator persona — runtime orchestration prompts, MCP tool semantics, session-resume rules — lives in [docker/moderator/CLAUDE.md](docker/moderator/CLAUDE.md) and is not loaded here.

## Project Overview

Quorum is a multi-agent AI orchestration system for semi-autonomous software development. It coordinates role-based AI agents (Claude Code instances) that collaborate on development tasks through an MCP server.

### Agent Roles
- **Moderator**: Main orchestrator, interfaces directly with the user
- **Architect**: Designs solutions and reviews code at architectural level
- **Team Lead**: Generates task stubs, monitors integration, plans refactorings
- **Developer**: Implements tickets, requests code reviews
- **QA**: Quality assurance and testing
- **Product Owner**: Provides business context and requirements

Agents communicate via MCP server and collaborate according to their roles. Each role has a customizable prompt defining professional behavior and responsibilities.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: NestJS
- **Agent LLM**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — agents run as Claude Code subprocesses
- **Moderator**: Claude Code CLI in a dedicated container — pure orchestration via MCP tools
- **Protocol**: MCP SDK (`@modelcontextprotocol/sdk`) over Streamable HTTP
- **Containerization**: Docker

## Project Structure

NestJS monorepo with 2 apps and 1 shared library:

```
apps/
  mcp-server/     # MCP Server — 7 tools, 2 resources, Agent Registry, Message Broker, Context Store
  agent/          # Agent App — single image, multi-role via AGENT_ROLE env var (Claude Agent SDK)
libs/
  common/         # Shared library — AgentRole, messaging types, prompts, config, logger, tool-mapper
docker/           # Container assets per role
  moderator/      # Moderator persona (CLAUDE.md), claude.json, settings.json, entrypoint.sh
  plugins/        # CC CLI plugins mounted into agent/moderator containers
docs/             # Project documentation — living reference for system architecture
tickets/          # Ticket library — implementation timeline knowledge base (see tickets/README.md)
releases/         # Per-milestone post-implementation summaries (RELEASE-QRM*.md)
scripts/          # Developer helpers — start.sh, moderator.sh
logs/             # Docker JSON logs (bind-mounted, gitignored) — {role}-{timestamp}.jsonl
  sessions/       # Written session reports — analysis of Docker run logs
tools/            # Developer tooling scripts
  entropy-report/ # Source code entropy/complexity analysis
  session-report/ # Session log parser (parse-logs.mjs) + report writing guide
CHANGELOG.md      # Top-line chronological summary across all milestones
quorum.md         # Workspace conventions read by agents at runtime
```

### Ticket Library

The `tickets/` directory is an **implementation timeline knowledge base** — not documentation, but a sequential record of every unit of work. Each ticket is a time snapshot capturing the circumstances, reasoning, and approach for a specific piece of codework. Tickets are primarily for the agent: they explain *why* something was implemented a certain way, while the codebase remains the primary source of truth for *how*.

Tickets complement `docs/` — documentation describes the current system; tickets explain the sequence of decisions that built it. See [tickets/README.md](tickets/README.md) for naming conventions, structure requirements, and writing guidelines.

### Research Tools

The `tools/` directory holds developer scripts for analyzing the codebase and runtime behavior — not part of the runtime system, but used to understand and report on it.

| Tool | Purpose |
|------|---------|
| [tools/entropy-report/README.md](tools/entropy-report/README.md) | Source-code complexity analysis — Halstead metrics aggregated across commits |
| [tools/session-report/SESSION-REPORT.md](tools/session-report/SESSION-REPORT.md) | Parse Docker JSON logs into narrative session reports |

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/system-design.md](docs/system-design.md) | Overall architecture, containers, deployment |
| [docs/agent-messaging.md](docs/agent-messaging.md) | Bidirectional MCP concepts, communication patterns |
| [docs/mcp-connectivity.md](docs/mcp-connectivity.md) | MCP session lifecycle for agents (HTTP) and moderator (elicitation) — establish, maintain, recycle, register, reap |
| [docs/message-broker.md](docs/message-broker.md) | Message Broker implementation details, safeguards |
| [docs/context-management.md](docs/context-management.md) | Context sharing concepts, MCP resources/tools API |
| [docs/context-store.md](docs/context-store.md) | Context Store implementation, InMemoryStore, file persistence |
| [docs/claude-code-sdk.md](docs/claude-code-sdk.md) | Claude Code SDK integration, tool bridge, permissions, hardening |
| [docs/knowledge-management.md](docs/knowledge-management.md) | Knowledge management philosophy, three domains, KB concept |
| [tickets/README.md](tickets/README.md) | Ticket library conventions and structure guide |
| [releases/README.md](releases/README.md) | Milestone index and per-release notes (QRM1–QRM7) |
| [CHANGELOG.md](CHANGELOG.md) | Top-line chronological changelog across all milestones |
| [quorum.md](quorum.md) | Workspace conventions read by agents at runtime |
| [docker/moderator/CLAUDE.md](docker/moderator/CLAUDE.md) | In-container moderator persona — orchestration prompts, MCP tool semantics |

## Build Commands

```bash
# Install dependencies
npm install

# Development
npm run start:dev

# Build
npm run build

# Production
npm run start:prod

# Linting
npm run lint

# Tests
npm run test
npm run test:watch
npm run test:e2e

# First-time setup — copy .env.example and fill in:
#   ANTHROPIC_API_KEY        (agents)
#   CLAUDE_CODE_OAUTH_TOKEN  (moderator, from `claude setup-token`)
#   GH_TOKEN                 (fine-grained PAT for gh + git in every container)
#   REPO_URL                 (HTTPS clone URL of the target repo)
cp .env.example .env

# Docker — builds and starts all containers with correct host uid/gid.
# On first boot, the moderator and each agent clone REPO_URL into their own
# named volumes and authenticate gh/git via GH_TOKEN. There is no host
# workspace bind mount — all containers sync through git push/pull, and each
# agent invocation runs inside an isolated git worktree.
./scripts/start.sh
./scripts/start.sh -d     # detached mode

# Moderator — attach to the running moderator container
./scripts/moderator.sh
```

## Architecture Concept

The system enables high-level task decomposition through agent collaboration. Example flow:
1. User requests moderator to build a feature
2. Moderator invokes architect to design the solution
3. User provides feedback on design (agents can escalate via moderator)
4. Moderator instructs team lead to create implementation ticket stubs
5. Moderator assigns developer to implement tickets
6. Developer can request architectural review from architect, code review from team lead
7. Team lead monitors build progress and integration issues
8. Moderator invokes QA for testing

All inter-agent communication flows through `invoke_agent` on the MCP server. Agents use a pull-based context model — they receive minimal bootstrap context and query the Context Store for what they need.