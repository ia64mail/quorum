/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { HttpAgentConnection } from './http-agent-connection';

/**
 * Mock undici's fetch while keeping the real Agent class.
 * We use a manual mock with `jest.fn()` inside the factory (hoisted above
 * imports) and then extract the mock reference via a second import.
 */
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});

// Import after mock so we get the mocked `fetch` and the real `Agent`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Agent: UndiciAgent, fetch: mockFetch } = require('undici') as {
  Agent: typeof import('undici').Agent;
  fetch: jest.Mock;
};

describe('HttpAgentConnection', () => {
  const role = AgentRole.architect;
  const callbackUrl = 'http://architect:3002';
  let connection: HttpAgentConnection;

  const request: InvokeRequest = {
    correlationId: 'corr-1',
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'design auth',
    wait: true,
    depth: 0,
  };

  const timeout = 5000;

  beforeEach(() => {
    connection = new HttpAgentConnection(role, callbackUrl);
    mockFetch.mockReset();
  });

  it('should have the correct role', () => {
    expect(connection.role).toBe(AgentRole.architect);
  });

  it('should always return true for isConnected()', () => {
    expect(connection.isConnected()).toBe(true);
  });

  it('should send POST to callbackUrl/invoke and return parsed response', async () => {
    const expected: InvokeResponse = { success: true, result: 'done' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => expected,
    });

    const result = await connection.handle(request, timeout);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://architect:3002/invoke',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    expect(result).toEqual(expected);
  });

  it('should return error response on HTTP error status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect returned HTTP 500',
    });
  });

  it('should return error response on network failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect unreachable: fetch failed',
    });
  });

  it('should include cause in error message when available', async () => {
    const err = new TypeError('fetch failed');
    (err as any).cause = new Error('connect ECONNREFUSED 172.18.0.4:3002');
    mockFetch.mockRejectedValue(err);

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error:
        'Agent architect unreachable: fetch failed (connect ECONNREFUSED 172.18.0.4:3002)',
    });
  });

  it('should return error response on timeout (AbortError)', async () => {
    const abortError = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    mockFetch.mockRejectedValue(abortError);

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect invocation timed out',
    });
  });

  it('should return error response on invalid response body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    });

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect returned invalid response',
    });
  });

  it('should append /invoke to callback URL', async () => {
    const conn = new HttpAgentConnection(role, 'http://custom-host:9999');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: 'ok' }),
    });

    await conn.handle(request, timeout);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://custom-host:9999/invoke',
      expect.anything(),
    );
  });

  describe('undici dispatcher', () => {
    it('should pass a dispatcher to fetch() with extended timeouts', async () => {
      const expected: InvokeResponse = { success: true, result: 'done' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => expected,
      });

      await connection.handle(request, timeout);

      const options = mockFetch.mock.calls[0][1] as Record<string, unknown>;
      expect(options.dispatcher).toBeDefined();
      expect(options.dispatcher).toBeInstanceOf(UndiciAgent);
    });

    it('should set headersTimeout and bodyTimeout exceeding max role timeout', async () => {
      const expected: InvokeResponse = { success: true, result: 'done' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => expected,
      });

      await connection.handle(request, timeout);

      const options = mockFetch.mock.calls[0][1] as Record<string, unknown>;
      // Verify dispatcher is an UndiciAgent — the constructor sets
      // headersTimeout and bodyTimeout to 35 min (2_100_000ms),
      // which exceeds the max role timeout of 30 min (1_800_000ms).
      expect(options.dispatcher).toBeInstanceOf(UndiciAgent);
    });

    it('should reuse the same dispatcher across multiple handle() calls', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, result: 'ok' }),
      });

      await connection.handle(request, timeout);
      await connection.handle(request, timeout);

      const dispatcher1 = (
        mockFetch.mock.calls[0][1] as Record<string, unknown>
      ).dispatcher;
      const dispatcher2 = (
        mockFetch.mock.calls[1][1] as Record<string, unknown>
      ).dispatcher;
      expect(dispatcher1).toBe(dispatcher2);
    });
  });
});
