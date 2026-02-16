import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { LlmModule } from '../llm';
import { McpClientService } from './mcp-client.service';
import { InvocationHandler } from './invocation-handler.service';
import { InvocationController } from './invocation.controller';

@Module({
  imports: [AgentConfigModule, LlmModule],
  providers: [McpClientService, InvocationHandler],
  controllers: [InvocationController],
  exports: [McpClientService],
})
export class ConnectionModule {}
