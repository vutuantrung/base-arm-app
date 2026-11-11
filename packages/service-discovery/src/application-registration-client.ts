import type { ApplicationRegistration } from './application-registry.js';

export interface RegistrationClientOptions extends ApplicationRegistration {
  supervisorUrl: string;
  token: string;
  intervalMs?: number;
}

/**
 * Self-registration from an independently started ARM-enabled application.
 * Re-registering doubles as heartbeat and automatically repairs Supervisor
 * restarts without modifying process ownership.
 */
export class ApplicationRegistrationClient {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(private readonly options: RegistrationClientOptions) {
    if (!options.token) throw new Error('Registration token is required');
    if ((options.intervalMs ?? 15000) < 1000) throw new Error('intervalMs must be >= 1000');
  }

  async register(): Promise<void> {
    const endpoint = new URL('/applications/register', this.options.supervisorUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        applicationId: this.options.applicationId,
        instanceId: this.options.instanceId,
        metricsUrl: this.options.metricsUrl,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Registration failed: HTTP ${response.status}`);
  }

  start(onError: (error: unknown) => void = () => {}): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      try { await this.register(); }
      catch (error) { onError(error); }
      finally { this.inFlight = false; }
    };
    void tick();
    this.timer = setInterval(() => { void tick(); }, this.options.intervalMs ?? 15000);
    this.timer.unref();
  }

  /** Stops registration heartbeats; does not stop the app or its ARM server. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async unregister(): Promise<void> {
    this.stop();
    const response = await fetch(new URL('/applications/unregister', this.options.supervisorUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        applicationId: this.options.applicationId,
        instanceId: this.options.instanceId,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Unregister failed: HTTP ${response.status}`);
    }
  }
}
