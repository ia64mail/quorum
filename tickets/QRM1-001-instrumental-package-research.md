# QRM1-001: Core Package Installation & Configuration

## Summary

Install and configure the five core npm packages that implement the Quorum system design: `@anthropic-ai/sdk` for LLM integration, `@modelcontextprotocol/sdk` for the MCP communication layer, `ink` and `react` for the terminal UI, and `zod` for schema validation. Set up the minimal environment configuration required by these dependencies.

## Problem Statement

The Quorum project scaffold exists with NestJS 11 and TypeScript, but lacks the domain-specific packages required by the system architecture. Every container component described in `docs/system-design.md` depends on one or more of these packages:

- The **Terminal App** needs `@anthropic-ai/sdk` (Moderator LLM) and `ink`/`react` (Console UI)
- The **MCP Server** needs `@modelcontextprotocol/sdk` (server, tool/resource registration) and `zod` (tool input schemas)
- The **Agent Containers** need `@modelcontextprotocol/sdk` (client connections) and `zod` (schema validation)

Without these packages installed and configured, no implementation ticket can proceed. This ticket captures the package selection rationale, documents how each package maps to the architecture, and defines the install + configuration steps.

## Design Context

### Package-to-Architecture Mapping

Each package was selected because it directly implements a component or capability described in the system design documentation.

#### `@anthropic-ai/sdk` — Moderator LLM Integration

| Design Reference | Requirement |
|-----------------|-------------|
| `docs/system-design.md` — Terminal App Container | "Built-in Moderator LLM that orchestrates other agents" |
| `docs/system-design.md` — Agent Collaboration Flow | Moderator initiates all agent orchestration via streaming conversation |
| `docs/agent-messaging.md` — The `invoke_agent` Tool | Moderator uses tool-use (function calling) to invoke agents through MCP |

The Moderator LLM lives in `apps/terminal/src/moderator/`. It requires:
- **Streaming responses** — the terminal UI renders LLM output as it arrives, not after completion
- **Tool use** — the Moderator calls `invoke_agent` to delegate work to other agents; the SDK must support tool definitions and tool-result message flows
- **Message construction** — building multi-turn conversations with system prompts, user input, assistant responses, and tool results

`@anthropic-ai/sdk` is Anthropic's official TypeScript SDK, provides the `Anthropic` client with `messages.stream()` and native tool-use support. It is the direct, low-level SDK — appropriate because Quorum manages its own orchestration loop rather than delegating to an agent framework.

#### `@modelcontextprotocol/sdk` — MCP Server & Client

| Design Reference | Requirement |
|-----------------|-------------|
| `docs/system-design.md` — MCP Server Container | "NestJS MCP server implementation" with Agent Registry and Message Broker |
| `docs/agent-messaging.md` — Dual-Role Agents | Each agent is both MCP client (outbound calls) and invocation handler (inbound tasks) |
| `docs/message-broker.md` — Transport | "WebSocket provides native bidirectional messaging" via `@modelcontextprotocol/sdk` |
| `docs/context-management.md` — MCP Resources & Tools | Resources (`context://project`, `context://conversation/{id}`) and tools (`context_store`, `context_query`, `context_summarize`, `context_stats`) |

This package is used across all three container types:
- **MCP Server** (`apps/mcp-server/`) — `McpServer` class for server creation, `server.tool()` for registering `invoke_agent` and context management tools, `server.resource()` / `server.registerResourceTemplate()` for context resources
- **Terminal App** (`apps/terminal/`) — `Client` class to connect Moderator to MCP Server
- **Agent Containers** (`apps/agent/`) — `Client` class for outbound MCP calls, plus handler registration for inbound task delivery
- **Shared library** (`libs/mcp-client/`, `libs/mcp-protocol/`) — reusable client wrapper and protocol type definitions

The SDK includes both server and client implementations, transport abstractions (WebSocket, HTTP, stdio), and the primitive registration APIs (tools, resources, prompts) that the design relies on.

#### `ink` + `react` — Terminal UI

| Design Reference | Requirement |
|-----------------|-------------|
| `docs/system-design.md` — Terminal App Container | "Console UI for chat-based interaction with the Moderator" |
| `docs/system-design.md` — Terminal App Responsibilities | "Accept user input as natural language commands", "Display agent responses and progress" |

Ink is a React renderer for the terminal. It maps directly to the Terminal App's UI layer (`apps/terminal/src/ui/`):
- React component model for composing chat views (message list, input box, status indicators)
- Streaming text rendering — re-renders as new tokens arrive from `@anthropic-ai/sdk` streams
- Input handling — captures user text input for the Moderator conversation loop

Ink is the same terminal UI stack used by Claude Code itself. React 18 is its peer dependency.

