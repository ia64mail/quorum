# Quorum

Multi-agent AI orchestration for semi-autonomous software development. Quorum coordinates role-based AI agents that collaborate on development tasks — each agent is an LLM with a specialized role, and they communicate, delegate, and share decisions through an MCP server without ever passing full conversation histories to each other.

```mermaid
graph TB
    subgraph "Terminal"
        U[User] <--> MOD[Moderator]
    end

    subgraph "MCP Server"
        MCP[Protocol Handler]
        BROKER[Message Broker]
        CTX[(Context Store)]
        MCP --- BROKER
        MCP --- CTX
    end

    subgraph "Agent Containers"
        A[Architect]
        TL[Team Lead]
        D[Developer]
        QA_A[QA]
        PO[Product Owner]
    end

    MOD <-->|MCP| MCP
    A <-->|MCP| MCP
    TL <-->|MCP| MCP
    D <-->|MCP| MCP
    QA_A <-->|MCP| MCP
    PO <-->|MCP| MCP
```

A user talks to the **Moderator** through a terminal. The Moderator orchestrates specialized agents — Architect, Team Lead, Developer, QA, Product Owner — by invoking them through the MCP server. Any agent can invoke any other agent mid-task, store decisions for the team, and query decisions left by others.

## Life of a Request

To understand how Quorum works, follow what happens when a user asks: *"Add user authentication to the project."*

The Moderator decides this needs a design first and invokes the Architect. But the Architect doesn't receive the Moderator's conversation history, or any accumulated context blob. It receives a thin envelope:

```
{
  correlationId: "task-auth-001",
  caller: "moderator",
  target: "architect",
  action: "Design the auth system for the project",
  context: { constraint: "must support OAuth" },
  depth: 0
}
```

A task description, a correlation ID to trace the chain, and an optional handful of key-value hints. That's it. The Architect's context window starts nearly empty.

This is the first principle: **agents start lean**.

### Step 1 — The Architect Pulls What It Needs

The Architect knows it needs project context to make good decisions. So it queries the Context Store:

```mermaid
sequenceDiagram
    participant A as Architect
    participant CS as Context Store

    Note over A: What tech stack are we working with?
    A->>CS: context_query(project, "tech stack")
    CS->>A: {framework: "NestJS", database: "PostgreSQL"}

    Note over A: Any prior auth decisions?
    A->>CS: context_query(project, "auth")
    CS->>A: (empty — no one has decided yet)
```

The Context Store holds facts organized into three scopes: **project** (visible to everyone, lives for the whole session), **conversation** (scoped to one task chain via correlationId), and **agent** (private scratchpad). The Architect queries the project scope because tech stack choices are session-wide facts that any earlier agent might have stored.

Nothing was pushed to the Architect. It decided what it needed and pulled just that. This is the second principle: **pull, don't push**.

### Step 2 — The Architect Makes Decisions and Records Them

With project context in hand, the Architect designs the auth system. Then it stores its decisions back into the Context Store so the rest of the team can find them later:

```mermaid
sequenceDiagram
    participant A as Architect
    participant CS as Context Store

    A->>A: Designs JWT auth with refresh tokens

    A->>CS: context_store(project, "auth_pattern", "JWT with refresh tokens")
    A->>CS: context_store(project, "session_storage", "Redis")
    A->>CS: context_store(conversation, "auth_guards", "NestJS guards on all endpoints")
```

The project-scoped decisions (`auth_pattern`, `session_storage`) are now visible to every agent across every future task. The conversation-scoped decision (`auth_guards`) is only visible to agents working on this specific `correlationId` chain.

This is the third principle: **store decisions, not conversations**. The Architect doesn't preserve its reasoning process or internal monologue. It distills decisions into named facts that others can query by topic.

### Step 3 — The Architect Consults Another Agent Mid-Task

While designing, the Architect realizes it needs business requirements to choose between OAuth and simple email/password. Rather than guessing, it invokes the Product Owner directly:

```mermaid
sequenceDiagram
    participant A as Architect
    participant B as Message Broker
    participant PO as Product Owner

    A->>B: invoke_agent(productowner, "OAuth required or email/password only?")
    Note over B: depth: 0→1, check safeguards
    B->>PO: deliver task
    PO->>PO: "Enterprise clients need OAuth, but MVP can be email/password"
    PO->>B: response
    B->>A: "MVP: email/password. Post-MVP: add OAuth."
    A->>A: Continues designing with the answer
```

The invocation passes through the Message Broker, which applies safeguards before delivery. It checks that the call depth hasn't exceeded the limit (default 5) — preventing unbounded delegation chains where agents keep calling agents forever. It checks that the Product Owner isn't already in the active call chain for this `correlationId` — preventing circular deadlocks where A calls B and B calls A. It verifies the Product Owner is registered and connected. And it wraps the call in a role-based timeout (2 minutes for Product Owner, 30 minutes for Developer) so a hung agent can't block the caller indefinitely.

This is the fourth principle: **agents are peers, not a pipeline**. Any agent can consult any other agent at any point. The Architect doesn't have to go back through the Moderator to reach the Product Owner. Communication is a mesh, not a chain.

### Step 4 — The Architect Returns, the Moderator Continues

The Architect finishes and returns a concise text response to the Moderator. The Moderator presents the design to the user, gets approval, and invokes the Team Lead to break the work into tickets.

The Team Lead — just like the Architect before it — starts with a near-empty context window and a thin task envelope. It pulls what it needs:

