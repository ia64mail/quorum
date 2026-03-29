# QRM4-BUG-003: `nest` CLI Not Available in Agent Containers — Build/Lint/Test Blocked

## Summary

Agent containers cannot run `npm run build`, `npm run lint`, or `npm run test` because `@nestjs/cli` is not in `$PATH` and `npx` cannot create its cache directory on the read-only filesystem. This blocks agents from verifying their own work, which is a core part of the development workflow.

## Problem Statement

The agent Dockerfile (`Dockerfile`, agent target) installs production dependencies only. The NestJS CLI (`@nestjs/cli`) is a devDependency — it exists in `node_modules/.bin/nest` on the host but is not available inside the container. Additionally, the read-only filesystem policy (`read_only: true` in `x-agent-security`) prevents `npx` from creating its cache at `/home/quorum/.npm`, blocking the fallback path.

**Observed behavior (QRM4 kick-off session, 2026-03-28):**

```
01:53:22  developer  !! npm run build -> "nest: not found" (no CLI in PATH)
01:53:25  developer     npm install -> installs, but...
01:53:38  developer  !! npx nest build -> ENOENT mkdir /home/quorum/.npm (read-only FS)
01:53:41  developer  !! node_modules/.bin/nest -> not found
01:54:03  developer  !! npm run build -> "nest: not found" (still stuck)
01:54:07  developer     Keeps trying build in loop (npx, PATH, mkdir...)
```

Developer spent 10+ turns and burned tokens trying workarounds. The implementation was correct (verified by `git diff`) but could not be build-verified or committed.

**Root cause:** Two compounding issues:
1. `node_modules/.bin` is not in `$PATH` inside agent containers
2. `/home/quorum/.npm` (npm cache) is on the read-only rootfs — `npx` and `npm install` fail with ENOENT/EROFS

## Implementation Details

Three changes are needed, all in Docker/compose configuration (no application code changes):

### 1. Add `node_modules/.bin` to `$PATH` in agent Dockerfile

In the `agent` target of `Dockerfile`, add:

```dockerfile
ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"
```

This makes `nest`, `jest`, `eslint`, and other bin-linked devDependencies available when the workspace is mounted. The workspace volume is mounted `:rw` and contains the full `node_modules` from the host.

### 2. Set `npm_config_cache` to a writable location

Add to `docker-compose.yml` shared env or per-agent env:

```yaml
npm_config_cache: /tmp/.npm
```

This redirects npm's cache directory from `/home/quorum/.npm` (read-only rootfs) to `/tmp/.npm` (writable tmpfs, 512MB). This enables `npx` and `npm install` as fallback paths.

### 3. (Optional) Increase `/tmp` tmpfs size if needed

The current `/tmp` tmpfs is 512MB. If `npm install` of devDependencies causes space issues, this may need to be increased. Monitor during testing.

### Why not install `@nestjs/cli` globally in the image?

Installing it globally would:
- Increase image size for all roles (architect, productowner don't need it)
- Create version drift between global CLI and project's pinned version
- Still not solve the `npx` cache issue for other tools

The `$PATH` approach is simpler and reuses the host's exact dependency versions.

## Acceptance Criteria

- [ ] `ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"` added to agent target in `Dockerfile`
- [ ] `npm_config_cache: /tmp/.npm` added to agent service environment in `docker-compose.yml`
- [ ] After rebuild, developer agent can run `npm run build` successfully
- [ ] After rebuild, developer agent can run `npm run lint` successfully
- [ ] After rebuild, developer agent can run `npm run test` successfully
- [ ] `npx` commands work inside agent containers (cache writes to `/tmp/.npm`)
- [ ] Other agent roles (architect, teamlead) are not adversely affected

## Dependencies and References

- Discovered during [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md) — Issue #2
- `Dockerfile:39-68` — agent target build definition
- `docker-compose.yml` — `x-agent-security` anchor (read_only, tmpfs mounts)
- `docker-compose.yml` — agent service definitions (architect, teamlead, developer)
- QRM1-011 (Docker Containerization) — original container setup