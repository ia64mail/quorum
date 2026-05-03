import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  query,
  InMemorySessionStore,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { AgentConfigService } from '../config';
import type { ExecuteParams, ExecuteResult } from './claude-code.types';
import { createObservabilityHooks } from './sdk-hooks.factory';

// QRM6-BUG-012 follow-up: bypass the SDK's broken binary picker (sdk.mjs `N7`
// tries `-musl` before glibc with no libc detection — fails on Debian when
// both variants are installed). Pin the binary path to the glibc variant
// for the current arch. Defense-in-depth alongside the `rm -rf …-musl` step
// in the Dockerfile.
const CLAUDE_BINARY_PATH = `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`;

@Injectable()
export class ClaudeCodeService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeCodeService.name);
  private readonly activeControllers = new Set<AbortController>();
  private readonly sessionStore = new InMemorySessionStore();

  constructor(private readonly config: AgentConfigService) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const controller = params.abortController ?? new AbortController();
    this.activeControllers.add(controller);

    const start = Date.now();

    try {
      return await this.executeQuery(params, controller, start);
    } catch (err) {
      // Graceful fallback: if resume was requested and the session is missing,
      // retry without resume so the agent starts a fresh session.
      // Skip the retry when the controller was aborted (shutdown in progress)
      // — retrying would fail immediately and the result wouldn't be used.
      if (params.resume && !controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Session resume failed (sessionId=${params.resume}): ${msg} — retrying fresh`,
        );
        try {
          return await this.executeQuery(
            { ...params, resume: undefined },
            controller,
            Date.now(),
          );
        } catch (retryErr) {
          return {
            success: false,
            error:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
            durationMs: Date.now() - start,
            totalCostUsd: 0,
          };
        }
      }
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

  private async executeQuery(
    params: ExecuteParams,
    controller: AbortController,
    start: number,
  ): Promise<ExecuteResult> {
    let sessionId: string | undefined;
    let messageCount = 0;

    const isResume = !!params.resume;

    const prompt = params.mcpServers
      ? toAsyncIterable(params.prompt)
      : params.prompt;

    const gen = query({
      prompt,
      options: {
        cwd: this.config.agent.workspaceDir,
        model: this.config.anthropic.model,
        pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
        // On resume, the resumed session already carries the original system
        // prompt; re-sending it busts the SDK prompt cache when MCP servers
        // are configured (anthropics/claude-agent-sdk-typescript#247) and
        // duplicates context. The retry-fresh fallback (executeQuery rerun
        // with resume:undefined) reinstates it via the same conditional.
        ...(isResume ? {} : { systemPrompt: params.systemPrompt }),
        permissionMode: 'default',
        persistSession: true,
        settingSources: ['project'],
        includePartialMessages: false,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.anthropic.apiKey,
        },
        ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
        abortController: controller,
        hooks: createObservabilityHooks(this.logger),
        debugFile: '/tmp/sdk-debug.log',
        stderr: (data: string) => {
          this.logger.warn(`[subprocess stderr] ${data.trimEnd()}`);
        },
        ...(params.plugins ? { plugins: params.plugins } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
        ...(params.disallowedTools
          ? { disallowedTools: params.disallowedTools }
          : {}),
        ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
        // QRM6-BUG-005: sessionStore enables the SDK's store-based resume path.
        // Without it, `resume` only passes --resume to the CLI which silently
        // starts fresh when the session file is missing (e.g. ephemeral containers).
        // The InMemorySessionStore is auto-populated by TranscriptMirrorBatcher
        // on first invocation and loaded back via store.load() on resume.
        sessionStore: this.sessionStore,
        ...(params.resume ? { resume: params.resume } : {}),
      },
    });

    for await (const message of gen) {
      messageCount++;
      const mapped = this.processMessage(message, sessionId, !!params.resume);
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
    isResume: boolean,
  ): ExecuteResult | null {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          if (isResume) {
            this.logger.debug(`Session resumed: ${message.session_id}`);
          } else {
            this.logger.debug(`Session started: ${message.session_id}`);
          }
        }
        return null;

      case 'assistant': {
        const content = message.message.content;
        const toolUseNames = extractToolUseNames(content);
        const preview = previewContent(message.message);

        // Assistant messages may contain only thinking blocks (extended
        // thinking) with no text or tool_use content. These are opaque by
        // SDK design — we can't extract anything useful, so skip logging
        // to avoid noisy "[non-text content]" lines.
        if (toolUseNames.length > 0) {
          // Tool-call message: log which tools were selected, and include
          // the model's stated reasoning if a text block is present.
          // When reasoning lives only in a thinking block, omit the
          // unhelpful "[non-text content]" suffix.
          const suffix = preview !== NON_TEXT ? ` "${preview}"` : '';
          this.logger.debug(
            `SDK reasoning: [calls ${toolUseNames.join(', ')}]${suffix}`,
          );
        } else if (preview !== NON_TEXT) {
          this.logger.debug(`SDK response: ${preview}`);
        }
        return null;
      }

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
          error: message.errors?.join('; ') || message.subtype,
          durationMs: message.duration_ms,
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns,
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

function extractToolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block: Record<string, unknown>) =>
        typeof block === 'object' &&
        block !== null &&
        block.type === 'tool_use',
    )
    .map((block: Record<string, unknown>) => String(block.name));
}

/** Sentinel returned when an assistant message has no text blocks (e.g. thinking-only). */
const NON_TEXT = '[non-text content]';

function previewContent(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block: Record<string, unknown>) =>
        typeof block === 'object' && block !== null && 'text' in block,
    ) as Record<string, unknown> | undefined;
    if (textBlock) {
      return String(textBlock.text).slice(0, 200);
    }
  }
  return NON_TEXT;
}
