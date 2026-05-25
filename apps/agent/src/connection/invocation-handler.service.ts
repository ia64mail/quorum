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

/** Base directory for per-invocation worktrees. Each invocation gets a
 *  subdirectory named by its correlationId. Uses tmpfs in production
 *  (self-healing on container restart). */
const WORKTREE_BASE = '/var/agent-worktrees';

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
    const worktreePath = `${WORKTREE_BASE}/${request.correlationId}`;
    const repoDir = this.config.agent.workspaceDir;

    // --- Worktree setup ---
    try {
      await execAsync('git fetch origin', { cwd: repoDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `git fetch failed: correlationId=${request.correlationId} ${msg}`,
      );
      return {
        success: false,
        error: `Worktree creation failed: git fetch origin: ${msg}`,
      };
    }

    try {
      await execAsync(`git worktree add ${worktreePath} ${request.branch}`, {
        cwd: repoDir,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `git worktree add failed: correlationId=${request.correlationId} ${msg}`,
      );
      return {
        success: false,
        error: `Worktree creation failed: ${msg}`,
      };
    }

    // --- SDK execution (finally block ensures cleanup) ---
    try {
      const prompt = this.buildPrompt(request);
      const systemPrompt = this.promptService.getSystemPrompt(request.caller);

      this.logInitialPrompt(request, systemPrompt, prompt);

      const result = await this.claudeCode.execute({
        prompt,
        systemPrompt,
        cwd: worktreePath,
        mcpServers: this.bridge.createBridge(request),
        plugins: this.permissions.getPlugins(),
        disallowedTools: this.permissions.getDisallowedTools(),
        canUseTool: toCanUseTool(this.permissions.getToolGuardHook()),
        resume: request.sessionId,
      });

      this.logResult(request, result);

      const response: InvokeResponse = result.success
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

      if (result.success) {
        try {
          await this.commitAndPush(worktreePath, request, response);
        } catch (commitErr) {
          const msg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          response.success = false;
          response.error = `Commit/push failed: ${msg}`;
        }
      }

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SDK execution failed: correlationId=${request.correlationId} ${message}`,
      );
      return { success: false, error: `SDK execution failed: ${message}` };
    } finally {
      // --- Worktree cleanup (must run on success AND error) ---
      try {
        await execAsync(`git worktree remove --force ${worktreePath}`, {
          cwd: repoDir,
        });
      } catch (cleanupErr) {
        const msg =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.warn(
          `Worktree cleanup failed: correlationId=${request.correlationId} ${msg}`,
        );
      }
    }
  }

  private logInitialPrompt(
    request: InvokeRequest,
    systemPrompt: string,
    userPrompt: string,
  ): void {
    const isResume = !!request.sessionId;
    const systemPromptNote = isResume
      ? `${systemPrompt.length} chars (suppressed on resume — session carries it)`
      : `${systemPrompt.length} chars`;
    this.logger.log(
      `Initial prompt assembled: correlationId=${request.correlationId} ` +
        `caller=${request.caller} resume=${isResume} ` +
        `systemPrompt=${systemPromptNote} userPromptChars=${userPrompt.length}`,
    );
    const systemPromptBlock = isResume
      ? `--- System Prompt (caller=${request.caller}) [SUPPRESSED — resume] ---\n` +
        `(${systemPrompt.length} chars; not sent to SDK because resume=${request.sessionId})\n`
      : `--- System Prompt (caller=${request.caller}) ---\n${systemPrompt}\n`;
    this.logger.debug(
      `\n=== Initial prompt for correlationId=${request.correlationId} ===\n` +
        systemPromptBlock +
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

  private async commitAndPush(
    cwd: string,
    request: InvokeRequest,
    response: InvokeResponse,
  ): Promise<void> {
    const { stdout: status } = await execAsync('git status --porcelain', {
      cwd,
    });

    if (!status.trim()) {
      this.logger.log(
        `No changes to commit after invocation: correlationId=${request.correlationId}`,
      );
      return;
    }

    let message: string;
    if (response.commitMessage) {
      message = response.commitMessage;
    } else {
      const corrIdShort = request.correlationId.substring(0, 8);
      message = `(no-message/${corrIdShort}): changes from ${request.target} invocation`;
      this.logger.warn(
        `Agent did not provide commitMessage: correlationId=${request.correlationId} — using fallback`,
      );
    }

    await execAsync('git add -A', { cwd });
    await execAsync(`git commit -m ${this.shellQuote(message)}`, { cwd });

    try {
      await execAsync(`git push origin ${request.branch}`, { cwd });
    } catch (pushErr) {
      const stderr =
        pushErr instanceof Error ? pushErr.message : String(pushErr);
      throw new Error(`push rejected: ${stderr}`);
    }
  }

  /** Wraps a string in single quotes, escaping embedded single quotes. */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  private logResult(request: InvokeRequest, result: ExecuteResult): void {
    const base = `correlationId=${request.correlationId}`;
    if (result.success) {
      this.logger.log(
        `Invocation complete: ${base} sessionId=${result.sessionId} ` +
          `turns=${result.numTurns} cost=$${result.totalCostUsd.toFixed(4)} ` +
          `duration=${result.durationMs}ms`,
      );
      // Silent-fallback detection: resume was requested but the SDK started
      // a fresh session instead of resuming the prior one.
      if (request.sessionId && result.sessionId !== request.sessionId) {
        this.logger.warn(
          `Session resume silent fallback: correlationId=${request.correlationId} ` +
            `requested=${request.sessionId} got=${result.sessionId}`,
        );
      }
    } else {
      this.logger.warn(
        `Invocation failed: ${base} error="${result.error}" ` +
          `turns=${result.numTurns ?? '?'} ` +
          `cost=$${result.totalCostUsd.toFixed(4)} duration=${result.durationMs}ms`,
      );
    }
  }
}
