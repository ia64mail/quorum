# QRM5-BUG-002: SDK Skills Disabled — Agents Cannot Use Built-in Review or Slash Commands

## Summary

Agent containers run with `settingSources: []` in `ClaudeCodeService`, which puts the Claude Agent SDK into full isolation mode. This silently disables the entire skills subsystem — agents have no access to built-in skills (`/review`, `/simplify`, `/batch`), plugins, CLAUDE.md project instructions, or user-defined slash commands. Concurrently, both SDK packages are 47 and 16 versions behind respectively, missing critical MCP stability fixes, a Zod v4 metadata bugfix that directly impacts the MCP tool bridge, and security patches.

## Problem Statement

### Missing skills subsystem

The Claude Code CLI has a rich skills ecosystem — `/review` (now the `code-review` plugin), `/simplify`, `/batch`, and custom skills defined in `.claude/skills/`. When driving Claude Code interactively, the `/review` skill produces substantially better code review output than a raw "review the changes" prompt because it orchestrates multiple parallel review agents (CLAUDE.md compliance auditors, bug detector, git-blame history analyzer) and applies confidence scoring to filter low-signal findings.

The Quorum architect and teamlead roles currently perform code reviews via free-form prompts to the Claude Code subprocess. These reviews are shallow compared to the structured review skill — they miss CLAUDE.md compliance issues, don't cross-reference git blame for context, and produce inconsistent output formats.

**Root cause:** `ClaudeCodeService` passes `settingSources: []` to `query()` (line 84 of `claude-code.service.ts`). The SDK documentation is explicit:

> When omitted or empty, no filesystem settings are loaded (SDK isolation mode). Must include `'project'` to load CLAUDE.md files.

This means:
1. **No skills loaded** — the `Skill` tool is not offered to the LLM, so slash commands are unavailable
2. **No CLAUDE.md loaded** — project instructions that would guide agent behavior are invisible
3. **No plugins loaded** — the `code-review` plugin (replacement for deprecated `/review`) cannot be discovered
4. **No hooks from settings** — only the programmatic observability hooks are active

### Stale SDK packages

`@anthropic-ai/claude-agent-sdk` is at `0.2.63` (published 2026-02-28); latest is `0.2.110` (2026-04-15). Notable fixes relevant to Quorum in the gap:

| Version | Fix | Quorum Impact |
|---------|-----|---------------|
| **0.2.89** | **Zod v4 `.describe()` metadata dropped from `createSdkMcpServer`** | `McpToolBridgeService` has 20+ `.describe()` calls across all 5 bridged tools — all descriptions were silently dropped, leaving the LLM with bare type schemas for `invoke_agent`, `context_store`, `context_query`, etc. |
| **0.2.89** | MCP servers stuck in failed state after connection race — now retry | Explains intermittent "MCP server unavailable" errors in session logs |
| **0.2.89** | `ERR_STREAM_WRITE_AFTER_END` with SDK MCP servers fixed | Prevents stream corruption on fast sequential tool calls |
| **0.2.89** | `startup()` for 20x faster first query | Enables container pre-warming for faster agent responsiveness |
| **0.2.94** | MCP server child processes not cleaned up when `query()` ends | Prevents zombie processes accumulating in long-running containers |
| **0.2.101** | Security: bumped `@anthropic-ai/sdk` to `^0.81.0` (GHSA-5474-4w2j-mq4c) | Security advisory — current `^0.73.0` is affected |
| **0.2.91** | `sandbox.failIfUnavailable` now defaults to `true` | Low impact — Quorum doesn't use sandbox, but worth noting for awareness |

`@anthropic-ai/sdk` is at `0.73.0` (published 2026-02-05); latest is `0.89.0` (2026-04-14). The agent SDK `0.2.101` requires `@anthropic-ai/sdk ^0.81.0` as a peer dependency, so upgrading the agent SDK will pull this along.

### ICEBOX caching issues — potential improvement

The ICEBOX item "Agent Session Resume via Correlation ID" is blocked by two upstream issues:
- **claude-agent-sdk#247** — MCP server configs non-serializable, busting prompt cache
- **claude-agent-sdk#192** — Random UUID in Bash tool description invalidating cache

Issue #247 was closed as a duplicate of #89 ("Cache Control in SDK"), which remains open. The MCP stability fixes in 0.2.89+ may have partially improved cache behavior even without full resolution — this should be re-evaluated after upgrade.

