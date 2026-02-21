import { Module } from '@nestjs/common';
import { TerminalConfigModule } from '../config';
import { AnthropicService } from './anthropic.service';

@Module({
  imports: [TerminalConfigModule],
  providers: [AnthropicService],
  exports: [AnthropicService],
})
export class LlmModule {}
