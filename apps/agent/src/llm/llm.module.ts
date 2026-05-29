import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { AnthropicService } from './anthropic.service';
import { ClaudeCodeService } from './claude-code.service';
import { FileSessionStore } from './file-session-store';

@Module({
  imports: [AgentConfigModule],
  providers: [
    AnthropicService,
    ClaudeCodeService,
    {
      provide: FileSessionStore,
      useFactory: () => new FileSessionStore('/var/agent-sessions/'),
    },
  ],
  exports: [AnthropicService, ClaudeCodeService],
})
export class LlmModule {}
