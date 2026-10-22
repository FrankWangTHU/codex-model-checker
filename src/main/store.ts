import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { assess } from '../core/assessment';
import { sanitizeObservation } from '../core/capture';
import type { Observation, RecordEntry, Settings } from '../core/types';
export class Store extends EventEmitter {
  records: RecordEntry[] = [];
  settings: Settings = { alwaysOnTop: true, login: true, collapsed: false, notifications: true };
  private timer?: NodeJS.Timeout;
  private notified=new Set<string>();
  constructor(readonly directory: string) {
    super(); mkdirSync(directory, { recursive: true });
    try {
      const data = JSON.parse(readFileSync(join(directory, 'records.json'), 'utf8'));
      this.records = (Array.isArray(data) ? data : []).map(v => sanitizeObservation(v, v.source === 'codex' ? 'codex' : 'chatgpt')).filter((v): v is Observation => Boolean(v)).map(assess);
    } catch {}
    try {
      const data = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
      for (const key of ['alwaysOnTop', 'login', 'collapsed', 'notifications'] as const) if (typeof data[key] === 'boolean') this.settings[key] = data[key];
      if (data.bounds && ['x','y','width','height'].every(k => Number.isFinite(data.bounds[k]))) this.settings.bounds = data.bounds;
    } catch {}
    this.prune();
    try{const ids=JSON.parse(readFileSync(join(directory,'alerts.json'),'utf8'));if(Array.isArray(ids))this.notified=new Set(ids.filter(v=>typeof v==='string'));}catch{}
  }
  private prune(): void { const cutoff = Date.now() - 30 * 86400000; this.records = this.records.filter(r => r.time >= cutoff).sort((a,b) => b.time-a.time).slice(0,10000); }
  upsert(observation: Observation): void {
    const entry = assess(observation);
    const index = this.records.findIndex(r => r.id === entry.id && r.source === entry.source && r.connection === entry.connection);
    const previous = index >= 0 ? this.records[index] : null;
    if (index >= 0) this.records[index] = entry; else this.records.unshift(entry);
    this.prune(); this.schedule(); this.emit('change');
    const alertKey=entry.source+':'+entry.connection+':'+entry.id;
    if (entry.astraAlert && !this.notified.has(alertKey)) {this.notified.add(alertKey);this.atomic('alerts.json',[...this.notified].slice(-10000));this.emit('alert', entry);}
  }
  clear(): void { this.records = []; this.notified.clear();this.atomic('alerts.json',[]);this.flush(); this.emit('change'); }
  saveSettings(): void { this.atomic('settings.json', this.settings); this.emit('change'); }
  private schedule(): void { if (!this.timer) this.timer = setTimeout(() => this.flush(), 500); }
  private atomic(name: string, value: unknown): void { const path = join(this.directory, name); writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path); }
  flush(): void { clearTimeout(this.timer); this.timer = undefined; this.prune(); this.atomic('records.json', this.records); }
}
