import { Module } from '@nestjs/common';
import { ConnectionModule } from '../connection';
import { LlmModule } from '../llm';
import { ChatService } from './chat.service';

@Module({
  imports: [ConnectionModule, LlmModule],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
