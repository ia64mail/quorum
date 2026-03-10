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

# Alpine has no groupmod/usermod — delete default `node` user and create `quorum` from scratch
RUN deluser node && delgroup node 2>/dev/null; \
    addgroup -g 1000 quorum && adduser -u 1000 -G quorum -s /bin/sh -D quorum

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

RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash ripgrep curl jq openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bookworm ships groupmod/usermod — rename default `node` user in-place
RUN groupmod -n quorum node && \
    usermod -l quorum -d /home/quorum -m -s /bin/bash node

ARG APP_NAME
COPY --from=builder --chown=quorum:quorum /app/dist/apps/${APP_NAME} ./dist
COPY --from=builder --chown=quorum:quorum /app/node_modules ./node_modules
COPY --from=builder --chown=quorum:quorum /app/package*.json ./

RUN mkdir -p /app/logs /tmp/.claude /home/quorum/.claude/debug \
 && chown -R quorum:quorum /app/logs /tmp/.claude /home/quorum/.claude \
 && ln -s /tmp/.claude.json /home/quorum/.claude.json

ENV NODE_ENV=production

USER quorum

CMD ["sh", "-c", "mkdir -p /home/quorum/.claude/debug && exec node dist/main.js"]
