import { Module } from '@nestjs/common';
import { ContextStoreModule } from '../context-store/context-store.module';
import { RegistryModule } from '../registry';
import { BootstrapContextService } from './bootstrap-context.service';
import { MessageBroker } from './message-broker.service';

@Module({
  imports: [RegistryModule, ContextStoreModule],
  providers: [MessageBroker, BootstrapContextService],
  exports: [MessageBroker, BootstrapContextService],
})
export class MessagingModule {}
