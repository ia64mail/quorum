ARG APP_NAME

FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG APP_NAME
RUN npx nest build ${APP_NAME}

# --- Runtime: default (mcp-server, terminal) ---
FROM node:24-alpine AS default

WORKDIR /app

ARG HOST_UID=1000
ARG HOST_GID=1000

# Alpine has no groupmod/usermod — delete default `node` user and create `quorum` from scratch
RUN deluser node && delgroup node 2>/dev/null; \
    addgroup -g ${HOST_GID} quorum && adduser -u ${HOST_UID} -G quorum -s /bin/sh -D quorum

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

RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude/debug \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude \
 && ln -s /tmp/.claude.json /home/quorum/.claude.json

ENV PATH="/mnt/quorum/workspace/node_modules/.bin:$PATH"

USER quorum

CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]
