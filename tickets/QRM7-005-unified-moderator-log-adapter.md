# QRM7-005: Unified Moderator Log Adapter

**Status:** Complete
**Owner:** TBD

## Goal

Bridge the moderator's CC CLI session log into the project's `QuorumLogger` JSONL format so `parse-logs.mjs` can ingest moderator activity on equal terms with agents — one command, one digest, all roles included.

## Problem

After `apps/terminal/` was deleted in QRM6-009, `parse-logs.mjs` has no moderator-side input. The legacy `terminal-*.jsonl` files (produced by the NestJS terminal app's `QuorumLogger`) no longer exist, and the post-QRM6 moderator — Claude Code CLI running in its own container — writes session transcripts in a completely different schema.

CC CLI writes one JSONL file per session under `/home/quorum/.claude/projects/<project-slug>/<sessionId>.jsonl` inside the moderator container, persisted via the `moderator-claude-data` named volume. Each line has a `{type, message, ...}` schema (types include `user`, `assistant`, `summary`, `permission-mode`, `result`) versus the `{timestamp, level, context, message, agentRole}` schema that `parse-logs.mjs` expects.

Today, accessing the raw moderator JSONL requires a `docker run --rm -v moderator-claude-data:/data alpine cat ...` recipe (documented in `SESSION-REPORT.md:79–98`). The adapter step is manual, the output format is incompatible, and `parse-logs.mjs` line 189 in `parseSession()` skips files that don't match the `{role}-{timestamp}.jsonl` naming pattern. The result: session reports are structurally incomplete — they cover agents but not the moderator that orchestrated them.

## Approach

### 1. Docker Compose volume change — nested bind-mount for raw session logs

> **Architect decision (D1):** Keep the `moderator-claude-data` named volume at `/home/quorum/.claude` — it holds the OAuth token from QRM7-007, CC CLI settings, and credentials that should not be disrupted. Add a second bind-mount `./logs/moderator-sessions:/home/quorum/.claude/projects` that shadows the named volume's `projects/` subtree. Docker handles nested mounts correctly — the bind-mount takes precedence for that path. CC CLI writes session JSONLs into the bind-mount; they land on the host at `logs/moderator-sessions/<project-slug>/<sessionId>.jsonl`. Existing session history on the named volume is shadowed (not deleted, just invisible through the mount) — acceptable for tooling. CC CLI recreates the project directory structure on first use. Add `logs/moderator-sessions/` to `.gitignore`. No operator re-authentication, no `docker exec` extraction step in the adapter.

In `docker-compose.yml`, the moderator `volumes:` block changes from:

```yaml
volumes:
  - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
  - ./logs:/app/logs
  - moderator-claude-data:/home/quorum/.claude
```

to:

```yaml
volumes:
  - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
  - ./logs:/app/logs
  - moderator-claude-data:/home/quorum/.claude
  - ./logs/moderator-sessions:/home/quorum/.claude/projects
```

The existing `logs/` entry in `.gitignore` (line 46) already covers `logs/moderator-sessions/` — verify during implementation, no `.gitignore` edit expected.

### 2. Adapter: `tools/session-report/cc-session-adapter.mjs`

A new Node.js script, sibling to `parse-logs.mjs`, that reads raw CC CLI session JSONL files and emits QuorumLogger-shaped output files.

**Input directory:** `logs/moderator-sessions/` (recursively finds `*.jsonl` session files across project-slug subdirectories).

**Output filename pattern:** `logs/moderator-{timestamp}.jsonl` where `{timestamp}` is derived from the session's first entry (formatted as `YYYYMMDDTHHMMSS` to match agent log conventions).

**Output schema:** Each line is `{timestamp, level, context, message, agentRole: 'moderator'}` — identical to `QuorumLogger` output.

**Idempotency strategy:** Track which input files have been processed (e.g. by comparing input file mtime/size against a lightweight manifest, or by checking whether the corresponding output file already exists and covers the same byte range). Safe to re-run as sessions grow or new sessions appear.

**Event-mapping table (six categories):**

> **Architect decision (D3) — corrected mapping against actual CC CLI captures:**

| CC CLI JSONL shape | Adapter output `context` | Notes |
|---|---|---|
| `type: "user"` with string content or text-only content blocks | `UserPrompt` | Top-level `type` + content inspection |
| `type: "user"` with `content[].type === "tool_result"` | `ToolResult` | Must inspect `message.content` array, not just top-level `type` — CC CLI wraps tool results as `user` messages |
| `type: "assistant"` with text blocks | `ModeratorResponse` | Moderator's user-facing narration |
| `type: "assistant"` with `tool_use` blocks | `ToolCall` | Include tool name + input summary in `message` |
| `type: "summary"` | `SessionSummary` | Session summary entries |
| Elicitation entries (if CC CLI logs them distinctly) | `Elicitation` | Agent-to-user clarification round-trips; high value for session reports |

**Additional type handling:**

- `permission-mode` lines -> drop silently (CC CLI internal state, not session-relevant).
- `type: "result"` lines (session metadata) -> investigate during implementation; likely drop or map to `SessionMeta`.
- **Unrecognized top-level types -> `console.warn`** so new CC CLI event types surface rather than silently vanishing.

The developer must inspect at least one real session file from `logs/moderator-sessions/` during implementation to validate and complete the mapping.

### 3. `parse-logs.mjs` integration

> **Architect decision (D2):** `parse-logs.mjs` detects the presence of `logs/moderator-sessions/` and auto-runs `cc-session-adapter.mjs` before parsing. A `--no-adapter` flag skips this for composability. The adapter remains directly invocable as `node tools/session-report/cc-session-adapter.mjs` for standalone use (debugging, incremental analysis). Rationale: one-command UX prevents the operator from forgetting the adapter step; idempotent adapter means auto-invocation has no correctness risk.

Current state of `parse-logs.mjs`:

- Line 34: `ALL_ROLES` already lists `'moderator'`.
- Line 189 in `parseSession()`: skips files with role `mcp-server`, `terminal`, or `unknown` — everything else is parsed as agent activity. Adapter-produced `moderator-{timestamp}.jsonl` files match the `{role}-{timestamp}.jsonl` pattern and are parsed as first-class agent-style logs with no parser changes beyond the auto-invoke pre-step.

Changes needed:

1. Add `--no-adapter` to `parseArgs()` option handling.
2. Before session discovery in `main()`, if `logs/moderator-sessions/` exists and `--no-adapter` is not set, spawn `cc-session-adapter.mjs` synchronously (via `execSync` or `spawnSync`).
3. Adapter-produced `moderator-*.jsonl` files in `logs/` are then picked up by the existing `discoverSessions()` and `parseSession()` logic — no further parser changes required.

### 4. `SESSION-REPORT.md` update

Rewrite the "Moderator Session Log (post-QRM6-002)" section (currently lines 75–98) to:

- Point at the new bind-mount path (`logs/moderator-sessions/`) as the raw log source — no `docker exec` needed.
- Document that `parse-logs.mjs` now auto-invokes the adapter (and `--no-adapter` skips it).
- Drop the `docker run --rm -v ... alpine cat` and `docker run --rm -v ... alpine sh -c` recipes entirely — superseded by the bind-mount.
- Update the input-sources table (lines 68–73) to note that `parse-logs.mjs` now covers the moderator; the "Does not cover the moderator" caveat becomes historical.
- Update the "Tips for Claude Code" bullet (line 169) — the digest now includes moderator `UserPrompt` and `ModeratorResponse` entries directly; manual extraction from a separate file is no longer needed.

## Acceptance Criteria

- [x] `docker-compose.yml` moderator service has the nested bind-mount `./logs/moderator-sessions:/home/quorum/.claude/projects` alongside the existing named volume.
- [x] `logs/moderator-sessions/` is covered by `.gitignore` (the existing `logs/` entry on line 46 should suffice — verify).
- [x] `cc-session-adapter.mjs` reads raw CC CLI session files from `logs/moderator-sessions/` and emits `logs/moderator-{timestamp}.jsonl` in QuorumLogger shape (`{timestamp, level, context, message, agentRole: 'moderator'}`).
- [x] Adapter is idempotent on re-run — running it twice on the same input produces the same output without duplication.
- [x] Event mapping covers all six categories: `UserPrompt`, `ModeratorResponse`, `ToolCall`, `ToolResult`, `SessionSummary`, `Elicitation`.
- [x] Unrecognized top-level CC CLI event types produce a `console.warn` (not silent drop, not hard error).
- [x] `parse-logs.mjs` auto-invokes `cc-session-adapter.mjs` when `logs/moderator-sessions/` exists.
- [x] `parse-logs.mjs --no-adapter` skips the auto-invocation.
- [x] `parse-logs.mjs` digest for a real captured session contains a moderator section with correct `UserPrompt` / `ModeratorResponse` / `ToolCall` / `ToolResult` / `SessionSummary` / `Elicitation` entries (where the session contains those event types).
- [x] `SESSION-REPORT.md` no longer references the `docker run --rm -v ... alpine cat` recipe.
- [x] `SESSION-REPORT.md` documents the bind-mount path and adapter workflow.

## Touches

| File | Action |
|------|--------|
| `docker-compose.yml` | Modified — add nested bind-mount for moderator session logs |
| `tools/session-report/cc-session-adapter.mjs` | Created — CC CLI to QuorumLogger JSONL adapter |
| `tools/session-report/parse-logs.mjs` | Modified — auto-invoke adapter pre-step, `--no-adapter` flag |
| `tools/session-report/SESSION-REPORT.md` | Modified — rewrite moderator log section, drop alpine recipes |
| `.gitignore` | Verify — existing `logs/` entry covers `logs/moderator-sessions/` |
| `tickets/QRM7-005-unified-moderator-log-adapter.md` | Created — this ticket |

## Implementation Notes

**Status:** Accepted — commit `e9234bb`
**Reviewer:** Team Lead
**Build/Lint/Test:** All pass (725 tests, 0 lint errors)

### Files Modified

| File | Change |
|------|--------|
| `docker-compose.yml` | +1 line: nested bind-mount `./logs/moderator-sessions:/home/quorum/.claude/projects` on moderator service |
| `tools/session-report/cc-session-adapter.mjs` | Created (~393 lines): six-category event mapper, recursive session file discovery, QuorumLogger output |
| `tools/session-report/parse-logs.mjs` | +136 lines: `--no-adapter` flag, `runAdapterIfNeeded()` pre-step, `parseModeratorLog()` function, widened `findSessionGroup()` for moderator files |
| `tools/session-report/SESSION-REPORT.md` | Rewrote §Moderator Session Log: dropped alpine recipes, documented bind-mount + adapter workflow, updated input-sources table and Tips |
| `.gitignore` | Refactored: removed broad `logs`/`logs/` patterns, replaced with scoped `/logs/*` + `!/logs/moderator-sessions/` + tracked `.gitkeep` |
| `logs/moderator-sessions/.gitkeep` | Created — ensures directory exists at compose-up time |

### Deviations from Ticket

1. **`.gitignore` refactored** — Ticket predicted no `.gitignore` edit needed (existing `logs/` entry would suffice). Implementation refactored the rules to `/logs/*` with explicit exceptions for `moderator-sessions/` and its `.gitkeep`. This is correct — the old broad patterns couldn't express "ignore contents but track the directory."
2. **Additional dropped types** — Beyond `permission-mode`, the adapter also silently drops `queue-operation`, `ai-title`, `last-prompt`, and `attachment` (discovered during implementation from real CC CLI captures). Consistent with the ticket's "investigate during implementation" guidance.
3. **`type: "result"` mapped to `SessionMeta`** — Ticket said "likely drop or map to SessionMeta"; implementation chose to map, preserving the data for session reports.

### Review Observations (Low Severity)

1. **Mixed-content user messages** — A `user` entry with both `text` and `tool_result` content blocks is classified entirely as `ToolResult`, dropping text blocks. Correct per architect mapping — text blocks in tool-result messages are system-injected reminders, not user input.
2. **Theoretical filename collision** — Two CC CLI sessions starting in the same UTC second would produce identical output filenames. Operationally implausible for single-moderator setup.
3. **Dead defensive check** — `parseModeratorLog` filters `match[1] !== 'calls'` but the regex can never match "calls" due to requiring `({` after the word. Harmless.

## Depends On

None — independent.

## References

- [QRM7-000-roadmap.md § QRM7-005](QRM7-000-roadmap.md) — milestone scope summary
- [QRM6-000-roadmap.md § QRM6-011](QRM6-000-roadmap.md) — original detailed design (carried forward to QRM7-005)
