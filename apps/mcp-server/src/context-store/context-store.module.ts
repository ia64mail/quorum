import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ContextStore } from '@app/common';
import { contextStoreConfig } from '../config';
import { InMemoryStore } from './in-memory-store';
import { OpenSearchStore } from './opensearch/opensearch-store';
import { OpenSearchModule } from './opensearch/opensearch.module';
import { MigrationService } from './opensearch/migration.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { EmbeddingPipelineService } from '../embedding/embedding-pipeline.service';

/**
 * Provides the {@link ContextStore} injection token backed by either
 * {@link InMemoryStore} or {@link OpenSearchStore}, depending on the
 * `CONTEXT_STORE_BACKEND` env var.
 *
 * Uses a `DynamicModule` with `forRoot()` so the module-level import/useClass
 * decision is resolved at module composition time (before NestJS config providers
 * are available). The env var is read directly — not through the config factory —
 * because module composition happens before DI resolution (architect C2).
 */
@Module({})
export class ContextStoreModule {
  static forRoot(): DynamicModule {
    const backend = process.env.CONTEXT_STORE_BACKEND ?? 'inmemory';

    if (backend === 'opensearch') {
      return {
        module: ContextStoreModule,
        global: true,
        imports: [
          EventEmitterModule.forRoot(),
          OpenSearchModule,
          EmbeddingModule,
          ConfigModule.forFeature(contextStoreConfig),
        ],
        providers: [
          { provide: ContextStore, useClass: OpenSearchStore },
          MigrationService,
          EmbeddingPipelineService,
        ],
        exports: [ContextStore],
      };
    }

    // Default: inmemory
    return {
      module: ContextStoreModule,
      global: true,
      imports: [EventEmitterModule.forRoot()],
      providers: [{ provide: ContextStore, useClass: InMemoryStore }],
      exports: [ContextStore],
    };
  }
}
