import type {
  HealthResult,
  ManagedComponent,
} from '../../core/src/reliability.js';
import type { OperationContext } from '../../core/src/operations.js';

/**
 * A connected resource owned by exactly one component instance.
 *
 * Implementations may represent a database pool, WebSocket session,
 * message broker channel or another connection-oriented resource.
 */
export interface ResourceSession {
  checkHealth(signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Creates a fresh session. If a session needs subscriptions or listeners,
 * install them before returning from create().
 */
export interface ResourceFactory<T extends ResourceSession> {
  create(signal: AbortSignal): Promise<T>;
}

export interface ReconnectableResourceOptions {
  id: string;
  /**
   * Optional diagnostic callback. Cleanup of an old session happens after
   * the new session is committed; cleanup failure must not undo that commit.
   */
  onCleanupError?: (error: unknown) => void;
}

/**
 * Adapts a connection-oriented dependency to ARM's ManagedComponent contract.
 *
 * The new session is built and checked before it replaces the old one.
 * An aborted/stale attempt cannot commit a new session.
 */
export class ReconnectableResource<T extends ResourceSession>
  implements ManagedComponent {

  readonly id: string;
  private current?: T;

  constructor(
    options: ReconnectableResourceOptions,
    private readonly factory: ResourceFactory<T>,
  ) {
    this.id = options.id;
    this.onCleanupError = options.onCleanupError ?? (() => {});
  }

  private readonly onCleanupError: (error: unknown) => void;

  async start(context?: OperationContext): Promise<void> {
    await this.replaceSession(context);
  }

  async recover(context?: OperationContext): Promise<void> {
    await this.replaceSession(context);
  }

  async checkHealth(signal?: AbortSignal): Promise<HealthResult> {
    const session = this.current;
    let healthy = false;

    try {
      healthy = session !== undefined && await session.checkHealth(signal);
    } catch {
      healthy = false;
    }

    return {
      status: healthy ? 'HEALTHY' : 'UNHEALTHY',
      checkedAt: new Date().toISOString(),
      ...(!healthy ? { reason: 'Resource session is unavailable' } : {}),
    };
  }

  async stop(): Promise<void> {
    const previous = this.current;
    this.current = undefined;
    if (previous) await previous.close();
  }

  /** Read-only access for an application adapter; never mutate this session. */
  get session(): T | undefined {
    return this.current;
  }

  private async replaceSession(context?: OperationContext): Promise<void> {
    if (!context) {
      throw new Error('ARM OperationContext is required to replace a session');
    }

    let candidate: T | undefined;

    try {
      candidate = await this.factory.create(context.signal);

      // The factory must finish setup before yielding the candidate.
      context.assertCurrent();

      const healthy = await candidate.checkHealth(context.signal);
      context.assertCurrent();

      if (!healthy) {
        throw new Error('Replacement resource failed health verification');
      }

      const previous = this.current;
      this.current = candidate;
      candidate = undefined;

      // Cleanup is not part of the new session's health status.
      if (previous) {
        try {
          await previous.close();
        } catch (error) {
          this.onCleanupError(error);
        }
      }
    } finally {
      // A failed or timed-out candidate never becomes the active session.
      if (candidate) {
        try {
          await candidate.close();
        } catch (error) {
          this.onCleanupError(error);
        }
      }
    }
  }
}
