# QRM2-011: Context Store File Persistence

## Summary

Add file-based persistence to `InMemoryStore` so context survives MCP server restarts. Serialize the store to `quorum.context` (alongside `quorum.md` in the workspace root) on graceful shutdown, and reload it on startup. No new dependencies — just `fs/promises` and NestJS lifecycle hooks.

## Problem Statement

The `InMemoryStore` is entirely volatile. Every MCP server restart — whether from a code change, a Docker rebuild, or an accidental container kill — wipes all stored context: project decisions, conversation state, agent scratchpads. This forces agents to re-establish shared knowledge from scratch each session.

For the POC phase this was acceptable, but as multi-step workflows grow longer and agent collaboration becomes more stateful, losing context on restart is a real friction point. The production path (OpenSearch) is not in scope yet, but a lightweight file-based bridge gives us persistence with zero infrastructure cost.

## Design Context

The `InMemoryStore` is a `Map<string, ContextItem>` where both keys (composite strings) and values (`ContextItem` with JSON-serializable payloads) are trivially serializable. The store already uses `JSON.stringify` for token estimation, confirming all values round-trip through JSON.

The workspace root (`/mnt/quorum/workspace` in containers, `${WORKSPACE_PATH:-.}` on host) already holds `quorum.md` — the project configuration file read by the terminal on startup. Placing `quorum.context` next to it keeps all project-specific state in one location, shipped together with the workspace setup. No new volumes or bind-mounts are needed for agents or terminal — only the MCP server needs the workspace volume added (it currently has only the logs volume).

NestJS provides `OnModuleInit` and `OnModuleDestroy` lifecycle hooks, which map cleanly to load-on-startup and save-on-shutdown.

## Implementation Details

### 1. Add Workspace Volume to MCP Server

In `docker-compose.yml`, add the workspace bind-mount to the `mcp-server` service:

```yaml
mcp-server:
  volumes:
    - ./logs:/app/logs
    - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
```

The mount must be `rw` — the MCP server needs to write `quorum.context` on shutdown.

Add a `MCP_WORKSPACE_DIR` environment variable to the mcp-server service (matching the pattern of `TERMINAL_WORKSPACE_DIR` and `AGENT_WORKSPACE_DIR`):

```yaml
environment:
  <<: *shared-env
  PORT: 3000
  ENABLE_TEST_ENDPOINTS: "true"
  MCP_WORKSPACE_DIR: /mnt/quorum/workspace
```

### 2. Configuration

Add a config value for the context file path. In the MCP server's config (or a new `context-store.config.ts`), resolve the file path:

```typescript
// Default: <workspaceDir>/quorum.context
// Env: CONTEXT_STORE_PATH (full path override)
contextStorePath: env.CONTEXT_STORE_PATH
  ?? path.join(env.MCP_WORKSPACE_DIR ?? '.', 'quorum.context')
```

This allows operators to override the path entirely via `CONTEXT_STORE_PATH`, but the default "next to `quorum.md`" behavior requires no configuration.

### 3. Serialization Format

Plain JSON — an array of `[compositeKey, ContextItem]` tuples (the natural `Map` entries format):

```json
[
  ["project:_:tech_stack", { "key": "tech_stack", "value": {...}, "scope": "project", "createdAt": 1710400000000 }],
  ["conversation:task-001:decision", { "key": "decision", "value": "JWT", "scope": "conversation", "id": "task-001", "createdAt": 1710400100000, "expiresAt": 1710403700000 }]
]
```

This format round-trips with `new Map(parsed)` / `[...map.entries()]` — no transformation needed.

### 4. Load on Startup (`OnModuleInit`)

Implement `OnModuleInit` on `InMemoryStore`:

