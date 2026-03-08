import * as readline from 'readline';
import { ClarificationHandler } from './clarification.service';
import { StdinLockService } from './stdin-lock.service';
import type { InvokeRequest } from '@app/common';
import { AgentRole } from '@app/common';
import type { McpClientService } from '../connection';

jest.mock('readline');

const mockCreateInterface = readline.createInterface as jest.Mock;

function makeRequest(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    correlationId: 'test-corr-id',
    caller: AgentRole.architect,
    target: AgentRole.moderator,
    action: 'Should we use push or pull architecture?',
    wait: true,
    depth: 1,
    ...overrides,
  };
}

describe('ClarificationHandler', () => {
  let handler: ClarificationHandler;
  let stdinLock: StdinLockService;
  let mockCallTool: jest.Mock;
  let mockRl: { question: jest.Mock; close: jest.Mock; on: jest.Mock };
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    stdinLock = new StdinLockService();
    mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Stored' }],
    });

    const mcpClient = {
      callTool: mockCallTool,
    } as unknown as McpClientService;

    mockRl = {
      question: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
    };
    mockCreateInterface.mockReturnValue(mockRl);

    handler = new ClarificationHandler(mcpClient, stdinLock);

    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    jest.clearAllMocks();
  });

  function getStdoutOutput(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('should display the question with agent attribution', async () => {
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) => cb('pull-based'),
    );

    await handler.handle(makeRequest());

    const output = getStdoutOutput();
    expect(output).toContain('Clarification from architect');
    expect(output).toContain('Should we use push or pull architecture?');
  });

  it('should return user answer as InvokeResponse', async () => {
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) =>
        cb('pull-based architecture'),
    );

    const response = await handler.handle(makeRequest());

    expect(response).toEqual({
      success: true,
      result: 'pull-based architecture',
    });
  });

  it('should call context_store with correct parameters', async () => {
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) => cb('use JWT'),
    );

    await handler.handle(makeRequest());

    expect(mockCallTool).toHaveBeenCalledWith(
      'context_store',
      expect.objectContaining({
        scope: 'project',
        agentRole: 'moderator',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        value: expect.objectContaining({
          question: 'Should we use push or pull architecture?',
          answer: 'use JWT',
          askedBy: AgentRole.architect,
          correlationId: 'test-corr-id',
        }),
      }),
    );
  });

  it('should return error for empty answer', async () => {
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) => cb('   '),
    );

    const response = await handler.handle(makeRequest());

    expect(response.success).toBe(false);
    expect(response.error).toContain('Empty answer');
  });

  it('should still return answer if context_store fails', async () => {
    mockCallTool.mockRejectedValue(new Error('MCP offline'));
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) => cb('my answer'),
    );

    const response = await handler.handle(makeRequest());

    expect(response).toEqual({
      success: true,
      result: 'my answer',
    });
  });

  it('should acquire and release stdin lock', async () => {
    mockRl.question.mockImplementation(
      (_prompt: string, cb: (answer: string) => void) => {
        expect(stdinLock.isLocked()).toBe(true);
        cb('answer');
      },
    );

    await handler.handle(makeRequest());

    expect(stdinLock.isLocked()).toBe(false);
  });

  it('should release lock even on error', async () => {
    mockRl.question.mockImplementation(() => {
      throw new Error('stdin broken');
    });

    const response = await handler.handle(makeRequest());

    expect(response.success).toBe(false);
    expect(stdinLock.isLocked()).toBe(false);
  });
});
