import { StdinLockService } from './stdin-lock.service';

describe('StdinLockService', () => {
  let service: StdinLockService;

  beforeEach(() => {
    service = new StdinLockService();
  });

  it('should not be locked initially', () => {
    expect(service.isLocked()).toBe(false);
  });

  it('should acquire and release the lock', async () => {
    const release = await service.acquire();
    expect(service.isLocked()).toBe(true);
    release();
    expect(service.isLocked()).toBe(false);
  });

  it('should queue waiters and resolve them in FIFO order', async () => {
    const order: number[] = [];

    const release1 = await service.acquire();
    order.push(1);

    const p2 = service.acquire().then((release) => {
      order.push(2);
      return release;
    });

    const p3 = service.acquire().then((release) => {
      order.push(3);
      return release;
    });

    // release1 unblocks the first waiter
    release1();
    const release2 = await p2;

    release2();
    const release3 = await p3;

    release3();
    expect(order).toEqual([1, 2, 3]);
    expect(service.isLocked()).toBe(false);
  });

  it('should ignore double-release', async () => {
    const release = await service.acquire();
    release();
    release(); // second call is a no-op
    expect(service.isLocked()).toBe(false);

    // Lock should still be acquirable
    const release2 = await service.acquire();
    expect(service.isLocked()).toBe(true);
    release2();
  });

  it('should hand the lock to the next waiter on release (not unlock)', async () => {
    const release1 = await service.acquire();

    const p2 = service.acquire();

    // Releasing should hand off to p2, so isLocked stays true
    release1();
    const release2 = await p2;
    expect(service.isLocked()).toBe(true);

    release2();
    expect(service.isLocked()).toBe(false);
  });
});
