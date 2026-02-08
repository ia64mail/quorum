# QRM1-003: NestJS Configuration Management — Per-App Configuration Services

## Summary

Implement centralized configuration management using NestJS `@nestjs/config` module with a per-app architecture: shared config factories in `libs/common/` for cross-app namespaces, app-specific config factories in each `apps/*/` directory, and a dedicated typed configuration service per application (`TerminalConfigService`, `McpServerConfigService`, `AgentConfigService`). Each app loads only the config namespaces it actually needs — Zod validation is strict with no optional workarounds. All `process.env` access is consolidated into config factory files; consuming code never references env var names or default values.

## Problem Statement

The codebase currently has three direct `process.env` reads scattered across `main.ts` bootstrap files (`apps/agent/src/main.ts:6`, `apps/mcp-server/src/main.ts:6`, `apps/terminal/src/main.ts:6` — all identical `process.env.port ?? 3000`). No `@nestjs/config` module is installed, no env var validation exists, and no centralized access point for configuration.

The next implementation phase — Message Broker — introduces configuration-heavy components: invocation depth limits (`MAX_CALL_DEPTH = 5` in `docs/message-broker.md`), per-role timeouts (5 different values), default broker timeout (300,000ms), context token budgets (2000 tokens default in `docs/context-management.md`). The LLM SDK integration requires API key management and model selection. Without a configuration foundation, each component will scatter `process.env` access across the codebase, duplicating defaults and making configuration changes fragile.

The problem compounds with Docker Compose: env vars flow from `.env` → `docker-compose.yml` → container `environment:` → NestJS app `process.env`. Without validation at the NestJS layer, misconfigured env vars (typos, missing values, wrong types) produce cryptic runtime errors instead of clear startup failures.

Risks of not doing this now:
- Every subsequent ticket (Message Broker, LLM integration, MCP tools) would introduce ad-hoc `process.env` reads, creating technical debt from day one
- No type safety on configuration values — a string where a number is expected fails silently
- No startup validation — misconfigured containers run and fail at unpredictable points
- Swapping defaults requires hunting across the codebase

## Design Context

### What NestJS Provides

`@nestjs/config` is the official NestJS configuration package (wraps `dotenv` internally). Its core primitives and how they map to the requirements:

| Requirement | NestJS Primitive |
|-------------|-----------------|
| "Each group in its own unit" | `registerAs(namespace, factory)` — one file per group, each returning a typed config object |
| "Default values at JSON level" | Factory body: `process.env.BROKER_MAX_CALL_DEPTH \|\| '5'` — env var name and default live only in the factory |
| "Config service doesn't know env var names or defaults" | `@Inject(config.KEY)` with `ConfigType<typeof config>` — injects resolved typed objects, no string lookups |
| "Use NestJS configuration module under the hood" | `ConfigModule.forRoot()` — official NestJS wrapper |

The `registerAs` factory pattern is the exact mechanism: each factory file is a self-contained unit that reads `process.env`, applies defaults, validates with Zod, and returns a plain typed object. Config services receive these pre-resolved objects via DI injection tokens — decoupled from both the env var names and the default values.

### Why Per-App, Not One Shared Service

The three Quorum applications are architecturally distinct components with limited config overlap:

| Namespace (vars) | terminal | mcp-server | agent | Used by |
|-------------------|:--------:|:----------:|:-----:|---------|
| `app` (2) | **needs** | **needs** | **needs** | all 3 |
| `anthropic` (2) | **needs** | — | **needs** | 2 of 3 |
| `mcp` (1) | **needs** | — | **needs** | 2 of 3 |
| `agent` (2) | — | — | **needs** | 1 of 3 |
| `broker` (2) | — | **needs** | — | 1 of 3 |
| `context` (2) | — | **needs** | — | 1 of 3 |

Irrelevant config per app: **terminal 55%**, **mcp-server 45%**, **agent 36%**. Only `app` (PORT, NODE_ENV) is truly universal. As the system grows (more broker tuning, more LLM params, UI settings), this ratio will skew further toward app-specific config.

