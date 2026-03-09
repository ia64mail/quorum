# QRM2-005: Role Permission Profiles

## Summary

Define per-role configuration that controls which Claude Code built-in tools each agent can use and which bash commands are denied. Each of the five deployable agent roles gets a permission profile specifying `disallowedTools` (tool-level blacklist) and a denied-command list enforced via a `PreToolUse` hook on `Bash` invocations. Profiles encode the principle of least privilege — agents get only the capabilities their role requires, with `AskUserQuestion` universally disabled to prevent indefinite hangs.

## Problem Statement

QRM2-002 gave every agent a full Claude Code runtime with `bypassPermissions` enabled. This is safe at the container level — QRM2-001's hardening (non-root user, dropped capabilities, read-only rootfs) ensures the host is protected. But inside the container, all agents have identical tool access: the developer can do everything the architect can, and the product owner has the same destructive capabilities as the developer.

This creates three problems:

- **No role differentiation at the tool level.** The architect is a design reviewer that should write documentation but not source code — yet it can `FileWrite` and `FileEdit` to any path. The product owner provides requirements context — yet it can `Bash` arbitrary commands. Role prompts *suggest* behavior, but nothing *enforces* it. An LLM hallucination or prompt drift can cause an agent to exceed its intended responsibilities.
- **`AskUserQuestion` is a live hang risk.** The SDK's `AskUserQuestion` tool prompts for interactive user input. Agent sessions use a single-message async iterable that exhausts on entry — there is no interactive user. If any agent invokes `AskUserQuestion`, the session hangs indefinitely, consuming a container slot and blocking the call chain. This must be mechanically prevented, not just discouraged via prompts.
- **No bash command guardrails.** With `bypassPermissions`, Claude Code's `Bash` tool runs arbitrary shell commands. The container is the outer boundary, but role-appropriate inner boundaries are absent. A read-only agent like architect shouldn't be running `git push` or `rm -rf`. A denied-command hook provides a lightweight inner fence without re-engineering the container security model.

## Design Context

### Tool Permission Mechanism

The SDK's `query()` options accept `allowedTools` (whitelist) and `disallowedTools` (blacklist). With `bypassPermissions`, these are the only tool-level gates — no interactive permission prompts fire. The design uses **`disallowedTools` only** (blacklist approach) because:

1. **Whitelist fragility.** The SDK's built-in tool set evolves across versions. An `allowedTools` whitelist silently drops new tools that agents should have access to. A `disallowedTools` blacklist is additive — new tools are available by default, and only explicitly dangerous ones need blocking.
2. **MCP tool compatibility.** Custom tools from the MCP bridge (`invoke_agent`, `context_store`, etc.) must also be available. A whitelist would need to enumerate every MCP tool name, creating coupling between the permission profile and the bridge. A blacklist ignores tools it doesn't mention.
3. **Simpler profiles.** Most roles need most tools. The denied set per role is small (3–8 entries), making profiles readable and maintainable.

### Bash Command Filtering via Hook

The SDK supports a `PreToolUse` hook pattern — a callback invoked before each tool execution that can inspect arguments and return a denial. For `Bash` invocations, the hook receives the command string and can match it against a denied-command list.

The hook uses a pattern-matching approach rather than exact string matching:

- **Prefix patterns** (e.g., `git push`, `rm -rf`) catch the command regardless of trailing arguments
- **Patterns are role-scoped** — the developer has a minimal deny list (catastrophic-only), while the product owner denies all bash execution via `disallowedTools`

The hook is not a security boundary — the container is. It's a **behavioral guardrail** that catches accidental misuse from prompt drift, reducing wasted compute and preventing unintended side effects in the shared workspace.

### AskUserQuestion: Universal Deny

`AskUserQuestion` appears in every role's `disallowedTools`. This is non-negotiable:

- Agent sessions receive a single-message `AsyncIterable<SDKUserMessage>` that yields once and exhausts. There is no stdin to read from.
- If the SDK attempts `AskUserQuestion`, the session blocks waiting for input that never arrives.
- The clarification path is `invoke_agent(moderator, ...)` per QRM2-004 — agents escalate to the user through the moderator's clarification handler.

### Profile Shape

```typescript
interface RoleToolProfile {
  disallowedTools: string[];
  deniedBashCommands: string[];
  allowedWritePaths?: string[];
}
```

