import { Test, TestingModule } from '@nestjs/testing';
import { TerminalController } from './terminal.controller';
import { TerminalService } from './terminal.service';

describe('TerminalController', () => {
  let terminalController: TerminalController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TerminalController],
      providers: [TerminalService],
    }).compile();

    terminalController = app.get<TerminalController>(TerminalController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(terminalController.getHello()).toBe('Hello World!');
    });
  });
});
