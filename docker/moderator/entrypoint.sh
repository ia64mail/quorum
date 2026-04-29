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

# CC CLI reads `mcpServers` from ~/.claude.json (user scope), not from
# ~/.claude/settings.json. /home/quorum/.claude.json is a symlink to
# /tmp/.claude.json (writable tmpfs under read-only rootfs). Write to the
# symlink target directly — GNU cp refuses to write through a dangling
# symlink, and /tmp tmpfs is fresh on every container start.
cp /etc/claude/claude.json /tmp/.claude.json

# Substitute MCP server URL at runtime (allows override via env var).
# Default: http://mcp-server:3000/mcp (Docker Compose service name).
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /tmp/.claude.json

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