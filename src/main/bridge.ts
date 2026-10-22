import http from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeObservation } from '../core/capture';
import type { Observation } from '../core/types';
export const BRIDGE_PORT = 43821;
export class Bridge {
  server: http.Server;
  pairing = { code: '', expiresAt: 0 };
  private clients = new Map<string, string>();
  private attempts = new Map<string, { count: number; until: number }>();
  private status = new Map<string, number>();
  constructor(private directory: string, private receive: (o: Observation) => void, private activity: () => void, private changed: () => void) {
    try { for (const [origin, token] of Object.entries(JSON.parse(readFileSync(join(directory, 'clients.json'), 'utf8')))) if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && typeof token === 'string') this.clients.set(origin, token); } catch {}
    this.server = http.createServer((req,res) => { this.handle(req,res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
  }
  renew(): void { this.pairing = { code: String(randomInt(10000000, 100000000)), expiresAt: Date.now() + 300000 }; this.changed(); }
  connected(): boolean { return [...this.status.values()].some(t => Date.now()-t < 35000); }
  private equal(a: string, b: string): boolean { const x=Buffer.from(a), y=Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin ?? '';
    if (req.headers.host !== `127.0.0.1:${BRIDGE_PORT}` || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin'); res.setHeader('Cache-Control','no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }).end(); return; }
    if (req.method !== 'POST' || !['/pair','/events','/presence'].includes(req.url ?? '')) { res.writeHead(404).end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    if (req.url !== '/pair') {
      const token = this.clients.get(origin);
      if (!token || !this.equal(req.headers.authorization ?? '', `Bearer ${token}`)) { res.writeHead(401).end(); return; }
    }
    let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw)>65536) { res.writeHead(413).end(); req.destroy(); return; } }
    let data: Record<string, unknown>; try { data=JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (req.url === '/pair') {
      const attempt = this.attempts.get(origin) ?? { count: 0, until: Date.now()+60000 };
      if (attempt.until < Date.now()) { attempt.count=0; attempt.until=Date.now()+60000; }
      attempt.count++; this.attempts.set(origin, attempt);
      if (attempt.count>5) { res.writeHead(429).end(); return; }
      if (this.pairing.expiresAt < Date.now() || !this.equal(String(data.code ?? ''),this.pairing.code)) { res.writeHead(403).end(); return; }
      const token=randomBytes(32).toString('hex'); this.clients.set(origin,token);
      writeFileSync(join(this.directory,'clients.json'),JSON.stringify(Object.fromEntries(this.clients)),{mode:0o600});
      this.pairing={code:'',expiresAt:0}; this.changed(); res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({token})); return;
    }
    if (req.url === '/presence') {
      if (data.open === true) { const was = this.connected(); this.status.set(origin,Date.now()); if (!was || data.opened === true) this.activity(); }
      else this.status.delete(origin);
      this.changed(); res.writeHead(204).end(); return;
    }
    const observation=sanitizeObservation(data,'chatgpt');
    if (!observation) { res.writeHead(400).end(); return; }
    observation.connection = `${origin.slice(-32)}:${observation.connection}`;
    this.receive(observation); res.writeHead(204).end();
  }
  async start(port=BRIDGE_PORT): Promise<void> { await new Promise<void>((resolve,reject) => { this.server.once('error',reject); this.server.listen(port,'127.0.0.1',resolve); }); }
  async stop(): Promise<void> { await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
