import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, Message } from '@anthropic-ai/sdk/resources';
import { AgentConfigService } from '../config';

@Injectable()
export class AnthropicService {
  private readonly client: Anthropic;

  constructor(private readonly config: AgentConfigService) {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async chat(params: {
    system: string;
    messages: MessageParam[];
    tools?: Tool[];
  }): Promise<Message> {
    return this.client.messages.create({
      model: this.config.anthropic.model,
      max_tokens: this.config.anthropic.maxTokens,
      system: params.system,
      messages: params.messages,
      ...(params.tools?.length ? { tools: params.tools } : {}),
    });
  }
}
