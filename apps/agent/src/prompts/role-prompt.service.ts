import { Injectable } from '@nestjs/common';
import { getRolePromptTemplate } from '@app/common';
import { AgentConfigService } from '../config';

/**
 * Resolves the role-specific prompt template for the current agent
 * and substitutes dynamic values (caller).
 */
@Injectable()
export class RolePromptService {
  constructor(private readonly config: AgentConfigService) {}

  /**
   * Returns the hydrated system prompt for the current agent's role
   * with {{caller}} replaced by the requesting agent's role.
   */
  getSystemPrompt(caller: string): string {
    const template = getRolePromptTemplate(this.config.agent.role);
    return template.replaceAll('{{caller}}', caller);
  }
}
