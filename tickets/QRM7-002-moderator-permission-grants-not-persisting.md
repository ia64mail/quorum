# QRM7-002: Moderator Permission Grants Stop Persisting Across Restarts on CC CLI 2.1.126

**Status: Draft**

## Summary

After QRM6-BUG-013 bumped the moderator's `@anthropic-ai/claude-code` pin from 2.1.117 → 2.1.126, the moderator re-prompts for every MCP tool permission on each container restart — regressing the persistence achieved by QRM6-BUG-009 Phase 2. Root cause: the v2.1.119 settings-precedence overhaul moved interactive "always allow" grants from user-scope `~/.claude.json` (which lives on the named volume) to project-local `<cwd>/.claude/settings.local.json`. The moderator's cwd is `/app`, which is read-only at the Docker image layer, so the writes silently fail and grants survive only in process memory.

## Problem Statement

QRM6-BUG-009 Phase 2 made `~/.claude.json` persistent across restarts by moving the symlink target from `/tmp/.claude.json` (tmpfs) to `/home/quorum/.claude/_claude.json` (named volume), so that CC CLI's per-project tool permission grants (`projects[<cwd>].allowedTools`) and onboarding state (`hasCompletedOnboarding`, `oauthAccount`) would survive `docker compose restart moderator`. That fix worked correctly against CC CLI 2.1.117.

After the bump to 2.1.126, the user-visible symptom of QRM6-BUG-009 has returned: every restart re-presents MCP permission prompts for tools that were previously granted as "always allow."

### Diagnosis (run against the live moderator container, CC CLI 2.1.126)

| Probe | Result |
|---|---|
| `claude --version` | `2.1.126` |
| Moderator cwd (Dockerfile `WORKDIR`, `~/.claude/sessions/37.json`) | `/app` |
| `touch /app/test-write` (as user `quorum`) | `Read-only file system` |
| `/app/.claude/` | does not exist |
| `~/.claude.json` → `projects["/app"].allowedTools` | `[]` (empty after multiple sessions of granting) |
| `~/.claude.json` → `projects["/app"].hasTrustDialogAccepted` | `true` (so the trust path is reached) |
| `~/.claude/settings.json` → `permissions.allow` | not present (only baked `deny` + `systemPrompt`) |
| `find / -name 'settings.local.json' -o -name 'permissions.json'` | nothing |

Grants the user issues during the session are not landing on disk anywhere — the `allowedTools` array exists in the schema, but CC CLI 2.1.126 is no longer writing to it.

### Why the bump caused this

Cross-referencing the upstream changelog, v2.1.119 reshaped the settings model:

> `/config` settings now persist to `~/.claude/settings.json` with project/local/policy precedence

CC CLI 2.1.117 wrote interactive "always allow" grants to user-scope `~/.claude.json` → `projects[<cwd>].allowedTools`, which QRM6-BUG-009 Phase 2 captured on the named volume. CC CLI 2.1.119+ writes them to the **project-local** layer — `<cwd>/.claude/settings.local.json`. For the moderator that resolves to `/app/.claude/settings.local.json`, but `/app` is the Docker image overlay (read-only) and `/app/.claude/` does not exist. The write fails silently and the grant persists only in the running process's memory.

QRM6-BUG-009 Phase 2's persistence machinery is structurally correct and unchanged — it still preserves `~/.claude.json` exactly as designed. The CLI just stopped writing the grants there.

## Design Context

The moderator's cwd is intentionally `/app` (Dockerfile `WORKDIR`) — that's where the moderator's own application code lives, and it's the natural "project root" for the CC CLI session that orchestrates Quorum. We don't want to relocate cwd to `/mnt/quorum/workspace` because that's the agents' shared workspace, not the moderator's own project, and switching would orphan the existing `projects["/app"]` history (`hasTrustDialogAccepted`, last-session metrics, transcripts under `~/.claude/projects/-app/`).

Pre-baking a static `permissions.allow` array in `docker/moderator/settings.json` was considered. The downside is that it removes the user's ability to evolve the allow list interactively as new MCP tools are added — every change to the moderator's tool surface would need a Dockerfile rebuild. We want the interactive grant flow to keep working; we just need a writable place to put the result.

The fix therefore is to give CC CLI a writable, persistent `<cwd>/.claude/` directory at `/app/.claude/`, backed by the same kind of named-volume persistence QRM6-BUG-009 Phase 2 set up for `~/.claude/`.

## Implementation Details

### Provide a writable, persistent `/app/.claude/`

Two viable approaches; pick one in implementation:

