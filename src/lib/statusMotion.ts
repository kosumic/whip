export type StatusMotionKind = 'spin' | 'pulse' | 'static';
export type StatusTone = 'success' | 'destructive' | 'warning' | 'muted';

const SPINNING_STATUSES = new Set(['working', 'running', 'connecting', 'reconnecting', 'syncing']);
const PULSING_STATUSES = new Set(['blocked', 'waiting']);

export function statusMotionKind(status: string): StatusMotionKind {
  if (SPINNING_STATUSES.has(status)) return 'spin';
  if (PULSING_STATUSES.has(status)) return 'pulse';
  return 'static';
}

export function statusTone(status: string): StatusTone {
  if (['working', 'running', 'done', 'connected', 'active'].includes(status)) return 'success';
  if (['blocked', 'error', 'failed', 'disconnected'].includes(status)) return 'destructive';
  if (['waiting', 'connecting', 'reconnecting', 'syncing'].includes(status)) return 'warning';
  return 'muted';
}
