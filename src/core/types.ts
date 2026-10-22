export type Source = 'codex' | 'chatgpt';
export type Verdict = 'match' | 'mismatch' | 'unknown' | 'conflict' | 'auto';
export interface Candidate { field: string; model: string; kind: 'route' | 'label' }
export interface Observation {
  id: string;
  source: Source;
  connection: string;
  requestId: string;
  time: number;
  requested: string | null;
  requestEvidence: 'wire' | 'session' | 'missing';
  candidates: Candidate[];
  transport: 'fetch' | 'websocket' | 'history' | 'proxy' | 'log';
  state: 'pending' | 'complete' | 'error' | 'cancelled';
  special: boolean;
}
export interface RecordEntry extends Observation { verdict: Verdict; astraAlert: boolean }
export interface Settings { alwaysOnTop: boolean; login: boolean; collapsed: boolean; notifications: boolean; bounds?: { x: number; y: number; width: number; height: number } }
export interface Snapshot {
  records: RecordEntry[];
  status: { codex: string; chatgpt: string; proxy: string };
  settings: Settings;
  pairing: { code: string; expiresAt: number };
  proxyEnabled: boolean;
}
export const verdictText: Record<Verdict, string> = { match: '一致', mismatch: '不一致', unknown: '无法核验', conflict: '证据冲突', auto: '自动路由' };
