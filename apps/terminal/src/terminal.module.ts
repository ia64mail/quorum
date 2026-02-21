import { Module } from '@nestjs/common';
import { TerminalConfigModule } from './config';
import { ChatModule } from './chat';

@Module({
  imports: [TerminalConfigModule, ChatModule],
})
export class TerminalModule {}
