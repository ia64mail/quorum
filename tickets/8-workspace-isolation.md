# #8: QRM8 Roadmap — Workspace Isolation

## Goal

Decouple agent and moderator workspaces from the host filesystem via **git worktree-per-invocation isolation**. QRM7 stabilized the post-QRM6 system for daily use; QRM8 addresses the foundational concurrency and safety gap that becomes untenable as the system scales: every agent container currently bind-mounts the same host directory and edits files in-place on a shared working tree. Two concurrent invocations can silently corrupt each other's work, git state is unpredictable, and the host filesystem is an implicit dependency that prevents remote deployment.

**Primary theme: Workspace Isolation.** Each invocation runs in its own git worktree, agents commit through a handler-controlled path (not the SDK loop), the moderator operates on its own git clone, and the host bind-mount bridge is removed entirely. Secondary deliverables harden the auth layer (PAT wiring, env filtering), redirect agent memory to context_store, and promote cross-turn session resume to the default behavior.

## Problem

The current shared-workspace model was adequate for sequential, single-developer workflows. As Quorum matures toward concurrent multi-agent dispatch, these gaps compound:

| Issue | Impact | Origin |
|-------|--------|--------|
| All agent containers share a single bind-mounted working tree | Concurrent invocations edit the same files; `git status` is non-deterministic; partial commits capture another agent's in-flight work | Architecture since QRM1 — never isolated |
| Agents can run `git commit` directly in the SDK loop | Uncontrolled commit timing, inconsistent commit messages, partial work committed mid-task; no handler-level verification before push | Developer role allows `git commit`; architect/qa deny it but developer/teamlead do not |
| Host filesystem is the single bridge between containers | Cannot deploy on a remote host without NFS/sshfs; host changes bypass git entirely; bind-mount is a container-escape surface | `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` in `docker-compose.yml` |
| No remote git push auth in containers | Agents commit locally today, but the workspace bind mount is what makes those commits reach the host. With the bind mount removed (#11, #14), there is no path for agent or moderator commits to reach the user without remote push, and no PAT or gh credentials are configured. The handler's `checkUncommittedChanges()` warns but can't resolve; moderator has no GitHub CLI integration | Bind-mount transitive: agent identity is wired (`docker-compose.yml:1-5`, `x-git-identity`), git binary is installed (`Dockerfile:48`), developer/teamlead roles permit `git commit` (`role-tool-profiles.ts:51,70-78`), but no remote credentials — relied on the bind mount as the implicit transport |
| `InMemorySessionStore` loses sessions on process restart | Session resume relies on in-process memory; container restart drops all session history; `FileSessionStore` design exists but was never implemented | QRM5-001 identified the fix; `tickets/tmp/session-resume-investigation.md` documented the root cause |
| CC auto-memory writes to ephemeral tmpfs on agents | Memory files accumulate on `~/.claude` tmpfs, lost on restart; model wastes turns writing to a sink that provides no cross-session value; no redirect to the durable Context Store | CC SDK default behavior; agent tmpfs at `docker-compose.yml:34` |
| Moderator depends on host bind mount for workspace access | Moderator cannot `git push`; reads stale host state; no mechanism to detect remote changes by agents | Same bind-mount dependency as agents |
| Cross-turn session resume impossible | `new_conversation` clears `agentSessions` cache (`mcp.service.ts:735`), destroying the cached sessionId for every role at every turn boundary — even when the moderator wants continuity with the same agent | QRM6 design (D5/D6) treated "new turn = new conversation" as default; real usage shows most turns want to continue prior agent context |

## Research Summary

### Per-Invocation Docker Containers vs. Worktree-Per-Invocation

Two isolation strategies were evaluated for preventing concurrent agents from corrupting each other's work:

| Approach | Overhead | Isolation | Verdict |
|----------|----------|-----------|---------|
| **Per-invocation Docker container** | 30–90s cold start (container create + npm install + NestJS bootstrap + MCP reconnect). Even with pre-built images, container orchestration adds significant latency and complexity (dynamic `docker-compose` service creation or Kubernetes job scheduling) | Full OS-level — separate PID/network/filesystem namespaces | **Deferred.** Overkill for the problem. The concurrency issue is file-level (shared working tree), not process-level. Container overhead is 30–90× worse than worktrees. |
| **Git worktree per invocation** | ~1s (`git worktree add` on a local clone). Cleanup is `git worktree remove` in a `finally` block; orphans handled by `git worktree prune` on startup | File-level — each invocation gets its own directory tree branched from the same base repo. Shared process, shared container. | **Chosen.** Sufficient isolation at 1/30th the cost. Same agent container handles multiple concurrent invocations in different worktrees. |

The worktree approach leaves the door open for per-invocation containers later if agents ever need different system packages per task or if worktree cleanup proves unreliable.

### Redis SessionStore vs. FileSessionStore on Named Volume

Three session persistence backends were evaluated (see `tickets/tmp/session-resume-investigation.md` for root-cause analysis):

| Backend | Durability | Complexity | Verdict |
|---------|-----------|------------|---------|
| `InMemorySessionStore` (current) | Process lifetime only — dies on container restart | Zero setup | **Insufficient.** Known failure mode: silent fallback to fresh session on restart. |
| **FileSessionStore on named volume** | Survives container restarts. Per-role named volume prevents cross-role leakage. | One new class implementing SDK `SessionStore` interface; JSONL file per session. | **Chosen (Option A from investigation doc).** SDK author's recommended pattern. No external dependencies. Sufficient for single-host, single-container-per-role. |
| Redis/Postgres SessionStore | Multi-host, cross-container. | Additional infrastructure container, connection management, schema. | **Deferred.** Only needed for multi-host scaling or same-role horizontal scaling (multiple developer containers). |

### Volume-Based Memory Persistence vs. Context Store Redirect

Under #11 worktrees, each invocation's cwd is `/var/agent-worktrees/<correlationId>`. CC encodes this into `~/.claude/projects/-var-agent-worktrees-<correlationId>/memory/` — a per-invocation subdirectory. A shared per-role volume at `~/.claude/projects/` would accumulate disjoint per-invocation memory dirs that no subsequent invocation ever reads. The only workarounds (pinning SDK cwd to a stable non-worktree path, or symlink-hacking each encoded subdir) are fragile across SDK upgrades.

**Verdict:** Volume-based CC memory persistence is structurally non-viable under worktrees. Redirect persistent role-level knowledge to `context_store(scope='agent')` via prompt guidance. Accept that CC memory writes occasionally land on agent tmpfs and die at container restart — the cost is a handful of tokens per session; the benefit is zero implementation work and free memory isolation for future same-role parallelism.

### GitHub App vs. Fine-Grained PAT

| Auth mechanism | Audit trail | Setup | Verdict |
|----------------|-------------|-------|---------|
| **GitHub App** (per-role bot identity) | Per-role commit attribution, fine-grained audit trail per agent | Complex: App registration, installation token rotation, JWT signing, per-container identity secrets | **Deferred.** Single-PAT model is sufficient until audit accountability matters. |
| **Fine-grained PAT** | All commits attributed to PAT owner | Simple: one token in `.env`, env-filtered from SDK subprocess | **Chosen for v1.** Minimal setup, covers clone/push/pull/PR for all agents and moderator. |

### Hard Cut (Option A) vs. Read-Only Host Bridge (Option B) for Moderator

| Option | How it works | Verdict |
|--------|-------------|---------|
| **Option A: Hard cut** | Remove moderator's workspace bind mount entirely. Moderator gets its own git clone on a named volume. Reads codebase from the clone; observes agent work via `git fetch`/`git pull`. | **Chosen.** Cleaner mental model — every container is a git client, the host filesystem is not in the loop at all. Forces workflow discipline: all changes flow through git. |
| **Option B: Read-only host bridge** | Keep moderator's bind mount but make it `:ro`. Moderator can read the host working tree but cannot write. Agent changes still visible via the host filesystem. | **Rejected.** Half-measure — the host filesystem remains an implicit dependency; cannot deploy remotely; moderator sees stale state between host-side git operations; does not force the git-as-transport discipline we want. |

## Design Decisions

### D1: Worktree Per Invocation

**Decision:** Each agent invocation specifies a target branch via `InvokeRequest.branch` (required field) and creates an isolated git worktree at `/var/agent-worktrees/<correlationId>` on that branch. The SDK subprocess runs in the worktree instead of the shared workspace. The worktree is created before `claudeCode.execute()` and removed in the `finally` block of `InvocationHandler.runInvocation()` (`invocation-handler.service.ts:87`).

**Rationale:** Eliminates the shared-working-tree concurrency problem at ~1s overhead per invocation (vs. 30–90s for per-invocation containers). Each invocation gets a branch checkout without affecting any other in-flight work.

**Infrastructure:** Agent containers need a persistent base repository (`/var/agent-repo/` on a named volume) from which worktrees are created. First-boot `git clone` runs in the container entrypoint. `git fetch origin` runs before each `git worktree add` to ensure the branch ref is current. `cwd` added to `ExecuteParams` so `InvocationHandler` can inject the worktree path per invocation (current singleton `this.config.agent.workspaceDir` at `claude-code.service.ts:90` becomes the fallback).

**Orphan cleanup:** If `runInvocation()` crashes after creating a worktree but before the `finally` block (OOM kill, SIGKILL), the worktree persists as an orphan. Mitigation: `git worktree prune` in the agent entrypoint on startup.

### D2: Handler-Controlled Commits

**Decision:** Agents only edit files; `InvocationHandler` commits and pushes after `claudeCode.execute()` completes. All agent roles get `git commit`, `git push`, `git checkout -b`, and `git branch` added to `deniedBashCommands` in `role-tool-profiles.ts`. (Currently developer at line 51 and teamlead at line 70-78 permit `git commit`; architect at line 56-64 and qa at line 82-84 already deny it.)

**Commit flow:**
1. After SDK execution, handler runs `git status --porcelain` in the worktree (replaces current `checkUncommittedChanges()` at `invocation-handler.service.ts:220`)
2. If changes exist: `git add -A && git commit -m "QRM8-NNN: <ticket-derived message>"` with structured commit message derived from invocation action/correlationId
3. `git push origin <branch>` — regular push, no force-push. Fail loudly on rejection (merge conflict = handler returns error, moderator decides).

**Rationale:** Deterministic commit timing, consistent commit messages, handler-level verification before push. Eliminates "partial commit mid-task" failure mode.

### D3: FileSessionStore on Named Volume

**Decision:** Replace `InMemorySessionStore` (`claude-code.service.ts:24`) with a `FileSessionStore` that persists SDK session transcripts to a Docker named volume at `/var/agent-sessions/`. Follows Option A from `tickets/tmp/session-resume-investigation.md`.

**Key design choice — lookup by sessionId only:** The SDK's `SessionKey.projectKey` is derived from the encoded cwd. Under worktree isolation, the cwd changes per invocation (from `/mnt/quorum/workspace` to `/var/agent-worktrees/<correlationId>`). If `FileSessionStore.load()` required a matching `projectKey`, cross-invocation resume would break every time the cwd changed. Since sessionIds are globally-unique UUIDs, keying on sessionId alone is sufficient and safe. `projectKey` is accepted on `append()` for SDK compatibility but ignored on `load()`.

**This resolves the original Concern #3** ("Session store `projectKey` changes with worktree cwd") by design — there is no "hidden tradeoff" because the store simply doesn't use `projectKey` for lookup.

**Silent-fallback detection:** When `request.sessionId` is provided but the agent's response comes back with `result.sessionId !== request.sessionId`, the SDK silently fell back to a fresh session (the `.jsonl` file was missing or corrupt). Log a `WARN` in `InvocationHandler.logResult()` — cheap diagnostic that makes silent fallback visible. This was a persistent debugging pain point during QRM5 session resume work.

### D4: No Host Bind Mount on Agents or Moderator

**Decision:** Option A hard cut. Remove host workspace bind mount from both agent and moderator containers. Both become git clients operating on their own clones/worktrees. The MCP server's bind mount is commented out (D8) but not deleted, preserving a debug escape hatch.

**Rationale:** Cleaner mental model — all containers are git clients; the host filesystem is not in the synchronization path. Enables remote deployment without NFS/sshfs. Forces workflow discipline: every change flows through git, making the system auditable and reproducible.

**Interaction with QRM7-004:** `WORKDIR /mnt/quorum/workspace` remains valid — it points to the git clone location on the named volume instead of the bind mount.

### D5: Fine-Grained PAT, Env-Filtered from SDK Subprocess

**Decision:** Wire a fine-grained GitHub PAT (Contents read-write, Pull Requests read-write, Metadata read — scoped to the Quorum repository) through the system.

**Agent side:** `claude-code.service.ts:103-106` currently spreads `...process.env` into the SDK subprocess env, which would leak `GH_TOKEN`. Replace with an **allowlist** of env vars (`ANTHROPIC_API_KEY`, `HOME`, `PATH`, `NODE_ENV`, `TERM`, `LANG`, `USER`, `SHELL`, and other benign vars). `GH_TOKEN` is available to the NestJS process (for `InvocationHandler` git operations) but filtered out of the SDK subprocess environment.

**Moderator side:** `entrypoint.sh` reads `GH_TOKEN`, runs `gh auth login --with-token`, then `unset GH_TOKEN` before starting CC CLI. Token persists to `~/.config/gh/hosts.yml` on the `moderator-claude-data` volume. Residual risk: model can `cat ~/.config/gh/hosts.yml` — mitigated by tool-guard deny on `~/.config/gh/**` + prompt-level prohibition.

### D6: Branch-in-Flight Guard in MessageBroker

**Decision:** Add a broker-level guard that prevents two concurrent invocations from operating on the same branch. New `branchLocks: Map<string, { correlationId: string; target: AgentRole }>` in `MessageBroker`, checked after existing safeguards (depth, availability, circular call) and before delivery. Lock acquired when delivery starts; released in the `finally` block (mirrors `callChains` lifecycle). With `branch` now a required field (D1), the guard applies universally to every invocation.

**Rationale:** Partial resolution of ICEBOX #1 (Duplicate Invocation Prevention). Combined with `InvocationHandler.inflight` deduplication (`invocation-handler.service.ts:79-91`), the system has two-layer protection. The remaining gap (retries with different branches) is low-risk and deferred.

### D7: Memory Redirected to context_store(scope='agent')

**Decision:** Add a paragraph to `SYSTEM_PREAMBLE` in `role-prompt-templates.ts` explaining that CC memory is ephemeral on agents (lost on container restart) and that persistent role-level knowledge belongs in `context_store(scope='agent')`. Prompt-only change — no mechanical deny rules, no auto-memory prompt stripping.

**Rationale:** CC memory persistence under worktrees is structurally non-viable (see Research Summary). Prompt guidance is sufficient because agents barely use CC memory today — it's mostly a no-op on stateless workers with no user. Quality upgrades (background summarization, agent-scope bootstrap injection, decay/TTL) deferred to QRM9.

**Moderator memory unchanged** — persistent named volume (`moderator-claude-data`) where CC memory works as intended.

### D8: MCP Server Bind Mount Commented Out, Not Removed

**Decision:** Comment out the workspace bind mount on the mcp-server service in `docker-compose.yml` with an inline debug note. Drop `MCP_WORKSPACE_DIR` env var; the `?? '.'` default in `context-store.config.ts:14` handles the missing env. No code changes.

**Rationale:** `MCP_WORKSPACE_DIR` has exactly one consumer (`context-store.config.ts:14` for `InMemoryStore` file path), which is dead code under the OpenSearch backend. The "workspace resource serving" concern was incorrect — MCP resources go through the `ContextStore` abstraction (`mcp.service.ts:762-809`), not the filesystem. Commenting out (rather than deleting) preserves the ability to switch back to `inmemory` backend for debugging.

### D9: Cross-Turn Agent Session Resume Becomes Default

**Decision:** Drop the `agentSessions.clear()` call in the `new_conversation` tool implementation (`mcp.service.ts:735`). The `agentSessions` cache survives across turns. Cross-turn resume becomes the default; explicitly-fresh becomes the opt-in (`sessionId: ""`).

**Today's behavior:** After every `invoke_agent` response, `state.agentSessions.set(target, response.sessionId)` updates the cache (`mcp.service.ts:259`). But `new_conversation` calls `state.agentSessions.clear()` (`mcp.service.ts:735`), destroying every cached sessionId at the turn boundary. Cross-turn resume of the same role is impossible — even when the moderator wants continuity with a prior agent conversation.

**What changes:** `new_conversation` still mints a fresh correlationId (context scoping stays clean) and `callChains` still resets (circular-call guard stays clean). Only `agentSessions` persists. The moderator's API is unchanged — default `invoke_agent` (no explicit sessionId) injects the cached sessionId for the role just like it does today within a turn. To force a fresh session, the moderator passes `sessionId: ""`.

**Tradeoff:** This flips the default from "fresh per turn" to "resume across turns." Symmetric to today, just inverted: explicitly-fresh becomes the new opt-in. This matches actual usage patterns — most turns want to continue prior agent context, not start over. The old default forced unnecessary cold starts and wasted the FileSessionStore investment (D3).

**FileSessionStore synergy (D3):** With sessionId-only lookup (no `projectKey` in the key), resume works regardless of which worktree cwd the new invocation gets. The entire "hidden tradeoff" from the original Concern #3 is eliminated.

**Silent-fallback detection (acceptance criterion):** When `request.sessionId` is provided but `result.sessionId !== request.sessionId`, the SDK silently fell back to fresh. Log a `WARN` in `InvocationHandler.logResult()` — makes the failure visible without breaking the flow.

**Optional v1 — cross-MCP-restart durability:** The `agentSessions` map is in-process memory. On MCP server restart, it's gone (observed multiple times in prior sessions). Optionally persist latest-per-role to `context_store` project scope (`latest-session:<role>` key) on each response, restore on MCP startup. Worth flagging but not blocking for QRM8.

### D10: Turn-Start Pull Reminder in `new_conversation` Response

**Decision:** The `new_conversation` MCP tool's response includes a `reminder` field instructing the moderator to run `git fetch origin && git pull --ff-only` before reading any workspace files. The response format changes from `{ correlationId }` to `{ correlationId, reminder }`. Implementation site: `apps/mcp-server/src/mcp/mcp.service.ts:697-738`.

**Rationale:** With the host bind mount removed (D4), the moderator's workspace is its own git clone — it can go stale between turns as agents push commits. The pull reminder fires at the only moment freshness actually matters (start of each turn) and is mechanical: the MCP tool always returns it, regardless of prompt drift. This is more reliable than depending on `docker/moderator/CLAUDE.md` prompt discipline alone, though the prompt should still document the practice.

**Reminder content:** `"Run git fetch origin && git pull --ff-only before reading any workspace files — agent commits since your last turn may not be in your local clone."`

**Resolves Concern #6** — the gap between "prompt-driven pull" and "mechanical pull" is closed by embedding the reminder in the tool response that already fires on every turn boundary.

## Technical Architecture

### System Overview — After QRM8

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Host                                                                    │
│                                                                          │
│  User's project repo ◀──── git push/pull ────▶  GitHub remote            │
│                                                   ▲   ▲   ▲              │
│  (no bind mounts to any container)                │   │   │              │
└───────────────────────────────────────────────────┼───┼───┼──────────────┘
                                                    │   │   │
┌───────────────────────────────────────────────────┼───┼───┼──────────────┐
│  Docker Compose Network: quorum-net                │   │   │              │
│                                                    │   │   │              │
│  ┌──────────────────────────┐                     │   │   │              │
│  │ moderator container       │ git push/pull ─────┘   │   │              │
│  │                           │                        │   │              │
│  │  Claude Code CLI          │                        │   │              │
│  │  /mnt/quorum/workspace/   │ (own git clone on      │   │              │
│  │   (named volume)          │  moderator-claude-data) │   │              │
│  │  gh auth → hosts.yml      │                        │   │              │
│  │                           │◀──── MCP HTTP ────┐    │   │              │
│  └──────────────────────────┘                    │    │   │              │
│                                                   │    │   │              │
│  ┌──────────────────────────┐                    │    │   │              │
│  │ mcp-server container      │◀───────────────────┘    │   │              │
│  │                           │                        │   │              │
│  │  McpService               │   (bind mount commented │   │              │
│  │  MessageBroker            │    out — debug only)    │   │              │
│  │  AgentRegistry            │                        │   │              │
│  │  ContextStore (OpenSearch)│                        │   │              │
│  │  agentSessions cache      │ (survives across turns) │   │              │
│  │  branchLocks guard        │                        │   │              │
│  └─────────┬────────────────┘                        │   │              │
│            │ POST /invoke                             │   │              │
│  ┌─────────▼────────────────┐                        │   │              │
│  │ agent containers          │ git push (handler) ────┘   │              │
│  │  (architect, developer,   │                            │              │
│  │   teamlead, qa)           │                            │              │
│  │                           │                            │              │
│  │  /var/agent-repo/         │ (persistent named volume   │              │
│  │   (base git clone)        │  — clone source)           │              │
│  │                           │                            │              │
│  │  /var/agent-worktrees/    │ (ephemeral — per-invocation│              │
│  │   <correlationId>/        │  worktree, cleaned up      │              │
│  │                           │  in finally block)         │              │
│  │                           │                            │              │
│  │  /var/agent-sessions/     │ (named volume —            │              │
│  │   (FileSessionStore)      │  session persistence)      │              │
│  │                           │                            │              │
│  │  GH_TOKEN in process env  │ (filtered out of SDK       │              │
│  │   (handler git ops only)  │  subprocess env)           │              │
│  └──────────────────────────┘                             │              │
│                                                            │              │
│  ┌──────────────────────────┐                             │              │
│  │ opensearch / ollama       │─────────────────────────────┘              │
│  └──────────────────────────┘                                            │
└─────────────────────────────────────────────────────────────────────────┘

Synchronization plane: GitHub remote (git push/pull)
No host bind mounts on agents or moderator.
MCP server bind mount commented out (debug escape hatch only).
```

### Worktree Lifecycle

```
InvocationHandler.runInvocation(request)
  │
  ├── git fetch origin                         # ensure branch ref is current
  │     cwd: /var/agent-repo/
  │
  ├── git worktree add /var/agent-worktrees/<correlationId> <branch>
  │     cwd: /var/agent-repo/
  │     branch = request.branch                    # required field — no default
  │
  ├── claudeCode.execute({ ..., cwd: '/var/agent-worktrees/<correlationId>' })
  │     SDK subprocess runs in the worktree
  │     All file edits happen here
  │
  ├── [D2] Handler commit & push (if changes exist)
  │     git add -A && git commit -m "..."
  │     git push origin <branch>
  │     cwd: /var/agent-worktrees/<correlationId>
  │
  └── finally:
        git worktree remove /var/agent-worktrees/<correlationId>
        (cleanup even on error/crash)

On container startup (entrypoint):
  ├── git clone <remote> /var/agent-repo/   (first boot only)
  └── git worktree prune                     (clean orphans from prior SIGKILL)
```

### Branch Routing

```
Moderator picks branch name
  │
  ├── invoke_agent(target=developer, branch="feature/auth", action="implement login")
  │
  ▼
MCP Server (McpService)
  │
  ├── Injects callerRole, correlationId, sessionId (from agentSessions cache)
  │
  ▼
MessageBroker.invoke(request)
  │
  ├── Existing safeguards: depth check, availability, circular-call guard
  ├── [D6] Branch-in-flight guard:
  │     branchLocks.has("feature/auth")?
  │       YES → reject with error ("branch feature/auth already in-flight by developer:abc123")
  │       NO  → branchLocks.set("feature/auth", { correlationId, target })
  │
  ├── Deliver to agent via POST /invoke
  │
  ▼
InvocationHandler (agent side)
  │
  ├── git worktree add ... feature/auth
  ├── SDK executes in worktree
  ├── Handler commits & pushes
  ├── Worktree removed in finally
  │
  └── Response returns to broker
        └── branchLocks.delete("feature/auth") in finally
```

### PAT Flow

```
.env file:
  GH_TOKEN=ghp_xxxxxxxxxxxx

┌─────────────────────────────────────────────────────────────────┐
│ Agent Container                                                  │
│                                                                  │
│  process.env.GH_TOKEN ──┬── InvocationHandler                   │
│                          │    git clone, git push                 │
│                          │    (NestJS process — has the token)    │
│                          │                                        │
│                          └── SDK subprocess                       │
│                               env = ALLOWLIST only                │
│                               (ANTHROPIC_API_KEY, HOME, PATH,    │
│                                NODE_ENV, TERM, LANG, USER, SHELL)│
│                               GH_TOKEN: EXCLUDED                  │
│                               Model cannot read token via         │
│                               printenv or $GH_TOKEN               │
│                                                                  │
│  Residual risk: None — token never enters subprocess env          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Moderator Container                                              │
│                                                                  │
│  entrypoint.sh:                                                  │
│    echo $GH_TOKEN | gh auth login --with-token                   │
│    gh auth setup-git                                             │
│    unset GH_TOKEN                                                │
│    exec claude  ← CC CLI starts without GH_TOKEN in env          │
│                                                                  │
│  ~/.config/gh/hosts.yml persists on moderator-claude-data volume  │
│                                                                  │
│  Residual risk: model can `cat ~/.config/gh/hosts.yml`            │
│  Mitigations:                                                    │
│    1. Tool-guard deny on ~/.config/gh/** in settings.json         │
│    2. Prompt-level prohibition ("never read credential files")    │
│    3. CC CLI permission system blocks unauthorized reads          │
└─────────────────────────────────────────────────────────────────┘
```

### Session Resume Across Turns

```
Turn 1:
  moderator → new_conversation()  → correlationId = C1
  moderator → invoke_agent(target=developer)
    → broker auto-injects sessionId = null (no cache yet)
    → developer runs, returns sessionId = S1
    → broker: agentSessions.set("developer", S1)     [mcp.service.ts:259]

Turn 2:
  moderator → new_conversation()  → correlationId = C2
    → [D9] agentSessions NOT cleared (clear() removed)
    → callChains cleared (circular-call guard resets)
    → correlationId updated to C2

  moderator → invoke_agent(target=developer)
    → broker auto-injects sessionId = S1 (still cached!)
    → developer resumes with S1 transcript
    → FileSessionStore.load({sessionId: S1})  [D3: ignores projectKey]
    → worktree cwd is different, but doesn't matter
    → developer returns sessionId = S1 (same session continued)

  moderator → invoke_agent(target=architect)
    → broker auto-injects sessionId = null (no prior cache for architect)
    → architect starts fresh, returns sessionId = S2
    → broker: agentSessions.set("architect", S2)

Turn 3 (topic change):
  moderator → invoke_agent(target=developer, sessionId="")
    → explicit empty string = force fresh
    → developer starts new session, returns sessionId = S3
    → broker: agentSessions.set("developer", S3)

MCP server restart:
  → agentSessions map lost (in-process memory)
  → [Optional v1] Restore from context_store: latest-session:<role> keys
  → FileSessionStore data survives (on named volume) — session
    transcripts are not lost, only the cache pointing to them

Silent-fallback detection:
  → request.sessionId = S1, but response.sessionId = S4 (different!)
  → InvocationHandler.logResult() emits WARN:
    "Session resume silent fallback: requested=S1 got=S4"
  → Indicates .jsonl was missing/corrupt — FileSessionStore has a gap
```

### Memory Redirect

Single paragraph added to `SYSTEM_PREAMBLE` in `libs/common/src/prompts/role-prompt-templates.ts`:

> Claude Code memory (`~/.claude/`) is ephemeral on agent containers — files accumulate on tmpfs during a session but are lost on container restart. Do not rely on CC memory for persistent knowledge. Instead, use `context_store(scope='agent')` to persist role-level knowledge (patterns learned, preferences, architectural constraints discovered) that should survive across invocations.

No mechanical fences. No auto-memory deny rules. Moderator memory unchanged (persistent volume).

## Success Criteria

1. **Worktree isolation works:** Two parallel `developer` invocations on different branches complete without file collision. Each invocation's `git status` shows only its own changes.

2. **Handler-controlled commits:** Agent SDK subprocess cannot run `git commit` or `git push` (denied by tool profiles). Handler produces structured commit messages. `git log` shows handler-authored commits only.

3. **No host bind mounts:** Moderator pushes a branch, agent pulls and edits, moderator can `git fetch` and read the change — without ever touching a host bind mount. `docker-compose.yml` has zero active workspace bind mounts on agents/moderator.

4. **Session resume across turns:** Agent process restart followed by `invoke_agent` with sessionId resumes the prior transcript (FileSessionStore actually works). Across turn boundaries (`new_conversation`), cached sessionIds persist and resume works by default.

5. **Silent-fallback detection:** When the SDK silently falls back to a fresh session (sessionId mismatch), a `WARN` log line appears — no more silent failures.

6. **PAT env filtering validated:** `printenv` output of the SDK subprocess does not contain `GH_TOKEN`. Handler git operations (clone, push) succeed with the token.

7. **Branch-in-flight guard:** Concurrent `invoke_agent` calls targeting the same branch → second call returns a descriptive error, not a silent collision.

8. **Memory redirect:** Agent prompts include context_store guidance. No memory-related regressions in multi-step task quality (monitored post-deployment).

9. **MCP server bind mount commented:** `docker-compose.yml` mcp-server bind mount is commented with a debug note. System operates normally under OpenSearch backend.

10. **Cross-turn resume is the default:** `invoke_agent` without explicit sessionId resumes the prior session for that role across turn boundaries. `sessionId: ""` forces fresh. Moderator prompt documents the new default.

11. **Moderator turn-start reminder:** `new_conversation` response includes a `reminder` field. Moderator's first action after `new_conversation` is `git pull` (verifiable in logs).

12. **Mandatory branch validation:** All `invoke_agent` calls include a `branch` field. Requests without `branch` are rejected by zod validation with a descriptive error.

## Scope Exclusions

| Item | Why excluded | Revisit when |
|------|-------------|--------------|
| **Per-invocation Docker containers** | Worktrees provide sufficient isolation at ~1s vs. 30–90s overhead. Container orchestration adds complexity with no proportional benefit for file-level isolation. | Worktrees prove insufficient (e.g., agent needs different system packages per task, or worktree cleanup is unreliable) |
| **Redis SessionStore** | FileSessionStore on named volume is sufficient for single-host, single-container-per-role deployment. No external dependency. | Multi-host scaling or same-role horizontal scaling (multiple developer containers) |
| **Context Store quality upgrades** | Background summarization, agent-scope bootstrap injection, decay/TTL — these make `context_store(scope='agent')` a full replacement for CC memory. Valuable but out of scope for QRM8's isolation theme. | QRM9. Monitor agent performance after #16 lands; if agents show degraded multi-step task quality, escalate priority |
| **Per-role git identity** | All commits attributed to PAT owner's GitHub identity. Per-role identity (separate GitHub Apps or bot accounts) enables audit trails per agent. | When audit accountability matters — deferred until the single-PAT model causes real confusion |
| **Web UI / remote moderator** | QRM8 removes bind mounts but keeps the moderator as a local Docker-attached CLI session. Remote access (web UI, SSH tunnel) is a separate concern. | User demand for remote access without Docker exec |
| **`new_conversation` prompt alignment** | The moderator prompt in `docker/moderator/CLAUDE.md` should align language with D9 (session cache persists across turns) and D10 (turn-start reminder). This is a prompt refinement, not a code change. The mechanical reminder (D10) reduces the urgency — the prompt change is polish, not a safety gap. | #14 or shortly after |
| **Automatic `agentSessions` restore from context_store on MCP restart** | The optional cross-MCP-restart durability for D9. Valuable but not blocking — MCP restarts are infrequent and FileSessionStore data survives regardless (only the cache pointer is lost). | If MCP restart frequency increases or session resume failures become a pain point |

---

## Milestone Scope

### #10 — FileSessionStore on Named Volume

**Status:** Open (builds on QRM5-001 session resume foundation)

Replace `InMemorySessionStore` with a `FileSessionStore` that persists SDK session transcripts to a Docker named volume. The current in-memory store (`claude-code.service.ts:24`) loses all session data on process restart — resume only works within a single container lifetime. The `FileSessionStore` implementation follows the design validated in `tickets/tmp/session-resume-investigation.md` (Option A). **Implements D3 (FileSessionStore), the mcp-server-side change for D9 (cross-turn resume), and D10 (turn-start reminder in `new_conversation` response).**

**Key decisions:**
- Storage path: `/var/agent-sessions/` on a per-role named Docker volume (not the workspace mount, which is removed in #11)
- Implements the SDK `SessionStore` interface (`append`, `load`, `listSubkeys`)
- **[D3] Session lookup keyed by `sessionId` only** — `projectKey` is accepted on `append()` for SDK compatibility but ignored on `load()`. SessionIds are globally-unique UUIDs; worktree cwd changes don't break resume.
- The volume survives container restarts; each agent role gets its own volume to prevent cross-role session leakage
- `InMemorySessionStore` import removed; `FileSessionStore` injected via NestJS DI for testability

**Touches:** `apps/agent/src/llm/claude-code.service.ts` (swap store), `apps/agent/src/llm/file-session-store.ts` (new), `docker-compose.yml` (add per-role session volumes + mount), `apps/agent/src/llm/claude-code.types.ts` (export store interface if needed), **`apps/mcp-server/src/mcp/mcp.service.ts`** (remove `agentSessions.clear()` from `new_conversation` at line 735 — D9; add `reminder` field to `new_conversation` response at lines 697-738 — D10)

**Acceptance criteria:**
1. `FileSessionStore.load({sessionId})` returns session entries regardless of `projectKey` value (sessionId-only lookup)
2. `FileSessionStore.append()` persists JSONL entries that survive container restart
3. Resume across invocations: SDK `query()` with `resume: sessionId` + `sessionStore` restores prior transcript
4. `agentSessions.clear()` removed from `new_conversation` — cached sessionIds survive across turns (D9)
5. `WARN` logged in `InvocationHandler.logResult()` when `result.sessionId !== request.sessionId` (silent-fallback detection)
6. (Optional) Persist latest-per-role sessionId to `context_store` project scope (`latest-session:<role>` key) on each response; restore on MCP startup for cross-restart resilience
7. `new_conversation` response includes a `reminder` field instructing the moderator to run `git fetch origin && git pull --ff-only` before reading workspace files (D10)

**Depends on:** —

**Full ticket:** [#10](10-file-session-store.md)

### #11 — Git Worktree Per Invocation + Agent-Side Repository Infrastructure

**Status:** Open (core isolation mechanism — implements D1)

Each invocation creates an isolated git worktree at `/var/agent-worktrees/<correlationId>` and the SDK subprocess runs there instead of the shared workspace. This is the central deliverable of QRM8 — it eliminates the shared-working-tree concurrency problem.

**Infrastructure changes:**
- **Agent git clone**: Each agent container needs a persistent base repository to create worktrees from. Replace the `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` bind mount with a named volume at `/var/agent-repo/` containing a git clone. First-boot initialization (`git clone`) runs in the container entrypoint. **Note:** #15 creates the agent entrypoint (`docker/agent/entrypoint.sh`) with `gh auth login` + `gh auth setup-git` + `unset GH_TOKEN`; #11 extends this existing entrypoint with `git clone` initialization — the git credential helper is already configured by #15, so `git clone https://github.com/...` authenticates transparently.
- **Branch param**: Add `branch` (required string) to `invokeRequestSchema` in `libs/common/src/messaging/invoke.types.ts`. Every caller must specify the target branch; zod validation rejects requests without `branch` with a descriptive error. The handler checks out the specified branch via `git worktree add`.
- **Worktree lifecycle**: `InvocationHandler.runInvocation()` creates the worktree before `claudeCode.execute()` and removes it in `finally`. The worktree path becomes the per-invocation cwd.
- **cwd parameterization**: `ClaudeCodeService.execute()` currently reads cwd from `this.config.agent.workspaceDir` (line 90). Add `cwd` to `ExecuteParams` so the handler can inject the worktree path per invocation. The config-based default becomes the fallback for non-worktree execution (e.g., tests).
- **Git fetch before worktree**: `git fetch origin` runs before `git worktree add` to ensure the branch ref is up to date.

**Key decisions:**
- Worktree directory (`/var/agent-worktrees/`) lives on tmpfs or an ephemeral volume — worktrees are short-lived and cleaned up after each invocation
- The base repo volume (`/var/agent-repo/`) is persistent (named volume) — survives container restarts, avoids re-cloning
- `AGENT_WORKSPACE_DIR` env var semantics change: it now points to the base repo, not the workspace; the actual SDK cwd is the worktree path

**Touches:** `libs/common/src/messaging/invoke.types.ts` (add `branch` field), `apps/agent/src/connection/invocation-handler.service.ts` (worktree lifecycle), `apps/agent/src/llm/claude-code.service.ts` (accept cwd in params), `apps/agent/src/llm/claude-code.types.ts` (add cwd to ExecuteParams), `apps/agent/src/config/agent.config.ts` (redefine workspaceDir semantics), `docker-compose.yml` (remove bind mount, add repo + worktree volumes), `docker/agent/entrypoint.sh` (extend with clone init — file created by #15), `Dockerfile` (agent stage: create `/var/agent-worktrees/` dir; ENTRYPOINT already set by #15)

**Depends on:** #15 (PAT wiring — the clone and fetch operations need git auth)

**Full ticket:** [#11](11-worktree-per-invocation.md)

### #12 — Handler-Controlled Commit and Push

**Status:** Open (completes the "agents only edit, handler does git" model — implements D2)

Move `git add`, `git commit`, and `git push` out of the SDK loop and into `InvocationHandler`. Today, agents with developer/teamlead roles can run `git commit` directly via Bash; the handler only detects uncommitted changes post-invocation (`checkUncommittedChanges()` at line 220). Under QRM8, the handler is the sole committer:

1. After `claudeCode.execute()` completes, the handler runs `git status --porcelain` in the worktree
2. If changes exist: `git add -A && git commit -m "QRM8-NNN: <ticket-derived message>"` with a structured commit message
3. `git push origin <branch>` pushes the branch to the remote (auth: the gh credential helper configured by #15's agent entrypoint handles HTTPS authentication transparently — the handler does NOT need to read `GH_TOKEN` or inject credentials into the push command)
4. All agent roles get `git commit` and `git push` added to `deniedBashCommands` in `role-tool-profiles.ts`
5. `git checkout -b` also denied for all roles (the handler controls branching via worktrees)

**Commit message format:** The handler constructs the message from the invocation's action and correlationId. If the action contains a ticket ID (e.g., "#12"), it uses that as the prefix. Otherwise, it uses the correlationId as a reference.

**Touches:** `apps/agent/src/connection/invocation-handler.service.ts` (replace `checkUncommittedChanges` with `commitAndPush`), `apps/agent/src/config/role-tool-profiles.ts` (deny `git commit`/`git push`/`git checkout -b` for all roles), `apps/agent/src/config/tool-guard-hook.spec.ts` (update tests)

**Depends on:** #11 (worktree cwd — commit/push targets the worktree), #15 (PAT — push auth)

**Full ticket:** [#12](12-handler-commit-push.md)

### #13 — Branch-in-Flight Guard in MessageBroker

**Status:** Open (concurrency safeguard — implements D6)

Add a broker-level guard that prevents two concurrent invocations from operating on the same branch. When `invoke_agent` is called with a `branch` that is already in-flight (an active invocation targeting the same branch has not yet returned), the broker rejects the request with a descriptive error rather than allowing concurrent edits.

**Mechanism:**
- New `branchLocks: Map<string, { correlationId: string; target: AgentRole }>` in `MessageBroker`
- Checked after existing safeguards (depth, availability, circular call) and before delivery
- Lock acquired when delivery starts; released in the `finally` block (mirrors `callChains` lifecycle)
- With `branch` now a required field, the guard applies universally — every invocation contributes a branch lock

**Relationship to ICEBOX #1 (Duplicate Invocation Prevention):** This guard partially resolves the icebox item by preventing same-branch collisions — the most damaging form of duplicate invocation. Combined with the existing `InvocationHandler.inflight` deduplication (`invocation-handler.service.ts:78-91`), the system now has two-layer protection. The remaining gap (retries with different branches) is low-risk and deferred.

**Touches:** `apps/mcp-server/src/messaging/message-broker.service.ts` (new safeguard), `apps/mcp-server/src/messaging/message-broker.service.spec.ts` (test coverage)

**Depends on:** #11 (the `branch` field in `InvokeRequest` must exist for the guard to operate)

**Full ticket:** [#13](13-branch-in-flight-guard.md)

### #14 — Moderator Becomes Standalone Git Client

**Status:** Open (moderator-side isolation — implements D4, D5 moderator side)

Remove the moderator's workspace bind mount (`${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) and replace it with a standalone git clone on the existing `moderator-claude-data` named volume (or a dedicated volume). The moderator becomes a pure git client — it reads the codebase from its own clone and observes agent work via `git fetch`/`git pull`.

**Implementation:**
- `docker/moderator/entrypoint.sh` gains first-boot `git clone` logic (clone into `/mnt/quorum/workspace` on the named volume if the directory is empty or not a git repo)
- `gh auth login --with-token` runs at container start using `GH_TOKEN` env var; token persists to `~/.config/gh/hosts.yml` on the named volume; `unset GH_TOKEN` before CC CLI starts so the model cannot read it from the environment
- `gh auth setup-git` configures git credential helper for HTTPS push/pull
- Moderator's prompt instructs it to run `git fetch origin && git pull --ff-only` after each `new_conversation` call (reinforced mechanically by D10's reminder field in the `new_conversation` response)
- **[D9] Prompt note for cross-turn resume:** "Cross-turn session resume now works by default — cached sessionIds persist across `new_conversation` boundaries. Pass `sessionId: ""` only when genuinely switching topics or when you want a completely fresh agent session."
- **Mandatory `branch` parameter:** Moderator must specify `branch` in every `invoke_agent` call — there is no default. For read-only or review invocations, use the feature branch in scope (or `main` for general codebase exploration).
- Tool-guard defense-in-depth: deny `cat ~/.config/gh/hosts.yml` and similar paths via moderator settings.json deny rules
- `docker-compose.yml`: remove workspace bind mount from moderator service; add GH_TOKEN to moderator environment (with note to unset in entrypoint)

**Interaction with QRM7-004:** QRM7-004 sets `WORKDIR /mnt/quorum/workspace`. This path remains valid under #14 — it points to the git clone location on the named volume instead of the bind mount. The WORKDIR change in QRM7-004 is preserved and works correctly with the new backing storage. CC CLI still auto-loads `CLAUDE.md` from cwd.

**Touches:** `docker/moderator/entrypoint.sh` (clone + auth bootstrap), `docker-compose.yml` (remove bind mount, add GH_TOKEN env), `Dockerfile` moderator stage (ensure git/gh CLI available, create clone target dir), `docker/moderator/settings.json` (add deny rules for credential paths)

**Depends on:** #15 (PAT and gh CLI auth — the clone needs credentials)

**Full ticket:** [#14](14-moderator-git-client.md)

### #15 — PAT Wiring and SDK Environment Filtering

**Status:** Open (remote auth foundation — implements D5; commit identity already wired via `x-git-identity`)

Wire a fine-grained GitHub Personal Access Token (PAT) through the system. The PAT enables `git clone`, `git push`, and `gh` CLI operations. Critically, the agent SDK subprocess must **not** see the token — the model could exfiltrate it via tool calls.

**PAT scope:** Contents (read-write), Pull Requests (read-write), Metadata (read). Scoped to the Quorum repository only.

**Agent side (SDK env filtering + entrypoint auth bootstrap):**
- `claude-code.service.ts:103-106` currently spreads `...process.env` into the SDK subprocess env, which would leak `GH_TOKEN`. Replace with an **allowlist** of env vars: `ANTHROPIC_API_KEY`, `HOME`, `PATH`, `NODE_ENV`, `TERM`, `LANG`, `USER`, `SHELL`, and other benign vars. Everything else is excluded.
- New `docker/agent/entrypoint.sh` runs `gh auth login --with-token` + `gh auth setup-git` + `unset GH_TOKEN` before starting the NestJS process. After this, `GH_TOKEN` is absent from `process.env` (defense layer 1) and the env allowlist filters it from the SDK subprocess (defense layer 2). Git operations from `InvocationHandler` authenticate via the gh credential helper — the handler never reads `GH_TOKEN` directly.
- #11 extends this entrypoint with `git clone` initialization; #12's `git push` authenticates via the credential helper.

**Moderator side (gh CLI bootstrap):**
- `entrypoint.sh` reads `GH_TOKEN`, runs `gh auth login --with-token` + `gh auth setup-git`, then `unset GH_TOKEN` before starting CC CLI
- Token persists to `~/.config/gh/hosts.yml` on tmpfs (`~/.config` is tmpfs from `x-base-security`, not the named volume — re-created from `GH_TOKEN` on each container start)
- Residual risk: model can `cat ~/.config/gh/hosts.yml` — mitigated by tool-guard deny on `~/.config/gh/**` + prompt-level prohibition

**Docker Compose (already done by #20):**
- `GH_TOKEN: ${GH_TOKEN}` already in agent services (via `x-shared-env`) and moderator service environment
- `.env.example` already has `GH_TOKEN` placeholder

**Touches:** `apps/agent/src/llm/claude-code.service.ts` (env allowlist), `docker/agent/entrypoint.sh` (new: agent gh auth + credential helper), `Dockerfile` agent stage (COPY entrypoint, set ENTRYPOINT), `docker/moderator/entrypoint.sh` (add gh auth + setup-git block), `docker/moderator/settings.json` (deny rules for gh credential paths)

**Depends on:** —

**Full ticket:** [#15](15-pat-wiring.md)

### #16 — Redirect Agent Memory to Context Store

**Status:** Open (prompt-only change — implements D7)

Add a paragraph to `SYSTEM_PREAMBLE` in `role-prompt-templates.ts` explaining that CC memory is ephemeral on agents (lost on container restart) and that persistent role-level knowledge belongs in `context_store(scope='agent')`. No mechanical deny rules, no auto-memory prompt stripping — prompt guidance only.

**Structural finding — why volume-based persistence isn't viable:** Under #11 worktrees, each invocation's cwd is `/var/agent-worktrees/<correlationId>`, which CC encodes into `~/.claude/projects/-var-agent-worktrees-<correlationId>/memory/` — a per-invocation subdirectory. A shared per-role volume at `~/.claude/projects/` would accumulate disjoint per-invocation memory dirs that no subsequent invocation reads. The only workarounds (pinning SDK cwd to a stable non-worktree path, or symlink-hacking each encoded subdir) are fragile across SDK upgrades. Memory persistence through CC-native means is structurally broken under worktrees.

**What we accept:** Memory writes occasionally happen on agent tmpfs and die at container restart. Cost: a handful of tokens per session. Benefit: zero implementation work, zero maintenance, and same-role parallelism (future) gets memory isolation for free from the cwd encoding.

**Moderator memory unchanged** — the moderator has a persistent named volume (`moderator-claude-data`) where memory files persist across restarts. CC memory works as intended there.

**Known regression:** Manual `context_store(scope='agent')` is functionally weaker than CC auto-memory — agents must explicitly decide what to store and when. In practice, agents barely use CC memory today (it's mostly a no-op on stateless workers with no user), so the gap is narrow. Quality upgrades (background summarization, agent-scope bootstrap injection, decay/TTL) are deferred to QRM9 and will close this gap further.

**Touches:** `libs/common/src/prompts/role-prompt-templates.ts` (add memory redirect paragraph to `SYSTEM_PREAMBLE`)

**Depends on:** —

**Full ticket:** [#16](16-disable-agent-memory.md)

### #17 — MCP Server Bind Mount Removal

**Status:** Open (trivial docker-compose cleanup — implements D8)

Comment out the workspace bind mount on the mcp-server service and drop the `MCP_WORKSPACE_DIR` environment variable. Audit confirmed `MCP_WORKSPACE_DIR` has exactly one consumer: `context-store.config.ts:14`, which computes the `quorum.context` file path for `InMemoryStore` persistence. Under `CONTEXT_STORE_BACKEND: opensearch` (production default), this path is vestigial — `InMemoryStore` file persistence is dead code and `MigrationService.onModuleInit()` handles file-not-found gracefully (line 79). The "workspace resource serving" concern from the original Concern #5 was incorrect: `context://project` and `context://conversation/{correlationId}` MCP resources go through the `ContextStore` abstraction (`mcp.service.ts:762-809`) and never touch the filesystem.

**Changes:**
- `docker-compose.yml:128` — comment out `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` with inline note: mount only needed if switching back to `inmemory` backend for debug
- `docker-compose.yml:105` — drop `MCP_WORKSPACE_DIR` env var; the `?? '.'` default in `context-store.config.ts:14` routes to `/app` (mcp-server WORKDIR) — acceptable since the file is never read under OpenSearch

**No code changes.** `context-store.config.ts:14` default handles the missing env var. No migration concerns — OpenSearch index is already populated; `MigrationService` no-ops on re-run.

**Touches:** `docker-compose.yml` (2 lines: comment out bind mount, remove env var)

**Depends on:** —

**Full ticket:** [#17](17-mcp-server-bind-mount.md)

---

## Dependency Graph

```
#10 (FileSessionStore + D9)     ─── independent
#15 (PAT Wiring)               ─── independent
#16 (Redirect Agent Memory)    ─── independent
#17 (MCP Bind Mount Removal)   ─── independent

#15 ──┬── #11 (Worktree Per Invocation)
            └── #14 (Moderator Git Client)

#11 ──┬── #12 (Handler Commit/Push)
            └── #13 (Branch-in-Flight Guard)

#15 ──── #12 (Handler Commit/Push)
```

**Summary of constraints:**
- #11 depends on #15 (clone/fetch need git auth)
- #12 depends on #11 (worktree cwd) AND #15 (push auth)
- #13 depends on #11 (branch field in InvokeRequest)
- #14 depends on #15 (gh auth, PAT)
- #17 is independent (no code changes, no dependencies)
- #10, #15, #16, #17 are independent of each other and of the chain

## Recommended Sequencing

```
Phase 1 (foundations, parallel):
  #10  FileSessionStore + D9 (cross-turn resume)
  #15  PAT Wiring
  #16  Redirect Agent Memory
  #17  MCP Server Bind Mount Removal

Phase 2 (core isolation):
  #11  Worktree Per Invocation    ← needs #15

Phase 3 (hardening, parallel after Phase 2):
  #12  Handler Commit/Push        ← needs #11 + #15
  #13  Branch-in-Flight Guard     ← needs #11
  #14  Moderator Git Client       ← needs #15

Phase 4 (integration testing):
  Full-system validation with all isolation changes active
```

**Rationale for deviation from proposed ordering:**

The original proposal sequenced #15 (PAT) after #12 (commit/push), but commit/push requires auth to function — `git push` from the handler fails without credentials. #15 is a foundational dependency and must land before #11 (clone needs auth) and #12 (push needs auth). Moving it to Phase 1 unblocks the entire agent-side chain.

#10 and #16 are genuinely independent and can run in any phase; placing them in Phase 1 front-loads work that has no blocking dependencies. #10 now includes the D9 mcp-server change (removing `agentSessions.clear()`) — this is a one-line deletion with no dependencies, and bundling it with the FileSessionStore work ensures cross-turn resume is testable as soon as the store lands.

#12 and #13 can run in parallel in Phase 3 because they touch different codebases (agent app vs. MCP server) and #13 only needs the `branch` field from #11, not the commit/push mechanics.

## Carry-Forward Registry

Items carried into QRM8 from previous milestones:

| Item | Origin | QRM8 Ticket |
|------|--------|-------------|
| FileSessionStore on named volume | `tickets/tmp/session-resume-investigation.md` Option A; QRM5-001 foundation | #10 |
| Duplicate Invocation Prevention (branch-level) | ICEBOX #1 (partial resolution) | #13 |

## Cross-References

### QRM7-004 — Moderator cwd Alignment (Interaction)

QRM7-004 moves the moderator's `WORKDIR` from `/app` to `/mnt/quorum/workspace`. #14 removes the workspace bind mount and replaces it with a git clone at the same path. The two are **compatible**: `WORKDIR /mnt/quorum/workspace` remains valid — it points to the clone location on the named volume instead of the host bind mount. QRM7-004 should land before #14 so the cwd fix is in place when the backing storage changes.

### QRM5-001 — Agent Session Resume (Foundation)

#10 builds directly on QRM5-001's session resume architecture. QRM5-001 surfaced `sessionId` in `InvokeResponse`, added `sessionId` to `InvokeRequest`, and established the moderator-driven resume model. #10 replaces the `InMemorySessionStore` that QRM5-001 acknowledged as insufficient for cross-restart persistence. D9 extends the model by making cross-turn resume the default behavior.

### QRM6 D5/D6 — Correlation ID and Session Tracking (Interaction)

QRM6's D5 (`new_conversation` mints correlationId) and D6 (server-side session tracking) established the `agentSessions` cache and the `new_conversation` reset pattern. D9 modifies this by removing the `agentSessions.clear()` from `new_conversation` — correlationId still resets (context scoping), `callChains` still resets (circular-call guard), but session cache persists. This is a targeted refinement of D6, not a contradiction.

### ICEBOX #1 — Duplicate Invocation Prevention (Partial Resolution)

#13's branch-in-flight guard prevents the most damaging form of duplicate invocation (two agents editing the same branch). Combined with `InvocationHandler.inflight` deduplication (per-correlationId, per-agent), the system has two-layer protection. ICEBOX #1 can be updated to reflect the partial resolution; the remaining gap (transport-error retries targeting different branches) is low-risk.

### ICEBOX #3 — Agent Session Resume via Correlation ID (Unchanged)

The upstream SDK prompt-cache issues (#247, #192) remain open. #10 improves session **persistence** but does not address prompt-cache **efficiency**. ICEBOX #3 stays as-is — the SDK#247 angle is independent of QRM8's scope.

## Concerns and Open Questions

### 1. Agent-side git clone initialization (hidden scope in #11)

The direction specifies that agents lose the workspace bind mount, but the ticket list doesn't explicitly call out the agent-side git clone infrastructure. Worktrees require a base repository. Each agent container needs:
- A named Docker volume for the base repo (`/var/agent-repo/`)
- First-boot clone logic (entrypoint or InvocationHandler)
- `git fetch origin` before each `git worktree add`

This is substantial infrastructure work — an agent entrypoint script (agents currently have none; they run `node dist/main.js` directly), a new volume per agent role in `docker-compose.yml`, and error handling for clone failures. It should be scoped explicitly in #11, not discovered during implementation.

### 2. `cwd` parameterization is a non-trivial refactor

`ClaudeCodeService.execute()` reads cwd from `this.config.agent.workspaceDir` — a singleton injected at startup. Under worktree isolation, cwd is per-invocation. The `ExecuteParams` interface needs a `cwd` field, and the call site in `InvocationHandler` must inject the worktree path. This is a clean change but touches the SDK integration surface — test carefully.

### 3. Session store `projectKey` — resolved by D3

~~The SDK's `SessionKey.projectKey` is derived from the encoded cwd. Under worktree isolation, the cwd changes per invocation. This could break cross-invocation resume if the store requires matching `projectKey` on lookup.~~

**Resolved:** D3 specifies sessionId-only lookup — `projectKey` is accepted on `append()` for SDK compatibility but ignored on `load()`. SessionIds are globally-unique UUIDs, so this is safe. The silent-fallback detection (D9 acceptance criterion: `WARN` on sessionId mismatch) makes any residual failure mode visible rather than silent. See Design Decisions D3 and D9 for full rationale.

### 4. Worktree cleanup on handler crash

If `InvocationHandler.runInvocation()` crashes after creating a worktree but before the `finally` block executes (e.g., OOM kill, SIGKILL), the worktree persists as an orphan. The `git worktree` system tracks these as "prunable." Mitigation: add a startup sweep (`git worktree prune`) in the agent entrypoint, and consider periodic cleanup if long-running containers accumulate stale worktrees.

### 5. MCP server bind mount — resolved, promoted to #17

**Original concern:** The MCP server mounts `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` and removing it might break workspace resource serving or other `MCP_WORKSPACE_DIR` consumers. Deferred to QRM9 pending audit.

**Resolved:** Audit confirmed single consumer (`context-store.config.ts:14`), dead under OpenSearch. Promoted to #17. See Design Decisions D8.

### 6. Moderator git-pull is prompt-driven, not mechanical — resolved by D10

~~The plan to run `git fetch && git pull --ff-only` at every `new_conversation` call relies on the moderator's prompt compliance. The moderator could forget, resulting in stale reads.~~

**Resolved:** D10 adds a `reminder` field to the `new_conversation` tool response instructing the moderator to run `git fetch origin && git pull --ff-only` before reading any workspace files. This fires at the only moment freshness matters (start of turn) and survives prompt drift better than relying on `docker/moderator/CLAUDE.md` discipline alone. Implementation lands in #10 (same function as D9's `agentSessions.clear()` removal).

### 7. Tool-guard updates needed across all roles (#12 scope)

Currently, `deniedBashCommands` for git operations differ by role:
- **developer**: denies `git push --force`, `git push -f` only
- **teamlead**: denies `git push --force`, `git push -f` only
- **architect**: denies `git push`, `git commit`, `git checkout -b`
- **qa**: denies `git push`, `git commit`
- **productowner**: Bash fully disabled

Under the "handler does git" model, **all roles** should deny `git commit`, `git push`, `git checkout -b`, and `git branch`. #12 must update all five role profiles in `role-tool-profiles.ts`, not just the developer. The architect's existing denials are already close to the target state.

## Icebox Items (Not Scheduled)

The following items from `tickets/ICEBOX.md` are noted for awareness:

- **Duplicate Invocation Prevention** — ICEBOX #1 is **partially resolved** by #13 (branch-in-flight guard). Update the icebox entry to reflect the remaining gap (retries targeting different branches). Do not promote further; the residual risk is low.
- **Agent Session Resume via Correlation ID** — ICEBOX #3 remains unchanged. The upstream SDK prompt-cache issues (#247, #192) are independent of QRM8's scope.

## References

- [QRM7-000-roadmap.md](QRM7-000-roadmap.md) — predecessor milestone; QRM8 builds on QRM7's stabilization
- [QRM5-001-agent-session-resume.md](QRM5-001-agent-session-resume.md) — session resume architecture that #10 completes
- [tmp/session-resume-investigation.md](tmp/session-resume-investigation.md) — root cause analysis and FileSessionStore design
- [QRM7-004-moderator-cwd-not-aligned-with-workspace.md](QRM7-004-moderator-cwd-not-aligned-with-workspace.md) — WORKDIR fix that #14 interacts with
- [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — predecessor milestone; QRM6's D5/D6 session tracking pattern refined by QRM8 D9
- [ICEBOX.md](ICEBOX.md) — unscheduled technical debt registry
- [docs/system-design.md](../docs/system-design.md) — current system architecture
- [docs/claude-code-sdk.md](../docs/claude-code-sdk.md) — SDK integration reference
