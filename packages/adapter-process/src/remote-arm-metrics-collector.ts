import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Metric, MetricsSnapshot } from '../../core/src/metrics.js';
import type { ProcessSpec } from './process-manager.js';

export interface RemoteMetricsState {
  id: string;
  connected: boolean;
  lastSnapshotAt?: string;
  lastEventAt?: string;
  metrics: Metric[];
  lastError?: string;
}

/**
 * Connects to the existing ARM MetricsServer WebSocket in each app.
 * No Node.js process metrics are inferred from the supervisor's process.
 */
export class RemoteArmMetricsCollector extends EventEmitter {
  private readonly connections = new Map<string, WebSocket>();
  private readonly states = new Map<string, RemoteMetricsState>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly generations = new Map<string, number>();
  private running = false;

  constructor(
    private readonly specs: ProcessSpec[],
    private readonly reconnectDelayMs = 2000,
    private readonly maxAgeMs = 15000,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const spec of this.specs) this.connect(spec);
  }

  stop(): void {
    this.running = false;
    for (const [id, timer] of this.reconnectTimers) {
      clearTimeout(timer);
      this.reconnectTimers.delete(id);
    }
    for (const [id, ws] of this.connections) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      ws.terminate();
    }
    this.connections.clear();
    for (const state of this.states.values()) state.connected = false;
  }

  get(id: string): RemoteMetricsState | undefined {
    const state = this.states.get(id);
    return state ? { ...state, metrics: state.metrics.map(m => ({ ...m })) } : undefined;
  }

  list(): RemoteMetricsState[] {
    return [...this.states.keys()].map(id => this.get(id)!);
  }

  isFresh(id: string): boolean {
    const state = this.states.get(id);
    return !!state?.connected && !!state.lastSnapshotAt &&
      Date.now() - new Date(state.lastSnapshotAt).getTime() <= this.maxAgeMs;
  }

  private connect(spec: ProcessSpec): void {
    if (!this.running) return;
    const old = this.connections.get(spec.id);
    if (old && old.readyState !== WebSocket.CLOSED) return;

    const generation = (this.generations.get(spec.id) ?? 0) + 1;
    this.generations.set(spec.id, generation);

    const state = this.states.get(spec.id) ?? {
      id: spec.id,
      connected: false,
      metrics: [],
    };
    this.states.set(spec.id, state);

    const headers = spec.metricsToken
      ? { authorization: `Bearer ${spec.metricsToken}` }
      : undefined;

    const ws = new WebSocket(spec.metricsUrl, {
      headers,
      handshakeTimeout: 5000,
      maxPayload: 1024 * 1024,
    });
    this.connections.set(spec.id, ws);

    const isCurrent = () => this.running && this.generations.get(spec.id) === generation;

    ws.on('open', () => {
      if (!isCurrent()) return;
      state.connected = true;
      state.lastError = undefined;
      ws.send(JSON.stringify({ action: 'subscribe' }));
      ws.send(JSON.stringify({ action: 'subscribe_events' }));
      this.emit('connected', { id: spec.id });
    });

    ws.on('message', raw => {
      if (!isCurrent()) return;
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object') return;
        const data = message as Record<string, unknown>;
        if ((data.type === 'snapshot' || data.type === 'metrics') && data.data) {
          const snapshot = data.data as MetricsSnapshot;
          if (!snapshot || !Array.isArray(snapshot.metrics) || typeof snapshot.timestamp !== 'string') return;
          state.metrics = snapshot.metrics.filter(m =>
            typeof m.name === 'string' && typeof m.value === 'number' &&
            Number.isFinite(m.value) && (m.type === 'counter' || m.type === 'gauge')
          ).map(m => ({ ...m }));
          state.lastSnapshotAt = new Date().toISOString();
          this.emit('metrics', { id: spec.id, snapshot: this.get(spec.id) });
        } else if (data.type === 'reliability_event') {
          state.lastEventAt = new Date().toISOString();
          this.emit('reliability_event', { id: spec.id, event: data.data });
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        this.emit('error_message', { id: spec.id, error: state.lastError });
      }
    });

    ws.on('error', error => {
      if (!isCurrent()) return;
      state.lastError = error.message;
      this.emit('connection_error', { id: spec.id, error: error.message });
    });

    ws.on('close', () => {
      if (!isCurrent()) return;
      state.connected = false;
      if (this.connections.get(spec.id) === ws) this.connections.delete(spec.id);
      this.emit('disconnected', { id: spec.id });
      this.scheduleReconnect(spec, generation);
    });
  }

  private scheduleReconnect(spec: ProcessSpec, generation: number): void {
    if (!this.running || this.generations.get(spec.id) !== generation) return;
    const existing = this.reconnectTimers.get(spec.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(spec.id);
      this.connect(spec);
    }, this.reconnectDelayMs);
    timer.unref();
    this.reconnectTimers.set(spec.id, timer);
  }
}
