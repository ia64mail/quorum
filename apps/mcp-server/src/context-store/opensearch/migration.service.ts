import { readFile } from 'node:fs/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Client } from '@opensearch-project/opensearch';
import { ContextItem, toEmbeddingText } from '@app/common';
import { opensearchConfig } from '../../config/opensearch.config';
import { contextStoreConfig } from '../../config';
import { OpenSearchSetupService } from './opensearch-setup.service';

/**
 * One-time migration service that imports existing `quorum.context` records
 * into OpenSearch on first startup.
 *
 * Reads the JSON file written by {@link InMemoryStore.onModuleDestroy()},
 * filters expired records, and indexes each surviving record with its
 * `embeddingText` field. The `embedding` vector is NOT set — the
 * {@link EmbeddingPipelineService}'s startup backfill computes vectors
 * automatically for documents that have `embeddingText` but no `embedding`.
 *
 * Idempotency: skips migration when the OpenSearch index already contains
 * records (either from a prior migration or normal operations).
 *
 * The original `quorum.context` file is preserved as a backup.
 */
@Injectable()
export class MigrationService implements OnModuleInit {
  private readonly logger = new Logger(MigrationService.name);
  private readonly client: Client;

  constructor(
    private readonly setupService: OpenSearchSetupService,
    @Inject(opensearchConfig.KEY)
    private readonly osConfig: ConfigType<typeof opensearchConfig>,
    @Inject(contextStoreConfig.KEY)
    private readonly csConfig: ConfigType<typeof contextStoreConfig>,
  ) {
    this.client = this.setupService.getClient();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.migrate();
    } catch (error) {
      this.logger.warn(
        `Migration failed — system will start without imported records: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async migrate(): Promise<void> {
    // 1. Idempotency guard — skip if index already has records
    let existingCount: number;
    try {
      const countResponse = (await this.client.count({
        index: this.osConfig.index,
      })) as { body: { count: number } };
      existingCount = countResponse.body.count;
    } catch (error) {
      this.logger.warn(
        `OpenSearch unavailable — skipping migration: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (existingCount > 0) {
      this.logger.log(
        `Index already contains ${existingCount} records — skipping migration`,
      );
      return;
    }

    // 2. Read the quorum.context file
    let raw: string;
    try {
      raw = await readFile(this.csConfig.contextStorePath, 'utf-8');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        this.logger.log('No quorum.context file found — nothing to migrate');
        return;
      }
      this.logger.warn(`Failed to read quorum.context file: ${error.message}`);
      return;
    }

    // 3. Parse the file
    if (!raw.trim()) {
      this.logger.warn('quorum.context file is empty — nothing to migrate');
      return;
    }

    let entries: [string, ContextItem][];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.logger.warn(
          'quorum.context file does not contain an array — skipping migration',
        );
        return;
      }
      entries = parsed as [string, ContextItem][];
    } catch {
      this.logger.warn(
        'quorum.context file contains malformed JSON — skipping migration',
      );
      return;
    }

    // 4. Filter expired records and index into OpenSearch
    const now = Date.now();
    let migrated = 0;
    let failed = 0;

    for (const [compositeKey, item] of entries) {
      // Skip expired records
      if (item.expiresAt !== undefined && now >= item.expiresAt) {
        continue;
      }

      const embeddingText = toEmbeddingText(item);

      try {
        await this.client.index({
          index: this.osConfig.index,
          id: compositeKey,
          body: { ...item, id: item.id ?? '_', embeddingText },
          refresh: true,
        });
        migrated++;
      } catch (error) {
        failed++;
        this.logger.warn(
          `Failed to index record [${compositeKey}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failed > 0) {
      this.logger.log(
        `Migrated ${migrated} records from quorum.context into OpenSearch (${failed} failed)`,
      );
    } else {
      this.logger.log(
        `Migrated ${migrated} records from quorum.context into OpenSearch`,
      );
    }
  }
}
