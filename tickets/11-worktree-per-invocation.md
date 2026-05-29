# #11: Git Worktree Per Invocation + Agent-Side Repository Infrastructure

## Summary

Each agent invocation creates an isolated git worktree at `/var/agent-worktrees/<correlationId>` and the SDK subprocess runs there instead of the shared workspace. This is the central deliverable of QRM8 -- it eliminates the shared-working-tree concurrency problem. Includes agent-side git clone infrastructure (new named volume for the base repo, first-boot clone in entrypoint, `git fetch` before each worktree add), `cwd` parameterization through `ExecuteParams`, a new required `branch` field on `InvokeRequest`, and `git worktree prune` orphan cleanup on container startup.

## Problem Statement

All agent containers currently bind-mount the same host directory (`${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) and edit files in-place on a shared working tree. Two concurrent invocations silently corrupt each other's work, `git status` is non-deterministic across invocations, and the host filesystem is an implicit dependency that prevents remote deployment.

The worktree-per-invocation model eliminates this by giving each invocation its own filesystem checkout. Each invocation targets a specific branch, creates a worktree from the persistent base repo clone, runs the SDK subprocess in that worktree, and cleans up afterward. No invocation sees another's in-flight file changes.

**Why now:** This blocks every other QRM8 deliverable. Handler-controlled commits (#12) need a worktree to commit from. The branch-in-flight guard (#13) needs the `branch` field this ticket adds. Agent memory redirect (#16) depends on the worktree cwd pattern. This is the foundational infrastructure ticket.

## Implementation Details

### 1. InvokeRequest.branch -- Schema Change

**File:** `libs/common/src/messaging/invoke.types.ts`

Add a `branch` field to `invokeRequestSchema` as a **required string**. Zod validation must reject:
- Missing field (not provided at all)
- Empty string (`""`)
- Whitespace-only string

Use `.min(1)` with a descriptive error message (e.g., `"branch is required -- specify the target git branch for this invocation"`).

The `branch` field sits alongside `correlationId`, `caller`, `target`, `action` as a core routing parameter. Every caller (moderator via MCP tool, agents via nested invocations) must provide it.

**MCP server side:** The `invoke_agent` MCP tool schema (in `apps/mcp-server/src/mcp/mcp.service.ts`) must also accept `branch` as a required input parameter and pass it through when constructing the `InvokeRequest` for the broker. Two insertion points:
1. **Tool input schema** (~line 282): Add `branch` as a required string in the zod schema for the `invoke_agent` tool registration.
2. **Request construction** (~line 368): Include `branch` from the parsed input when building the `InvokeRequest` object sent to the broker.

### 2. ExecuteParams.cwd Parameterization

**File:** `apps/agent/src/llm/claude-code.types.ts`

Add an optional `cwd` field to the `ExecuteParams` interface:

```ts
/** Working directory for the SDK subprocess. When provided, overrides
 *  the default `agent.workspaceDir` from config. Used by InvocationHandler
 *  to inject the per-invocation worktree path. */
cwd?: string;
```

**File:** `apps/agent/src/llm/claude-code.service.ts`

In `executeQuery()`, the `query()` options currently use `cwd: this.config.agent.workspaceDir` (line 131). Change to:

```ts
cwd: params.cwd ?? this.config.agent.workspaceDir,
```

The config-based default remains the fallback for non-worktree execution (tests, development). In production, `InvocationHandler` always provides `cwd` explicitly.

**Risk area (Concern #2):** This touches the SDK integration surface. The `cwd` flows directly into `query()` options, which determines where the CC CLI subprocess runs. Test carefully that the subprocess respects the new cwd for all operations (file reads, writes, bash commands, git operations).

### 3. Worktree Lifecycle in InvocationHandler.runInvocation()

**File:** `apps/agent/src/connection/invocation-handler.service.ts`

The worktree lifecycle wraps the existing `claudeCode.execute()` call in `runInvocation()` (line 94). The structure becomes:

```
runInvocation(request):
  worktreePath = null
  try:
    // 1. Fetch latest refs
    git fetch origin                           (cwd: /var/agent-repo/)

    // 2. Create isolated worktree
    worktreePath = /var/agent-worktrees/<correlationId>
    git worktree add <worktreePath> <branch>   (cwd: /var/agent-repo/)

    // 3. Run SDK in worktree
    claudeCode.execute({ ..., cwd: worktreePath })

    // 4. Existing post-execution logic (checkUncommittedChanges, logResult)
    ...
  catch:
    // Surface worktree-add failures as invocation errors
    ...
  finally:
    // 5. Always clean up
    if worktreePath:
      git worktree remove <worktreePath> --force  (cwd: /var/agent-repo/)
```

**Key implementation notes:**

- **`git fetch origin`** runs before every worktree add to ensure the branch ref is current. Use `execAsync` (already imported). `cwd` is the base repo path, obtained from `this.config.agent.workspaceDir` (which now points to `/var/agent-repo/` -- see section 7).
- **`git worktree add`** runs with `cwd: /var/agent-repo/`. The worktree path uses the `correlationId` to guarantee uniqueness across concurrent invocations.
- **`claudeCode.execute()`** receives `cwd: worktreePath` via the new `ExecuteParams.cwd` field. The SDK subprocess runs entirely within the worktree.
- **`finally` block** runs `git worktree remove <worktreePath> --force`. The `--force` flag is needed when the worktree has uncommitted changes (the agent may have edited files but #12's handler commit hasn't landed yet -- #11 does NOT commit). Must run even on crash; use try/finally, not success-path-only cleanup.
- **Error handling for `git worktree add`:** If the command fails, surface a clear error in the `InvokeResponse`. Common failure modes:
  - Branch doesn't exist on remote (after fetch) -- `error: invalid reference: <branch>`
  - Ref is ambiguous -- `fatal: ambiguous argument`
  - Directory already exists (correlationId collision, should never happen) -- `fatal: '<path>' already exists`
  - Catch the `execAsync` rejection, extract stderr, and return `{ success: false, error: "Worktree creation failed: <stderr>" }`.
- **`checkUncommittedChanges()` (line 220): update to accept worktree path as a parameter.** It currently runs against `this.config.agent.workspaceDir`, which after this ticket points to the base repo (not the worktree where the agent actually worked). The developer must update this method to accept a `cwd` parameter and pass the worktree path from `runInvocation()`. #12 replaces `checkUncommittedChanges()` entirely with `commitAndPush()`, so this is a minor alignment -- just fixing the check's target directory, NOT implementing #12's commit/push behavior.
- **Logging:** Log worktree creation and removal at `log` level for observability. Include the branch, correlationId, and worktree path.

### 4. Agent Entrypoint Extension

**File:** `docker/agent/entrypoint.sh`

Extend the existing entrypoint (created by #15, extended by #29) with git clone and worktree prune. The new ordering is critical:

```
1. gh auth bootstrap       (#15 -- configures credential helper, unsets GH_TOKEN)
2. mkdir debug             (existing)
3. git clone               (NEW -- needs credential helper from step 1)
4. git checkout --detach   (NEW -- frees all branch refs for worktree use; see below)
5. plugin seed             (#29 -- global scope, reads from /var/agent-repo/)
6. git worktree prune      (NEW -- needs repo from step 3)
7. exec node dist/main.js  (existing)
```

**Git clone (first-boot only):**

```bash
# First-boot repo clone -- idempotent via .git check
if [ ! -d /var/agent-repo/.git ]; then
  echo "First boot: cloning $REPO_URL into /var/agent-repo/"
  git clone "$REPO_URL" /var/agent-repo/
else
  echo "Repo already present at /var/agent-repo/"
fi
```

`REPO_URL` is a new env var (same value used by the moderator in #14). The clone authenticates transparently via the gh credential helper configured in step 1.

**Detach HEAD (immediately after clone, every boot):**

```bash
# Free all branch refs for worktree use -- a regular clone checks out the
# default branch (main), so `git worktree add ... main` would fail with
# "fatal: 'main' is already checked out at '/var/agent-repo'".
# Detaching HEAD releases all branch refs while keeping the working tree
# and .git structure intact. The idempotency check is unaffected.
cd /var/agent-repo && git checkout --detach && cd /app
echo "HEAD detached -- branch refs freed for worktree use"
```

This runs on every boot (not just first-boot) because `git fetch` or other operations could leave HEAD on a branch. The `git checkout --detach` is safe when HEAD is already detached (it's a no-op).

**Git worktree prune (every boot):**

```bash
# Clean orphan worktree tracking entries from prior SIGKILL/OOM
cd /var/agent-repo && git worktree prune && cd /app
echo "git worktree prune complete"
```

This addresses **Concern #4** (orphan worktrees on SIGKILL). If `runInvocation()` crashes after creating a worktree but before the `finally` block, the worktree tracking entry persists in `/var/agent-repo/.git/worktrees/`. On restart, the tmpfs-backed worktree files are gone, so `git worktree prune` cleanly removes the stale entries.

**Plugin seed path and scope update (side-effect of bind mount removal + worktree cwd):**

The current `PLUGIN_SRC` path is `/mnt/quorum/workspace/docker/plugins/code-review`. With the workspace bind mount removed, this path no longer exists. Update to read from the cloned repo:

```bash
PLUGIN_SRC=/var/agent-repo/docker/plugins/code-review
```

This is why git clone must precede the plugin seed step.

**Plugin scope: change from `"project"` to `"global"`.**  The current plugin manifest (from #29) uses `scope: "project"` with `projectPath: "/mnt/quorum/workspace"`. Under worktrees, the SDK cwd is `/var/agent-worktrees/<correlationId>` — CC CLI may not match a project-scoped plugin whose `projectPath` doesn't match the current cwd. Changing to `scope: "global"` makes the plugin available regardless of cwd, which is the correct behavior for agents that always need the code-review skill. Remove the `projectPath` field entirely — global-scoped plugins don't need it.

The `installed_plugins.json` write in the entrypoint should produce:

```json
{
  "plugins": [{
    "name": "code-review",
    "scope": "global",
    "source": "<PLUGIN_SRC path>"
  }]
}
```

**Volume-seed bug warning (from #14):** The entrypoint must NOT create files inside `/var/agent-repo/` or `/var/agent-worktrees/` at build time. Docker seeds empty named volumes from image layers on first use. If the Dockerfile creates content at the volume mount point, that content appears in the volume and breaks `git clone` (which requires an empty directory). This was the exact bug found in #14's code review -- see `14-project-notes` in Context Store.

### 5. Docker Compose Changes

**File:** `docker-compose.yml`

Changes apply to all four agent services: `architect`, `developer`, `teamlead`, `qa` (note: `qa` and `productowner` services are not yet defined -- only update existing services).

**Per agent service:**

1. **Remove** the workspace bind mount:
   ```yaml
   # REMOVE: - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
   ```

2. **Add** per-role base repo named volume:
   ```yaml
   - <role>-agent-repo:/var/agent-repo
   ```
   Named volumes: `architect-agent-repo`, `developer-agent-repo`, `teamlead-agent-repo`. Persistent -- survives container restarts, avoids re-cloning.

3. **Add** `REPO_URL` to agent environment (via `x-shared-env` or per-service -- same value as moderator):
   ```yaml
   REPO_URL: ${REPO_URL}
   ```

**Worktrees on tmpfs (via x-agent-security):**

Add `/var/agent-worktrees` to the `x-agent-security` tmpfs list:

```yaml
x-agent-security: &agent-security
  <<: *base-security
  tmpfs:
    - /tmp:size=512m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.claude:size=256m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.config:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.local:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.cache:size=128m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /var/agent-worktrees:size=1g,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
```

**Rationale for tmpfs over named volume for worktrees:** Worktrees are strictly ephemeral -- created before `claudeCode.execute()` and removed in `finally`. On crash (SIGKILL/OOM), the `finally` block doesn't run and worktree files become orphans. With tmpfs, the container restart clears the tmpfs, orphan files disappear, and `git worktree prune` in the entrypoint cleanly removes the stale tracking entries from the base repo (because the target paths no longer exist). With a named volume, orphan worktree directories would persist across restarts; `git worktree prune` does NOT clean entries whose target paths still exist -- it only removes entries pointing to missing paths. This means named-volume orphans would require active directory cleanup beyond prune. tmpfs makes the failure mode self-healing.

**Top-level volumes declaration:**

Add new named volumes:

```yaml
volumes:
  # ... existing ...
  architect-agent-repo:
  developer-agent-repo:
  teamlead-agent-repo:
```

### 6. Dockerfile Agent Stage

**File:** `Dockerfile` (agent stage, lines ~83-95)

Create mount-point directories for the named volume and tmpfs with correct ownership. Add to the existing `RUN mkdir -p ... && chown -R ...` block:

```dockerfile
RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude/debug \
      /var/agent-repo /var/agent-worktrees \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude \
      /var/agent-repo /var/agent-worktrees \
 && ln -s /tmp/.claude.json /home/quorum/.claude.json
```

**CRITICAL: Do NOT create any sub-content inside `/var/agent-repo/` or `/var/agent-worktrees/`.** These are empty mount points. Docker seeds named volumes from image layers on first use -- if there's content at the mount path in the image, it appears in the volume. An empty directory is fine (Docker treats it as "nothing to seed"); any file or subdirectory inside would break `git clone` (which requires an empty target). This is the same class of bug caught in #14's code review (`14-project-notes`).

**PATH env var update: REMOVE the stale entry.** The current `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` references a path that won't exist under the new volume layout (the workspace bind mount is removed). Decision: **remove the PATH entry entirely** rather than updating to `/var/agent-repo/node_modules/.bin`. Rationale: (1) `git clone` does not produce `node_modules` — `npm install` would need to run in the entrypoint for the path to be useful, adding ~30s startup time. (2) Agents primarily use CC CLI's built-in tools, not project devDependency binaries. (3) The base `node` image PATH already includes the global `npm` and `node` binaries. If a future ticket needs project scripts in agents, it can add `npm install` to the entrypoint and restore the PATH at that time.

### 7. agent.config.ts Semantics

**File:** `apps/agent/src/config/agent.config.ts`

The `workspaceDir` config value changes semantics:
- **Before:** Points to the shared workspace mount (`/mnt/quorum/workspace`) -- both the repo checkout and the SDK working directory.
- **After:** Points to the base repo clone (`/var/agent-repo`) -- the source for worktree creation. The per-invocation SDK working directory is the worktree path, injected via `ExecuteParams.cwd`.

Update the default:

```ts
workspaceDir: process.env.AGENT_WORKSPACE_DIR || '/var/agent-repo',
```

The `AGENT_WORKSPACE_DIR` env var is not explicitly set in `docker-compose.yml` (agents inherit the default). If an explicit env var is preferred for clarity, add `AGENT_WORKSPACE_DIR: /var/agent-repo` to `x-shared-env` or per-service env.

### 8. MCP Server and Moderator-Side Awareness

**MCP Server (`apps/mcp-server/src/mcp/mcp.service.ts`):** The `invoke_agent` tool must accept `branch` as a required string parameter and include it in the constructed `InvokeRequest`. This is inseparable from the schema change in section 1 -- the MCP tool is the primary entry point for invocations from the moderator.

**Moderator:** The moderator must provide `branch` in every `invoke_agent` call. This is a new required parameter with no default. For implementation invocations, use the feature branch (e.g., `"11-worktree-per-invocation"`). For review or read-only invocations, use the branch in scope or `"main"` for general exploration.

Minimal moderator-side update: add a brief note to `docker/moderator/CLAUDE.md` documenting the new required `branch` parameter in `invoke_agent`. This is a documentation-only change -- the MCP tool's zod validation will enforce the requirement mechanically.

## Scope Guards

- **DO NOT** touch agent commit/push behavior. `checkUncommittedChanges()` stays (update its cwd to worktree path only). Handler-controlled commits are #12.
- **DO NOT** add the branch-in-flight broker guard. That's #13 -- it depends on the `branch` field this ticket adds.
- **DO NOT** modify moderator container infrastructure (entrypoint, volumes, env). Moderator's git client work is #14 (merged).
- **DO NOT** remove or replace `checkUncommittedChanges()`. Only update its `cwd` to target the worktree instead of the base repo. #12 handles the full replacement.
- **DO NOT** touch `role-tool-profiles.ts` (git command deny rules). That's #12 scope.

## Risk Areas

1. **SDK integration surface (Concern #2):** The `cwd` parameterization flows directly into the CC CLI subprocess. All file operations, bash commands, and git operations in the subprocess will use the worktree directory. Verify that the SDK correctly respects the injected cwd for all tool types.

2. **Orphan worktrees on SIGKILL (Concern #4):** If `runInvocation()` is killed after `git worktree add` but before `finally`, the worktree tracking entry persists. Mitigation: `git worktree prune` in the entrypoint on every startup. With tmpfs-backed worktrees, the files are already gone on restart -- prune only cleans the tracking metadata.

3. **Plugin resolution under worktree cwd (MITIGATED):** The plugin seed previously wrote `scope: "project"` with `projectPath: "/mnt/quorum/workspace"`. Under worktrees, the SDK cwd is `/var/agent-worktrees/<correlationId>`, which wouldn't match. **Mitigation:** This ticket changes the plugin to `scope: "global"` (no `projectPath`), making it available regardless of cwd. The developer should verify empirically that the global-scoped plugin is resolved correctly when the SDK subprocess runs in a worktree directory.

4. **Volume-seed bug (#14 pattern):** Any content created inside `/var/agent-repo/` in the Dockerfile will be seeded into the named volume on first use, breaking `git clone`. The Dockerfile must only create the empty mount-point directory.

5. **PATH env var staleness (RESOLVED):** The stale `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` is removed entirely (see Section 6). Agents don't need project devDependency binaries — they use CC CLI's built-in tools. If a future ticket requires project scripts, it can add `npm install` to the entrypoint and restore the PATH entry.

6. **Concurrent worktree creation:** If two invocations for the same agent target the same branch simultaneously, `git worktree add` will fail (git does not allow two worktrees on the same branch). This is by design -- #13's branch-in-flight guard prevents this at the broker level. Until #13 lands, the `git worktree add` error handling (section 3) will surface a clear error.

## Acceptance Criteria

- [x] `branch` field added to `invokeRequestSchema` as required string -- zod rejects missing/empty values with descriptive error message
- [x] MCP server's `invoke_agent` tool schema accepts `branch` as required parameter and passes it through to `InvokeRequest`
- [x] `cwd` optional field added to `ExecuteParams`; `ClaudeCodeService.executeQuery()` uses `params.cwd` when provided, falls back to `this.config.agent.workspaceDir`
- [x] `runInvocation()` runs `git fetch origin` (cwd: `/var/agent-repo/`) before worktree creation
- [x] `runInvocation()` creates worktree via `git worktree add /var/agent-worktrees/<correlationId> <branch>` (cwd: `/var/agent-repo/`)
- [x] `runInvocation()` passes worktree path as `cwd` to `claudeCode.execute()`
- [x] `runInvocation()` removes worktree in `finally` block -- cleanup runs on success, failure, and thrown exceptions
- [x] `git worktree add` failures (branch not found, ref ambiguous, dir exists) return clear error in `InvokeResponse`
- [x] Agent entrypoint: first-boot `git clone $REPO_URL /var/agent-repo` is idempotent (skips if `.git` exists); existing #15/#29 behavior preserved without regression
- [x] Agent entrypoint: `git checkout --detach` runs immediately after clone (every boot) — HEAD is detached so all branch refs are free for `git worktree add` (fixes blocker: regular clone checks out `main`, blocking `git worktree add ... main`)
- [x] Agent entrypoint: `git worktree prune` runs on every container start in `/var/agent-repo` (orphan cleanup for Concern #4)
- [x] Entrypoint order: gh auth (#15) -> git clone -> git checkout --detach -> plugin seed (#29, updated path + global scope) -> worktree prune -> exec node
- [x] Agent entrypoint plugin seed: `installed_plugins.json` uses `scope: "global"` (not `"project"`) with no `projectPath` field — ensures plugin availability regardless of SDK cwd under worktrees
- [x] Agent entrypoint plugin seed: `PLUGIN_SRC` updated to `/var/agent-repo/docker/plugins/code-review` (reads from cloned repo, not removed bind mount)
- [x] Dockerfile agent stage: `/var/agent-repo` and `/var/agent-worktrees` created as empty mount-point dirs with `quorum` ownership -- NO sub-content inside (volume-seed bug prevention)
- [x] Dockerfile agent stage: stale `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` removed entirely (no `node_modules` in clone; agents use CC CLI tools, not project devDeps)
- [x] Docker compose: workspace bind mount removed from agent services; per-role `<role>-agent-repo` named volumes; `/var/agent-worktrees` on tmpfs (`size=1g`) via `x-agent-security`; `REPO_URL` in agent env; new volumes in top-level declaration
- [x] `checkUncommittedChanges()` updated to accept worktree path as a `cwd` parameter — runs against the worktree, not the base repo
- [x] `agent.config.ts`: `workspaceDir` default changed to `/var/agent-repo`
- [~] Happy-path manual E2E after container rebuild: invoke agent with a branch -> worktree created at expected path, SDK runs in worktree, worktree removed after completion — deferred to post-merge rebuild

## Dependencies and References

**Depends on:**
- #15 (PAT Wiring) -- `git clone` and `git fetch` require the gh credential helper configured by #15's entrypoint block. #15 is merged.
- #29 (Agent Plugin Install) -- entrypoint plugin seed block exists. #11 reorders it after git clone and updates the source path. #29 is merged.

**Blocks:**
- #12 (Handler-Controlled Commit and Push) -- needs the worktree cwd and `branch` field
- #13 (Branch-in-Flight Guard) -- needs the `branch` field in `InvokeRequest`

**References:**
- `tickets/8-workspace-isolation.md` -- QRM8 roadmap, D1 design decision, worktree lifecycle diagram, branch routing diagram
- `tickets/14-moderator-git-client.md` -- #14 volume-seed bug pattern (Dockerfile mkdir at mount point)
- `14-project-notes` in Context Store -- volume-seed bug discovery and fix details
- `docs/claude-code-sdk.md` -- SDK integration reference for `query()` options and cwd behavior
- GitHub issue: https://github.com/ia64mail/quorum/issues/11

## Implementation Notes

**Status:** Complete (19/19 ACs satisfied; 1 deferred to post-merge E2E)

### Pass A — TypeScript schema/SDK/worktree-lifecycle/config (5 commits)

| Commit | Description |
|--------|-------------|
| `c4063db` | Add `branch` field to InvokeRequest schema + MCP `invoke_agent` tool |
| `2353884` | Add `cwd` to ExecuteParams and thread through ClaudeCodeService |
| `35a4bf7` | Add `cwd` to ExecuteParams and thread through ClaudeCodeService (lint fix) |
| `67c52b1` | Add worktree lifecycle to InvocationHandler + cwd-aware `checkUncommittedChanges` |
| `c697493` | Shift `agent.config.workspaceDir` default to `/var/agent-repo` |

**Files modified (Pass A):**
- `libs/common/src/messaging/invoke.types.ts` — `branch` added as required field
- `apps/mcp-server/src/mcp/mcp.service.ts` — `branch` in tool schema + request construction
- `apps/agent/src/llm/claude-code.types.ts` — `cwd` optional field on ExecuteParams
- `apps/agent/src/llm/claude-code.service.ts` — `params.cwd ?? config.workspaceDir` fallback
- `apps/agent/src/connection/invocation-handler.service.ts` — worktree lifecycle (fetch → add → execute → remove), cwd-aware `checkUncommittedChanges`
- `apps/agent/src/config/agent.config.ts` — default to `/var/agent-repo`
- All corresponding `.spec.ts` files updated for new `branch` field and worktree behavior

### Pass B — Container infrastructure (3 commits)

| Commit | Description |
|--------|-------------|
| `462ba78` | Extend agent entrypoint: clone + detach + global plugin scope + worktree prune |
| `f1e288f` | docker-compose: remove bind mount, add named volumes + worktree tmpfs + REPO_URL |
| `6c84adc` | Dockerfile: add mount points, remove stale PATH |

**Files modified (Pass B):**
- `docker/agent/entrypoint.sh` — full entrypoint rewrite with new boot sequence
- `docker-compose.yml` — per-role named volumes, worktree tmpfs, REPO_URL in shared-env
- `Dockerfile` — mount-point dirs + PATH removal in agent stage

### Architect-Driven Decisions

1. **`git checkout --detach` (BLOCKING FIX):** Regular clone checks out `main`, which blocks `git worktree add ... main`. Detaching HEAD on every boot frees all branch refs. This is in the entrypoint at line 49.
2. **Plugin scope `"global"` (not `"project"`):** Under worktrees the SDK cwd is `/var/agent-worktrees/<correlationId>`, which wouldn't match a project-scoped plugin's `projectPath`. Global scope makes the plugin available regardless of cwd.
3. **PATH removal:** The stale `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` pointed to a now-nonexistent directory. Removed entirely — agents use CC CLI built-in tools, not project devDeps.
4. **tmpfs for worktrees:** Self-healing orphan cleanup — container restart clears tmpfs, then `git worktree prune` cleans stale tracking entries.

### Deviations

- None. Implementation follows the ticket spec and architect design notes exactly.

### Verification

- 3 webpack compilations successful (mcp-server, agent, common)
- 0 lint errors
- 46 test suites, 798 tests passed
- E2E deferred to post-merge container rebuild

### Post-Merge Rebuild Required

All agent containers need rebuild after merge:
```bash
docker compose build architect developer teamlead && docker compose up -d
```
