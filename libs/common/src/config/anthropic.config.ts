import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

export const anthropicConfig = registerAs('anthropic', () =>
  schema.parse({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
  }),
);
