import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentRegistry } from '../registry/agent-registry.service';
import { MockConnection } from '../registry/mock-connection';
import { McpServerConfigService } from '../config';
import { BootstrapContextService } from './bootstrap-context.service';
import { MessageBroker } from './message-broker.service';

function makeRequest(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    correlationId: 'corr-1',
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'review design',
    wait: true,
    depth: 0,
    ...overrides,
  };
}

describe('MessageBroker', () => {
  let broker: MessageBroker;
  let registry: AgentRegistry;

  const mockConfig = {
    app: { name: 'mcp-server', port: 3000 },
    broker: { maxCallDepth: 5, defaultTimeoutMs: 300_000 },
    context: { defaultMaxTokens: 2000, tokenCharRatio: 4 },
  };

  const mockBootstrapService = {
    assemble: jest.fn().mockResolvedValue(null),
  };

  beforeEach(async () => {
    mockBootstrapService.assemble.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRegistry,
        MessageBroker,
        { provide: McpServerConfigService, useValue: mockConfig },
        { provide: BootstrapContextService, useValue: mockBootstrapService },
      ],
    }).compile();

    broker = module.get<MessageBroker>(MessageBroker);
    registry = module.get<AgentRegistry>(AgentRegistry);
  });

  describe('happy path', () => {
    it('should route invoke to correct agent and return its response', async () => {
      const connection = new MockConnection(AgentRole.architect);
      connection.handleFn = async () => ({
        success: true,
        result: 'design approved',
      });
      registry.register(connection);

      const response = await broker.invoke(makeRequest());

      expect(response).toEqual({
        success: true,
        result: 'design approved',
      });
    });
  });

  describe('depth limit', () => {
    it('should reject when depth >= maxCallDepth', async () => {
      const connection = new MockConnection(AgentRole.architect);
      registry.register(connection);

      const response = await broker.invoke(makeRequest({ depth: 5 }));

      expect(response.success).toBe(false);
      expect(response.error).toContain('Max call depth (5) exceeded');
    });

    it('should allow depth just below maxCallDepth', async () => {
      const connection = new MockConnection(AgentRole.architect);
      registry.register(connection);

      const response = await broker.invoke(makeRequest({ depth: 4 }));

      expect(response.success).toBe(true);
    });
  });

  describe('circular call prevention', () => {
    it('should detect A→B→A circular pattern', async () => {
      const archConnection = new MockConnection(AgentRole.architect);
      const devConnection = new MockConnection(AgentRole.developer);

      // Architect handler invokes developer, who invokes architect back
      archConnection.handleFn = async () => {
        // Simulate nested call: architect calls developer
        const nestedResponse = await broker.invoke(
          makeRequest({
            correlationId: 'corr-1',
            caller: AgentRole.architect,
            target: AgentRole.developer,
            depth: 1,
          }),
        );
        return nestedResponse;
      };

      devConnection.handleFn = async () => {
        // Developer tries to call architect back — circular!
        const circularResponse = await broker.invoke(
          makeRequest({
            correlationId: 'corr-1',
            caller: AgentRole.developer,
            target: AgentRole.architect,
            depth: 2,
          }),
        );
        return circularResponse;
      };

      registry.register(archConnection);
      registry.register(devConnection);

      const response = await broker.invoke(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error).toContain('Circular call');
      expect(response.error).toContain('architect');
    });
  });

  describe('agent not found', () => {
    it('should return error for unregistered target', async () => {
      const response = await broker.invoke(
        makeRequest({ target: AgentRole.developer }),
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('Agent developer not registered');
    });
  });

  describe('agent disconnected', () => {
    it('should return error for registered but disconnected target', async () => {
      const connection = new MockConnection(AgentRole.architect, false);
      registry.register(connection);

      const response = await broker.invoke(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error).toBe('Agent architect not connected');
    });
  });

  describe('timeout', () => {
    it('should return timeout error when agent.handle exceeds timeout', async () => {
      // Use moderator as target — it has no role-specific timeout,
      // so the short defaultTimeoutMs (50ms) applies.
      const shortConfig = {
        ...mockConfig,
        broker: { maxCallDepth: 5, defaultTimeoutMs: 50 },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AgentRegistry,
          MessageBroker,
          { provide: McpServerConfigService, useValue: shortConfig },
          { provide: BootstrapContextService, useValue: mockBootstrapService },
        ],
      }).compile();

      const shortBroker = module.get<MessageBroker>(MessageBroker);
      const shortRegistry = module.get<AgentRegistry>(AgentRegistry);

      const connection = new MockConnection(AgentRole.moderator);
      connection.handleFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { success: true, result: 'late' };
      };
      shortRegistry.register(connection);

      const response = await shortBroker.invoke(
        makeRequest({ target: AgentRole.moderator }),
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain('timed out after');
    });
  });

  describe('chain cleanup', () => {
    it('should clean up call chain after successful completion', async () => {
      const connection = new MockConnection(AgentRole.architect);
      registry.register(connection);

      await broker.invoke(makeRequest());

      // Access private callChains to verify cleanup
      const callChains = (
        broker as unknown as { callChains: Map<string, Set<AgentRole>> }
      ).callChains;
      expect(callChains.size).toBe(0);
    });

    it('should clean up call chain after handler error', async () => {
      const connection = new MockConnection(AgentRole.architect);
      connection.handleFn = async () => {
        throw new Error('handler crashed');
      };
      registry.register(connection);

      const response = await broker.invoke(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error).toBe('handler crashed');

      const callChains = (
        broker as unknown as { callChains: Map<string, Set<AgentRole>> }
      ).callChains;
      expect(callChains.size).toBe(0);
    });
  });

  describe('async (wait: false)', () => {
    it('should still fail immediately if agent unavailable', async () => {
      const response = await broker.invoke(
        makeRequest({ wait: false, target: AgentRole.developer }),
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('Agent developer not registered');
    });
  });
});
