import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { opensearchConfig } from '../../config/opensearch.config';
import { OpenSearchSetupService } from './opensearch-setup.service';

@Module({
  imports: [ConfigModule.forFeature(opensearchConfig)],
  providers: [OpenSearchSetupService],
  exports: [OpenSearchSetupService],
})
export class OpenSearchModule {}
