# QRM6-BUG-009: Moderator Entrypoint Wipes CC CLI State on Every Container Start

**Status: In Progress (re-opened — initial fix was incomplete)**

## Summary

The moderator container's entrypoint unconditionally copies baked CC CLI config into the writable filesystem on every start, wiping CC CLI state from prior sessions. This forces the user through the full onboarding flow and re-prompts for every MCP tool permission after every container restart. The fix: merge baked keys over the existing file instead of replacing it, and persist `~/.claude.json` on the named volume rather than tmpfs.

The fix has two phases:
- **Phase 1 (initial, completed):** Merge `~/.claude/settings.json` instead of overwriting.
- **Phase 2 (this re-open):** Persist `~/.claude.json` on the named volume and apply the same merge pattern. The Phase 1 fix did not address the user-visible symptom because CC CLI stores onboarding state and per-project tool permissions in `~/.claude.json`, not `~/.claude/settings.json`.

## Problem Statement

The moderator uses a named volume (`moderator-claude-data:/home/quorum/.claude`) to persist CC CLI data across restarts. However, `docker/moderator/entrypoint.sh:8` runs:

```bash
cp /etc/claude/settings.json /home/quorum/.claude/settings.json
```

The baked `settings.json` contains only `permissions.deny` and `systemPrompt` — the two areas Quorum needs to control. CC CLI adds its own keys during use (`hasCompletedOnboarding`, `preferredTheme`, `trustedDirectories`, etc.). The unconditional `cp` replaces the entire file, destroying those additions.

**Phase 2 finding:** CC CLI stores its primary state — `hasCompletedOnboarding`, `oauthAccount`, and per-project tool permission grants under `projects[<workspace>].allowedTools` — in `~/.claude.json` (the file at the home directory level), *not* in `~/.claude/settings.json`. In the moderator container, `/home/quorum/.claude.json` is a symlink to `/tmp/.claude.json` (Dockerfile:99), and `/tmp` is tmpfs (`docker-compose.yml:22`). The entrypoint then unconditionally rewrites `/tmp/.claude.json` from the baked `claude.json` (which contains only the `mcpServers` block) on every start. Net effect: every restart wipes onboarding state and the entire per-project permission allow list.

**User-visible symptom:** After `docker compose restart moderator`, running `docker compose exec -it moderator claude` presents the full first-time onboarding flow and re-prompts for every MCP tool permission, even after the Phase 1 fix to `settings.json` was deployed.

**Severity:** Low — the user can complete onboarding again in under a minute, but it's a recurring annoyance that undermines the purpose of the named volume.

## Implementation Details

### settings.json — Merge baked keys over existing

Replace the unconditional `cp` for `settings.json` (entrypoint line 8) with a conditional merge. If `settings.json` already exists in the volume, use `jq` to merge the baked file's keys over it. First boot (no existing file) seeds from the baked copy.

```bash
if [ -f /home/quorum/.claude/settings.json ]; then
  jq -s '.[0] * .[1]' \
    /home/quorum/.claude/settings.json \
    /etc/claude/settings.json \
    > /tmp/merged-settings.json
  mv /tmp/merged-settings.json /home/quorum/.claude/settings.json
else
  cp /etc/claude/settings.json /home/quorum/.claude/settings.json
fi
```

**Merge semantics:** `jq -s '.[0] * .[1]'` performs a recursive object merge. The existing file is `.[0]` (base), the baked file is `.[1]` (wins for shared keys). This gives the correct precedence: Quorum-controlled keys (`permissions`, `systemPrompt`) always update from the baked file, while CC CLI state keys survive because the baked file doesn't define them.

**Permissions allow list behavior:** The baked `settings.json` contains only `permissions.deny` — it has no `allow` key. As the user gradually approves permissions during sessions, CC CLI writes `permissions.allow` entries into the volume's `settings.json`. Because `jq`'s `*` operator does recursive object merge on nested objects, the merge produces `permissions: { allow: [...from volume...], deny: [...from baked...] }` — both keys coexist. The user's accumulated allow list survives restarts without any pre-baked allow configuration.

