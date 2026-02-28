import { mkdirSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import { QuorumLogger } from './quorum-logger.service';

/** NestJS log levels mapped to winston numeric priorities (lower = more severe). */
const CUSTOM_LEVELS: winston.config.AbstractConfigSetLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

/** NestJS-style colors per winston level. */
const LEVEL_COLORS: winston.config.AbstractConfigSetColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'magenta',
  verbose: 'cyan',
};

winston.addColors(LEVEL_COLORS);

/** Map NestJS level name to winston level name for the minimum-level setting. */
const NEST_LEVEL_TO_WINSTON: Record<string, string> = {
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'verbose',
};

/** Maps a nestLevel field back to a NestJS-style display label. */
const NEST_LEVEL_LABELS: Record<string, string> = {
  log: 'LOG',
  error: 'ERROR',
  warn: 'WARN',
  debug: 'DEBUG',
  verbose: 'VERBOSE',
  fatal: 'FATAL',
};

/**
 * Generate a compact filesystem-safe timestamp: 20260211T143201
 */
function startupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
}

/**
 * Console format matching NestJS ConsoleLogger style:
 * [Nest] 12345  - 02/11/2026, 2:32:01 PM     LOG [MessageBroker] Invoke: ...
 */
function nestConsoleFormat(): winston.Logform.Format {
  const colorizer = winston.format.colorize();

  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const nestLevel = (info['nestLevel'] as string) || 'log';
      const label = NEST_LEVEL_LABELS[nestLevel] ?? 'LOG';
      const winstonLevel = NEST_LEVEL_TO_WINSTON[nestLevel] ?? 'info';
      const ctx = typeof info['context'] === 'string' ? info['context'] : '';
      const context = ctx ? `[${ctx}] ` : '';
      const pid = process.pid;
      const ts = new Date().toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });

      // Pad before colorizing — ANSI codes add invisible chars that break padding
      const paddedLabel = label.padStart(7, ' ');
      const coloredLabel = colorizer.colorize(winstonLevel, paddedLabel);

      return `[Nest] ${pid}  - ${ts} ${coloredLabel} ${context}${String(info.message)}`;
    }),
  );
}

/**
 * JSON format for file transport. Writes one JSON object per line with NestJS level names.
 */
function nestJsonFormat(agentRole: string): winston.Logform.Format {
  return winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const nestLevel = (info['nestLevel'] as string) || 'log';

      const line: Record<string, unknown> = {
        timestamp: info['timestamp'],
        level: nestLevel,
        context: info['context'] || '',
        message: info.message,
        agentRole,
      };

      // Add known metadata fields
      if (info['correlationId'] != null) {
        line['correlationId'] = info['correlationId'];
      }
      if (info['fatal'] === true) {
        line['fatal'] = true;
      }

      // Add extra if present
      if (info['extra'] != null) {
        line['extra'] = info['extra'];
      }

      return JSON.stringify(line);
    }),
  );
}

export class LoggerBuilder {
  private addConsole = false;
  private jsonDir = '';
  private agentRole = 'unknown';
  private level = 'log';

  withConsole(): this {
    this.addConsole = true;
    return this;
  }

  withJsonDir(dir: string): this {
    this.jsonDir = dir;
    return this;
  }

  withAgentRole(role: string): this {
    this.agentRole = role;
    return this;
  }

  withLevel(level: string): this {
    this.level = level;
    return this;
  }

  build(): QuorumLogger {
    const winstonLevel = NEST_LEVEL_TO_WINSTON[this.level] ?? 'info';
    const transports: winston.transport[] = [];

    if (this.addConsole) {
      transports.push(
        new winston.transports.Console({
          format: nestConsoleFormat(),
        }),
      );
    }

    if (this.jsonDir) {
      mkdirSync(this.jsonDir, { recursive: true });
      const filename = `${this.agentRole}-${startupTimestamp()}.jsonl`;
      transports.push(
        new winston.transports.File({
          filename: join(this.jsonDir, filename),
          format: nestJsonFormat(this.agentRole),
        }),
      );
    }

    // If no transports configured, add a silent console to avoid winston errors
    if (transports.length === 0) {
      transports.push(new winston.transports.Console({ silent: true }));
    }

    const logger = winston.createLogger({
      levels: CUSTOM_LEVELS,
      level: winstonLevel,
      transports,
    });

    return new QuorumLogger(logger);
  }

  /**
   * Convenience factory for main.ts usage (runs before DI container).
   * Reads env vars directly: LOG_LEVEL, LOG_CONSOLE, LOG_JSON_DIR, AGENT_ROLE / APP_NAME.
   */
  static fromEnv(): QuorumLogger {
    const builder = new LoggerBuilder();

    builder.withLevel(process.env.LOG_LEVEL || 'log');
    builder.withAgentRole(
      process.env.AGENT_ROLE || process.env.APP_NAME || 'unknown',
    );

    if (process.env.LOG_CONSOLE !== 'false') {
      builder.withConsole();
    }

    const jsonDir = process.env.LOG_JSON_DIR || '';
    if (jsonDir) {
      builder.withJsonDir(jsonDir);
    }

    return builder.build();
  }
}
