# QRM4-006: Configuration & Documentation

## Summary

Add `BOOTSTRAP_*` environment variables to `docker-compose.yml` for the MCP server service, and update three documentation files (`message-broker.md`, `context-management.md`, `system-design.md`) to reflect the now-implemented bootstrap context injection pipeline from QRM4-001 through QRM4-005.

## Problem Statement

The bootstrap context injection feature is fully implemented in code (types, assembly service, broker integration, prompt rendering, tests) but the documentation and Docker Compose configuration lag behind:

1. **docker-compose.yml** has no `BOOTSTRAP_*` env vars — operators cannot tune or disable the feature without modifying code. The config factory (QRM4-002) reads `BOOTSTRAP_ENABLED`, `BOOTSTRAP_MAX_TOKENS`, and `BOOTSTRAP_PROJECT_RATIO` from `process.env`, but these are not declared in the compose file, so operators rely on undocumented defaults.
2. **docs/message-broker.md** — the "Context Integration" section (line 249) still says bootstrap context is a "planned enhancement" and the `InvokeRequest` interface listing (lines 42–52) does not include the `bootstrapContext` field added by QRM4-001.
3. **docs/context-management.md** — the introduction (line 10) describes agents as receiving only "task description + correlation ID" on invocation. The Usage Patterns section has three patterns but no pattern for the new automatic bootstrap injection. Pattern 2 (Task Handoff) shows the old flow where agents must manually query for context.
4. **docs/system-design.md** — the "Future Considerations" section (line 424) lists "Bootstrap context injection" as a TODO. The "Context Management" subsection (line 268) describes agents as receiving "minimal bootstrap context (task description + correlation ID)" without mentioning the automatic injection.

Without these updates, new agents, operators, and contributors will not know the feature exists, how to configure it, or how it changed the invocation flow.

## Design Context

The complete QRM4 implementation chain is:

| Ticket | What it delivered |
|--------|-------------------|
| QRM4-001 | `BootstrapContext`, `BootstrapContextMeta` interfaces; `bootstrapContext` field on `InvokeRequest` |
| QRM4-002 | `BootstrapContextService.assemble()` — queries Context Store, applies token budget, returns assembled context or `null` |
| QRM4-003 | Broker calls `assemble()` after safeguard checks, attaches result to `request.bootstrapContext`, non-fatal on failure |
| QRM4-004 | `InvocationHandler.buildPrompt()` renders bootstrap context as `## Prior Decisions` section before the task action |
| QRM4-005 | Unit tests covering assembly, broker integration, and prompt rendering |

Configuration env vars (from `apps/mcp-server/src/config/bootstrap.config.ts`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOTSTRAP_ENABLED` | `true` | Master toggle — when `false`, assembly returns `null` (zero overhead) |
| `BOOTSTRAP_MAX_TOKENS` | `1000` | Total token budget for the assembled bootstrap payload |
| `BOOTSTRAP_PROJECT_RATIO` | `0.6` | Fraction of budget allocated to project-scope items (remainder goes to conversation-scope) |

## Implementation Details

### 1. Docker Compose — add `BOOTSTRAP_*` env vars to `mcp-server` service

In `docker-compose.yml`, add three environment variables to the `mcp-server` service's `environment` block (lines 40–46), grouped together with a comment:

```yaml
# Bootstrap context injection (QRM4)
BOOTSTRAP_ENABLED: ${BOOTSTRAP_ENABLED:-true}
BOOTSTRAP_MAX_TOKENS: ${BOOTSTRAP_MAX_TOKENS:-1000}
BOOTSTRAP_PROJECT_RATIO: ${BOOTSTRAP_PROJECT_RATIO:-0.6}
```

**Placement**: After the existing `MCP_WORKSPACE_DIR` variable (line 46), before the `volumes` key. This groups all MCP server-specific config together.

**Pattern**: Follow the existing convention of `${VAR:-default}` for operator-overridable defaults (see `ANTHROPIC_MODEL`, `MCP_REQUEST_TIMEOUT_MS` in `x-shared-env`). The defaults match `bootstrap.config.ts` exactly.

**Why only `mcp-server`**: The bootstrap assembly runs exclusively in the MCP server — the config factory is loaded by `McpServerConfigModule`. Agent containers and the terminal do not read these env vars.

### 2. docs/message-broker.md — update Context Integration section and InvokeRequest interface

Two changes in this file:

**a) Update the `InvokeRequest` interface listing (lines 42–52)**

Add the `bootstrapContext` field to the interface code block, after the existing `context` field:

```typescript
bootstrapContext?: BootstrapContext;  // Injected by broker — project + conversation context
```

Add a brief note after the `InvokeResponse` interface about the `BootstrapContext` type, or reference QRM4-001 types. Keep it concise — a one-liner pointing to `libs/common/src/messaging/invoke.types.ts` for the full definition.

**b) Replace the "Context Integration" section (lines 249–251)**

The current section is a single paragraph describing bootstrap as "planned." Replace it with a substantive section documenting the implemented flow:

Content to cover:
- The broker now queries the Context Store before delivering invocations via `BootstrapContextService.assemble()`
- Assembly fetches project-scope items always, conversation-scope items when `correlationId` is present
- Token budgeting: total budget (`BOOTSTRAP_MAX_TOKENS`), project/conversation split (`BOOTSTRAP_PROJECT_RATIO`), budget reclamation (unused project budget flows to conversation)
- The assembled `BootstrapContext` is attached to `request.bootstrapContext`
- Non-fatal: if assembly fails, a warning is logged and delivery proceeds without bootstrap context
- When disabled (`BOOTSTRAP_ENABLED=false`) or the store is empty, the field remains absent — zero behavioral change from the pre-QRM4 flow
- Agent-side: `InvocationHandler.buildPrompt()` renders the context as a `## Prior Decisions` section before the task action
- Include a sequence diagram showing: Broker → BootstrapContextService → ContextStore → attach to request → Agent renders in prompt

**Style**: Keep the documentation descriptive, not tutorial-like. Explain the flow and configuration, reference the source files, and link to `context-management.md` for the pattern description.

### 3. docs/context-management.md — add Pattern 4 and update introduction

Two changes in this file:

**a) Update the introduction paragraph (line 10)**

