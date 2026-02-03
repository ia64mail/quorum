FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build agent

FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/dist/apps/agent ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production
ENV AGENT_ROLE=developer

EXPOSE 3002

CMD ["node", "dist/main.js"]