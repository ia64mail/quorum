import { Injectable } from '@nestjs/common';

@Injectable()
export class McpServerService {
  getHello(): string {
    return 'Hello World!';
  }
}
