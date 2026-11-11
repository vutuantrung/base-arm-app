import type { HttpEndpoint, TrafficRouter } from '../../contracts/src/index.js';
import { BlueGreenHttpProxy } from './blue-green-http-proxy.js';

/**
 * Adapter for a single Blue/Green proxy. The orchestrator must verify
 * candidate readiness before activate; this adapter only switches a route.
 */
export class BlueGreenTrafficRouterAdapter implements TrafficRouter {
  private previousSlot?: 'blue' | 'green';

  constructor(
    private readonly applicationId: string,
    private readonly proxy: BlueGreenHttpProxy,
  ) {}

  async activate(applicationId: string, target: HttpEndpoint): Promise<void> {
    this.assertApplication(applicationId);
    const slot = this.slotFromEndpoint(target);
    if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535 ||
      target.host !== '127.0.0.1' || target.applicationId !== applicationId ||
      target.mode !== 'blue-green') {
      throw new Error('Invalid Blue/Green routing target');
    }
    const old = this.proxy.current();
    this.proxy.switchTo({ slot, port: target.port });
    this.previousSlot = old && old.slot !== slot ? old.slot : undefined;
  }

  async current(applicationId: string): Promise<HttpEndpoint | undefined> {
    this.assertApplication(applicationId);
    const current = this.proxy.current();
    if (!current) return undefined;
    return {
      applicationId,
      instanceId: `${applicationId}-${current.slot}`,
      host: '127.0.0.1',
      port: current.port,
      url: `http://127.0.0.1:${current.port}`,
      mode: 'blue-green',
    };
  }

  /** Drains the previous slot after a traffic switch, not the new active slot. */
  async drain(applicationId: string, timeoutMs: number): Promise<boolean> {
    this.assertApplication(applicationId);
    if (!this.previousSlot) return true;
    const drained = await this.proxy.drain(this.previousSlot, timeoutMs);
    if (drained) this.previousSlot = undefined;
    return drained;
  }

  private assertApplication(applicationId: string): void {
    if (applicationId !== this.applicationId) {
      throw new Error('Unknown Blue/Green application: ' + applicationId);
    }
  }

  private slotFromEndpoint(target: HttpEndpoint): 'blue' | 'green' {
    if (target.instanceId === `${this.applicationId}-blue`) return 'blue';
    if (target.instanceId === `${this.applicationId}-green`) return 'green';
    throw new Error('Invalid Blue/Green slot identity');
  }
}
