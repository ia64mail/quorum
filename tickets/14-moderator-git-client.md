# #14: Moderator Becomes Standalone Git Client

## Summary

Remove the moderator's workspace bind mount (`${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) and replace it with a first-boot `git clone` on a dedicated `moderator-workspace` named volume. The moderator becomes a pure git client: it reads the codebase from its own clone and observes agent work via `git fetch`/`git pull`. Includes entrypoint clone logic, prompt updates for D9 (cross-turn resume) and mandatory `branch` parameter (D1), and tool-guard deny rule hardening for credential paths.

## Problem Statement

The moderator container currently depends on a host workspace bind mount at `docker-compose.yml:173`:

```yaml
- ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
```

This creates three problems:

1. **Host filesystem coupling.** The moderator reads and writes the host's working tree directly. Changes made by agents (on the same bind mount) are visible instantly, but this is an implicit dependency — it only works because all containers share the same host directory. Remote deployment without NFS/sshfs is impossible.

2. **No git discipline.** Because the moderator sees host files directly, there is no requirement that changes flow through git. Stale reads, uncommitted host changes, and diverged state between the moderator's view and the remote are all possible failure modes that go undetected.

3. **Blocks QRM8 D4 goal.** Design Decision D4 targets zero active workspace bind mounts on agents and moderator. The agent-side bind mount is addressed by #11; this ticket addresses the moderator side.

