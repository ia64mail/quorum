# QRM6-BUG-002: Moderator Identity in Project-Root CLAUDE.md Leaks to Host CC Sessions

**Status: Open**

## Summary

QRM6-007 placed the full moderator role prompt (identity, turn lifecycle, clarification flow, skill dispatch, tool restrictions, etc.) at the project root in `CLAUDE.md`. Claude Code auto-loads this file for any CC session started inside the repository — including host-side sessions that are **not** the moderator (IDE sessions, developer inspections, smoke tests). Those host sessions inherit moderator identity and instructions (e.g. call `register_agent`, call `new_conversation`), none of which apply outside the containerized moderator. The moderator-specific content needs to live in a location that the moderator container loads but host CC does not — typically baked into the container image and placed at user-level memory (`~/.claude/CLAUDE.md`) inside the container.

## Problem Statement

QRM6-007 rewrote `CLAUDE.md` at the workspace root as the moderator's system prompt. It works for the moderator container because the container bind-mounts `/mnt/quorum/workspace` from the host repo, so CC inside the container reads the same file. However:

- **Host CC sessions** (the user running `claude` in `~/quorum` for any reason — inspecting the codebase, running smoke tests before the stack is up, using the IDE integration, assisting with a non-moderator task) also read this file.
- Host CC then adopts the moderator identity and is told to call `register_agent(role='moderator')`, `new_conversation`, `invoke_agent`, and other MCP tools that only exist when the Quorum MCP server is running and the session is wired to it.
- On first build of the stack (`./scripts/start.sh`) or when the stack is down, the user's host CC session still behaves as a moderator — asking about elicitation decline/cancel, trying to delegate to agents, refusing to Write/Edit, etc. This is misleading and degrades usability.

**What the user sees:**
The user opens the repo in their IDE, starts a CC session, and the session announces itself as "the Moderator, the orchestration hub of the Quorum multi-agent system". It then proceeds as if MCP tools exist. This is wrong — on the host, CC is not the moderator.

**Root cause:**
QRM6-007 merged two concerns into one file:
1. **Project orientation** (Project Overview, Tech Stack, Project Structure, Documentation, Build Commands, Architecture Concept) — useful for any CC session operating in this repo.
2. **Moderator role prompt** (Moderator Identity, Turn Lifecycle, Clarification Flow, Skill Dispatch, Tool Restrictions, etc.) — meaningful only inside the moderator container.

Both live in the same project-root `CLAUDE.md` because the moderator container reuses the workspace bind-mount for project awareness. But CC's discovery is unconditional — it reads whatever `CLAUDE.md` it finds, regardless of whether the session is the moderator or not.

## Design Context

Claude Code memory discovery is additive: CC walks up from CWD reading `CLAUDE.md` at each level, and additionally reads user-level memory at `~/.claude/CLAUDE.md`. Project-level memory is seen by every CC session that opens the repo; user-level memory is seen only by sessions running under that user/home directory.

Inside the moderator container:
- Container CC starts from `/mnt/quorum/workspace` (bind-mount)
- Container CC reads `/mnt/quorum/workspace/CLAUDE.md` (project level, shared with host)
- Container CC also reads `/home/quorum/.claude/CLAUDE.md` (user level, container-only — host `ia64_corp` user never reads this path)

This gives us a clean split: the moderator identity can live at the user level inside the container, while the project-level file stays focused on project orientation.

## Implementation Details

### Approach

Split `CLAUDE.md` into two files living at two different paths:

| Content | Current location | New location | Visible to |
|---------|------------------|--------------|------------|
| Moderator Identity, Turn Lifecycle, Clarification Flow, Agent Capabilities Awareness, Responsibilities, Collaboration, Skill Dispatch, Context Management, Communication Style, Failure Recovery, Session Resume, Tool Restrictions, Constraints | `CLAUDE.md:5-172` (project root) | `docker/moderator/CLAUDE.md` → baked to `/etc/claude/CLAUDE.md` → entrypoint-copied to `/home/quorum/.claude/CLAUDE.md` | Moderator container only |
| `@quorum.md` import, Project Overview, Tech Stack, Project Structure, Documentation, Build Commands, Architecture Concept | `CLAUDE.md:1-3, 173-end` (project root) | Stay at project-root `CLAUDE.md` | All CC sessions operating in the repo |

### Change 1 — Extract moderator role content

Move lines 5–172 of the current `CLAUDE.md` (the `## Moderator Identity` block through the end of `## Constraints`) into a new file `docker/moderator/CLAUDE.md`. The `@quorum.md` import at the top of the current file stays at the project-root `CLAUDE.md` — project orientation belongs there.

Verify the moderator container will actually load the new file at user level: check CC's behavior when `~/.claude/CLAUDE.md` exists alongside `/mnt/quorum/workspace/CLAUDE.md`. Both should be loaded additively. If CC does not auto-load user-level `CLAUDE.md`, fall back to placing moderator content in `docker/moderator/settings.json`'s `systemPrompt` or using `--append-system-prompt` via a shell wrapper.

If the user-level `CLAUDE.md` in the container also needs `@quorum.md`, add an import statement at the top of `docker/moderator/CLAUDE.md`. The file path `@quorum.md` resolves relative to the file containing the import, so an absolute reference `@/mnt/quorum/workspace/quorum.md` may be needed.

### Change 2 — Strip project-root `CLAUDE.md`

Remove all moderator-specific sections from `CLAUDE.md` at the project root. What remains:

