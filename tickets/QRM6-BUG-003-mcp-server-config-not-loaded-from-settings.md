# QRM6-BUG-003: Moderator MCP Server Config Not Loaded From `settings.json`

**Status: Implemented** — fixed in commit 1f1bdb5

## Summary

QRM6-002 bakes the moderator's MCP server configuration into `~/.claude/settings.json` under a `mcpServers` key, with `"type": "url"`. Claude Code CLI 2.1.117 does not load MCP server definitions from `settings.json` — it expects them in `~/.claude.json` (user scope) or a `.mcp.json` file (project/local scope). As a result, `claude mcp list` reports "No MCP servers configured", the moderator's CC CLI session sees zero Quorum MCP tools, and `register_agent` / `new_conversation` / `invoke_agent` are all unavailable. The moderator boots but cannot orchestrate anything — QRM6 is non-functional out of the box.

A secondary issue: even in the formats that CC CLI *does* read, the correct transport `type` for a Streamable HTTP endpoint is `"http"`, not `"url"`. Both the location and the `type` string need to be corrected.

## Problem Statement

Reproduction (after `./scripts/start.sh`):

```
$ docker compose exec moderator claude mcp list
No MCP servers configured. Use `claude mcp add` to add a server.

$ docker compose exec moderator claude -p --permission-mode bypassPermissions \
    "List your available MCP tools and then call register_agent with role='moderator'."
... I cannot call register_agent because the Quorum MCP server is not connected
to this Claude Code session. ...
```

Meanwhile the MCP server itself is reachable from inside the moderator container:

```
$ docker compose exec moderator curl -sS -X POST http://mcp-server:3000/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
event: message
data: {"result":{"protocolVersion":"2024-11-05",...}}
```

The network path and the MCP server are fine. The problem is that CC CLI never *tries* to connect — it never sees a server in its config.

Workaround that confirms the diagnosis:

```
$ docker compose exec moderator claude mcp add quorum \
    --scope user --transport http http://mcp-server:3000/mcp
Added HTTP MCP server quorum with URL: http://mcp-server:3000/mcp to user config
File modified: /home/quorum/.claude.json
$ docker compose exec moderator claude mcp list
quorum: http://mcp-server:3000/mcp (HTTP) - ✓ Connected
```

After this, `register_agent` works and the full QRM6 stack is operational. But this fix is ephemeral — `~/.claude.json` lives in the moderator's writable area (a symlink to `/tmp/.claude.json` in the current image), and the entrypoint does not seed it, so the config is lost on every container restart or rebuild.

This blocks every live-LLM scenario in the QRM6-008 playbook (scenarios 2–7) and effectively blocks the QRM6 milestone.

### Root cause

Two compounding mistakes in `docker/moderator/settings.json`:

1. **Wrong location.** CC CLI's configuration layering for MCP servers is documented at [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp): user-scope in `~/.claude.json`, project-scope in `.mcp.json` (CWD-resolved). `~/.claude/settings.json` is not one of the files CC CLI consults for `mcpServers`. Putting the block there silently does nothing.
2. **Wrong `type` value.** Even in the formats CC CLI does read, the Streamable HTTP transport is keyed `"type": "http"`. `"type": "url"` is not a recognized transport and would be rejected by schema validation if it ever reached the loader.

QRM6-002 verified the baked settings were present inside the container (`cat /home/quorum/.claude/settings.json` returns the expected JSON) but did not verify that CC CLI actually *sees* the MCP server. The file-exists check was mistaken for a functional check.

## Design Context

CC CLI's MCP configuration model (v2.1.117):

| Scope | File | Survives | Visible to |
|-------|------|----------|------------|
| Enterprise | `/etc/claude-code/mcp.json` | System | All users |
| User | `~/.claude.json` | User restarts | All sessions for this user |
| Project | `.mcp.json` at repo root | Committed to repo | Any session with that CWD |
| Local | `.claude/.mcp.json` | Machine-local override | Only this machine's sessions |

`~/.claude/settings.json` holds **permission** and **preference** settings (deny/allow lists, `defaultMode`, `systemPrompt`, etc.) but not MCP server definitions. That is why the existing `permissions.deny` block is honored (verified — `Write`/`Edit`/`NotebookEdit` *are* blocked) while `mcpServers` is ignored.

For a containerized, image-baked configuration that should not require human setup, the fitting scope is either:

- **User-scope** — seed `~/.claude.json` in the entrypoint. Pros: matches `claude mcp add --scope user`; isolated per container; matches the moderator-as-a-user mental model. Cons: `~/.claude.json` also holds other user state, so we must merge-write, not overwrite blindly.
- **Project-scope** — write `.mcp.json` into `/mnt/quorum/workspace`. Pros: simple flat file, no merge concerns. Cons: leaks the moderator's Docker-network URL into the workspace (which is bind-mounted from the host), pollutes the repo, and confuses host-side CC sessions that would suddenly see a `quorum` MCP server pointing at `http://mcp-server:3000/mcp` — unreachable from outside the Docker network.

User-scope is the right choice. The entrypoint already seeds `~/.claude/settings.json`; extending it to also seed `~/.claude.json` is the natural fix.

## Implementation Details

### Change 1 — Strip `mcpServers` from `settings.json`

`docker/moderator/settings.json` no longer carries MCP server info. It keeps what CC CLI actually reads from that file:

```json
{
  "permissions": { "deny": ["Write", "Edit", "NotebookEdit"] },
  "systemPrompt": "..."
}
```

