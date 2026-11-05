import { appStorage } from './appStorage';
import { settledPromise } from '../lib/promises';
import { usageChartPeriod, type UsageChartPeriod, type UsageRange } from '../lib/usagePeriods';
import type { VoiceTranscriptEntry } from '../lib/voiceTranscript';

export type UsageProvider = 'local' | 'openai';
export type UsageMode = 'turn_based' | 'realtime' | 'live' | 'tts' | 'stt';
export type UsageScope = 'agent' | 'global' | 'speech' | 'preview';
export type AccountingStatus = 'live_estimate' | 'provider_usage_finalized' | 'incomplete';
export type UsageMetric = 'input_text' | 'cached_input_text' | 'output_text' | 'input_audio' | 'cached_input_audio' | 'output_audio' | 'input_image' | 'cached_input_image' | 'other';
export type UsageUnit = 'tokens' | 'seconds' | 'requests';
export interface UsageQuantity { metric: UsageMetric; unit: UsageUnit; amount: number }
/** All monetary values are USD; rates apply to one unit, not one million units. */
export interface VoicePriceSnapshot {
  version: number;
  id: string;
  source_url: string;
  effective_at_ms: number;
  rates: { metric: UsageMetric; unit: UsageUnit; usd_per_unit: number }[];
}
export interface VoiceUsageIdentity {
  session_id: string;
  provider: UsageProvider;
  mode: UsageMode;
  model: string | null;
  voice: string | null;
  scope: UsageScope;
  started_at_ms: number;
}
export interface VoiceUsageItem {
  revision: number;
  reported_usage: UsageQuantity[];
  estimated_usd: number | null;
  price_snapshot: VoicePriceSnapshot | null;
  finalized: boolean;
}
/** Stable item IDs and monotonically increasing revisions replace cumulative
 * accounting, never add it again. Finalized items are immutable. */
export type VoiceUsageEvent =
  | { kind: 'started'; call: VoiceUsageIdentity }
  | { kind: 'usage'; session_id: string; item_id: string; item: VoiceUsageItem }
  | { kind: 'ended'; session_id: string; ended_at_ms: number }
  | { kind: 'recover' };
export type VoiceHistoryCommand =
  | { kind: 'transcript'; session_id: string; fragments: readonly VoiceTranscriptEntry[] }
  | { kind: 'delete'; session_id: string };
export interface VoiceUsageCall extends VoiceUsageIdentity {
  ended_at_ms: number | null;
  active: boolean;
  estimated_usd: number | null;
  /** Sum of the priced components, even when the complete call is unpriced. */
  known_estimated_usd?: number | null;
  remote_agent_estimated_usd: number | null;
  status: AccountingStatus;
  items: Record<string, VoiceUsageItem>;
}
export type UsagePeriod = UsageRange;
export interface VoiceUsageTotal { known_estimated_usd: number; unknown_cost_calls: number; incomplete_calls: number; calls: number }
export type VoiceUsageChart = UsageChartPeriod & { buckets: VoiceUsageTotal[] };
export interface VoiceUsageSummary { calls: VoiceUsageCall[]; totals: Record<UsagePeriod, VoiceUsageTotal>; chart?: VoiceUsageChart }
export interface VoiceUsageFilter { provider?: UsageProvider; mode?: UsageMode; scope?: UsageScope }

export function voiceUsageQuery(filter: VoiceUsageFilter, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(today);
  week.setDate(week.getDate() - (week.getDay() + 6) % 7); // Local Monday, including DST.
  return { ...filter, now_ms: now.getTime(), today_ms: today.getTime(), week_ms: week.getTime(),
    month_ms: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
}
interface UsageBridge { recordVoiceUsage(event: string): Promise<void>; voiceUsageSummary(query: string): Promise<string> }
const nativeBridge = (): UsageBridge => require('react-native-whip-ssh') as UsageBridge;

/** Persistence never gates call I/O. Errors remain visible in Usage & costs.
 * Failed operations stay in this process's queue, in order, for a later retry. */
export class VoiceUsageLedger {
  private recovered = false;
  private pending: (VoiceUsageEvent | VoiceHistoryCommand)[] = [];
  private operations: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly bridge = nativeBridge, private readonly initialize = () => appStorage.initialize()) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation);
    this.operations = settledPromise(next);
    return next;
  }
  private async flush(): Promise<void> {
    await this.initialize();
    if (!this.recovered) {
      await this.bridge().recordVoiceUsage(JSON.stringify({ kind: 'recover' }));
      this.recovered = true;
    }
    while (this.pending.length) {
      await this.bridge().recordVoiceUsage(JSON.stringify(this.pending[0]));
      this.pending.shift();
    }
  }
  record(event: VoiceUsageEvent | VoiceHistoryCommand): Promise<void> {
    // Snapshot immediately: adapters must not mutate a pending usage report.
    this.pending.push(JSON.parse(JSON.stringify(event)) as VoiceUsageEvent);
    return this.enqueue(async () => {
      try { await this.flush(); }
      finally { for (const listener of this.listeners) listener(); }
    });
  }
  summary(filter: VoiceUsageFilter = {}, now = new Date(), range?: UsageRange): Promise<VoiceUsageSummary> {
    return this.enqueue(async () => {
      await this.flush();
      const query = voiceUsageQuery(filter, now);
      const read = async (period?: UsageChartPeriod) => JSON.parse(await this.bridge().voiceUsageSummary(JSON.stringify({
        ...query, ...(period ? { chart_boundaries_ms: period.boundaries.map(Number) } : {}),
      }))) as VoiceUsageSummary & { chart_buckets?: VoiceUsageTotal[] };
      let period = range && range !== 'lifetime' ? usageChartPeriod(range, now) : undefined;
      let summary = await read(period);
      if (range === 'lifetime') {
        const first = summary.calls.at(-1)?.started_at_ms;
        period = usageChartPeriod(range, now, first === undefined ? undefined : BigInt(first));
        summary = await read(period);
      }
      if (!period) return summary;
      if (summary.chart_buckets?.length !== period.dates.length) throw new Error('Voice usage chart is unavailable.');
      return { ...summary, chart: { ...period, buckets: summary.chart_buckets } };
    });
  }
}
export const voiceUsageLedger = new VoiceUsageLedger();