```markdown
# CLAUDE.md

@quorum.md

## Project Overview

[...keep existing content...]

## Tech Stack

[...keep existing content...]

## Project Structure

[...keep existing content...]

## Documentation

[...keep existing content...]

## Build Commands

[...keep existing content...]

## Architecture Concept

[...keep existing content...]
```

This file is safe for host CC — it describes the repo without instructing the reader to act as the moderator.

### Change 3 — Dockerfile: bake the moderator CLAUDE.md

Add a `COPY` line to the moderator build target (after the existing `settings.json` copy at `Dockerfile:102`):

```dockerfile
COPY --chown=quorum:quorum docker/moderator/CLAUDE.md /etc/claude/CLAUDE.md
```

`/etc/claude/` already exists in the image (created at line 96). The baked file is the source; the entrypoint copies it into the writable home directory.

### Change 4 — Entrypoint: seed user-level CLAUDE.md

Update `docker/moderator/entrypoint.sh` to also seed the user-level `CLAUDE.md`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cp /etc/claude/settings.json /home/quorum/.claude/settings.json
cp /etc/claude/CLAUDE.md /home/quorum/.claude/CLAUDE.md

MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /home/quorum/.claude/settings.json

exec tail -f /dev/null
```

### Interaction with QRM6-BUG-001

QRM6-BUG-001 proposes switching the moderator's `.claude` from tmpfs to a named volume. If BUG-001 is fixed first, the entrypoint's `cp` calls will overwrite the named volume's `CLAUDE.md` on every container start — this is intentional so the latest baked prompt always wins, but be aware that user edits inside the volume are not preserved. This matches the current behavior for `settings.json`.

### `.dockerignore` check

`.dockerignore` already excludes `docker/moderator/**` via a `!docker/moderator/**` exception (per QRM6-002). Confirm that `docker/moderator/CLAUDE.md` is picked up by the build context. If necessary, add an explicit include.

### Documentation update

Add a one-paragraph note to `CLAUDE.md` (post-strip) briefly explaining that the moderator's role prompt is not in this file — it's baked into the moderator container image. This helps new contributors understand the two-file split and prevents anyone from "fixing" the host by re-adding moderator content to the project file.

## Acceptance Criteria

- [ ] Project-root `CLAUDE.md` contains **no** moderator identity, turn lifecycle, skill dispatch, or tool-restriction content
- [ ] Project-root `CLAUDE.md` still contains `@quorum.md` import and project orientation (Overview, Tech Stack, Project Structure, Documentation, Build Commands, Architecture Concept)
- [ ] `docker/moderator/CLAUDE.md` exists and contains the moderator role prompt (the content removed from project root)
- [ ] `Dockerfile` moderator target copies `docker/moderator/CLAUDE.md` to `/etc/claude/CLAUDE.md`
- [ ] `docker/moderator/entrypoint.sh` copies `/etc/claude/CLAUDE.md` to `/home/quorum/.claude/CLAUDE.md` on startup
- [ ] Inside the moderator container, `docker compose exec moderator cat /home/quorum/.claude/CLAUDE.md` returns the moderator role content
- [ ] Inside the moderator container, starting `claude` loads the moderator identity (verify by asking the moderator who it is — it should identify as the Moderator)
- [ ] **Host verification:** `claude` started from `~/quorum` on the host does NOT adopt the moderator identity — no mention of `register_agent`, `new_conversation`, or the elicitation flow in its self-description. It describes itself as a general-purpose CC session aware of project conventions only.
- [ ] `npm run build`, `npm run lint`, `npm run test` pass (no regressions)
- [ ] QRM6-008 playbook still passes end-to-end after the split (moderator behaves identically inside the container)

## Dependencies and References

### Prerequisites
- QRM6-BUG-001 — Moderator `.claude` mount conflict (must be fixed first; without it the stack cannot start and we can't verify container-side CLAUDE.md loading)

### What This Blocks
- QRM6-008 — Playbook E2E test should verify host-vs-container CLAUDE.md split as part of the playbook (or the playbook acceptance criteria should be amended to include host cleanliness)

### References
- `CLAUDE.md` (project root) — current file mixing project orientation and moderator role
- `tickets/QRM6-007-moderator-claude-md.md` — the ticket that introduced the mixed content; section 7 ("Project Documentation Preserved") and the "Approach" note in Implementation Notes document the intentional colocation that this bug reverses
- `Dockerfile:76–108` — moderator target build steps
- `docker/moderator/settings.json` — existing baked config pattern (add `CLAUDE.md` alongside)
- `docker/moderator/entrypoint.sh` — existing seed pattern for `settings.json`
- Claude Code memory hierarchy: project-level `CLAUDE.md` walks up from CWD; user-level at `~/.claude/CLAUDE.md` is loaded additively

### Notes on alternative approaches considered

1. **Put moderator content entirely in `settings.json`'s `systemPrompt`.** Rejected: the moderator role prompt is ~145 lines; `systemPrompt` is best kept brief (QRM6-007 intentionally scoped it to four one-liners per architect note #5). A long systemPrompt also loses markdown structure, which matters for skill-dispatch tables and the section hierarchy.
2. **Use `--append-system-prompt` CLI flag via a shell wrapper.** Rejected unless user-level `CLAUDE.md` proves unworkable: requires wrapping the `claude` binary, complicates the exec-attach flow, and duplicates what CC's native memory discovery already provides.
3. **Rename project-root `CLAUDE.md` to something CC doesn't auto-load (e.g. `DOCS.md`).** Rejected: project-root `CLAUDE.md` with project orientation is valuable for host CC sessions (e.g. an engineer exploring the repo gets the tech-stack summary and build commands for free). The fix should preserve that value, not eliminate it.