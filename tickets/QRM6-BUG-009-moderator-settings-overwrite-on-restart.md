# QRM6-BUG-009: Moderator Entrypoint Force-Overwrites `settings.json` on Every Container Start

**Status: Open**

## Summary

The moderator container's entrypoint unconditionally copies the baked `settings.json` from `/etc/claude/` into the named volume at `/home/quorum/.claude/` on every start. This wipes CC CLI state written during prior sessions — onboarding completion, theme choice, and directory trust decisions — forcing the user through the full onboarding flow every time they reconnect after a container restart. The same issue affects `CLAUDE.md`: user edits in the volume are silently overwritten.

## Problem Statement

The moderator uses a named volume (`moderator-claude-data:/home/quorum/.claude`) specifically to persist CC CLI data across restarts. However, `docker/moderator/entrypoint.sh:8-9` runs:

```bash
cp /etc/claude/settings.json /home/quorum/.claude/settings.json
cp /etc/claude/CLAUDE.md /home/quorum/.claude/CLAUDE.md
```

The baked `settings.json` contains only `permissions` and `systemPrompt` — the two keys Quorum needs to control. CC CLI adds its own keys during use (onboarding state, theme, trust decisions, etc.). The unconditional `cp` replaces the entire file, destroying those additions.

**User-visible symptom:** After `docker compose restart moderator`, running `docker compose exec -it moderator claude` presents the full first-time onboarding flow (theme selection, directory trust prompt, API key entry) instead of resuming a configured session.

The entrypoint comment explains the intent: *"the latest baked prompt/settings always wins on container start."* The goal — keeping Quorum's config current across image updates — is valid, but the mechanism is too aggressive. A full file replacement is appropriate for first boot but destructive on subsequent starts.

**Severity:** Low. The user can complete onboarding again in under a minute, and no data beyond UX preferences is lost. But it's a recurring annoyance that undermines the purpose of the named volume.

## Implementation Details

Three fix directions, in order of recommendation:

### Option A: Merge baked keys into existing settings (recommended)

On container start, if `settings.json` already exists in the volume, merge only the `permissions` and `systemPrompt` keys from the baked file into the existing file — preserving everything CC CLI added. Use `jq` (already available in the image) for a simple JSON merge:

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

This ensures Quorum's `permissions` and `systemPrompt` stay current on image updates while preserving CC CLI's state. The `jq -s '.[0] * .[1]'` pattern gives the baked file precedence for shared keys, which is the desired behavior.

Apply the same pattern to `CLAUDE.md` if user edits should be preserved, or accept the overwrite if `CLAUDE.md` is meant to be fully controlled by the image.

### Option B: Copy only if absent

```bash
[ -f /home/quorum/.claude/settings.json ] || cp /etc/claude/settings.json /home/quorum/.claude/settings.json
```

Simplest fix, but means Quorum config updates in new image builds won't propagate to existing volumes until the volume is wiped. Acceptable for `CLAUDE.md` (where full image control may be desirable) but problematic for `settings.json` if permissions or system prompt evolve.

### Option C: Separate baked config path

Move Quorum-controlled settings to a path CC CLI reads alongside user settings (e.g., project-level `.claude/settings.json`). This avoids the collision entirely but requires understanding CC CLI's settings precedence and may not be supported for all keys.

### CLAUDE.md consideration

The `CLAUDE.md` overwrite (line 9) is arguably correct — the moderator's `CLAUDE.md` defines its role prompt and should stay in sync with the image. But if users or agents modify it during a session (e.g., adding project-specific notes), those edits are lost. Consider whether `CLAUDE.md` should follow the same merge strategy or remain force-copied.

## Acceptance Criteria

- [ ] `settings.json` in the named volume retains CC CLI state (onboarding, theme, trust) across container restarts
- [ ] Quorum-controlled keys (`permissions`, `systemPrompt`) are updated from the baked file on every start
- [ ] First boot (empty volume) still seeds `settings.json` from the baked file
- [ ] User does not see the onboarding flow after `docker compose restart moderator` if they already completed it
- [ ] `CLAUDE.md` handling is explicitly decided (merge, skip-if-exists, or keep force-copy) and documented in the entrypoint

## Dependencies and References

### Prerequisites
- None — self-contained entrypoint change; may require `jq` if Option A is chosen (verify availability in the image)

### What This Blocks
- Nothing directly — low-severity UX issue

### References
- `docker/moderator/entrypoint.sh:8-9` — the unconditional `cp` commands
- `docker/moderator/settings.json` — baked source (contains only `permissions` and `systemPrompt`)
- `docker-compose.yml:175` — named volume mount `moderator-claude-data:/home/quorum/.claude`
- `Dockerfile:103-105` — bake step copying files into `/etc/claude/`
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — discovered during the BUG-005 investigation session (2026-04-25)
- [QRM6-BUG-006](QRM6-BUG-006-moderator-entrypoint-dangling-symlink.md) — related entrypoint fix (dangling symlink for `.claude.json`)
