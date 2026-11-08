import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { MetricsRegistry } from '../../core/src/metrics.js';
import type { ReliabilityManager, ReliabilityEvent } from '../../core/src/reliability.js';
import { VALID_NAME_PATTERN } from '../../shared/constants.js';

interface Subscription {
  names: Set<string> | null;
  timer?: NodeJS.Timeout;
  events: boolean;
}

export interface MetricsServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  broadcastIntervalMs?: number;
  maxSubscriptions?: number;
}

/** REST snapshots + filtered WS subscriptions; external access requires token configuration. */
export class MetricsServer {
  readonly http: Server;
  readonly ws: WebSocketServer;
  private readonly clients = new Map<WebSocket, Subscription>();
  private readonly options: Required<Omit<MetricsServerOptions, 'authToken'>> & Pick<MetricsServerOptions, 'authToken'>;

  constructor(
    private readonly registry: MetricsRegistry,
    options: MetricsServerOptions = {},
    private readonly reliability?: ReliabilityManager
  ) {
    this.options = {
      host: options.host ?? '127.0.0.1', port: options.port ?? 3100,
      authToken: options.authToken, broadcastIntervalMs: options.broadcastIntervalMs ?? 5000,
      maxSubscriptions: options.maxSubscriptions ?? 100
    };

    if (this.options.broadcastIntervalMs < 1000) {
      throw new Error('Broadcast interval must be >= 1000ms');
    }

    this.reliability?.on('event', this.forwardEvent);

    this.http = createServer((req, res) => this.handleHttp(req, res));

    this.ws = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/metrics/ws' || !this.authorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.ws.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
  }

  private authorized(req: IncomingMessage) {
    if (!this.options.authToken) return true;
    return req.headers.authorization === `Bearer ${this.options.authToken}`;
  }

  private send(res: ServerResponse, code: number, data: unknown) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!this.authorized(req)) {
      return this.send(res, 401, { error: 'unauthorized' });
    }
    if (req.method !== 'GET') {
      return this.send(res, 405, { error: 'method_not_allowed' });
    }
    if (url.pathname === '/reliability/components' && this.reliability) {
      return this.send(res, 200, this.reliability.statuses());
    }
    if (url.pathname === '/reliability/ready' && this.reliability) {
      return this.send(res, this.reliability.readiness().ready ? 200 : 503, this.reliability.readiness());
    }
    if (url.pathname === '/reliability/events' && this.reliability) {
      const since = Number(url.searchParams.get('since') ?? '0');
      if (!Number.isSafeInteger(since) || since < 0) {
        return this.send(res, 400, { error: 'invalid_since' });
      }
      return this.send(res, 200, { events: this.reliability.recentEvents(since) });
    }
    if (url.pathname === '/metrics')
      return this.send(res, 200, this.registry.snapshot());
    if (url.pathname.startsWith('/metrics/')) {
      let name: string;
      try { name = decodeURIComponent(url.pathname.slice('/metrics/'.length)); }
      catch { return this.send(res, 400, { error: 'invalid_metric_name' }); }
      const metric = this.registry.get(name);
      return metric ? this.send(res, 200, metric) : this.send(res, 404, { error: 'not_found' });
    }
    return this.send(res, 404, { error: 'not_found' });
  }

  private accept(ws: WebSocket) {
    if (this.clients.size >= this.options.maxSubscriptions) {
      ws.close(1013, 'Too many clients');
      return;
    }

    this.clients.set(ws, { names: null, events: false });
    this.deliver(ws, { type: 'connected', protocol: 'arm.metrics.v1' });
    ws.on('message', raw => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object') {
          throw Error('Invalid message');
        }
        const m = message as Record<string, unknown>;

        if (m.action === 'subscribe_events') {
          this.clients.get(ws)!.events = true;
          this.deliver(ws, { type: 'events', data: { events: this.reliability?.recentEvents() ?? [] } });
          return;
        }
        if (m.action === 'unsubscribe_events') {
          this.clients.get(ws)!.events = false;
          this.deliver(ws, { type: 'events_unsubscribed' });
          return;
        }
        if (m.action === 'unsubscribe') {
          this.clearSubscription(ws);
          this.deliver(ws, { type: 'unsubscribed' });
          return;
        }
        if (m.action !== 'subscribe' && m.action !== 'snapshot') {
          throw Error('Unknown action');
        }

        if (m.names !== undefined
          && (!Array.isArray(m.names)
            || m.names.length > 100
            || !m.names.every(n => typeof n === 'string' && VALID_NAME_PATTERN.test(n)))) {
          throw Error('Invalid metric names');
        }
        const names = m.names as string[] | undefined;

        if (m.action === 'subscribe') {
          this.updateSubscription(ws, names);
        }
        this.deliver(ws, { type: 'snapshot', data: this.registry.snapshot(names) });
      } catch (error) {
        this.deliver(ws, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Invalid message'
        });
      }
    });
    ws.on('close', () => this.cleanup(ws));
    ws.on('error', () => this.cleanup(ws));
  }

  private readonly forwardEvent = (event: ReliabilityEvent) => {
    for (const [ws, sub] of this.clients)
      if (sub.events) {
        this.deliver(ws, { type: 'reliability_event', data: event });
      }
  };

  private deliver(ws: WebSocket, data: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      ws.close(1013, 'Slow consumer');
      return;
    }
    ws.send(JSON.stringify(data));
  }

  private updateSubscription(ws: WebSocket, names?: string[]) {
    const old = this.clients.get(ws);
    if (!old) return;
    if (old.timer) clearInterval(old.timer);
    old.timer = undefined;
    old.names = names ? new Set(names) : null;
    old.timer = setInterval(() => {
      this.deliver(ws,
        {
          type: 'metrics',
          data: this.registry.snapshot(old.names ? [...old.names] : undefined)
        });
    }, this.options.broadcastIntervalMs);
    old.timer.unref();
  }

  private clearSubscription(ws: WebSocket) {
    const item = this.clients.get(ws);
    if (item?.timer) clearInterval(item.timer);
    if (item) item.timer = undefined;
  }

  private cleanup(ws: WebSocket) {
    this.clearSubscription(ws);
    this.clients.delete(ws);
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(
        this.options.port,
        this.options.host,
        () => { this.http.off('error', reject); resolve(); });
    });
  }

  async stop() {
    this.reliability?.off('event', this.forwardEvent);
    for (const ws of this.clients.keys()) { this.cleanup(ws); ws.terminate(); }
    await new Promise<void>(resolve => this.ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close(err => err ? reject(err) : resolve()));
  }
}
