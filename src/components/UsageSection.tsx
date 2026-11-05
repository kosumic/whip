import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import ChartColumn from 'lucide-react-native/icons/chart-column';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import { useTranslation } from 'react-i18next';
import {
  voiceUsageLedger,
  type UsageMode,
  type UsageProvider,
  type UsageScope,
  type VoiceUsageCall,
  type VoiceUsageSummary,
  type VoiceUsageTotal,
} from '../services/voiceUsage';
import { useSectionExpansion } from '../hooks/useSectionExpansion';
import {
  formatUsageChartDate,
  usagePeriodStarts,
  type UsageRange,
} from '../lib/usagePeriods';
import { formatUsd as usd } from '../lib/formatUsd';
import {
  CollapsibleSectionCard,
  SECTION_TITLE_CLASS_NAME,
} from './CollapsibleSectionCard';
import { DetailsTitle } from './SettingsDetails';
import { UsageBarChart, UsageRangeTabs } from './UsageChart';
import { GlassButton } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import { WhippingTimeChart } from './WhippingTimeChart';
import { loadVoiceHistory, type SavedCall } from '../services/voiceHistory';
import { VoiceHistoryDetails } from './VoiceHistoryDetails';
import { VoiceHistoryRow } from './VoiceHistoryRow';

const PROVIDERS: (UsageProvider | undefined)[] = [undefined, 'local', 'openai'];
const MODES: (UsageMode | undefined)[] = [
  undefined,
  'turn_based',
  'realtime',
  'live',
  'tts',
  'stt',
];
const SCOPES: (UsageScope | undefined)[] = [
  undefined,
  'agent',
  'global',
  'speech',
  'preview',
];
const METRICS = ['time', 'cost', 'activity'] as const;
const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 2_000;
const MIN_COST_AXIS = 0.0001;

