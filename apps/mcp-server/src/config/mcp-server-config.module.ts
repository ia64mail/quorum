import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from '@app/common';
import { brokerConfig } from './broker.config';
import { contextConfig } from './context.config';
import { contextStoreConfig } from './context-store.config';
import { McpServerConfigService } from './mcp-server-config.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, brokerConfig, contextConfig, contextStoreConfig],
    }),
  ],
  providers: [McpServerConfigService],
  exports: [McpServerConfigService],
})
export class McpServerConfigModule {}
