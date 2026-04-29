# QRM6-BUG-009: Moderator Entrypoint Force-Overwrites `settings.json` on Every Container Start

**Status: Done**

## Summary

The moderator container's entrypoint unconditionally copies the baked `settings.json` into the named volume on every start, wiping CC CLI state from prior sessions. This forces the user through the full onboarding flow after every container restart. The fix: merge baked keys over the existing file instead of replacing it.

## Problem Statement

The moderator uses a named volume (`moderator-claude-data:/home/quorum/.claude`) to persist CC CLI data across restarts. However, `docker/moderator/entrypoint.sh:8` runs:

```bash
cp /etc/claude/settings.json /home/quorum/.claude/settings.json
```

The baked `settings.json` contains only `permissions.deny` and `systemPrompt` — the two areas Quorum needs to control. CC CLI adds its own keys during use (`hasCompletedOnboarding`, `preferredTheme`, `trustedDirectories`, etc.). The unconditional `cp` replaces the entire file, destroying those additions.

**User-visible symptom:** After `docker compose restart moderator`, running `docker compose exec -it moderator claude` presents the full first-time onboarding flow instead of resuming a configured session.

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

- [x] `settings.json` in the named volume retains CC CLI state (onboarding, theme, trust) across container restarts
- [x] Quorum-controlled keys (`permissions`, `systemPrompt`) update from the baked file on every start
- [x] First boot (empty volume) seeds `settings.json` from the baked file
- [x] User does not see the onboarding flow after `docker compose restart moderator` if already completed
- [x] `CLAUDE.md` remains unconditional force-copy
- [x] Merge uses `jq -s '.[0] * .[1]'` with write-to-tmp-then-mv atomicity pattern
- [x] `set -euo pipefail` ensures malformed JSON aborts before corrupting the volume
- [x] Baked `settings.json` is not modified (no pre-baked `allow` list)

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

**Review status:** Accepted

**Files modified:**
- `docker/moderator/entrypoint.sh` — replaced unconditional `cp` for `settings.json` with conditional `jq -s '.[0] * .[1]'` merge; updated comment block to describe merge semantics

**Deviations from ticket:** None — implementation matches the ticket spec exactly.

**Verification results:**
- `npm run build` — pass
- `npm run lint` — pass (0 errors, 0 warnings)
- `npm run test` — 50 suites, 771 tests, all pass
- Edge cases verified by code inspection: empty file, malformed JSON, first boot, permissions allow/deny coexistence, cross-filesystem `mv` safety
