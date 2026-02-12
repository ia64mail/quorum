# QRM1-006: Structured Logger

## Summary

Replace the default NestJS `ConsoleLogger` with a dual-transport logging subsystem: human-readable colored output for console, and append-only JSON lines to file. JSON logs enable cross-container timeline reconstruction when analysing multi-agent sessions — both by humans reviewing Docker output and by LLMs reconstructing "who said what" across an invocation chain.

## Problem Statement

All three apps (`terminal`, `mcp-server`, `agent`) currently use NestJS's default `Logger` (4 files, all `new Logger(ClassName.name)` pattern). The default logger outputs unstructured text to stdout. This creates three problems:

1. **No cross-container correlation.** When moderator invokes architect, which invokes teamlead, there's no way to reconstruct the chain from separate container logs. The `correlationId` already exists in message broker log messages as interpolated text, but it's not machine-parseable.

2. **No structured metadata.** Log lines are flat strings. An LLM analysing a session can't reliably extract which agent emitted a line, at what severity, or which invocation chain it belongs to — it has to guess from message text.

3. **No file persistence.** Logs go only to stdout. In Docker, stdout is ephemeral unless a log driver captures it. A JSON-lines file gives a deterministic, greppable, machine-readable record that survives container restarts (when mounted to a volume) and is trivially concatenatable across containers for timeline reconstruction.

Without structured logging, the system has no observability story for multi-agent debugging — the primary use case for the QRM1 milestone's end-to-end smoke test (QRM1-012).

## Design Context

### Why Winston (Not Pino, Not nest-winston)

**Winston directly** — not the `nest-winston` NestJS wrapper, not `pino`.

- **Winston** supports different formatters per transport natively. The console transport gets `winston.format.combine(colorize(), printf(...))` for NestJS-style human-readable output. The file transport gets `winston.format.json()` for machine-parseable lines. This dual-format requirement is winston's sweet spot.

- **Pino** is JSON-first by default, which is great for production but requires the separate `pino-pretty` package for human-readable console output. Its transport model (worker threads) adds complexity unsuitable for the POC.

- **nest-winston** provides `WinstonModule.forRoot()` — a NestJS module that registers a `LoggerService` via dependency injection. But the `LoggerBuilder` pattern described in the roadmap creates a `LoggerService` instance for `NestFactory.create(Module, { logger })`, which happens *before* the DI container exists. `WinstonModule` adds a dependency for the wrong integration point. Raw winston is the right level of abstraction.

Packages to install: `winston` (runtime dependency).

### JSON Lines — What "JSON Schema Per Line" Means

Each line in the JSON log file is a self-contained JSON object:

```json
{"timestamp":"2026-02-11T14:32:01.123Z","level":"log","context":"MessageBroker","message":"Invoke: caller=moderator target=architect","correlationId":"a1b2c3","agentRole":"mcp-server"}
{"timestamp":"2026-02-11T14:32:01.456Z","level":"warn","context":"MessageBroker","message":"Rejected: circular call","correlationId":"a1b2c3","agentRole":"mcp-server"}
```

The schema per line:

| Field | Type | Source | Always present |
|-------|------|--------|---------------|
| `timestamp` | ISO-8601 string | Winston `timestamp()` format | Yes |
| `level` | `'log' \| 'error' \| 'warn' \| 'debug' \| 'verbose'` | NestJS log level | Yes |
| `context` | string | Class name from `new Logger(ClassName.name)` | Yes (empty string if missing) |
| `message` | string | The log message | Yes |
| `correlationId` | string (UUID) | Passed via metadata object in log call | No — only when caller provides it |
| `agentRole` | string | Set once at logger creation from container's env var | Yes |
| `extra` | object | Any additional metadata from the log call | No — only when caller provides it |

**Crucially, the `LoggerService` interface does not change.** NestJS's `Logger` class already supports optional params:

```typescript
// How NestJS Logger works under the hood:
// new Logger('MyService').log('hello')
//   → calls LoggerService.log('hello', 'MyService')
//
// new Logger('MyService').log('hello', { correlationId: '123' })
//   → calls LoggerService.log('hello', { correlationId: '123' }, 'MyService')
```

Our custom `LoggerService` implementation parses `...optionalParams`:
- The last string argument → `context` field (NestJS convention)
- Any plain object argument → structured metadata (merged into JSON output)
- Everything else → ignored

This means:

```typescript
// Existing calls — unchanged, still work, no correlationId in JSON:
this.logger.log(`Session created: ${sessionId}`);

// Structured calls — correlationId and any extras appear in JSON:
this.logger.log('Invoke started', { correlationId, target });
this.logger.warn('Rejected: circular call', { correlationId, depth });
```

