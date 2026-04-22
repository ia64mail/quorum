#!/usr/bin/env bash
set -euo pipefail

# Copy baked settings template into the writable tmpfs home directory.
# The read_only rootfs + tmpfs overlay on /home/quorum/.claude means the
# build-time COPY is invisible at runtime — this entrypoint restores it.
cp /etc/claude/settings.json /home/quorum/.claude/settings.json

# Substitute MCP server URL at runtime (allows override via env var).
# Default: http://mcp-server:3000/mcp (Docker Compose service name).
MCP_SERVER_URL="${MCP_SERVER_URL:-http://mcp-server:3000/mcp}"
sed -i "s|__MCP_SERVER_URL__|${MCP_SERVER_URL}|g" /home/quorum/.claude/settings.json

# Idle — the user attaches via `docker compose exec -it moderator claude`.
exec tail -f /dev/null
