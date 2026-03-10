# QRM2-BUG-003: Container UID Mismatch Breaks Bind-Mount Writes

## Summary

Agent containers run as `quorum` (uid 1000) but the host user may have a different uid (e.g. 1002), causing bind-mounted directories like `./logs:/app/logs` to be unwritable from inside the container. JSON log files are silently not created on fresh restarts.

## Problem Statement

The Dockerfile hardcodes the `quorum` user at uid 1000 / gid 1000. When the host user that owns `./logs/` has a different uid (discovered as uid 1002 on the current dev host), the container process cannot create new files in the bind-mounted directory.

**Observed behavior:**
- Containers start cleanly, no errors in stdout
- `./logs/` contains only stale log files from a prior session (when containers ran as root)
- No new `{role}-{timestamp}.jsonl` files are created
- Console logging still works — only JSON file logging is affected

**Workaround applied:** `chmod 1777 ./logs` (sticky bit + world-writable). This is acceptable for a logs directory but fragile — any new bind-mounted directory will hit the same issue.

### Why this matters

- Silent log loss makes debugging container issues harder (as seen in QRM2-BUG-002 diagnosis)
- The problem will recur for any future bind-mounted directory
- Different dev machines may have different uids, making the issue intermittent across environments

## Implementation Details

Parameterize the container user's uid/gid via Docker build args so the image matches the host user. A startup script automates the entire flow.

### Changes

#### 1. Dockerfile — both stages accept `HOST_UID` / `HOST_GID`

**`default` stage** (Alpine — mcp-server, terminal): creates the `quorum` user with the provided uid/gid via `addgroup -g` / `adduser -u`:

```dockerfile
ARG HOST_UID=1000
ARG HOST_GID=1000

RUN deluser node && delgroup node 2>/dev/null; \
    addgroup -g ${HOST_GID} quorum && adduser -u ${HOST_UID} -G quorum -s /bin/sh -D quorum
```

**`agent` stage** (Bookworm — agent containers): renames the default `node` user and adjusts uid/gid in-place via `groupmod -g` / `usermod -u -g`:

```dockerfile
ARG HOST_UID=1000
ARG HOST_GID=1000

RUN groupmod -n quorum -g ${HOST_GID} node && \
    usermod -l quorum -u ${HOST_UID} -g ${HOST_GID} -d /home/quorum -m -s /bin/bash node
```

`COPY --chown=quorum:quorum` resolves by name (not uid), so it adapts automatically once the user exists with the correct uid.

#### 2. docker-compose.yml — build args + tmpfs alignment

All 5 services pass `HOST_UID`/`HOST_GID` as build args with a 1000 fallback:

```yaml
build:
  args:
    HOST_UID: ${HOST_UID:-1000}
    HOST_GID: ${HOST_GID:-1000}
```

The `x-agent-security` anchor's tmpfs mounts use the same env vars instead of hardcoded 1000:

```yaml
tmpfs:
  - /tmp:size=512m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
  - /home/quorum/.claude:size=256m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
  - /home/quorum/.config:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
  - /home/quorum/.local:size=64m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
  - /home/quorum/.cache:size=128m,uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}
```

#### 3. scripts/start.sh — automated startup

New convenience script that exports the host user's uid/gid and runs the full build+up cycle:

```bash
#!/usr/bin/env bash
set -euo pipefail

export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"

echo "Building with HOST_UID=$HOST_UID, HOST_GID=$HOST_GID"

docker compose build "$@"
docker compose up "$@"
```

Extra args are forwarded to both commands (e.g. `./scripts/start.sh -d` for detached mode).

### Verification

Tested on host with uid 1002 (`ia64_corp`). Log files from the latest run are correctly owned:

```
-rw-r--r-- ia64_corp ia64_corp architect-20260310T005154.jsonl
-rw-r--r-- ia64_corp ia64_corp developer-20260310T005154.jsonl
-rw-r--r-- ia64_corp ia64_corp teamlead-20260310T005154.jsonl
-rw-r--r-- ia64_corp ia64_corp unknown-20260310T005149.jsonl
-rw-r--r-- ia64_corp ia64_corp unknown-20260310T005154.jsonl
```

All agents wrote logs without `chmod 1777`. Previous log files from older runs (owned by `root` or uid 1000) remain untouched — logs rotate by timestamp so ownership mismatch on stale files is harmless.

### Notes

- **Default of 1000** — most single-user Linux systems use uid 1000, so omitting the env vars preserves backward compatibility.
- **Existing log files** — old files owned by root or uid 1000 won't be writable by a different uid, but this is fine since each container run creates new timestamped log files.

## Acceptance Criteria

- [x] Dockerfile accepts `HOST_UID` and `HOST_GID` build args (default 1000)
- [x] Agent and default stages create the `quorum` user with the provided uid/gid
- [x] `docker-compose.yml` passes `HOST_UID`/`HOST_GID` from environment with 1000 fallback
- [x] tmpfs `uid`/`gid` values align with the build args
- [x] Agent containers can write to `./logs:/app/logs` without manual `chmod`
- [x] `npm run test` passes with no regressions

## Dependencies and References

### Prerequisites
- None — standalone fix

### What This Blocks
- Nothing directly, but improves reliability for all bind-mounted volumes

### References
- QRM2-BUG-002 — discovered during log investigation
- [tickets/QRM2-001-docker-agent-image.md](QRM2-001-docker-agent-image.md) — original container setup
- `Dockerfile` — `default` stage (lines 15-37), `agent` stage (lines 39-68)
- `docker-compose.yml` — `x-agent-security` anchor (lines 9-20), build args on all services
- `scripts/start.sh` — automated startup with HOST_UID/HOST_GID export