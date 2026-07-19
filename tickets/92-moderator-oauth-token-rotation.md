# #92: Moderator forced re-login — stale CLAUDE_CODE_OAUTH_TOKEN shadows fresh /login credentials

## Summary

The moderator's Claude Code CLI intermittently forces an interactive `/login`, roughly daily since ~2026-07-13, despite a valid-looking `CLAUDE_CODE_OAUTH_TOKEN` present in `.env` and reaching the `claude` process. Root cause: in the pinned Claude Code CLI version the env OAuth token outranks the `/login` credentials file, so once the env token goes stale it 401s every session and suppresses the fresh credentials each re-login writes. Resolution is an operational token rotation; **no code change**.

## Problem Statement

- **Symptom:** recurring forced `/login`; each login fails to "stick" across sessions. Evidence from moderator transcripts: forced-login events ~none from 2026-06-19 → 07-12, then near-daily from 2026-07-13 onward.
- **Auth precedence:** cloud creds → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → **`CLAUDE_CODE_OAUTH_TOKEN` (env)** → **`/login` file creds (`~/.claude/.credentials.json`)**. The env token wins over the file.
- **Failure loop:** stale env token is tried first → 401 → `/login` prompt → `/login` writes a fresh `~/.claude/.credentials.json`, but the next session again prefers the stale env token → 401 again. Upstream footgun: [anthropics/claude-code#16238](https://github.com/anthropics/claude-code/issues/16238) ("old OAuth token in env silently overrides fresh valid credentials file").
- **Ruled out:** the hypothesis that a CC CLI version bump moved the credential location or made it read-only — wrong regardless of version. The running moderator container is on Claude Code CLI **2.1.207**, confirmed via `claude --version` inside the container. The upgrade is real: #68 (commit `3c26b8c`, 2026-07-13, "bump claude-agent-sdk to 0.3.207, claude-code CLI to 2.1.207, default model to Opus 4.8") bumped the CLI 2.1.126 → 2.1.207 and lives on the QRM9 feature-branch line; it is simply not yet merged to `main` — `origin/main:Dockerfile:128` still pins `@anthropic-ai/claude-code@2.1.126`, which is why checking against `main` alone doesn't show it. On either version, the credential file is at the unchanged path `~/.claude/.credentials.json`, on the persistent `moderator-claude-data` named volume (`docker-compose.yml:178`, mounted at `/home/quorum/.claude`) — writable, and unaffected by the container's `read_only: true` rootfs (`x-base-security`, `docker-compose.yml:20-30`) because the named volume is a distinct mount. `CLAUDE_CONFIG_DIR` is unset anywhere in the compose file, entrypoint, or Dockerfile (defaults to `~/.claude`). No credential/keyring material lands on the tmpfs `~/.config`/`~/.local`/`~/.cache` mounts (`docker-compose.yml:27-30`) — those are unrelated to the CLI's auth storage. The #68 upgrade date (2026-07-13) coincides closely with the onset of the daily forced-login symptom, but is most likely **coincidental timing, not causal** — the env-token-over-`/login`-file auth precedence this ticket describes is unchanged across the 2.1.x line, on both sides of #68.
- **Diagnostic note worth capturing:** the token is present in container PID 1 and in the `claude` process env (wired at `docker-compose.yml:172`, moderator `environment:` block), but is deliberately scrubbed from Bash-tool subprocesses by the CLI — so `echo $CLAUDE_CODE_OAUTH_TOKEN` from a Bash tool shows empty even though auth has it. Do not mistake that scrub for the token being unset.

## Diagnosis Evidence (for the record)

Summarize the investigation chain: `.env` has the token (`.env.example:13` documents `CLAUDE_CODE_OAUTH_TOKEN=`) → `docker-compose.yml:172` passes `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}` in the moderator service's `environment:` block (deliberately not part of `x-shared-env`, per #QRM7-007/QRM7-013) → present in PID 1 and the `claude` process (len ~108, `sk-ant-oat01…`) → yet a `/login` still fires at session start → therefore the env token is being rejected (stale/expired/revoked), not missing.

## Operational Rotation Runbook (no code enforcement)

This is a manual runbook. There is no code, config, or entrypoint change accompanying this ticket — the fix is operator action, repeated whenever the symptom recurs.

1. Issue a fresh token inside the running moderator:
   ```
   docker compose exec -it moderator claude setup-token
   ```
   → yields a new `sk-ant-oat01-…` token.
2. Replace the OLD value of `CLAUDE_CODE_OAUTH_TOKEN` in the host `.env` (ensure only ONE such line — a leftover stale duplicate re-poisons it).
3. Recreate the moderator so PID 1 and `claude` pick up the new token (a plain `restart` does not re-read `.env`):
   ```
   ./scripts/start.sh -d
   ```
4. Clear the stale `/login` file so only the fresh env token is in play:
   ```
   docker compose exec moderator rm -f /home/quorum/.claude/.credentials.json
   ```
5. Verify:
   ```
   docker compose exec -it moderator claude
   ```
   then `/status` — should report Claude.ai Max subscription auth with no `/login` prompt; confirm no recurrence over ~a day.

**Pre-rotation confirmation test** (optional, to prove the env token is the poison before rotating):
```
docker compose exec -it moderator env -u CLAUDE_CODE_OAUTH_TOKEN claude
```
then `/status` — if it authenticates cleanly with the env var unset, that proves the env token was the poison (falling back to the `/login` file creds, which are still valid).

## Acceptance Criteria

- [x] Ticket file exists at `tickets/92-moderator-oauth-token-rotation.md`, follows `tickets/README.md` structure
- [x] Runbook steps are complete, ordered, and correct (issue token → update `.env` → recreate container → clear stale credentials file → verify)
- [x] Root cause (env-token-over-file auth precedence, staleness, silent-shadow failure loop) and its evidence are documented
- [x] Ruled-out theory (CC CLI version bump moving/locking the credential path) is recorded, along with the corrected finding (moderator runtime is on 2.1.207 via #68 on the QRM9 line; `main` still pins 2.1.126 as of writing — the credential path and its persistence/writability are unchanged either way)
- [x] Explicit statement that this ticket carries **no code enforcement** — pure operational runbook
- [x] References to prior art (QRM7-013) and concrete files (docker-compose.yml, entrypoint.sh, settings.json, Dockerfile) included and line-verified against current repo state

## Dependencies and References

- [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md) — prior art. Established the `claude setup-token` mitigation for the *idle-refresh* 401 (auto-refresh across ≥10h hibernation gaps never working). This ticket documents a related but distinct failure mode: the token was working from 2026-06-19 through 2026-07-12, then started failing near-daily from 2026-07-13 — i.e. the *issued* token itself went stale/was revoked, and the env-over-file precedence turned that single staleness event into a persistent daily loop instead of a one-time re-login.
- `docker-compose.yml:160-179` — moderator service `environment:` and `volumes:` blocks; `CLAUDE_CODE_OAUTH_TOKEN` wiring (line 172) and the `moderator-claude-data` volume mount (line 178) where `.credentials.json` persists.
- `docker/moderator/entrypoint.sh` — does not touch `.credentials.json` directly; only merges `settings.json` and `_claude.json` (lines 14-22, 76-96). Confirms the credentials file is CC CLI-managed, outside entrypoint control.
- `docker/moderator/settings.json` — `forceLoginMethod: "claudeai"` (line 2), unchanged since QRM7-007.
- `Dockerfile:128` — on `origin/main`, still pins `@anthropic-ai/claude-code@2.1.126` (QRM6-001 spike pin). The moderator runtime this ticket describes is on 2.1.207 via #68 (commit `3c26b8c`), which lives on the QRM9 feature-branch line and has not yet merged to `main` — hence the discrepancy between the running container and `main`'s Dockerfile.
- `.env.example:8-13` — documents `CLAUDE_CODE_OAUTH_TOKEN` issuance via `claude setup-token`.
- [anthropics/claude-code#16238](https://github.com/anthropics/claude-code/issues/16238) — upstream report of the same env-token-shadows-fresh-file-creds behavior.
- [Claude Code Authentication docs](https://code.claude.com/docs/en/authentication) — auth precedence order.
