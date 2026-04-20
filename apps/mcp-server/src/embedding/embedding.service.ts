import { Injectable, Logger } from '@nestjs/common';
import { OllamaClient } from './ollama-client.service';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  private readonly queryPrefix =
    'Represent this sentence for searching relevant passages: ';

  constructor(private readonly client: OllamaClient) {}

  async embedDocument(text: string): Promise<number[] | null> {
    try {
      return await this.client.embed(text);
    } catch (error) {
      this.logger.error(
        `Failed to embed document: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async embedQuery(text: string): Promise<number[] | null> {
    try {
      return await this.client.embed(this.queryPrefix + text);
    } catch (error) {
      this.logger.error(
        `Failed to embed query: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isHealthy();
  }
}