## Design Context

### Skills architecture in the Claude Agent SDK

The SDK skill system works through layers:

1. **`settingSources`** — controls which filesystem locations are scanned for settings, CLAUDE.md files, skills, and hooks. `[]` = nothing loaded (current state). `['project']` = loads from `.claude/` in the workspace. `['user', 'project']` = loads from both `~/.claude/` and workspace `.claude/`.

2. **`Skill` tool** — the runtime tool that invokes skill SKILL.md files. Registered automatically when skills are discovered via `settingSources`. If no settings sources are loaded, no skills are discovered, and the `Skill` tool is never offered to the LLM.

3. **`ToolSearch` tool** — deferred tool loading mechanism. Skills can declare required tools in frontmatter; `ToolSearch` fetches their schemas on demand.

4. **`plugins`** option — loads plugin packages that provide custom commands, agents, skills, and hooks. Currently supports `{ type: 'local', path: string }`. The `code-review` plugin is distributed as a standard Claude Code plugin installable via `claude plugin install code-review@claude-plugins-official`.

5. **`skills`** field on `AgentDefinition` — preloads named skills into a subagent's context. Only applicable to subagent definitions, not the top-level `query()` options.

### `/review` is deprecated — `code-review` plugin is the replacement

The CLI `/review` command has been deprecated. The replacement `code-review` plugin launches 4 parallel agents:
- 2 CLAUDE.md compliance auditors
- 1 bug detector
- 1 git-blame history analyzer

Each issue is scored 0-100 for confidence; only issues >= 80 are surfaced. This structured approach produces dramatically better review output than a raw review prompt.

### Per-role skill access design

Not all roles should have equal skill access. The skills subsystem should follow the same principle of least privilege as the existing tool profiles:

| Role | Skills Access | Rationale |
|------|---------------|-----------|
| **architect** | `code-review`, `simplify` | Architectural review, code quality assessment |
| **teamlead** | `code-review`, `simplify` | Integration review, quality monitoring |
| **developer** | `simplify` | Self-review before submitting, code quality |
| **qa** | — (no skills) | QA focuses on test execution, not code review |
| **productowner** | — (no skills) | No code interaction |

## Implementation Details

### Part 1: Package Upgrade

Bump both SDK packages and verify compatibility:

```
@anthropic-ai/claude-agent-sdk  ^0.2.63  →  ^0.2.110
@anthropic-ai/sdk               ^0.73.0  →  ^0.89.0
```

The agent SDK `0.2.101` internally requires `@anthropic-ai/sdk ^0.81.0`, so both must be upgraded together. The `@modelcontextprotocol/sdk` dependency should also be checked — SDK `0.2.101` bumped to `^1.29.0` (current project has `^1.26.0`).

