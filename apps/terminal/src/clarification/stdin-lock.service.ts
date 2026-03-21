import { Injectable } from '@nestjs/common';

export type ReleaseFn = () => void;

/**
 * Async mutex for stdin access coordination.
 *
 * Both {@link ChatService} and {@link ClarificationHandler} need exclusive
 * access to stdin. This service serialises access so that clarification
 * prompts never interleave with the normal chat loop.
 */
@Injectable()
export class StdinLockService {
  private pending: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire exclusive stdin access.
   * Resolves immediately if free, otherwise queues until the current holder releases.
   */
  acquire(): Promise<ReleaseFn> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<ReleaseFn>((resolve) => {
      this.pending.push(() => resolve(this.createRelease()));
    });
  }

  /** Whether the lock is currently held. */
  isLocked(): boolean {
    return this.locked;
  }

  private createRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.pending.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    };
  }
}
