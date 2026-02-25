import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { MessageBroker } from '../messaging';
import { TestController } from './test.controller';

describe('TestController', () => {
  let controller: TestController;
  let broker: { invoke: jest.Mock };

  beforeEach(async () => {
    broker = { invoke: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TestController],
      providers: [{ provide: MessageBroker, useValue: broker }],
    }).compile();

    controller = module.get<TestController>(TestController);
  });

  const validBody: InvokeRequest = {
    correlationId: 'test-001',
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'ping',
    wait: true,
    depth: 0,
  };

  it('should pass valid request to broker and return response', async () => {
    const response: InvokeResponse = { success: true, result: 'pong' };
    broker.invoke.mockResolvedValue(response);

    const result = await controller.invoke(validBody);

    expect(result).toEqual(response);
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'test-001',
        target: AgentRole.architect,
      }),
    );
  });

  it('should return broker error responses as-is', async () => {
    const response: InvokeResponse = {
      success: false,
      error: 'Agent qa not registered',
    };
    broker.invoke.mockResolvedValue(response);

    const body = { ...validBody, target: AgentRole.qa };
    const result = await controller.invoke(body);

    expect(result).toEqual(response);
  });

  it('should reject invalid body with 400', async () => {
    await expect(controller.invoke({ bad: 'data' })).rejects.toThrow(
      HttpException,
    );

    try {
      await controller.invoke({ bad: 'data' });
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('should reject body missing required fields', async () => {
    const incomplete = { correlationId: 'x', caller: 'moderator' };

    await expect(controller.invoke(incomplete)).rejects.toThrow(HttpException);
  });
});
