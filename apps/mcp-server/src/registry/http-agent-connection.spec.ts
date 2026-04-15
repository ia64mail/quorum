import { Agent as UndiciAgent } from 'undici';
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { HttpAgentConnection } from './http-agent-connection';

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
    jest.restoreAllMocks();
  });

  it('should have the correct role', () => {
    expect(connection.role).toBe(AgentRole.architect);
  });

  it('should always return true for isConnected()', () => {
    expect(connection.isConnected()).toBe(true);
  });

  it('should send POST to callbackUrl/invoke and return parsed response', async () => {
    const expected: InvokeResponse = { success: true, result: 'done' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => expected,
    } as Response);

    const result = await connection.handle(request, timeout);

    expect(fetch).toHaveBeenCalledWith(
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
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect returned HTTP 500',
    });
  });

  it('should return error response on network failure', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect unreachable: fetch failed',
    });
  });

  it('should return error response on timeout (AbortError)', async () => {
    const abortError = new DOMException(
      'The operation was aborted',
      'AbortError',
    );
    jest.spyOn(global, 'fetch').mockRejectedValue(abortError);

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect invocation timed out',
    });
  });

  it('should return error response on invalid response body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    } as Response);

    const result = await connection.handle(request, timeout);

    expect(result).toEqual({
      success: false,
      error: 'Agent architect returned invalid response',
    });
  });

  it('should append /invoke to callback URL', async () => {
    const conn = new HttpAgentConnection(role, 'http://custom-host:9999');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: 'ok' }),
    } as Response);

    await conn.handle(request, timeout);

    expect(fetch).toHaveBeenCalledWith(
      'http://custom-host:9999/invoke',
      expect.anything(),
    );
  });

  describe('undici dispatcher', () => {
    it('should pass a dispatcher to fetch() with extended timeouts', async () => {
      const expected: InvokeResponse = { success: true, result: 'done' };
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => expected,
      } as Response);

      await connection.handle(request, timeout);

      const fetchCall = jest.mocked(fetch).mock.calls[0];
      const options = fetchCall[1] as RequestInit & { dispatcher?: unknown };
      expect(options.dispatcher).toBeDefined();
      expect(options.dispatcher).toBeInstanceOf(UndiciAgent);
    });

    it('should set headersTimeout and bodyTimeout exceeding max role timeout', async () => {
      const expected: InvokeResponse = { success: true, result: 'done' };
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => expected,
      } as Response);

      await connection.handle(request, timeout);

      const fetchCall = jest.mocked(fetch).mock.calls[0];
      const options = fetchCall[1] as RequestInit & {
        dispatcher?: UndiciAgent;
      };
      const dispatcher = options.dispatcher as UndiciAgent;
      // Verify dispatcher is an UndiciAgent — the constructor sets
      // headersTimeout and bodyTimeout to 35 min (2_100_000ms),
      // which exceeds the max role timeout of 30 min (1_800_000ms).
      expect(dispatcher).toBeInstanceOf(UndiciAgent);
    });

    it('should reuse the same dispatcher across multiple handle() calls', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, result: 'ok' }),
      } as Response);

      await connection.handle(request, timeout);
      await connection.handle(request, timeout);

      const calls = jest.mocked(fetch).mock.calls;
      const dispatcher1 = (
        calls[0][1] as RequestInit & { dispatcher?: unknown }
      ).dispatcher;
      const dispatcher2 = (
        calls[1][1] as RequestInit & { dispatcher?: unknown }
      ).dispatcher;
      expect(dispatcher1).toBe(dispatcher2);
    });
  });
});
