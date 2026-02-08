import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  role: z.enum(['architect', 'teamlead', 'developer', 'qa', 'productowner']),
  workspaceDir: z.string().min(1),
});

export const agentConfig = registerAs('agent', () =>
  schema.parse({
    role: process.env.AGENT_ROLE || 'developer',
    workspaceDir: process.env.AGENT_WORKSPACE_DIR || '/mnt/quorum/workspace',
  }),
);