A single shared `AppConfigurationService` loading all namespaces creates two problems:
1. **Zod validation degrades** — `ANTHROPIC_API_KEY` must be marked `optional()` because mcp-server doesn't have it, even though terminal and agent *require* it. Validation becomes permissive to accommodate the lowest common denominator.
2. **Types weaken** — optional namespaces produce `T | undefined` properties on the service. Consumers must null-check config that's guaranteed present in their app.

Per-app config services solve both: each app loads exactly its namespaces, Zod schemas are strict (required means required), and every property is non-nullable.

### Configuration Groups

Derived from the system design docs, `.env.example`, and the upcoming Message Broker/LLM integration requirements:

**Shared factories** (used by 2+ apps — live in `libs/common/`):

| Namespace | Env Vars | Default Values | Source |
|-----------|----------|----------------|--------|
| `app` | `PORT`, `NODE_ENV` | `3000`, `development` | All `main.ts` files |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | *(required, no default)*, `claude-sonnet-4-5-20250929` | `system-design.md` — Terminal App, Agent Containers |
| `mcp` | `MCP_SERVER_URL` | `http://mcp-server:3000` | `system-design.md` — Docker Compose config |

**App-specific factories** (used by 1 app — live in that app):

| Namespace | Env Vars | Default Values | App | Source |
|-----------|----------|----------------|-----|--------|
| `agent` | `AGENT_ROLE`, `AGENT_WORKSPACE_DIR` | `developer`, `/mnt/quorum/workspace` | agent | `system-design.md` — Agent Containers |
| `broker` | `BROKER_MAX_CALL_DEPTH`, `BROKER_DEFAULT_TIMEOUT_MS` | `5`, `300000` | mcp-server | `message-broker.md` |
| `context` | `CONTEXT_DEFAULT_MAX_TOKENS`, `CONTEXT_TOKEN_CHAR_RATIO` | `2000`, `4` | mcp-server | `context-management.md`, `context-store.md` |

### Where It Lives

Follows the established monorepo pattern: shared contracts in `libs/common/`, app-specific implementations in `apps/*/`. This mirrors the `ContextStore` design where the abstract class and types live in `libs/common/src/context-store/` while `InMemoryStore` lives in `apps/mcp-server/src/context-store/`.

- **Shared config factories** (`app`, `anthropic`, `mcp`) → `libs/common/src/config/`
- **App-specific config factories** → each app's `src/config/` directory
- **Per-app config service + module** → each app's `src/config/` directory

## Implementation Details

### 1. Install `@nestjs/config`

Add `@nestjs/config` to `dependencies` in `package.json`. This is the only new package — Zod (v4.3.6) is already available for schema validation.

### 2. Config Namespace Factory Pattern

Each `*.config.ts` file follows the same structure — `registerAs` factory with an internal Zod schema:

```typescript
// Conceptual pattern — broker.config.ts
export default registerAs('broker', () =>
  schema.parse({
    maxCallDepth: parseInt(process.env.BROKER_MAX_CALL_DEPTH || '5', 10),
    defaultTimeoutMs: parseInt(process.env.BROKER_DEFAULT_TIMEOUT_MS || '300000', 10),
  })
);
```

Key properties:
- **Env var name** exists only in the factory file — nowhere else in the codebase
- **Default value** exists only in the factory file — the `|| '5'` fallback
- **Zod validation** runs at factory execution time (during `ConfigModule.forRoot()` initialization) — invalid config crashes the app immediately with a clear Zod error, never silently proceeding
- **Type coercion** happens in the factory — `parseInt` for numbers, Zod `.transform()` where appropriate — consumers receive correctly typed values
- **Config services** receive the parsed, typed, validated object and know nothing about the env var or its default

One factory file per config group. Six files total: three shared in `libs/common/`, three app-specific.

### 3. Shared Config Factories

These live in `libs/common/src/config/` and are imported by multiple apps:

**`app.config.ts`** — `PORT`, `NODE_ENV`. Used by all three apps. Port parsed to number, NODE_ENV validated against an enum.

