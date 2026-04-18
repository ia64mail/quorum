import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Client } from '@opensearch-project/opensearch';
import {
  ChangeEvent,
  CompositeKeyBuilder,
  ContextItem,
  ContextScope,
  ContextStats,
  ContextStore,
  SetParams,
  toEmbeddingText,
} from '@app/common';
import { opensearchConfig } from '../../config/opensearch.config';
import { OpenSearchSetupService } from './opensearch-setup.service';
import { EmbeddingService } from '../../embedding/embedding.service';

/** OpenSearch get-document response shape. */
interface GetResponse {
  body: { _source: ContextItem };
}

/** OpenSearch search response shape. */
interface SearchResponse<T = ContextItem> {
  body: { hits: { hits: Array<{ _source: T }> } };
}

/**
 * Default number of nearest neighbors for the k-NN leg of hybrid search.
 * Context stores are small (<1000 items per scope), so 100 ensures the
 * token budget — not k — is the binding constraint on result set size.
 */
const DEFAULT_KNN_K = 100;

/**
 * OpenSearch-backed Context Store implementing hybrid BM25 + k-NN vector search.
 *
 * Replaces {@link InMemoryStore} in production. The swap is config-driven via
 * `CONTEXT_STORE_BACKEND` env var and the `ContextStoreModule.forRoot()` dynamic module.
 *
 * Write path: `set()` indexes documents with `embeddingText` for immediate BM25 search.
 * The `embedding` vector is computed asynchronously by the Embedding Pipeline (QRM5-006).
 *
 * Search path: `search()` uses hybrid queries through the `hybrid-search` pipeline
 * when embeddings are available, falling back to BM25-only when Ollama is unavailable.
 */
@Injectable()
export class OpenSearchStore extends ContextStore {
  private readonly logger = new Logger(OpenSearchStore.name);
  private readonly client: Client;

  constructor(
    private readonly setupService: OpenSearchSetupService,
    private readonly embeddingService: EmbeddingService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(opensearchConfig.KEY)
    private readonly osConfig: ConfigType<typeof opensearchConfig>,
  ) {
    super();
    this.client = this.setupService.getClient();
  }

  /* ------------------------------------------------------------------ */
  /*  set                                                                */
  /* ------------------------------------------------------------------ */

