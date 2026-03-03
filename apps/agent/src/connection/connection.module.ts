import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { LlmModule } from '../llm';
import { PromptsModule } from '../prompts';
import { McpClientService } from './mcp-client.service';
import { McpToolBridgeService } from './mcp-tool-bridge.service';
import { InvocationHandler } from './invocation-handler.service';
import { InvocationController } from './invocation.controller';

@Module({
  imports: [AgentConfigModule, LlmModule, PromptsModule],
  providers: [McpClientService, McpToolBridgeService, InvocationHandler],
  controllers: [InvocationController],
  exports: [McpClientService, McpToolBridgeService],
})
export class ConnectionModule {}
