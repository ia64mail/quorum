import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Client } from '@opensearch-project/opensearch';
import type { ChangeEvent } from '@app/common';
import { CompositeKeyBuilder } from '@app/common';
import { opensearchConfig } from '../config/opensearch.config';
import { OpenSearchSetupService } from '../context-store/opensearch/opensearch-setup.service';
import { EmbeddingService } from './embedding.service';

/** Maximum number of retry attempts before abandoning a queue item. */
const MAX_RETRIES = 3;

/** Maximum backoff delay in milliseconds. */
const MAX_BACKOFF_MS = 8000;

/** Internal queue item representing a document awaiting embedding. */
interface QueueItem {
  compositeKey: string;
  retryCount: number;
}

/** Shape of an OpenSearch get response with selective _source. */
interface GetResponse {
  body: { _source: { embeddingText?: string } };
}

/** Shape of an OpenSearch search response returning only _id. */
interface BackfillSearchResponse {
  body: { hits: { hits: Array<{ _id: string }> } };
}

/**
 * Async embedding pipeline that computes vectors for Context Store records.
 *
 * Subscribes to `'context.change'` events emitted by {@link OpenSearchStore}
 * on every `set()` call. For each event, fetches the pre-rendered `embeddingText`
 * from OpenSearch, computes the embedding via Ollama ({@link EmbeddingService}),
 * and partial-updates the OpenSearch document with the vector.
 *
 * On startup, backfills embeddings for any documents that have `embeddingText`
 * but lack an `embedding` vector (e.g., after a restart while Ollama was down).
 */
@Injectable()
export class EmbeddingPipelineService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingPipelineService.name);
  private readonly client: Client;
  private readonly queue: QueueItem[] = [];
  private processing = false;

  constructor(
    private readonly setupService: OpenSearchSetupService,
    private readonly embeddingService: EmbeddingService,
    @Inject(opensearchConfig.KEY)
    private readonly config: ConfigType<typeof opensearchConfig>,
  ) {
    this.client = this.setupService.getClient();
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async onModuleInit(): Promise<void> {
    await this.backfill();
  }

  /* ------------------------------------------------------------------ */
  /*  Event handler                                                      */
  /* ------------------------------------------------------------------ */

  @OnEvent('context.change')
  handleContextChange(event: ChangeEvent): void {
    if (event.action !== 'set') return;
    const compositeKey = CompositeKeyBuilder.build(
      event.scope,
      event.key,
      event.id,
    );
    this.enqueue(compositeKey);
  }

  /* ------------------------------------------------------------------ */
  /*  Queue management                                                   */
  /* ------------------------------------------------------------------ */

  private enqueue(compositeKey: string, retryCount = 0): void {
    this.queue.push({ compositeKey, retryCount });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.processItem(item);
      }
    } finally {
      this.processing = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Item processing                                                    */
  /* ------------------------------------------------------------------ */

  private async processItem(item: QueueItem): Promise<void> {
    const { compositeKey } = item;

    // 1. Fetch embeddingText from OpenSearch
    let embeddingText: string | undefined;
    try {
      const response = (await this.client.get({
        index: this.config.index,
        id: compositeKey,
        _source_includes: ['embeddingText'],
      })) as GetResponse;
      embeddingText = response.body._source.embeddingText;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.debug(
          `Document [${compositeKey}] no longer exists — skipping`,
        );
        return;
      }
      this.logger.error(
        `Failed to fetch document [${compositeKey}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleRetry(item);
      return;
    }

    if (!embeddingText) {
      this.logger.debug(
        `Document [${compositeKey}] has no embeddingText — skipping`,
      );
      return;
    }

    // 2. Compute embedding
    const embedding = await this.embeddingService.embedDocument(embeddingText);
    if (!embedding) {
      this.scheduleRetry(item);
      return;
    }

    // 3. Partial-update the document with the embedding vector
    try {
      await this.client.update({
        index: this.config.index,
        id: compositeKey,
        body: { doc: { embedding } },
      });
      this.logger.debug(`Embedded document [${compositeKey}]`);
    } catch (error) {
      this.logger.error(
        `Failed to update document [${compositeKey}] with embedding: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleRetry(item);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Retry logic                                                        */
  /* ------------------------------------------------------------------ */

  private scheduleRetry(item: QueueItem): void {
    if (item.retryCount >= MAX_RETRIES) {
      this.logger.warn(
        `Abandoned embedding for [${item.compositeKey}] after ${MAX_RETRIES} retries`,
      );
      return;
    }

    const delay = Math.min(1000 * 2 ** item.retryCount, MAX_BACKOFF_MS);
    setTimeout(() => {
      this.enqueue(item.compositeKey, item.retryCount + 1);
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /*  Startup backfill                                                   */
  /* ------------------------------------------------------------------ */

  private async backfill(): Promise<void> {
    try {
      const response = (await this.client.search({
        index: this.config.index,
        body: {
          query: {
            bool: {
              must: { exists: { field: 'embeddingText' } },
              must_not: { exists: { field: 'embedding' } },
            },
          },
          size: 10000,
          _source: false,
        },
      })) as BackfillSearchResponse;

      const hits = response.body.hits.hits;
      if (hits.length === 0) {
        this.logger.debug('No documents need embedding backfill');
        return;
      }

      this.logger.log(`Backfilling embeddings for ${hits.length} document(s)`);
      for (const hit of hits) {
        this.enqueue(hit._id);
      }
    } catch (error) {
      this.logger.warn(
        `Embedding backfill skipped — OpenSearch unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

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
