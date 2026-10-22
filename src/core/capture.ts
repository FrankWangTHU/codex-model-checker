import type { Candidate, Observation } from './types';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const model = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160 && /^[\w .:/-]+$/.test(v);
export function requestModel(value: unknown): string | null {
  if (!object(value)) return null;
  if (model(value.model)) return value.model;
  return object(value.response) && model(value.response.model) ? value.response.model : null;
}
export function evidence(value: unknown): { candidates: Candidate[]; special: boolean; responseId?: string; done: boolean } {
  const candidates: Candidate[] = []; let special = false; let responseId: string | undefined; let done = false;
  const add = (field: string, v: unknown, kind: Candidate['kind']) => { if (model(v)) candidates.push({ field, model: v, kind }); };
  if (!object(value)) return { candidates, special, done };
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') done = true;
  if (object(value.response)) {
    responseId = typeof value.response.id === 'string' ? value.response.id : undefined;
    if (type.startsWith('response.')) add('response.model', value.response.model, 'route');
  }
  // JSON Responses / Chat Completions object, not arbitrary text or tool arguments.
  if (value.object === 'response' || value.object === 'chat.completion' || value.object === 'chat.completion.chunk') {
    add('model', value.model, 'route');
    if (typeof value.id === 'string') responseId = value.id;
  }
  const inspect = (v: unknown, depth: number) => {
    if (depth > 6 || !object(v)) return;
    if (v.type === 'server_ste_metadata' && object(v.metadata)) {
      add('server_ste_metadata.model_slug', v.metadata.model_slug, 'route');
      add('server_ste_metadata.resolved_model_slug', v.metadata.resolved_model_slug, 'route');
    }
    if (object(v.metadata)) {
      add('metadata.resolved_model_slug', v.metadata.resolved_model_slug, 'route');
      if (object(v.author) && v.author.role === 'assistant') add('assistant.metadata.model_slug', v.metadata.model_slug, 'label');
      if (['image_generation', 'deep_research'].includes(String(v.metadata.task_type))) special = true;
    }
    // Walk only known envelope containers. Never recurse through message content.
    for (const key of ['message', 'data', 'v']) if (object(v[key])) inspect(v[key], depth + 1);
    if (Array.isArray(v.v)) for (const patch of v.v.slice(0, 100)) inspect(patch, depth + 1);
    if (v.type === 'image_generation_call') special = true;
    // ChatGPT delta patches can carry server routing fields by exact path.
    if (typeof v.p === 'string') {
      if (/^\/?(?:message\/)?metadata\/resolved_model_slug$/.test(v.p)) add('metadata.resolved_model_slug', v.v, 'route');
      if (/^\/?(?:message\/)?metadata\/model_slug$/.test(v.p)) add('assistant.metadata.model_slug', v.v, 'label');
    }
  };
  inspect(value, 0);
  return { candidates, special, responseId, done };
}
export function mergeEvidence(entry: Observation, value: unknown): void {
  const next = evidence(value);
  for (const candidate of next.candidates) if (!entry.candidates.some(c => c.field === candidate.field && c.model === candidate.model && c.kind === candidate.kind)) entry.candidates.push(candidate);
  entry.special ||= next.special;
  if (next.done) entry.state = 'complete';
}
export class StreamObserver {
  private decoder = new TextDecoder();
  private buffer = '';
  private overflow = false;
  constructor(private receive: (value: unknown) => void, private mode: 'sse' | 'json' = 'sse', private limit = 1024 * 1024) {}
  push(chunk: Uint8Array | string): void {
    if (this.overflow) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.mode === 'json') { if (this.buffer.length > this.limit) { this.buffer = ''; this.overflow = true; } return; }
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, boundary.index); this.buffer = this.buffer.slice(boundary.index + boundary[0].length); this.block(block);
    }
    if (this.buffer.length > this.limit) { this.buffer = ''; this.overflow = true; }
  }
  private block(block: string): void {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    try { this.receive(JSON.parse(data)); } catch { /* Unknown events do not stop the stream. */ }
  }
  finish(): void {
    if (this.overflow) return;
    this.buffer += this.decoder.decode();
    if (this.mode === 'json') { try { this.receive(JSON.parse(this.buffer)); } catch {} }
    else if (this.buffer) this.block(this.buffer);
    this.buffer = '';
  }
}

// Strict whitelist at the trust boundary: discard every other property, including text.
export function sanitizeObservation(value: unknown, source: Observation['source']): Observation | null {
  if (!object(value)) return null;
  const safeId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(v);
  if (!safeId(value.id) || !safeId(value.connection) || !safeId(value.requestId) || !Array.isArray(value.candidates)) return null;
  const candidates: Candidate[] = [];
  const allowedFields = ['response.model', 'model', 'diagnostic.server_model', 'model_reroute.to_model', 'metadata.resolved_model_slug', 'server_ste_metadata.model_slug', 'server_ste_metadata.resolved_model_slug', 'assistant.metadata.model_slug'];
  for (const item of value.candidates.slice(0, 24)) {
    if (!object(item) || !allowedFields.includes(String(item.field)) || !model(item.model)) continue;
    candidates.push({ field: String(item.field), model: item.model, kind: item.field === 'assistant.metadata.model_slug' ? 'label' : 'route' });
  }
  return {
    id: String(value.id), source, connection: String(value.connection), requestId: String(value.requestId),
    time: typeof value.time === 'number' && Number.isFinite(value.time) && value.time >= 0 && value.time <= Date.now() + 60000 ? value.time : Date.now(),
    requested: model(value.requested) ? value.requested : null,
    requestEvidence: (source==='codex'?['wire','session','diagnostic','probe']:['wire','session']).includes(String(value.requestEvidence)) ? value.requestEvidence as Observation['requestEvidence'] : 'missing',
    candidates, transport: (source==='codex'?['fetch','websocket','history','proxy','log','diagnostic','probe']:['fetch','websocket','history']).includes(String(value.transport)) ? value.transport as Observation['transport'] : 'fetch',
    state: ['pending', 'complete', 'error', 'cancelled'].includes(String(value.state)) ? value.state as Observation['state'] : 'error', special: value.special === true
  };
}
