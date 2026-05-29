# Changelog

All notable changes to Quorum are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely — section names are adapted to the project's needs (New Features, Bug Fixes, Documentation, Internal / Other Changes). Each entry is a one-line summary; for full milestone narrative, follow the cross-reference to the matching release note in [`releases/`](releases/).

## [v0.8.0-beta] (QRM8) — 2026-05-29 — Workspace Isolation

Full milestone notes: [releases/RELEASE-QRM8.md](releases/RELEASE-QRM8.md)

### New Features

- **Git worktree-per-invocation isolation** (#11) — each agent invocation creates an isolated worktree at `/var/agent-worktrees/<correlationId>` on the target branch; SDK subprocess runs there instead of the shared workspace; cleanup in `finally` block eliminates cross-invocation file corruption.
- **Handler-controlled commit and push** (#12) — `git commit` and `git push` removed from the SDK loop; `InvocationHandler` extracts a `<commit-message>` delimiter from the agent's response, commits after SDK exit, and pushes via gh credential helper; all roles now deny direct git commit/push/checkout-b.
- **Branch-in-flight guard** (#13) — `MessageBroker` prevents two concurrent invocations from targeting the same branch; `branchLocks` map mirrors `callChains` lifecycle with descriptive error on collision.
- **Moderator standalone git client** (#14) — moderator's workspace bind mount replaced with a git clone on a named volume; `new_conversation` returns a `reminder` field instructing `git pull` before reading files.
- **FileSessionStore on named volumes** (#10) — `InMemorySessionStore` replaced with JSONL-backed `FileSessionStore` on per-role Docker volumes; cross-restart session resume is now durable; cross-turn resume is the default (`agentSessions.clear()` removed from `new_conversation`).
- **PAT wiring and SDK env filtering** (#15) — fine-grained GitHub PAT wired through Docker entrypoints; SDK subprocess env uses an allowlist that excludes `GH_TOKEN`; gh credential helper handles clone/push auth transparently.
- **Always-pending long-role dispatch** (#47) — `invoke_agent` for long-role targets always returns `{status: "pending", invocationId}` immediately, collapsing the 0–270 s recovery blind spot from QRM7's `raceAgainstCeiling` approach.

### Bug Fixes

- **gh auth env-ordering in entrypoints** (#27) — `GH_TOKEN` captured and unset before piping to `gh auth login --with-token`; `GIT_CONFIG_GLOBAL` redirected to tmpfs to avoid read-only `~/.gitconfig` write failure.
- **Agent plugin never installed** (#29) — `code-review` plugin seeded to agent tmpfs in entrypoint; 109 prior teamlead invocations had fallen back to manual prose review.
- **Tool-guard rejects namespaced plugin skills** (#31) — namespace prefix stripped before allowlist lookup; plugin path repointed from masked workspace to entrypoint-seeded tmpfs.
- **correlationId shell-injection risk** (#39) — `z.string().uuid()` validation added to correlationId in MCP tool schema and InvokeRequest; 3 `execAsync` calls converted to `execFileAsync` (argv form).
- **Moderator workspace volume ownership** (#42) — `/mnt/quorum/workspace` added to Dockerfile moderator stage `mkdir`/`chown` block for correct first-mount ownership.
- **Worktree missing node_modules** (#45) — `/app/node_modules` symlinked into each worktree after creation; enables `npm run build/lint/test` from worktree cwd.

### Internal / Other Changes

- **Agent memory redirected to context store** (#16) — prompt-only change adding "Agent Memory" section to `SYSTEM_PREAMBLE`; CC memory writes on agent tmpfs accepted as ephemeral; persistent knowledge directed to `context_store(scope='agent')`.
- **MCP server bind mount commented out** (#17) — workspace bind mount on mcp-server service commented with debug note; `MCP_WORKSPACE_DIR` env var dropped; `?? '.'` default handles the missing env under OpenSearch backend.
- **PR-based workflow bootstrap** (#20) — gh CLI installed in all containers; `quorum.md` gains GitHub Workflow section with `#<N>` commit format, branch naming, and PR lifecycle conventions; `@quorum.md` symlink seeded in moderator entrypoint.

### Documentation

- **`quorum.md`** — GitHub Workflow section (branch naming, PR lifecycle, `#<N>` commit format), Moderator role section, code-review PR comment conventions, PR verdict comment requirement.
- **`docker/moderator/CLAUDE.md`** — cross-turn session resume default, mandatory `branch` parameter, `git pull` turn-start discipline, credential-path deny rules, always-pending dispatch + `wait_invocation` rule.
- **`CLAUDE.md`** — updated for QRM8 workspace model (worktrees, named volumes, `REPO_URL`, `GH_TOKEN`).
- **`README.md`** — refreshed for QRM8 workspace model; host bind-mount references removed.

---

## [v0.7.0] (QRM7) — 2026-05-15 — Stabilization

Full milestone notes: [releases/RELEASE-QRM7.md](releases/RELEASE-QRM7.md)

### New Features

- **Long-poll continuation protocol** (QRM7-015 + QRM7-017) — `invoke_agent` now returns `{status: "pending", invocationId}` before CC CLI's 5-min `undici.bodyTimeout` fires; moderator calls `wait_invocation(invocationId)` to continue waiting, with zero overhead on sub-5-min calls.
- **Context-search observability** (QRM7-016) — dedicated `/app/logs/context-search-{startupTimestamp}.jsonl` trace stream captures every `context_query mode=search` invocation in full (query, scope filters, engine choice, hits with scores, snippets, duration); main MCP log carries a `queryId` breadcrumb.
- **Moderator OAuth long-idle hardening** (QRM7-013) — long-lived `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` eliminates `401 authentication_error` after hibernation gaps ≥ ~10 h, preserving QRM7-007's flat-rate subscription billing.
- **GitHub Actions CI pipeline** (QRM7-018) — first CI for the repo: lint + unit tests + build gate every push and pull request to `main`; README badge added.

### Bug Fixes

- **MCP session cleanup never fires on container shutdown** (QRM7-001) — layered fix: `lastSeenAt`-based `isConnected()`, TCP keepalive on SSE socket, periodic reaper, SIGTERM DELETE from agents.
- **Agent retry-once path races MCP `initialize`** (QRM7-008) — `reconnectPromise` memoization across both call sites; `isSessionNotFound()` broadened to catch `Server not initialized`.
- **Reaper churns agent sessions despite stable callback URL** (QRM7-009) — `isSessionAlive()` exempts deployable-agent roles; `register_agent` evicts prior session bound to the same role.
- **Moderator session reaped after SSE GET stream dies** (QRM7-012 + QRM7-014) — Candidate A bumps `SESSION_LIVENESS_TIMEOUT_MS` to 30 min, Candidate E adds immediate SSE ping with tightened cadence, Candidate B′ replaces dead `hasOpenedSse` flag with `activeSseToken` identity-guarded tracking.
- **Moderator cwd misaligned with workspace** (QRM7-004) — Dockerfile `WORKDIR` for moderator changed to `/mnt/quorum/workspace`, fixing project-scope `CLAUDE.md` auto-load, permission-grant persistence, and CC CLI's project-root anchor in one line.

### Internal / Other Changes

- **Schema-first `InvokeRequest` migration** (QRM7-002) — `invokeRequestSchema` moved to `libs/common/`, TypeScript interface now derived via `z.infer`; retires the dual-declaration class behind two QRM6 silent-strip bugs.
- **Moderator log adapter** (QRM7-005) — new `tools/session-report/cc-session-adapter.mjs` reads raw CC CLI session JSONL and emits QuorumLogger-shaped events; `parse-logs.mjs` now ingests moderator activity on equal terms with agents.
- **Moderator subscription auth** (QRM7-007) — moderator dropped from `*shared-env` anchor; authenticates via Claude.ai subscription OAuth (`forceLoginMethod: "claudeai"`) instead of metered `ANTHROPIC_API_KEY`.
- **Three superseded diagnostic cycles** (QRM7-003 → -004, QRM7-010 → -011 → -012) — original framings were falsified by runtime instrumentation; lesson is now baked into `docs/mcp-connectivity.md`.
- **Unit-test gap-fill formally declined** (QRM7-006) — integration-style specs added under QRM7-008/-009/-014/-017 provide sufficient regression signal.

### Documentation

- **`docs/mcp-connectivity.md`** (new, 705 lines) — single source of truth for MCP session lifecycle across both agent (HTTP) and moderator (elicitation) clients; consolidates QRM7-001/-009/-012/-014 design decisions.
- **`CLAUDE.md`** — long-poll continuation rule added (moderator must call `wait_invocation(invocationId)` when any tool response carries `status: "pending"`).
- **`docker/moderator/CLAUDE.md`** — Turn Diagnostic Summary table and Self-Diagnostic via Agent Logs section added for operator UX.
- **`docs/system-design.md`** — two-tier billing split (subscription moderator + API-key agents) documented.
- **README** — research case-study disclaimer added; front matter rewritten for visitor engagement; CI badge.

---

## [v0.6.0-beta] (QRM6) — 2026-05-03 — Containerized Moderator via Claude Code CLI

Full milestone notes: [releases/RELEASE-QRM6.md](releases/RELEASE-QRM6.md)

### New Features

- **Containerized CC CLI moderator** (QRM6-002, QRM6-007) — moderator now runs as a standard Claude Code CLI session in its own Docker container, with identity, prompt, and tool restrictions baked into the image.
- **MCP elicitation back-channel** (QRM6-001, QRM6-003) — agents that need to ask the user a question issue `elicitation/create`, surfacing inline in the moderator's CC CLI session; replaces the custom HTTP-callback clarification handler.
- **Server-side caller identity injection** (QRM6-004) — every tool call is auto-tagged with the caller's role and correlation ID, eliminating boilerplate from every MCP tool implementation.
- **Agent session resume via session tracking cache** (QRM6-004, QRM6-005) — `new_conversation` tool gives the moderator explicit correlation-scope control; `agentSessions` cache enables session resume across invocations within a conversation.

### Bug Fixes

- **Moderator `.claude` mount conflict** (QRM6-BUG-001) — split `*base-security` (common) and `*agent-security` (adds `.claude` tmpfs) compose anchors.
- **Moderator identity leaks to host CC sessions** (QRM6-BUG-002) — moderator role prompt moved from project-root `CLAUDE.md` to `docker/moderator/CLAUDE.md`.
- **MCP server config not loaded** (QRM6-BUG-003) — `mcpServers` block written to `~/.claude.json` with transport type `"http"`.
- **Elicitation blocked by circular-call safeguard** (QRM6-BUG-004) — guard skipped when target is `McpElicitationConnection` (human-in-the-loop, not recursive).
- **SDK `resume` parameter does not resume session** (QRM6-BUG-005) — `InMemorySessionStore` adapter bypasses CC SDK CLI-flag bug; controller Zod schema extended to preserve `sessionId`.
- **Moderator entrypoint dangling symlink** (QRM6-BUG-006) — write directly to symlink target; tmpfs no longer breaks the symlink target on restart.
- **Elicitation timeout too short** (QRM6-BUG-008) — role timeout (5 min) forwarded to `elicitInput()` instead of defaulting to SDK's 60 s.
- **Moderator settings overwrite on restart** (QRM6-BUG-009) — `jq`-based merge for `settings.json`; `claude.json` symlink moved from tmpfs to named volume.
- **Broker timeout causes retry storm** (QRM6-BUG-010) — `Map<correlationId, Promise>` idempotency guard in `InvocationHandler`; architect timeout raised 5 min → 15 min.
- **Server-side SSE heartbeat & TCP keepalive** (QRM6-BUG-011) — `: ping\n\n` every 30 s on POST responses; TCP keepalive on the server socket.
- **Agent image libc mismatch** (QRM6-BUG-012) — builder and runtime stages both moved to Debian bookworm-slim (glibc).
- **Resume re-injects system prompt** (QRM6-BUG-013) — `bootstrapContext.assemble()` and `systemPrompt` skipped when `sessionId` is non-empty (~2,780 tokens saved per invocation).
- **Schema silently strips bootstrap context** (QRM6-BUG-014) — `bootstrapContextSchema` added to agent `/invoke` Zod schema; bidirectional key-level equality guard replaces one-directional type guard.

### Internal / Other Changes

- **Custom NestJS terminal app deleted** (QRM6-009) — 29 files / 3,596 LOC removed (`ChatService`, `ClarificationHandler`, prompt caching, Anthropic SDK orchestration); first net-negative TypeScript milestone in project history.

### Documentation

- **`docs/system-design.md`** — terminal removed from container diagram; moderator service description updated for CC CLI.
- **`docs/agent-messaging.md`** — "User Clarification" section rewritten around MCP elicitation; Mermaid diagrams updated.
- **`docs/claude-code-sdk.md`** — "Terminal Moderator Exception" section removed.
- **`docker/moderator/CLAUDE.md`** (new) — moderator role prompt with turn lifecycle, elicitation handling, tool restrictions, session resume.

---

## [v0.5.0-beta] (QRM5) — 2026-04-19 — Semantic Search Foundation

Full milestone notes: [releases/RELEASE-QRM5.md](releases/RELEASE-QRM5.md)

### New Features

- **Hybrid search context store** (QRM5-002, QRM5-005) — OpenSearch backend with BM25 full-text + k-NN vector similarity; agents now get intent-based context discovery without changes to the MCP tool contract.
- **Local Ollama embedding service** (QRM5-003) — `mxbai-embed-large` runs as a sidecar container with an init container that pre-pulls the model.
- **Async embedding pipeline** (QRM5-006) — records become BM25-searchable immediately while vectors are computed in the background; periodic backfill sweep reconciles records stuck without embeddings.
- **Agent session resume via moderator routing** (QRM5-001) — moderator passes `sessionId` on subsequent invocations, enabling stateful multi-turn agent work.
- **Upgraded `/health` endpoint** — reports per-dependency status (OpenSearch, Ollama) and the active backend.

### Bug Fixes

- **Undici `headersTimeout` kills long-running invocations** (QRM5-BUG-001) — custom undici dispatcher with 35-min timeout for `fetch()` + `Agent` imports.
- **SDK skills disabled; SDK packages stale** (QRM5-BUG-002) — `settingSources: []` removed in `ClaudeCodeService`; both SDK packages upgraded.
- **Silent stall of long-running tool responses over Streamable HTTP** (QRM5-BUG-003) — same 35-min undici dispatcher applied to both terminal and agent `McpClientService`; `server.requestTimeout` raised for defence-in-depth.
- **Embedding pipeline abandons records after short backoff** (QRM5-BUG-004) — periodic backfill sweep (60 s) with concurrency guard and `OnModuleDestroy` cleanup.
- **Agents fail to reconnect after `mcp-server` restart** (QRM5-BUG-005) — intercept "Session not found" on `callTool()` and trigger reconnect + retry; SSE keepalive pings on the server side.
- **`ContextStoreModule.forRoot()` called twice — providers duplicated** (QRM5-BUG-006) — consolidated `forRoot()` to a single call in `McpServerModule` with `global: true`.

### Documentation

- **`docs/knowledge-management.md`** (new) — philosophical framing for the three knowledge domains and the KB concept.
- **`docs/context-store.md`** — major rewrite for OpenSearch backend, hybrid search, embedding pipeline, graceful degradation.
- **`docs/context-management.md`** — search semantics updated (hybrid replaces substring; BM25-only fallback documented).
- **`docs/system-design.md`** — container diagram updated with OpenSearch, Ollama, and `ollama-init`.

---

## [v0.4.0-beta] (QRM4) — 2026-04-11 — Bootstrap Context Injection

Full milestone notes: [releases/RELEASE-QRM4.md](releases/RELEASE-QRM4.md)

### New Features

- **Bootstrap context injection** (QRM4-001, QRM4-002, QRM4-003) — Message Broker queries Context Store for project-scope and conversation-scope decisions and attaches them to every invocation; agents are context-aware from the first token.
- **Agent-side prompt rendering** (QRM4-004) — bootstrap context rendered into the agent's system prompt with deterministic ordering and a greedy bin-packing budget.
- **First milestone implemented by the Quorum agent system itself** — developer, team lead, and architect agents collaborated across 12 orchestrated runs over 15 days.

### Bug Fixes

- **Logger outputs "unknown" role** (QRM4-BUG-001) — `APP_NAME` added to `environment` block in docker-compose.yml.
- **MCP client timeout causes duplicate invocations** (QRM4-BUG-002) — configurable `MCP_REQUEST_TIMEOUT_MS` and custom fetch wrapper with `AbortSignal.timeout()`.
- **`nest` CLI not available in agent containers** (QRM4-BUG-003) — `NODE_ENV=production` removed; PATH augmented; npm cache redirected to tmpfs.
- **Git identity not configured in agents** (QRM4-BUG-004) — `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars added to `x-shared-env`.
- **Moderator activity feed** (QRM4-BUG-005) — `→`/`←` status lines around tool execution in `ChatService.processWithLoop()`.
- **Error reporting hides failure subtype** (QRM4-BUG-006) — `??` replaced with `||` in error handling; `numTurns` added to failure logs.
- **Context store search non-functional for multi-word queries** (QRM4-BUG-014) — `String.includes()` replaced with whitespace-split AND semantics.
- **Moderator cannot discover agent checkpoints** (QRM4-BUG-011) — `InMemoryStore.search()` extended to match against item keys, not just values.
- **Agents do not commit work before returning** (QRM4-BUG-015) — commit message convention added to `quorum.md`; post-invocation `git status --porcelain` warning check.

### Internal / Other Changes

- **Moderator prompt caching and cost tracking** (QRM4-BUG-012, QRM4-BUG-013) — `cache_control: { type: 'ephemeral' }` on system prompt, tool definitions, and last user message; `pricing.ts` + `calculateCostUsd()` for visible per-turn cost display.
- **Incremental context checkpointing guidance** (QRM4-BUG-008) — added to system preamble and developer prompt so long tasks survive mid-run failure.
- **Per-role `maxTurns` deferred** (QRM4-BUG-007) — SDK semantics unclear; calibrated limits risked tighter constraints than SDK's effective default.

### Documentation

- **`docs/agent-messaging.md`** — bootstrap context section added; message lifecycle updated.
- **`tickets/QRM4-000-roadmap.md`** — first roadmap to incorporate dogfooding run logs as primary discovery surface.

---

## [v0.2.0-beta] (QRM2) — 2026-03-20 — Claude Code SDK Migration (Beta)

Full milestone notes: [releases/RELEASE-QRM2.md](releases/RELEASE-QRM2.md)

### New Features

- **Claude Agent SDK integration** (QRM2-002, QRM2-006) — agents run as real Claude Code instances with filesystem, bash, and git access; replaces the manual Anthropic-SDK agentic loop.
- **MCP orchestration tool bridge** (QRM2-003) — agents can invoke other agents and the Context Store through MCP tools.
- **User clarification flow** (QRM2-004) — moderator invocation endpoint surfaces agent clarification requests in the terminal session.
- **Role-based permission profiles** (QRM2-005) — per-role tool whitelists, bash guardrails, and write-path guards enforced at the SDK boundary.
- **Hardened agent Docker image** (QRM2-001) — toolchain (node, npm, git, bash) plus security hardening (read-only root, tmpfs for writes, non-root user, dropped capabilities).
- **Context store file persistence** (QRM2-011) — `FileBackedStore` flushes context to disk on change with debounce; recovers on restart.
- **Enhanced agent log observability** (QRM2-010) — SDK lifecycle events surfaced into the structured logger.

### Bug Fixes

- **Claude Code SDK spawn failure** (QRM2-BUG-001) — SDK `env` option spreads `process.env`; debug dirs created in Dockerfile; tmpfs uid/gid aligned.
- **SDK subprocess silent failure** (QRM2-BUG-002) — symlink to tmpfs for `~/.claude.json`; XDG tmpfs mounts; stderr capture.
- **Container UID mismatch** (QRM2-BUG-003) — `HOST_UID` / `HOST_GID` build args with `scripts/start.sh` auto-detection.
- **Write path guard tool name mismatch** (QRM2-BUG-004) — guard updated to match SDK tool names (`Write`/`Edit`); `bypassPermissions` honors canUseTool callback; allow response includes `updatedInput`.
- **Graceful shutdown broken** (QRM2-BUG-005) — `enableShutdownHooks()` added to MCP server `main.ts`; `shuttingDown` guard flag prevents reconnect during shutdown.
- **Context store project-scope key mismatch** (QRM2-BUG-006) — centralized `CompositeKeyBuilder` utility; scope-aware key construction across all handlers.

### Documentation

- **`docs/claude-code-sdk.md`** (new) — SDK integration, tool bridge, permissions, hardening.
- **`docs/system-design.md`** — agent role updated for CC SDK semantics.

---

## [v0.1.0-alpha] (QRM1) — 2026-02-28 — Alpha (Initial Implementation)

Full milestone notes: [releases/RELEASE-QRM1.md](releases/RELEASE-QRM1.md)

### New Features

- **NestJS monorepo scaffold** (QRM1-001, QRM1-003) — `apps/` for `mcp-server`, `agent`, `terminal`; `libs/common` shared library; per-app config services with Zod validation.
- **MCP server with tools and resources** (QRM1-005) — Streamable HTTP transport, per-session `McpServer` factory, 5 tools and 2 resources.
- **Context Store with InMemoryStore** (QRM1-002) — abstract base + scope-aware composite keys + substring search.
- **Message Broker with safeguards** (QRM1-004) — `AgentRole` enum, `InvokeRequest`/`Response` types, four routing safeguards (depth limit, circular call, target online check, timeout).
- **Agent-to-server connection** (QRM1-007) — `HttpAgentConnection`, MCP client with connect/retry/reconnect, `InvocationHandler` stub, `POST /invoke` endpoint.
- **Agent LLM integration** (QRM1-008) — Anthropic SDK wrapper, agentic tool loop, MCP tool discovery, parameter augmentation.
- **Role prompt system** (QRM1-009) — `SYSTEM_PREAMBLE` + per-role templates (moderator, architect, teamlead, developer); generic fallback for qa/productowner.
- **Terminal moderator bootstrap** (QRM1-010) — stdin/stdout chat loop, terminal `McpClientService`/`AnthropicService`/`ChatService`.
- **Docker containerization** (QRM1-011) — unified root Dockerfile with `APP_NAME` build arg, docker-compose with health checks and service-healthy ordering.
- **Structured logger** (QRM1-006) — `QuorumLogger` with dual-transport (console + JSON).
- **E2E connectivity smoke test** (QRM1-012, QRM1-013) — `GET /registry`, `POST /test/invoke` gated endpoint, 7/7 scenario runbook.

### Bug Fixes

- **MCP server rejects concurrent agent connections** (QRM1-BUG-001) — per-session factory + session registration ordering.
- **Moderator registration silently rejected** (QRM1-BUG-002) — `register_agent` enum scope corrected; terminal `callTool` now checks `isError`.
- **InvocationHandler missing correlation ID in logs** (QRM1-BUG-003) — `correlationId` inlined into all 4 log messages.
- **Console log colors not rendered** (QRM1-BUG-004) — colorizer applied directly to the padded NestJS label string.

### Documentation

- **`docs/system-design.md`** (new) — overall architecture, containers, deployment.
- **`docs/agent-messaging.md`** (new) — bidirectional MCP concepts and communication patterns.
- **`docs/message-broker.md`** (new) — implementation details and safeguards.
- **`docs/context-management.md`** + **`docs/context-store.md`** (new) — Context Store concepts and InMemoryStore reference.
- **`docs/smoke-test-runbook.md`** (new) — 8 scenarios for end-to-end validation.

[v0.8.0-beta]: releases/RELEASE-QRM8.md
[v0.7.0]: releases/RELEASE-QRM7.md
[v0.6.0-beta]: releases/RELEASE-QRM6.md
[v0.5.0-beta]: releases/RELEASE-QRM5.md
[v0.4.0-beta]: releases/RELEASE-QRM4.md
[v0.2.0-beta]: releases/RELEASE-QRM2.md
[v0.1.0-alpha]: releases/RELEASE-QRM1.md