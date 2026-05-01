import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CanUseTool,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  BootstrapContext,
  InvokeRequest,
  InvokeResponse,
} from '@app/common';
import {
  AgentConfigService,
  RolePermissionService,
  type ToolGuardResult,
} from '../config';
import { ClaudeCodeService } from '../llm';
import type { ExecuteResult } from '../llm/claude-code.types';
import { RolePromptService } from '../prompts';
import { McpToolBridgeService } from './mcp-tool-bridge.service';

const execAsync = promisify(exec);

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
  private readonly inflight = new Map<string, Promise<InvokeResponse>>();

  constructor(
    private readonly claudeCode: ClaudeCodeService,
    private readonly bridge: McpToolBridgeService,
    private readonly permissions: RolePermissionService,
    private readonly promptService: RolePromptService,
    private readonly config: AgentConfigService,
  ) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    this.logger.log(
      `Invocation received: correlationId=${request.correlationId} ` +
        `action="${request.action}" caller=${request.caller} depth=${request.depth}`,
    );

    const existing = this.inflight.get(request.correlationId);
    if (existing) {
      this.logger.log(
        `Duplicate invocation reusing in-flight: correlationId=${request.correlationId}`,
      );
      return existing;
    }

    const work = this.runInvocation(request).finally(() => {
      this.inflight.delete(request.correlationId);
    });
    this.inflight.set(request.correlationId, work);
    return work;
  }

  private async runInvocation(request: InvokeRequest): Promise<InvokeResponse> {
    try {
      const prompt = this.buildPrompt(request);
      const systemPrompt = this.promptService.getSystemPrompt(request.caller);

      this.logInitialPrompt(request, systemPrompt, prompt);

      const result = await this.claudeCode.execute({
        prompt,
        systemPrompt,
        mcpServers: this.bridge.createBridge(request),
        plugins: this.permissions.getPlugins(),
        disallowedTools: this.permissions.getDisallowedTools(),
        canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
        resume: request.sessionId,
      });

      this.logResult(request, result);
      await this.checkUncommittedChanges(request.correlationId);

      return result.success
        ? {
            success: true,
            result: result.result,
            totalCostUsd: result.totalCostUsd,
            durationMs: result.durationMs,
            sessionId: result.sessionId,
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

  private logInitialPrompt(
    request: InvokeRequest,
    systemPrompt: string,
    userPrompt: string,
  ): void {
    this.logger.log(
      `Initial prompt assembled: correlationId=${request.correlationId} ` +
        `caller=${request.caller} systemPromptChars=${systemPrompt.length} ` +
        `userPromptChars=${userPrompt.length}`,
    );
    this.logger.debug(
      `\n=== Initial prompt for correlationId=${request.correlationId} ===\n` +
        `--- System Prompt (caller=${request.caller}) ---\n${systemPrompt}\n` +
        `--- User Prompt ---\n${userPrompt}\n` +
        `=== End of initial prompt (correlationId=${request.correlationId}) ===`,
    );
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

    // Slash-command actions (e.g. "/code-review") are passed verbatim so
    // the SDK dispatches directly to the skill.  Regular actions get the
    // "Task: " prefix for the LLM.
    prompt += request.action.startsWith('/')
      ? request.action
      : `Task: ${request.action}`;

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

  private async checkUncommittedChanges(
    correlationId: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: this.config.agent.workspaceDir,
      });
      if (stdout.trim()) {
        this.logger.warn(
          `Uncommitted changes after invocation: correlationId=${correlationId}\n${stdout.trim()}`,
        );
        return true;
      }
      return false;
    } catch {
      // git not available or not a repo — skip silently
      return false;
    }
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
