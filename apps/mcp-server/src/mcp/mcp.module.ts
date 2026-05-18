import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging';
import { ObservabilityModule } from '../observability';
import { RegistryModule } from '../registry';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [MessagingModule, ObservabilityModule, RegistryModule],
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
