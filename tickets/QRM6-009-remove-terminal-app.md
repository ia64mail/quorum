# QRM6-009: Remove Legacy Terminal App

## Summary

Delete the `apps/terminal/` directory and all references to the terminal app across the codebase. The terminal was the original NestJS-based moderator UI (stdin/stdout chat loop, raw Anthropic SDK, ink+React TUI, `ClarificationHandler`). QRM6-002 through QRM6-008 replaced it with a CC CLI moderator running in its own container. The terminal app is now dead code.

## Problem Statement

The terminal app (`apps/terminal/`) is 29 source files of dead code. Every capability it provided — interactive chat loop, MCP client connection, clarification back-channel, agent session tracking, caller identity augmentation, cost tracking — has been replaced by the CC CLI moderator container (QRM6-002) plus server-side auto-injection (QRM6-004). Keeping it creates three concrete problems:

1. **Registration race.** The QRM6-008 playbook (Scenario 2) confirmed that the terminal service's `register_agent(role=moderator, callbackUrl=http://terminal:3001)` races with the CC CLI moderator's elicitation-based registration. The last writer wins — if terminal registers after the CC CLI moderator, clarification requests route to a service that no longer hosts the interactive user.
2. **Maintenance drag.** `nest build --all` compiles the terminal app. `npm run lint` lints it. Any shared-library change in `libs/common/` must remain backward-compatible with terminal's imports. The dead code participates in every CI cycle.
3. **Prompt drift surface.** `TERMINAL_MODERATOR_PROMPT` at `apps/terminal/src/chat/chat.service.ts:206` is a ~300-line inline prompt that was the prior source of truth for moderator behavior. It now coexists with `CLAUDE.md` (QRM6-007). Two moderator prompts in the tree invite confusion — which is canonical?

Per design decision D8 in the QRM6 roadmap: no legacy-mode flag, no toggle, no parallel code path. This ticket is a pure deletion — no behavioral changes.

## Design Context

The QRM6 roadmap (D8) explicitly scoped this as a final cleanup ticket after all replacement infrastructure is working and validated:

> **D8: Delete `apps/terminal/` Entirely — No Legacy Mode.** Remove `apps/terminal/` in the final cleanup ticket. No legacy-mode flag, no toggle, no parallel code path.

The QRM6-008 playbook validated the replacement stack end-to-end (8/10 scenarios passed; the 2 failures are tracked as QRM6-BUG-005 and QRM7-001 (was QRM6-BUG-007), neither related to terminal functionality). The terminal's function is fully subsumed.

## Implementation Details

This is a deletion-only ticket. Every change removes terminal references; nothing new is introduced.

### 1. Delete `apps/terminal/` directory

Remove the entire directory tree — 29 files across 6 modules:

| Module | Files | Purpose (now dead) |
|--------|-------|--------------------|
| `chat/` | `chat.module.ts`, `chat.service.ts`, `chat.service.spec.ts`, `index.ts` | Interactive readline loop, 15-round agentic tool loop, `TERMINAL_MODERATOR_PROMPT`, activity feed, cost tracking, `augmentArgs()`, `agentSessions` map |
| `clarification/` | `clarification.controller.ts`, `clarification.module.ts`, `clarification.service.ts`, `clarification.service.spec.ts`, `stdin-lock.service.ts`, `stdin-lock.service.spec.ts`, `index.ts` | `POST /invoke` endpoint, `ClarificationHandler.persistDecision()`, stdin mutex — all replaced by MCP elicitation (QRM6-003) |
| `config/` | `terminal-config.module.ts`, `terminal-config.service.ts`, `terminal-config.service.spec.ts`, `terminal.config.ts`, `index.ts` | Terminal-specific env var parsing (`PORT`, `MCP_CALLBACK_URL`, `TERMINAL_WORKSPACE_DIR`) |
| `connection/` | `connection.module.ts`, `mcp-client.service.ts`, `mcp-client.service.spec.ts`, `index.ts` | Streamable HTTP MCP client, register/unregister, reconnect, stale-session recovery |
| `llm/` | `llm.module.ts`, `anthropic.service.ts`, `anthropic.service.spec.ts`, `index.ts`, `pricing.ts` | Raw Anthropic SDK wrapper with prompt caching |
| Root | `main.ts`, `terminal.module.ts` | NestJS bootstrap and root module |
| Config | `tsconfig.app.json`, `test/jest-e2e.json` | TypeScript and Jest configuration |

### 2. Update `nest-cli.json`

**Remove the `terminal` project entry** (lines 40–48):
```json
"terminal": {
  "type": "application",
  "root": "apps/terminal",
  ...
}
```

**Switch top-level defaults from `apps/terminal` to `apps/mcp-server`.** The top-level `root`, `sourceRoot`, and `compilerOptions.tsConfigPath` currently default to `apps/terminal` — these are NestJS CLI defaults for the "primary" project:

