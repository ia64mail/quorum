import { Module } from '@nestjs/common';
import { ContextSearchTraceLogger } from './context-search-trace-logger.service';

@Module({
  providers: [ContextSearchTraceLogger],
  exports: [ContextSearchTraceLogger],
})
export class ObservabilityModule {}
