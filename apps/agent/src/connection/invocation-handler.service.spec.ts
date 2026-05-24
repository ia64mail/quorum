import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as childProcess from 'node:child_process';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentConfigService, RolePermissionService } from '../config';
import { ClaudeCodeService } from '../llm';
import type { ExecuteResult } from '../llm/claude-code.types';
import { RolePromptService } from '../prompts';
import { McpToolBridgeService } from './mcp-tool-bridge.service';
import { InvocationHandler, toCanUseTool } from './invocation-handler.service';

jest.mock('node:child_process');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExec = childProcess.exec as unknown as jest.Mock;
const mockExecute = jest.fn<Promise<ExecuteResult>, [unknown]>();
const mockCreateBridge = jest.fn();
const mockGetDisallowedTools = jest.fn();
const mockGetPlugins = jest.fn();
const mockGetToolGuardHook = jest.fn();
const mockGetSystemPrompt = jest.fn();

const mockConfig = {
  agent: { workspaceDir: '/mnt/quorum/workspace' },
} as unknown as AgentConfigService;

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

const baseRequest: InvokeRequest = {
  correlationId: 'corr-123',
  caller: AgentRole.moderator,
  target: AgentRole.architect,
  action: 'design auth system',
  wait: true,
  depth: 0,
  branch: 'main',
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
  numTurns: 20,
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
    mockGetPlugins.mockReturnValue([]);
    mockGetToolGuardHook.mockReturnValue(() => ({ allowed: true }));

    // Default: git status returns clean (no uncommitted changes)
    mockExec.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );

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
            getPlugins: mockGetPlugins,
            getToolGuardHook: mockGetToolGuardHook,
          },
        },
        {
          provide: RolePromptService,
          useValue: { getSystemPrompt: mockGetSystemPrompt },
        },
        { provide: AgentConfigService, useValue: mockConfig },
      ],
    }).compile();

    handler = module.get<InvocationHandler>(InvocationHandler);
  });

  describe('success path', () => {
    it('should return success result with sessionId from execute()', async () => {
      mockExecute.mockResolvedValue(successResult);

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
        totalCostUsd: 0.0123,
        durationMs: 5000,
        sessionId: 'sess-abc',
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
        totalCostUsd: 0.005,
        durationMs: 30000,
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

    it('should prefix regular actions with "Task: "', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('Task: design auth system');
    });

    it('should pass slash-command actions verbatim without "Task: " prefix (BUG-002)', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        action: '/code-review\n\nFocus on auth changes',
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('/code-review');
      expect(call.prompt).toContain('Focus on auth changes');
      expect(call.prompt).not.toContain('Task: /code-review');
    });

    it('should pass /simplify skill action verbatim (BUG-002)', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({ ...baseRequest, action: '/simplify' });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('/simplify');
      expect(call.prompt).not.toContain('Task: ');
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

  describe('plugin integration (BUG-002)', () => {
    it('should call RolePermissionService.getPlugins()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockGetPlugins).toHaveBeenCalled();
    });

    it('should pass plugins to execute()', async () => {
      const plugins = [
        {
          type: 'local' as const,
          path: '/mnt/quorum/workspace/.claude/plugins/code-review',
        },
      ];
      mockGetPlugins.mockReturnValue(plugins);
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ plugins }),
      );
    });

    it('should pass empty plugins array for roles without plugins', async () => {
      mockGetPlugins.mockReturnValue([]);
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ plugins: [] }),
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

    it('should log error, turns, totalCostUsd, and durationMs on failure', async () => {
      mockExecute.mockResolvedValue(failureResult);

      await handler.handle(baseRequest);

      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('Invocation failed'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain('error="timeout"');
      expect(warnMessage).toContain('turns=20');
      expect(warnMessage).toContain('cost=$0.0050');
      expect(warnMessage).toContain('duration=30000ms');
    });

    it('should log turns=? when numTurns is not present on failure', async () => {
      const failureWithoutTurns: ExecuteResult = {
        success: false,
        error: 'Connection lost',
        durationMs: 1000,
        totalCostUsd: 0,
      };
      mockExecute.mockResolvedValue(failureWithoutTurns);

      await handler.handle(baseRequest);

      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('Invocation failed'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain('turns=?');
    });

    it('should WARN when result.sessionId differs from request.sessionId (silent-fallback detection)', async () => {
      const resumeResult: ExecuteResult = {
        success: true,
        result: 'Done',
        sessionId: 'sess-new-xyz',
        durationMs: 3000,
        totalCostUsd: 0.01,
        numTurns: 2,
      };
      mockExecute.mockResolvedValue(resumeResult);

      await handler.handle({
        ...baseRequest,
        sessionId: 'sess-old-abc',
      });

      const fallbackWarn = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Session resume silent fallback'),
      )?.[0] as string;
      expect(fallbackWarn).toBeDefined();
      expect(fallbackWarn).toContain('requested=sess-old-abc');
      expect(fallbackWarn).toContain('got=sess-new-xyz');
    });

    it('should NOT warn when result.sessionId matches request.sessionId', async () => {
      const resumeResult: ExecuteResult = {
        success: true,
        result: 'Done',
        sessionId: 'sess-same',
        durationMs: 3000,
        totalCostUsd: 0.01,
        numTurns: 2,
      };
      mockExecute.mockResolvedValue(resumeResult);

      await handler.handle({
        ...baseRequest,
        sessionId: 'sess-same',
      });

      const fallbackWarn = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Session resume silent fallback'),
      );
      expect(fallbackWarn).toBeUndefined();
    });

    it('should NOT warn on success when no sessionId was requested', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const fallbackWarn = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Session resume silent fallback'),
      );
      expect(fallbackWarn).toBeUndefined();
    });
  });

  describe('session resume forwarding', () => {
    it('should pass request.sessionId as resume to execute()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        sessionId: 'sess-resume-1',
      });

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: 'sess-resume-1',
        }),
      );
    });

    it('should pass undefined resume when sessionId is absent', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const call = mockExecute.mock.calls[0][0] as { resume: unknown };
      expect(call.resume).toBeUndefined();
    });

    it('should include sessionId in success response', async () => {
      mockExecute.mockResolvedValue(successResult);

      const result = await handler.handle(baseRequest);

      expect(result.sessionId).toBe('sess-abc');
    });

    it('should not include sessionId in failure response', async () => {
      mockExecute.mockResolvedValue(failureResult);

      const result = await handler.handle(baseRequest);

      expect(result.sessionId).toBeUndefined();
    });
  });

  describe('bootstrap context rendering', () => {
    it('should render project context before Task line when bootstrapContext is present', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: { 'tech-stack': 'NestJS' },
          conversation: {},
          meta: {
            itemCount: 1,
            estimatedTokens: 10,
            scopesQueried: ['project'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('## Prior Decisions');
      expect(call.prompt).toContain('### Project Context');
      expect(call.prompt).toContain('- tech-stack: "NestJS"');
      // Prior Decisions must appear before Task:
      const priorIdx = call.prompt.indexOf('## Prior Decisions');
      const taskIdx = call.prompt.indexOf('Task:');
      expect(priorIdx).toBeLessThan(taskIdx);
    });

    it('should render conversation context when present', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: { 'tech-stack': 'NestJS' },
          conversation: { 'task-notes': 'use JWT' },
          meta: {
            itemCount: 2,
            estimatedTokens: 20,
            scopesQueried: ['project', 'conversation'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('### Project Context');
      expect(call.prompt).toContain('### Conversation Context');
      expect(call.prompt).toContain('- task-notes: "use JWT"');
    });

    it('should omit project subsection when project scope is empty', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: {},
          conversation: { 'task-notes': 'data' },
          meta: {
            itemCount: 1,
            estimatedTokens: 5,
            scopesQueried: ['project', 'conversation'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('### Conversation Context');
      expect(call.prompt).not.toContain('### Project Context');
    });

    it('should omit conversation subsection when conversation scope is empty', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: { 'tech-stack': 'NestJS' },
          conversation: {},
          meta: {
            itemCount: 1,
            estimatedTokens: 10,
            scopesQueried: ['project'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain('### Project Context');
      expect(call.prompt).not.toContain('### Conversation Context');
    });

    it('should not render meta into prompt', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: { a: '1' },
          conversation: {},
          meta: {
            itemCount: 5,
            estimatedTokens: 200,
            scopesQueried: ['project', 'conversation'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).not.toContain('itemCount');
      expect(call.prompt).not.toContain('estimatedTokens');
      expect(call.prompt).not.toContain('scopesQueried');
    });

    it('should produce unchanged prompt when bootstrapContext is absent', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toMatch(/^Task:/);
      expect(call.prompt).not.toContain('## Prior Decisions');
    });

    it('should produce unchanged prompt when bootstrapContext has empty scopes', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: {},
          conversation: {},
          meta: {
            itemCount: 0,
            estimatedTokens: 0,
            scopesQueried: ['project'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toMatch(/^Task:/);
      expect(call.prompt).not.toContain('## Prior Decisions');
    });

    it('should JSON-stringify complex values', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: { 'auth-pattern': { type: 'JWT', expiry: '24h' } },
          conversation: {},
          meta: {
            itemCount: 1,
            estimatedTokens: 15,
            scopesQueried: ['project'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      expect(call.prompt).toContain(
        '- auth-pattern: {"type":"JWT","expiry":"24h"}',
      );
    });
  });
  // Regression test for QRM6-BUG-014: bootstrapContext was silently stripped
  // by the controller's Zod schema. This test verifies that when the handler
  // receives a request with non-trivial bootstrapContext (both project and
  // conversation populated), the rendered prompt contains all expected sections.
  describe('bootstrap context end-to-end rendering (BUG-014)', () => {
    it('should render Prior Decisions with both Project and Conversation sections', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle({
        ...baseRequest,
        bootstrapContext: {
          project: {
            'tech-stack': 'NestJS with TypeScript',
            'auth-pattern': 'JWT with refresh tokens',
          },
          conversation: {
            'task-breakdown': 'implement auth module with guards',
            'architect-decision': 'use passport.js strategy pattern',
          },
          meta: {
            itemCount: 4,
            estimatedTokens: 581,
            scopesQueried: ['project', 'conversation'],
          },
        },
      });

      const call = mockExecute.mock.calls[0][0] as { prompt: string };
      // All three heading levels must be present
      expect(call.prompt).toContain('## Prior Decisions');
      expect(call.prompt).toContain('### Project Context');
      expect(call.prompt).toContain('### Conversation Context');
      // All key-value pairs must be rendered
      expect(call.prompt).toContain('- tech-stack: "NestJS with TypeScript"');
      expect(call.prompt).toContain(
        '- auth-pattern: "JWT with refresh tokens"',
      );
      expect(call.prompt).toContain(
        '- task-breakdown: "implement auth module with guards"',
      );
      expect(call.prompt).toContain(
        '- architect-decision: "use passport.js strategy pattern"',
      );
      // Prior Decisions must come before the task
      const priorIdx = call.prompt.indexOf('## Prior Decisions');
      const taskIdx = call.prompt.indexOf('Task:');
      expect(priorIdx).toBeLessThan(taskIdx);
    });
  });

  describe('in-flight idempotency (BUG-010)', () => {
    it('should deduplicate concurrent calls with the same correlationId', async () => {
      // Use a deferred promise to control when execute() resolves
      let resolveExec!: (v: ExecuteResult) => void;
      mockExecute.mockReturnValue(
        new Promise<ExecuteResult>((resolve) => {
          resolveExec = resolve;
        }),
      );

      const promise1 = handler.handle(baseRequest);
      const promise2 = handler.handle(baseRequest);

      // Resolve the single execute call
      resolveExec(successResult);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Only one execute() call should have been made
      expect(mockExecute).toHaveBeenCalledTimes(1);
      // Both callers get the same result
      expect(result1).toEqual(result2);
      expect(result1).toEqual({
        success: true,
        result: 'Here is my design.',
        totalCostUsd: 0.0123,
        durationMs: 5000,
        sessionId: 'sess-abc',
      });
    });

    it('should log duplicate invocation when reusing in-flight', async () => {
      let resolveExec!: (v: ExecuteResult) => void;
      mockExecute.mockReturnValue(
        new Promise<ExecuteResult>((resolve) => {
          resolveExec = resolve;
        }),
      );

      const promise1 = handler.handle(baseRequest);
      // Second call triggers duplicate log
      const promise2 = handler.handle(baseRequest);

      resolveExec(successResult);
      await Promise.all([promise1, promise2]);

      const dupLog = (logSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Duplicate invocation reusing in-flight'),
      )?.[0] as string;
      expect(dupLog).toBeDefined();
      expect(dupLog).toContain('correlationId=corr-123');
    });

    it('should run separate execute() calls for different correlationIds', async () => {
      let resolveExec1!: (v: ExecuteResult) => void;
      let resolveExec2!: (v: ExecuteResult) => void;
      mockExecute
        .mockReturnValueOnce(
          new Promise<ExecuteResult>((resolve) => {
            resolveExec1 = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise<ExecuteResult>((resolve) => {
            resolveExec2 = resolve;
          }),
        );

      const request2: InvokeRequest = {
        ...baseRequest,
        correlationId: 'corr-456',
      };

      const promise1 = handler.handle(baseRequest);
      const promise2 = handler.handle(request2);

      resolveExec1(successResult);
      resolveExec2(successResult);

      await Promise.all([promise1, promise2]);

      // Two distinct correlationIds → two execute() calls
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should allow fresh invocation after prior one completes (map cleanup)', async () => {
      mockExecute.mockResolvedValue(successResult);

      // First call — completes fully
      await handler.handle(baseRequest);
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // Second call with same correlationId — should start fresh
      await handler.handle(baseRequest);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should clean up map entry even when invocation fails', async () => {
      mockExecute
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(successResult);

      // First call — throws, but should clean up map
      const result1 = await handler.handle(baseRequest);
      expect(result1.success).toBe(false);

      // Second call with same correlationId — should start fresh
      const result2 = await handler.handle(baseRequest);
      expect(result2.success).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should propagate failure to all concurrent awaiters', async () => {
      let rejectExec!: (e: Error) => void;
      mockExecute.mockReturnValue(
        new Promise<ExecuteResult>((_, reject) => {
          rejectExec = reject;
        }),
      );
      const p1 = handler.handle(baseRequest);
      const p2 = handler.handle(baseRequest);
      rejectExec(new Error('boom'));
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(r2);
      expect(r1.success).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate three concurrent calls matching the 2026-04-25 incident', async () => {
      let resolveExec!: (v: ExecuteResult) => void;
      mockExecute.mockReturnValue(
        new Promise<ExecuteResult>((resolve) => {
          resolveExec = resolve;
        }),
      );
      const p1 = handler.handle(baseRequest);
      const p2 = handler.handle(baseRequest);
      const p3 = handler.handle(baseRequest);
      resolveExec(successResult);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
      expect(r1.success).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('uncommitted changes check', () => {
    it('should run git status --porcelain after execution completes', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExec).toHaveBeenCalledWith(
        'git status --porcelain',
        { cwd: '/mnt/quorum/workspace' },
        expect.any(Function),
      );
    });

    it('should log a warning when uncommitted changes exist', async () => {
      mockExecute.mockResolvedValue(successResult);
      mockExec.mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          cb(null, { stdout: ' M src/app.ts\n?? new-file.ts\n', stderr: '' });
        },
      );

      await handler.handle(baseRequest);

      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Uncommitted changes after invocation'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain('correlationId=corr-123');
      expect(warnMessage).toContain('M src/app.ts');
      expect(warnMessage).toContain('new-file.ts');
    });

    it('should not log a warning when workspace is clean', async () => {
      mockExecute.mockResolvedValue(successResult);
      // Default mock returns empty stdout

      await handler.handle(baseRequest);

      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Uncommitted changes after invocation'),
      );
      expect(warnMessage).toBeUndefined();
    });

    it('should not fail or block the invocation when git is unavailable', async () => {
      mockExecute.mockResolvedValue(successResult);
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
          cb(new Error('git: command not found'));
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
        totalCostUsd: 0.0123,
        durationMs: 5000,
        sessionId: 'sess-abc',
      });
    });

    it('should not fail or block the invocation when workspace is not a git repo', async () => {
      mockExecute.mockResolvedValue(successResult);
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
          cb(new Error('fatal: not a git repository'));
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
        totalCostUsd: 0.0123,
        durationMs: 5000,
        sessionId: 'sess-abc',
      });
    });

    it('should still return success even when uncommitted changes are detected', async () => {
      mockExecute.mockResolvedValue(successResult);
      mockExec.mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          cb(null, { stdout: ' M dirty-file.ts\n', stderr: '' });
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
        totalCostUsd: 0.0123,
        durationMs: 5000,
        sessionId: 'sess-abc',
      });
    });

    it('should check for uncommitted changes even on failed invocations', async () => {
      mockExecute.mockResolvedValue(failureResult);

      await handler.handle(baseRequest);

      expect(mockExec).toHaveBeenCalledWith(
        'git status --porcelain',
        { cwd: '/mnt/quorum/workspace' },
        expect.any(Function),
      );
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

  it('should map allowed: true to behavior: allow with updatedInput', async () => {
    const hook = () => ({ allowed: true });
    const canUseTool = toCanUseTool(hook);
    const input = { command: 'ls' };

    const result = await canUseTool('Bash', input, dummyOptions);

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
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
