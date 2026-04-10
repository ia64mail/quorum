import { Injectable, Logger } from '@nestjs/common';
import type {
  CanUseTool,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  BootstrapContext,
  InvokeRequest,
  InvokeResponse,
} from '@app/common';
import { RolePermissionService, type ToolGuardResult } from '../config';
import { ClaudeCodeService } from '../llm';
import type { ExecuteResult } from '../llm/claude-code.types';
import { RolePromptService } from '../prompts';
import { McpToolBridgeService } from './mcp-tool-bridge.service';

/**
 * Adapts the synchronous {@link ToolGuardResult} from the role guard hook
 * into the SDK's async {@link CanUseTool} callback.
 */
export function toCanUseTool(
  guardHook: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => ToolGuardResult,
): CanUseTool {
  return async (toolName, input, _options): Promise<PermissionResult> => {
    const result = guardHook(toolName, input);

    if (result.allowed) {
      return {
        behavior: 'allow',
        updatedInput: input,
      };
    }

    return {
      behavior: 'deny',
      message: result.reason ?? 'Denied by role policy',
    };
  };
}

/**
 * Processes incoming invocations from other agents by delegating to
 * {@link ClaudeCodeService.execute}.
 *
 * The handler assembles parameters (prompt, system prompt, MCP bridge,
 * permission restrictions) and maps the SDK result to an {@link InvokeResponse}.
 * The agentic tool loop runs inside Claude Code — this is a thin orchestration layer.
 */
@Injectable()
export class InvocationHandler {
  private readonly logger = new Logger(InvocationHandler.name);

  constructor(
    private readonly claudeCode: ClaudeCodeService,
    private readonly bridge: McpToolBridgeService,
    private readonly permissions: RolePermissionService,
    private readonly promptService: RolePromptService,
  ) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    this.logger.log(
      `Invocation received: correlationId=${request.correlationId} ` +
        `action="${request.action}" caller=${request.caller} depth=${request.depth}`,
    );

    try {
      const result = await this.claudeCode.execute({
        prompt: this.buildPrompt(request),
        systemPrompt: this.promptService.getSystemPrompt(request.caller),
        mcpServers: this.bridge.createBridge(request),
        disallowedTools: this.permissions.getDisallowedTools(),
        canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
      });

      this.logResult(request, result);

      return result.success
        ? {
            success: true,
            result: result.result,
            totalCostUsd: result.totalCostUsd,
            durationMs: result.durationMs,
          }
        : {
            success: false,
            error: result.error,
            totalCostUsd: result.totalCostUsd,
            durationMs: result.durationMs,
          };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SDK execution failed: correlationId=${request.correlationId} ${message}`,
      );
      return { success: false, error: `SDK execution failed: ${message}` };
    }
  }

  private buildPrompt(request: InvokeRequest): string {
    let prompt = '';

    // Bootstrap context (prepended before task)
    const bootstrapSection = this.renderBootstrapContext(
      request.bootstrapContext,
    );
    if (bootstrapSection) {
      prompt += bootstrapSection + '\n\n';
    }

    // Task action (existing)
    prompt += `Task: ${request.action}`;

    // Caller-provided context (existing)
    if (request.context && Object.keys(request.context).length > 0) {
      prompt += `\n\nAdditional context:\n${JSON.stringify(request.context, null, 2)}`;
    }

    return prompt;
  }

  private renderBootstrapContext(
    ctx: BootstrapContext | undefined,
  ): string | null {
    if (!ctx) return null;

    const projectEntries = Object.entries(ctx.project);
    const conversationEntries = Object.entries(ctx.conversation);

    if (projectEntries.length === 0 && conversationEntries.length === 0) {
      return null;
    }

    const lines: string[] = ['## Prior Decisions'];

    if (projectEntries.length > 0) {
      lines.push('', '### Project Context');
      for (const [key, value] of projectEntries) {
        lines.push(`- ${key}: ${JSON.stringify(value)}`);
      }
    }

    if (conversationEntries.length > 0) {
      lines.push('', '### Conversation Context');
      for (const [key, value] of conversationEntries) {
        lines.push(`- ${key}: ${JSON.stringify(value)}`);
      }
    }

    return lines.join('\n');
  }

  private logResult(request: InvokeRequest, result: ExecuteResult): void {
    const base = `correlationId=${request.correlationId}`;
    if (result.success) {
      this.logger.log(
        `Invocation complete: ${base} sessionId=${result.sessionId} ` +
          `turns=${result.numTurns} cost=$${result.totalCostUsd.toFixed(4)} ` +
          `duration=${result.durationMs}ms`,
      );
    } else {
      this.logger.warn(
        `Invocation failed: ${base} error="${result.error}" ` +
          `turns=${result.numTurns ?? '?'} ` +
          `cost=$${result.totalCostUsd.toFixed(4)} duration=${result.durationMs}ms`,
      );
    }
  }
}
