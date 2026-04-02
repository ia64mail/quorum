import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BootstrapContext,
  BootstrapContextMeta,
  ContextScope,
  ContextStore,
} from '@app/common';
import { McpServerConfigService } from '../config';

@Injectable()
export class BootstrapContextService {
  private readonly logger = new Logger(BootstrapContextService.name);

  constructor(
    @Inject(ContextStore)
    private readonly contextStore: ContextStore,
    private readonly config: McpServerConfigService,
  ) {}

  async assemble(correlationId?: string): Promise<BootstrapContext | null> {
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

    // Step 3 — Fetch project items (always)
    const projectItems = await this.contextStore.getAll(ContextScope.project);

    // Step 4 — Fetch conversation items (only when correlationId is provided)
    const conversationItems = correlationId
      ? await this.contextStore.getAll(ContextScope.conversation, correlationId)
      : {};

    // Step 5 — Apply budget to project items (prefer newer — reverse insertion order)
    const { selected: selectedProject, tokensUsed: projectTokensUsed } =
      this.applyBudget(projectItems, projectBudget);

    // Step 6 — Reclaim unused project budget
    conversationBudget += projectBudget - projectTokensUsed;

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

  private applyBudget(
    items: Record<string, unknown>,
    budget: number,
  ): { selected: Record<string, unknown>; tokensUsed: number } {
    const selected: Record<string, unknown> = {};
    let tokensUsed = 0;

    // Reverse entry order to prefer newer items (later in Map insertion order)
    const entries = Object.entries(items).reverse();

    for (const [key, value] of entries) {
      const tokens = this.estimateTokens(value);
      if (tokensUsed + tokens > budget) {
        continue;
      }
      tokensUsed += tokens;
      selected[key] = value;
    }

    return { selected, tokensUsed };
  }
}
