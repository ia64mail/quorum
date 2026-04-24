#!/usr/bin/env bash
set -euo pipefail

# Copy baked config into the writable home directory (tmpfs in the agent profile,
# named volume in the moderator profile). The build-time COPY at /etc/claude/ is the
# source of truth — this entrypoint restores it so the latest baked prompt/settings
# always wins on container start.
cp /etc/claude/settings.json /home/quorum/.claude/settings.json
cp /etc/claude/CLAUDE.md /home/quorum/.claude/CLAUDE.md

# Substitute MCP server URL at runtime (allows override via env var).
# Default: http://mcp-server:3000/mcp (Docker Compose service name).
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /home/quorum/.claude/settings.json

# Idle — the user attaches via `docker compose exec -it moderator claude`.
exec tail -f /dev/null
