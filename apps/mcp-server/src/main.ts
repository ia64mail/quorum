import { NestFactory } from '@nestjs/core';
import { McpServerConfigService } from './config';
import { McpServerModule } from './mcp-server.module';

async function bootstrap() {
  const app = await NestFactory.create(McpServerModule);
  const config = app.get(McpServerConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