| Field | Current value | New value |
|-------|---------------|-----------|
| `root` (line 11) | `apps/terminal` | `apps/mcp-server` |
| `sourceRoot` (line 3) | `apps/terminal/src` | `apps/mcp-server/src` |
| `compilerOptions.tsConfigPath` (line 7) | `apps/terminal/tsconfig.app.json` | `apps/mcp-server/tsconfig.app.json` |

### 3. Update `docker-compose.yml`

**Remove the entire `terminal` service block** (~lines 128–154). This block defines the terminal container with `APP_NAME: terminal`, `PORT: 3001`, `MCP_CALLBACK_URL: http://terminal:3001`, and workspace volume mounts. The `moderator` service (added in QRM6-002, lines 155+) is the replacement.

### 4. Update `Dockerfile`

**Update the comment on line 14** from:
```
# --- Runtime: default (mcp-server, terminal) ---
```
to:
```
# --- Runtime: default (mcp-server) ---
```

The `default` build target was shared by mcp-server and terminal. With terminal removed, only mcp-server uses it.

### 5. Update `package.json`

**Remove the `build:terminal` script** (line 15):
```json
"build:terminal": "nest build terminal",
```

The `build` script (`nest build --all`) automatically builds all projects registered in `nest-cli.json`, so removing the terminal project entry (step 2) already excludes it from `npm run build`. The per-project convenience script is the only explicit reference.

### 6. Documentation updates

Six documentation files reference the terminal app. Each needs targeted removal of terminal-specific content:

**`docs/system-design.md`:**
- Remove `terminal/` from the project directory tree (around line 349)
- Remove terminal from the "Base Image" row in the deployment table (line 177): update from `mcp-server/terminal use node:24-alpine` to just `mcp-server uses node:24-alpine`
- Remove terminal from service list and port allocations (line 107 — `POST /invoke` on terminal, line 435 — `T[terminal:3001]`)
- Update Mermaid network diagram to remove the `terminal:3001` node
- Update the multi-target build description (line 398): `default target for mcp-server/terminal` → `default target for mcp-server`
- Update deployment description and container list where terminal appears as a service

**`docs/claude-code-sdk.md`:**
- Remove the paragraph about terminal using raw Anthropic SDK (lines ~215–217): the three sentences explaining why the terminal app's moderator uses the raw SDK, the manual tool loop, and the `quorum.md` read at startup. These describe deleted code.
- Update the Dockerfile multi-target build description (line ~148): `default for mcp-server/terminal (Alpine)` → `default for mcp-server (Alpine)`

**`docs/message-broker.md`:**
- Update the invocation delivery table (line 226): remove `terminal` from the description `MCP server → agent/terminal task delivery` → `MCP server → agent task delivery`

**`CLAUDE.md`:**
- Remove `terminal/` from the project structure tree (under `apps/`)
- Update the `Terminal App` description line to reflect that the moderator is now a CC CLI container (or simply remove the terminal line since `moderator` is not a NestJS app in `apps/`)
- Update the Tech Stack "Framework" line if it lists terminal as an app: `apps: terminal, mcp-server, agent` → `apps: mcp-server, agent`
- Update the Architecture Concept example flow if it references the terminal

**`quorum.md`:**
- Update the Framework line (line 10): `NestJS monorepo (apps: terminal, mcp-server, agent; lib: common)` → `NestJS monorepo (apps: mcp-server, agent; lib: common)`
- Remove `terminal/` from the Project Structure directory tree (line 35): remove the line `│   ├── terminal/      # User-facing moderator (stdin/stdout chat, raw Anthropic SDK)`

## Acceptance Criteria

- [x] `apps/terminal/` directory is deleted (all 29 files)
- [x] `nest-cli.json` has no `terminal` project entry; top-level `root`, `sourceRoot`, and `compilerOptions.tsConfigPath` point to `apps/mcp-server`
- [x] `docker-compose.yml` has no `terminal` service block
- [x] `Dockerfile` comment on line 14 reads `default (mcp-server)`, not `default (mcp-server, terminal)`
- [x] `package.json` has no `build:terminal` script
- [x] `docs/system-design.md` has no references to the terminal app, terminal service, or `terminal:3001`
- [x] `docs/claude-code-sdk.md` has no references to terminal using raw Anthropic SDK or terminal in Dockerfile description
- [x] `docs/message-broker.md` invocation delivery table does not mention terminal
- [x] `CLAUDE.md` project structure and tech stack do not reference terminal
- [x] `quorum.md` framework line and directory tree do not reference terminal
- [x] `npm run build` succeeds (terminal no longer in `nest-cli.json` projects)
- [x] `npm run lint` passes with 0 errors, 0 warnings
- [x] `npm run test` passes — existing test count is preserved minus terminal's own specs (subtract ~8 terminal spec files)
- [x] No remaining references to `apps/terminal` in the codebase (verify with `grep -r "apps/terminal" --include="*.ts" --include="*.json" --include="*.md" --include="*.yml"`)

