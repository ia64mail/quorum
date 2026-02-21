import { NestFactory } from '@nestjs/core';
import { LoggerBuilder } from '@app/common';
import { TerminalConfigService } from './config';
import { McpClientService } from './connection';
import { ChatService } from './chat';
import { TerminalModule } from './terminal.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(TerminalModule, { logger });
  app.enableShutdownHooks();

  const config = app.get(TerminalConfigService);
  await app.listen(config.app.port);

  const mcpClient = app.get(McpClientService);
  await mcpClient.connectAndRegister();

  const chat = app.get(ChatService);
  await chat.start();

  await app.close();
}
void bootstrap();