After `npm install`, run `npm run build` and `npm run test` to verify no breaking changes. The key risk points:
- `sandbox.failIfUnavailable` defaulting to `true` in 0.2.91 (Quorum doesn't use sandbox — no-op)
- New required peer dependencies
- Type changes in SDK exports used by `ClaudeCodeService` and `McpToolBridgeService`

### Part 2: Enable `settingSources`

Change `settingSources: []` to `settingSources: ['project']` in `ClaudeCodeService.execute()`:

```typescript
// claude-code.service.ts, line 84
settingSources: ['project'],
```

This loads:
- `.claude/settings.json` from the workspace (project-level settings)
- CLAUDE.md files from the workspace root
- Skills from `.claude/skills/` in the workspace

**Why `['project']` and not `['user', 'project']`:** Agent containers have read-only root filesystems with tmpfs at `~/.claude`. There are no user-level settings or skills worth loading — everything relevant lives in the workspace. Adding `'user'` would scan the tmpfs for nothing and risks picking up stale state across container restarts.

### Part 3: Install `code-review` Plugin in Agent Container

The `code-review` plugin needs to be available in the agent container filesystem. The container runs with a read-only root filesystem, so runtime `claude plugin install` is not an option — the plugin must be baked into the image at build time.

**Approach: Pre-install at Docker build time and reference via `plugins` option.**

Add a build step in the Dockerfile's agent target that installs the plugin into the workspace's `.claude/plugins/` directory. This avoids runtime network calls, is reproducible across builds, and aligns with the read-only container policy:

```dockerfile
# In the agent build target, after npm install
RUN npx @anthropic-ai/claude-agent-sdk plugin install code-review@claude-plugins-official \
    --project /mnt/quorum/workspace
```

Then pass the plugin path to the SDK via the `plugins` option in `ClaudeCodeService`. The `plugins` field accepts `{ type: 'local', path: string }` entries — this is the explicit, deterministic wiring that doesn't depend on filesystem scanning:

```typescript
// In ClaudeCodeService.execute(), within the query() options
plugins: params.plugins ?? [],
```

Add `plugins` to `ExecuteParams`:

```typescript
// In claude-code.types.ts
plugins?: Array<{ type: 'local'; path: string }>;
```

Wire from `RolePermissionService` — the role's tool profile determines which plugins are passed. Roles without plugin access receive an empty array.

Add the plugin path constant in a shared location (e.g. `role-tool-profiles.ts`):

```typescript
const CODE_REVIEW_PLUGIN = { type: 'local' as const, path: '/mnt/quorum/workspace/.claude/plugins/code-review' };
```

**Note for awareness:** `settingSources: ['project']` may auto-discover plugins in `.claude/plugins/` without explicit `plugins` wiring. However, the SDK docs are ambiguous on whether `settingSources` scans plugins or only settings/skills. Explicit `plugins` wiring is preferred because it's deterministic and role-controllable — auto-discovery would give all roles access to all installed plugins with no filtering.

### Part 4: Allow `Skill` and `ToolSearch` Tools

The `Skill` and `ToolSearch` tools must not be in any role's `disallowedTools`. Examining the current `COMMON_DISALLOWED_TOOLS` and per-role profiles: neither `Skill` nor `ToolSearch` is currently blocked, so **no changes needed** to `role-tool-profiles.ts` — the tools will be available to all roles once `settingSources` enables skill discovery.

However, if per-role skill restriction is desired (per the design table above), the `disallowedTools` approach is too coarse — it blocks all skills, not specific ones. Per-role skill control should be achieved via:

1. **Workspace-level `.claude/settings.json`** with role-specific skill allowlists, or
2. **Separate workspace directories per role** with only the permitted `.claude/skills/` entries, or
3. **The `canUseTool` hook** — intercept `Skill` tool calls and filter by skill name based on role

Option 3 is the most Quorum-native approach since the `canUseTool` hook already handles role-based tool filtering:

```typescript
// In tool-guard-hook.ts, extend the guard to filter Skill invocations
if (toolName === 'Skill') {
  const skillName = input?.skill as string | undefined;
  if (skillName && !allowedSkills.includes(skillName)) {
    return { allowed: false, reason: `Skill '${skillName}' not permitted for ${role}` };
  }
}
```

### Part 5: Skill Invocation — Dispatching Review Tasks

Once the plugin is installed and discovered, agents invoke it via the `Skill` tool. The SDK recognizes slash command syntax in the prompt and routes directly to the skill — no LLM deliberation, no wasted turns.

**Direct dispatch (recommended for Quorum):**

When the moderator dispatches a review task, it controls the `action` field in `InvokeRequest`. For code review invocations, the moderator should set the prompt to the slash command directly:

```typescript
// In the moderator's invoke_agent call
action: '/code-review'
```

This is deterministic — the SDK invokes the plugin's multi-agent review pipeline immediately. The alternative (natural language like "review the changes on this branch") relies on the LLM noticing the skill is available and choosing to use it, which is not guaranteed — it may perform a manual review instead.

**Adding focus context:**

The slash command can be followed by additional context that guides the review's priorities:

```typescript
action: '/code-review\n\nFocus on the context-store changes and the new embedding pipeline integration.'
```

The skill runs its structured review (4 parallel agents: 2 CLAUDE.md compliance auditors, 1 bug detector, 1 git-blame history analyzer), and the appended context steers what gets prioritized. No special syntax beyond the leading `/code-review` is needed.

**Moderator-side routing:**

The moderator already makes role-dispatch decisions based on task type. Review dispatching fits naturally:

| Task intent | Moderator action |
|-------------|-----------------|
| Architectural review | Dispatch to architect with `action: '/code-review\n\n<focus>'` |
| Integration review | Dispatch to teamlead with `action: '/code-review\n\n<focus>'` |
| Self-review before PR | Dispatch to developer with `action: '/simplify'` |
| Implementation task | Dispatch normally with natural language `action` |

The moderator doesn't need to know the plugin's internals — it just sends the slash command. The skill handles orchestration (parallel agents, confidence scoring, filtering) internally.

### Part 6: Verify Zod v4 `.describe()` Fix (Post-Upgrade)

After upgrading to `>=0.2.89`, the `.describe()` metadata on all MCP tool bridge schemas should be preserved through to the Claude Code subprocess. Verify by:
1. Enabling debug logging (`debug: true` or `debugFile`)
2. Running an agent invocation
3. Checking the debug log for tool schema definitions — all parameter descriptions should be present

No code changes needed — the existing `.describe()` calls in `McpToolBridgeService` are already correct. The fix is purely in the SDK's `createSdkMcpServer()` implementation.

### Part 7: Re-evaluate ICEBOX Session Resume (Post-Upgrade)

After upgrading, re-test prompt caching behavior with MCP servers:
1. Run two sequential invocations of the same agent role
2. Check cost breakdown — if `cache_creation_input_tokens` appears on the first call and `cache_read_input_tokens` on the second, caching is working
3. If caching works, the ICEBOX item "Agent Session Resume via Correlation ID" can be unblocked and moved to an active ticket

This is verification only — no code changes.

### Files to modify

| File | Change |
|------|--------|
| `package.json` | Bump `@anthropic-ai/claude-agent-sdk` to `^0.2.110`, `@anthropic-ai/sdk` to `^0.89.0`, verify `@modelcontextprotocol/sdk` compatibility |
| `apps/agent/src/llm/claude-code.service.ts` | Change `settingSources: []` → `settingSources: ['project']` |
| `apps/agent/src/config/role-tool-profiles.ts` | Add `allowedSkills` to `RoleToolProfile` interface (per-role skill allowlist) |
| `apps/agent/src/config/tool-guard-hook.ts` | Add `Skill` tool filtering in `canUseTool` hook based on role's `allowedSkills` |
| `Dockerfile` | Install `code-review` plugin in agent build target (if Option A) |
| `apps/agent/src/llm/claude-code.service.spec.ts` | Update tests for new `settingSources` value; add skill-related test cases |
| `apps/agent/src/config/role-tool-profiles.spec.ts` | Add tests for `allowedSkills` per role |
| `apps/agent/src/config/tool-guard-hook.spec.ts` | Add tests for Skill tool filtering |

## Acceptance Criteria

- [ ] `@anthropic-ai/claude-agent-sdk` upgraded to `^0.2.110`
- [ ] `@anthropic-ai/sdk` upgraded to `^0.89.0`
- [ ] `@modelcontextprotocol/sdk` version compatible with upgraded SDK
- [ ] `settingSources: ['project']` in `ClaudeCodeService` — skills subsystem enabled
- [ ] `code-review` plugin available in agent containers
- [ ] Architect and teamlead roles can invoke `/code-review` during invocations
- [ ] Developer role can invoke `/simplify` but not `/code-review` (if per-role filtering implemented)
- [ ] QA and productowner roles cannot invoke any skills
- [ ] Zod v4 `.describe()` metadata visible in debug logs for all bridged tool schemas
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` — all existing tests pass, no regressions
- [ ] ICEBOX session resume re-evaluated — caching behavior documented post-upgrade

## Dependencies and References

- **Root cause file:** `apps/agent/src/llm/claude-code.service.ts:84` — `settingSources: []`
- **Tool profiles:** `apps/agent/src/config/role-tool-profiles.ts` — `COMMON_DISALLOWED_TOOLS`, per-role profiles
- **Tool guard hook:** `apps/agent/src/config/tool-guard-hook.ts` — runtime tool filtering
- **MCP tool bridge:** `apps/agent/src/connection/mcp-tool-bridge.service.ts` — 20+ `.describe()` calls affected by Zod v4 fix
- **SDK type definitions:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `Options.settingSources`, `Options.plugins`, `AgentDefinition.skills`
- **ICEBOX:** `tickets/ICEBOX.md` lines 42-59 — session resume blocked by #247/#192
- **Prior caching tickets:** `tickets/QRM4-BUG-012-moderator-prompt-caching-and-cost-tracking.md`, `tickets/QRM4-BUG-013-moderator-conversation-caching.md`
- **Security advisory:** GHSA-5474-4w2j-mq4c — addressed by `@anthropic-ai/sdk ^0.81.0`
- **Plugin deprecation:** `/review` CLI command deprecated in favor of `code-review@claude-plugins-official` plugin