The current text says agents receive "minimal bootstrap context on invocation (task description + correlation ID), then query the Context Store for what they need." Update to reflect that the broker now automatically injects relevant context alongside the task description. The pull model remains the core principle — bootstrap injection is an optimization that reduces the need for initial queries, not a replacement for the pull model.

Suggested phrasing: agents receive a task description, correlation ID, and automatic bootstrap context (project and conversation decisions assembled by the broker), then query for additional detail as needed.

**b) Add "Pattern 4: Bootstrap Context Injection" after Pattern 3 (after line 291)**

This is the key new usage pattern. Content to cover:

- **Trigger**: Automatic — happens on every `invoke_agent` call when bootstrap is enabled
- **Flow**: Broker calls `BootstrapContextService.assemble(correlationId)` → fetches project-scope `getAll()` + conversation-scope `getAll()` → applies token budget → attaches to `request.bootstrapContext` → agent's `buildPrompt()` renders as `## Prior Decisions` section
- **Sequence diagram**: Show the broker, BootstrapContextService, ContextStore, and agent in a mermaid diagram illustrating automatic injection (contrast with Pattern 2's manual query)
- **Configuration**: Reference the three env vars and their defaults
- **Relationship to other patterns**: Bootstrap injection makes Pattern 2 (Task Handoff) less necessary for common decisions — agents no longer start blind. Agents still use explicit `context_query` for targeted lookups, detailed queries, or agent-scope data that bootstrap doesn't cover.

### 4. docs/system-design.md — update Future Considerations and Context Management

Two changes in this file:

**a) Update "Future Considerations" (lines 422–428)**

Remove the "Bootstrap context injection" bullet from the future considerations list — it is now implemented. Either:
- Delete the line entirely and leave the remaining future items, or
- Replace it with a brief note that it was implemented in QRM4, with a link to `message-broker.md#context-integration` for details

Prefer deletion — the other docs cover the implementation. Keeping a "was implemented" note in a futures list creates clutter.

**b) Update the Context Management subsection (lines 262–303)**

The "Core Principle" section (lines 267–272) describes the three-step agent flow:
1. Receive minimal bootstrap context (task description + correlation ID)
2. Query the Context Store for what they need
3. Store their decisions for others

Update step 1 to reflect that agents now also receive automatic bootstrap context (project-scope and conversation-scope decisions) injected by the broker. Steps 2 and 3 remain unchanged — agents still query for additional detail and store their own decisions.

Also update the `graph LR` diagram under "Core Principle" (lines 273–277) or add a note about broker-side injection feeding the agent before the agent's own queries.

## Acceptance Criteria

