import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChangeEvent,
  ContextItem,
  ContextScope,
  ContextStats,
  ContextStore,
  SetParams,
} from '@app/common';

@Injectable()
export class InMemoryStore extends ContextStore {
  private readonly store = new Map<string, ContextItem>();

  constructor(private readonly eventEmitter: EventEmitter2) {
    super();
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
