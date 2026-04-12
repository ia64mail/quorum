# QRM4-BUG-004: Git Identity Not Configured in Agent Containers

## Summary

Agent containers have no git author/committer identity configured, causing the first `git commit` attempt to fail with "Author identity unknown." Agents self-recover by running `git config`, but this wastes 2+ LLM turns and tokens on every session that commits.

## Problem Statement

When an agent runs `git commit` inside a container, git requires `user.name` and `user.email` to be set. These are not configured in the agent Docker image or compose environment. The agent must discover the error and self-recover by running `git config user.name` and `git config user.email` before retrying.

**Observed behavior (QRM4 kick-off session, 2026-03-28):**

```
01:52:06  teamlead  !! git commit fails: "Author identity unknown"
01:52:09  teamlead     Self-recovers: sets git config, stages + commits
01:52:13  teamlead     Commit succeeds (be3c05e)
```

While the agent recovered, it wasted 2 turns and tokens on a problem that should never occur. Every agent session that needs to commit will hit this same error on the first attempt.

**Root cause:** No `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, or `GIT_COMMITTER_EMAIL` environment variables are set in `docker-compose.yml` for agent services.

## Implementation Details

Add git identity environment variables to the shared env anchor (`x-shared-env`) in `docker-compose.yml`:

```yaml
x-shared-env: &shared-env
  # ... existing vars ...
  GIT_AUTHOR_NAME: Quorum Agent
  GIT_AUTHOR_EMAIL: quorum-agent@noreply.local
  GIT_COMMITTER_NAME: Quorum Agent
  GIT_COMMITTER_EMAIL: quorum-agent@noreply.local
```

Using environment variables rather than `git config --global` avoids:
- Writing to `~/.gitconfig` (which would require a writable location on the read-only rootfs)
- Per-role Dockerfile modifications
- Agents overriding the identity mid-session

The identity is intentionally generic ("Quorum Agent") — individual commits are attributable via the ticket ID and session logs, not the git author. If per-role attribution is desired later (e.g., "Quorum Developer"), this can be moved to per-service `environment` blocks with `GIT_AUTHOR_NAME: "Quorum ${AGENT_ROLE}"`.

## Acceptance Criteria

- [ ] `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` are set in `docker-compose.yml` for all agent services
- [ ] After rebuild, `git commit` succeeds on first attempt without agents needing to run `git config`
- [ ] Terminal and MCP server services are unaffected (they don't commit)
- [ ] Commit metadata shows the configured identity

## Dependencies and References

- Discovered during [QRM4 kick-off session](../logs/sessions/2026-03-28-qrm4-kickoff.md) — Issue #3
- `docker-compose.yml` — `x-shared-env` anchor and agent service definitions
- QRM1-011 (Docker Containerization) — original container setup