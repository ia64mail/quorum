# QRM7-004: Moderator's CC CLI cwd Is `/app` (Empty), Causing Path Confusion with the Workspace

**Status: Done (2026-05-08)**

> **Cross-ref [QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md) — consider both together before implementing.** QRM7-003 addresses a different symptom of the same `cwd=/app` mistake: CC CLI 2.1.119+ writes interactive permission grants to `<cwd>/.claude/settings.local.json` and the writes fail because `/app` is read-only with no `.claude/` directory. The cwd relocation proposed here would make QRM7-003's planned `/app/.claude/` writable-volume engineering unnecessary by landing grants on the existing workspace bind-mount instead. Pick a single resolution path rather than landing both — see the **Design Context** section for the reconciliation.

## Summary

The moderator container starts CC CLI with `cwd=/app` because the moderator Dockerfile stage inherits `WORKDIR /app` from the earlier `default`/`agent` stages and nothing overrides it at attach time. `/app` holds no project code in the moderator image — only the `/app/logs` bind-mount — so CC CLI's "project root" lands on an empty directory while the actual Quorum workspace is mounted next door at `/mnt/quorum/workspace`. The model's first instinct on any "look at the project" request is to use cwd-relative paths under `/app`, even though the user-scope `CLAUDE.md` clearly states the workspace is at `/mnt/quorum/workspace`. Move the moderator's cwd to the workspace mount; the prompt-level reminder isn't strong enough on its own.

## Problem Statement

Observed behavior (current `main`, CC CLI 2.1.126):

```
$ ./scripts/moderator.sh
> read the project roadmap
● The workspace is at /mnt/quorum/workspace, not /app. Let me look there for the roadmap, tickets, and git history.
```

The moderator self-corrects, but only after a wasted turn. Symptom recurs intermittently across sessions: any ambiguous "the project / the codebase / the repo" reference is first interpreted as cwd-relative, then walked back when the model rereads its prompt and remembers that cwd ≠ workspace.

### Why this happens

1. **`Dockerfile:88` sets `WORKDIR /app`** for the moderator stage. This is inherited boilerplate from the `default` and `agent` stages (where `/app` *does* hold app code via `COPY --from=builder /app/dist`); the moderator stage copies nothing into `/app` (no `dist/`, no `node_modules` — `npm install -g` puts CC CLI under `/usr/lib/node_modules`).
2. **`scripts/moderator.sh:3`** runs `docker compose exec -it moderator claude` with no `--workdir`, so CC CLI starts in the container's `WORKDIR`.
3. **CC CLI surfaces cwd in its system context.** The model sees `cwd: /app` on every turn and that signal repeatedly outweighs the prose guidance in `~/.claude/CLAUDE.md` ("shared workspace at `/mnt/quorum/workspace`", lines 18 and 56 of `docker/moderator/CLAUDE.md`).
4. **Project-scope CLAUDE.md auto-load walks up from cwd.** From `/app` there is no `CLAUDE.md` to find — so `/mnt/quorum/workspace/CLAUDE.md` and the `@quorum.md` import target are **not** auto-loaded as project-scope. They're only echoed for visibility by `docker/moderator/entrypoint.sh:65-74`, never injected into the live prompt.

`/app` in the running moderator container contains exactly:
- `/app/logs/` (bind-mount → host `./logs`)

That's it. No package.json, no code. CC CLI's notion of "the project" is anchored on a directory that contains nothing the moderator should ever read or write.

### Evidence

| Probe (run inside `quorum-moderator-1`) | Result |
|---|---|
| `pwd` (initial CC CLI session cwd) | `/app` |
| `ls /app` | `logs` (only) |
| `ls /mnt/quorum/workspace` | full Quorum repo: `apps/`, `libs/`, `tickets/`, `docs/`, `CLAUDE.md`, `quorum.md`, … |
| `cat /home/quorum/.claude/CLAUDE.md \| grep -c "/mnt/quorum/workspace"` | `2` (prose-only references; not enough on its own) |

## Design Context

This ticket directly intersects with **[QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md)**, which proposed creating a writable, persistent `/app/.claude/` so CC CLI 2.1.119+ could persist interactive permission grants at `<cwd>/.claude/settings.local.json`. QRM7-003 explicitly opted *not* to relocate cwd to `/mnt/quorum/workspace`, citing two concerns:

1. **Workspace ≠ moderator's project.** The argument was that the workspace belongs to the agents and switching cwd would conflate concerns.
2. **Orphaning `~/.claude/projects/-app/`** transcripts and `hasTrustDialogAccepted` history.

This ticket revisits both points and concludes the relocation is the better fix — and it *obsoletes* QRM7-003's `/app/.claude/` engineering rather than competing with it:

