import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { LoggerBuilder } from '@app/common';
import { McpServerConfigService } from './config';
import { McpServerModule } from './mcp-server.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(McpServerModule, { logger });
  app.enableShutdownHooks();
  const config = app.get(McpServerConfigService);

  // QRM5-BUG-003: defence-in-depth. Node's http.Server defaults both
  // `requestTimeout` and `headersTimeout` to 300s — these apply to slow
  // *incoming* request bodies, not slow responses, so they are NOT the
  // actual cause of long-call stalls (the real fix is client-side undici
  // `bodyTimeout`; see apps/agent/src/connection/mcp-client.service.ts).
  // Raising them anyway so the client-side AbortController remains the sole
  // timeout authority across the whole stack, matching the outgoing-side
  // pattern in apps/mcp-server/src/registry/http-agent-connection.ts.
  const clientTimeoutMs =
    Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 1_800_000;
  const serverTimeoutMs = clientTimeoutMs + 5 * 60_000;
  const httpServer = app.getHttpServer() as Server;
  httpServer.requestTimeout = serverTimeoutMs;
  httpServer.headersTimeout = serverTimeoutMs;

  // QRM6-BUG-011 Fix #3: enable TCP keepalive on every incoming connection.
  // When a flow goes truly dead (route flap, container restart, conntrack
  // eviction), the kernel detects the dead socket within ~30s instead of
  // leaving a zombie ESTABLISHED connection.
  httpServer.on('connection', (socket) => {
    socket.setKeepAlive(true, 30_000);
  });

  await app.listen(config.app.port);
}
void bootstrap();
