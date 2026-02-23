ARG APP_NAME

FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG APP_NAME
RUN npx nest build ${APP_NAME}

FROM node:24-alpine

WORKDIR /app

ARG APP_NAME
COPY --from=builder /app/dist/apps/${APP_NAME} ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production

CMD ["node", "dist/main.js"]