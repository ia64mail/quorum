import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { AgentConfigService } from '../config';
import type { ExecuteParams, ExecuteResult } from './claude-code.types';

@Injectable()
export class ClaudeCodeService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeCodeService.name);
  private readonly activeControllers = new Set<AbortController>();

  constructor(private readonly config: AgentConfigService) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const controller = params.abortController ?? new AbortController();
    this.activeControllers.add(controller);

    const start = Date.now();
    let sessionId: string | undefined;
    let messageCount = 0;

    try {
      const prompt = params.mcpServers
        ? toAsyncIterable(params.prompt)
        : params.prompt;

      const gen = query({
        prompt,
        options: {
          cwd: this.config.agent.workspaceDir,
          model: this.config.anthropic.model,
          systemPrompt: params.systemPrompt,
          permissionMode: 'default',
          persistSession: false,
          settingSources: [],
          includePartialMessages: false,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: this.config.anthropic.apiKey,
          },
          maxTurns: params.maxTurns ?? 20,
          abortController: controller,
          debugFile: '/tmp/sdk-debug.log',
          stderr: (data: string) => {
            this.logger.warn(`[subprocess stderr] ${data.trimEnd()}`);
          },
          ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
          ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
          ...(params.disallowedTools
            ? { disallowedTools: params.disallowedTools }
            : {}),
          ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
        },
      });

      for await (const message of gen) {
        messageCount++;
        const mapped = this.processMessage(message, sessionId);
        if (mapped) return mapped;
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
        }
      }

      const elapsed = Date.now() - start;
      this.logger.error(
        `SDK generator exhausted after ${messageCount} messages and ${elapsed}ms — no result message received`,
      );
      return {
        success: false,
        error: 'Generator completed without a result message',
        durationMs: elapsed,
        totalCostUsd: 0,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        totalCostUsd: 0,
      };
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  onApplicationShutdown(): void {
    if (this.activeControllers.size === 0) return;
    this.logger.warn(
      `Aborting ${this.activeControllers.size} active execution(s)`,
    );
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  private processMessage(
    message: SDKMessage,
    sessionId: string | undefined,
  ): ExecuteResult | null {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.logger.log(`Session started: ${message.session_id}`);
        }
        return null;

      case 'assistant':
        this.logger.debug(
          `Assistant turn — ${previewContent(message.message)}`,
        );
        return null;

      case 'result':
        if (message.subtype === 'success') {
          return {
            success: true,
            result: message.result,
            sessionId: sessionId ?? message.session_id,
            durationMs: message.duration_ms,
            totalCostUsd: message.total_cost_usd,
            numTurns: message.num_turns,
          };
        }
        return {
          success: false,
          error: message.errors?.join('; ') ?? message.subtype,
          durationMs: message.duration_ms,
          totalCostUsd: message.total_cost_usd,
        };

      default:
        return null;
    }
  }
}

async function* toAsyncIterable(prompt: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt } satisfies MessageParam,
    parent_tool_use_id: null,
    session_id: '',
  };
}

function previewContent(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && 'text' in first) {
      return String(first.text).slice(0, 200);
    }
  }
  return '[non-text content]';
}