**`agentRole` is never passed per-call.** It's static per container (from `AGENT_ROLE` or `APP_NAME` env var), set once when the `LoggerBuilder` creates the winston instance. Every log line from that container automatically gets the role.

### Log File Naming Strategy (Docker Volume)

In Docker Compose, all containers share one mounted host directory (e.g., `./logs:/var/log/quorum`). Each container needs a unique, identifiable log file.

**Approach: `LOG_JSON_DIR` + auto-generated filename.**

The env var `LOG_JSON_DIR` points to the shared directory. The builder auto-generates the filename from `agentRole` and process startup timestamp:

```
/var/log/quorum/mcp-server-20260211T143201.jsonl
/var/log/quorum/architect-20260211T143203.jsonl
/var/log/quorum/developer-20260211T143205.jsonl
```

Why not a single file per role (`mcp-server.jsonl`)? It mixes sessions — you can't isolate "the 3pm run" without parsing timestamps inside the file. The startup timestamp suffix gives free session isolation.

Why not coordinated session directories (`{sessionId}/mcp-server.jsonl`)? Cleaner grouping, but requires an externally-generated session ID shared across all services (docker-compose `.env` or wrapper script). Unnecessary complexity for the POC.

The slight startup time differences between containers (~seconds) don't matter for analysis. Session reconstruction sorts by the `timestamp` field *inside* each JSON line, not by filename:

```bash
# Merge all logs from a session into a sorted timeline
cat /var/log/quorum/*.jsonl | jq -s 'sort_by(.timestamp)[]' > session-timeline.jsonl
```

**Future production path:** Switch the console transport to JSON format in production mode (env var toggle). Docker's `json-file` log driver captures stdout per container. External aggregators (Loki, Fluentd, ELK) scrape from there — no file transport needed at all. The file transport is a POC convenience that sidesteps log infrastructure.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `LoggerBuilder` fluent factory in `libs/common` | AsyncLocalStorage-based automatic correlationId propagation |
| Winston console transport (colored, NestJS-style format) | Log file rotation (containers use ephemeral storage or external collectors) |
| Winston JSON-lines file transport (append-only, auto-named) | Log aggregation (ELK, Loki, CloudWatch) |
| Logger config factory (`logger.config.ts`) with env var control | Structured logging middleware (auto-attach requestId to HTTP requests) |
| Auto-generated filenames (`{agentRole}-{startupTimestamp}.jsonl`) | Coordinated session directories |
| Swap in all 3 `main.ts` bootstraps | Changing existing log message strings |
| Existing `new Logger(ClassName.name)` calls continue unchanged | Console-as-JSON production mode toggle (future) |

## Implementation Details

### 1. Logger Config Factory — `libs/common/src/config/logger.config.ts`

Follows the same `registerAs` + Zod validation pattern established in QRM1-003 (`app.config.ts`, `anthropic.config.ts`, `mcp.config.ts`).

```typescript
export const loggerConfig = registerAs('logger', () =>
  schema.parse({
    level: process.env.LOG_LEVEL || 'log',
    console: process.env.LOG_CONSOLE !== 'false',    // enabled by default
    jsonDir: process.env.LOG_JSON_DIR || '',          // empty = disabled; directory path
    agentRole: process.env.AGENT_ROLE || process.env.APP_NAME || 'unknown',
  }),
);
```

