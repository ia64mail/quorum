import { Controller, Get } from '@nestjs/common';
import { TerminalService } from './terminal.service';

@Controller()
export class TerminalController {
  constructor(private readonly terminalService: TerminalService) {}

  @Get()
  getHello(): string {
    return this.terminalService.getHello();
  }
}
