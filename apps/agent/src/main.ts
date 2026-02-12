import { NestFactory } from '@nestjs/core';
import { LoggerBuilder } from '@app/common';
import { AgentConfigService } from './config';
import { AgentModule } from './agent.module';

async function bootstrap() {
  const logger = LoggerBuilder.fromEnv();
  const app = await NestFactory.create(AgentModule, { logger });
  const config = app.get(AgentConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
