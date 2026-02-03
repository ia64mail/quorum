import { NestFactory } from '@nestjs/core';
import { McpServerModule } from './mcp-server.module';

async function bootstrap() {
  const app = await NestFactory.create(McpServerModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
