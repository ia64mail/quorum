import { Test, TestingModule } from '@nestjs/testing';
import { McpServerController } from './mcp-server.controller';
import { McpServerService } from './mcp-server.service';

describe('McpServerController', () => {
  let mcpServerController: McpServerController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [McpServerController],
      providers: [McpServerService],
    }).compile();

    mcpServerController = app.get<McpServerController>(McpServerController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(mcpServerController.getHello()).toBe('Hello World!');
    });
  });
});
