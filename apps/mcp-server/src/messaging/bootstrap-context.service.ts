import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BootstrapContext,
  BootstrapContextMeta,
  ContextScope,
  ContextStore,
} from '@app/common';
import type { SearchTrace } from '@app/common';
import { McpServerConfigService } from '../config';
import { ContextSearchTraceLogger } from '../observability';

@Injectable()
export class BootstrapContextService {
  private readonly logger = new Logger(BootstrapContextService.name);

  constructor(
    @Inject(ContextStore)
    private readonly contextStore: ContextStore,
    private readonly config: McpServerConfigService,
    private readonly traceLogger: ContextSearchTraceLogger,
  ) {}

  async assemble(
    correlationId?: string,
    query?: string,
  ): Promise<BootstrapContext | null> {
    // Step 1 — Check enabled
    if (!this.config.bootstrap.enabled) {
      this.logger.debug(
        `Bootstrap disabled — returning null [correlationId=${correlationId ?? 'none'}]`,
      );
      return null;
    }

    // Step 2 — Calculate budgets
    const { maxTokens, projectRatio } = this.config.bootstrap;
    const projectBudget = Math.floor(maxTokens * projectRatio);
    let conversationBudget = maxTokens - projectBudget;

    // Step 3/5 — Select project items: relevance-ranked search when a
    // searchQuery is present and the backend supports ranked search (#70),
    // recency getAll + greedy bin-pack otherwise (unchanged, strictly a
    // fallback — never a regression from pre-#70 behavior).
    const { selected: selectedProject, tokensUsed: projectTokensUsed } =
      await this.selectProjectItems(query, projectBudget, correlationId);

    // Step 4 — Fetch conversation items (only when correlationId is provided)
    const conversationItems = correlationId
      ? await this.contextStore.getAll(ContextScope.conversation, correlationId)
      : {};

    // Step 6 — Reclaim unused project budget. Clamped at 0: the #61
    // top-hit floor means the search path can return a single oversized
    // hit with projectTokensUsed > projectBudget (`search` guarantees at
    // least the top hit even when it alone exceeds the budget) — an
    // oversized project selection reclaims nothing rather than driving
    // conversationBudget negative (which would silently zero out
    // conversation-scope selection in applyBudget below).
    conversationBudget += Math.max(0, projectBudget - projectTokensUsed);

    // Step 7 — Apply budget to conversation items
    const {
      selected: selectedConversation,
      tokensUsed: conversationTokensUsed,
    } = this.applyBudget(conversationItems, conversationBudget);

    // Step 8 — Check emptiness
    const projectCount = Object.keys(selectedProject).length;
    const conversationCount = Object.keys(selectedConversation).length;

    if (projectCount === 0 && conversationCount === 0) {
      this.logger.debug(
        `No context items to inject — returning null [correlationId=${correlationId ?? 'none'}]`,
      );
      return null;
    }

    // Step 9 — Build metadata
    const scopesQueried: BootstrapContextMeta['scopesQueried'] = ['project'];
    if (correlationId) {
      scopesQueried.push('conversation');
    }

    const meta: BootstrapContextMeta = {
      itemCount: projectCount + conversationCount,
      estimatedTokens: projectTokensUsed + conversationTokensUsed,
      scopesQueried,
    };

    this.logger.debug(
      `Assembled bootstrap context: ${meta.itemCount} items, ${meta.estimatedTokens} tokens, scopes=[${meta.scopesQueried.join(', ')}] [correlationId=${correlationId ?? 'none'}]`,
    );

    // Step 10 — Return
    return {
      project: selectedProject,
      conversation: selectedConversation,
      meta,
    };
  }

