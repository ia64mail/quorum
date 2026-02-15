import { Injectable, Logger } from '@nestjs/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConfigService } from '../config';

/**
 * Processes incoming invocations from other agents.
 *
 * QRM1-007 stub: acknowledges receipt without LLM processing.
 * QRM1-008 replaces the stub body with Anthropic API integration.
 */
@Injectable()
export class InvocationHandler {
  private readonly logger = new Logger(InvocationHandler.name);

  constructor(private readonly config: AgentConfigService) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    this.logger.log(
      `Invocation received: action="${request.action}" ` +
        `caller=${request.caller} depth=${request.depth}`,
      { correlationId: request.correlationId },
    );

    return {
      success: true,
      result: `[${this.config.agent.role}] Acknowledged: "${request.action}"`,
    };
  }
}
