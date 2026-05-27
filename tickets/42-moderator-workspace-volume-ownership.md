# #42: Fix moderator workspace volume ownership for first-boot clone

## Summary

Make the moderator stage in `Dockerfile` chown `/mnt/quorum/workspace` to `quorum:quorum` so the `moderator-workspace` named volume is seeded with the right ownership on first mount, and the entrypoint's first-boot `git clone` succeeds.

## Problem Statement

On a clean install (or any time the `moderator-workspace` named volume is recreated), the moderator container fails to start on first boot:

```
moderator-1    | gh auth: logged in, credential helper configured, GH_TOKEN unset
moderator-1    | First boot: cloning https://github.com/ia64mail/quorum.git into /mnt/quorum/workspace ...
moderator-1    | Cloning into '/mnt/quorum/workspace'...
moderator-1    | /mnt/quorum/workspace/.git: Permission denied
moderator-1 exited with code 1
```

### Root cause

The moderator stage in `Dockerfile` sets `WORKDIR /mnt/quorum/workspace` (line 100). `WORKDIR` creates the directory at image build time, owned by `root:root` with mode `0755`. The subsequent `RUN mkdir -p … && chown -R quorum:quorum …` block (lines 130-131) lists `/app/logs /tmp/.claude /home/quorum/.claude /etc/claude` but **not** `/mnt/quorum/workspace`, so that path stays root-owned in the image.

When the empty `moderator-workspace` named volume is first mounted at `/mnt/quorum/workspace`, Docker seeds the volume from the image layer at that path — including the `root:root` ownership of the directory itself. The moderator container runs as `quorum` (UID `${HOST_UID}`), which has only `r-x` on a `root`-owned `0755` directory and cannot create `.git/` inside it. The entrypoint's `git clone "$REPO_URL" /mnt/quorum/workspace` fails with `Permission denied`, and `set -euo pipefail` exits the container.

### Why #14's "Option D" volume-seed fix didn't cover this

PR #36 (ticket #14) addressed a related-but-different volume-seed bug: the Dockerfile was creating `/mnt/quorum/workspace/.claude` at build time, which the empty volume then inherited, making the clone target non-empty. The fix was to drop the `mkdir` for that subdirectory so the volume mount point stays empty on first boot.

That fix correctly addresses the *contents* of the seeded volume, but does not touch the *ownership* of the mount point directory itself. The directory still exists (created by `WORKDIR`), still has `root:root` ownership, and `git clone` still cannot write into it.

### Scope of impact

Reproduces on every first boot of the moderator on a host where:
- The `moderator-workspace` named volume does not yet exist (clean install, or after `docker volume rm quorum_moderator-workspace`).
- The container's effective UID differs from the directory's owner (UID 0). This is always true given `USER quorum` and `${HOST_UID:-1000}`.

After first-boot failure, the volume is left empty but root-owned, and every subsequent restart fails the same way until the volume is removed and the image is rebuilt with the fix.

## Implementation Details

### 1. Add `/mnt/quorum/workspace` to the moderator stage's mkdir/chown

**File:** `Dockerfile`, moderator stage (lines 130-132).

**Current state:**

```dockerfile
RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude /etc/claude \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude /etc/claude \
 && ln -s /home/quorum/.claude/_claude.json /home/quorum/.claude.json
```

**Target state:**

```dockerfile
RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude /etc/claude /mnt/quorum/workspace \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude /etc/claude /mnt/quorum/workspace \
 && ln -s /home/quorum/.claude/_claude.json /home/quorum/.claude.json
```

The `mkdir -p` for `/mnt/quorum/workspace` is a no-op when the directory already exists (created by `WORKDIR` at line 100) — it only ensures the chown target exists in case the `WORKDIR` line is ever removed or reordered. The `chown` is the load-bearing change: it switches the image-layer ownership of the workspace directory from `root:root` to `quorum:quorum`.

### 2. Why this works under Docker's volume-seed semantics