- [x] `docker-compose.yml` contains `BOOTSTRAP_ENABLED`, `BOOTSTRAP_MAX_TOKENS`, and `BOOTSTRAP_PROJECT_RATIO` env vars in the `mcp-server` service, using `${VAR:-default}` syntax with defaults matching `bootstrap.config.ts`
- [x] `docs/message-broker.md` `InvokeRequest` interface listing includes the `bootstrapContext` field
- [x] `docs/message-broker.md` "Context Integration" section describes the implemented bootstrap flow (assembly, budgeting, non-fatal error handling, agent rendering), not the "planned" placeholder
- [x] `docs/message-broker.md` includes a sequence diagram for the bootstrap injection flow
- [x] `docs/context-management.md` introduction reflects automatic bootstrap context injection
- [x] `docs/context-management.md` includes "Pattern 4: Bootstrap Context Injection" with a mermaid sequence diagram, configuration reference, and relationship to other patterns
- [x] `docs/system-design.md` "Future Considerations" no longer lists bootstrap context injection as a TODO
- [x] `docs/system-design.md` "Context Management" subsection reflects that agents receive automatic bootstrap context on invocation
- [x] All documentation changes are factually accurate against the implemented code (QRM4-001 through QRM4-005)
- [x] No code changes — this ticket is purely configuration and documentation

## Dependencies and References

**Prerequisites:**
- **QRM4-001** (✅ Complete) — `BootstrapContext` type, `bootstrapContext` field on `InvokeRequest`
- **QRM4-002** (✅ Complete) — `BootstrapContextService`, `bootstrap.config.ts` with env vars
- **QRM4-003** (✅ Complete) — Broker integration, non-fatal error handling
- **QRM4-004** (✅ Complete) — `buildPrompt()` renders `## Prior Decisions` section
- **QRM4-005** (✅ Complete) — Unit tests for the full pipeline

**Blocks:**
- Nothing — this is the final ticket in QRM4

**Key file references:**

| File | Relevance |
|------|-----------|
| `docker-compose.yml` | Add `BOOTSTRAP_*` env vars to `mcp-server` service |
| `docs/message-broker.md` | Update `InvokeRequest` listing and "Context Integration" section |
| `docs/context-management.md` | Update introduction and add Pattern 4 |
| `docs/system-design.md` | Update "Future Considerations" and "Context Management" subsection |
| `apps/mcp-server/src/config/bootstrap.config.ts` | Source of truth for env var names, defaults, and Zod schema |
| `apps/mcp-server/src/messaging/bootstrap-context.service.ts` | Assembly algorithm — reference for documentation accuracy |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | Broker integration — reference for flow documentation |
| `apps/agent/src/connection/invocation-handler.service.ts` | `buildPrompt()` rendering — reference for prompt format documentation |
| `libs/common/src/messaging/invoke.types.ts` | `BootstrapContext`, `BootstrapContextMeta` — reference for type documentation |
| `tickets/QRM4-000-roadmap.md` | Roadmap — QRM4-006 subtask description |
| `tickets/QRM4-001-extend-invoke-request-bootstrap-context.md` | Type foundation |
| `tickets/QRM4-002-bootstrap-context-assembly-service.md` | Assembly service and config |
| `tickets/QRM4-003-message-broker-integration.md` | Broker integration |
| `tickets/QRM4-004-agent-side-prompt-rendering.md` | Prompt rendering |

## Implementation Notes

**Status:** ✅ Complete — Accepted in review

**Files modified (4):**
- `docker-compose.yml` — Added `BOOTSTRAP_ENABLED`, `BOOTSTRAP_MAX_TOKENS`, `BOOTSTRAP_PROJECT_RATIO` env vars to `mcp-server` service after `MCP_WORKSPACE_DIR`, using `${VAR:-default}` pattern
- `docs/message-broker.md` — Added `bootstrapContext` field to `InvokeRequest` listing; replaced "planned" Context Integration section with full documentation (assembly flow, config table, error handling, agent rendering, mermaid sequence diagram)
- `docs/context-management.md` — Updated introduction to reflect automatic bootstrap injection; added Pattern 4: Bootstrap Context Injection with mermaid diagram, config table, and relationship to other patterns
- `docs/system-design.md` — Removed bootstrap injection from Future Considerations; updated Context Management step 1 and mermaid graph to show broker-mediated injection

**Deviations from ticket:** None — implementation follows the ticket spec exactly.

**Verification results:**
- `npm run build`: 4 apps compiled successfully
- `npm run lint`: 0 errors, 0 warnings
- `npm run test`: 511 passed, 0 failed, 39 suites

**Factual accuracy audit:** All documentation claims verified against source code — assembly algorithm, token estimation formula, budget reclamation, non-fatal error handling, prompt rendering format, config defaults, and backward compatibility all match the implemented code in QRM4-001 through QRM4-005.
