import { Module } from '@nestjs/common';
import { ConnectionModule } from '../connection';
import { LlmModule } from '../llm';
import { ClarificationModule } from '../clarification';
import { ChatService } from './chat.service';

@Module({
  imports: [ConnectionModule, LlmModule, ClarificationModule],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
