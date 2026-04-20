import { Injectable, Logger, Optional } from '@nestjs/common';
import { OpenSearchSetupService } from '../context-store/opensearch/opensearch-setup.service';
import { EmbeddingService } from '../embedding/embedding.service';

export interface DependencyStatus {
  opensearch: 'up' | 'down';
  ollama: 'up' | 'down';
}

export interface HealthResponse {
  status: 'ok';
  dependencies?: DependencyStatus;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Optional() private readonly openSearchSetup?: OpenSearchSetupService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  async check(): Promise<HealthResponse> {
    // inmemory backend: no dependencies to check
    if (!this.openSearchSetup) {
      return { status: 'ok' };
    }

    const [opensearch, ollama] = await Promise.all([
      this.checkOpenSearch(),
      this.checkOllama(),
    ]);

    return {
      status: 'ok',
      dependencies: { opensearch, ollama },
    };
  }

  private async checkOpenSearch(): Promise<'up' | 'down'> {
    try {
      const client = this.openSearchSetup!.getClient();
      const response = await client.cluster.health({});
      const body = response.body as { status?: string };
      return body.status ? 'up' : 'down';
    } catch (error) {
      this.logger.warn(
        `OpenSearch health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'down';
    }
  }

  private async checkOllama(): Promise<'up' | 'down'> {
    if (!this.embeddingService) {
      return 'down';
    }
    try {
      return (await this.embeddingService.isAvailable()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
