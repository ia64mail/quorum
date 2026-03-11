import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { RolePermissionService } from '../config';
import { ClaudeCodeService } from '../llm';
import type { ExecuteResult } from '../llm/claude-code.types';
import { RolePromptService } from '../prompts';
import { McpToolBridgeService } from './mcp-tool-bridge.service';
import { InvocationHandler, toCanUseTool } from './invocation-handler.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecute = jest.fn<Promise<ExecuteResult>, [unknown]>();
const mockCreateBridge = jest.fn();
const mockGetDisallowedTools = jest.fn();
const mockGetToolGuardHook = jest.fn();
const mockGetSystemPrompt = jest.fn();

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

const baseRequest: InvokeRequest = {
  correlationId: 'corr-123',
  caller: AgentRole.moderator,
  target: AgentRole.architect,
  action: 'design auth system',
  wait: true,
  depth: 0,
};

const successResult: ExecuteResult = {
  success: true,
  result: 'Here is my design.',
  sessionId: 'sess-abc',
  durationMs: 5000,
  totalCostUsd: 0.0123,
  numTurns: 3,
};

const failureResult: ExecuteResult = {
  success: false,
  error: 'timeout',
  durationMs: 30000,
  totalCostUsd: 0.005,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvocationHandler', () => {
  let handler: InvocationHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetSystemPrompt.mockReturnValue('Mocked system prompt');
    mockCreateBridge.mockReturnValue({ quorum: { name: 'quorum' } });
    mockGetDisallowedTools.mockReturnValue(['AskUserQuestion']);
    mockGetToolGuardHook.mockReturnValue(() => ({ allowed: true }));

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvocationHandler,
        { provide: ClaudeCodeService, useValue: { execute: mockExecute } },
        {
          provide: McpToolBridgeService,
          useValue: { createBridge: mockCreateBridge },
        },
        {
          provide: RolePermissionService,
          useValue: {
            getDisallowedTools: mockGetDisallowedTools,
            getToolGuardHook: mockGetToolGuardHook,
          },
        },
        {
          provide: RolePromptService,
          useValue: { getSystemPrompt: mockGetSystemPrompt },
        },
      ],
    }).compile();

    handler = module.get<InvocationHandler>(InvocationHandler);
  });

  describe('success path', () => {
    it('should return success result from execute()', async () => {
      mockExecute.mockResolvedValue(successResult);

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
      });
    });
  });

  describe('failure path', () => {
    it('should return failure result from execute()', async () => {
      mockExecute.mockResolvedValue(failureResult);

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: false,
        error: 'timeout',
      });
    });
  });

  describe('exception handling', () => {
    it('should catch exceptions and return SDK execution failed error', async () => {
      mockExecute.mockRejectedValue(new Error('Connection refused'));

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: false,
        error: 'SDK execution failed: Connection refused',
      });
    });

    it('should handle non-Error thrown values', async () => {
      mockExecute.mockRejectedValue('raw string error');

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: false,
        error: 'SDK execution failed: raw string error',
      });
    });
  });

  describe('prompt building', () => {
    it('should include action in prompt', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('design auth system') as string,
        }),
      );
    });

    it('should include context when present', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        context: { framework: 'NestJS' },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('NestJS');
      expect(call.prompt).toContain('Additional context');
    });

    it('should omit context when absent', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).not.toContain('Additional context');
    });

    it('should omit context when empty object', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({ ...baseRequest, context: {} });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).not.toContain('Additional context');
    });
  });

  describe('system prompt', () => {
    it('should call RolePromptService.getSystemPrompt with request.caller', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockGetSystemPrompt).toHaveBeenCalledWith(AgentRole.moderator);
    });

    it('should pass resolved system prompt to execute()', async () => {
      mockGetSystemPrompt.mockReturnValue('Custom resolved prompt');
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'Custom resolved prompt',
        }),
      );
    });
  });

  describe('bridge integration', () => {
    it('should call McpToolBridgeService.createBridge with the request', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockCreateBridge).toHaveBeenCalledWith(baseRequest);
    });

    it('should pass bridge result as mcpServers', async () => {
      const bridgeResult = { quorum: { name: 'quorum', tools: [] } };
      mockCreateBridge.mockReturnValue(bridgeResult);
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: bridgeResult,
        }),
      );
    });
  });

  describe('permission integration — disallowedTools', () => {
    it('should call RolePermissionService.getDisallowedTools()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockGetDisallowedTools).toHaveBeenCalled();
    });

    it('should pass disallowedTools to execute()', async () => {
      mockGetDisallowedTools.mockReturnValue([
        'AskUserQuestion',
        'NotebookEdit',
      ]);
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          disallowedTools: ['AskUserQuestion', 'NotebookEdit'],
        }),
      );
    });
  });

  describe('permission integration — canUseTool', () => {
    it('should call RolePermissionService.getToolGuardHook()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockGetToolGuardHook).toHaveBeenCalled();
    });

    it('should pass a canUseTool function to execute()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const call = mockExecute.mock.calls[0][0] as { canUseTool: unknown };
      expect(typeof call.canUseTool).toBe('function');
    });
  });

  describe('metadata logging', () => {
    it('should log sessionId, numTurns, totalCostUsd, and durationMs on success', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const logMessage = (logSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Invocation complete'),
      )?.[0] as string;
      expect(logMessage).toBeDefined();
      expect(logMessage).toContain('sessionId=sess-abc');
      expect(logMessage).toContain('turns=3');
      expect(logMessage).toContain('cost=$0.0123');
      expect(logMessage).toContain('duration=5000ms');
    });

    it('should log error, totalCostUsd, and durationMs on failure', async () => {
      mockExecute.mockResolvedValue(failureResult);

      await handler.handle(baseRequest);

      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('Invocation failed'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain('error="timeout"');
      expect(warnMessage).toContain('cost=$0.0050');
      expect(warnMessage).toContain('duration=30000ms');
    });
  });
});

// ---------------------------------------------------------------------------
// toCanUseTool adapter
// ---------------------------------------------------------------------------

describe('toCanUseTool', () => {
  const dummyOptions = {
    signal: new AbortController().signal,
    toolUseID: 'tu_1',
  };

  it('should map allowed: true to behavior: allow', async () => {
    const hook = () => ({ allowed: true });
    const canUseTool = toCanUseTool(hook);

    const result = await canUseTool('Bash', { command: 'ls' }, dummyOptions);

    expect(result).toEqual({ behavior: 'allow' });
  });

  it('should map allowed: false with reason to behavior: deny with message', async () => {
    const hook = () => ({
      allowed: false,
      reason: 'Denied bash command: "rm -rf"',
    });
    const canUseTool = toCanUseTool(hook);

    const result = await canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      dummyOptions,
    );

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Denied bash command: "rm -rf"',
    });
  });

  it('should default deny message to "Denied by role policy" when reason is missing', async () => {
    const hook = () => ({ allowed: false });
    const canUseTool = toCanUseTool(hook);

    const result = await canUseTool(
      'Write',
      { file_path: '/etc/passwd' },
      dummyOptions,
    );

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Denied by role policy',
    });
  });

  it('should pass tool name and input to the guard hook', async () => {
    const hook = jest.fn().mockReturnValue({ allowed: true });
    const canUseTool = toCanUseTool(hook);

    await canUseTool('Bash', { command: 'echo hello' }, dummyOptions);

    expect(hook).toHaveBeenCalledWith('Bash', { command: 'echo hello' });
  });
});
