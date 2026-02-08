import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  maxCallDepth: z.number().int().min(1),
  defaultTimeoutMs: z.number().int().min(1),
});

export const brokerConfig = registerAs('broker', () =>
  schema.parse({
    maxCallDepth: parseInt(process.env.BROKER_MAX_CALL_DEPTH || '5', 10),
    defaultTimeoutMs: parseInt(
      process.env.BROKER_DEFAULT_TIMEOUT_MS || '300000',
      10,
    ),
  }),
);