  async set(params: SetParams): Promise<void> {
    const now = Date.now();

    const item: ContextItem = {
      key: params.key,
      value: params.value,
      scope: params.scope,
      // C1: Always store id so OpenSearch term queries match project-scope docs
      id: params.id ?? '_',
      createdAt: now,
    };

    if (params.createdBy !== undefined) {
      item.createdBy = params.createdBy;
    }
    if (params.ttl !== undefined) {
      item.expiresAt = now + params.ttl;
    }

    const embeddingText = toEmbeddingText(item);
    const compositeKey = CompositeKeyBuilder.build(
      params.scope,
      params.key,
      params.id,
    );

    try {
      await this.client.index({
        index: this.osConfig.index,
        id: compositeKey,
        body: { ...item, embeddingText },
        refresh: true,
      });
    } catch (error) {
      this.logger.error(
        `Failed to index document [${compositeKey}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.emitChange(params.scope, params.key, 'set', params.id);
  }

  /* ------------------------------------------------------------------ */
  /*  get                                                                */
  /* ------------------------------------------------------------------ */

  async get(scope: ContextScope, key: string, id?: string): Promise<unknown> {
    const compositeKey = CompositeKeyBuilder.build(scope, key, id);

    let source: ContextItem;
    try {
      const response = (await this.client.get({
        index: this.osConfig.index,
        id: compositeKey,
      })) as GetResponse;
      source = response.body._source;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return undefined;
      }
      this.logger.error(
        `Failed to get document [${compositeKey}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }

    // Lazy TTL expiration
    if (source.expiresAt !== undefined && Date.now() >= source.expiresAt) {
      try {
        await this.client.delete({
          index: this.osConfig.index,
          id: compositeKey,
          refresh: true,
        });
      } catch (error) {
        this.logger.error(
          `Failed to delete expired document [${compositeKey}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.emitChange(scope, key, 'expire', id);
      return undefined;
    }

    return source.value;
  }

  /* ------------------------------------------------------------------ */
  /*  getAll                                                             */
  /* ------------------------------------------------------------------ */

  async getAll(
    scope: ContextScope,
    id?: string,
  ): Promise<Record<string, unknown>> {
    const filters = [
      { term: { scope: scope } },
      { term: { id: id ?? '_' } },
      this.buildTtlFilter(),
    ];

    try {
      const response = (await this.client.search({
        index: this.osConfig.index,
        body: {
          query: { bool: { filter: filters } },
          size: 10000,
          _source: { excludes: ['embedding', 'embeddingText'] },
        },
      })) as SearchResponse;

      const result: Record<string, unknown> = {};
      for (const hit of response.body.hits.hits) {
        result[hit._source.key] = hit._source.value;
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to getAll for scope=${scope}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  /* ------------------------------------------------------------------ */
  /*  search                                                             */
  /* ------------------------------------------------------------------ */

  async search(
    scope: ContextScope,
    query: string,
    id?: string,
    maxTokens?: number,
  ): Promise<ContextItem[]> {
    const scopeAndTtlFilter = [
      { term: { scope: scope } },
      { term: { id: id ?? '_' } },
      this.buildTtlFilter(),
    ];

    let body: Record<string, unknown>;

    try {
      const queryEmbedding = await this.embeddingService.embedQuery(query);

      if (queryEmbedding) {
        // Hybrid query: BM25 + k-NN
        this.logger.debug(`Hybrid search for scope=${scope}: "${query}"`);
        body = {
          _source: { excludes: ['embedding', 'embeddingText'] },
          size: DEFAULT_KNN_K,
          query: {
            hybrid: {
              queries: [
                // BM25 leg
                {
                  bool: {
                    must: { match: { embeddingText: query } },
                    filter: scopeAndTtlFilter,
                  },
                },
                // k-NN leg
                {
                  knn: {
                    embedding: {
                      vector: queryEmbedding,
                      k: DEFAULT_KNN_K,
                      filter: {
                        bool: { filter: scopeAndTtlFilter },
                      },
                    },
                  },
                },
              ],
            },
          },
          search_pipeline: 'hybrid-search',
        };
      } else {
        // BM25-only fallback
        this.logger.debug(
          `BM25-only search for scope=${scope} (embedding unavailable): "${query}"`,
        );
        body = {
          _source: { excludes: ['embedding', 'embeddingText'] },
          size: DEFAULT_KNN_K,
          query: {
            bool: {
              must: { match: { embeddingText: query } },
              filter: scopeAndTtlFilter,
            },
          },
        };
      }

      const response = (await this.client.search({
        index: this.osConfig.index,
        body,
      })) as SearchResponse;

      // Apply token budget
      const tokenBudget = maxTokens ?? Infinity;
      let consumed = 0;
      const results: ContextItem[] = [];

      for (const hit of response.body.hits.hits) {
        const tokens = this.estimateTokens(hit._source.value);
        if (consumed + tokens > tokenBudget) {
          break;
        }
        consumed += tokens;
        results.push(hit._source);
      }

      return results;
    } catch (error) {
      this.logger.error(
        `Failed to search scope=${scope}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /*  getStats                                                           */
  /* ------------------------------------------------------------------ */

  async getStats(scope?: ContextScope, id?: string): Promise<ContextStats> {
    // C4: When scope is undefined, use match_all with only TTL filter
    const filters: Record<string, unknown>[] = [this.buildTtlFilter()];

    if (scope !== undefined) {
      filters.push({ term: { scope: scope } });
      filters.push({ term: { id: id ?? '_' } });
    }

    try {
      const response = (await this.client.search({
        index: this.osConfig.index,
        body: {
          query: { bool: { filter: filters } },
          size: 10000,
          _source: { includes: ['value'] },
        },
      })) as SearchResponse<{ value: unknown }>;

      const { hits } = response.body.hits;
      let estimatedTokens = 0;
      for (const hit of hits) {
        estimatedTokens += this.estimateTokens(hit._source.value);
      }

      return {
        itemCount: hits.length,
        estimatedTokens,
      };
    } catch (error) {
      this.logger.error(
        `Failed to getStats: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { itemCount: 0, estimatedTokens: 0 };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / 4);
  }

  private emitChange(
    scope: ContextScope,
    key: string,
    action: ChangeEvent['action'],
    id?: string,
  ): void {
    const event: ChangeEvent = { scope, key, action };
    if (id !== undefined) {
      event.id = id;
    }
    this.eventEmitter.emit('context.change', event);
  }

  /**
   * Build a TTL filter clause that matches documents where either
   * `expiresAt` is absent (no expiry) or `expiresAt > now` (not yet expired).
   */
  private buildTtlFilter(): Record<string, unknown> {
    return {
      bool: {
        should: [
          { bool: { must_not: { exists: { field: 'expiresAt' } } } },
          { range: { expiresAt: { gt: Date.now() } } },
        ],
      },
    };
  }

  /**
   * Check whether an OpenSearch client error indicates a missing document (404).
   */
  private isNotFoundError(error: unknown): boolean {
    if (error == null || typeof error !== 'object') return false;

    const err = error as {
      statusCode?: number;
      meta?: { statusCode?: number };
    };

    if (err.statusCode === 404) return true;
    if (err.meta?.statusCode === 404) return true;

    return false;
  }
}