**`anthropic.config.ts`** — `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. Used by terminal and agent. API key validated as non-empty string (no default — required). Model has a default value.

**`mcp.config.ts`** — `MCP_SERVER_URL`. Used by terminal and agent. URL validated, default for docker-compose network.

Since these factories are loaded only by apps that need them, the Zod schemas are strict. `ANTHROPIC_API_KEY` is `z.string().min(1)` — not optional. If an app loads the `anthropic` namespace, the key must be present or the app fails at startup. Apps that don't need it (mcp-server) simply don't load it.

### 4. App-Specific Config Factories

**`apps/agent/src/config/agent.config.ts`** — `AGENT_ROLE`, `AGENT_WORKSPACE_DIR`. Only the agent app needs these. Role validated against the enum of known roles.

**`apps/mcp-server/src/config/broker.config.ts`** — `BROKER_MAX_CALL_DEPTH`, `BROKER_DEFAULT_TIMEOUT_MS`. Only the mcp-server needs these. Both parsed to numbers with sensible defaults from `docs/message-broker.md`.

**`apps/mcp-server/src/config/context.config.ts`** — `CONTEXT_DEFAULT_MAX_TOKENS`, `CONTEXT_TOKEN_CHAR_RATIO`. Only the mcp-server needs these. Defaults from `docs/context-management.md` and `docs/context-store.md`.

### 5. Per-App Config Services

Each app gets its own `@Injectable()` config service that injects only the namespaces that app actually uses:

**`TerminalConfigService`** — injects `app` + `anthropic` + `mcp`:

```typescript
@Injectable()
export class TerminalConfigService {
  constructor(
    @Inject(appConfig.KEY)       public readonly app: ConfigType<typeof appConfig>,
    @Inject(anthropicConfig.KEY) public readonly anthropic: ConfigType<typeof anthropicConfig>,
    @Inject(mcpConfig.KEY)       public readonly mcp: ConfigType<typeof mcpConfig>,
  ) {}
}
```

**`McpServerConfigService`** — injects `app` + `broker` + `context`:

```typescript
@Injectable()
export class McpServerConfigService {
  constructor(
    @Inject(appConfig.KEY)     public readonly app: ConfigType<typeof appConfig>,
    @Inject(brokerConfig.KEY)  public readonly broker: ConfigType<typeof brokerConfig>,
    @Inject(contextConfig.KEY) public readonly context: ConfigType<typeof contextConfig>,
  ) {}
}
```

**`AgentConfigService`** — injects `app` + `anthropic` + `mcp` + `agent`:

```typescript
@Injectable()
export class AgentConfigService {
  constructor(
    @Inject(appConfig.KEY)       public readonly app: ConfigType<typeof appConfig>,
    @Inject(anthropicConfig.KEY) public readonly anthropic: ConfigType<typeof anthropicConfig>,
    @Inject(mcpConfig.KEY)       public readonly mcp: ConfigType<typeof mcpConfig>,
    @Inject(agentConfig.KEY)     public readonly agent: ConfigType<typeof agentConfig>,
  ) {}
}
```

Every property is fully typed and non-nullable. Consumers access config with full IDE autocompletion:

    this.config.broker.maxCallDepth     // number (not number | undefined)
    this.config.anthropic.apiKey        // string (not string | undefined)
    this.config.app.port                // number

No `ConfigService.get('string.key')` lookups, no knowledge of env var names.

### 6. Per-App Config Modules

Each app has a config module that wraps `ConfigModule.forRoot()` with only its namespaces:

**`TerminalConfigModule`**:
```typescript
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, anthropicConfig, mcpConfig],
    }),
  ],
  providers: [TerminalConfigService],
  exports: [TerminalConfigService],
})
export class TerminalConfigModule {}
```

**`McpServerConfigModule`** — loads `appConfig`, `brokerConfig`, `contextConfig`.

**`AgentConfigModule`** — loads `appConfig`, `anthropicConfig`, `mcpConfig`, `agentConfig`.

Each app's root module (`TerminalModule`, `McpServerModule`, `AgentModule`) imports its config module. `isGlobal: true` ensures the config service is injectable anywhere within the app without re-importing the module.

The `.env` file loading behavior: `@nestjs/config` reads `.env` by default in development. In Docker containers, env vars come from `docker-compose.yml` `environment:` blocks. The default behavior (read `.env` if present, container env vars take precedence) works for both local dev and containerized runs without additional configuration.

### 7. Migrate Existing `process.env` Usage

The three `main.ts` files currently use `process.env.port ?? 3000`. After migration, each `main.ts` retrieves the port from its app's config service via `app.get()` (necessary because full DI context isn't available in the bootstrap function):

```typescript
// apps/mcp-server/src/main.ts — conceptual
const config = app.get(McpServerConfigService);
await app.listen(config.app.port);
```

This is the only place where `app.get()` is needed — everywhere else, standard constructor injection works.

### 8. Update `.env.example`

Add all new env vars with documentation, organized by namespace group:

```env
# === Application (all apps) ===
PORT=3000
NODE_ENV=development

