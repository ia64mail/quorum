import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { appConfig } from '@app/common';
import { bootstrapConfig } from './bootstrap.config';
import { brokerConfig } from './broker.config';
import { contextConfig } from './context.config';
import { contextStoreConfig } from './context-store.config';

@Injectable()
export class McpServerConfigService {
  constructor(
    @Inject(appConfig.KEY)
    public readonly app: ConfigType<typeof appConfig>,
    @Inject(bootstrapConfig.KEY)
    public readonly bootstrap: ConfigType<typeof bootstrapConfig>,
    @Inject(brokerConfig.KEY)
    public readonly broker: ConfigType<typeof brokerConfig>,
    @Inject(contextConfig.KEY)
    public readonly context: ConfigType<typeof contextConfig>,
    /**
     * Exposes `backend` ('inmemory' | 'opensearch') so consumers (e.g.
     * BootstrapContextService, #70) can gate ranked-search behavior on the
     * active Context Store backend without re-injecting the config token
     * directly. `contextStoreConfig` is already loaded via
     * `ConfigModule.forRoot` (see McpServerConfigModule) — this only adds
     * the getter.
     */
    @Inject(contextStoreConfig.KEY)
    public readonly contextStore: ConfigType<typeof contextStoreConfig>,
  ) {}
}
