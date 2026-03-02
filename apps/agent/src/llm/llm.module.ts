import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { AnthropicService } from './anthropic.service';
import { ClaudeCodeService } from './claude-code.service';

@Module({
  imports: [AgentConfigModule],
  providers: [AnthropicService, ClaudeCodeService],
  exports: [AnthropicService, ClaudeCodeService],
})
export class LlmModule {}
