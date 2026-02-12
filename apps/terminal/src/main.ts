import { NestFactory } from '@nestjs/core';
import { LoggerBuilder } from '@app/common';
import { TerminalConfigService } from './config';
import { TerminalModule } from './terminal.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(TerminalModule, { logger });
  const config = app.get(TerminalConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
