# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Containerization**: Docker
- **UI**: Terminal-based (minimalistic)

## Project Structure

```
docs/       # Project documentation (primary contribution point)
tickets/    # Implementation tasks as flat MD files (local Jira-like workflow)
```

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/system-design.md](docs/system-design.md) | Overall architecture, containers, deployment |
| [docs/agent-messaging.md](docs/agent-messaging.md) | Bidirectional MCP concepts, communication patterns |
| [docs/message-broker.md](docs/message-broker.md) | Message Broker implementation details, safeguards |

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
```

## Architecture Concept

The system enables high-level task decomposition through agent collaboration. Example flow:
1. User requests moderator to build an MCP server for database access
2. Moderator triggers architect to design using chosen stack
3. User provides feedback on design
4. Moderator instructs team lead to create implementation task stubs
5. Moderator assigns developer to implement tasks
6. Developer can request reviews from architect, clarifications from team lead
7. Team lead monitors build progress and integration issues

The MCP server enables inter-agent communication and shared context.