When Docker first mounts an empty named volume at an image path, it copies the *contents and metadata* (mode, ownership) of the image-layer directory into the volume. With the directory chowned to `quorum:quorum` in the image, the seeded volume inherits that ownership and the entrypoint's `git clone` succeeds.

On subsequent restarts the volume is non-empty, Docker skips the seed step, and the entrypoint's `.git` check skips the clone — unchanged behavior.

### 3. No interaction with other stages

The `default` and `agent` stages do not use `/mnt/quorum/workspace` as a `WORKDIR` and do not mount the `moderator-workspace` volume. This change is scoped to the moderator stage only.

### Scope guards

- **Moderator image rebuild required.** After merge, `docker compose build moderator` must run for the fix to take effect.
- **Existing root-owned volumes must be removed.** Hosts where the moderator already failed first-boot have a root-owned `moderator-workspace` volume on disk. The fix only seeds the *next* fresh volume; an existing root-owned one must be removed first (`docker volume rm quorum_moderator-workspace`). Document this in the post-merge note.
- **Build env hygiene reminder.** Always rebuild via `./scripts/start.sh` (or with `HOST_UID=$(id -u) HOST_GID=$(id -g)` in the env). Rebuilding with the default `HOST_UID=1000` on a host with a different UID produces a `quorum` user that cannot read/write any existing volume files. This is a separate, recurring footgun — out of scope for this ticket but worth flagging in the PR description.
- **Do NOT touch the `WORKDIR` line.** Moving or removing `WORKDIR /mnt/quorum/workspace` would break QRM7-004 (cwd alignment, used by CC CLI to auto-load `CLAUDE.md` and resolve the `@quorum.md` symlink).
- **Do NOT add a runtime chown in the entrypoint.** The entrypoint runs as `quorum` and cannot chown a root-owned directory. Even if it could (e.g., via setuid), runtime chown is the wrong layer — the image should ship with correct ownership.

## Acceptance Criteria

- [ ] Moderator stage in `Dockerfile` includes `/mnt/quorum/workspace` in both the `mkdir -p` and `chown -R quorum:quorum` arguments of the `RUN` block at lines 130-132.
- [ ] `docker run --rm --entrypoint=/bin/sh quorum-moderator -c 'ls -ld /mnt/quorum/workspace'` reports owner `quorum:quorum` (not `root:root`) on a freshly built image.
- [ ] On a host with no existing `moderator-workspace` volume, `./scripts/start.sh moderator` completes first boot without `Permission denied`, the entrypoint logs `Clone complete`, and `docker exec quorum-moderator-1 ls -la /mnt/quorum/workspace/.git` shows the cloned repo metadata.
- [ ] Idempotency preserved — on a second `docker compose up moderator` against the now-populated volume, the entrypoint logs `Workspace already initialized (git repo found), skipping clone` (existing behavior; nothing regresses).
- [ ] `default` and `agent` stages of `Dockerfile` are unchanged.
- [ ] No changes to `docker-compose.yml`, `docker/moderator/entrypoint.sh`, `docker/moderator/CLAUDE.md`, or any other file outside `Dockerfile`.
- [ ] Post-merge note in the PR description: existing hosts that already hit the bug must run `docker volume rm quorum_moderator-workspace` before `docker compose build moderator && ./scripts/start.sh -d moderator` to pick up the fix.

## Dependencies and References

**Depends on / interacts with:**
- #14 — Moderator becomes standalone git client. Introduced the named-volume + first-boot-clone model and fixed a related `.claude` seed bug (PR #36). This ticket completes the volume-seed fix by addressing directory ownership, which #14's spec did not anticipate.

**References:**
- [#8: QRM8 Roadmap](8-workspace-isolation.md) — D4 (no host bind mount on moderator) and the named-volume model this ticket hardens.
- [#14: Moderator git client](14-moderator-git-client.md) — Implementation Notes section describing the prior "Option D" volume-seed fix; this ticket is the second half of the same class of bug.
- Docker docs — [Populate a volume using a container](https://docs.docker.com/storage/volumes/#populate-a-volume-using-a-container) — confirms that ownership/mode of the image-layer directory is copied into the empty volume on first mount.