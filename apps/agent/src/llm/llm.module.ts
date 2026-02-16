import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { AnthropicService } from './anthropic.service';

@Module({
  imports: [AgentConfigModule],
  providers: [AnthropicService],
  exports: [AnthropicService],
})
export class LlmModule {}
