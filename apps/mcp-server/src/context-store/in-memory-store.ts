import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChangeEvent,
  ContextItem,
  ContextScope,
  ContextStats,
  ContextStore,
  SetParams,
} from '@app/common';
import { contextStoreConfig } from '../config';

@Injectable()
export class InMemoryStore
  extends ContextStore
  implements OnModuleInit, OnModuleDestroy
{
  private readonly store = new Map<string, ContextItem>();
  private readonly logger = new Logger(InMemoryStore.name);
  private readonly contextFilePath: string;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Inject(contextStoreConfig.KEY)
    private readonly config: ConfigType<typeof contextStoreConfig>,
  ) {
    super();
    this.contextFilePath = this.config.contextStorePath;
  }

  async onModuleInit(): Promise<void> {
    try {
      const raw = await readFile(this.contextFilePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.logger.warn('Context file does not contain an array — ignoring');
        return;
      }
      const entries = parsed as [string, ContextItem][];
      const now = Date.now();

      for (const [compositeKey, item] of entries) {
        if (item.expiresAt !== undefined && now >= item.expiresAt) {
          continue;
        }
        this.store.set(compositeKey, item);
      }

      this.logger.log(
        `Context loaded: ${this.store.size} items from ${this.contextFilePath}`,
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        this.logger.log('No context file found — starting with empty store');
        return;
      }
      this.logger.warn(`Failed to load context file: ${error.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      const now = Date.now();
      const entries: [string, ContextItem][] = [];

      for (const [compositeKey, item] of this.store) {
        if (item.expiresAt !== undefined && now >= item.expiresAt) {
          continue;
        }
        entries.push([compositeKey, item]);
      }

      const tmpPath = this.contextFilePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
      await rename(tmpPath, this.contextFilePath);

      this.logger.log(
        `Context saved: ${entries.length} items to ${this.contextFilePath}`,
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      this.logger.error(`Failed to save context file: ${error.message}`);
    }
  }

  private compositeKey(scope: ContextScope, key: string, id?: string): string {
    return `${scope}:${id ?? '_'}:${key}`;
  }

  private estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / 4);
  }

  private isExpired(item: ContextItem): boolean {
    return item.expiresAt !== undefined && Date.now() >= item.expiresAt;
  }

  private emitChange(
    scope: ContextScope,
    key: string,
    action: ChangeEvent['action'],
    id?: string,
  ): void {
    const event: ChangeEvent = { scope, key, action };
    if (id !== undefined) {
      event.id = id;
    }
    this.eventEmitter.emit('context.change', event);
  }

  async set(params: SetParams): Promise<void> {
    const compositeKey = this.compositeKey(params.scope, params.key, params.id);
    const now = Date.now();

    const item: ContextItem = {
      key: params.key,
      value: params.value,
      scope: params.scope,
      createdAt: now,
    };

    if (params.id !== undefined) {
      item.id = params.id;
    }
    if (params.createdBy !== undefined) {
      item.createdBy = params.createdBy;
    }
    if (params.ttl !== undefined) {
      item.expiresAt = now + params.ttl;
    }

    this.store.set(compositeKey, item);
    this.emitChange(params.scope, params.key, 'set', params.id);
  }

  async get(scope: ContextScope, key: string, id?: string): Promise<unknown> {
    const compositeKey = this.compositeKey(scope, key, id);
    const item = this.store.get(compositeKey);

    if (!item) {
      return undefined;
    }

    if (this.isExpired(item)) {
      this.store.delete(compositeKey);
      this.emitChange(item.scope, item.key, 'expire', item.id);
      return undefined;
    }

    return item.value;
  }

  async getAll(
    scope: ContextScope,
    id?: string,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const prefix = `${scope}:${id ?? '_'}:`;

    for (const [compositeKey, item] of this.store) {
      if (!compositeKey.startsWith(prefix)) {
        continue;
      }

      if (this.isExpired(item)) {
        this.store.delete(compositeKey);
        this.emitChange(item.scope, item.key, 'expire', item.id);
        continue;
      }

      result[item.key] = item.value;
    }

    return result;
  }

  async search(
    scope: ContextScope,
    query: string,
    id?: string,
    maxTokens?: number,
  ): Promise<ContextItem[]> {
    const results: ContextItem[] = [];
    const lowerQuery = query.toLowerCase();
    const prefix = `${scope}:${id ?? '_'}:`;
    let tokenBudget = maxTokens ?? Infinity;

    for (const [compositeKey, item] of this.store) {
      if (!compositeKey.startsWith(prefix)) {
        continue;
      }

      if (this.isExpired(item)) {
        this.store.delete(compositeKey);
        this.emitChange(item.scope, item.key, 'expire', item.id);
        continue;
      }

      const serialized = JSON.stringify(item.value);
      if (serialized.toLowerCase().includes(lowerQuery)) {
        const tokens = this.estimateTokens(item.value);
        if (tokens > tokenBudget) {
          break;
        }
        tokenBudget -= tokens;
        results.push(item);
      }
    }

    return results;
  }

  async getStats(scope?: ContextScope, id?: string): Promise<ContextStats> {
    let itemCount = 0;
    let estimatedTokens = 0;

    if (scope === undefined) {
      for (const [compositeKey, item] of this.store) {
        if (this.isExpired(item)) {
          this.store.delete(compositeKey);
          this.emitChange(item.scope, item.key, 'expire', item.id);
          continue;
        }
        itemCount++;
        estimatedTokens += this.estimateTokens(item.value);
      }
    } else {
      const prefix = `${scope}:${id ?? '_'}:`;
      for (const [compositeKey, item] of this.store) {
        if (!compositeKey.startsWith(prefix)) {
          continue;
        }
        if (this.isExpired(item)) {
          this.store.delete(compositeKey);
          this.emitChange(item.scope, item.key, 'expire', item.id);
          continue;
        }
        itemCount++;
        estimatedTokens += this.estimateTokens(item.value);
      }
    }

    return { itemCount, estimatedTokens };
  }
}
