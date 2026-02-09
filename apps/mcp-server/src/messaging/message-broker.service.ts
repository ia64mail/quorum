import { Injectable, Logger } from '@nestjs/common';
import type { AgentRole, InvokeRequest, InvokeResponse } from '@app/common';
import { McpServerConfigService } from '../config';
import { AgentRegistry } from '../registry';
import { ROLE_TIMEOUTS } from './role-timeouts';

@Injectable()
export class MessageBroker {
  private readonly logger = new Logger(MessageBroker.name);
  private readonly callChains = new Map<string, Set<AgentRole>>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly config: McpServerConfigService,
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

    // Safeguard 2 — Circular call prevention (O(1) amortized)
    const chain = this.callChains.get(correlationId) ?? new Set<AgentRole>();

    if (chain.has(target)) {
      const error = `Circular call: ${[...chain].join(' → ')} → ${target}`;
      this.logger.warn(`Rejected: ${error} [correlationId=${correlationId}]`);
      return { success: false, error };
    }

    // Safeguard 3 — Agent availability (O(1) lookup)
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

    // Track caller in chain
    chain.add(caller);
    this.callChains.set(correlationId, chain);

    try {
      // Safeguard 4 — Role-based timeout (wraps delivery)
      const timeout =
        ROLE_TIMEOUTS[target] ?? this.config.broker.defaultTimeoutMs;

      // TODO: Before delivering to the agent, query ContextStore for bootstrap context.
      // The broker should call contextStore.search("conversation", "decisions", request.correlationId, 500)
      // and attach the results as a `bootstrapContext` field on the request, so the receiving agent
      // starts with recent conversation decisions. This implements the pull-based context model
      // from docs/context-management.md Pattern 2 (Task Handoff). Requires injecting ContextStore
      // and extending InvokeRequest with a bootstrapContext field. See docs/context-store.md
      // (Integration with Message Broker section) for full design.
      const response = await this.deliverWithTimeout(
        agent.handle(request, timeout),
        timeout,
        target,
      );

      this.logger.log(
        `Completed: correlationId=${correlationId} target=${target} success=${response.success}`,
      );

      return response;
    } finally {
      chain.delete(caller);
      if (chain.size === 0) {
        this.callChains.delete(correlationId);
      }
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
