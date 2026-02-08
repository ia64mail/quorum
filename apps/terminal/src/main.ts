import { NestFactory } from '@nestjs/core';
import { TerminalConfigService } from './config';
import { TerminalModule } from './terminal.module';

async function bootstrap() {
  const app = await NestFactory.create(TerminalModule);
  const config = app.get(TerminalConfigService);
  await app.listen(config.app.port);
}
void bootstrap();
