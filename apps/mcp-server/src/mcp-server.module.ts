import { Module } from '@nestjs/common';
import { McpServerController } from './mcp-server.controller';
import { McpServerService } from './mcp-server.service';

@Module({
  imports: [],
  controllers: [McpServerController],
  providers: [McpServerService],
})
export class McpServerModule {}
