import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { voiceUsageLedger, type UsageMode, type UsagePeriod, type UsageProvider, type UsageScope, type VoiceUsageCall, type VoiceUsageSummary } from '../services/voiceUsage';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';
import { formatUsd as usd } from '../lib/formatUsd';

const PERIODS: UsagePeriod[] = ['today', 'week', 'month', 'lifetime'];
const PROVIDERS: (UsageProvider | undefined)[] = [undefined, 'local', 'openai'];
const MODES: (UsageMode | undefined)[] = [undefined, 'turn_based', 'realtime', 'live', 'tts'];
const SCOPES: (UsageScope | undefined)[] = [undefined, 'agent', 'global', 'speech', 'preview'];
const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 2_000;

export function VoiceUsageSetting() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [provider, setProvider] = useState<UsageProvider>();
  const [mode, setMode] = useState<UsageMode>();
  const [scope, setScope] = useState<UsageScope>();
  const [summary, setSummary] = useState<VoiceUsageSummary>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    let revision = 0;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      const request = ++revision;
      void voiceUsageLedger.summary({ provider, mode, scope }).then(value => {
        if (current && request === revision) { setSummary(value); setError(false); }
      }, () => { if (current && request === revision) setError(true); }).finally(() => { loading = false; });
    };
    setSummary(undefined); setLimit(PAGE_SIZE); load();
    const unsubscribe = voiceUsageLedger.subscribe(load);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') load(); });
    // Native speech can finish without a JS session event. Refresh only while
    // this panel is open; this also keeps local-calendar totals current.
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => { current = false; unsubscribe(); appState.remove(); clearInterval(timer); };
  }, [expanded, provider, mode, scope, refresh]);
  const cost = (call: VoiceUsageCall) => call.provider === 'local' ? t('voiceUsage.localFree')
    : call.estimated_usd === null ? t('voiceUsage.unknown') : usd(call.estimated_usd);
  return <View className="gap-2 border-b border-border px-3.5 py-3">
    <GlassButton accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
      <Text className="text-sm font-medium">{t('voiceUsage.title')}</Text>
    </GlassButton>
    {expanded && <>
      <Text className="text-xs text-muted-foreground">{t('voiceUsage.explanation')}</Text>
      <Text className="text-xs text-muted-foreground">{t('voiceUsage.remoteUnknown')}</Text>
      <Text className="text-xs text-muted-foreground">{t('voiceUsage.periodNote')}</Text>
      <Text className="text-sm font-medium">{t('voiceUsage.provider')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {PROVIDERS.map(value => <GlassButton key={value ?? 'all'} accessibilityRole="radio"
          accessibilityState={{ selected: provider === value }} variant={provider === value ? 'secondary' : 'ghost'}
          onPress={() => setProvider(value)}><Text>{t(value ? `voiceProvider.${value}` : 'voiceUsage.all')}</Text></GlassButton>)}
      </View>
      <Text className="text-sm font-medium">{t('voiceUsage.mode')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {MODES.map(value => <GlassButton key={value ?? 'all'} accessibilityRole="radio"
          accessibilityState={{ selected: mode === value }} variant={mode === value ? 'secondary' : 'ghost'}
          onPress={() => setMode(value)}><Text>{t(value ? `voiceUsage.${value}` : 'voiceUsage.all')}</Text></GlassButton>)}
      </View>
      <Text className="text-sm font-medium">{t('voiceUsage.scope')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {SCOPES.map(value => <GlassButton key={value ?? 'all'} accessibilityRole="radio"
          accessibilityState={{ selected: scope === value }} variant={scope === value ? 'secondary' : 'ghost'}
          onPress={() => setScope(value)}><Text>{t(value ? `voiceUsage.${value}` : 'voiceUsage.all')}</Text></GlassButton>)}
      </View>
      {error ? <>
        <Text accessibilityRole="alert" className="text-xs text-destructive">{t('voiceUsage.storageError')}</Text>
        <GlassButton onPress={() => setRefresh(value => value + 1)}><Text>{t('voiceUsage.retry')}</Text></GlassButton>
      </> : !summary ? <Text>{t('voiceUsage.loading')}</Text> : <>
        <Text className="text-sm font-medium">{t('voiceUsage.current')}</Text>
        {summary.calls.some(call => call.active) ? summary.calls.filter(call => call.active).map(call =>
          <Text key={call.session_id}>{cost(call)}</Text>) : <Text className="text-xs text-muted-foreground">{t('voiceUsage.noCurrent')}</Text>}
        {PERIODS.map(period => {
          const total = summary.totals[period];
          return <View key={period} className="gap-1 border-t border-border py-2">
            <Text>{t(`voiceUsage.${period}`)} · {t('voiceUsage.activityCount', { count: total.calls })}</Text>
            <Text>{total.calls === 0 ? t('voiceUsage.noCalls')
              : total.unknown_cost_calls > 0 && total.known_estimated_usd === 0 ? t('voiceUsage.unknown')
                : t('voiceUsage.knownEstimate', { cost: usd(total.known_estimated_usd) })}</Text>
            {total.unknown_cost_calls > 0 && <Text className="text-xs text-muted-foreground">{t('voiceUsage.unknownCalls', { count: total.unknown_cost_calls })}</Text>}
            {total.incomplete_calls > 0 && <Text className="text-xs text-muted-foreground">{t('voiceUsage.incompleteCalls', { count: total.incomplete_calls })}</Text>}
          </View>;
        })}
        <Text className="text-sm font-medium">{t('voiceUsage.history')}</Text>
        {summary.calls.length === 0 && <Text className="text-xs text-muted-foreground">{t(mode === 'realtime' || mode === 'live' || provider === 'openai' ? 'voiceUsage.cloudEmpty' : 'voiceUsage.empty')}</Text>}
        {summary.calls.slice(0, limit).map(call => <View key={call.session_id} className="gap-1 border-t border-border py-2">
          <Text>{new Date(call.started_at_ms).toLocaleString()} · {t(`voiceUsage.${call.mode}`)}</Text>
          <Text className="text-xs text-muted-foreground">{t(`voiceProvider.${call.provider}`)} · {t(`voiceUsage.${call.scope}`)}{call.model ? ` · ${call.model}` : ''}{call.voice ? ` · ${call.voice}` : ''}</Text>
          <Text>{cost(call)}</Text>
          {call.provider !== 'local' && <Text className="text-xs text-muted-foreground">{t(`voiceUsage.${call.status}`)}</Text>}
          <Text className="text-xs text-muted-foreground">{call.active ? t('voiceUsage.active') : call.ended_at_ms === null ? t('voiceUsage.endUnknown') : t('voiceUsage.ended', { time: new Date(call.ended_at_ms).toLocaleString() })}</Text>
        </View>)}
        {summary.calls.length > limit && <GlassButton onPress={() => setLimit(value => value + PAGE_SIZE)}><Text>{t('voiceUsage.more')}</Text></GlassButton>}
      </>}
    </>}
  </View>;
}
