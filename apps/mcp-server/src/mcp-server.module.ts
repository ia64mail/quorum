import { Module } from '@nestjs/common';
import { McpServerConfigModule } from './config';
import { HealthModule } from './health';
import { McpModule } from './mcp';

@Module({
  imports: [McpServerConfigModule, HealthModule, McpModule],
})
export class McpServerModule {}
