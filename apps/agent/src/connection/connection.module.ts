import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../config';
import { McpClientService } from './mcp-client.service';
import { InvocationHandler } from './invocation-handler.service';
import { InvocationController } from './invocation.controller';

@Module({
  imports: [AgentConfigModule],
  providers: [McpClientService, InvocationHandler],
  controllers: [InvocationController],
  exports: [McpClientService],
})
export class ConnectionModule {}
