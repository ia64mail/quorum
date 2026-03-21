import { Module } from '@nestjs/common';
import { TerminalConfigModule } from './config';
import { ClarificationModule } from './clarification';
import { ChatModule } from './chat';

@Module({
  imports: [TerminalConfigModule, ClarificationModule, ChatModule],
})
export class TerminalModule {}
