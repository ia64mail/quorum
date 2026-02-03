import { Injectable } from '@nestjs/common';

@Injectable()
export class TerminalService {
  getHello(): string {
    return 'Hello World!';
  }
}
