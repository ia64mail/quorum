# QRM7-007: Shift Moderator from API Key to Claude Subscription (OAuth) Auth

**Status: Draft**

## Summary

Move the moderator container off `ANTHROPIC_API_KEY` (Anthropic Console / org metered billing) onto the user's Claude.ai subscription credentials issued by `claude /login`. Agents continue to use the API key — they call the Anthropic API programmatically via the Claude Agent SDK, which subscription auth does not cover. The change is a docker-compose env tweak, an optional defense-in-depth setting in the baked moderator settings, and a one-time interactive `/login` inside the running container.

## Problem Statement

The moderator currently inherits the shared compose anchor at `docker-compose.yml:1-2`:

```yaml
x-shared-env: &shared-env
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

…via `<<: *shared-env` at `docker-compose.yml:150`. The moderator runs CC CLI 2.1.126, which selects auth in this order: `ANTHROPIC_API_KEY` env > stored OAuth credentials from `/login`. Even if a subscription token were already on the volume, the env var would win and the moderator would bill against the org's metered API quota.

The user now holds a Claude subscription and wants the moderator's interactive CC CLI session billed against the subscription seat (flat per-month) while the SDK-driven agents continue billing the org's API key (programmatic API access, which subscription seats do not grant). Both auth paths need to coexist within one compose project.

### Why precedence matters specifically

CC CLI's auth resolver doesn't ask the user — it picks silently. If `ANTHROPIC_API_KEY` is non-empty in the moderator's environment, even a successful `/login` is functionally a no-op for billing purposes. Setting `ANTHROPIC_API_KEY=""` does not help; the resolver treats "set to empty" as "set." The env var must be **absent** from the moderator's environment for the OAuth credentials to take effect.

## Design Context

### Why agents must stay on the API key

Agents run the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as a subprocess that talks to the Anthropic API directly with a key. Claude.ai subscription seats grant access to Claude.ai web + Claude Code CLI, not to the programmatic API. Subscription credentials cannot authenticate SDK API calls. Therefore the split is structural, not a preference:

| Component | Auth | Billing |
|---|---|---|
| Moderator (CC CLI session) | OAuth token from `/login` | Subscription seat (flat /month) |
| Agents — architect, teamlead, developer (SDK) | `ANTHROPIC_API_KEY` | Org metered billing on platform.claude.com |

### Why the shared compose anchor can be dropped from the moderator only

The `x-shared-env` anchor at `docker-compose.yml:1-2` contains exactly one variable: `ANTHROPIC_API_KEY`. Removing the moderator's `<<: *shared-env` line is therefore a complete change — there is no other shared environment surface to preserve for that service. Other agent services (`docker-compose.yml:173, 197, 221`) keep the anchor and continue to receive the key.

### Why the OAuth flow works in a no-browser container

CC CLI's `/login` uses a device-style flow: it prints a URL and a state parameter, the user opens the URL in their host browser, completes login on claude.ai, then pastes the resulting code back into the CLI prompt. There is no localhost callback, no host-network exposure, and no browser launch from inside the container. A one-time interactive run via `docker compose exec -it moderator claude` is sufficient.

### Why `forceLoginMethod` belt-and-suspenders is recommended

The env-removal alone is sufficient *today*. But:

1. The single-anchor structure is fragile — a future contributor could re-add `ANTHROPIC_API_KEY` to the moderator service without realizing the precedence consequence.
2. A `forceLoginMethod: "claudeai"` setting in `~/.claude/settings.json` declares the auth choice in version-controlled config, not implicitly via env-omission.
3. The cost is one JSON key and a verification check during implementation that the setting is honored by CC CLI 2.1.126.

If verification reveals the setting name has changed or is unsupported, fall back to env-removal alone — it remains correct.

### Why credentials persist without new volume work

`moderator-claude-data` is already mounted at `/home/quorum/.claude` (`docker-compose.yml:155`). CC CLI writes OAuth credentials to a file under that directory (`.credentials.json` in current versions; exact filename has shifted historically). The QRM6-BUG-009 Phase 2 persistence machinery (`~/.claude.json` → `_claude.json` symlink onto the same volume) covers the case where credentials are kept inside `~/.claude.json` instead. Either layout is captured by the existing volume — no new infrastructure required.

## Implementation Details

### Step 1: Drop the shared env anchor from the moderator service

Edit the moderator service's `environment:` block in `docker-compose.yml`. Remove the `<<: *shared-env` line; keep the explicit `MCP_SERVER_URL` line. Other services are unchanged.

After the edit, verify with `docker compose config | yq '.services.moderator.environment'` that `ANTHROPIC_API_KEY` is absent for the moderator and still present for agents.

### Step 2 (recommended): Bake `forceLoginMethod` into moderator settings

Add `"forceLoginMethod": "claudeai"` to `docker/moderator/settings.json` at the top level. The existing entrypoint merge logic (`docker/moderator/entrypoint.sh:14-22`, `jq -s '.[0] * .[1]'` with baked-wins-on-conflict) will propagate this key onto every container start. No entrypoint changes required.

If, during implementation, `claude /status` shows the setting is unrecognized or doesn't override the env-var precedence as expected, drop this step — Step 1 alone is sufficient.

### Step 3: One-time interactive `/login` inside the running moderator

After rebuilding and starting the stack:

```bash
./scripts/start.sh -d
docker compose exec -it moderator claude
# inside CC CLI:
/login
# Choose the manual / paste-code path if prompted.
# Open the printed URL in the host browser → complete login on claude.ai → copy the code → paste back.
```

The token is written to `~/.claude/` on the named volume. Subsequent `docker compose restart moderator` does not require re-login.

### Step 4: Verify the active auth source

Inside the moderator's CC CLI session run `/status` (or equivalent). Expected: subscription/Claude.ai auth reported, no API key mention. If `/status` still reports API-key auth, recheck Step 1 (env anchor really removed for the moderator service) and Step 2 (setting key recognized).

### Token refresh

OAuth tokens carry a refresh token; CC CLI handles renewal transparently as long as the container has outbound network access (it does — it already talks to claude.ai via the same network path used by agents reaching the Anthropic API). No cron, no manual refresh.

### Reverting

To shift back to API-key billing without losing the OAuth state:

1. Re-add `<<: *shared-env` under the moderator's `environment:` block.
2. (If Step 2 was applied) remove `forceLoginMethod` from `docker/moderator/settings.json`.

The OAuth credentials remain on the volume; the precedence resolver will simply prefer the API key again.

## Acceptance Criteria

- [ ] `docker-compose.yml` moderator service does not inherit `<<: *shared-env`; `MCP_SERVER_URL` is still set explicitly
- [ ] `docker compose config` confirms `ANTHROPIC_API_KEY` is absent from the moderator's resolved environment and present for `architect`, `teamlead`, `developer`
- [ ] (Recommended) `docker/moderator/settings.json` contains `"forceLoginMethod": "claudeai"`; the merged `~/.claude/settings.json` inside the running container reflects it
- [ ] After one-time `/login` inside the container, `claude /status` reports Claude.ai subscription auth (not API key)
- [ ] OAuth credentials survive `docker compose restart moderator` — no re-login required
- [ ] Agent containers continue to invoke the Anthropic API successfully via `ANTHROPIC_API_KEY` (smoke-test by triggering any `invoke_agent` call against architect/teamlead/developer)
- [ ] Moderator's `quorum:` MCP server registration still passes the entrypoint self-check (`claude mcp list` shows it)
- [ ] No new volumes added; `moderator-claude-data` continues to back `~/.claude/`

## Dependencies and References

### Prerequisites
- Active Claude.ai subscription seat for the user who will run `/login`
- Network egress from the moderator container to claude.ai (already in place)

### What This Blocks
- Nothing structural. Reduces org metered-API spend on moderator orchestration turns once shifted.

### Relationship to other QRM7 work
- **Independent of QRM7-004** (cwd relocation) — auth source and cwd are orthogonal concerns. Either can land first.
- **Independent of QRM7-003** — permission grant persistence is a settings-file location problem; auth source does not affect it.

### References
- `docker-compose.yml:1-2` — shared env anchor (single var: `ANTHROPIC_API_KEY`)
- `docker-compose.yml:149-155` — moderator service environment + volume mounts
- `docker-compose.yml:155` — `moderator-claude-data:/home/quorum/.claude` (already provides OAuth credential persistence)
- `docker/moderator/settings.json` — baked settings; entrypoint merges this into `~/.claude/settings.json` on every start
- `docker/moderator/entrypoint.sh:14-22` — `jq -s '.[0] * .[1]'` merge that propagates baked keys (including `forceLoginMethod` if added) over volume state
- `docker/moderator/entrypoint.sh:39-46` — `_claude.json` merge logic; baked file holds only `mcpServers`, so OAuth fields written into the volume's `_claude.json` are not overwritten by the merge
- [QRM6-BUG-009](QRM6-BUG-009-moderator-settings-overwrite-on-restart.md) — established the `~/.claude/` persistence pattern that this ticket reuses for OAuth credentials
- [docs/system-design.md](../docs/system-design.md) — moderator container vs agent container distinction (CC CLI vs Claude Agent SDK)