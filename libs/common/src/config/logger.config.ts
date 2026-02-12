import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  level: z.enum(['log', 'error', 'warn', 'debug', 'verbose']),
  console: z.boolean(),
  jsonDir: z.string(),
  agentRole: z.string().min(1),
});

export const loggerConfig = registerAs('logger', () =>
  schema.parse({
    level: process.env.LOG_LEVEL || 'log',
    console: process.env.LOG_CONSOLE !== 'false',
    jsonDir: process.env.LOG_JSON_DIR || '',
    agentRole: process.env.AGENT_ROLE || process.env.APP_NAME || 'unknown',
  }),
);
