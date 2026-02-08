import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  defaultMaxTokens: z.number().int().min(1),
  tokenCharRatio: z.number().int().min(1),
});

export const contextConfig = registerAs('context', () =>
  schema.parse({
    defaultMaxTokens: parseInt(
      process.env.CONTEXT_DEFAULT_MAX_TOKENS || '2000',
      10,
    ),
    tokenCharRatio: parseInt(process.env.CONTEXT_TOKEN_CHAR_RATIO || '4', 10),
  }),
);
