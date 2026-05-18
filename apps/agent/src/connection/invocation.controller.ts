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
import { InvocationHandler } from './invocation-handler.service';

@Controller()
export class InvocationController {
  constructor(private readonly handler: InvocationHandler) {}

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

    return this.handler.handle(parsed.data);
  }
}
