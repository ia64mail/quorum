import { Module } from '@nestjs/common';
import { McpServerConfigModule } from './config';
import { ContextStoreModule } from './context-store';
import { McpServerController } from './mcp-server.controller';
import { McpServerService } from './mcp-server.service';

@Module({
  imports: [McpServerConfigModule, ContextStoreModule],
  controllers: [McpServerController],
  providers: [McpServerService],
})
export class McpServerModule {}
