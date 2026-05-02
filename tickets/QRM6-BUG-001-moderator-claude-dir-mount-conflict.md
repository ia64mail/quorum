# QRM6-BUG-001: Moderator `.claude` Mount Conflict Blocks Stack Startup

**Status: Implemented** — mount conflict resolved by splitting security anchors (commits bc9d05d, 1d2fc89)

## Summary

The `moderator` service in `docker-compose.yml` declares `/home/quorum/.claude` as both a tmpfs (inherited from the `*agent-security` anchor) and a named volume (`moderator-claude-data`), causing `./scripts/start.sh` to fail immediately with `services.moderator.volumes[2]: target /home/quorum/.claude already mounted as services.moderator.tmpfs[1]`. No containers start, so QRM6 cannot be verified end-to-end.

## Problem Statement

QRM6-002 introduced the `moderator` service with two requirements:

1. Reuse the agent security posture (read-only rootfs, `no-new-privileges`, `cap_drop ALL`, tmpfs for ephemeral user dirs) via `<<: *agent-security`.
2. Persist CC CLI session history across container restarts via a named volume at `/home/quorum/.claude`.

The shared `*agent-security` anchor (`docker-compose.yml:15–26`) declares `/home/quorum/.claude` as a tmpfs. The moderator service then mounts `moderator-claude-data` at the same path (`docker-compose.yml:167`). Docker Compose rejects overlapping mounts, so the entire stack refuses to start:

```
ia64_corp@ia64-Precision-5560:~/quorum$ ./scripts/start.sh
Building with HOST_UID=1002, HOST_GID=1002
services.moderator.volumes[2]: target /home/quorum/.claude already mounted as services.moderator.tmpfs[1]
```

This is a **blocking bug** — QRM6-008 (playbook E2E test) and all subsequent QRM6 verification are gated on a working stack.

### Root Cause

The four agent services (`architect`, `teamlead`, `developer`, plus moderator) share the `*agent-security` anchor, but only the moderator needs a persistent `/home/quorum/.claude` — the agents are stateless and intentionally use tmpfs. QRM6-002 added the named volume without removing the `.claude` tmpfs from the anchor's scope for the moderator, producing two mounts at the same target.

## Implementation Details

Split the shared security anchor into two: a base anchor with the common security settings and ephemeral tmpfs mounts (`/tmp`, `.config`, `.local`, `.cache`), and an agent-specific anchor that adds the `.claude` tmpfs. The moderator uses the base; the four agents use the agent-specific anchor.

### Change to `docker-compose.yml`

Replace the single `x-agent-security` anchor with two anchors:

```yaml
x-base-security: &base-security
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  tmpfs:
    - /tmp:size=512m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.config:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.local:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.cache:size=128m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}

x-agent-security: &agent-security
  <<: *base-security
  tmpfs:
    - /tmp:size=512m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.claude:size=256m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.config:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.local:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
    - /home/quorum/.cache:size=128m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
```

Note: YAML merge keys (`<<:`) do not deep-merge list fields — the `tmpfs` list in `*agent-security` fully replaces the one from `*base-security`, so the `.claude` entry must be explicit in the agent anchor. An alternative is to duplicate the security block inline in the moderator and skip the anchor for it; pick whichever keeps the file cleaner.

Update the `moderator` service to use `*base-security` instead of `*agent-security`:

```yaml
moderator:
  build: ...
  <<: *base-security      # was: *agent-security
  stdin_open: true
  ...
  volumes:
    - ${WORKSPACE_PATH:-.}:/mnt/quorum/workspace:rw
    - ./logs:/app/logs
    - moderator-claude-data:/home/quorum/.claude
```

The four agent services (`architect`, `teamlead`, `developer`, and any future agent) continue using `*agent-security` unchanged.

### Entrypoint behavior

The moderator entrypoint (`docker/moderator/entrypoint.sh`) copies the baked settings template from `/etc/claude/settings.json` into `/home/quorum/.claude/settings.json` at startup. With a named volume:
- **First boot** — the volume is empty; the entrypoint seeds it.
- **Subsequent boots** — the volume already contains `settings.json`, session history, and `.claude.json` symlink target. Decide whether the entrypoint should overwrite or skip on re-seed (current behavior overwrites unconditionally, which is probably correct so `MCP_SERVER_URL` substitution stays fresh).

Verify this during implementation; if overwrite causes loss of user-authored config, guard the copy with a sentinel check.

## Acceptance Criteria

- [ ] `./scripts/start.sh` completes without a mount conflict error
- [ ] `docker compose up -d` brings up all seven services (`ollama-init`, `ollama`, `opensearch`, `mcp-server`, `moderator`, `architect`, `teamlead`, `developer`) to healthy / running state
- [ ] The moderator's `/home/quorum/.claude` is a named volume (not tmpfs) — verified via `docker inspect quorum-moderator-1` showing `moderator-claude-data` as the mount source
- [ ] `docker compose exec moderator ls -la /home/quorum/.claude/settings.json` returns a real file, and its content has `__MCP_SERVER_URL__` substituted
- [ ] The four agent services still have `/home/quorum/.claude` as tmpfs — verified via `docker inspect quorum-architect-1` (and siblings)
- [ ] After `docker compose down` and `docker compose up -d`, moderator CC CLI session history in `/home/quorum/.claude` persists across restarts (verify by creating a marker file inside the container, restarting, confirming presence)
- [ ] `npm run build`, `npm run lint`, `npm run test` pass (no regressions — docker-compose changes should not affect TS tests)

## Dependencies and References

### Prerequisites
- QRM6-002 — Moderator Container Image (introduced the conflicting mount configuration)

### What This Blocks
- QRM6-008 — Playbook E2E Test for Containerized Moderator (cannot run until the stack starts)
- All subsequent QRM6 verification and milestone acceptance

### References
- `docker-compose.yml:15–26` — `x-agent-security` anchor with `.claude` tmpfs
- `docker-compose.yml:147–169` — `moderator` service definition
- `docker/moderator/entrypoint.sh` — settings template seeding
- [tickets/QRM6-002-moderator-container-image.md](QRM6-002-moderator-container-image.md) — original design, lines 137–144 noted the named-volume option but the implementation retained the conflicting tmpfs inheritance