import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  ollamaBaseUrl: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().min(1),
});

export const embeddingConfig = registerAs('embedding', () =>
  schema.parse({
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://ollama:11434',
    model: process.env.EMBEDDING_MODEL || 'mxbai-embed-large',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
  }),
);
