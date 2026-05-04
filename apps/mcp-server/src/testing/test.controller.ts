import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { invokeRequestSchema } from '@app/common';
import type { InvokeResponse } from '@app/common';
import { MessageBroker } from '../messaging';

@Controller('test')
export class TestController {
  constructor(private readonly broker: MessageBroker) {}

  @Post('invoke')
  @HttpCode(HttpStatus.OK)
  async invoke(@Body() body: unknown): Promise<InvokeResponse> {
    const parsed = invokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { message: 'Invalid invoke request', errors: parsed.error.issues },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.broker.invoke(parsed.data);
  }
}
