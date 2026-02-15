import { NestFactory } from '@nestjs/core';
import { LoggerBuilder } from '@app/common';
import { AgentConfigService } from './config';
import { McpClientService } from './connection';
import { AgentModule } from './agent.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(AgentModule, { logger });
  app.enableShutdownHooks();

  const config = app.get(AgentConfigService);
  await app.listen(config.app.port);

  // Connect to MCP server and register AFTER app is listening
  const mcpClient = app.get(McpClientService);
  await mcpClient.connectAndRegister();
}
void bootstrap();
