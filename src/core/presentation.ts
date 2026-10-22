import type { Observation } from './types';

// Exact known auxiliary models only; do not infer roles from similar names.
export function isAuxiliary(record: Pick<Observation, 'requested' | 'special'>): boolean {
  return record.special || record.requested?.trim().toLowerCase() === 'codex-auto-review';
}

export function latestPrimary<T extends Observation>(records: T[], source: Observation['source']): T | undefined {
  return records.find(record => record.source === source && record.transport !== 'probe' && !isAuxiliary(record));
}

export function fitBounds(bounds: {x:number;y:number}, area: {x:number;y:number;width:number;height:number}, width:number, height:number) {
  width=Math.min(width,area.width);height=Math.min(height,area.height);
  return {x:Math.max(area.x,Math.min(bounds.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(bounds.y,area.y+area.height-height)),width,height};
}