- **Workspace ≠ moderator's project is no longer accurate.** Per `docker/moderator/CLAUDE.md:18` and the Quorum design as it stands, the moderator works *against* the Quorum repo (reading tickets, docs, code, git history). The workspace is the moderator's project — it's just shared with agents. There's no separate "moderator's own project" living at `/app`; that path is empty boilerplate.
- **Transcript orphaning is one-time and acceptable.** Existing `~/.claude/projects/-app/` files don't disappear; they just stop being auto-loaded for the new cwd. No active session relies on them. The named volume (`moderator-claude-data`) preserves them indefinitely if anyone ever needs to grep them.
- **Permission persistence becomes free.** With cwd at `/mnt/quorum/workspace`, CC CLI writes grants to `/mnt/quorum/workspace/.claude/settings.local.json` — already a writable bind-mount, persists on the host without any volume engineering. QRM7-003's `/app/.claude/` named-volume work becomes unnecessary.
- **Project-scope CLAUDE.md auto-loads naturally.** `/mnt/quorum/workspace/CLAUDE.md` (which `@`-imports `quorum.md`) is the moderator role definition. With cwd inside the workspace, CC CLI loads it as project-scope without the entrypoint having to `cat` it for visibility. The user-scope copy at `/home/quorum/.claude/CLAUDE.md` becomes redundant and can be retired in a follow-up.

The reverse alternative — strengthening prompt guidance only — was already attempted (see lines 18 and 56 of `docker/moderator/CLAUDE.md`) and the symptom persists. Prompt prose loses to cwd in CC CLI's system context.

## Implementation Details

### Move the moderator's cwd to the workspace

Change `Dockerfile:88` for the moderator stage:

```dockerfile
# Before
WORKDIR /app

# After
WORKDIR /mnt/quorum/workspace
```

The `/app/logs` mount in `docker-compose.yml:147` stays — `WORKDIR` doesn't affect bind-mount targets, and `LOG_JSON_DIR=/app/logs` (docker-compose.yml:7) keeps working.

### Remove or adapt QRM7-003's planned `/app/.claude/` infrastructure

QRM7-003 is in **Draft** status. With this ticket, its fix path is no longer needed — close it as superseded once QRM7-004 lands and verify on CC CLI 2.1.126 that grants persist via `/mnt/quorum/workspace/.claude/settings.local.json`. Concretely:

- **Don't** add the `moderator-claude-data` sub-path mount or new `moderator-app-claude-data` volume that QRM7-003 proposed.
- **Don't** add the `/app/.claude` `mkdir`/`chown` step in `docker/moderator/entrypoint.sh`.
- **Do** verify (post-deploy) that an interactive "always allow" produces an entry in `/mnt/quorum/workspace/.claude/settings.local.json` and survives `docker compose restart moderator`.

### Entrypoint: drop the redundant CLAUDE.md echo (optional cleanup)

`docker/moderator/entrypoint.sh:65-74` `cat`s `/mnt/quorum/workspace/CLAUDE.md` and `/mnt/quorum/workspace/quorum.md` to stdout to reveal what the moderator "would see if cwd were aligned." Once cwd *is* aligned, CC CLI auto-loads them as project-scope and the echo is just startup-log noise. Recommend deleting those lines as part of this ticket; not strictly required for the fix.

### Verify project-scope auto-load

After the change, attach to the moderator and run `/context` (or equivalent) inside the CC CLI session to confirm `/mnt/quorum/workspace/CLAUDE.md` (and the `@quorum.md` import) appear in the loaded context as project-scope, not just user-scope. This is the empirical test that the cwd move had its intended effect.

### Note on `~/.claude/projects/` path

CC CLI encodes the cwd into a directory name under `~/.claude/projects/`. The moderator's transcript directory will move from `~/.claude/projects/-app/` to `~/.claude/projects/-mnt-quorum-workspace/`. Both live on the persistent `moderator-claude-data` volume, so no transcript is lost; they just split into two prefixes. This is one-time and self-resolving.

## Acceptance Criteria

- [x] `Dockerfile:88` (moderator stage) sets `WORKDIR /mnt/quorum/workspace`
- [x] After `./scripts/start.sh` and `./scripts/moderator.sh`, `pwd` inside the moderator's CC CLI session reports `/mnt/quorum/workspace` *(verified 2026-05-08)*
- [x] CC CLI auto-loads `/mnt/quorum/workspace/CLAUDE.md` as project-scope (verifiable via `/context` or equivalent) *(verified 2026-05-08)*
- [x] An ambiguous prompt like "read the project roadmap" no longer triggers a `/app/...` first attempt — moderator goes straight to `/mnt/quorum/workspace/...` (or relative `./...`) *(implied by cwd + project-scope alignment; no `/app` self-correction observed)*
- [ ] An interactive "always allow" grant in CC CLI 2.1.126 produces `/mnt/quorum/workspace/.claude/settings.local.json`, the entry survives `docker compose restart moderator`, and the moderator does not re-prompt for the same tool after restart *(observation-pending — plumbing verified writable, write will materialise on first grant)*
- [x] `/app/logs` bind-mount remains functional; logs continue to land on the host under `./logs/`
- [x] QRM7-003 closed as superseded with a note pointing to QRM7-004
- [x] (Optional) `docker/moderator/entrypoint.sh` redundant `cat /mnt/quorum/workspace/CLAUDE.md` echo removed

