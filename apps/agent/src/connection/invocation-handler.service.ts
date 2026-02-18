import { Injectable, Logger } from '@nestjs/common';
import type { MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConfigService } from '../config';
import { AnthropicService } from '../llm';
import { mapMcpToolsToAnthropic, formatToolResult } from '../llm/tool-mapper';
import { RolePromptService } from '../prompts';
import { McpClientService } from './mcp-client.service';

const MAX_TOOL_ROUNDS = 10;

/**
 * Processes incoming invocations from other agents using an agentic tool loop.
 *
 * Builds messages from the InvokeRequest, calls the Anthropic Messages API
 * with MCP tool definitions, executes tool calls via McpClientService, and
 * loops until a final text response.
 */
@Injectable()
export class InvocationHandler {
  private readonly logger = new Logger(InvocationHandler.name);

  constructor(
    private readonly config: AgentConfigService,
    private readonly anthropic: AnthropicService,
    private readonly mcpClient: McpClientService,
    private readonly promptService: RolePromptService,
  ) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    this.logger.log(
      `Invocation received: action="${request.action}" ` +
        `caller=${request.caller} depth=${request.depth}`,
      { correlationId: request.correlationId },
    );

    try {
      return await this.processWithLoop(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`LLM processing failed: ${message}`, {
        correlationId: request.correlationId,
      });
      return { success: false, error: `LLM processing failed: ${message}` };
    }
  }

  private async processWithLoop(
    request: InvokeRequest,
  ): Promise<InvokeResponse> {
    const tools = mapMcpToolsToAnthropic(this.mcpClient.getTools());
    const system = this.promptService.getSystemPrompt(request.caller);

    const messages: MessageParam[] = [
      { role: 'user', content: this.buildUserMessage(request) },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.anthropic.chat({
        system,
        messages,
        tools,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        return {
          success: true,
          result: this.extractText(response.content),
        };
      }

      const toolUseBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use',
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map((block) => this.executeTool(block, request)),
      );

      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Max rounds exceeded — extract any accumulated text
    const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
    const accumulatedText = lastAssistant
      ? this.extractText(lastAssistant.content as ContentBlock[])
      : '';

    if (accumulatedText) {
      return {
        success: true,
        result: `${accumulatedText}\n\n[Note: Tool loop reached maximum of ${MAX_TOOL_ROUNDS} rounds]`,
      };
    }

    return {
      success: false,
      error: `Tool loop reached maximum of ${MAX_TOOL_ROUNDS} rounds without producing a response`,
    };
  }

  private buildUserMessage(request: InvokeRequest): string {
    let message = `Task: ${request.action}`;
    if (request.context && Object.keys(request.context).length > 0) {
      message += `\n\nAdditional context:\n${JSON.stringify(request.context, null, 2)}`;
    }
    return message;
  }

  private extractText(content: ContentBlock[]): string {
    return content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n');
  }

  private async executeTool(
    block: { id: string; name: string; input: unknown },
    request: InvokeRequest,
  ): Promise<{
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> {
    try {
      const args = this.augmentArgs(
        block.name,
        block.input as Record<string, unknown>,
        request,
      );

      this.logger.log(`Calling tool: ${block.name}`, {
        correlationId: request.correlationId,
      });

      const mcpResult = (await this.mcpClient.callTool(block.name, args)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const { text, isError } = formatToolResult(mcpResult);

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: text || '(no output)',
        ...(isError ? { is_error: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tool ${block.name} failed: ${message}`, {
        correlationId: request.correlationId,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution failed: ${message}`,
        is_error: true,
      };
    }
  }

  private augmentArgs(
    toolName: string,
    args: Record<string, unknown>,
    request: InvokeRequest,
  ): Record<string, unknown> {
    if (toolName === 'invoke_agent') {
      return {
        ...args,
        callerRole: this.config.agent.role,
        correlationId: request.correlationId,
        depth: request.depth + 1,
      };
    }

    if (toolName.startsWith('context_')) {
      return {
        correlationId: request.correlationId,
        ...args,
      };
    }

    return args;
  }
}
