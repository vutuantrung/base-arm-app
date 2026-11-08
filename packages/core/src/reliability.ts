import {EventEmitter} from 'node:events';
import type {MetricsRegistry} from './metrics.js';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
export type LifecycleStatus = 'CREATED' | 'STARTING' | 'RUNNING' | 'RECOVERING' | 'STOPPING' | 'STOPPED' | 'FAILED';
export interface HealthResult { status: HealthStatus; reason?: string; checkedAt: string; }
export interface ManagedComponent {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  checkHealth(): Promise<HealthResult>;
  recover?(): Promise<void>;
}
export interface RecoveryPolicy { enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; timeoutMs: number; }
export interface ComponentRegistration { component: ManagedComponent; critical: boolean; recovery: RecoveryPolicy; }
export interface ComponentStatus { id: string; critical: boolean; lifecycle: LifecycleStatus; health: HealthResult; recoveryAttempts: number; lastRecoveryAt?: string; }
export interface ReliabilityEvent { sequence: number; timestamp: string; componentId: string; type: 'lifecycle' | 'health' | 'recovery.started' | 'recovery.succeeded' | 'recovery.failed'; detail?: string; }
const validId = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const values: Record<HealthStatus, number> = {UNKNOWN: -1, UNHEALTHY: 0, DEGRADED: 1, HEALTHY: 2};
const healthStatuses = new Set(Object.keys(values));