**Array handling:** `jq`'s `*` operator replaces arrays wholesale rather than appending. The baked `deny` array is authoritative — this is correct behavior.

**Atomicity:** Write to `/tmp/merged-settings.json` then `mv` to the final path. If `jq` fails (malformed JSON), `set -euo pipefail` aborts before `mv`, leaving the existing file untouched.

**jq availability:** `jq` is installed via `apt-get` in the moderator Dockerfile target (bookworm-slim base).

### claude.json — Repoint symlink to volume + merge (Phase 2)

The Dockerfile moderator target (line 99) currently creates the symlink:

```
ln -s /tmp/.claude.json /home/quorum/.claude.json
```

`/tmp` is tmpfs and is wiped on every container start, so any state CC CLI writes to `~/.claude.json` is lost. Repoint the symlink at a path inside the named volume:

```
ln -s /home/quorum/.claude/_claude.json /home/quorum/.claude.json
```

The leading underscore in `_claude.json` is purely cosmetic — it disambiguates the symlink target from anything CC CLI itself might create inside `~/.claude/` (it does not write a file with that name today). The named volume mount at `/home/quorum/.claude` carries the file across restarts.

In the entrypoint, replace the unconditional `cp` + in-place `sed` with: substitute the MCP server URL into a temp copy of the baked file, then merge that over the existing volume file. Same recursive-merge semantics and atomicity pattern as `settings.json`:

```bash
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /etc/claude/claude.json \
  > /tmp/baked-claude.json

if [ -f /home/quorum/.claude/_claude.json ]; then
  jq -s '.[0] * .[1]' \
    /home/quorum/.claude/_claude.json \
    /tmp/baked-claude.json \
    > /tmp/merged-claude.json
  mv /tmp/merged-claude.json /home/quorum/.claude/_claude.json
else
  cp /tmp/baked-claude.json /home/quorum/.claude/_claude.json
fi
```

**Merge semantics:** Existing volume file is `.[0]` (base, holds CC CLI state); baked file is `.[1]` (wins for shared keys). The baked file contains only `mcpServers`, so:
- `mcpServers.quorum` always picks up the current `MCP_SERVER_URL` env var on every start (allows env var override to take effect).
- `hasCompletedOnboarding`, `oauthAccount`, `projects[<workspace>].allowedTools`, and any other CC CLI-managed keys survive.
- If the user manually adds a non-Quorum MCP server entry via `claude mcp add`, it survives because the baked file doesn't define it.

**Symlink-write safety:** `cp`/`mv` write to `/home/quorum/.claude/_claude.json` directly (the symlink target), not through the symlink — so the dangling-symlink-on-first-boot case (analogous to QRM6-BUG-006) is avoided.

**Agent target unchanged:** The agent target's `ln -s /tmp/.claude.json /home/quorum/.claude.json` (Dockerfile:64) stays as-is. Agents are stateless and don't have a named volume — tmpfs is the correct backing store there.

### CLAUDE.md — Unconditional force-copy (no change)

The existing `cp` for `CLAUDE.md` (entrypoint line 9) remains as-is:

```bash
cp /etc/claude/CLAUDE.md /home/quorum/.claude/CLAUDE.md
```

CLAUDE.md is the moderator's role prompt and changes only via commits to the quorum repository. In-container edits are not a supported workflow — the image is the source of truth.

### Baked settings.json — No changes

`docker/moderator/settings.json` remains unchanged:

```json
{
  "permissions": {
    "deny": ["Write", "Edit", "NotebookEdit"]
  },
  "systemPrompt": "..."
}
```

No `allow` key is added. The user builds their allow list incrementally through interactive permission grants during sessions. The merge logic preserves these grants across restarts.

### Edge Cases

1. **Volume-less operation:** If the container runs without the named volume mount, `/home/quorum/.claude/` is tmpfs from the base security anchor. The `if/else` handles this — every start is a first boot, equivalent to current behavior.

