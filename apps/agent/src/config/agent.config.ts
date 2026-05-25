import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { DEPLOYABLE_AGENT_ROLES } from '@app/common';

const schema = z.object({
  role: z.enum(DEPLOYABLE_AGENT_ROLES),
  workspaceDir: z.string().min(1),
  callbackUrl: z.string().url(),
});

export const agentConfig = registerAs('agent', () =>
  schema.parse({
    role: process.env.AGENT_ROLE || 'developer',
    workspaceDir: process.env.AGENT_WORKSPACE_DIR || '/var/agent-repo',
    callbackUrl:
      process.env.AGENT_CALLBACK_URL ||
      `http://localhost:${process.env.PORT || '3000'}`,
  }),
);