#### `zod` — Schema Validation

| Design Reference | Requirement |
|-----------------|-------------|
| `docs/agent-messaging.md` — `invoke_agent` Tool | Tool schema uses `z.enum()`, `z.string()`, `z.record()`, `z.boolean()` |
| `docs/context-management.md` — All Context Tools | Every tool input schema (`context_store`, `context_query`, `context_summarize`, `context_stats`) uses zod types |

Zod is the schema definition language for MCP tool registration. The `@modelcontextprotocol/sdk` `server.tool()` API accepts zod schemas as input definitions. Every MCP tool in the design docs is already expressed in zod — this is not an optional choice but a requirement of the MCP SDK.

### Packages Not Selected

| Package | Reason for Exclusion |
|---------|---------------------|
| `@anthropic-ai/claude-agent-sdk` | Provides a full agent runtime (file ops, bash execution, tool loops). Quorum implements its own orchestration — agents are Claude Code CLI instances wrapped in NestJS, not SDK-managed agents. Adding this would conflict with the architecture. |
| `blessed` / `blessed-contrib` | Legacy terminal UI library. Ink's React model is a better fit for composable UI components and is actively maintained. |
| `commander` | CLI argument parsing. Not needed — the terminal app is a single-purpose chat interface launched via NestJS, not a multi-command CLI tool. |

## Implementation Details

### 1. Install Dependencies

Add the five core packages to the project's `dependencies` in `package.json`:

```
@anthropic-ai/sdk       ^0.71.x
@modelcontextprotocol/sdk  ^1.x
ink                     ^5.x
react                   ^18.x
zod                     ^3.25.x
```

Additionally, `@types/react` is needed as a dev dependency since the project uses TypeScript.

Ink 5.x is ESM-only. The current NestJS scaffold uses CommonJS (`ts-jest`, `tsconfig-paths/register`). This is a known integration point — the terminal app's tsconfig may need `"module": "nodenext"` or a dynamic `import()` wrapper. This should be validated at install time and documented if any workaround is needed.

### 2. Environment Configuration

Create a `.env.example` file at project root documenting required environment variables:

```env
# Required by @anthropic-ai/sdk — Moderator LLM API access
ANTHROPIC_API_KEY=sk-ant-...

# MCP Server URL — used by terminal app and agent containers to connect
# (default for docker-compose network)
MCP_SERVER_URL=http://mcp-server:3000

# Agent role — set per container in docker-compose.yml
# Values: architect | teamlead | developer | qa | productowner
AGENT_ROLE=developer

# Host path to target project — mounted as /mnt/quorum/workspace in containers
WORKSPACE_PATH=/path/to/target/project

# Number of developer agent replicas (default: 1)
DEVELOPER_COUNT=1
```

Only `ANTHROPIC_API_KEY` is immediately required by the new dependencies. The remaining variables are documented for completeness against `docs/system-design.md` Docker Compose configuration and will be consumed by later implementation tickets.

Add `.env` to `.gitignore` to prevent secret leakage.

### 3. Verify Installation

After install, confirm that core imports resolve without errors:
- `import Anthropic from '@anthropic-ai/sdk'`
- `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`
- `import { Client } from '@modelcontextprotocol/sdk/client/index.js'`
- `import { z } from 'zod'`
- `import React from 'react'` / `import { render } from 'ink'`

If ESM/CJS interop issues surface with `ink`, document the specific error and workaround.

## Acceptance Criteria

- [ ] All five packages installed and listed in `package.json` dependencies
- [ ] `@types/react` installed as dev dependency
- [ ] `npm install` completes without peer dependency warnings or errors
- [ ] `.env.example` created with documented variables
- [ ] `.env` added to `.gitignore`
- [ ] TypeScript can resolve imports from all five packages (no type errors on bare imports)
- [ ] Any ESM/CJS compatibility notes documented in this ticket or a follow-up

## Dependencies and References

### References
- [docs/system-design.md](../docs/system-design.md) — Container architecture, NestJS monorepo structure, Docker Compose config
- [docs/agent-messaging.md](../docs/agent-messaging.md) — Bidirectional MCP, `invoke_agent` tool definition
- [docs/message-broker.md](../docs/message-broker.md) — Message Broker implementation, WebSocket transport
- [docs/context-management.md](../docs/context-management.md) — Context MCP tools and resources, zod schemas
- [docs/context-store.md](../docs/context-store.md) — Context Store interface, storage backends
- [@anthropic-ai/sdk on npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [Ink — React for CLI](https://github.com/vadimdemedes/ink)
- [MCP TypeScript SDK on GitHub](https://github.com/modelcontextprotocol/typescript-sdk)