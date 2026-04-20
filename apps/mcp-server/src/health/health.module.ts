import { DynamicModule, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { OpenSearchModule } from '../context-store/opensearch/opensearch.module';
import { EmbeddingModule } from '../embedding/embedding.module';

/**
 * Health check module. When the opensearch backend is active, imports
 * {@link OpenSearchModule} and {@link EmbeddingModule} to enable
 * dependency health reporting. The env var is read directly at module
 * composition time (same pattern as {@link ContextStoreModule}).
 */
@Module({})
export class HealthModule {
  static forRoot(): DynamicModule {
    const backend = process.env.CONTEXT_STORE_BACKEND ?? 'inmemory';
    const imports =
      backend === 'opensearch' ? [OpenSearchModule, EmbeddingModule] : [];

    return {
      module: HealthModule,
      imports,
      controllers: [HealthController],
      providers: [HealthService],
    };
  }
}
