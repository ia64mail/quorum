import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  port: z.number().int().min(1).max(65535),
  nodeEnv: z.enum(['development', 'production', 'test']),
});

export const appConfig = registerAs('app', () =>
  schema.parse({
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  }),
);
