import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  serverUrl: z.string().url(),
});

export const mcpConfig = registerAs('mcp', () =>
  schema.parse({
    serverUrl: process.env.MCP_SERVER_URL || 'http://mcp-server:3000',
  }),
);
