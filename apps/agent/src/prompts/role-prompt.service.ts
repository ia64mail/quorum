import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { getRolePromptTemplate } from '@app/common';
import { AgentConfigService } from '../config';

@Injectable()
export class RolePromptService implements OnModuleInit {
  private readonly logger = new Logger(RolePromptService.name);

  constructor(private readonly config: AgentConfigService) {}

  onModuleInit(): void {
    const role = this.config.agent.role;
    const template = getRolePromptTemplate(role);
    this.logger.log(
      `Role prompt template loaded: role=${role} chars=${template.length} ` +
        `({{caller}} substituted per invocation)`,
    );
    this.logger.log(
      `\n--- BEGIN ROLE PROMPT TEMPLATE (${role}) ---\n${template}\n--- END ROLE PROMPT TEMPLATE (${role}) ---`,
    );
  }

  getSystemPrompt(caller: string): string {
    const template = getRolePromptTemplate(this.config.agent.role);
    return template.replaceAll('{{caller}}', caller);
  }
}
