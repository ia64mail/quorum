import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentRole, ContextScope, ContextStore } from '@app/common';
import type {
  BootstrapContext,
  InvokeRequest,
  InvokeResponse,
} from '@app/common';
import { BootstrapContextService } from './bootstrap-context.service';
import { McpServerConfigService } from '../config';
import { AgentRegistry } from '../registry';
import { McpElicitationConnection } from '../registry/mcp-elicitation-connection';
import { ROLE_TIMEOUTS } from './role-timeouts';

@Injectable()
export class MessageBroker {
  private readonly logger = new Logger(MessageBroker.name);
  private readonly callChains = new Map<string, Set<AgentRole>>();
  private readonly branchLocks = new Map<
    string,
    { correlationId: string; target: AgentRole }
  >();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly config: McpServerConfigService,
    private readonly bootstrapContext: BootstrapContextService,
    @Inject(ContextStore)
    private readonly contextStore: ContextStore,
  ) {}

  async invoke(request: InvokeRequest): Promise<InvokeResponse> {
    const { correlationId, caller, target, depth } = request;

    this.logger.log(
      `Invoke: correlationId=${correlationId} caller=${caller} target=${target} depth=${depth}`,
    );

    // Safeguard 1 — Depth limit (O(1))
    if (depth >= this.config.broker.maxCallDepth) {
      const error = `Max call depth (${this.config.broker.maxCallDepth}) exceeded`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      return { success: false, error };
    }

    // Safeguard 2 — Agent availability (O(1) lookup)
    // Runs before the circular check so we know the connection type and can
    // exempt elicitation targets (which are human prompts, not recursive LLM calls).
    const agent = this.registry.get(target);

    if (!agent) {
      const error = `Agent ${target} not registered`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      return { success: false, error };
    }

    if (!agent.isConnected()) {
      const error = `Agent ${target} not connected`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      return { success: false, error };
    }

    // Safeguard 3 — Circular call prevention (O(1) amortized)
    // Skipped for elicitation targets: the moderator-via-elicitation path
    // (moderator → developer → moderator) is the QRM6 clarification flow,
    // not a recursive LLM loop. Elicitation delivers a user prompt that
    // cannot itself emit further invoke_agent calls.
    const chain = this.callChains.get(correlationId) ?? new Set<AgentRole>();
    const isElicitation = agent instanceof McpElicitationConnection;

    if (!isElicitation && chain.has(target)) {
      const error = `Circular call: ${[...chain].join(' → ')} → ${target}`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      return { success: false, error };
    }

    // Track caller in chain
    chain.add(caller);
    this.callChains.set(correlationId, chain);

    // Safeguard 4 — Branch-in-flight guard (O(1))
    // Prevents two concurrent invocations from operating on the same git branch,
    // which would race on commit/push. Mirrors callChains lifecycle.
    const existingLock = this.branchLocks.get(request.branch);
    if (existingLock && existingLock.correlationId !== correlationId) {
      const error = `Branch '${request.branch}' is already in-flight (target=${existingLock.target}, correlationId=${existingLock.correlationId})`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      // Clean up the caller's entry from callChains (was added above)
      chain.delete(caller);
      if (chain.size === 0) {
        this.callChains.delete(correlationId);
      }
      return { success: false, error };
    }

    // Acquire branch lock before delivery
    this.branchLocks.set(request.branch, { correlationId, target });

    try {
      // Safeguard 5 — Role-based timeout (wraps delivery)
      const timeout =
        ROLE_TIMEOUTS[target] ?? this.config.broker.defaultTimeoutMs;

      // Assemble bootstrap context only on fresh sessions. Resumed sessions
      // already carry Prior Decisions in conversation history; re-injecting
      // them would duplicate context and (with SDK MCP cache busting,
      // anthropics/claude-agent-sdk-typescript#247) re-pay full input cost.
      if (!request.sessionId) {
        let bootstrapResult: BootstrapContext | null = null;
        try {
          bootstrapResult = await this.bootstrapContext.assemble(correlationId);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Bootstrap context assembly failed — proceeding without: ${message} [correlationId=${correlationId}]`,
          );
        }

        if (bootstrapResult) {
          request.bootstrapContext = bootstrapResult;
        }
      }

      const response = await this.deliverWithTimeout(
        agent.handle(request, timeout),
        timeout,
        target,
      );

      // Auto-persist successful moderator clarifications to the context store.
      // Mirrors ClarificationHandler.persistDecision() — same key format, scope,
      // and value shape. Non-fatal: persist failure is logged but does not affect
      // the InvokeResponse returned to the caller.
      if (
        target === AgentRole.moderator &&
        response.success &&
        response.result
      ) {
        try {
          await this.contextStore.set({
            scope: ContextScope.project,
            key: `clarification:${caller}:${correlationId}`,
            value: {
              question: request.action,
              answer: response.result,
              askedBy: caller,
              correlationId,
            },
            createdBy: 'moderator',
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to persist clarification decision: ${message} [correlationId=${correlationId}]`,
          );
        }
      }

      this.logger.log(
        `Completed: correlationId=${correlationId} target=${target} success=${response.success}`,
      );

      return response;
    } finally {
      chain.delete(caller);
      if (chain.size === 0) {
        this.callChains.delete(correlationId);
      }
      this.branchLocks.delete(request.branch);
    }
  }

  private deliverWithTimeout(
    delivery: Promise<InvokeResponse>,
    timeout: number,
    target: AgentRole,
  ): Promise<InvokeResponse> {
    return new Promise<InvokeResponse>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          error: `Agent ${target} timed out after ${timeout}ms`,
        });
      }, timeout);
      timer.unref();

      delivery
        .then((response) => {
          clearTimeout(timer);
          resolve(response);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          const message = err instanceof Error ? err.message : 'Unknown error';
          resolve({ success: false, error: message });
        });
    });
  }
}