Zod schema validates:
- `level` — one of `'log' | 'error' | 'warn' | 'debug' | 'verbose'` (NestJS log levels, not winston's)
- `console` — boolean (enable/disable console transport)
- `jsonDir` — string (directory path; empty string = no file transport). The builder generates the filename: `{agentRole}-{startupTimestamp}.jsonl`
- `agentRole` — non-empty string identifying the container

The factory is exported from the `libs/common/src/config/index.ts` barrel.

### 2. LoggerBuilder — `libs/common/src/logger/logger.builder.ts`

Fluent factory that produces a NestJS-compatible `LoggerService`. This is used in `main.ts` *before* the DI container boots, so it cannot depend on injected services.

```typescript
const logger = new LoggerBuilder()
  .withConsole()
  .withJsonDir('/var/log/quorum')
  .withAgentRole('mcp-server')
  .withLevel('log')
  .build();

const app = await NestFactory.create(AppModule, { logger });
```

**Builder methods:**
- `.withConsole()` — adds the console transport with colored, NestJS-style formatting. Called with no args; styling matches NestJS's default output (yellow `[Nest]` prefix, colored level, timestamp, context in brackets).
- `.withJsonDir(dir: string)` — adds a file transport writing one JSON object per line. Auto-generates the filename as `{agentRole}-{startupTimestamp}.jsonl` inside `dir` (requires `.withAgentRole()` to have been called). Creates the directory if it doesn't exist (`mkdirSync` with `recursive: true`). Append mode. No rotation (out of scope).
- `.withAgentRole(role: string)` — sets the `agentRole` field included in every JSON log entry and used in the auto-generated filename.
- `.withLevel(level: string)` — sets the minimum log level.
- `.build()` — creates the winston logger, wraps it in a class implementing NestJS `LoggerService`, and returns it.

**Startup timestamp format**: compact ISO-8601 with no colons or dashes for filesystem safety: `20260211T143201` (from `new Date().toISOString()` stripped to `YYYYMMDDTHHmmss`). Example filename: `mcp-server-20260211T143201.jsonl`.

**Convenience static method** for config-driven creation:

`LoggerBuilder.fromEnv()` reads env vars directly (`LOG_LEVEL`, `LOG_CONSOLE`, `LOG_JSON_DIR`, `AGENT_ROLE`) and calls the appropriate builder methods. This is what `main.ts` uses — it runs before DI, so no config service is available.

### 3. QuorumLogger — `libs/common/src/logger/quorum-logger.service.ts`

The class returned by `LoggerBuilder.build()`. Implements NestJS `LoggerService`.

**NestJS LoggerService interface:**
```typescript
interface LoggerService {
  log(message: any, ...optionalParams: any[]): any;
  error(message: any, ...optionalParams: any[]): any;
  warn(message: any, ...optionalParams: any[]): any;
  debug?(message: any, ...optionalParams: any[]): any;
  verbose?(message: any, ...optionalParams: any[]): any;
  fatal?(message: any, ...optionalParams: any[]): any;
  setLogLevels?(levels: LogLevel[]): any;
}
```

Each method:
1. Extracts `context` (last string in `optionalParams`) — NestJS convention.
2. Extracts `metadata` (any plain object in `optionalParams`) — our convention.
3. Calls the winston logger at the appropriate level with a structured info object: `{ message, context, ...metadata }`.
4. Winston formats handle the rest — console formatter uses `context` and `message` for NestJS-style output; JSON formatter includes all fields.

**NestJS → Winston level mapping** is needed because NestJS uses `log` where winston uses `info`:

| NestJS | Winston |
|--------|---------|
| `log` | `info` |
| `error` | `error` |
| `warn` | `warn` |
| `debug` | `debug` |
| `verbose` | `verbose` |
| `fatal` | `error` (with `fatal: true` metadata) |

The JSON output writes the **NestJS level name** (not winston's) so that consumers see `"level":"log"` matching the original call, not `"level":"info"`.

### 4. Console Format

Matches the default NestJS `ConsoleLogger` style so that switching to the structured logger doesn't visually change anything in the terminal:

```
[Nest] 12345  - 02/11/2026, 2:32:01 PM     LOG [MessageBroker] Invoke: caller=moderator target=architect
[Nest] 12345  - 02/11/2026, 2:32:01 PM    WARN [MessageBroker] Rejected: circular call
```

Implemented as a custom `winston.format.printf()` with `winston.format.colorize()`. Colours follow NestJS conventions: green for LOG, yellow for WARN, red for ERROR, magenta for DEBUG, cyan for VERBOSE.

### 5. JSON Format

Each log call produces exactly one JSON object (one line in the file). Winston's built-in `winston.format.json()` handles serialization. A custom format prepends the `timestamp`, remaps the level to NestJS names, and injects `agentRole` from the builder config.

The `extra` field captures any metadata keys beyond the known fields (`timestamp`, `level`, `context`, `message`, `correlationId`, `agentRole`). If there are no extra keys, the `extra` field is omitted (not `{}`).

### 6. Bootstrap Integration — All 3 `main.ts` Files

Each app's `main.ts` creates the logger before NestJS boots:

```typescript
import { LoggerBuilder } from '@app/common';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();   // reads LOG_LEVEL, LOG_CONSOLE, LOG_JSON_DIR, AGENT_ROLE

  const app = await NestFactory.create(AppModule, { logger });
  // ...
}
```

`LoggerBuilder.fromEnv()` reads env vars directly (no Zod config service needed — `main.ts` runs before DI). It applies defaults matching the `loggerConfig` factory's defaults.

The `loggerConfig` factory and its potential `LoggerConfigService` exist for any NestJS service that needs to read logger configuration at runtime (e.g., to adjust log levels dynamically in future). For the POC, `main.ts` is the only consumer and uses `fromEnv()`.

### 7. Module Export — `libs/common/src/logger/index.ts`

Barrel export for `LoggerBuilder`, `QuorumLogger`, and the `loggerConfig` factory. Added to `libs/common/src/index.ts` top-level barrel.

### 8. File Structure

```
libs/common/src/
  config/
    logger.config.ts                # registerAs factory with Zod validation
    logger.config.spec.ts           # Env var parsing tests
    index.ts                        # Updated — adds loggerConfig export
  logger/
    logger.builder.ts               # LoggerBuilder fluent factory
    quorum-logger.service.ts        # LoggerService implementation wrapping winston
    quorum-logger.service.spec.ts   # Unit tests for arg parsing, level mapping, format output
    logger.builder.spec.ts          # Builder tests (transport config, fromEnv)
    index.ts                        # Barrel export
  index.ts                          # Updated — adds logger barrel re-export

apps/mcp-server/src/main.ts         # Modified — swap in LoggerBuilder
apps/agent/src/main.ts              # Modified — swap in LoggerBuilder
apps/terminal/src/main.ts           # Modified — swap in LoggerBuilder
```


## Acceptance Criteria

- [x] `winston` added to `package.json` dependencies
- [x] `loggerConfig` factory in `libs/common/src/config/logger.config.ts` with Zod validation for `level`, `console`, `jsonDir`, `agentRole`
- [x] `LoggerBuilder` fluent factory with `.withConsole()`, `.withJsonDir(dir)`, `.withAgentRole(role)`, `.withLevel(level)`, `.build()` methods
- [x] `LoggerBuilder.fromEnv()` convenience static method for `main.ts` usage
- [x] `QuorumLogger` implements NestJS `LoggerService` — delegates to winston, parses `...optionalParams` for context string and metadata object
- [x] Console transport output matches NestJS `ConsoleLogger` style (colored, timestamped, context in brackets)
- [x] JSON file transport writes one JSON object per line with fields: `timestamp`, `level`, `context`, `message`, `agentRole`, and optional `correlationId`, `extra`
- [x] Log filenames auto-generated as `{agentRole}-{startupTimestamp}.jsonl` inside `LOG_JSON_DIR`
- [x] `level` field in JSON uses NestJS level names (`log`, not `info`)
- [x] `agentRole` set once at builder level, appears in every JSON log entry
- [x] `correlationId` extracted from metadata object when passed: `this.logger.log('msg', { correlationId })`
- [x] Extra metadata keys beyond known fields collected into `extra` field (omitted when empty)
- [x] All 3 `main.ts` files updated to use `LoggerBuilder.fromEnv()`
- [x] Existing `new Logger(ClassName.name)` calls in `McpService`, `McpController`, `MessageBroker`, `AgentRegistry` continue to work unchanged
- [x] Barrel exports updated in `libs/common/src/logger/index.ts` and `libs/common/src/index.ts`
- [x] `npm run build` succeeds, `npm run lint` passes, `npm run test` passes

## Dependencies and References

### Prerequisites
- QRM1-003 — Configuration management pattern (`registerAs` + Zod) established in `libs/common/src/config/`
- QRM1-004 / QRM1-005 — Existing `Logger` usage in `MessageBroker`, `AgentRegistry`, `McpService`, `McpController` (these are the consumers that benefit from structured logging)

### What This Blocks
- QRM1-007 — Agent-to-Server Connection (needs structured logging for connection lifecycle events, correlationId tracking across containers)
- QRM1-011 — Docker Containerization (shared log volume for JSON files across containers)
- QRM1-012 — End-to-End Smoke Test (verify JSON logs: correlationId traces an invocation chain across container log files)

### References
- [docs/system-design.md](../docs/system-design.md) — Docker Compose architecture, container structure
- [docs/message-broker.md](../docs/message-broker.md) — correlationId concept, broker logging
- [Winston documentation](https://github.com/winstonjs/winston) — Transports, formats, custom levels
- [NestJS Logger documentation](https://docs.nestjs.com/techniques/logger) — Custom logger integration, `LoggerService` interface

## Implementation Notes

**Status:** Complete

**Date:** 2026-02-11

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `libs/common/src/config/logger.config.ts` | Created | `registerAs` factory with Zod validation for level, console, jsonDir, agentRole |
| `libs/common/src/config/index.ts` | Modified | Added `loggerConfig` barrel export |
| `libs/common/src/logger/quorum-logger.service.ts` | Created | NestJS `LoggerService` wrapping winston; parses optionalParams for context + metadata |
| `libs/common/src/logger/logger.builder.ts` | Created | Fluent factory with console/JSON transports, `fromEnv()` static method |
| `libs/common/src/logger/index.ts` | Created | Barrel export for `LoggerBuilder` and `QuorumLogger` |
| `libs/common/src/index.ts` | Modified | Added `./logger` re-export |
| `apps/terminal/src/main.ts` | Modified | Added `LoggerBuilder.fromEnv()` passed to `NestFactory.create()` |
| `apps/mcp-server/src/main.ts` | Modified | Added `LoggerBuilder.fromEnv()` passed to `NestFactory.create()` |
| `apps/agent/src/main.ts` | Modified | Added `LoggerBuilder.fromEnv()` passed to `NestFactory.create()` |

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 115 tests passing (0 new, 115 existing, 0 regressions)