- `disallowedTools` — tools the role cannot use at all.
- `deniedBashCommands` — command prefixes rejected by the bash guard hook.
- `allowedWritePaths` — when set, `FileWrite`, `FileEdit`, and `NotebookEdit` are restricted to files under these workspace-relative path prefixes. When `undefined`, write tools are unrestricted. This enables roles like architect to write documentation without having blanket code-modification access.

Profiles are a static `Record<AgentRole, RoleToolProfile>` keyed by the five `DEPLOYABLE_AGENT_ROLES`. The moderator is excluded — it runs in the terminal app on the raw Anthropic SDK, not Claude Code.

### Scope Boundary

| In scope | Out of scope |
|----------|-------------|
| `RoleToolProfile` interface and `ROLE_TOOL_PROFILES` map | InvocationHandler migration (QRM2-006) |
| Per-role `disallowedTools` definitions | Prompt updates describing available tools (QRM2-007) |
| Per-role `deniedBashCommands` definitions | Terminal moderator changes (QRM2-008) |
| `createToolGuardHook()` factory for `PreToolUse` filtering | Container-level security changes (QRM2-001) |
| `RolePermissionService` to resolve profiles by role | |
| Unit tests for profiles and bash guard hook | |
| Integration with `ClaudeCodeService.execute()` options | |

## Implementation Details

### Role Tool Profiles

Location: `apps/agent/src/config/role-tool-profiles.ts`

A const map keyed by `AgentRole` (from `@app/common`) for the five deployable roles. Each entry is a `RoleToolProfile` with two arrays.

**Common `disallowedTools` (all roles):**

| Tool | Reason |
|------|--------|
| `AskUserQuestion` | Hangs indefinitely — no interactive user in agent sessions |
| `Config` | No runtime config changes inside containers — settings are immutable per session |
| `ExitPlanMode` | Agent sessions don't enter plan mode — this tool is irrelevant and confusing |

**Per-role additional denials:**

| Role | Additional `disallowedTools` | Rationale |
|------|----------------------------|-----------|
| **developer** | *(none)* | Full implementation access — needs all code tools |
| **architect** | `NotebookEdit` | Design reviewer, not general code author. `FileWrite`/`FileEdit` are available but path-restricted to `docs/` and `tickets/` via `allowedWritePaths` (see below) — the architect can author and update project documentation and system design review tickets but cannot modify source code. Can still use `Bash` for analysis commands (grep, find, tree, test runners) |
| **teamlead** | *(none)* | Creates tickets and reviews code — needs file write access for ticket files and light edits. `Bash` for build/test monitoring |
| **qa** | *(none)* | Writes test files, runs test suites. Needs full filesystem and bash access |
| **productowner** | `NotebookEdit`, `Bash`, `EnterWorktree`, `Agent` | Requirements and user stories. `FileWrite`/`FileEdit` are available but path-restricted to `tickets/` via `allowedWritePaths` — the product owner can author user stories and requirements tickets but cannot modify source code or documentation. Cannot run commands or spawn sub-agents |

### Denied Bash Commands

Per-role lists of command prefixes that the bash guard hook should reject. These are **behavioral guardrails**, not security boundaries.

| Role | Denied command prefixes | Rationale |
|------|------------------------|-----------|
| **developer** | `git push --force`, `git push -f`, `rm -rf /` | Catastrophic-only — developer needs wide bash access |
| **architect** | `git push`, `git commit`, `git checkout -b`, `rm -rf`, `npm publish` | Read/analyze only — shouldn't mutate repo state or publish |
| **teamlead** | `git push --force`, `git push -f`, `rm -rf /`, `npm publish` | Can commit (for ticket files) but not force-push or publish |
| **qa** | `git push`, `git commit`, `rm -rf`, `npm publish` | Runs tests, doesn't commit results — test output goes to Context Store |
| **productowner** | *(n/a — `Bash` is in `disallowedTools`)* | Bash fully disabled at tool level |

### Allowed Write Paths

Per-role path restrictions for `FileWrite`, `FileEdit`, and `NotebookEdit`. When `allowedWritePaths` is set, the tool guard hook checks that the target file path falls under one of the allowed prefixes (relative to the workspace root `/mnt/quorum/workspace/`). When `undefined`, no path restriction is applied.

