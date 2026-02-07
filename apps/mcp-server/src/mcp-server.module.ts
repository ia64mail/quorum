import { Module } from '@nestjs/common';
import { McpServerController } from './mcp-server.controller';
import { McpServerService } from './mcp-server.service';
import { ContextStoreModule } from './context-store';

@Module({
  imports: [ContextStoreModule],
  controllers: [McpServerController],
  providers: [McpServerService],
})
export class McpServerModule {}
