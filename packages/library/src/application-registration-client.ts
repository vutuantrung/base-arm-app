/**
 * Optional self-registration client for an ARM-enabled Node.js application.
 *
 * This module depends only on Node.js fetch and does not import Supervisor code.
 * Registering an application grants monitoring, never process control.
 */
export interface ApplicationRegistration {
  applicationId: string;
  instanceId: string;
  metricsUrl: string;
}

export interface RegistrationClientOptions extends ApplicationRegistration {
  supervisorUrl: string;
  /** Bearer token configured on the Supervisor Registration API. */
  token: string;
  /** Registration heartbeat period; default 15 seconds. */
  intervalMs?: number;
  /** HTTP request timeout; default 5 seconds. */
  requestTimeoutMs?: number;
}

export type RegistrationErrorHandler = (error: unknown) => void;

const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]';
}

function isSecureSupervisorEndpoint(url: URL): boolean {
  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
}

function validateRegistrationOptions(options: RegistrationClientOptions): void {
  if (!IDENTIFIER_PATTERN.test(options.applicationId) ||
      !IDENTIFIER_PATTERN.test(options.instanceId)) {
    throw new Error('Invalid applicationId or instanceId');
  }
  if (!options.token) throw new Error('Supervisor registration token is required');

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error('Registration intervalMs must be >= 1000');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100) {
    throw new Error('Registration requestTimeoutMs must be >= 100');
  }

  const supervisor = new URL(options.supervisorUrl);
  if (!isSecureSupervisorEndpoint(supervisor) ||
      supervisor.username || supervisor.password ||
      supervisor.search || supervisor.hash) {
    throw new Error('Supervisor requires HTTPS or loopback HTTP');
  }

  const metrics = new URL(options.metricsUrl);
  if (!['ws:', 'wss:'].includes(metrics.protocol) ||
      metrics.pathname !== '/metrics/ws' ||
      metrics.username || metrics.password ||
      metrics.search || metrics.hash) {
    throw new Error('Invalid ARM metrics WebSocket endpoint');
  }
}

/**
 * Periodically advertises an independently started application to Supervisor.
 * Does not manage processes or alter ARM health / recovery behavior.
 */
export class ApplicationRegistrationClient {
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly registrationEndpoint: URL;
  private readonly unregistrationEndpoint: URL;
  private timer?: NodeJS.Timeout;
  private ongoing?: Promise<void>;
  private generation = 0;

  constructor(private readonly options: RegistrationClientOptions) {
    validateRegistrationOptions(options);
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.registrationEndpoint = new URL('/applications/register', options.supervisorUrl);
    this.unregistrationEndpoint = new URL('/applications/unregister', options.supervisorUrl);
  }

  /** Single registration attempt. Can also be called without start(). */
  async register(): Promise<void> {
    await this.sendRegistrationRequest(this.registrationEndpoint, {
      applicationId: this.options.applicationId,
      instanceId: this.options.instanceId,
      metricsUrl: this.options.metricsUrl,
    });
  }

  /**
   * Starts periodic registration, including an immediate first attempt.
   * HTTP failure is non-fatal; subsequent ticks retry automatically.
   */
  start(onError: RegistrationErrorHandler = () => {}): void {
    if (this.timer) return;
    const currentGeneration = ++this.generation;
    const tick = () => {
      if (this.ongoing) return;
      const attempt = this.register();
      this.ongoing = attempt;
      void attempt.catch(error => {
        if (currentGeneration === this.generation) onError(error);
      }).finally(() => {
        if (this.ongoing === attempt) this.ongoing = undefined;
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  /** Stops registration heartbeats without stopping the application or ARM. */
  stop(): void {
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Voluntary removal; failure does not shut down the business application. */
  async unregister(): Promise<void> {
    this.stop();
    // Avoid racing a previous heartbeat with an explicit unregister.
    if (this.ongoing) await this.ongoing.catch(() => {});
    await this.sendRegistrationRequest(this.unregistrationEndpoint, {
      applicationId: this.options.applicationId,
      instanceId: this.options.instanceId,
    }, [200, 404]);
  }

  private async sendRegistrationRequest(
    endpoint: URL,
    payload: Record<string, string>,
    acceptedStatuses: number[] = [200],
  ): Promise<void> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!acceptedStatuses.includes(response.status)) {
      throw new Error(`ARM registration request failed: HTTP ${response.status}`);
    }
  }
}