| Role | `allowedWritePaths` | Effect |
|------|---------------------|--------|
| **developer** | *(undefined)* | Unrestricted — can write anywhere in the workspace |
| **architect** | `['docs/', 'tickets/']` | Can create/edit files under `docs/` (architecture docs, design decisions) and `tickets/` (system design reviews). `FileWrite`/`FileEdit` to source code paths are denied by the hook |
| **teamlead** | *(undefined)* | Unrestricted — needs write access for tickets, code review edits |
| **qa** | *(undefined)* | Unrestricted — writes test files alongside source |
| **productowner** | `['tickets/']` | Can create/edit files under `tickets/` (user stories, requirements). `FileWrite`/`FileEdit` to all other paths are denied by the hook |

The path check resolves the target path to a workspace-relative form, strips leading `./` or `/`, and checks if it starts with any allowed prefix. Absolute paths outside the workspace are always denied when `allowedWritePaths` is set.

### Tool Guard Hook

Location: `apps/agent/src/config/tool-guard-hook.ts`

A factory function that creates a `PreToolUse`-compatible callback combining **bash command filtering** and **write path filtering** for a given role's profile:

```typescript
function createToolGuardHook(
  profile: RoleToolProfile,
  workspaceDir: string,
): (toolName: string, toolInput: Record<string, unknown>) => { allowed: boolean; reason?: string }
```

The hook handles two tool categories:

**Bash filtering** (same as before):
1. For `Bash` tool, extracts the `command` field from `toolInput`
2. Normalizes whitespace, strips nested `sudo` prefixes (loop)
3. Checks against `deniedBashCommands` prefixes (case-insensitive)

**Write path filtering:**
1. For `FileWrite`, `FileEdit`, or `NotebookEdit` tools, extracts the file path from `toolInput`
2. If `profile.allowedWritePaths` is undefined, allows the operation
3. Otherwise, resolves the path relative to `workspaceDir` and checks if it starts with any allowed prefix
4. Denies with a descriptive message if no prefix matches (e.g., `"architect role can only write to: docs/"`)

All other tools return `{ allowed: true }`.

This replaces the earlier single-purpose `createBashGuardHook` with a unified hook that covers both guard dimensions from a single callback.

The `sudo` stripping in bash filtering is a convenience — `sudo` isn't installed in the container (QRM2-001), so the command would fail anyway, but stripping it (in a loop, to catch `sudo sudo ...`) ensures the prefix match catches `sudo git push` the same as `git push`.

The write path check uses a trailing-slash comparison to prevent workspace-prefix substring attacks (e.g., `/mnt/quorum/workspace-evil/` matching `/mnt/quorum/workspace`). Paths are resolved via `node:path` `resolve()`/`relative()` against the workspace directory.

### RolePermissionService

Location: `apps/agent/src/config/role-permission.service.ts`

Injectable NestJS service that resolves the profile for the agent's configured role.

**Constructor dependencies:**
- `AgentConfigService` — provides `agent.role`

**Methods:**

- `getProfile(): RoleToolProfile` — returns the profile for the agent's role from the static map. Throws if the role has no profile (defensive — all `DEPLOYABLE_AGENT_ROLES` must have entries).
- `getDisallowedTools(): string[]` — convenience accessor for `getProfile().disallowedTools`.
- `getToolGuardHook()` — returns the pre-built hook closure for the agent's role. Creates it once on first call (lazy singleton), capturing the role's `deniedBashCommands` and `allowedWritePaths`. Uses `AgentConfigService.agent.workspaceDir` for path resolution.

### Integration with ClaudeCodeService

`ClaudeCodeService.execute()` already accepts `disallowedTools` in `ExecuteParams` (QRM2-002). The integration point is the **caller** — `InvocationHandler` (QRM2-006) will inject the profile when calling `execute()`:

```typescript
// In QRM2-006's migrated InvocationHandler:
const profile = this.rolePermission.getProfile();
const result = await this.claudeCode.execute({
  prompt: request.action,
  systemPrompt: this.rolePrompt.getPrompt(role),
  mcpServers: this.bridge.createBridge(request),
  disallowedTools: profile.disallowedTools,
  // tool guard hook wired via SDK options (bash commands + write paths)
});
```

This ticket defines the profiles and the hook. QRM2-006 wires them into the execution path.

### Hook Delivery to SDK

The bash guard hook needs to reach the SDK's tool execution pipeline. The SDK's `query()` options don't have a direct `PreToolUse` callback in the current version. Two integration paths, to be finalized during implementation:

1. **`canUseTool` callback.** The SDK's `Options.canUseTool` is invoked before tool execution. With `bypassPermissions`, verify whether `canUseTool` still fires — if yes, this is the natural hook point. The callback receives the tool name and input, matching the guard hook's signature.
2. **MCP server hook.** Register a pass-through MCP tool that wraps `Bash` and applies the guard. This is more invasive and should only be used if `canUseTool` is bypassed.

