import { Module } from '@nestjs/common';
import { ContextStoreModule } from '../context-store';
import { MessagingModule } from '../messaging';
import { RegistryModule } from '../registry';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [MessagingModule, ContextStoreModule.forRoot(), RegistryModule],
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