async function within<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('Operation timed out')), ms);})]);
  } finally {if (timer) clearTimeout(timer);}
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A process-local coordinator. Does not provide cross-process orchestration or cancellation of stuck operations. */
export class ReliabilityManager extends EventEmitter {
  private readonly registrations = new Map<string, ComponentRegistration>();
  private readonly states = new Map<string, ComponentStatus>();
  private readonly recoveryInFlight = new Map<string, Promise<void>>();
  private readonly checkingInFlight = new Set<string>();
  private readonly events: ReliabilityEvent[] = [];
  private sequence = 0;
  private monitoring?: NodeJS.Timeout;
  private active = false;
  private stopping = false;
  constructor(private readonly metrics: MetricsRegistry, private readonly options: {checkIntervalMs?: number; healthTimeoutMs?: number; eventHistoryLimit?: number} = {}) {
    super();
    if ((options.checkIntervalMs ?? 5000) < 100) throw new Error('checkIntervalMs must be >= 100');
    if ((options.healthTimeoutMs ?? 2000) < 1) throw new Error('healthTimeoutMs must be positive');
    if ((options.eventHistoryLimit ?? 200) < 1) throw new Error('eventHistoryLimit must be positive');
  }
  register(r: ComponentRegistration) {
    if (this.active || this.stopping) throw new Error('Cannot register after start');
    if (!validId.test(r.component.id) || this.registrations.has(r.component.id)) throw new Error('Invalid or duplicate component id');
    const p = r.recovery;
    if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 0 || ![p.baseDelayMs,p.maxDelayMs,p.timeoutMs].every(Number.isFinite) || p.baseDelayMs < 0 || p.maxDelayMs < p.baseDelayMs || p.timeoutMs < 1) throw new Error('Invalid recovery policy');
    this.registrations.set(r.component.id, r);
    this.states.set(r.component.id, {id:r.component.id, critical:r.critical, lifecycle:'CREATED', health:{status:'UNKNOWN',checkedAt:new Date().toISOString()}, recoveryAttempts:0});
    this.publishMetrics(r.component.id);
  }
  private emitEvent(componentId: string, type: ReliabilityEvent['type'], detail?: string) {
    const event: ReliabilityEvent = {sequence:++this.sequence,timestamp:new Date().toISOString(),componentId,type,...(detail?{detail}:{})};
    this.events.push(event);
    if (this.events.length > (this.options.eventHistoryLimit ?? 200)) this.events.shift();
    this.emit('event', event);
  }
  private publishMetrics(id: string) {
    const state = this.states.get(id)!;
    this.metrics.gauge(`arm.component.${id}.health`, values[state.health.status], 'state');
    this.metrics.gauge(`arm.component.${id}.recovery_attempts`, state.recoveryAttempts, 'count');
    this.metrics.gauge(`arm.component.${id}.running`, state.lifecycle === 'RUNNING' ? 1 : 0, 'boolean');
    this.metrics.gauge('arm.components.total', this.states.size, 'count');
    this.metrics.gauge('arm.components.healthy', [...this.states.values()].filter(x=>x.health.status==='HEALTHY').length, 'count');
    this.metrics.gauge('arm.components.unhealthy', [...this.states.values()].filter(x=>x.health.status==='UNHEALTHY').length, 'count');
  }
  private lifecycle(id: string, next: LifecycleStatus) {this.states.get(id)!.lifecycle=next;this.publishMetrics(id);this.emitEvent(id,'lifecycle',next);}
  private updateHealth(id: string, health: HealthResult) {
    const state=this.states.get(id)!;
    const previous=state.health.status;
    state.health={...health};
    this.publishMetrics(id);
    if(previous!==health.status) this.emitEvent(id,'health',`${previous} -> ${health.status}${health.reason?`: ${health.reason}`:''}`);
  }
  private async healthCheck(id: string) {
    const component=this.registrations.get(id)!.component;
    let result: HealthResult;
    try {
      result=await within(()=>component.checkHealth(),this.options.healthTimeoutMs??2000);
      if (!result || !healthStatuses.has(result.status)) throw new Error('Invalid health result');
      result={status:result.status,reason:result.reason,checkedAt:new Date().toISOString()};
    } catch(e) {result={status:'UNHEALTHY',reason:e instanceof Error?e.message:String(e),checkedAt:new Date().toISOString()};}
    if (!this.stopping) this.updateHealth(id,result);
    return result;
  }
  private async checkOne(id: string) {
    if(this.stopping || this.checkingInFlight.has(id) || this.recoveryInFlight.has(id)) return;
    this.checkingInFlight.add(id);
    try {
      if(this.states.get(id)!.lifecycle!=='RUNNING') return;
      const result=await this.healthCheck(id);
      if(result.status==='UNHEALTHY' && !this.stopping) void this.recover(id).catch(()=>{});
    } finally {this.checkingInFlight.delete(id);}
  }
  async checkAll() {await Promise.all([...this.registrations.keys()].map(id=>this.checkOne(id)));}
  async start() {
    if(this.active || this.stopping) throw new Error('Manager already started or stopping');
    this.active=true;
    for(const [id,r] of this.registrations) {
      this.lifecycle(id,'STARTING');
      try {await within(()=>r.component.start(),r.recovery.timeoutMs);this.lifecycle(id,'RUNNING');await this.healthCheck(id);}
      catch(e){this.lifecycle(id,'FAILED');this.updateHealth(id,{status:'UNHEALTHY',reason:String(e),checkedAt:new Date().toISOString()});}
    }
    this.monitoring=setInterval(()=>{void this.checkAll().catch(()=>{});},this.options.checkIntervalMs??5000);
    this.monitoring.unref();
  }
  recover(id: string): Promise<void> {
    const existing=this.recoveryInFlight.get(id);
    if(existing) return existing;
    const r=this.registrations.get(id);
    if(!r) return Promise.reject(new Error('Unknown component'));
    if(this.stopping || !this.active || !r.recovery.enabled || !r.component.recover || !['RUNNING','FAILED'].includes(this.states.get(id)!.lifecycle)) return Promise.resolve();
    const task=Promise.resolve().then(async()=>{
      this.lifecycle(id,'RECOVERING');
      const p=r.recovery;
      for(let attempt=1;attempt<=p.maxAttempts && !this.stopping;attempt++) {
        if(attempt>1) await sleep(Math.min(p.maxDelayMs,p.baseDelayMs*2**Math.min(attempt-2,20)));
        if(this.stopping) break;
        const state=this.states.get(id)!;
        state.recoveryAttempts++;
        state.lastRecoveryAt=new Date().toISOString();
        this.publishMetrics(id);
        this.emitEvent(id,'recovery.started',`attempt ${attempt}`);
        const start=performance.now();
        try {
          await within(()=>r.component.recover!(),p.timeoutMs);
          const result=await this.healthCheck(id);
          if(result.status==='UNHEALTHY' || result.status==='UNKNOWN') throw new Error(`Recovery verification: ${result.status}`);
          this.metrics.gauge(`arm.component.${id}.last_recovery_duration_ms`,performance.now()-start,'milliseconds');
          this.metrics.increment('arm.recovery.success_total');
          this.emitEvent(id,'recovery.succeeded',`attempt ${attempt}`);
          this.lifecycle(id,'RUNNING');
          return;
        } catch(e) {
          this.metrics.increment('arm.recovery.failure_total');
          this.emitEvent(id,'recovery.failed',e instanceof Error?e.message:String(e));
        }
      }
      if(!this.stopping) this.lifecycle(id,'FAILED');
    }).finally(()=>this.recoveryInFlight.delete(id));
    this.recoveryInFlight.set(id,task);
    return task;
  }
  statuses(): ComponentStatus[] {return [...this.states.values()].map(x=>({...x,health:{...x.health}}));}
  recentEvents(since=0): ReliabilityEvent[] {return this.events.filter(x=>x.sequence>since).map(x=>({...x}));}
  readiness() {
    const critical=this.statuses().filter(x=>x.critical);
    const ready=this.active && !this.stopping && critical.every(x=>x.lifecycle==='RUNNING' && x.health.status==='HEALTHY');
    return {ready,components:critical.map(x=>({id:x.id,lifecycle:x.lifecycle,health:x.health.status}))};
  }
  async stop() {
    if(this.stopping) return;
    this.stopping=true;
    if(this.monitoring) clearInterval(this.monitoring);
    this.monitoring=undefined;
    // Bounded shutdown; in-flight operations are not forcibly cancelled.
    for(const [id,r] of [...this.registrations].reverse()) {
      this.lifecycle(id,'STOPPING');
      try {await within(()=>r.component.stop(),r.recovery.timeoutMs);} catch(e){this.emitEvent(id,'recovery.failed',`stop: ${String(e)}`);}
      this.lifecycle(id,'STOPPED');
    }
    this.active=false;
  }
}
