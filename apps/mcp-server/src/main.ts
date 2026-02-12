import { NestFactory } from '@nestjs/core';
import { LoggerBuilder } from '@app/common';
import { McpServerConfigService } from './config';
import { McpServerModule } from './mcp-server.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(McpServerModule, { logger });
  const config = app.get(McpServerConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
