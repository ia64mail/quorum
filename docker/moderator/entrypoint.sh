#!/usr/bin/env bash
set -euo pipefail

# Restore baked config into the writable home directory (tmpfs in the agent profile,
# named volume in the moderator profile). The build-time COPY at /etc/claude/ is the
# source of truth.
#
# settings.json: If a file already exists in the volume (from a prior session), merge
# the baked keys over it so Quorum-controlled keys (permissions, systemPrompt) always
# update while CC CLI state (onboarding, theme, trust) survives. First boot (no
# existing file) seeds from the baked copy. Uses jq recursive merge (.[0] * .[1])
# with write-to-tmp-then-mv for atomicity — if jq fails, set -euo pipefail aborts
# before mv, leaving the existing file untouched.
if [ -f /home/quorum/.claude/settings.json ]; then
  jq -s '.[0] * .[1]' \
    /home/quorum/.claude/settings.json \
    /etc/claude/settings.json \
    > /tmp/merged-settings.json
  mv /tmp/merged-settings.json /home/quorum/.claude/settings.json
else
  cp /etc/claude/settings.json /home/quorum/.claude/settings.json
fi
cp /etc/claude/CLAUDE.md /home/quorum/.claude/CLAUDE.md

# Symlink workspace quorum.md into the moderator's user-scope ~/.claude dir
# so the `@quorum.md` directive at the top of CLAUDE.md resolves. The relative
# resolution looks alongside CLAUDE.md and the workspace file is only available
# via bind mount — this symlink bridges the two. ln -sf is idempotent and
# survives volume state from prior runs.
if [ ! -f /mnt/quorum/workspace/quorum.md ]; then
  echo "WARN: /mnt/quorum/workspace/quorum.md not found — @quorum.md will not resolve" >&2
fi
ln -sf /mnt/quorum/workspace/quorum.md /home/quorum/.claude/quorum.md

# Authenticate gh CLI with the PAT and configure git's credential helper,
# then strip the raw token from the env so the CC CLI session cannot
# exfiltrate it via $GH_TOKEN. The token persists on disk at
# ~/.config/gh/hosts.yml (tmpfs — re-created on each container start).
if [ -n "${GH_TOKEN:-}" ]; then
  # gh refuses to persist credentials while GH_TOKEN is in env (it treats the
  # env var as authoritative). Capture, unset, then pipe — otherwise gh exits
  # non-zero and `set -euo pipefail` aborts the entrypoint.
  _token="$GH_TOKEN"
  unset GH_TOKEN
  echo "$_token" | gh auth login --with-token
  unset _token
  gh auth setup-git          # configures git credential helper → gh
  echo "gh auth: logged in, credential helper configured, GH_TOKEN unset"
else
  echo "WARN: GH_TOKEN not set — gh CLI will not be authenticated" >&2
fi

# CC CLI reads `mcpServers` from ~/.claude.json (user scope), not from
# ~/.claude/settings.json. It also stores onboarding state, oauth tokens,
# and per-project tool permissions there. /home/quorum/.claude.json is a
# symlink to /home/quorum/.claude/_claude.json on the named volume so this
# state survives restarts. Apply the same merge pattern as settings.json:
# baked keys (mcpServers) win on every start; CC CLI state (onboarding,
# projects, oauth) survives. Write to the symlink target directly — GNU cp
# refuses to write through a dangling symlink (first boot: target absent).
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /etc/claude/claude.json \
  > /tmp/baked-claude.json

if [ -f /home/quorum/.claude/_claude.json ]; then
  jq -s '.[0] * .[1]' \
    /home/quorum/.claude/_claude.json \
    /tmp/baked-claude.json \
    > /tmp/merged-claude.json
  mv /tmp/merged-claude.json /home/quorum/.claude/_claude.json
else
  cp /tmp/baked-claude.json /home/quorum/.claude/_claude.json
fi

# Render the effective moderator prompt sources to stdout so `docker compose logs
# moderator` shows exactly what CC CLI auto-loads. Mirrors the agent-side container-
# start template log (RolePromptService.onModuleInit). Note: CC CLI applies its own
# recursive @-import resolution and may inject system messages internally — this
# dump reflects on-disk state after the entrypoint merge, not the byte-exact prompt
# the model receives.
echo "===== BEGIN moderator effective prompt ====="

echo "--- settings.json: systemPrompt ---"
jq -r '.systemPrompt // "(none)"' /home/quorum/.claude/settings.json

echo "--- settings.json: permissions ---"
jq '.permissions // {}' /home/quorum/.claude/settings.json

echo "--- ~/.claude/CLAUDE.md (user-scope) ---"
cat /home/quorum/.claude/CLAUDE.md
echo

echo "===== END moderator effective prompt ====="

# Self-verify: fail loudly if CC CLI doesn't see the Quorum MCP server.
# Catches the QRM6-BUG-003 class of defect (config file present but CLI ignores it)
# at startup instead of silently leaving the moderator with zero MCP tools.
if ! claude mcp list 2>&1 | grep -q "quorum:"; then
  echo "FATAL: Quorum MCP server not registered in CC CLI config" >&2
  echo "---- claude mcp list output ----" >&2
  claude mcp list >&2 || true
  echo "---- ~/.claude.json ----" >&2
  cat /home/quorum/.claude.json >&2 || true
  exit 1
fi

# Idle — the user attaches via `docker compose exec -it moderator claude`.
exec tail -f /dev/null