# === Anthropic LLM API (terminal, agent) ===
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

# === MCP Server Connectivity (terminal, agent) ===
MCP_SERVER_URL=http://mcp-server:3000

# === Agent Identity (agent only) ===
AGENT_ROLE=developer
AGENT_WORKSPACE_DIR=/mnt/quorum/workspace

# === Message Broker (mcp-server only) ===
BROKER_MAX_CALL_DEPTH=5
BROKER_DEFAULT_TIMEOUT_MS=300000

# === Context Store (mcp-server only) ===
CONTEXT_DEFAULT_MAX_TOKENS=2000
CONTEXT_TOKEN_CHAR_RATIO=4

# === Docker Compose Only (not consumed by NestJS apps) ===
WORKSPACE_PATH=/path/to/target/project
DEVELOPER_COUNT=1
```

### 9. File Structure

```
libs/common/src/
  config/
    app.config.ts               # registerAs('app') — PORT, NODE_ENV
    anthropic.config.ts         # registerAs('anthropic') — API key, model
    mcp.config.ts               # registerAs('mcp') — server URL
    index.ts                    # Barrel export of shared factories

apps/terminal/src/
  config/
    terminal-config.service.ts  # Injects: app + anthropic + mcp
    terminal-config.module.ts   # ConfigModule.forRoot() with 3 namespaces
    index.ts

apps/mcp-server/src/
  config/
    broker.config.ts            # registerAs('broker') — depth, timeout
    context.config.ts           # registerAs('context') — token budget, ratio
    mcp-server-config.service.ts  # Injects: app + broker + context
    mcp-server-config.module.ts   # ConfigModule.forRoot() with 3 namespaces
    index.ts

apps/agent/src/
  config/
    agent.config.ts             # registerAs('agent') — role, workspace dir
    agent-config.service.ts     # Injects: app + anthropic + mcp + agent
    agent-config.module.ts      # ConfigModule.forRoot() with 4 namespaces
    index.ts