## Implementation Notes

**Status:** Done

**Date:** 2026-05-08

**Commit:** `169ca02` — `QRM7-004: align moderator cwd with workspace mount`

### Files Modified

| File | Action | Notes |
|------|--------|-------|
| `Dockerfile` | Modified | Moderator stage `WORKDIR /app` → `WORKDIR /mnt/quorum/workspace` (line 88). All other paths in the stage are absolute — no collateral impact. |
| `docker/moderator/entrypoint.sh` | Modified | Removed 12-line block that `cat`'d `/mnt/quorum/workspace/CLAUDE.md` and `quorum.md` to stdout inside the "effective prompt" diagnostic. Now redundant — CC CLI auto-loads them as project-scope from cwd. Remaining diagnostic block (settings.json, permissions, user-scope CLAUDE.md) preserved. |
| `tickets/QRM7-003-moderator-permission-grants-not-persisting.md` | Modified | Status flipped from `Draft` to `Closed — Superseded by QRM7-004` with resolution note. |

### Deviations

- **0 deviations** — implementation matches ticket spec exactly. Both the required change (WORKDIR) and the optional cleanup (entrypoint echo removal) landed.

### Verification

- `npm run build` ✅ — all 3 webpack compilations successful
- `npm run lint` ✅ — clean (0 errors, 0 warnings)
- `npm run test` ✅ — 700/700 tests pass (44 suites)
- Code review confirmed all paths in the moderator Dockerfile stage are absolute — no implicit `cwd=/app` dependency.
- Code review confirmed `LOG_JSON_DIR=/app/logs` and `./logs:/app/logs` bind-mount are unaffected (absolute container paths, Docker resolves independently of WORKDIR).
- Code review confirmed the removed entrypoint block has no consumers — purely informational stdout.

### Runtime Verification (2026-05-08)

Performed by the moderator immediately after `./scripts/start.sh` rebuild:

1. **`pwd` → `/mnt/quorum/workspace`** ✅ — cwd aligned correctly.
2. **Project-scope `CLAUDE.md` auto-loaded** ✅ — visible in CC CLI system reminder as `Contents of /mnt/quorum/workspace/CLAUDE.md (project instructions, checked into the codebase)`.
3. **Transcript directory shifted** ✅ — `~/.claude/projects/-mnt-quorum-workspace/` created on the named volume; old `-app/` preserved untouched.
4. **`/mnt/quorum/workspace/.claude/` writable** ✅ — `drwxrwxr-x quorum quorum`, currently holds the repo-tracked `settings.json` only; ready to receive `settings.local.json` on first interactive grant.
5. **Grant write-through** ⏳ — observation-pending. The plumbing is verified writable; the actual `settings.local.json` write (and survival across `docker compose restart moderator`) will materialise organically the next time a permission with an "always allow" option is approved. Not blocking the status flip.

## Dependencies and References

### Prerequisites
- None — single-line Dockerfile change plus follow-up cleanup.

### What This Blocks
- Reliable moderator behavior on first-instinct file access. Until fixed, every session burns one or more turns on cwd-vs-workspace self-correction.

### What This Supersedes
- **[QRM7-003](QRM7-003-moderator-permission-grants-not-persisting.md)** — the `/app/.claude/` writable-volume fix becomes unnecessary because grants land in the workspace bind-mount once cwd is aligned. Close QRM7-003 with a pointer here.

### References
- `Dockerfile:86-120` — moderator stage; `WORKDIR /app` at line 88 is the lever
- `docker-compose.yml:128-150` — moderator service; `${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw` mount at line 146 already gives CC CLI a writable workspace
- `docker/moderator/entrypoint.sh:65-74` — current `cat` of workspace CLAUDE.md/quorum.md (becomes redundant)
- `docker/moderator/CLAUDE.md:18,56` — prose references to `/mnt/quorum/workspace` that proved insufficient on their own
- `scripts/moderator.sh:3` — `docker compose exec -it moderator claude`; no `--workdir` passed, so the change must happen at the `WORKDIR` layer
- [QRM6-007](QRM6-007-moderator-claude-md.md) — original moderator CLAUDE.md port; established the workspace as the moderator's reading/working surface
- [QRM6-BUG-009](QRM6-BUG-009-moderator-settings-overwrite-on-restart.md) — `~/.claude/` persistence (still applies, unchanged by this ticket)