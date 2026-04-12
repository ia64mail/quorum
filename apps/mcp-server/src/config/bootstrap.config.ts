import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  enabled: z.boolean(),
  maxTokens: z.number().int().min(1),
  projectRatio: z.number().min(0).max(1),
});

export const bootstrapConfig = registerAs('bootstrap', () =>
  schema.parse({
    enabled: process.env.BOOTSTRAP_ENABLED !== 'false',
    maxTokens: parseInt(process.env.BOOTSTRAP_MAX_TOKENS || '1000', 10),
    projectRatio: parseFloat(process.env.BOOTSTRAP_PROJECT_RATIO || '0.6'),
  }),
);
