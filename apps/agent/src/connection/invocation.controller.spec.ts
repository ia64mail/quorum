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
});
