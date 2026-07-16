import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { AgentConfigService } from '../config';
import type { ExecuteParams, ExecuteResult } from './claude-code.types';
import { FileSessionStore } from './file-session-store';
import { createObservabilityHooks } from './sdk-hooks.factory';

// QRM6-BUG-012 follow-up: bypass the SDK's broken binary picker (sdk.mjs `N7`
// tries `-musl` before glibc with no libc detection — fails on Debian when
// both variants are installed). Pin the binary path to the glibc variant
// for the current arch. Defense-in-depth alongside the `rm -rf …-musl` step
// in the Dockerfile.
const CLAUDE_BINARY_PATH = `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`;

/**
 * Allowlist of env vars forwarded to the CC CLI subprocess.
 * Everything NOT on this list is excluded — this is the primary defense
 * against leaking secrets (GH_TOKEN, ANTHROPIC_API_KEY from env, etc.)
 * into the model-visible subprocess environment.
 *
 * DELIBERATE OMISSIONS (QRM8 D5 secret-isolation boundary, #65):
 *   - `GH_TOKEN`         — the GitHub PAT held by the handler process for
 *                          push authentication. Forwarding it would let
 *                          the model read its own token, print it, write
 *                          it to a file, or be prompt-injected into doing
 *                          so via code under review.
 *   - `GIT_CONFIG_GLOBAL` — points at the gh credential-helper config
 *                          written by docker/agent/entrypoint.sh; same
 *                          token-exposure concern as above.
 *
 * The intended consequence is that the agent CAN commit (it has git
 * identity above) but CANNOT push (no credential path). Push reliability
 * is the handler's responsibility — see InvocationHandler.commitAndPush,
 * which pushes anything ahead of origin regardless of whether the
 * commit was framework-made or agent-made (#65 keystone). Do NOT add
 * either secret to this list to "fix" the push gap.
 */
