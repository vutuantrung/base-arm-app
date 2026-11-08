/**
 * Cooperative cancellation and per-component operation isolation.
 *
 * A timeout does not kill JavaScript promises or undo external side effects.
 * Timed-out operations remain registered until their underlying task settles.
 */
export class OperationTimeoutError extends Error {
  constructor(public readonly operation: string) {
    super(`Operation timed out: ${operation}`);
    this.name = 'OperationTimeoutError';
  }
}

export class OperationAbortedError extends Error {
  constructor(public readonly operation: string) {
    super(`Operation aborted: ${operation}`);
    this.name = 'OperationAbortedError';
  }
}

export interface OperationContext {
  readonly signal: AbortSignal;
  readonly generation: number;
  /** Check immediately before committing state or external side effects. */
  isCurrent(): boolean;
  assertCurrent(): void;
}

type ActiveOperation = {
  controller: AbortController;
  finished: Promise<void>;
};

export class OperationManager {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, ActiveOperation>();

  /** Returns true if the component has an active operation. */
  /**
   * @param id The ID of the component.
   * @returns True if the component has an active operation, false otherwise.
   */
  hasActive(id: string): boolean {
    return this.active.has(id);
  }

  /** Invalidate the current operation for the specified component. */
  /**
   * @param id The ID of the component.
   */
  invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.active.get(id)?.controller.abort();
  }

  /** Abort all active operations for all components. */
  /**
   * This will trigger the abort signal for all active operations.
   */
  abortAll(): void {
    for (const id of this.active.keys()) this.invalidate(id);
  }

  /** Execute an operation with cooperative cancellation and timeout. */
  /**
   * @param id The ID of the component.
   * @param operation The name of the operation.
   * @param timeoutMs The timeout in milliseconds.
   * @param action The async action to execute.
   * @returns The result of the action.
   */
  async execute<T>(
    id: string,
    operation: string,
    timeoutMs: number,
    action: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(id)) {
      throw new Error(`Component ${id} already has a pending operation`);
    }

    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const controller = new AbortController();

    const context: OperationContext = {
      signal: controller.signal,
      generation,
      isCurrent: () => !controller.signal.aborted && this.generations.get(id) === generation,
      assertCurrent() {
        if (!this.isCurrent()) throw new OperationAbortedError(operation);
      },
    };

    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    const entry: ActiveOperation = { controller, finished };
    this.active.set(id, entry);

    // Keep tracking the underlying action even if timeout wins the race.
    const work = Promise.resolve()
      .then(() => action(context))
      .finally(() => {
        if (this.active.get(id) === entry) this.active.delete(id);
        done();
      });

    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let timedOut = false;

    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new OperationAbortedError(operation));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new OperationTimeoutError(operation));
        controller.abort();
      }, timeoutMs);
    });

    try {
      // The rejection of a losing Promise is observed by Promise.race.
      return await Promise.race([work, aborted, timeout]);
    } catch (error) {
      if (timedOut) throw new OperationTimeoutError(operation);
      if (controller.signal.aborted && !(error instanceof OperationTimeoutError)) {
        throw new OperationAbortedError(operation);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * Returns false if uncooperative operations remain active after the deadline.
   * @param timeoutMs The maximum time to wait for all operations to become idle.
   * @returns True if all operations became idle within the timeout, false otherwise.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const pending = [...this.active.values()].map(entry => entry.finished);
    if (pending.length === 0) return true;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
