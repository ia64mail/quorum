import { Injectable, Logger } from '@nestjs/common';
import { exec, execFile } from 'node:child_process';
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
const execFileAsync = promisify(execFile);

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
      await execFileAsync(
        'git',
        ['worktree', 'add', worktreePath, request.branch],
        { cwd: repoDir },
      );
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

    // --- Reset working branch to origin/<branch> (#65) ---
    // Self-heal divergence: if a prior invocation orphaned a local-ahead
    // commit on the shared clone's ref, the worktree we just created
    // inherits that ref. Resetting to the remote-tracking ref (refreshed
    // by the `git fetch origin` above) discards the stale local-ahead
    // state so the SDK starts from canonical origin every time.
    // ORDERING: reset is start-of-invocation, push is end-of-invocation
    // (commitAndPush). They must not be reordered within one invocation
    // — a reset after the SDK runs would discard the agent's output
    // before it can be pushed.
    try {
      await execFileAsync(
        'git',
        ['reset', '--hard', `origin/${request.branch}`],
        { cwd: worktreePath },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `worktree reset to origin failed: correlationId=${request.correlationId} ${msg}`,
      );
      // Clean up the worktree we just created before returning error
      try {
        await execFileAsync(
          'git',
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: repoDir },
        );
      } catch {
        /* best-effort cleanup */
      }
      return {
        success: false,
        error: `Worktree setup failed: reset to origin/${request.branch}: ${msg}`,
      };
    }

    // --- Symlink /app/node_modules into worktree ---
    try {
      await execFileAsync('ln', [
        '-s',
        '/app/node_modules',
        `${worktreePath}/node_modules`,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `node_modules symlink failed: correlationId=${request.correlationId} ${msg}`,
      );
      // Clean up the worktree we just created before returning error
      try {
        await execFileAsync(
          'git',
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: repoDir },
        );
      } catch {
        /* best-effort cleanup */
      }
      return {
        success: false,
        error: `Worktree setup failed: node_modules symlink: ${msg}`,
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
            commitMessage: result.commitMessage,
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
        await execFileAsync(
          'git',
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: repoDir },
        );
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

    const lines: string[] = [
      '## Prior Decisions',
      '',
      "The records below are prior agents' stored context — snapshots from earlier invocations, possibly stale. Treat each as a hypothesis to re-verify against the present code, not as settled fact.",
    ];

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

    // 1. Commit any dirty changes the SDK left behind.
    if (status.trim()) {
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
    }

    // 2. Push anything ahead of origin (keystone, #65).
    //    The handler is the sole pusher (docs/system-design.md:413 — agent is
    //    a non-pusher by design, QRM8 D5). If the agent committed despite
    //    the deny-guard, those commits live only in the shared clone until
    //    we push them; if we don't, they orphan and poison later worktrees.
    //    Check rev-list against origin/<branch> — the fetch at worktree
    //    setup keeps the remote-tracking ref current.
    const aheadCount = await this.countAhead(cwd, request.branch);
    if (aheadCount === 0) {
      this.logger.log(
        `No changes to push after invocation: correlationId=${request.correlationId}`,
      );
      return;
    }

    await this.pushWithRebaseRetry(cwd, request);

    const { stdout: sha } = await execAsync('git rev-parse --short HEAD', {
      cwd,
    });
    this.logger.log(
      `Committed and pushed: correlationId=${request.correlationId} ` +
        `branch=${request.branch} sha=${sha.trim()} ahead=${aheadCount}`,
    );
  }

  /**
   * Count commits on the local HEAD that are not yet on `origin/<branch>`.
   * Returns 0 when the branch is fully pushed (clean no-op case).
   */
  private async countAhead(cwd: string, branch: string): Promise<number> {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `origin/${branch}..HEAD`],
      { cwd },
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Push to origin with a single recover-once-then-fail-loud rebase retry.
   * On a non-fast-forward reject we attempt one `git pull --rebase origin
   * <branch>` and re-push; if that fails (rebase conflict or the second
   * push still rejects) we throw a structured `push rejected` error so the
   * broker surfaces a real failure instead of leaving a silent local
   * orphan (#65 fail-loud invariant).
   */
  private async pushWithRebaseRetry(
    cwd: string,
    request: InvokeRequest,
  ): Promise<void> {
    try {
      await execFileAsync('git', ['push', 'origin', request.branch], { cwd });
      return;
    } catch (pushErr) {
      const initialErr =
        pushErr instanceof Error ? pushErr.message : String(pushErr);
      this.logger.warn(
        `Push rejected, attempting rebase + retry: ` +
          `correlationId=${request.correlationId} branch=${request.branch} ` +
          `error=${initialErr}`,
      );

      try {
        await execFileAsync(
          'git',
          ['pull', '--rebase', 'origin', request.branch],
          { cwd },
        );
      } catch (rebaseErr) {
        const stderr =
          rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
        throw new Error(
          `push rejected: rebase failed (initial=${initialErr}): ${stderr}`,
        );
      }

      try {
        await execFileAsync('git', ['push', 'origin', request.branch], { cwd });
      } catch (retryErr) {
        const stderr =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          `push rejected: retry after rebase failed (initial=${initialErr}): ${stderr}`,
        );
      }

      this.logger.log(
        `Push succeeded after rebase: correlationId=${request.correlationId} ` +
          `branch=${request.branch}`,
      );
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
