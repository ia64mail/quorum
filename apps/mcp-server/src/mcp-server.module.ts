import { Module, Type } from '@nestjs/common';
import { McpServerConfigModule } from './config';
import { ContextStoreModule } from './context-store';
import { HealthModule } from './health';
import { McpModule } from './mcp';
import { TestModule } from './testing';

const conditionalImports: Type[] = [];
if (process.env.ENABLE_TEST_ENDPOINTS === 'true') {
  conditionalImports.push(TestModule);
}

@Module({
  imports: [
    McpServerConfigModule,
    ContextStoreModule.forRoot(),
    HealthModule.forRoot(),
    McpModule,
    ...conditionalImports,
  ],
})
export class McpServerModule {}