The moderator already has `gh` CLI installed (Dockerfile moderator stage, lines 108-121), `GH_TOKEN` in its environment (docker-compose.yml:171, wired by #15/#20), and `gh auth login` + `gh auth setup-git` in `entrypoint.sh` (lines 39-59, added by #15/#27). The git credential infrastructure is ready — this ticket adds the clone logic and removes the bind mount.

## Implementation Details

### 1. Add first-boot `git clone` logic to `docker/moderator/entrypoint.sh`

**Location:** After the gh auth block (line 59) and before the `~/.claude.json` merge block (line 69). The clone must happen after gh auth so the credential helper is available for HTTPS authentication.

**Logic:**

```bash
# Clone the workspace repo on first boot. The moderator's WORKDIR
# (/mnt/quorum/workspace, set by QRM7-004 at Dockerfile:100) points
# to the moderator-workspace named volume. If the directory is empty
# or not a git repo, clone into it. Skip if .git already exists
# (idempotent across container restarts).
REPO_URL="${REPO_URL:?REPO_URL must be set for moderator git clone}"
if [ ! -d /mnt/quorum/workspace/.git ]; then
  echo "First boot: cloning $REPO_URL into /mnt/quorum/workspace ..."
  git clone "$REPO_URL" /mnt/quorum/workspace
  echo "Clone complete"
else
  echo "Workspace already initialized (git repo found), skipping clone"
fi
```

**Key design choices:**

- **`REPO_URL` as a required env var** — not hardcoded, because the moderator image is project-agnostic. The env var must be added to `docker-compose.yml` moderator environment and `.env.example`. Using `${REPO_URL:?...}` causes a hard fail if missing, which is correct — without a repo URL, the moderator has no workspace.
- **Idempotency via `.git` directory check** — on container restart the named volume already has the clone, so the entrypoint skips straight to the auth/config merge blocks. This is the same pattern the agent entrypoint (#11) will use.
- **Placement after gh auth** — the `gh auth setup-git` call at line 55 configures the credential helper. The clone needs this helper for HTTPS auth. Placing the clone before auth would fail on private repos.
- **Clone target is WORKDIR** — `/mnt/quorum/workspace` is the Dockerfile's `WORKDIR` (line 100), set by QRM7-004. The clone writes directly to this path, which is backed by the `moderator-workspace` named volume. CC CLI auto-loads `CLAUDE.md` from cwd, and the `quorum.md` symlink at `entrypoint.sh:33` resolves because the clone provides the file.

**Interaction with existing entrypoint blocks:**

- The `quorum.md` symlink (line 30-33): On first boot, this block runs *before* the clone, so `/mnt/quorum/workspace/quorum.md` doesn't exist yet and the WARN fires. **The clone block must be placed before the quorum.md symlink block**, or the symlink block must be reordered after the clone. The developer should reorder the entrypoint so the clone happens early (after gh auth), then the quorum.md symlink block runs when the file is guaranteed to exist.
- The settings/CLAUDE.md merge blocks (lines 14-23): These write to `/home/quorum/.claude/`, which is on the `moderator-claude-data` volume — unaffected by the workspace clone.
- The `claude mcp list` self-verify (lines 106-113): Unaffected — it reads from `~/.claude.json`, not the workspace.

### 2. Remove workspace bind mount from `docker-compose.yml` moderator service

**Current state (docker-compose.yml:172-176):**

```yaml
    volumes:
      - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
      - ./logs:/app/logs
      - moderator-claude-data:/home/quorum/.claude
      - ./logs/moderator-sessions:/home/quorum/.claude/projects
```

**Target state:**

```yaml
    volumes:
      - moderator-workspace:/mnt/quorum/workspace
      - ./logs:/app/logs
      - moderator-claude-data:/home/quorum/.claude
      - ./logs/moderator-sessions:/home/quorum/.claude/projects
```

Changes:
- Line 173: Replace `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` with `moderator-workspace:/mnt/quorum/workspace`
- Add `moderator-workspace:` to the top-level `volumes:` section (line 255+)

### 3. Named volume choice: dedicated `moderator-workspace` (not reusing `moderator-claude-data`)

**Decision: Introduce a new `moderator-workspace` named volume.**

**Rationale:**
- `moderator-claude-data` is mounted at `/home/quorum/.claude` — it holds CC CLI state (settings, sessions, memory, plugin cache). Mixing a full git repo clone into this volume would either require mounting it at a second path or restructuring the `.claude` directory layout. Both add complexity and risk breaking the existing CC CLI state management.
- A dedicated volume provides clean separation of concerns: `moderator-claude-data` = CC CLI state, `moderator-workspace` = git repo clone. Each can be independently inspected, backed up, or deleted without affecting the other.
- The volume is lightweight — it holds one git clone. The overhead is negligible.

### 4. Add `REPO_URL` to moderator environment and `.env.example`

**docker-compose.yml moderator environment (after line 171):**

```yaml
      REPO_URL: ${REPO_URL}
```

**.env.example (after the GH_TOKEN entry, around line 50):**

```bash
# Repository URL for moderator/agent git clone (QRM8).
# Must be an HTTPS URL — SSH auth is not wired. The gh credential
# helper authenticates via GH_TOKEN.
REPO_URL=https://github.com/ia64mail/quorum.git
```

### 5. Update moderator prompt in `docker/moderator/CLAUDE.md`

Add two sections to the moderator prompt documenting the new operational realities:

**a. Cross-turn resume note (D9):**

After the "Session Resume" section, add or update text clarifying the new default:

> Cross-turn session resume now works by default — cached sessionIds persist across `new_conversation` boundaries. You do NOT need to track or pass `sessionId` manually for same-role continuity. Pass `sessionId: ""` only when genuinely switching topics or when you want a completely fresh agent session.

**b. Mandatory `branch` parameter note (D1):**

Update the "Agent Capabilities Awareness" or "Responsibilities" section to document:

> Every `invoke_agent` call must include a `branch` parameter specifying the target git branch. There is no default — requests without `branch` are rejected by zod validation. For read-only or review invocations, use the feature branch in scope (or `main` for general codebase exploration).

**c. Turn-start pull (D10 — already implemented by #10):**

D10's mechanical `reminder` field in the `new_conversation` response is already implemented (see #10 Implementation Notes). The prompt should document the practice but NOT re-implement it:

> After calling `new_conversation`, run `git fetch origin && git pull --ff-only` before reading any workspace files — agent commits since your last turn may not be in your local clone. The `new_conversation` response includes a `reminder` field reinforcing this.

**d. Replace "Pre-Isolation Note":**

The "Pre-Isolation Note" section currently says the moderator uses a bind mount. After this ticket, that note is obsolete. Replace it with a note describing the new model:

> The moderator operates on its own git clone at `/mnt/quorum/workspace` (backed by the `moderator-workspace` named volume). Changes from agents arrive via `git fetch`/`git pull` — they are NOT automatically visible. Always pull at the start of each turn.

### 6. Tool-guard deny rules in `docker/moderator/settings.json`

**Current state (settings.json:4-14):** Already includes deny rules for credential paths:

```json
"deny": [
  "Write",
  "Edit",
  "NotebookEdit",
  "Read(/home/quorum/.config/gh/**)",
  "Bash(cat /home/quorum/.config/gh/*)",
  "Bash(cat ~/.config/gh/*)",
  "Bash(head /home/quorum/.config/gh/*)",
  "Bash(head ~/.config/gh/*)",
  "Bash(less /home/quorum/.config/gh/*)",
  "Bash(less ~/.config/gh/*)"
]
```

These were added by #15/#27. **Verify they are sufficient** — the deny rules cover `Read()`, `cat`, `head`, and `less` patterns for `~/.config/gh/` paths. Additional vectors to consider:

- `Bash(tail ~/.config/gh/*)` — not currently denied. **Add it.**
- `Bash(grep ~/.config/gh/*)` and `Bash(rg ~/.config/gh/*)` — not denied but low risk (CC CLI blocks by default). **Add for defense-in-depth.**
- `Bash(cp ~/.config/gh/*)` — could exfiltrate to a readable location. **Add.**
- Same patterns for `/home/quorum/.config/gh/*` paths.

The developer should evaluate which additional patterns are worth adding vs. which are already blocked by CC CLI's permission system, and add a reasonable set for defense-in-depth without creating an unmaintainably long deny list.

### 7. Confirm GH_TOKEN env wiring

**Already present at docker-compose.yml:171:**

```yaml
GH_TOKEN: ${GH_TOKEN}
```

This was wired by #15/#20. The moderator entrypoint already reads `GH_TOKEN`, authenticates `gh`, and unsets the env var before starting CC CLI (entrypoint.sh:39-59). **No changes needed** — document confirmation in the ticket.

### Scope guards

- **Moderator container rebuild required.** This ticket modifies the entrypoint, prompt, settings, and docker-compose moderator volumes. After merge, the moderator container **must** be rebuilt (`docker compose build moderator`) and restarted. The moderator container running this conversation will not see the changes until rebuild.
- **Do NOT remove the agent-side bind mount.** That is #11's scope. The agent services in docker-compose.yml (architect, teamlead, developer) keep their `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` bind mounts until #11 lands.
- **Do NOT change anything about the MCP server.** The MCP server bind mount was already handled by #17.
- **First-boot clone must be idempotent.** The `.git` directory check ensures repeated container starts on an initialized volume skip the clone. This is critical because the entrypoint runs on every `docker compose up`, not just the first time.
- **Clone target aligns with QRM7-004.** `WORKDIR /mnt/quorum/workspace` (Dockerfile:100) remains the moderator's working directory. The named volume is mounted at this exact path. CC CLI's auto-CLAUDE.md-loading continues to work.
- **Do NOT touch the `moderator-claude-data` volume mount.** It stays at `/home/quorum/.claude` for CC CLI state. The workspace clone lives on the separate `moderator-workspace` volume.

## Acceptance Criteria

- [ ] `docker/moderator/entrypoint.sh` contains first-boot `git clone` logic that clones `$REPO_URL` into `/mnt/quorum/workspace` when the directory has no `.git` subdirectory
- [ ] Clone is idempotent — container restart on an already-initialized volume skips the clone (verified by `.git` existence check)
- [ ] `docker-compose.yml` moderator service: workspace bind mount (`${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw`) replaced with `moderator-workspace:/mnt/quorum/workspace` named volume
- [ ] `moderator-workspace` added to top-level `volumes:` section in `docker-compose.yml`
- [ ] `REPO_URL` added to moderator environment in `docker-compose.yml` and documented in `.env.example`
- [ ] `docker/moderator/CLAUDE.md` updated: D9 cross-turn resume note, mandatory `branch` parameter note (D1), turn-start pull practice documented (referencing D10's existing mechanical reminder), Pre-Isolation Note replaced with current model description
- [ ] `docker/moderator/settings.json` deny rules reviewed and hardened — at minimum `tail` added alongside existing `cat`/`head`/`less` patterns for `~/.config/gh/` credential paths
- [ ] GH_TOKEN env wiring confirmed present at `docker-compose.yml:171` (no changes needed — from #15/#20)
- [ ] Entrypoint clone block is placed after gh auth block (so credential helper is available for HTTPS clone)
- [ ] Entrypoint quorum.md symlink block runs after the clone (so the symlink target exists on first boot)
- [ ] `npm run build` passes, `npm run lint` passes (0 errors, 0 warnings), `npm run test` passes — no regressions
- [ ] Ticket documents that moderator container rebuild+restart is required after merge

## Dependencies and References

**Depends on:**
- #15 — PAT wiring and gh CLI auth (already merged). Provides `GH_TOKEN` env, `gh auth login`, `gh auth setup-git` in entrypoint, credential helper configuration.

**Interacts with:**
- QRM7-004 — `WORKDIR /mnt/quorum/workspace` alignment. This ticket preserves the WORKDIR; the path now points to the named volume clone instead of the bind mount.
- #10 — D10 (`new_conversation` reminder field) is already implemented by #10. This ticket's prompt updates reference but do not re-implement it.
- #11 — Agent-side bind mount removal. **Not in this ticket's scope.** Agent services retain their bind mounts until #11.
- #17 — MCP server bind mount removal. **Already complete.** No interaction.
- #27 — gh auth env ordering fix. Already merged; entrypoint.sh:39-59 reflects the corrected flow.

**Design decisions implemented:**
- D4 (moderator side) — No host bind mount; moderator operates on its own git clone
- D5 (moderator side) — gh auth bootstrap with GH_TOKEN unset before CC CLI (already in entrypoint from #15/#27; confirmed)

**Prompt-only changes referencing:**
- D1 — Mandatory `branch` parameter in `invoke_agent` calls (documented in prompt)
- D9 — Cross-turn session resume as default (documented in prompt; mechanical change in #10)
- D10 — Turn-start pull reminder (documented in prompt; mechanical change in #10)

**References:**
- [#8: QRM8 Roadmap](8-workspace-isolation.md) — Design decisions D4, D5, D9, D10; §14 milestone scope; dependency graph
- [#15: PAT Wiring](15-pat-wiring.md) — Foundation for git auth
- [#10: FileSessionStore](10-file-session-store.md) — D9/D10 mechanical implementation
- [#17: MCP Server Bind Mount](17-mcp-server-bind-mount.md) — Companion bind mount removal (already done)
- [#27: gh auth env ordering](27-gh-auth-env-ordering.md) — Entrypoint fix this ticket builds on
