# #17: MCP Server Bind Mount Removal

## Summary

Comment out the workspace bind mount on the `mcp-server` service in `docker-compose.yml` and drop the `MCP_WORKSPACE_DIR` environment variable. Audit confirmed the variable has exactly one consumer (`context-store.config.ts:14` for `InMemoryStore` file path), which is dead code under the OpenSearch backend. Two-line docker-compose cleanup, no source code changes required.

## Problem Statement

The `mcp-server` service in `docker-compose.yml` mounts the host workspace at `/mnt/quorum/workspace:rw` and exposes `MCP_WORKSPACE_DIR` pointing to that mount. This creates two problems:

- **Unnecessary host coupling.** The MCP server has no runtime need for the host filesystem under the OpenSearch backend — the bind mount is vestigial infrastructure from the pre-QRM5 `InMemoryStore` era when context was persisted to a file at `${MCP_WORKSPACE_DIR}/quorum.context`.
- **Blocks the QRM8 "no host bind mounts" goal.** Design Decision D4 targets zero active workspace bind mounts across all containers. The MCP server mount is the easiest to remove because it has no active consumers.

The original Concern #5 in the QRM8 roadmap worried that removing the mount might break "workspace resource serving." Audit disproved this: `context://project` and `context://conversation/{correlationId}` MCP resources go through the `ContextStore` abstraction (`mcp.service.ts:1181-1225`), not the filesystem.

## Implementation Details

This is a two-line change in `docker-compose.yml` with no source code modifications.

### 1. Comment out the bind mount (line 135)

```yaml
# Current (docker-compose.yml:135):
      - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw

# Target:
      # - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw  # mount only needed if switching back to inmemory backend for debug
```

The mount is commented rather than deleted. This preserves a debug escape hatch: if the system ever needs to fall back to `CONTEXT_STORE_BACKEND: inmemory`, uncommenting this single line restores the file persistence path.

### 2. Drop the `MCP_WORKSPACE_DIR` env var (line 112)

```yaml
# Current (docker-compose.yml:112):
      MCP_WORKSPACE_DIR: /mnt/quorum/workspace

# Target: line removed entirely
```

**Why removal is safe:** `MCP_WORKSPACE_DIR` has exactly one consumer — `context-store.config.ts:14`:

```typescript
path.join(process.env.MCP_WORKSPACE_DIR ?? '.', 'quorum.context')
```

The `?? '.'` default means the missing env var resolves to `path.join('.', 'quorum.context')`, which under the mcp-server's `WORKDIR /app` evaluates to `/app/quorum.context`. This path is never read or written under the OpenSearch backend (`CONTEXT_STORE_BACKEND: opensearch` at docker-compose.yml:118).

The `MigrationService.onModuleInit()` handles `ENOENT` gracefully (migration.service.ts:78-80) — it logs "No quorum.context file found — nothing to migrate" and returns. No crash, no error propagation.

### What does NOT change

- **No source code modifications.** `context-store.config.ts` continues to compile and function with the `?? '.'` default.
- **No test changes.** The config spec (`context-store.config.spec.ts`) already tests the default-path fallback (the `MCP_WORKSPACE_DIR` env is deleted in `beforeEach` at line 10).
- **No migration concerns.** The OpenSearch index is already populated; `MigrationService` no-ops on re-run when no file is present.
- **Other services unaffected.** Only the `mcp-server` service block is touched; agent and moderator bind mounts are separate concerns (addressed by #11 and #14).

## Acceptance Criteria

- [x] `docker-compose.yml` mcp-server bind mount (`${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) is commented out with an inline note: "mount only needed if switching back to inmemory backend for debug"
- [x] `MCP_WORKSPACE_DIR` env var removed from the `docker-compose.yml` mcp-server service environment block
- [x] No source code files modified — only `docker-compose.yml` touched
- [x] `npm run build` passes — no compilation errors
- [x] `npm run lint` passes — 0 errors, 0 warnings
- [x] `npm run test` passes — all existing tests pass, no regressions
- [x] System operates normally under the OpenSearch backend (verified by build + test suite; full runtime validation deferred to Phase 4 integration testing)

## Implementation Notes

**Files modified:** `docker-compose.yml` only (1 file, 1 insertion, 2 deletions).

**Changes:**
- Line 112 (`MCP_WORKSPACE_DIR: /mnt/quorum/workspace`) — removed entirely.
- Line 135 (`- ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) — commented out with inline note: `# mount only needed if switching back to inmemory backend for debug`.

**Deviations from spec:** None — implementation matches the ticket exactly.

**Verification results:** `npm run build` ✓, `npm run lint` ✓ (0 errors, 0 warnings), `npm run test` ✓ (788 tests, 46 suites, all passing).

## Dependencies and References

- **Implements:** Design Decision D8 from `tickets/8-workspace-isolation.md`
- **Resolves:** Concern #5 (MCP server bind mount audit)
- **Part of:** QRM8 Phase 1 (foundations, parallel) — independent of all other QRM8 tickets
- **No upstream dependencies** — this ticket has no prerequisites
- **Does not block:** any other QRM8 ticket (the MCP server mount is not consumed by agent or moderator isolation work)
- **Origin:** `MCP_WORKSPACE_DIR` was introduced by QRM2-011 (`tickets/QRM2-011-context-store-file-persistence.md`) for `InMemoryStore` file persistence; made vestigial by QRM5-009's OpenSearch backend migration
- **Architect review:** Not needed — trivial two-line docker-compose change following an established design decision (D8), no new abstractions or cross-system integration