1. **Sub-path of the existing `moderator-claude-data` volume.** Add a second mount in `docker-compose.yml` for the moderator service that targets `/app/.claude/` with a sub-path of the same volume (e.g. `moderator-claude-data` mounted at `/app/.claude` with a sub-path like `app-claude/`). Keeps everything moderator-state-related in one volume.
2. **Dedicated volume.** Add a new named volume `moderator-app-claude-data` mounted at `/app/.claude/`. Cleaner separation between user-scope (`~/.claude/`) and project-scope (`/app/.claude/`) state at the cost of an extra volume to manage.

Either works. Approach 1 is preferred for backup/lifecycle simplicity unless Docker Compose's sub-path syntax constrains us.

The mount must be writable by uid/gid `${HOST_UID}/${HOST_GID}` (the `quorum` user) so CC CLI can `mkdir`/write inside it. A first-boot `chown` in the entrypoint may be needed if the volume initializes as root-owned.

### Entrypoint: ensure the directory exists with correct ownership

Add an idempotent step at the top of `docker/moderator/entrypoint.sh`:

```bash
mkdir -p /app/.claude
chown quorum:quorum /app/.claude || true
```

(or equivalent — match the ownership model the rest of the entrypoint uses). No baked content is copied in — the directory is purely a writable backing for CC CLI's runtime writes.

### No content baking (today)

`/app/.claude/` is currently empty in the image (verified: no Dockerfile `mkdir`/`COPY` targets it, `ls /app/` in the running container shows only the `logs/` bind-mount). So this change is purely additive — there is no shipped content that gets shadowed by the volume mount.

If a future ticket needs to ship project-scope content (e.g. a baked `/app/.claude/settings.json` carrying pre-approved MCP tool grants), the right pattern is the same `jq -s '.[0] * .[1]'` merge that `entrypoint.sh` already uses for `~/.claude/settings.json` and `~/.claude/_claude.json`: bake to `/etc/claude/app-claude/`, merge baked-overlay over volume-base on boot. That stays out of scope for this ticket.

### Verification: confirm grant-write path in 2.1.126

After the fix, run a single interactive grant in the moderator and confirm `/app/.claude/settings.local.json` exists with the new entry under `permissions.allow`. Restart the container and confirm the file (and the entry) survive. This is the empirical proof that the new persistence path is correct — and the regression test for any future CC CLI version bump.

## Acceptance Criteria

- [ ] `/app/.claude/` exists in the running moderator container, owned by the `quorum` user, and is writable
- [ ] The directory's contents persist across `docker compose restart moderator` (via named volume)
- [ ] An interactive "always allow" grant in CC CLI 2.1.126 produces a `/app/.claude/settings.local.json` entry, and that entry survives a restart
- [ ] After restart, CC CLI does not re-prompt for previously-granted MCP tools
- [ ] First boot (empty volume sub-path) still succeeds — no error if `/app/.claude/` is initially empty
- [ ] No baked content is introduced at `/app/.claude/` — the directory is a pure runtime backing
- [ ] Existing user-scope persistence (QRM6-BUG-009 Phase 2: `~/.claude.json`, `~/.claude/settings.json`) continues to work

## Dependencies and References

### Prerequisites
- None — self-contained Docker/entrypoint change.

### What This Blocks
- Smooth interactive use of the moderator on CC CLI ≥ 2.1.119. Until fixed, every restart costs the user a re-grant pass.

### References
- [QRM6-BUG-009](QRM6-BUG-009-moderator-settings-overwrite-on-restart.md) — original persistence fix; Phase 2 was correct against CC CLI 2.1.117 but the upstream change moved the write target out from under it
- [QRM6-BUG-013](QRM6-BUG-013-redundant-prompt-injection-on-session-resume.md) — commit `3677215`, the version bump that exposed this regression (purely a pin change; no other Dockerfile/entrypoint edits)
- Upstream CC CLI changelog v2.1.119: "`/config` settings now persist to `~/.claude/settings.json` with project/local/policy precedence" — the behavioral change at the root of this regression
- `Dockerfile:88,99,102` — moderator target `WORKDIR /app`, user remap, `npm install -g @anthropic-ai/claude-code@2.1.126`
- `Dockerfile:104-108` — `mkdir`/`chown` for `/home/quorum/.claude` and the symlink to `_claude.json`
- `docker-compose.yml:128-148` — moderator service, `moderator-claude-data:/home/quorum/.claude` mount
- `docker/moderator/entrypoint.sh` — current merge logic for `settings.json` and `_claude.json`; this ticket adds a `/app/.claude/` writable directory ahead of those steps