```mermaid
sequenceDiagram
    participant TL as Team Lead
    participant CS as Context Store

    Note over TL: What did the architect decide?
    TL->>CS: context_query(project, "auth")
    CS->>TL: {auth_pattern: "JWT with refresh tokens", session_storage: "Redis"}

    Note over TL: Anything specific to this task chain?
    TL->>CS: context_query(conversation, correlationId="task-auth-001")
    CS->>TL: {auth_guards: "NestJS guards on all endpoints"}
```

The Team Lead didn't receive the Architect's full conversation. It queried two scopes and got exactly the decisions it needs. The Architect's internal reasoning, false starts, and consultation with the Product Owner are gone — only the distilled facts survived.

### Step 5 — The Developer Implements

The Moderator assigns the Developer to implement a ticket. Same pattern: thin envelope in, pull context, do work.

```mermaid
sequenceDiagram
    participant D as Developer
    participant CS as Context Store
    participant A as Architect

    Note over D: received: "Implement ticket QRM-042: login endpoint"

    D->>CS: context_query(project, "auth")
    CS->>D: {auth_pattern: "JWT", session_storage: "Redis"}

    D->>CS: context_query(conversation, "task-auth-001")
    CS->>D: {auth_guards: "NestJS guards", tickets: [...]}

    D->>D: Implementing...

    Note over D: Unclear about token rotation
    D->>A: invoke_agent(architect, "Refresh token rotation strategy?")
    A->>D: "Rotate on every use, 7-day absolute expiry"

    D->>CS: context_store(conversation, "token_rotation", "rotate on use, 7d expiry")
    D->>D: Implementation complete
```

The Developer pulled project and conversation context, consulted the Architect mid-task for clarification (the broker checks safeguards: depth is now 1, no circular call, Architect is available), then recorded its own implementation decision back to the conversation scope for whoever comes next.

### Step 6 — Context Housekeeping

As a task chain grows, context can accumulate. An agent can check the budget:

```
context_stats(conversation, "task-auth-001") → {itemCount: 14, estimatedTokens: 3200}
```

If it's getting heavy, the agent compresses:

```
context_summarize("task-auth-001", maxTokens=800, preserveKeys=["auth_pattern"])
```

This keeps the `auth_pattern` decision verbatim while truncating the rest. The summary is stored as a `_summary` key in the conversation scope, keeping agent context windows lean even on long-running tasks.

### What Didn't Happen

No agent received another agent's full conversation history. No context was duplicated at each hop. The Moderator's chat with the user, the Architect's internal reasoning, the Product Owner's clarification — none of that was serialized and forwarded. Each agent started lean, pulled what it needed by topic, recorded decisions as named facts, and returned a concise result.

```mermaid
graph LR
    A[Architect] -->|"stores: auth=JWT"| CS[(Context Store)]
    TL[Team Lead] -->|"stores: tickets=[...]"| CS
    CS -->|"queries: auth?"| D[Developer]
    CS -->|"queries: tickets?"| D
    D -->|"stores: token_rotation=..."| CS
```

In a traditional system, context flows through the call chain and grows at every hop. In Quorum, context flows through the store and agents take only what they need.

## Project Structure

NestJS monorepo with three applications and one shared library:

```
quorum/
├── apps/
│   ├── terminal/           # User-facing chat + Moderator LLM
│   ├── mcp-server/         # Communication backbone
│   └── agent/              # Single Docker image, multi-role via AGENT_ROLE env var
├── libs/
│   └── common/             # Shared types and config across all apps
│       └── src/
│           ├── config/         # Config factories (app, anthropic, mcp)
│           ├── context-store/  # Abstract ContextStore class + types
│           └── messaging/      # AgentRole enum, InvokeRequest/Response
├── docs/                   # Architecture documentation
├── tickets/                # Implementation timeline knowledge base
└── docker-compose.yml
```

## Getting Started

### Prerequisites

- Node.js
- Docker & Docker Compose
- Anthropic API key

### Setup

```bash
npm install
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and WORKSPACE_PATH
```

### Development

```bash
npm run start:dev          # Start default app (terminal) in watch mode
npm run build              # Build all apps
npm run lint               # Lint and auto-fix
npm run test               # Run unit tests
npm run test:e2e           # Run end-to-end tests
```

### Docker

```bash
export WORKSPACE_PATH=/path/to/your/project
./scripts/start.sh        # build & start all containers
./scripts/start.sh -d     # detached mode
```

The startup script exports `HOST_UID`/`HOST_GID` from the current user so container bind-mounts (logs, workspace) have correct file ownership, then runs `docker compose build` and `docker compose up`. Extra args are forwarded to both commands.

Starts the MCP server, terminal with moderator, and all agent containers. Agents register on startup and are ready to receive invocations.

## Documentation

| Document | What it covers |
|----------|----------------|
| [System Design](docs/system-design.md) | Architecture, containers, deployment, `quorum.md` config |
| [Agent Messaging](docs/agent-messaging.md) | Bidirectional MCP, `invoke_agent`, communication patterns |
| [Message Broker](docs/message-broker.md) | Routing, safeguards, transport, availability |
| [Context Management](docs/context-management.md) | MCP tools/resources API, usage patterns |
| [Context Store](docs/context-store.md) | Storage backends, InMemoryStore, OpenSearch |
| [Ticket Library](tickets/README.md) | Ticket conventions and structure guide |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: NestJS (monorepo, webpack)
- **LLM**: Anthropic Claude via `@anthropic-ai/sdk`
- **Protocol**: Model Context Protocol via `@modelcontextprotocol/sdk`
- **Containerization**: Docker Compose
- **Validation**: Zod
- **Testing**: Jest