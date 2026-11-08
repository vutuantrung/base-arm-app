import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { cpus, totalmem, freemem } from 'node:os';

export type MetricType = 'gauge' | 'counter';
export interface Metric { name: string; type: MetricType; value: number; unit?: string; timestamp: string; }
export interface MetricsSnapshot { timestamp: string; metrics: Metric[]; }
const validName = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

/** Process-local, bounded current-value registry; not a time-series database. */
export class MetricsRegistry extends EventEmitter {
  private readonly metrics = new Map<string, Metric>();
  constructor(private readonly maxMetrics = 1000) { super(); }
  record(name: string, type: MetricType, value: number, unit?: string): Metric {
    if (!validName.test(name)) throw new Error('Invalid metric name');
    if (!Number.isFinite(value)) throw new Error('Metric value must be finite');
    if (unit !== undefined && unit.length > 32) throw new Error('Metric unit too long');
    const prev = this.metrics.get(name);
    if (prev && prev.type !== type) throw new Error(`Metric type mismatch: ${name}`);
    if (!prev && this.metrics.size >= this.maxMetrics) throw new Error('Metric cardinality limit exceeded');
    const metric: Metric = {name, type, value, ...(unit ? { unit } : {}), timestamp: new Date().toISOString()};
    this.metrics.set(name, metric);
    this.emit('update', metric);
    return metric;
  }
  gauge(name: string, value: number, unit?: string) { return this.record(name, 'gauge', value, unit); }
  increment(name: string, amount = 1, unit?: string) {
    if (amount < 0 || !Number.isFinite(amount)) throw new Error('Counter increment must be non-negative');
    const prev = this.metrics.get(name);
    return this.record(name, 'counter', (prev?.value ?? 0) + amount, unit ?? prev?.unit);
  }
  get(name: string): Metric | undefined { const m = this.metrics.get(name); return m && { ...m }; }
  snapshot(names?: readonly string[]): MetricsSnapshot {
    const requested = names ? new Set(names) : null;
    return {timestamp: new Date().toISOString(), metrics: [...this.metrics.values()].filter(m => !requested || requested.has(m.name)).map(m => ({...m}))};
  }
}

/** Collection does not start until start() is called. */
export class NodeMetricsCollector {
  private timer?: NodeJS.Timeout;
  private readonly histogram = monitorEventLoopDelay({resolution: 20});
  private lastCpu = process.cpuUsage();
  private lastTime = process.hrtime.bigint();
  constructor(private readonly registry: MetricsRegistry, private readonly intervalMs = 5000) {
    if (intervalMs < 1000) throw new Error('Collector interval must be >= 1000ms');
  }
  start() {
    if (this.timer) return;
    this.lastCpu = process.cpuUsage();
    this.lastTime = process.hrtime.bigint();
    this.histogram.enable();
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.histogram.disable(); }
  sample() {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.lastTime) / 1000;
    const delta = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage(); this.lastTime = now;
    const mem = process.memoryUsage();
    this.registry.gauge('process.uptime_seconds', process.uptime(), 'seconds');
    this.registry.gauge('process.memory.rss_bytes', mem.rss, 'bytes');
    this.registry.gauge('process.memory.heap_used_bytes', mem.heapUsed, 'bytes');
    this.registry.gauge('process.memory.heap_total_bytes', mem.heapTotal, 'bytes');
    this.registry.gauge('process.cpu.percent_of_one_core', elapsedUs > 0 ? (delta.user + delta.system) / elapsedUs * 100 : 0, 'percent');
    this.registry.gauge('runtime.event_loop.mean_delay_ms', Number.isFinite(this.histogram.mean) ? this.histogram.mean / 1e6 : 0, 'milliseconds');
    this.histogram.reset();
    this.registry.gauge('host.memory.total_bytes', totalmem(), 'bytes');
    this.registry.gauge('host.memory.free_bytes', freemem(), 'bytes');
    this.registry.gauge('host.cpu.logical_cores', cpus().length, 'count');
  }
}
