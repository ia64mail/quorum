import { Injectable, Logger } from '@nestjs/common';
import type { AgentRole, InvokeResponse } from '@app/common';
import { ROLE_TIMEOUTS } from './role-timeouts';

/**
 * Tracks an in-flight or completed agent invocation that outlived its
 * initial `invoke_agent` POST response window. The `deliveryPromise`
 * lets multiple `wait_invocation` calls race against the same underlying
 * work without re-invoking the agent.
 */
export interface InvocationRecord {
  invocationId: string;
  callerRole: AgentRole;
  target: AgentRole;
  status: 'pending' | 'completed' | 'failed';
  response?: InvokeResponse;
  deliveryPromise: Promise<InvokeResponse>;
  createdAt: number;
}

/**
 * In-memory store for long-poll continuation records (QRM7-017).
 *
 * When `invoke_agent` returns `{ status: "pending" }` because the
 * 4 min 30 s server timer fired before the broker resolved, the
 * in-flight invocation is parked here. `wait_invocation` reads from
 * this store to continue waiting on the same `deliveryPromise`.
 *
 * Bounded by `maxCallDepth x concurrent moderator sessions` — in
 * practice <20 entries. Stale records are reaped on the existing
 * 30 s reaper interval via {@link reapStaleInvocations}.
 */
@Injectable()
export class InvocationResultStore {
  private readonly logger = new Logger(InvocationResultStore.name);
  private readonly records = new Map<string, InvocationRecord>();

  /**
   * Extra time (ms) added to `ROLE_TIMEOUTS[target]` for TTL calculation.
   * Generous because the store is small and records should outlive the
   * agent's work to allow retrieval after completion.
   */
  private static readonly TTL_PADDING_MS = 10 * 60_000; // 10 minutes

  /** Store a new in-flight invocation record. */
  store(record: InvocationRecord): void {
    this.records.set(record.invocationId, record);
    this.logger.log(
      `Stored invocation: id=${record.invocationId} ` +
        `caller=${record.callerRole} target=${record.target} status=${record.status}`,
    );
  }

  /** Retrieve a record by invocationId. */
  get(invocationId: string): InvocationRecord | undefined {
    return this.records.get(invocationId);
  }

  /**
   * Reap records whose TTL has expired. Called from the 30 s reaper
   * interval in `mcp.controller.ts`. TTL = ROLE_TIMEOUTS[target] + 10 min.
   */
  reapStaleInvocations(): void {
    const now = Date.now();
    let reaped = 0;

    for (const [id, record] of this.records) {
      const roleTimeout = ROLE_TIMEOUTS[record.target] ?? 300_000;
      const ttl = roleTimeout + InvocationResultStore.TTL_PADDING_MS;

      if (now - record.createdAt > ttl) {
        this.records.delete(id);
        reaped++;
      }
    }

    if (reaped > 0) {
      this.logger.log(
        `Reaped ${reaped} stale invocation record(s), ${this.records.size} remaining`,
      );
    }
  }

  /** Current number of stored records (for diagnostics). */
  get size(): number {
    return this.records.size;
  }
}
