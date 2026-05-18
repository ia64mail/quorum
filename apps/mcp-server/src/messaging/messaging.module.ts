import { Module } from '@nestjs/common';
import { RegistryModule } from '../registry';
import { BootstrapContextService } from './bootstrap-context.service';
import { InvocationResultStore } from './invocation-result-store';
import { MessageBroker } from './message-broker.service';

@Module({
  imports: [RegistryModule],
  providers: [MessageBroker, BootstrapContextService, InvocationResultStore],
  exports: [MessageBroker, BootstrapContextService, InvocationResultStore],
})
export class MessagingModule {}
