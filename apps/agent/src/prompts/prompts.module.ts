import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { RolePromptService } from './role-prompt.service';

@Module({
  imports: [AgentConfigModule],
  providers: [RolePromptService],
  exports: [RolePromptService],
})
export class PromptsModule {}