  private estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / 4);
  }

  /**
   * Select project-scope items for bootstrap injection.
   *
   * Relevance path (#70): when `query` is present and the Context Store
   * backend is OpenSearch, delegate to `ContextStore.search` — it is
   * already scope-filtered and token-budgeted, returns relevance-ranked
   * items, and (since #61) guarantees at least the top hit even when it
   * exceeds the budget. Falls back to the recency path whenever:
   * - `query` is absent;
   * - the backend is InMemoryStore (its `search` is substring-only, not
   *   ranked — see ContextStore.search doc);
   * - `search` throws or returns an empty result set (embedding-service
   *   downtime already degrades to BM25-only *inside* search; a true empty
   *   result here still falls back to recency so bootstrap is never worse
   *   than the pre-#70 behavior).
   *
   * Observability (#70 follow-up): the ranked search leg is traced via
   * `ContextSearchTraceLogger`, mirroring the `context_query` MCP tool path
   * (`mcp.service.ts`), tagged `source: 'bootstrap'` so it is attributable.
   * A trace is emitted only when the ranked search actually produced (or
   * attempted to produce, on error) the returned selection — the recency
   * fallback branch, for any of the reasons above including a search that
   * completes with zero hits, emits no trace, by design (parity with
   * `context_query`, which only logs when a ranked search ran to a result).
   */
  private async selectProjectItems(
    query: string | undefined,
    projectBudget: number,
    correlationId?: string,
  ): Promise<{ selected: Record<string, unknown>; tokensUsed: number }> {
    const canSearch =
      !!query && this.config.contextStore.backend === 'opensearch';

    if (canSearch) {
      // Narrowed by canSearch above, but kept as a local const for the
      // non-null query reference passed into search/trace emission.
      const searchQuery = query;
      let capturedTrace: SearchTrace | undefined;

      try {
        const hits = await this.contextStore.search(
          ContextScope.project,
          searchQuery,
          undefined,
          projectBudget,
          (trace) => {
            capturedTrace = trace;
          },
        );

        if (hits.length > 0) {
          const selected: Record<string, unknown> = {};
          let tokensUsed = 0;
          for (const item of hits) {
            selected[item.key] = item.value;
            tokensUsed += this.estimateTokens(item.value);
          }
          this.emitBootstrapSearchTrace(
            capturedTrace,
            searchQuery,
            projectBudget,
            correlationId,
          );
          return { selected, tokensUsed };
        }

        this.logger.debug(
          'Project relevance search returned no hits — falling back to recency',
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Project relevance search failed — falling back to recency: ${message}`,
        );
        // Per QRM7-016, OpenSearchStore.search can fire onTrace (capturing
        // errorMessage) even when it subsequently throws — emit whatever
        // was captured so the failure stays auditable, even though
        // selection still falls back to recency below.
        this.emitBootstrapSearchTrace(
          capturedTrace,
          searchQuery,
          projectBudget,
          correlationId,
        );
      }
    }

    // Recency fallback (pre-#70 behavior, unchanged). No trace emitted.
    const projectItems = await this.contextStore.getAll(ContextScope.project);
    return this.applyBudget(projectItems, projectBudget);
  }

  /**
   * Emit a `ContextSearchTrace` record for the bootstrap project-scope
   * relevance search (#70 follow-up), tagged `source: 'bootstrap'`. No-op
   * when `trace` is undefined (search never reached the `onTrace` callback).
   */
  private emitBootstrapSearchTrace(
    trace: SearchTrace | undefined,
    queryText: string,
    maxTokens: number,
    correlationId?: string,
  ): void {
    if (!trace) {
      return;
    }

    this.traceLogger.log({
      timestamp: new Date().toISOString(),
      queryId: randomUUID(),
      correlationId: correlationId ?? null,
      callerRole: null,
      source: 'bootstrap',
      scope: ContextScope.project,
      id: null,
      queryText,
      maxTokens,
      engine: trace.engine,
      durationMs: trace.durationMs,
      hitCountRaw: trace.hitCountRaw,
      hitCountReturned: trace.hitCountReturned,
      truncatedByTokenBudget: trace.truncatedByTokenBudget,
      results: trace.results,
      errorMessage: trace.errorMessage,
    });
  }

  private applyBudget(
    items: Record<string, unknown>,
    budget: number,
  ): { selected: Record<string, unknown>; tokensUsed: number } {
    const selected: Record<string, unknown> = {};
    let tokensUsed = 0;

    // Defensive floor: a negative budget must never reach the loop below —
    // whatever the caller computed (e.g. a reclaim), treat anything below 0
    // as 0 so this never accidentally admits items on a negative budget.
    const safeBudget = Math.max(0, budget);

    // Reverse entry order to prefer newer items (later in Map insertion order)
    const entries = Object.entries(items).reverse();

    for (const [key, value] of entries) {
      const tokens = this.estimateTokens(value);
      if (tokensUsed + tokens > safeBudget) {
        continue;
      }
      tokensUsed += tokens;
      selected[key] = value;
    }

    return { selected, tokensUsed };
  }
}
