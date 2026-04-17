import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import type { ConfigType } from '@nestjs/config';
import { opensearchConfig } from '../../config/opensearch.config';

/** Index mapping for the quorum-context index. */
const INDEX_SETTINGS = {
  settings: {
    index: {
      knn: true,
    },
  },
  mappings: {
    properties: {
      key: { type: 'keyword' },
      scope: { type: 'keyword' },
      id: { type: 'keyword' },
      value: { type: 'object', enabled: false },
      createdBy: { type: 'keyword' },
      createdAt: { type: 'long' },
      expiresAt: { type: 'long' },
      embeddingText: {
        type: 'text',
        analyzer: 'standard',
      },
      embedding: {
        type: 'knn_vector',
        dimension: 1024,
        method: {
          name: 'hnsw',
          space_type: 'cosinesimil',
          engine: 'faiss',
        },
      },
    },
  },
};

/** Hybrid search pipeline configuration (D8). */
const HYBRID_PIPELINE = {
  description: 'Hybrid search pipeline combining BM25 and k-NN scores',
  phase_results_processors: [
    {
      'normalization-processor': {
        normalization: { technique: 'min_max' },
        combination: {
          technique: 'arithmetic_mean',
          parameters: { weights: [0.3, 0.7] },
        },
      },
    },
  ],
};

const PIPELINE_ID = 'hybrid-search';

@Injectable()
export class OpenSearchSetupService implements OnModuleInit {
  private readonly logger = new Logger(OpenSearchSetupService.name);
  private readonly client: Client;

  constructor(
    @Inject(opensearchConfig.KEY)
    private readonly config: ConfigType<typeof opensearchConfig>,
  ) {
    this.client = new Client({
      node: this.config.node,
      auth: {
        username: this.config.username,
        password: this.config.password,
      },
      ssl: { rejectUnauthorized: false },
    });
  }

  /** Returns the initialized OpenSearch client for downstream injection. */
  getClient(): Client {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.createIndex();
      await this.createPipeline();
      this.logger.log('OpenSearch setup completed successfully');
    } catch (error) {
      this.logger.error(
        'OpenSearch setup failed — running in degraded state',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async createIndex(): Promise<void> {
    const indexName = this.config.index;
    try {
      await this.client.indices.create({
        index: indexName,
        body: INDEX_SETTINGS,
      });
      this.logger.log(`Created index "${indexName}"`);
    } catch (error: unknown) {
      if (this.isResourceAlreadyExistsError(error)) {
        this.logger.log(`Index "${indexName}" already exists — skipping`);
        return;
      }
      throw error;
    }
  }

  private async createPipeline(): Promise<void> {
    await this.client.transport.request({
      method: 'PUT',
      path: `/_search/pipeline/${PIPELINE_ID}`,
      body: HYBRID_PIPELINE,
    });
    this.logger.log(`Created search pipeline "${PIPELINE_ID}"`);
  }

  private isResourceAlreadyExistsError(error: unknown): boolean {
    return this.extractErrorType(error) === 'resource_already_exists_exception';
  }

  /**
   * Extracts the OpenSearch error type from the client error response.
   * The client may surface the error at `error.body.error.type` or
   * `error.meta.body.error.type` depending on the status code path.
   */
  private extractErrorType(error: unknown): string | undefined {
    if (error == null || typeof error !== 'object') return undefined;

    const tryExtract = (obj: unknown): string | undefined => {
      if (obj == null || typeof obj !== 'object') return undefined;
      const rec = obj as { error?: { type?: string } };
      if (rec.error != null && typeof rec.error === 'object') {
        return typeof rec.error.type === 'string' ? rec.error.type : undefined;
      }
      return undefined;
    };

    const err = error as {
      body?: unknown;
      meta?: { statusCode?: number; body?: unknown };
    };

    // Direct body path: error.body.error.type
    const fromBody = tryExtract(err.body);
    if (fromBody) return fromBody;

    // Meta path: error.meta.body.error.type
    if (err.meta?.body) {
      return tryExtract(err.meta.body);
    }

    return undefined;
  }
}
