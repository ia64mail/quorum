ARG APP_NAME

FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG APP_NAME
RUN npx nest build ${APP_NAME}

# --- Runtime: default (mcp-server) ---
FROM node:24-bookworm-slim AS default

WORKDIR /app

ARG HOST_UID=1000
ARG HOST_GID=1000

# Bookworm ships groupmod/usermod — rename default `node` user and adjust uid/gid to match host
RUN groupmod -n quorum -g ${HOST_GID} node && \
    usermod -l quorum -u ${HOST_UID} -g ${HOST_GID} -d /home/quorum -m -s /bin/bash node

ARG APP_NAME
COPY --from=builder --chown=quorum:quorum /app/dist/apps/${APP_NAME} ./dist
COPY --from=builder --chown=quorum:quorum /app/node_modules ./node_modules
COPY --from=builder --chown=quorum:quorum /app/package*.json ./

RUN mkdir -p /app/logs && chown quorum:quorum /app/logs

ENV NODE_ENV=production

USER quorum

CMD ["node", "dist/main.js"]

# --- Runtime: agent (Claude Code toolchain + hardening) ---
FROM node:24-bookworm-slim AS agent

WORKDIR /app

ARG HOST_UID=1000
ARG HOST_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash ripgrep curl jq openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bookworm ships groupmod/usermod — rename default `node` user and adjust uid/gid to match host
RUN groupmod -n quorum -g ${HOST_GID} node && \
    usermod -l quorum -u ${HOST_UID} -g ${HOST_GID} -d /home/quorum -m -s /bin/bash node

ARG APP_NAME
COPY --from=builder --chown=quorum:quorum /app/dist/apps/${APP_NAME} ./dist
COPY --from=builder --chown=quorum:quorum /app/node_modules ./node_modules
COPY --from=builder --chown=quorum:quorum /app/package*.json ./

# QRM6-BUG-012 follow-up: npm's libc filter doesn't reliably skip the musl
# variants of @anthropic-ai/claude-agent-sdk-linux-*-musl on glibc systems —
# both variants land in node_modules. The SDK's binary picker (function `N7`
# in sdk.mjs) tries `-musl` FIRST with no libc detection, so on this Debian
# runtime it picks the musl binary and exec fails (missing musl loader).
# Removing the wrong-libc variants forces the picker through to the glibc
# package that this image can actually execute.
RUN rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude/debug \
    /mnt/quorum/workspace/.claude/plugins \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude \
    /mnt/quorum/workspace/.claude \
 && ln -s /tmp/.claude.json /home/quorum/.claude.json

# Vendor code-review plugin (read-only rootfs prevents runtime installs).
# Source: https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review
COPY --chown=quorum:quorum docker/plugins/code-review /mnt/quorum/workspace/.claude/plugins/code-review

ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"

USER quorum

CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]

# --- Runtime: moderator (Claude Code CLI + MCP client config) ---
FROM node:24-bookworm-slim AS moderator

WORKDIR /app

ARG HOST_UID=1000
ARG HOST_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash ripgrep curl jq openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bookworm ships groupmod/usermod — rename default `node` user and adjust uid/gid to match host
RUN groupmod -n quorum -g ${HOST_GID} node && \
    usermod -l quorum -u ${HOST_UID} -g ${HOST_GID} -d /home/quorum -m -s /bin/bash node

# Install Claude Code CLI globally (pinned version from QRM6-001 spike)
RUN npm install -g @anthropic-ai/claude-code@2.1.117

RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude \
    /mnt/quorum/workspace/.claude /etc/claude \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude \
    /mnt/quorum/workspace/.claude /etc/claude \
 && ln -s /home/quorum/.claude/_claude.json /home/quorum/.claude.json

# Bake settings template and moderator prompt into a read-only path; entrypoint copies them to tmpfs at runtime.
# claude.json holds the mcpServers block — CC CLI reads it from ~/.claude.json (user scope), not settings.json.
COPY --chown=quorum:quorum docker/moderator/settings.json /etc/claude/settings.json
COPY --chown=quorum:quorum docker/moderator/claude.json /etc/claude/claude.json
COPY --chown=quorum:quorum docker/moderator/CLAUDE.md /etc/claude/CLAUDE.md
COPY --chown=quorum:quorum docker/moderator/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER quorum

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
