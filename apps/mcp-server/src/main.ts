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

  // QRM5-BUG-003: Node's http.Server.requestTimeout defaults to 300s (5 min)
  // and silently kills the response socket on longer requests, stalling any
  // tool handler that runs past 5 minutes. Raise past MCP_REQUEST_TIMEOUT_MS
  // (default 30 min, see libs/common/src/config/mcp.config.ts) so the
  // client-side AbortController remains the sole timeout authority — mirrors
  // the outgoing-side fix at apps/mcp-server/src/registry/http-agent-connection.ts.
  const clientTimeoutMs =
    Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 1_800_000;
  const serverTimeoutMs = clientTimeoutMs + 5 * 60_000;
  const httpServer = app.getHttpServer() as Server;
  httpServer.requestTimeout = serverTimeoutMs;
  httpServer.headersTimeout = serverTimeoutMs;

  await app.listen(config.app.port);
}
void bootstrap();