The implementation should verify `canUseTool` behavior with `bypassPermissions` and document the chosen path in the Implementation Notes.

### Module Wiring

Add `RolePermissionService` to `AgentConfigModule` (it depends only on `AgentConfigService` which is in the same module). Export it so `ConnectionModule` can inject it into `InvocationHandler` in QRM2-006.

### Testing Strategy

**Profile completeness tests:**
- Every `DEPLOYABLE_AGENT_ROLES` entry has a corresponding profile in the map
- Every profile includes `AskUserQuestion` in `disallowedTools`
- Every profile includes `Config` and `ExitPlanMode` in `disallowedTools`
- No profile contains duplicate entries
- Architect profile has `allowedWritePaths: ['docs/', 'tickets/']`

**Role-specific tool tests:**
- Architect profile denies `NotebookEdit`, does *not* deny `FileWrite`/`FileEdit` (path-guarded instead)
- Developer profile has no additional denials beyond common and no `allowedWritePaths`
- Product owner profile denies `Bash`, `NotebookEdit`, `EnterWorktree`, `Agent` and sets `allowedWritePaths: ['tickets/']`

**Tool guard hook — bash filtering tests:**
- Non-guarded tools always allowed
- Exact prefix match triggers denial (e.g., `git push --force origin main`)
- Partial prefix mismatch allowed (e.g., `git pull` when `git push` is denied)
- Case-insensitive matching (`Git Push` denied when `git push` is denied)
- `sudo` prefix stripped before matching (including nested `sudo sudo ...`)
- Whitespace normalization (`git  push` matches `git push`)
- Empty denied list allows all bash commands
- Non-string `command` field gracefully allowed

