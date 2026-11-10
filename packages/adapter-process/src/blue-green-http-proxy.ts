import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface ProxyTarget {
  slot: 'blue' | 'green';
  port: number;
}

/**
 * Stable public HTTP entrypoint. Route selection occurs once for each incoming
 * request; in-flight requests retain their original upstream after a switch.
 */
export class BlueGreenHttpProxy {
  readonly server: Server;
  private active?: ProxyTarget;
  private readonly inFlight = new Map<string, number>();
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(
    private readonly listenPort: number,
    private readonly host = '127.0.0.1',
  ) {
    if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      throw new Error('Invalid public proxy port');
    }
    if (host !== '127.0.0.1') throw new Error('Proxy currently supports loopback only');
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.listenPort, this.host);
    });
  }

  switchTo(target: ProxyTarget): void {
    if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new Error('Invalid target port');
    }
    this.active = { ...target };
  }

  current(): ProxyTarget | undefined {
    return this.active && { ...this.active };
  }

  requestsInFlight(slot: string): number {
    return this.inFlight.get(slot) ?? 0;
  }

  async drain(slot: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.requestsInFlight(slot) > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    return true;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
    });
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const target = this.active;
    if (!target) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_active_release' }));
      return;
    }

    const hopHeaders = new Set([
      'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
      'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
    ]);
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hopHeaders.has(key.toLowerCase())) headers[key] = value;
    }
    headers.host = `127.0.0.1:${target.port}`;
    headers['x-forwarded-proto'] = 'http';
    const slot = target.slot;
    this.inFlight.set(slot, this.requestsInFlight(slot) + 1);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.inFlight.set(slot, Math.max(0, this.requestsInFlight(slot) - 1));
    };
    res.once('finish', finish);
    res.once('close', finish);
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
      agent: false,
    }, response => {
      const responseHeaders = { ...response.headers };
      for (const key of hopHeaders) delete responseHeaders[key];
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(res);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Upstream timed out')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
}
