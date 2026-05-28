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
const mockExecFile = childProcess.execFile as unknown as jest.Mock;
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

    // Default: all git commands succeed (fetch, worktree add/remove, status)
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

    // Default: execFile (node_modules symlink) succeeds
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
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

    it('should pass worktree cwd to execute()', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: `/var/agent-worktrees/${baseRequest.correlationId}`,
        }),
      );
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

  describe('commit and push', () => {
    it('should run git status --porcelain in the worktree after successful execution', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const statusCall = (mockExec.mock.calls as unknown[][]).find(
        (call) => call[0] === 'git status --porcelain',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1]).toEqual({
        cwd: `/var/agent-worktrees/${baseRequest.correlationId}`,
      });
    });

    it('should not commit or push when no changes exist', async () => {
      mockExecute.mockResolvedValue(successResult);
      // Default mock returns empty stdout → no changes

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      // No git add, commit, or push commands should appear
      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      expect(cmds.find((c) => c.startsWith('git add'))).toBeUndefined();
      expect(cmds.find((c) => c.startsWith('git commit'))).toBeUndefined();
      expect(cmds.find((c) => c.startsWith('git push'))).toBeUndefined();
      // INFO log should note no changes
      const infoLog = (logSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('No changes to commit after invocation'),
      )?.[0] as string;
      expect(infoLog).toBeDefined();
      expect(infoLog).toContain('correlationId=corr-123');
    });

    it('should commit with provided commitMessage verbatim and push', async () => {
      const resultWithMsg: ExecuteResult = {
        ...successResult,
        commitMessage: '#12: implement handler-controlled commit',
      };
      mockExecute.mockResolvedValue(resultWithMsg);
      // git status reports dirty
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd === 'git status --porcelain') {
            cb(null, {
              stdout: ' M src/app.ts\n',
              stderr: '',
            });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      expect(cmds).toContain('git add -A');
      const commitCmd = cmds.find((c) => c.startsWith('git commit'));
      expect(commitCmd).toBeDefined();
      expect(commitCmd).toContain('#12: implement handler-controlled commit');
      expect(cmds).toContain(`git push origin ${baseRequest.branch}`);
    });

    it('should use fallback message and log WARN when commitMessage is missing', async () => {
      mockExecute.mockResolvedValue(successResult); // no commitMessage
      // git status reports dirty
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd === 'git status --porcelain') {
            cb(null, {
              stdout: ' M src/app.ts\n',
              stderr: '',
            });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      // Verify fallback message format: (no-message/<corrId-short>): changes from <target> invocation
      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      const commitCmd = cmds.find((c) => c.startsWith('git commit'));
      expect(commitCmd).toBeDefined();
      expect(commitCmd).toContain('(no-message/corr-123');
      expect(commitCmd).toContain(
        `changes from ${baseRequest.target} invocation`,
      );
      // WARN log should be emitted
      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Agent did not provide commitMessage'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain('correlationId=corr-123');
      expect(warnMessage).toContain('using fallback');
    });

    it('should return failure with error when push is rejected', async () => {
      const resultWithMsg: ExecuteResult = {
        ...successResult,
        commitMessage: '#12: some change',
      };
      mockExecute.mockResolvedValue(resultWithMsg);
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd === 'git status --porcelain') {
            cb(null, { stdout: ' M file.ts\n', stderr: '' });
          } else if (cmd.startsWith('git push')) {
            cb(new Error('rejected: non-fast-forward'), {
              stdout: '',
              stderr: 'rejected: non-fast-forward',
            });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Commit/push failed');
      expect(result.error).toContain('push rejected');
    });

    it('should NOT call commitAndPush when SDK returns failure', async () => {
      mockExecute.mockResolvedValue(failureResult);

      await handler.handle(baseRequest);

      const statusCall = (mockExec.mock.calls as unknown[][]).find(
        (call) => call[0] === 'git status --porcelain',
      );
      // git status --porcelain should NOT be called because commitAndPush is skipped
      expect(statusCall).toBeUndefined();
    });

    it('should pass multi-line commitMessage through verbatim', async () => {
      const multiLineMsg =
        '#12: implement handler-controlled commit\n\n- Add commitAndPush method\n- Wire into runInvocation';
      const resultWithMsg: ExecuteResult = {
        ...successResult,
        commitMessage: multiLineMsg,
      };
      mockExecute.mockResolvedValue(resultWithMsg);
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd === 'git status --porcelain') {
            cb(null, { stdout: ' M src/handler.ts\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      const commitCmd = cmds.find((c) => c.startsWith('git commit'));
      expect(commitCmd).toBeDefined();
      // Multi-line message should appear in the commit command
      expect(commitCmd).toContain('#12: implement handler-controlled commit');
      expect(commitCmd).toContain('Add commitAndPush method');
    });
  });
  describe('worktree lifecycle (#11)', () => {
    it('should run git fetch, worktree add, execute, then worktree remove', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      // Expect: fetch, worktree add, status check (commitAndPush, no changes), worktree remove
      expect(cmds[0]).toBe('git fetch origin');
      expect(cmds[1]).toMatch(/^git worktree add/);
      expect(cmds[1]).toContain(baseRequest.correlationId);
      expect(cmds[1]).toContain(baseRequest.branch);
      // git status --porcelain from commitAndPush (no changes → no commit/push)
      expect(cmds[2]).toBe('git status --porcelain');
      // worktree remove is last (finally block)
      expect(cmds[3]).toMatch(/^git worktree remove --force/);
      expect(cmds[3]).toContain(baseRequest.correlationId);
    });

    it('should return failure without calling execute when git fetch fails', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd === 'git fetch origin') {
            cb(new Error('network error'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Worktree creation failed');
      expect(result.error).toContain('git fetch origin');
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should return failure without calling execute when git worktree add fails', async () => {
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd.startsWith('git worktree add')) {
            cb(new Error("fatal: 'nonexistent' is not a commit"));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Worktree creation failed');
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should remove worktree even when SDK execution throws', async () => {
      mockExecute.mockRejectedValue(new Error('SDK crash'));

      await handler.handle(baseRequest);

      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      const removeCmd = cmds.find((c) => c.startsWith('git worktree remove'));
      expect(removeCmd).toBeDefined();
    });

    it('should log warning when worktree cleanup fails', async () => {
      mockExecute.mockResolvedValue(successResult);
      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (cmd.startsWith('git worktree remove')) {
            cb(new Error('worktree locked'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      const result = await handler.handle(baseRequest);

      // Invocation still succeeds despite cleanup failure
      expect(result.success).toBe(true);
      const warnMessage = (warnSpy.mock.calls as unknown[][]).find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Worktree cleanup failed'),
      )?.[0] as string;
      expect(warnMessage).toBeDefined();
      expect(warnMessage).toContain(baseRequest.correlationId);
    });

    it('should use workspaceDir as cwd for git fetch and worktree commands', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      // git fetch cwd
      const fetchCall = (mockExec.mock.calls as unknown[][]).find(
        (call) => call[0] === 'git fetch origin',
      );
      expect(fetchCall![1]).toEqual({
        cwd: '/mnt/quorum/workspace',
      });

      // git worktree add cwd
      const addCall = (mockExec.mock.calls as unknown[][]).find((call) =>
        (call[0] as string).startsWith('git worktree add'),
      );
      expect(addCall![1]).toEqual({
        cwd: '/mnt/quorum/workspace',
      });
    });
  });

  describe('node_modules symlink (#45)', () => {
    const expectedSymlinkTarget = `/var/agent-worktrees/${baseRequest.correlationId}/node_modules`;

    it('should create node_modules symlink with correct argv after worktree add', async () => {
      mockExecute.mockResolvedValue(successResult);

      await handler.handle(baseRequest);

      expect(mockExecFile).toHaveBeenCalledWith(
        'ln',
        ['-s', '/app/node_modules', expectedSymlinkTarget],
        expect.any(Function),
      );
    });

    it('should run symlink after worktree add and before SDK execute', async () => {
      const callOrder: string[] = [];

      mockExec.mockImplementation(
        (
          cmd: string,
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callOrder.push(cmd.split(' ').slice(0, 3).join(' '));
          cb(null, { stdout: '', stderr: '' });
        },
      );

      mockExecFile.mockImplementation(
        (
          _file: string,
          _args: string[],
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callOrder.push('ln -s');
          cb(null, { stdout: '', stderr: '' });
        },
      );

      mockExecute.mockImplementation(async () => {
        callOrder.push('sdk-execute');
        return successResult;
      });

      await handler.handle(baseRequest);

      const addIdx = callOrder.findIndex((c) =>
        c.startsWith('git worktree add'),
      );
      const symlinkIdx = callOrder.indexOf('ln -s');
      const executeIdx = callOrder.indexOf('sdk-execute');

      expect(addIdx).toBeGreaterThanOrEqual(0);
      expect(symlinkIdx).toBeGreaterThan(addIdx);
      expect(executeIdx).toBeGreaterThan(symlinkIdx);
    });

    it('should return failure and clean up worktree when symlink fails', async () => {
      mockExecFile.mockImplementation(
        (_file: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error('EEXIST: file already exists'));
        },
      );

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Worktree setup failed: node_modules symlink',
      );
      expect(result.error).toContain('EEXIST');
      expect(mockExecute).not.toHaveBeenCalled();
      // Worktree cleanup should have been attempted
      const cmds = (mockExec.mock.calls as unknown[][]).map(
        (call) => call[0] as string,
      );
      const removeCmd = cmds.find((c) =>
        c.startsWith('git worktree remove --force'),
      );
      expect(removeCmd).toBeDefined();
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
