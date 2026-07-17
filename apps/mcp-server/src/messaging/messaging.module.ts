import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability';
import { RegistryModule } from '../registry';
import { BootstrapContextService } from './bootstrap-context.service';
import { InvocationResultStore } from './invocation-result-store';
import { MessageBroker } from './message-broker.service';

@Module({
  // ObservabilityModule has no imports of its own, so this creates no
  // circular dependency; McpModule already imports both MessagingModule and
  // ObservabilityModule directly, so the ContextSearchTraceLogger singleton
  // (one JSONL stream) is shared, not duplicated (#70 follow-up).
  imports: [RegistryModule, ObservabilityModule],
  providers: [MessageBroker, BootstrapContextService, InvocationResultStore],
  exports: [MessageBroker, BootstrapContextService, InvocationResultStore],
})
export class MessagingModule {}