### Change 2 — Bake a `.claude.json` template with the MCP server

Add a new file `docker/moderator/claude.json` containing the user-scope MCP definition:

```json
{
  "mcpServers": {
    "quorum": {
      "type": "http",
      "url": "__MCP_SERVER_URL__"
    }
  }
}
```

Note `type: "http"` (not `"url"`), matching CC CLI's documented schema.

### Change 3 — Dockerfile: copy the template

Add to the moderator target (next to the existing `settings.json` copy at `Dockerfile:102`):

```dockerfile
COPY --chown=quorum:quorum docker/moderator/claude.json /etc/claude/claude.json
```

### Change 4 — Entrypoint: seed `~/.claude.json` with substitution

Extend `docker/moderator/entrypoint.sh`:

```bash
cp /etc/claude/claude.json /home/quorum/.claude.json
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /home/quorum/.claude.json
```

The file path must actually resolve to `/home/quorum/.claude.json`. In the current image, `/home/quorum/.claude.json` is a symlink to `/tmp/.claude.json` — verify this during the fix. If the symlink is intentional (for writability under read-only rootfs), write through it: `cp /etc/claude/claude.json /home/quorum/.claude.json` will follow the symlink and land at `/tmp/.claude.json`, which is what `claude mcp list` reads. If the symlink was an artifact, replace it with a real file at `/home/quorum/.claude.json`.

### Change 5 — Verify with `claude mcp list`

Add to the entrypoint (or a health-check script) a self-verification step that confirms the MCP server registered correctly before the container becomes "ready":

```bash
# Emit a clear failure rather than silently idling with no tools
if ! claude mcp list 2>&1 | grep -q "quorum:"; then
  echo "FATAL: Quorum MCP server not registered in CC CLI config" >&2
  exit 1
fi
```

This keeps the BUG-003 class of failure from recurring silently.

### Merge safety (if `~/.claude.json` ever contains other user state)

In the current container image, `~/.claude.json` is container-only (not persisted by default; depends on BUG-001 volume resolution). Overwriting is safe. If a future ticket makes `~/.claude.json` part of the `moderator-claude-data` named volume (QRM6-BUG-001 proposes persisting `~/.claude` only, so `~/.claude.json` stays ephemeral — verify), the entrypoint's plain overwrite is correct. If it ever needs to merge with user-added config, switch to `jq --argjson` to deep-merge. Not needed on day one.

### Cleanup

Audit `docker/moderator/settings.json` for any other fields CC CLI ignores — `"type": "url"` was a symptom of the broader location mistake and is not the only possible typo. Sanity-check each field against the current CC CLI settings schema.

## Acceptance Criteria

- [ ] `docker/moderator/settings.json` contains only `permissions` and `systemPrompt` (no `mcpServers`)
- [ ] `docker/moderator/claude.json` exists and contains the `mcpServers.quorum` entry with `"type": "http"`
- [ ] `Dockerfile` moderator target copies `docker/moderator/claude.json` to `/etc/claude/claude.json`
- [ ] `docker/moderator/entrypoint.sh` seeds `~/.claude.json` from `/etc/claude/claude.json` and substitutes `__MCP_SERVER_URL__`
- [ ] After `./scripts/start.sh`: `docker compose exec moderator claude mcp list` shows `quorum: http://mcp-server:3000/mcp (HTTP) - ✓ Connected` — **no manual `claude mcp add` required**
- [ ] `docker compose exec moderator claude -p --permission-mode bypassPermissions "Call register_agent(role='moderator'), then reply REG_OK"` returns `REG_OK`, and `curl -s http://localhost:3000/registry | jq .` shows `moderator` connected
- [ ] `docker compose logs mcp-server` shows `Agent moderator registered via MCP elicitation (session-bound)` — not `registered at http://...` (confirms QRM6-003 path, ties into BUG-004)
- [ ] After `docker compose restart moderator`, `claude mcp list` still shows the server registered (entrypoint re-seeds on every start)
- [ ] `npm run build`, `npm run lint`, `npm run test` pass (no regressions)
- [ ] QRM6-008 playbook scenarios 2 (elicitation registration) and 3 (new_conversation auto-injection) pass without any manual MCP config step

## Dependencies and References

### Prerequisites
- QRM6-002 — Moderator Container Image (introduced the misplaced/mistyped `mcpServers` block)
- QRM6-BUG-001 — Moderator `.claude` mount conflict (fixed first; BUG-003's entrypoint change assumes a working `~/.claude` layout)

### What This Blocks
- QRM6-008 — Playbook E2E test (scenarios 2–7 require a functional MCP tool surface on the moderator)
- QRM6-BUG-004 — Elicitation round-trip bug cannot be observed until BUG-003 is fixed and the moderator can actually call `invoke_agent`

### References
- [CC CLI MCP docs](https://code.claude.com/docs/en/mcp) — configuration scopes and transport schema (`type: http` for Streamable HTTP)
- `docker/moderator/settings.json` — current (broken) location of `mcpServers`
- `docker/moderator/entrypoint.sh:8–14` — existing seed + substitution pattern to extend
- `tickets/QRM6-002-moderator-container-image.md` — ticket that introduced the bug; acceptance criteria should be amended to include `claude mcp list` verification so the next round catches this class of defect
- **Discovered during:** QRM6-008 playbook run 2026-04-24 — scenario 2 blocked until `claude mcp add --scope user` was run manually inside the container