2. **Concurrent access:** Not a concern — only the entrypoint writes settings.json, and it runs before the container idles. The user attaches CC CLI later via exec.

## Acceptance Criteria

### Phase 1 (settings.json — completed)
- [x] `settings.json` in the named volume retains CC CLI state (onboarding, theme, trust) across container restarts
- [x] Quorum-controlled keys (`permissions`, `systemPrompt`) update from the baked file on every start
- [x] First boot (empty volume) seeds `settings.json` from the baked file
- [x] `CLAUDE.md` remains unconditional force-copy
- [x] Merge uses `jq -s '.[0] * .[1]'` with write-to-tmp-then-mv atomicity pattern
- [x] `set -euo pipefail` ensures malformed JSON aborts before corrupting the volume
- [x] Baked `settings.json` is not modified (no pre-baked `allow` list)

### Phase 2 (claude.json)
- [x] Moderator Dockerfile target symlinks `/home/quorum/.claude.json` into the named volume, not tmpfs
- [x] Agent Dockerfile target's symlink is unchanged (still tmpfs — agents are stateless)
- [x] Entrypoint applies the same `jq -s '.[0] * .[1]'` merge pattern to `claude.json`
- [x] MCP server URL substitution runs against the baked source before merge, so env var overrides take effect on every start
- [x] CC CLI state (`hasCompletedOnboarding`, `oauthAccount`, `projects[*].allowedTools`) survives container restart
- [x] User does not see the onboarding flow or repeated MCP tool permission prompts after `docker compose restart moderator`
- [x] First boot (empty volume) seeds `_claude.json` from the (URL-substituted) baked file

## Dependencies and References

### Prerequisites
- None — self-contained entrypoint change. `jq` is already available in the moderator image.

### What This Blocks
- Nothing directly — low-severity UX fix.

### References
- `docker/moderator/entrypoint.sh:8-9` — the unconditional `cp` commands to replace
- `docker/moderator/settings.json` — baked source (contains only `permissions.deny` and `systemPrompt`)
- `docker-compose.yml:175` — named volume mount `moderator-claude-data:/home/quorum/.claude`
- `Dockerfile:103-105` — bake step copying files into `/etc/claude/`
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — discovered during the BUG-005 investigation session
- [QRM6-BUG-006](QRM6-BUG-006-moderator-entrypoint-dangling-symlink.md) — related entrypoint fix (dangling symlink for `.claude.json`)

## Implementation Notes

### Phase 1 (settings.json)

**Review status:** Accepted

**Files modified:**
- `docker/moderator/entrypoint.sh` — replaced unconditional `cp` for `settings.json` with conditional `jq -s '.[0] * .[1]'` merge; updated comment block to describe merge semantics

**Deviations from ticket:** None — implementation matches the ticket spec exactly.

**Verification results:**
- `npm run build` — pass
- `npm run lint` — pass (0 errors, 0 warnings)
- `npm run test` — 50 suites, 771 tests, all pass
- Edge cases verified by code inspection: empty file, malformed JSON, first boot, permissions allow/deny coexistence, cross-filesystem `mv` safety

**Post-deployment finding:** User reported the onboarding flow and MCP permission prompts still appearing after every `docker compose restart moderator`. Root cause: the persistence layer fixed by Phase 1 (`~/.claude/settings.json`) is not where CC CLI stores those particular pieces of state — those live in `~/.claude.json`, which is symlinked to tmpfs and recreated from the baked file on every start. Phase 2 addresses this.

### Phase 2 (claude.json)

**Files modified:**
- `Dockerfile` — moderator target symlink target changed from `/tmp/.claude.json` to `/home/quorum/.claude/_claude.json` so the file lives on the named volume
- `docker/moderator/entrypoint.sh` — replaced `cp` + in-place `sed` for `claude.json` with: substitute URL into a temp copy of the baked file, then `jq -s '.[0] * .[1]'` merge over the existing volume file (write-to-tmp-then-mv atomicity)

**Deviations from ticket:** None.
