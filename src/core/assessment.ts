import type { Observation, RecordEntry } from './types';

// Explicit aliases only. Never strip arbitrary suffixes or infer a model family.
const aliases: Record<string, string> = { 'gpt-6 astra': 'gpt-6-astra', 'gpt6-astra': 'gpt-6-astra' };
export function normalize(model: string): string { const key = model.trim().toLowerCase(); return aliases[key] ?? key; }
export function assess(observation: Observation): RecordEntry {
  const requested = observation.requested ? normalize(observation.requested) : null;
  const routes = [...new Set(observation.candidates.filter(c => c.kind === 'route').map(c => normalize(c.model)))];
  const labels = [...new Set(observation.candidates.filter(c => c.kind === 'label').map(c => normalize(c.model)))];
  let verdict: RecordEntry['verdict'] = 'unknown';
  if (routes.length > 1 || labels.length > 1 || (routes.length === 1 && labels.some(m => m !== routes[0]))) verdict = 'conflict';
  else if (!observation.special && observation.state !== 'error' && observation.state !== 'cancelled' && routes.length === 1 && requested && ['wire','diagnostic','probe'].includes(observation.requestEvidence)) {
    verdict = requested === 'auto' ? 'auto' : requested === routes[0] ? 'match' : 'mismatch';
  }
  return { ...observation, verdict, astraAlert: requested === 'gpt-6-astra' && verdict === 'mismatch' };
}