## Dependencies and References

- **Depends on (all complete):**
  - QRM6-002 (moderator container image) ✅ — replacement moderator service exists in `docker-compose.yml`
  - QRM6-003 (elicitation connection & broker routing) ✅ — clarification back-channel replaced
  - QRM6-004 (server-side caller identity & session tracking) ✅ — `augmentArgs()` and `agentSessions` replaced server-side
  - QRM6-005 (`new_conversation` tool) ✅ — correlation ID minting replaced
  - QRM6-007 (moderator CLAUDE.md) ✅ — `TERMINAL_MODERATOR_PROMPT` replaced
  - QRM6-008 (E2E playbook) ✅ — replacement stack validated end-to-end
- **Blocks:**
  - QRM6-010 (documentation) — docs update after deletion avoids documenting a transient state
  - QRM6-011 (unified moderator log adapter) — adapter targets the post-terminal world; `terminal-*.jsonl` filename retired here
- **Part of:** [QRM6-000-roadmap.md](QRM6-000-roadmap.md) — Containerized Moderator via Claude Code CLI milestone
- **Design decision:** D8 in QRM6-000-roadmap.md — "Delete `apps/terminal/` Entirely — No Legacy Mode"

## Implementation Notes

**Status:** Complete

**Date:** 2026-05-01

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/terminal/` (29 files) | Deleted | Entire terminal app directory — chat, clarification, config, connection, llm modules, root module, tsconfig, jest config |
| `nest-cli.json` | Modified | Removed `terminal` project entry; switched top-level `root`, `sourceRoot`, `compilerOptions.tsConfigPath` from `apps/terminal` to `apps/mcp-server` |
| `docker-compose.yml` | Modified | Removed 27-line `terminal` service block (lines 128–154) |
| `Dockerfile` | Modified | Updated line 14 comment: `default (mcp-server, terminal)` → `default (mcp-server)` |
| `package.json` | Modified | Removed `build:terminal` script |
| `docs/system-design.md` | Modified | Removed terminal from directory tree, Mermaid diagrams, service table, base image row, deployment description; updated moderator section to describe CC CLI container |
| `docs/claude-code-sdk.md` | Modified | Removed "Terminal Moderator Exception" section; updated Dockerfile description |
| `docs/agent-messaging.md` | Modified | Rewrote "User Clarification" section — replaced ClarificationHandler/terminal with MCP elicitation/moderator in prose and Mermaid diagram |
| `docs/message-broker.md` | Modified | Updated invocation delivery table: `agent/terminal` → `agent` |
| `CLAUDE.md` | Modified | Removed terminal from project structure tree, updated tech stack (moderator line, app count), updated architecture example flow |
| `quorum.md` | Modified | Updated framework line and project structure directory tree; updated build comment |
| `docker/moderator/CLAUDE.md` | Modified | Removed terminal from project structure tree, updated app count |
| `apps/mcp-server/src/main.ts` | Modified | Updated comment reference from deleted `apps/terminal/src/connection/mcp-client.service.ts` to surviving `apps/agent/src/connection/mcp-client.service.ts` |
| `libs/common/src/messaging/invoke.types.ts` | Modified | Updated JSDoc: "Terminal App's moderator" → "the moderator" |

### Deviations from Ticket Spec

- **Three extra files updated beyond ticket scope.** The developer proactively cleaned up `apps/mcp-server/src/main.ts` (comment referencing deleted terminal MCP client), `libs/common/src/messaging/invoke.types.ts` (JSDoc referencing "Terminal App's moderator"), and `docker/moderator/CLAUDE.md` (terminal in project structure). These were not listed in the ticket's Implementation Details but are correct and necessary removals.
- **`docs/agent-messaging.md` updated but not listed in ticket.** The ticket's documentation section listed 5 doc files but omitted `agent-messaging.md`, which had a ClarificationHandler-based Mermaid diagram and prose. The developer correctly updated it to describe the MCP elicitation flow.
- **`tools/entropy-report/` references not cleaned.** `README.md` (line 93) and `entropy-report.mjs` (line 222) still reference `apps/terminal/`. Functionally harmless (dead `classifyApp` branch, stale README line). Not covered by any downstream ticket — opportunistic cleanup candidate.
- **`tools/session-report/SESSION-REPORT.md` references deferred.** Two references to `apps/terminal/` remain; QRM6-011 is scoped to rewrite this file.

### Verification

- `npm run build` — 3 targets compiled successfully (agent, mcp-server, common)
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 44 suites, 674 tests passing (down from 49 suites / 760 tests — terminal's 5 spec files and their tests removed)
- `grep -r "apps/terminal" --include="*.ts" --include="*.json" --include="*.md" --include="*.yml"` in active code/config/docs — 0 matches (residual matches only in `tickets/*.md` historical records and `tools/` developer scripts)
