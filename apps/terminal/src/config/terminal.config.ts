import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  callbackUrl: z.string().url(),
  workspaceDir: z.string().min(1),
});

export const terminalConfig = registerAs('terminal', () =>
  schema.parse({
    callbackUrl:
      process.env.MCP_CALLBACK_URL ||
      `http://localhost:${process.env.PORT || '3000'}`,
    workspaceDir: process.env.TERMINAL_WORKSPACE_DIR || '/mnt/quorum/workspace',
  }),
);