```typescript
async onModuleInit(): Promise<void> {
  try {
    const raw = await readFile(this.contextFilePath, 'utf-8');
    const entries: [string, ContextItem][] = JSON.parse(raw);
    const now = Date.now();

    for (const [compositeKey, item] of entries) {
      if (item.expiresAt !== undefined && now >= item.expiresAt) {
        continue; // Skip expired items — don't even load them
      }
      this.store.set(compositeKey, item);
    }

    this.logger.log(`Context loaded: ${this.store.size} items from ${this.contextFilePath}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      this.logger.log('No context file found — starting with empty store');
      return;
    }
    this.logger.warn(`Failed to load context file: ${err.message}`);
  }
}
```

Key behaviors:
- Missing file (`ENOENT`) is not an error — expected on first run
- Expired items are pruned during load, not persisted back
- Parse errors log a warning and start with empty store (don't crash)

### 5. Save on Graceful Shutdown (`OnModuleDestroy`)

Implement `OnModuleDestroy` on `InMemoryStore`:

```typescript
async onModuleDestroy(): Promise<void> {
  const now = Date.now();
  const entries: [string, ContextItem][] = [];

  for (const [compositeKey, item] of this.store) {
    if (item.expiresAt !== undefined && now >= item.expiresAt) {
      continue; // Don't persist expired items
    }
    entries.push([compositeKey, item]);
  }

  const tmpPath = this.contextFilePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
  await rename(tmpPath, this.contextFilePath);

  this.logger.log(`Context saved: ${entries.length} items to ${this.contextFilePath}`);
}
```

Key behaviors:
- Atomic write via tmp+rename — prevents corruption if the process is killed mid-write
- Expired items stripped before serialization
- Pretty-printed JSON (2-space indent) for debuggability — file is small enough that compactness doesn't matter

### 6. Inject Dependencies

`InMemoryStore` currently takes only `EventEmitter2`. It will additionally need:
- A logger instance (for load/save status messages)
- The resolved context file path (from config)

Use `@Inject(contextStoreConfig.KEY)` for the config, and NestJS `Logger` for logging. The constructor signature becomes:

```typescript
constructor(
  private readonly eventEmitter: EventEmitter2,
  @Inject(contextStoreConfig.KEY) private readonly config: ConfigType<typeof contextStoreConfig>,
  private readonly logger: Logger,
) {
  super();
  this.contextFilePath = this.config.contextStorePath;
}
```

### 7. Non-Docker (Bare Metal) Behavior

When running outside Docker (`npm run start:dev`), `MCP_WORKSPACE_DIR` won't be set. The config fallback uses `'.'` (cwd), so `quorum.context` is written to the project root — same directory as `quorum.md`. This matches the Docker behavior without any special casing.

## Known Limitations

- **Non-graceful shutdown**: `OnModuleDestroy` does not fire on `SIGKILL`, OOM kills, or power loss. Context written since last graceful shutdown is lost. Acceptable for POC — production will use OpenSearch with write-through persistence.
- **No concurrent access safety**: If multiple MCP server instances share the same workspace (not a current scenario), last-write-wins. No file locking.
- **No schema versioning**: If `ContextItem` shape changes in a future ticket, old `quorum.context` files may fail to parse. Mitigation: the load path already handles parse errors gracefully (warns and starts empty).

## Acceptance Criteria

- [x] MCP server loads `quorum.context` on startup, populating the in-memory Map
- [x] Missing file on first startup logs info and starts with empty store (no error)
- [x] Corrupt/unparseable file logs a warning and starts with empty store (no crash)
- [x] Expired items in the file are pruned during load
- [x] MCP server writes `quorum.context` on graceful shutdown (SIGTERM / app.close())
- [x] Expired items are excluded from the written file
- [x] Write uses atomic tmp+rename pattern
- [x] `quorum.context` lives in the workspace root alongside `quorum.md`
- [x] `docker-compose.yml` mounts the workspace volume into mcp-server as rw
- [x] `MCP_WORKSPACE_DIR` env var added to mcp-server service
- [x] File path is configurable via `CONTEXT_STORE_PATH` env var (optional override)
- [x] Non-Docker mode (`npm run start:dev`) writes to cwd by default
- [x] Existing unit tests pass (`npm run test` — 0 regressions)
- [x] New unit tests cover: load from file, load with expired items, load with missing file, load with corrupt file, save to file, save excludes expired items, atomic write

## Dependencies and References

- **Requires:** QRM1-002 (`InMemoryStore`), QRM1-003 (config pattern)
- **Builds on:** QRM1-011 (Docker setup, volume mounts)
- **Files to modify:**
  - `apps/mcp-server/src/context-store/in-memory-store.ts` — add lifecycle hooks, load/save logic
  - `apps/mcp-server/src/context-store/in-memory-store.spec.ts` — new test cases
  - `docker-compose.yml` — workspace volume + env var for mcp-server
  - New: `apps/mcp-server/src/context-store/context-store.config.ts` (or extend existing mcp-server config)

## Implementation Notes

**Status:** Complete

**Date:** 2026-03-15

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Modified | Added `OnModuleInit`/`OnModuleDestroy` lifecycle hooks, `Logger`, config injection, file load/save with atomic writes |
| `apps/mcp-server/src/context-store/in-memory-store.spec.ts` | Modified | 9 new test cases covering all persistence scenarios (load, expired pruning, ENOENT, corrupt file, non-array JSON, save, expired exclusion, atomic write, write failure) |
| `apps/mcp-server/src/config/context-store.config.ts` | Created | Zod-validated `registerAs` config for `contextStorePath` with `CONTEXT_STORE_PATH` / `MCP_WORKSPACE_DIR` env var resolution |
| `apps/mcp-server/src/config/index.ts` | Modified | Barrel re-export for `contextStoreConfig` |
| `apps/mcp-server/src/config/mcp-server-config.module.ts` | Modified | Added `contextStoreConfig` to `ConfigModule.forRoot` load array |
| `docker-compose.yml` | Modified | Added `MCP_WORKSPACE_DIR` env var and workspace bind-mount to mcp-server service |
| `apps/agent/src/llm/sdk-hooks.factory.spec.ts` | Modified | Formatting cleanup (no functional change), added missing newline at EOF |

### Deviations from Ticket Spec

- **Config file placed in `config/` not `context-store/`.** The ticket suggested `apps/mcp-server/src/context-store/context-store.config.ts` but the implementation correctly placed it in `apps/mcp-server/src/config/context-store.config.ts` to follow the established per-app config module pattern (alongside `broker.config.ts`, `context.config.ts`).

- **`Array.isArray` guard added on load.** The ticket's pseudocode cast `JSON.parse` output directly. The implementation adds a structural guard that rejects valid JSON that isn't an array (e.g., `{"not": "an array"}`), logging a warning and starting empty — same as the corrupt-file path.

- **`onModuleDestroy` wrapped in try/catch.** The ticket's pseudocode had no error handling on the save path. A write failure (disk full, permissions) during shutdown would propagate and potentially block other `OnModuleDestroy` hooks. The implementation catches and logs the error without rethrowing.

### Verification

```
npm run build   → 4 apps compiled successfully
npm run lint    → clean
npm run test    → 33 passed in in-memory-store.spec.ts (9 new persistence tests + 24 existing)
```