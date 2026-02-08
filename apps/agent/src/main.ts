import { NestFactory } from '@nestjs/core';
import { AgentConfigService } from './config';
import { AgentModule } from './agent.module';

async function bootstrap() {
  const app = await NestFactory.create(AgentModule);
  const config = app.get(AgentConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
