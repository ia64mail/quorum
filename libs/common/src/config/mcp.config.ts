import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  serverUrl: z.string().url(),
  requestTimeoutMs: z.coerce.number().int().positive(),
});

export const mcpConfig = registerAs('mcp', () =>
  schema.parse({
    serverUrl: process.env.MCP_SERVER_URL || 'http://mcp-server:3000',
    requestTimeoutMs: process.env.MCP_REQUEST_TIMEOUT_MS || 1_800_000,
  }),
);
