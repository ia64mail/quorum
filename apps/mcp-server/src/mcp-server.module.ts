import { Module } from '@nestjs/common';
import { McpServerConfigModule } from './config';
import { McpModule } from './mcp';

@Module({
  imports: [McpServerConfigModule, McpModule],
})
export class McpServerModule {}
