import path from 'node:path';
import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  contextStorePath: z.string().min(1),
});

export const contextStoreConfig = registerAs('contextStore', () =>
  schema.parse({
    contextStorePath:
      process.env.CONTEXT_STORE_PATH ??
      path.join(process.env.MCP_WORKSPACE_DIR ?? '.', 'quorum.context'),
  }),
);
