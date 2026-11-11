import { createServer } from 'node:net';

/**
 * Port leases are process-local hints, NOT OS socket ownership.
 * An ephemeral probe is released before the child binds, so EADDRINUSE
 * is still possible. Health checks must verify the destination before routing.
 */
export class DynamicPortAllocator {
  private static readonly claimed = new Set<number>();

  async allocate(excluded: ReadonlySet<number> = new Set()): Promise<number> {
    for (let i = 0; i < 30; i++) {
      const port = await this.findEphemeralPort();
      if (excluded.has(port) || DynamicPortAllocator.claimed.has(port)) continue;
      DynamicPortAllocator.claimed.add(port);
      return port;
    }
    throw new Error('Unable to allocate dynamic child HTTP port');
  }

  claim(port: number): void {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid child HTTP port');
    }
    if (DynamicPortAllocator.claimed.has(port)) {
      throw new Error(`Child HTTP port already claimed by Supervisor: ${port}`);
    }
    DynamicPortAllocator.claimed.add(port);
  }

  release(port: number): void {
    DynamicPortAllocator.claimed.delete(port);
  }

  private async findEphemeralPort(): Promise<number> {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No dynamic port address');
      return address.port;
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()));
      }
    }
  }
}