export function UsageSection() {
  const { t, i18n } = useTranslation();
  const { expanded, toggleExpanded } = useSectionExpansion('usage');
  const [range, setRange] = useState<UsageRange>('week');
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('time');
  const voiceMetricsVisible = metric !== 'time';
  const [selected, setSelected] = useState<number | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [provider, setProvider] = useState<UsageProvider>();
  const [mode, setMode] = useState<UsageMode>();
  const [scope, setScope] = useState<UsageScope>();
  const [summary, setSummary] = useState<VoiceUsageSummary>();
  const [savedCalls, setSavedCalls] = useState<SavedCall[]>([]);
  const [captionError, setCaptionError] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteError, setDeleteError] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    if (!expanded || !voiceMetricsVisible) return;
    let current = true;
    let revision = 0;
    let loading = false;
    let historyKey: string | undefined;
    let cachedHistory: SavedCall[] = [];
    const load = () => {
      if (loading || AppState.currentState !== 'active') return;
      loading = true;
      const request = ++revision;
      void voiceUsageLedger
        .summary({ provider, mode, scope }, new Date(), range)
        .then(async value => {
          const key = JSON.stringify(
            value.calls.map(call => [
              call.session_id,
              call.active,
              call.ended_at_ms,
            ]),
          );
          let historyError = false;
          if (key !== historyKey) {
            try {
              cachedHistory = await loadVoiceHistory();
              historyKey = key;
            } catch {
              historyError = true;
            }
          }
          return {
            value,
            captions: {
              calls: historyError ? [] : cachedHistory,
              error: historyError,
            },
          };
        })
        .then(
          ({ value, captions }) => {
            if (current && request === revision) {
              setSummary(value);
              setSavedCalls(captions.calls);
              setCaptionError(captions.error);
              setError(false);
            }
          },
          () => {
            if (current && request === revision) setError(true);
          },
        )
        .finally(() => {
          loading = false;
        });
    };
    setSummary(undefined);
    setSavedCalls([]);
    setSelectedCallId(undefined);
    setSelected(null);
    setLimit(PAGE_SIZE);
    load();
    const unsubscribe = voiceUsageLedger.subscribe(load);
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') load();
    });
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      current = false;
      unsubscribe();
      appState.remove();
      clearInterval(timer);
    };
  }, [expanded, voiceMetricsVisible, provider, mode, scope, range, refresh]);
  const cost = (call: VoiceUsageCall) =>
    call.provider === 'local'
      ? t('voiceUsage.localFree')
      : call.estimated_usd === null
        ? call.known_estimated_usd == null
          ? t('voiceUsage.unknown')
          : t('voiceUsage.partialEstimate', {
              cost: usd(call.known_estimated_usd),
            })
        : usd(call.estimated_usd);
  const totalCost = (total: VoiceUsageTotal) =>
    total.calls > 0 &&
    total.unknown_cost_calls === total.calls &&
    total.known_estimated_usd === 0
      ? t('voiceUsage.unknown')
      : usd(total.known_estimated_usd);
  const chart = summary?.chart;
  const total =
    selected === null ? summary?.totals[range] : chart?.buckets[selected];
  const date = selected === null ? undefined : chart?.dates[selected];
  const activeCalls = summary?.calls.filter(call => call.active) ?? [];
  const filterCount = [provider, mode, scope].filter(
    value => value !== undefined,
  ).length;
  const starts = usagePeriodStarts();
  const historyStart =
    selected !== null && chart
      ? Number(chart.boundaries[selected])
      : range === 'lifetime'
        ? 0
        : Number(starts[range]);
  const historyEnd =
    selected !== null && chart
      ? Number(chart.boundaries[selected + 1])
      : Infinity;
  const savedById = new Map(savedCalls.map(call => [call.id, call]));
  const usageIds = new Set(summary?.calls.map(call => call.session_id));
  const history = [
    ...(summary?.calls ?? []).map(call => ({
      id: call.session_id,
      timestamp: call.started_at_ms,
      call,
      saved: savedById.get(call.session_id),
    })),
    ...savedCalls
      .filter(saved => {
        if (usageIds.has(saved.id)) return false;
        const savedProvider =
          saved.usage?.provider ??
          (saved.model === 'local' ? 'local' : 'openai');
        const savedMode =
          saved.usage?.mode ??
          (saved.model === 'local'
            ? 'turn_based'
            : saved.model === 'gpt-live-1'
              ? 'live'
              : 'realtime');
        return (
          (!provider || provider === savedProvider) &&
          (!mode || mode === savedMode) &&
          (!scope || scope === saved.usage?.scope)
        );
      })
      .map(saved => ({
        id: saved.id,
        timestamp: saved.usage?.started_at_ms ?? saved.endedAtMs,
        call: undefined as VoiceUsageCall | undefined,
        saved,
      })),
  ]
    .filter(
      entry => entry.timestamp >= historyStart && entry.timestamp < historyEnd,
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  const selectedCall = summary?.calls.find(
    call => call.session_id === selectedCallId,
  );
  const selectedSaved = selectedCallId
    ? savedById.get(selectedCallId)
    : undefined;
  const deleteEntry = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    setDeleteError(false);
    try {
      await voiceUsageLedger.record({ kind: 'delete', session_id: id });
      setSavedCalls(calls => calls.filter(call => call.id !== id));
      if (selectedCallId === id) setSelectedCallId(undefined);
      setRefresh(value => value + 1);
    } catch {
      setDeleteError(true);
    } finally {
      setDeletingId(undefined);
    }
  };
  const number = (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(
      value,
    );
  return (
    <View className="px-4 py-2">
      <CollapsibleSectionCard
        title={t('voiceUsage.title')}
        icon={ChartColumn}
        titleContent={
          <DetailsTitle
            title={t('voiceUsage.title')}
            titleClassName={SECTION_TITLE_CLASS_NAME}
            copy={
              metric === 'time'
                ? `${t('usage.copy')}\n\n${t('usage.calendarCopy')}`
                : `${t('voiceUsage.explanation')}\n\n${t('voiceUsage.remoteUnknown')}\n\n${t('voiceUsage.periodNote')}`
            }
          />
        }
        expanded={expanded}
        onToggle={toggleExpanded}
        contentClassName="px-4 pb-4"
      >
        <UsageRangeTabs
          range={range}
          onChange={value => {
            setSelected(null);
            setRange(value);
          }}
        />
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-2">
          <View
            className="min-w-0 flex-1 flex-row gap-1"
            accessibilityRole="tablist"
          >
            {METRICS.map(value => (
              <GlassButton
                key={value}
                size="content"
                className="min-h-11 min-w-0 flex-1 px-2"
                variant={metric === value ? 'secondary' : 'ghost'}
                accessibilityRole="tab"
                accessibilityState={{ selected: metric === value }}
                onPress={() => {
                  if (value === 'time' || metric === 'time') setSelected(null);
                  setMetric(value);
                }}
              >
                <Text
                  className="text-xs font-medium"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                >
                  {t(`voiceUsage.${value}`)}
                </Text>
              </GlassButton>
            ))}
          </View>
          {voiceMetricsVisible && (
            <GlassButton
              variant="ghost"
              accessibilityLabel={t('voiceUsage.filters')}
              accessibilityState={{ expanded: filtersExpanded }}
              onPress={() => setFiltersExpanded(value => !value)}
            >
              <Icon as={SlidersHorizontal} size={16} />
              <Text className="text-xs">
                {t('voiceUsage.filters')}
                {filterCount > 0 ? ` · ${filterCount}` : ''}
              </Text>
            </GlassButton>
          )}
        </View>
        {voiceMetricsVisible && filtersExpanded && (
          <View className="mb-5 gap-3 border-b border-border pb-4">
            <UsageFilter
              title={t('voiceUsage.provider')}
              options={PROVIDERS}
              selected={provider}
              onSelect={setProvider}
              label={value =>
                t(value ? `voiceProvider.${value}` : 'voiceUsage.all')
              }
            />
            <UsageFilter
              title={t('voiceUsage.mode')}
              options={MODES}
              selected={mode}
              onSelect={setMode}
              label={value =>
                t(value ? `voiceUsage.${value}` : 'voiceUsage.all')
              }
            />
            <UsageFilter
              title={t('voiceUsage.scope')}
              options={SCOPES}
              selected={scope}
              onSelect={setScope}
              label={value =>
                t(value ? `voiceUsage.${value}` : 'voiceUsage.all')
              }
            />
          </View>
        )}
        {metric === 'time' ? (
          <WhippingTimeChart range={range} />
        ) : error ? (
          <View className="gap-3 py-4">
            <Text
              accessibilityRole="alert"
              className="text-sm text-destructive"
            >
              {t('voiceUsage.storageError')}
            </Text>
            <GlassButton onPress={() => setRefresh(value => value + 1)}>
              <Text>{t('voiceUsage.retry')}</Text>
            </GlassButton>
          </View>
        ) : !summary ? (
          <Text className="py-6 text-sm text-muted-foreground">
            {t('voiceUsage.loading')}
          </Text>
        ) : (
          <>
            <View className="mb-5 gap-1">
              <Text className="text-xs font-medium text-muted-foreground">
                {date && chart
                  ? formatUsageChartDate(date, chart.unit, range, i18n.language)
                  : t(`usage.${range}`)}
              </Text>
              <Text
                accessibilityLiveRegion="polite"
                className="text-[36px] font-semibold leading-[44px] tracking-tight"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.55}
              >
                {total
                  ? metric === 'cost'
                    ? totalCost(total)
                    : number(total.calls)
                  : '—'}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t(
                  metric === 'cost'
                    ? 'voiceUsage.estimatedCost'
                    : 'voiceUsage.activityCount',
                  { count: total?.calls ?? 0 },
                )}
              </Text>
            </View>
            <UsageBarChart
              chart={
                chart
                  ? {
                      ...chart,
                      values: chart.buckets.map(bucket =>
                        metric === 'cost'
                          ? bucket.known_estimated_usd
                          : bucket.calls,
                      ),
                      unknown: chart.buckets.map(
                        bucket =>
                          metric === 'cost' && bucket.unknown_cost_calls > 0,
                      ),
                      empty: summary.totals[range].calls === 0,
                    }
                  : null
              }
              range={range}
              selected={selected}
              onSelect={index => {
                setSelected(previous => (previous === index ? null : index));
                setLimit(PAGE_SIZE);
              }}
              formatValue={(_, index) => {
                const bucket = chart!.buckets[index];
                const value =
                  metric === 'cost'
                    ? totalCost(bucket)
                    : t('voiceUsage.activityCount', { count: bucket.calls });
                return bucket.unknown_cost_calls > 0
                  ? `${value}. ${t('voiceUsage.unknownCalls', { count: bucket.unknown_cost_calls })}`
                  : value;
              }}
              formatAxis={metric === 'cost' ? usd : number}
              minimumValue={metric === 'cost' ? MIN_COST_AXIS : 2}
            />
            <View className="mb-4 mt-2 gap-1">
              <Text className="text-xs text-muted-foreground">
                {t('voiceUsage.remoteUnknown')}
              </Text>
              {!!total?.unknown_cost_calls && (
                <View className="flex-row items-center gap-2">
                  <View className="size-2 rounded-sm border border-dashed border-muted-foreground" />
                  <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {t('voiceUsage.unknownCalls', {
                      count: total.unknown_cost_calls,
                    })}
                  </Text>
                </View>
              )}
              {!!total?.incomplete_calls && (
                <Text className="text-xs text-muted-foreground">
                  {t('voiceUsage.incompleteCalls', {
                    count: total.incomplete_calls,
                  })}
                </Text>
              )}
            </View>
            {activeCalls.length > 0 && (
              <View className="mb-4 gap-2 border-t border-border pt-4">
                <Text className="text-xs font-semibold text-muted-foreground">
                  {t('voiceUsage.current')}
                </Text>
                {activeCalls.map(call => (
                  <View
                    key={call.session_id}
                    className="flex-row items-center justify-between gap-3"
                  >
                    <Text className="min-w-0 flex-1 text-sm">
                      {t(`voiceUsage.${call.mode}`)} · {t('voiceUsage.active')}
                    </Text>
                    <Text className="max-w-[60%] text-right text-sm font-medium">
                      {cost(call)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <View className="border-t border-border pt-4">
              <Text className="mb-2 text-xs font-semibold text-muted-foreground">
                {t('voiceUsage.history')}
              </Text>
              {(captionError || deleteError) && (
                <Text
                  accessibilityRole="alert"
                  className="py-2 text-sm text-destructive"
                >
                  {t(
                    deleteError
                      ? 'voiceUsage.deleteFailed'
                      : 'voiceUsage.transcriptLoadFailed',
                  )}
                </Text>
              )}
              {history.length === 0 && (
                <Text className="py-3 text-sm text-muted-foreground">
                  {t(
                    summary.calls.length > 0
                      ? 'voiceUsage.emptyRange'
                      : mode === 'realtime' ||
                          mode === 'live' ||
                          provider === 'openai'
                        ? 'voiceUsage.cloudEmpty'
                        : 'voiceUsage.empty',
                  )}
                </Text>
              )}
              {history.slice(0, limit).map(({ id, timestamp, call, saved }) => (
                <VoiceHistoryRow
                  key={id}
                  label={`${call ? t(`voiceUsage.${call.mode}`) : saved!.model} · ${new Date(timestamp).toLocaleString(i18n.language)}`}
                  onOpen={() => setSelectedCallId(id)}
                  onDelete={() => {
                    void deleteEntry(id);
                  }}
                  deleting={deletingId === id}
                >
                  {call ? (
                    <>
                      <View className="flex-row items-start justify-between gap-3">
                        <Text className="min-w-0 flex-1 text-sm font-medium">
                          {t(`voiceUsage.${call.mode}`)}
                        </Text>
                        <Text className="max-w-[60%] text-right text-sm font-semibold">
                          {cost(call)}
                        </Text>
                      </View>
                      <Text className="text-xs text-muted-foreground">
                        {formatHistoryDate(call.started_at_ms, i18n.language)} ·{' '}
                        {t(`voiceUsage.${call.scope}`)}
                      </Text>
                      <CallHistoryTiming call={call} />
                      <Text className="text-xs text-muted-foreground">
                        {t(`voiceProvider.${call.provider}`)}
                        {call.model ? ` · ${call.model}` : ''}
                        {call.voice ? ` · ${call.voice}` : ''}
                      </Text>
                      {call.provider !== 'local' &&
                        call.status !== 'provider_usage_finalized' && (
                          <Text className="text-xs text-muted-foreground">
                            {t(`voiceUsage.${call.status}`)}
                          </Text>
                        )}
                    </>
                  ) : (
                    <>
                      <Text className="text-sm font-medium">
                        {saved!.model}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {formatHistoryDate(timestamp, i18n.language)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {t('voiceUsage.ended', {
                          time: new Date(saved!.endedAtMs).toLocaleTimeString(
                            i18n.language,
                          ),
                        })}
                      </Text>
                    </>
                  )}
                </VoiceHistoryRow>
              ))}
              {history.length > limit && (
                <GlassButton
                  variant="ghost"
                  onPress={() => setLimit(value => value + PAGE_SIZE)}
                >
                  <Text>{t('voiceUsage.more')}</Text>
                </GlassButton>
              )}
            </View>
          </>
        )}
      </CollapsibleSectionCard>
      {selectedCallId && (selectedCall || selectedSaved) && (
        <VoiceHistoryDetails
          key={selectedCallId}
          call={selectedCall}
          saved={selectedSaved}
          onClose={() => setSelectedCallId(undefined)}
        />
      )}
    </View>
  );
}

function formatHistoryDate(timestamp: number, language: string) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = date.toDateString();
  const offset =
    day === today.toDateString()
      ? 0
      : day === yesterday.toDateString()
        ? -1
        : null;
  return offset === null || typeof Intl.RelativeTimeFormat !== 'function'
    ? date.toLocaleDateString(language)
    : new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(
        offset,
        'day',
      );
}

function CallHistoryTiming({ call }: { call: VoiceUsageCall }) {
  const { t, i18n } = useTranslation();
  const start = new Date(call.started_at_ms);
  const end = call.ended_at_ms === null ? null : new Date(call.ended_at_ms);
  const formatTime = (date: Date) =>
    date.toLocaleTimeString(i18n.language, {
      hour: 'numeric',
      minute: '2-digit',
    });
  const endLabel = call.active
    ? t('voiceUsage.active')
    : end === null
      ? t('voiceUsage.endUnknown')
      : start.toDateString() === end.toDateString()
        ? formatTime(end)
        : `${formatHistoryDate(end.getTime(), i18n.language)} ${formatTime(end)}`;
  const durationEnd = call.active ? Date.now() : call.ended_at_ms;
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <Text className="text-xs text-muted-foreground">
        {formatTime(start)} – {endLabel}
      </Text>
      {durationEnd !== null && (
        <Text className="text-xs text-muted-foreground">
          {formatCallDuration(durationEnd - call.started_at_ms, i18n.language)}
        </Text>
      )}
    </View>
  );
}

function formatCallDuration(milliseconds: number, language: string) {
  const secondsPerMinute = 60;
  const secondsPerHour = secondsPerMinute * 60;
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const parts = [
    { unit: 'hour', value: Math.floor(seconds / secondsPerHour) },
    {
      unit: 'minute',
      value: Math.floor((seconds % secondsPerHour) / secondsPerMinute),
    },
    { unit: 'second', value: seconds % secondsPerMinute },
  ];
  return parts
    .filter(part => part.value > 0 || (part.unit === 'second' && seconds === 0))
    .map(part =>
      new Intl.NumberFormat(language, {
        style: 'unit',
        unit: part.unit,
        unitDisplay: 'narrow',
      }).format(part.value),
    )
    .join(' ');
}

function UsageFilter<T extends string>({
  title,
  options,
  selected,
  onSelect,
  label,
}: {
  title: string;
  options: (T | undefined)[];
  selected: T | undefined;
  onSelect: (value: T | undefined) => void;
  label: (value: T | undefined) => string;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-medium text-muted-foreground">{title}</Text>
      <View className="flex-row flex-wrap gap-1">
        {options.map(value => (
          <GlassButton
            key={value ?? 'all'}
            accessibilityRole="radio"
            accessibilityState={{ selected: selected === value }}
            variant={selected === value ? 'secondary' : 'ghost'}
            onPress={() => onSelect(value)}
          >
            <Text className="text-xs">{label(value)}</Text>
          </GlassButton>
        ))}
      </View>
    </View>
  );
}
