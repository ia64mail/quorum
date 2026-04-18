import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { embeddingConfig } from '../config/embedding.config';
import { OllamaClient } from './ollama-client.service';
import { EmbeddingService } from './embedding.service';

@Module({
  imports: [ConfigModule.forFeature(embeddingConfig)],
  providers: [OllamaClient, EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
