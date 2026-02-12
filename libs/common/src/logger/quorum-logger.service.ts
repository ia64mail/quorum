import type { LoggerService } from '@nestjs/common';
import type { Logger as WinstonLogger } from 'winston';

/** NestJS → Winston level mapping. NestJS uses 'log' where winston uses 'info'. */
const NEST_TO_WINSTON: Record<string, string> = {
  log: 'info',
  error: 'error',
  warn: 'warn',
  debug: 'debug',
  verbose: 'verbose',
  fatal: 'error',
};

/** Known metadata fields that go into top-level JSON (not into `extra`). */
const KNOWN_META_KEYS = new Set(['correlationId']);

/**
 * Parses NestJS `...optionalParams` into a context string and a metadata object.
 *
 * NestJS convention:
 *  - The last string argument is the context (class name).
 *  - Any plain object argument is structured metadata.
 */
function parseOptionalParams(optionalParams: unknown[]): {
  context: string;
  metadata: Record<string, unknown>;
} {
  let context = '';
  let metadata: Record<string, unknown> = {};

  for (let i = optionalParams.length - 1; i >= 0; i--) {
    const param = optionalParams[i];
    if (typeof param === 'string' && context === '') {
      context = param;
    } else if (
      typeof param === 'object' &&
      param !== null &&
      !Array.isArray(param) &&
      Object.keys(metadata).length === 0
    ) {
      metadata = param as Record<string, unknown>;
    }
  }

  return { context, metadata };
}

/**
 * Splits metadata into known top-level fields and extra.
 * Returns { knownFields, extra } where extra is undefined if empty.
 */
function splitMetadata(metadata: Record<string, unknown>): {
  known: Record<string, unknown>;
  extra: Record<string, unknown> | undefined;
} {
  const known: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (KNOWN_META_KEYS.has(key)) {
      known[key] = value;
    } else {
      extra[key] = value;
    }
  }

  return {
    known,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

export class QuorumLogger implements LoggerService {
  constructor(private readonly winston: WinstonLogger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.writeLog('fatal', message, optionalParams);
  }

  private writeLog(
    nestLevel: string,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const { context, metadata } = parseOptionalParams(optionalParams);
    const { known, extra } = splitMetadata(metadata);
    const winstonLevel = NEST_TO_WINSTON[nestLevel] ?? 'info';

    this.winston.log(winstonLevel, {
      message: String(message),
      context,
      nestLevel,
      ...known,
      ...(extra != null ? { extra } : {}),
      ...(nestLevel === 'fatal' ? { fatal: true } : {}),
    });
  }
}