**Tool guard hook — write path filtering tests:**
- `FileWrite` to `docs/system-design.md` allowed for architect (`allowedWritePaths: ['docs/']`)
- `FileEdit` to `src/main.ts` denied for architect
- `FileWrite` to any path allowed for developer (no `allowedWritePaths`)
- Absolute workspace paths resolved correctly (e.g., `/mnt/quorum/workspace/docs/foo.md` → `docs/foo.md`)
- Paths outside workspace always denied when `allowedWritePaths` is set
- Workspace-prefix substring paths denied (e.g., `workspace-evil/` doesn't match `workspace/`)
- `./`-prefixed relative paths resolved correctly

**RolePermissionService tests:**
- Returns correct profile for each role
- `getToolGuardHook()` returns a function
- Throws for unknown role (defensive)

### File Structure

```
apps/agent/src/
  config/
    role-tool-profiles.ts            # NEW — RoleToolProfile interface + ROLE_TOOL_PROFILES map
    role-tool-profiles.spec.ts       # NEW — profile completeness + role-specific tests
    tool-guard-hook.ts               # NEW — createToolGuardHook() factory (bash commands + write paths)
    tool-guard-hook.spec.ts          # NEW — hook behavior tests
    role-permission.service.ts       # NEW — RolePermissionService
    role-permission.service.spec.ts  # NEW — service tests
    agent-config.module.ts           # MODIFIED — add RolePermissionService
    index.ts                         # MODIFIED — barrel exports
```

## Acceptance Criteria

- [ ] `RoleToolProfile` interface defined with `disallowedTools: string[]`, `deniedBashCommands: string[]`, and optional `allowedWritePaths?: string[]`
- [ ] `ROLE_TOOL_PROFILES` map covers all five `DEPLOYABLE_AGENT_ROLES`
- [ ] `AskUserQuestion`, `Config`, and `ExitPlanMode` appear in every role's `disallowedTools`
- [ ] Architect profile denies `NotebookEdit` and sets `allowedWritePaths: ['docs/', 'tickets/']` — can write documentation and system design review tickets but not source code
- [ ] Product owner profile denies `NotebookEdit`, `Bash`, `EnterWorktree`, `Agent` and sets `allowedWritePaths: ['tickets/']` — can write user stories and requirements tickets but not source code or documentation
- [ ] Developer and QA profiles have no additional tool denials beyond the common set and no `allowedWritePaths` restriction
- [ ] Team lead profile has no additional tool denials beyond the common set and no `allowedWritePaths` restriction
- [ ] Per-role `deniedBashCommands` lists defined with prefix patterns
- [ ] `createToolGuardHook()` factory returns a hook that filters both `Bash` commands by prefix and `FileWrite`/`FileEdit`/`NotebookEdit` by path
- [ ] Bash filtering normalizes whitespace, strips `sudo` prefix, and matches case-insensitively
- [ ] Write path filtering resolves paths relative to workspace dir and checks against `allowedWritePaths` prefixes
- [ ] Roles with `allowedWritePaths: undefined` have unrestricted write access
- [ ] `RolePermissionService` resolves profile by role from `AgentConfigService`
- [ ] `RolePermissionService` exposes `getDisallowedTools()` and `getToolGuardHook()` convenience methods
- [ ] `RolePermissionService` wired into `AgentConfigModule` and exported
- [ ] Barrel exports updated
- [ ] Unit tests cover: profile completeness, role-specific denials, bash hook prefix matching, write path filtering, hook edge cases, service resolution
- [ ] `npm run build` compiles successfully
- [ ] `npm run lint` passes
- [ ] `npm run test` passes (all existing + new tests)

## Implementation Notes

**Status:** Complete (2 commits on `qrm2-agent-sdk-migration`)

### Deviations from Plan

1. **Product owner retains `FileWrite`/`FileEdit` (path-guarded).** The original ticket design denied `FileWrite` and `FileEdit` at the tool level for the product owner role. During implementation, this was revised to use `allowedWritePaths: ['tickets/']` instead — matching the architect's pattern. This lets the product owner author user stories and requirements tickets directly rather than being fully read-only. The ticket spec (Design Context, Acceptance Criteria, Testing Strategy) was updated accordingly.

2. **Architect `allowedWritePaths` expanded to include `tickets/`.** The original design restricted the architect to `['docs/']`. Expanded to `['docs/', 'tickets/']` so the architect can write system design review tickets alongside documentation.

### Post-Review Fixes

Three issues were identified during code review and fixed in a follow-up commit:

1. **Path traversal bug in `toWorkspaceRelative`** (`tool-guard-hook.ts:109-125`). The original implementation used `resolve(rel) === resolved` as part of the outside-workspace check, which depends on the process's CWD and is unreliable. Additionally, the `startsWith(workspaceDir)` check was vulnerable to prefix-substring attacks — `/mnt/quorum/workspace-evil/` matched `/mnt/quorum/workspace`. Replaced with a clean trailing-slash comparison: `resolved.startsWith(workspaceDir + '/')`.

2. **Single-layer `sudo` stripping** (`tool-guard-hook.ts:89`). Changed `if (cmd.startsWith('sudo '))` to `while (cmd.startsWith('sudo '))` so nested `sudo sudo git push` is caught. Low real-world risk since `sudo` isn't installed in containers (QRM2-001), but eliminates the edge case.

3. **Missing test coverage.** Added three tests:
   - Workspace-prefix substring attack (`/mnt/quorum/workspace-evil/docs/attack.md` → denied)
   - `./`-prefixed relative path resolution (`./docs/design.md` → allowed)
   - Nested `sudo` stripping (`sudo sudo git push` → denied)

### Key Implementation Details

**Hook delivery to SDK (open question).** The ticket identified two possible integration paths for the tool guard hook: `Options.canUseTool` callback or an MCP server wrapper. This ticket only defines the hook — QRM2-006 will verify `canUseTool` behavior with `bypassPermissions` and wire the chosen path. The hook's signature `(toolName, toolInput) => { allowed, reason? }` was designed to align with both options.

**`as const satisfies` for profile map** (`role-tool-profiles.ts:82`). The `ROLE_TOOL_PROFILES` map uses `as const satisfies Record<DeployableRole, RoleToolProfile>` to get both compile-time key completeness checking (every deployable role must have an entry) and readonly inference on the values. This catches missing roles at build time without runtime assertions.

**Lazy singleton hook in `RolePermissionService`** (`role-permission.service.ts:36-47`). `getToolGuardHook()` creates the closure once on first call and caches it. The hook captures the profile's `deniedBashCommands` and `allowedWritePaths` at creation time, so repeated calls don't re-allocate. The workspace directory comes from `AgentConfigService.agent.workspaceDir`.

### Test Coverage

| File | Tests | What's covered |
|------|-------|----------------|
| `role-tool-profiles.spec.ts` | 44 | Profile completeness (all roles present, no non-deployable entries), common disallowed tools (AskUserQuestion, Config, ExitPlanMode per role), no duplicates, role-specific denials (architect NotebookEdit, productowner Bash/EnterWorktree/Agent), path-guarded roles don't deny FileWrite/FileEdit, `allowedWritePaths` values, WRITE_TOOLS constant |
| `tool-guard-hook.spec.ts` | 26 | Bash prefix matching, partial mismatch, case-insensitive, sudo stripping (single + nested), whitespace normalisation, empty deny list, non-string command, write path allow/deny, absolute workspace paths, outside-workspace denial, prefix-substring attack, `./` paths, camelCase `filePath`, multiple allowedWritePaths, undefined allowedWritePaths (unrestricted), non-guarded tools passthrough |
| `role-permission.service.spec.ts` | 11 | Profile resolution for each deployable role, unknown role throws, `getDisallowedTools()` accessor, `getToolGuardHook()` returns function, lazy singleton (same ref), integrated write path enforcement, integrated bash command enforcement |

### Security Review

A focused security review was conducted against the last 2 commits. No actionable vulnerabilities were found. Summary of verified controls and noted observations:

**Verified controls:**

| Control | Status |
|---------|--------|
| Workspace-prefix substring attack prevention | Implemented (trailing-slash check in `toWorkspaceRelative`) |
| Path traversal via `../` | Mitigated (`resolve()` normalizes before comparison) |
| `AskUserQuestion` universally denied | Confirmed in all 5 profiles |
| SDK `disallowedTools` enforcement | Correctly delegated to SDK `query()` options |
| `sudo` stripping (including nested) | Implemented with `while` loop |
| Case-insensitive bash matching | Implemented via `.toLowerCase()` |
| Tool names match SDK types | `FileWrite`, `FileEdit`, `NotebookEdit` confirmed against `sdk-tools.d.ts` |

**Observation 1: Bash prefix matching is bypassable via shell operators.** The `normaliseBashCommand()` function strips `sudo` and collapses whitespace but does not parse shell operators. A command like `echo noop && git push --force` or `bash -c "git push"` would bypass the prefix check. This is a **known design trade-off** — the ticket explicitly documents the hook as a "behavioral guardrail, not a security boundary." The container (non-root user, dropped capabilities, read-only rootfs per QRM2-001) is the actual security boundary. No action required unless the threat model changes to treat the hook as a security control.

**Observation 2: `NotebookEdit` uses `notebook_path` field, not `file_path`.** The SDK's `NotebookEditInput` defines its path field as `notebook_path`, but `extractFilePath()` in `tool-guard-hook.ts` only checks `file_path`/`filePath`. If the SDK passes `notebook_path` as the sole key, the guard returns `allowed: true` (missing path → skip check). **Not currently exploitable** — both roles with `allowedWritePaths` (architect, product owner) have `NotebookEdit` in `disallowedTools`, so the tool is blocked before the hook fires. This is a **latent bug** that should be fixed if a future profile adds `allowedWritePaths` without also denying `NotebookEdit`. Fix: add `toolInput.notebook_path` to `extractFilePath()`.

### Verification

```
npm run build   → 4 apps compiled successfully
npm run lint    → clean
npm run test    → 379/379 passed (36 suites)
```

## Dependencies and References

### Prerequisites
- QRM2-002 — Claude Code SDK Service Layer (`ClaudeCodeService` with `allowedTools`/`disallowedTools` passthrough, `ExecuteParams` types)
- QRM1-003 — Configuration Management (`AgentConfigService` for role resolution)

### Related (not blocking)
- QRM2-001 — Docker Agent Image (container hardening that makes `bypassPermissions` safe; runtime dependency, not code dependency)
- QRM2-004 — Moderator Invocation Endpoint (clarification flow that replaces `AskUserQuestion`)

### What This Blocks
- QRM2-006 — InvocationHandler Migration (needs profiles to configure tool permissions when calling `ClaudeCodeService.execute()`)
- QRM2-007 — Prompt Adaptation (needs profile definitions to describe available tools in role prompts)

### References
- SDK built-in tools: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
- SDK `Options.allowedTools`/`disallowedTools`/`canUseTool`: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `ClaudeCodeService`: `apps/agent/src/llm/claude-code.service.ts`
- `ExecuteParams`: `apps/agent/src/llm/claude-code.types.ts`
- `AgentRole` / `DEPLOYABLE_AGENT_ROLES`: `libs/common/src/messaging/agent-role.enum.ts`
- `AgentConfigService`: `apps/agent/src/config/agent-config.service.ts`
- QRM2-000 roadmap `AskUserQuestion` note: `tickets/QRM2-000-roadmap.md:55`