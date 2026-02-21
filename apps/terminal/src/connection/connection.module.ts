import { Module } from '@nestjs/common';
import { TerminalConfigModule } from '../config';
import { McpClientService } from './mcp-client.service';

@Module({
  imports: [TerminalConfigModule],
  providers: [McpClientService],
  exports: [McpClientService],
})
export class ConnectionModule {}
