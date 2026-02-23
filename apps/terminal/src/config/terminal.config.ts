import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  callbackUrl: z.string().url(),
});

export const terminalConfig = registerAs('terminal', () =>
  schema.parse({
    callbackUrl:
      process.env.MCP_CALLBACK_URL ||
      `http://localhost:${process.env.PORT || '3000'}`,
  }),
);
