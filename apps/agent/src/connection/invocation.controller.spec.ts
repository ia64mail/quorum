import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { InvocationController } from './invocation.controller';
import { InvocationHandler } from './invocation-handler.service';

const mockHandler = {
  handle: jest.fn<Promise<InvokeResponse>, [InvokeRequest]>(),
};

describe('InvocationController', () => {
  let controller: InvocationController;

  const validBody = {
    correlationId: 'corr-1',
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'design API',
    wait: true,
    depth: 0,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvocationController],
      providers: [{ provide: InvocationHandler, useValue: mockHandler }],
    }).compile();

    controller = module.get<InvocationController>(InvocationController);
  });

  it('should delegate valid request to handler and return response', async () => {
    const expected: InvokeResponse = {
      success: true,
      result: '[architect] Acknowledged: "design API"',
    };
    mockHandler.handle.mockResolvedValue(expected);

    const result = await controller.invoke(validBody);

    expect(mockHandler.handle).toHaveBeenCalledWith(validBody);
    expect(result).toEqual(expected);
  });

  it('should throw 400 for missing required fields', async () => {
    const invalidBody = { caller: AgentRole.moderator };

    await expect(controller.invoke(invalidBody)).rejects.toThrow(HttpException);
    try {
      await controller.invoke(invalidBody);
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(mockHandler.handle).not.toHaveBeenCalled();
  });

  it('should throw 400 for invalid enum value', async () => {
    const invalidBody = {
      ...validBody,
      caller: 'invalid-role',
    };

    await expect(controller.invoke(invalidBody)).rejects.toThrow(HttpException);
    expect(mockHandler.handle).not.toHaveBeenCalled();
  });

  it('should pass optional context through to handler', async () => {
    const bodyWithContext = {
      ...validBody,
      context: { ticket: 'QRM1-007' },
    };
    mockHandler.handle.mockResolvedValue({ success: true });

    await controller.invoke(bodyWithContext);

    expect(mockHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ context: { ticket: 'QRM1-007' } }),
    );
  });

  // Regression guard for QRM6-BUG-005 second root cause: the Zod schema must
  // declare every optional field on InvokeRequest, otherwise z.object() strips
  // it before the handler runs and downstream consumers (e.g. session resume
  // via ClaudeCodeService) silently behave as if the field was never sent.
  it('should pass optional sessionId through to handler', async () => {
    const bodyWithSession = {
      ...validBody,
      sessionId: 'sess-abc-123',
    };
    mockHandler.handle.mockResolvedValue({ success: true });

    await controller.invoke(bodyWithSession);

    expect(mockHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-abc-123' }),
    );
  });

  // Regression guard for QRM6-BUG-014: bootstrapContext was silently stripped
  // by the Zod schema because the field was missing. The broker assembles
  // bootstrap context and POSTs it; the agent must preserve it through to the
  // handler so renderBootstrapContext can produce the Prior Decisions section.
  it('should pass optional bootstrapContext through to handler (BUG-014)', async () => {
    const bootstrapContext = {
      project: { 'tech-stack': 'NestJS with TypeScript' },
      conversation: { 'task-breakdown': 'implement auth module' },
      meta: {
        itemCount: 2,
        estimatedTokens: 581,
        scopesQueried: ['project', 'conversation'] as const,
      },
    };
    const bodyWithBootstrap = {
      ...validBody,
      bootstrapContext,
    };
    mockHandler.handle.mockResolvedValue({ success: true });

    await controller.invoke(bodyWithBootstrap);

    expect(mockHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapContext }),
    );
    // Verify deep equality — the parsed data must exactly match the input
    const passedArg = mockHandler.handle.mock.calls[0][0];
    expect(passedArg.bootstrapContext).toEqual(bootstrapContext);
  });

  it('should accept request without bootstrapContext (optional field)', async () => {
    mockHandler.handle.mockResolvedValue({ success: true });

    await controller.invoke(validBody);

    const passedArg = mockHandler.handle.mock.calls[0][0];
    expect(passedArg.bootstrapContext).toBeUndefined();
  });
});
