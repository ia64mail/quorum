import { NestFactory } from '@nestjs/core';
import { TerminalModule } from './terminal.module';

async function bootstrap() {
  const app = await NestFactory.create(TerminalModule);
  await app.listen(process.env.port ?? 3000);
}
void bootstrap();
