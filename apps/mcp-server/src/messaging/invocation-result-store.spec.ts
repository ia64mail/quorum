import { AgentRole } from '@app/common';
import type { InvokeResponse } from '@app/common';
import {
  InvocationResultStore,
  type InvocationRecord,
} from './invocation-result-store';
import { ROLE_TIMEOUTS } from './role-timeouts';

function makeRecord(
  overrides: Partial<InvocationRecord> = {},
): InvocationRecord {
  const defaultResponse: InvokeResponse = { success: true, result: 'done' };
  return {
    invocationId: 'inv-1',
    callerRole: AgentRole.moderator,
    target: AgentRole.developer,
    status: 'pending',
    deliveryPromise: Promise.resolve(defaultResponse),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('InvocationResultStore', () => {
  let store: InvocationResultStore;

  beforeEach(() => {
    store = new InvocationResultStore();
  });

  // ---------------------------------------------------------------------------
  // Record lifecycle — create, read, update status on delivery, read after
  // ---------------------------------------------------------------------------

  describe('record lifecycle', () => {
    it('should store and retrieve a record by invocationId', () => {
      const record = makeRecord();
      store.store(record);

      const retrieved = store.get(record.invocationId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.invocationId).toBe('inv-1');
      expect(retrieved!.callerRole).toBe(AgentRole.moderator);
      expect(retrieved!.target).toBe(AgentRole.developer);
      expect(retrieved!.status).toBe('pending');
    });

    it('should return undefined for unknown invocationId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should update status when deliveryPromise resolves', async () => {
      let resolveDelivery!: (value: InvokeResponse) => void;
      const deliveryPromise = new Promise<InvokeResponse>((resolve) => {
        resolveDelivery = resolve;
      });

      const record = makeRecord({ deliveryPromise, status: 'pending' });
      store.store(record);

      // Wire the .then() to update status (like invoke_agent does)
      deliveryPromise.then((response) => {
        record.status = response.success ? 'completed' : 'failed';
        record.response = response;
      });

      resolveDelivery({ success: true, result: 'implementation done' });
      // Let microtask queue flush
      await deliveryPromise;

      const retrieved = store.get('inv-1');
      expect(retrieved!.status).toBe('completed');
      expect(retrieved!.response).toEqual({
        success: true,
        result: 'implementation done',
      });
    });

    it('should track size correctly', () => {
      expect(store.size).toBe(0);
      store.store(makeRecord({ invocationId: 'a' }));
      expect(store.size).toBe(1);
      store.store(makeRecord({ invocationId: 'b' }));
      expect(store.size).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // TTL reaping
  // ---------------------------------------------------------------------------

  describe('TTL reaping', () => {
    it('should reap records past TTL on reap cycle', () => {
      jest.useFakeTimers();

      const record = makeRecord({
        createdAt: Date.now(),
        target: AgentRole.developer,
      });
      store.store(record);
      expect(store.size).toBe(1);

      // Advance past developer TTL (30 min) + padding (10 min) = 40 min
      const developerTimeout = ROLE_TIMEOUTS[AgentRole.developer]!;
      jest.advanceTimersByTime(developerTimeout + 10 * 60_000 + 1);

      store.reapStaleInvocations();
      expect(store.size).toBe(0);

      jest.useRealTimers();
    });

    it('should preserve records within TTL', () => {
      jest.useFakeTimers();

      const record = makeRecord({
        createdAt: Date.now(),
        target: AgentRole.developer,
      });
      store.store(record);

      // Advance to just before TTL expires
      const developerTimeout = ROLE_TIMEOUTS[AgentRole.developer]!;
      jest.advanceTimersByTime(developerTimeout + 10 * 60_000 - 1000);

      store.reapStaleInvocations();
      expect(store.size).toBe(1);

      jest.useRealTimers();
    });

    it('should reap only expired records, leaving valid ones', () => {
      jest.useFakeTimers();
      const now = Date.now();

      // Old record — will expire
      store.store(
        makeRecord({
          invocationId: 'old',
          createdAt: now - (30 * 60_000 + 10 * 60_000 + 1),
          target: AgentRole.developer,
        }),
      );

      // Fresh record — will survive
      store.store(
        makeRecord({
          invocationId: 'fresh',
          createdAt: now,
          target: AgentRole.developer,
        }),
      );

      expect(store.size).toBe(2);
      store.reapStaleInvocations();
      expect(store.size).toBe(1);
      expect(store.get('old')).toBeUndefined();
      expect(store.get('fresh')).toBeDefined();

      jest.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Immediate-return path
  // ---------------------------------------------------------------------------

  describe('immediate-return path', () => {
    it('should return completed record instantly without needing to race', () => {
      const response: InvokeResponse = {
        success: true,
        result: 'all done',
      };
      const record = makeRecord({
        status: 'completed',
        response,
        deliveryPromise: Promise.resolve(response),
      });
      store.store(record);

      const retrieved = store.get('inv-1');
      expect(retrieved!.status).toBe('completed');
      expect(retrieved!.response).toEqual(response);
    });

    it('should return failed record instantly without needing to race', () => {
      const response: InvokeResponse = {
        success: false,
        error: 'agent crashed',
      };
      const record = makeRecord({
        status: 'failed',
        response,
        deliveryPromise: Promise.resolve(response),
      });
      store.store(record);

      const retrieved = store.get('inv-1');
      expect(retrieved!.status).toBe('failed');
      expect(retrieved!.response).toEqual(response);
    });
  });
});
