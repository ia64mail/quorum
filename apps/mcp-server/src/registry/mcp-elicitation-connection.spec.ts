import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpElicitationConnection } from './mcp-elicitation-connection';

describe('McpElicitationConnection', () => {
  const role = AgentRole.moderator;
  const request: InvokeRequest = {
    correlationId: 'corr-1',
    caller: AgentRole.developer,
    target: AgentRole.moderator,
    action: 'push or pull?',
    wait: true,
    depth: 1,
  };

  function buildServer(elicitInput: jest.Mock): McpServer {
    return {
      server: { elicitInput },
    } as unknown as McpServer;
  }

  it('forwards the broker-supplied timeout into elicitInput options', async () => {
    const elicitInput = jest
      .fn()
      .mockResolvedValue({ action: 'accept', content: { answer: 'pull' } });
    const conn = new McpElicitationConnection(role, buildServer(elicitInput));

    const response = await conn.handle(request, 300_000);

    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(elicitInput).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 300_000,
    });
    expect(response).toEqual({ success: true, result: 'pull' });
  });

  it('returns a structured error envelope when elicitInput throws (e.g. MCP -32001 timeout)', async () => {
    const elicitInput = jest
      .fn()
      .mockRejectedValue(new Error('MCP error -32001: Request timed out'));
    const conn = new McpElicitationConnection(role, buildServer(elicitInput));

    const response = await conn.handle(request, 300_000);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('-32001');
    }
  });

  // ---------------------------------------------------------------------------
  // QRM7-001: livenessCheck-based isConnected()
  // ---------------------------------------------------------------------------

  describe('isConnected() with livenessCheck (QRM7-001)', () => {
    it('returns true when livenessCheck returns true', () => {
      const elicitInput = jest.fn();
      const conn = new McpElicitationConnection(
        role,
        buildServer(elicitInput),
        () => true,
      );
      expect(conn.isConnected()).toBe(true);
    });

    it('returns false when livenessCheck returns false', () => {
      const elicitInput = jest.fn();
      const conn = new McpElicitationConnection(
        role,
        buildServer(elicitInput),
        () => false,
      );
      expect(conn.isConnected()).toBe(false);
    });

    it('defaults to true when no livenessCheck is provided (backward compat)', () => {
      const elicitInput = jest.fn();
      const conn = new McpElicitationConnection(role, buildServer(elicitInput));
      expect(conn.isConnected()).toBe(true);
    });

    it('reflects dynamic livenessCheck state changes', () => {
      let alive = true;
      const elicitInput = jest.fn();
      const conn = new McpElicitationConnection(
        role,
        buildServer(elicitInput),
        () => alive,
      );

      expect(conn.isConnected()).toBe(true);
      alive = false;
      expect(conn.isConnected()).toBe(false);
      alive = true;
      expect(conn.isConnected()).toBe(true);
    });
  });
});
