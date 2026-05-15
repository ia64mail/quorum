import { mkdirSync } from 'fs';
import { join } from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as winston from 'winston';

/**
 * Full trace record written to the context-search JSONL stream.
 * Combines the backend {@link SearchTrace} with session/query metadata.
 */
export interface ContextSearchTraceRecord {
  timestamp: string;
  queryId: string;
  correlationId: string | null;
  callerRole: string | null;
  scope: string;
  id: string | null;
  queryText: string;
  maxTokens: number;
  engine: string;
  durationMs: number;
  hitCountRaw: number;
  hitCountReturned: number;
  truncatedByTokenBudget: boolean;
  results: Array<{
    key: string;
    score: number | null;
    snippet: string;
    tokensEstimate: number;
    includedInResult: boolean;
  }>;
  errorMessage: string | null;
}

function startupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
}

function traceJsonFormat(): winston.Logform.Format {
  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const line: Record<string, unknown> = {
        timestamp: info['timestamp'],
        level: 'info',
        context: 'ContextSearchTrace',
        message: info.message,
        agentRole: 'mcp-server',
      };

      if (info['extra'] != null) {
        line['extra'] = info['extra'];
      }

      return JSON.stringify(line);
    }),
  );
}

@Injectable()
export class ContextSearchTraceLogger implements OnModuleInit {
  private logger!: winston.Logger;

  onModuleInit(): void {
    const jsonDir = process.env.LOG_JSON_DIR || '';
    const transports: winston.transport[] = [];

    if (jsonDir) {
      mkdirSync(jsonDir, { recursive: true });
      const filename = `context-search-${startupTimestamp()}.jsonl`;
      transports.push(
        new winston.transports.File({
          filename: join(jsonDir, filename),
          level: 'info',
          format: traceJsonFormat(),
        }),
      );
    }

    if (transports.length === 0) {
      transports.push(new winston.transports.Console({ silent: true }));
    }

    this.logger = winston.createLogger({
      level: 'info',
      transports,
    });
  }

  log(record: ContextSearchTraceRecord): void {
    this.logger.info(record.queryId, { extra: record });
  }
}
