import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from '@app/common';
import { bootstrapConfig } from './bootstrap.config';
import { brokerConfig } from './broker.config';
import { contextConfig } from './context.config';
import { contextStoreConfig } from './context-store.config';
import { embeddingConfig } from './embedding.config';
import { opensearchConfig } from './opensearch.config';
import { McpServerConfigService } from './mcp-server-config.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        bootstrapConfig,
        brokerConfig,
        contextConfig,
        contextStoreConfig,
        embeddingConfig,
        opensearchConfig,
      ],
    }),
  ],
  providers: [McpServerConfigService],
  exports: [McpServerConfigService],
})
export class McpServerConfigModule {}
