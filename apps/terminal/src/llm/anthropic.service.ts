import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, Message } from '@anthropic-ai/sdk/resources';
import { TerminalConfigService } from '../config';

const CACHE_CONTROL = { type: 'ephemeral' as const };

@Injectable()
export class AnthropicService {
  private readonly client: Anthropic;

  constructor(private readonly config: TerminalConfigService) {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async chat(params: {
    system: string;
    messages: MessageParam[];
    tools?: Tool[];
  }): Promise<Message> {
    // --- Tool definition caching ---
    // Clone the tools array and add cache_control to the last tool.
    // Tools don't change between rounds, so this is a one-time cache write.
    let cachedTools: Tool[] | undefined;
    if (params.tools?.length) {
      cachedTools = [...params.tools];
      cachedTools[cachedTools.length - 1] = {
        ...cachedTools[cachedTools.length - 1],
        cache_control: CACHE_CONTROL,
      };
    }

    // --- Conversation message caching ---
    // Inject cache_control on the last content block of the last user message.
    // This creates a sliding cache breakpoint so only the newest messages are
    // fresh input on each round. Clones only the modified objects to avoid
    // mutating the caller's data.
    const cachedMessages = [...params.messages];
    for (let i = cachedMessages.length - 1; i >= 0; i--) {
      if (cachedMessages[i].role === 'user') {
        const msg = cachedMessages[i];
        const content = msg.content;

        if (typeof content === 'string') {
          // String content — convert to content block array with cache_control
          cachedMessages[i] = {
            ...msg,
            content: [
              {
                type: 'text' as const,
                text: content,
                cache_control: CACHE_CONTROL,
              },
            ],
          };
        } else if (Array.isArray(content) && content.length > 0) {
          // Array content — clone and annotate the last block.
          // Use Record<string,unknown> spread to avoid ContentBlockParam union
          // narrowing issues — not all union members declare cache_control.
          const blocks = [...content];
          const lastBlock = blocks[blocks.length - 1] as unknown as Record<
            string,
            unknown
          >;
          blocks[blocks.length - 1] = {
            ...lastBlock,
            cache_control: CACHE_CONTROL,
          } as unknown as (typeof blocks)[number];
          cachedMessages[i] = { ...msg, content: blocks };
        }
        break;
      }
    }

    return this.client.messages.create({
      model: this.config.anthropic.model,
      max_tokens: this.config.anthropic.maxTokens,
      system: [
        {
          type: 'text' as const,
          text: params.system,
          cache_control: CACHE_CONTROL,
        },
      ],
      messages: cachedMessages,
      ...(cachedTools ? { tools: cachedTools } : {}),
    });
  }
}
