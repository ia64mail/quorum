import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { embeddingConfig } from '../config/embedding.config';

@Injectable()
export class OllamaClient {
  private readonly logger = new Logger(OllamaClient.name);

  constructor(
    @Inject(embeddingConfig.KEY)
    private readonly config: ConfigType<typeof embeddingConfig>,
  ) {}

  async embed(text: string): Promise<number[]> {
    const url = `${this.config.ollamaBaseUrl}/api/embed`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embed request failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as {
      embeddings?: number[][];
    };

    if (
      !body.embeddings ||
      !Array.isArray(body.embeddings) ||
      body.embeddings.length === 0
    ) {
      throw new Error(
        'Ollama response missing embeddings field or empty array',
      );
    }

    const vector = body.embeddings[0];

    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`,
      );
    }

    return vector;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const url = `${this.config.ollamaBaseUrl}/api/tags`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch (error) {
      this.logger.warn(
        `Ollama health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
