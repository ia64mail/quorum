import { Controller, Get } from '@nestjs/common';
import { McpServerService } from './mcp-server.service';

@Controller()
export class McpServerController {
  constructor(private readonly mcpServerService: McpServerService) {}

  @Get()
  getHello(): string {
    return this.mcpServerService.getHello();
  }
}