const SDK_ENV_ALLOWLIST: readonly string[] = [
  // System essentials
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'HOSTNAME',
  // Locale & terminal
  'TERM',
  'LANG',
  'LC_ALL',
  // Runtime
  'NODE_ENV',
  'TMPDIR',
  'TZ',
  // Git identity (NOT credentials — see comment above)
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/** Pick only allowlisted keys from process.env, skipping undefined values. */
function buildSdkEnv(allowlist: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}

@Injectable()
export class ClaudeCodeService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeCodeService.name);
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly config: AgentConfigService,
    private readonly sessionStore: FileSessionStore,
  ) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const controller = params.abortController ?? new AbortController();
    this.activeControllers.add(controller);

    const start = Date.now();

    try {
      const result = await this.executeQuery(params, controller, start);

      // Result-envelope resume-failure path (#68 Round-2 Finding 6):
      // On SDK 0.3.207, a missing-resume-session is delivered as a
      // result envelope with subtype !== 'success' rather than a thrown
      // error, so the outer catch below never runs. Detect it here and
      // route through the same retry-fresh path as thrown errors.
      // Skip the retry when the controller was aborted (shutdown in
      // progress) — mirrors the catch-path abort-guard below.
      if (
        !result.success &&
        params.resume &&
        !controller.signal.aborted &&
        ClaudeCodeService.isResumeFailure(result.error, result.terminalReason)
      ) {
        this.logger.warn(
          `Session resume failed (sessionId=${params.resume}): ${result.error} — retrying fresh`,
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

      return result;
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

  /**
   * Detect whether a failure result envelope from the SDK signals a
   * missing-resume-session condition, so `execute()` can route it through
   * the same retry-fresh fallback as thrown errors.
   *
   * Preferred signal: the SDK's structured `terminal_reason`
   * (`TerminalReason` in `@anthropic-ai/claude-agent-sdk/sdk.d.ts`) —
   * `turn_setup_failed` is what 0.3.207 emits when the CLI cannot resume
   * the requested session. Fallback: substring match against the observed
   * subprocess-stderr text `No conversation found with session ID`
   * relayed through the joined `errors` field. See #68 Round-2 Finding 6.
   */
  private static isResumeFailure(
    error: string | undefined,
    terminalReason: string | undefined,
  ): boolean {
    if (terminalReason === 'turn_setup_failed') return true;
    if (error && error.includes('No conversation found with session ID')) {
      return true;
    }
    return false;
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
        cwd: params.cwd ?? this.config.agent.workspaceDir,
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
          ...buildSdkEnv(SDK_ENV_ALLOWLIST),
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
        // FileSessionStore (QRM8 D3) persists transcripts as JSONL on the
        // /var/agent-sessions/ named volume, enabling resume across restarts.
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
        } else if (message.subtype === 'mirror_error') {
          // #78: FileSessionStore.append() failed the SDK's own 3-attempt
          // retry (SDKMirrorErrorMessage in sdk.d.ts). Surface it at warn —
          // silently dropping this frame is what masked the /var/agent-sessions
          // EACCES for the entire PR #69 verification. Session persistence is
          // broken for this session; the invocation itself is still
          // recoverable (the model has completed its work) so we do NOT
          // elevate to a hard failure.
          const frame = message as unknown as Record<string, unknown>;
          const terminalReason =
            typeof frame.terminal_reason === 'string'
              ? ` terminal_reason=${frame.terminal_reason}`
              : '';
          this.logger.warn(
            `SDK session-store mirror_error (session=${message.session_id}): ${message.error}${terminalReason}`,
          );
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
          const { message: commitMessage, stripped } =
            ClaudeCodeService.extractCommitMessage(message.result);
          return {
            success: true,
            result: stripped,
            sessionId: sessionId ?? message.session_id,
            durationMs: message.duration_ms,
            totalCostUsd: message.total_cost_usd,
            numTurns: message.num_turns,
            ...(commitMessage !== undefined ? { commitMessage } : {}),
          };
        }
        return {
          success: false,
          error: message.errors?.join('; ') || message.subtype,
          durationMs: message.duration_ms,
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns,
          // Surface terminal_reason (SDK 0.3.203+) so execute() can detect
          // missing-resume-session failures without string matching. See
          // #68 Round-2 Finding 6.
          ...(message.terminal_reason !== undefined
            ? { terminalReason: message.terminal_reason }
            : {}),
        };

      default:
        return null;
    }
  }

  /**
   * Extract a `<commit-message>...</commit-message>` block from SDK result text.
   * If multiple blocks are present, the last one wins (agent may revise mid-stream).
   * The block is stripped from the returned text so consumers don't see metadata.
   *
   * Pairing is done by index rather than a single spanning regex: the last
   * `</commit-message>` is paired with the last `<commit-message>` that
   * precedes it. This selects the correct "real" block even when the agent
   * mentions the literal marker in prose beforehand (the prose opening tag
   * has no closing tag of its own, so it is never selected as part of a
   * pair) — see #79. Stripping then removes every well-formed pair,
   * scanning right-to-left, so multiple genuine blocks (e.g. a
   * mid-conversation revision) are still fully removed, while a dangling,
   * unmatched opening tag (the prose mention) is left in place untouched.
   */
  private static extractCommitMessage(text: string): {
    message?: string;
    stripped: string;
  } {
    const OPEN_TAG = '<commit-message>';
    const CLOSE_TAG = '</commit-message>';

    const findLastPair = (
      haystack: string,
    ): { openIndex: number; closeIndex: number } | null => {
      const lower = haystack.toLowerCase();
      const closeIndex = lower.lastIndexOf(CLOSE_TAG);
      if (closeIndex === -1) return null;
      const openIndex = lower.lastIndexOf(OPEN_TAG, closeIndex - 1);
      if (openIndex === -1) return null;
      return { openIndex, closeIndex };
    };

    const lastPair = findLastPair(text);
    if (!lastPair) {
      return { stripped: text };
    }

    const message = text
      .slice(lastPair.openIndex + OPEN_TAG.length, lastPair.closeIndex)
      .trim();

    let working = text;
    for (
      let pair = findLastPair(working);
      pair !== null;
      pair = findLastPair(working)
    ) {
      working =
        working.slice(0, pair.openIndex) +
        working.slice(pair.closeIndex + CLOSE_TAG.length);
    }
    const stripped = working.replace(/\n{3,}/g, '\n\n').trim();

    return { message: message || undefined, stripped };
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
