# QRM6-BUG-006: Moderator Entrypoint `cp` Fails Through Dangling Symlink Under Tmpfs `/tmp`

**Status: Open** — patch landed in the working tree during the QRM6-008 2026-04-25 run; pending commit.

## Summary

The moderator container exits non-zero on every fresh start with `cp: not writing through dangling symlink '/home/quorum/.claude.json'`. The Dockerfile creates `/home/quorum/.claude.json` as a symlink to `/tmp/.claude.json` to keep the writable file on tmpfs under a read-only rootfs. The QRM6-BUG-001 security refactor made `/tmp` a fresh tmpfs on every container start, so the symlink target is empty/absent at boot — and GNU coreutils `cp` refuses to write through a dangling symlink. The container never reaches `tail -f /dev/null`; `docker compose up moderator` reports `Exited (1)`. No subsequent QRM6 work runs end-to-end on a clean machine.

## Problem Statement

Reproduction on a clean checkout (no patch applied), with the host's `HOST_UID`/`HOST_GID` correctly exported:

```
$ docker compose up -d moderator
 Container quorum-moderator-1  Started
$ docker compose ps -a moderator
NAME                 STATUS
quorum-moderator-1   Exited (1) 9 seconds ago
$ docker compose logs --tail=5 moderator
moderator-1  | cp: not writing through dangling symlink '/home/quorum/.claude.json'
```

Direct repro inside a fresh container (entrypoint disabled):

```
$ docker compose run --rm --no-deps --entrypoint /bin/bash moderator -c '
  ls -la /home/quorum/.claude.json /tmp/
  cp /etc/claude/claude.json /home/quorum/.claude.json
'
lrwxrwxrwx 1 root root 17 ... /home/quorum/.claude.json -> /tmp/.claude.json
/tmp/:
total 0
drwxrwxrwt 2 1002 1002 40 ... .
drwxr-xr-x 1 root root 4096 ... ..
cp: not writing through dangling symlink '/home/quorum/.claude.json'
```

The symlink exists from build time (`Dockerfile:104`), `/tmp` is a tmpfs (per `*base-security` after QRM6-BUG-001), and the symlink target `/tmp/.claude.json` does not exist at boot. GNU `cp` (coreutils) treats this as unsafe and refuses to create the file at the symlink target.

### Root cause

Two correct-on-their-own changes interacted:

| Commit | Change | Effect |
|--------|--------|--------|
| `b9ac714` (QRM6-002) | `Dockerfile`: add `ln -s /tmp/.claude.json /home/quorum/.claude.json`; `entrypoint.sh`: `cp /etc/claude/claude.json /home/quorum/.claude.json` | Place the writable user-scope `.claude.json` on tmpfs (so it survives the read-only rootfs) |
| `1d2fc89` (QRM6-BUG-001) | `docker-compose.yml`: split `*agent-security` into `*base-security`; moderator now uses `*base-security` which mounts `/tmp` as a fresh tmpfs each start | Resolve the `.claude` directory mount conflict |

Before `1d2fc89`, the moderator inherited the rootfs's `/tmp` (a writable directory baked into the image), and the symlink target may have been pre-populated by an earlier run or simply absent in a way that worked. After `1d2fc89`, every start gets an empty tmpfs, leaving the symlink dangling.

GNU coreutils' "not writing through dangling symlink" is a deliberate safety check — there is no `cp` flag to override it.

## Implementation Details

### Fix landed in the working tree (2026-04-25 session)

`docker/moderator/entrypoint.sh:15,20` — write the file directly to the symlink target rather than through the symlink:

```diff
-cp /etc/claude/claude.json /home/quorum/.claude.json
+cp /etc/claude/claude.json /tmp/.claude.json
 ...
-sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /home/quorum/.claude.json
+sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /tmp/.claude.json
```

CC CLI reads `~/.claude.json`, which still resolves through the symlink — the file at `/tmp/.claude.json` is the resolved target. No change to client behavior.

### Why this is a one-line entrypoint change rather than a Dockerfile/symlink rework

The symlink itself is fine; the problem is only the moment of first write. Writing to the target directly bypasses the safety check without weakening it (cp would still refuse to follow a dangling symlink for an arbitrary user-supplied destination). Alternative remediations considered:

| Option | Why not |
|--------|---------|
| `touch /home/quorum/.claude.json && cp ...` | `touch` follows the symlink and hits the same dangling-symlink semantics on some coreutils versions; non-portable |
| Drop the symlink, write to `/home/quorum/.claude.json` directly | Rootfs is read-only (`*base-security: read_only: true`); writing fails |
| Add `/home/quorum/.claude.json` as its own tmpfs mount in compose | Doubles the surface area; `.claude.json` is a single file, tmpfs operates on directories — would need `/home/quorum` as tmpfs which conflicts with the rootfs-baked `quorum` user files |
| Drop the symlink and seed `.claude.json` directly into the named volume `moderator-claude-data` | Volume is at `/home/quorum/.claude/`, not `/home/quorum/`. Adding another named volume just for a single file inflates compose for marginal benefit |

The one-line entrypoint change is the minimal correct fix.

### Hardening (out of scope for this ticket, recommended for QRM6-002 cleanup)

Add a self-verification step to the entrypoint that fails loudly if `~/.claude.json` is unreadable after the seed step. Currently the entrypoint already self-verifies `claude mcp list`; that catches QRM6-BUG-003 but masks file-level issues with a generic "Quorum MCP server not registered" error. A separate `[ -s ~/.claude.json ]` check before the `claude mcp list` probe would make the failure mode obvious.

## Acceptance Criteria

- [ ] Patch in `docker/moderator/entrypoint.sh` (cp/sed targets `/tmp/.claude.json` directly) committed to the QRM6 branch
- [ ] On a clean machine (`docker volume rm quorum_moderator-claude-data`, `docker compose down`, fresh build), `docker compose up -d moderator` brings the container to `Up` status without entrypoint errors
- [ ] `docker compose exec moderator cat /home/quorum/.claude.json` returns the substituted JSON (not an empty file or symlink error)
- [ ] `docker compose exec moderator claude mcp list` reports `quorum: ✓ Connected`
- [ ] QRM6-008 Scenario 1 passes deterministic checks without manual intervention
- [ ] (Optional) Entrypoint adds an early `[ -s /tmp/.claude.json ]` sanity check after the cp + sed block

## Dependencies and References

### Prerequisites
- None — the fix is a self-contained one-line entrypoint change

### What This Blocks
- QRM6-008 — playbook cannot run on a clean machine without the patch (Scenario 1 fails container-up)
- QRM6-009 — terminal deletion is downstream of moderator stack stability

### What Triggered the Regression
- QRM6-002 introduced the symlink (commit `b9ac714`)
- QRM6-BUG-001 changed `/tmp` to per-start tmpfs (commit `1d2fc89`)
- The two combined produce the dangling-symlink condition; neither change is wrong on its own

### References
- `docker/moderator/entrypoint.sh` — patched file (lines 15, 20)
- `Dockerfile:104` — `ln -s /tmp/.claude.json /home/quorum/.claude.json`
- `docker-compose.yml` — `*base-security` anchor (`/tmp` as tmpfs)
- [QRM6-BUG-001](QRM6-BUG-001-moderator-claude-dir-mount-conflict.md) — security anchor split that surfaced this latent bug
- [QRM6-002](QRM6-002-moderator-container-image.md) — moderator container image (where the symlink was introduced)
- **Discovered during:** QRM6-008 playbook run 2026-04-25 — Scenario 1 (container health) failed at startup; patch developed and applied mid-session before resuming the playbook