```

### 10. Testing Strategy

Unit tests for config factories and per-app config services:

**Factory tests** (per factory file):
- **Defaults**: factory returns correct defaults when no env vars are set
- **Overrides**: setting an env var overrides the default
- **Type coercion**: string env vars are correctly parsed to numbers
- **Zod validation**: invalid values (non-numeric string for a port, negative depth, empty API key) throw at startup with clear error messages
- **Required fields**: missing required env vars with no defaults (e.g., `ANTHROPIC_API_KEY`) throw

**Config service tests** (per app):
- **Wiring**: verify the service is injectable and all namespace properties are populated, using `Test.createTestingModule()` with the app's config module
- **Type correctness**: all properties are non-nullable (no `undefined` in the type)
- **Isolation**: mcp-server config module doesn't attempt to load `anthropic` namespace; agent config module doesn't load `broker` namespace

Mock `process.env` in tests via `jest.replaceProperty(process, 'env', { ... })` or by setting individual keys before module initialization.

## Acceptance Criteria

- [x] `@nestjs/config` installed and listed in `package.json` dependencies
- [x] Three shared config factory files in `libs/common/src/config/` (`app`, `anthropic`, `mcp`)
- [x] Three app-specific config factory files in their respective `apps/*/src/config/` directories (`agent`, `broker`, `context`)
- [x] Each factory file is self-contained: env var name, default value, and Zod validation schema live only in that file
- [x] `TerminalConfigService` in `apps/terminal/src/config/` injects `app` + `anthropic` + `mcp`
- [x] `McpServerConfigService` in `apps/mcp-server/src/config/` injects `app` + `broker` + `context`
- [x] `AgentConfigService` in `apps/agent/src/config/` injects `app` + `anthropic` + `mcp` + `agent`
- [x] All properties on all config services are non-nullable (no `T | undefined` for config the app requires)
- [x] Per-app config modules wrap `ConfigModule.forRoot({ isGlobal: true, load: [...] })` with only that app's namespaces
- [x] All three app root modules import their config module; all three `main.ts` files migrated from `process.env.port ?? 3000`
- [x] Zero `process.env` access outside of config factory files (enforced by code review)
- [x] `.env.example` updated with all env vars organized by namespace group, annotated with which apps consume them
- [x] Zod validation in each factory throws a clear error at startup for invalid configuration
- [x] Barrel exports from `libs/common/src/config/index.ts` (updated `libs/common/src/index.ts`) and each `apps/*/src/config/index.ts`
- [x] Unit tests pass covering factory defaults, overrides, coercion, validation, required-field enforcement, and per-app service wiring
- [x] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-001 — Core packages installed (NestJS, Zod available)
- QRM1-002 — Context Store implemented (existing module structure to integrate with)

### What This Blocks
- Message Broker implementation — needs `broker.maxCallDepth`, `broker.defaultTimeoutMs`
- LLM SDK integration — needs `anthropic.apiKey`, `anthropic.model`
- Context MCP tools — needs `context.defaultMaxTokens`, `context.tokenCharRatio`
- Docker Compose hardening — validated env vars prevent silent misconfiguration

### References
- [docs/system-design.md](../docs/system-design.md) — Container architecture, Docker Compose config, env var definitions
- [docs/message-broker.md](../docs/message-broker.md) — `MAX_CALL_DEPTH` (5), `defaultTimeout` (300,000ms), role-based timeouts
- [docs/context-management.md](../docs/context-management.md) — `maxTokens` default (2000), token budget concepts
- [docs/context-store.md](../docs/context-store.md) — Token estimation ratio (chars/4)
- [@nestjs/config on npm](https://www.npmjs.com/package/@nestjs/config) — Official NestJS configuration module
- [NestJS Configuration Documentation](https://docs.nestjs.com/techniques/configuration) — `registerAs`, `ConfigType`, `ConfigModule`

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-07

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/config/app.config.ts` | Created | `registerAs('app')` — `PORT` (int, 1–65535, default 3000), `NODE_ENV` (enum, default development) |
| `libs/common/src/config/anthropic.config.ts` | Created | `registerAs('anthropic')` — `ANTHROPIC_API_KEY` (required, no default), `ANTHROPIC_MODEL` (default claude-sonnet-4-5-20250929) |
| `libs/common/src/config/mcp.config.ts` | Created | `registerAs('mcp')` — `MCP_SERVER_URL` (URL-validated, default http://mcp-server:3000) |
| `libs/common/src/config/index.ts` | Created | Barrel export of shared factories |
| `libs/common/src/config/app.config.spec.ts` | Created | 7 tests: defaults, overrides, coercion, invalid port/nodeEnv, out-of-range port |
| `libs/common/src/config/anthropic.config.spec.ts` | Created | 5 tests: missing key, empty key, default model, override model, key passthrough |
| `libs/common/src/config/mcp.config.spec.ts` | Created | 3 tests: default URL, override, invalid URL |
| `libs/common/src/index.ts` | Modified | Added `export * from './config'` |
| `apps/terminal/src/config/terminal-config.service.ts` | Created | Injects `app` + `anthropic` + `mcp` |
| `apps/terminal/src/config/terminal-config.module.ts` | Created | `ConfigModule.forRoot()` with 3 namespaces |
| `apps/terminal/src/config/index.ts` | Created | Barrel export |
| `apps/terminal/src/config/terminal-config.service.spec.ts` | Created | 4 tests: wiring, non-nullable app/anthropic/mcp properties |
| `apps/terminal/src/terminal.module.ts` | Modified | Imported `TerminalConfigModule` |
| `apps/terminal/src/main.ts` | Modified | Replaced `process.env.port ?? 3000` with `config.app.port` via `app.get(TerminalConfigService)` |
| `apps/mcp-server/src/config/broker.config.ts` | Created | `registerAs('broker')` — `BROKER_MAX_CALL_DEPTH` (int, min 1, default 5), `BROKER_DEFAULT_TIMEOUT_MS` (int, min 1, default 300000) |
| `apps/mcp-server/src/config/context.config.ts` | Created | `registerAs('context')` — `CONTEXT_DEFAULT_MAX_TOKENS` (int, min 1, default 2000), `CONTEXT_TOKEN_CHAR_RATIO` (int, min 1, default 4) |
| `apps/mcp-server/src/config/mcp-server-config.service.ts` | Created | Injects `app` + `broker` + `context` |
| `apps/mcp-server/src/config/mcp-server-config.module.ts` | Created | `ConfigModule.forRoot()` with 3 namespaces |
| `apps/mcp-server/src/config/index.ts` | Created | Barrel export |
| `apps/mcp-server/src/config/broker.config.spec.ts` | Created | 6 tests: defaults, overrides, coercion, non-numeric, zero depth |
| `apps/mcp-server/src/config/context.config.spec.ts` | Created | 6 tests: defaults, overrides, coercion, non-numeric, zero ratio |
| `apps/mcp-server/src/config/mcp-server-config.service.spec.ts` | Created | 4 tests: wiring, non-nullable broker/context properties, isolation (no anthropic) |
| `apps/mcp-server/src/mcp-server.module.ts` | Modified | Imported `McpServerConfigModule` |
| `apps/mcp-server/src/main.ts` | Modified | Replaced `process.env.port ?? 3000` with `config.app.port` via `app.get(McpServerConfigService)` |
| `apps/agent/src/config/agent.config.ts` | Created | `registerAs('agent')` — `AGENT_ROLE` (enum of 5 roles, default developer), `AGENT_WORKSPACE_DIR` (string, default /mnt/quorum/workspace) |
| `apps/agent/src/config/agent-config.service.ts` | Created | Injects `app` + `anthropic` + `mcp` + `agent` |
| `apps/agent/src/config/agent-config.module.ts` | Created | `ConfigModule.forRoot()` with 4 namespaces |
| `apps/agent/src/config/index.ts` | Created | Barrel export |
| `apps/agent/src/config/agent.config.spec.ts` | Created | 5 tests: defaults, role override, all valid roles, invalid role, workspaceDir override |
| `apps/agent/src/config/agent-config.service.spec.ts` | Created | 3 tests: wiring, non-nullable agent properties, isolation (no broker) |
| `apps/agent/src/agent.module.ts` | Modified | Imported `AgentConfigModule` |
| `apps/agent/src/main.ts` | Modified | Replaced `process.env.port ?? 3000` with `config.app.port` via `app.get(AgentConfigService)` |
| `.env.example` | Modified | Reorganized by namespace group with app annotations |
| `package.json` | Modified | Added `@nestjs/config` dependency |

### Deviations from Ticket Spec

- **Named exports instead of default exports for `registerAs` factories.** The ticket showed `export default registerAs(...)` but the codebase convention (established in QRM1-002) uses named exports exclusively for barrel re-export consistency. Changed to `export const appConfig = registerAs(...)`. Consumers reference the injection token via `appConfig.KEY` identically.
- **`import type { ConfigType }` required in config services.** The ticket showed `import { ConfigType } from '@nestjs/config'` but `isolatedModules: true` + `emitDecoratorMetadata: true` requires type-only imports for symbols used only as type annotations in decorated constructors (TS1272). The `import type` form works because `@Inject(config.KEY)` provides the runtime injection token — NestJS doesn't rely on `design:paramtypes` metadata for explicitly injected parameters.
- **Env var mock strategy uses `process.env` replacement, not `jest.replaceProperty`.** The ticket suggested `jest.replaceProperty(process, 'env', { ... })` but the established test pattern from QRM1-002 (`in-memory-store.spec.ts`) saves `originalEnv`, replaces `process.env` in `beforeEach`, and restores in `afterEach`. Followed the existing convention for consistency.

### Verification

- `npm run build` — compiles successfully (all 3 apps)
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 71 tests passing (43 new + 28 existing across 14 suites)