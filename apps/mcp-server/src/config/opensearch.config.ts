import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  node: z.string().min(1),
  index: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const opensearchConfig = registerAs('opensearch', () =>
  schema.parse({
    node: process.env.OPENSEARCH_NODE || 'http://opensearch:9200',
    index: process.env.OPENSEARCH_INDEX || 'quorum-context',
    username: process.env.OPENSEARCH_USERNAME || 'admin',
    password: process.env.OPENSEARCH_PASSWORD || 'admin',
  }),
);
