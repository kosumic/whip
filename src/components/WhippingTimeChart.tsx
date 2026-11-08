import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { usageChart, usageSummary } from 'react-native-whip-ssh';
import { useScreenVisible } from '../lib/screenVisibility';
import {
  usageChartPeriod,
  usagePeriodStarts,
  formatUsageChartDate,
  type UsageChartPeriod,
  type UsageRange,
} from '../lib/usagePeriods';
import { UsageBarChart } from './UsageChart';
import { Text } from './ui/text';

const REFRESH_INTERVAL_MS = 5_000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

type ChartView = UsageChartPeriod & {
  range: UsageRange;
  values: number[];
  total: number;
};

function readChart(range: UsageRange): ChartView {
  const now = new Date();
  const starts = usagePeriodStarts(now);
  const summary = usageSummary(starts.today, starts.week, starts.month);
  const period = usageChartPeriod(range, now, summary.startedAtMs);
  const chart = usageChart(period.boundaries);
  return {
    ...period,
    range,
    values: chart.bucketsMs.map(Number),
    total: Number(range === 'lifetime' ? summary.lifetimeMs : chart.totalMs),
  };
}

export function WhippingTimeChart({ range }: { range: UsageRange }) {
  const { t, i18n } = useTranslation();
  const visible = useScreenVisible();
  const [chart, setChart] = useState<ChartView | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setSelected(null);
  }, [range]);
  useEffect(() => {
    if (!visible) return;
    const refresh = () => {
      if (AppState.currentState !== 'active') return;
      try {
        setChart(readChart(range));
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', refresh);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [range, visible]);

  const duration = (milliseconds: number) => {
    if (milliseconds > 0 && milliseconds < MS_PER_MINUTE)
      return t('usage.lessThanMinute');
    const minutes = Math.floor(milliseconds / MS_PER_MINUTE);
    return t('usage.duration', {
      hours: Math.floor(minutes / MINUTES_PER_HOUR),
      minutes: minutes % MINUTES_PER_HOUR,
    });
  };
  const axisDuration = (milliseconds: number) => {
    const minutes = milliseconds / MS_PER_MINUTE;
    const value =
      minutes >= MINUTES_PER_HOUR ? minutes / MINUTES_PER_HOUR : minutes;
    return t(
      minutes >= MINUTES_PER_HOUR ? 'usage.axisHours' : 'usage.axisMinutes',
      {
        value: new Intl.NumberFormat(i18n.language, {
          maximumFractionDigits: 1,
        }).format(value),
      },
    );
  };
  const current = chart?.range === range ? chart : null;
  const selectedDate = selected === null ? undefined : current?.dates[selected];
  const value = selected === null ? current?.total : current?.values[selected];
  const dateLabel = (date: Date, unit: UsageChartPeriod['unit']) =>
    formatUsageChartDate(date, unit, range, i18n.language);
  return (
    <>
      <View className="mb-5">
        {selectedDate && current ? (
          <Text className="mb-1 text-xs font-medium text-muted-foreground">
            {dateLabel(selectedDate, current.unit)}
          </Text>
        ) : null}
        <Text
          accessibilityLiveRegion="polite"
          className="text-[36px] font-semibold leading-[44px] tracking-tight"
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {unavailable
            ? t('common.unavailable')
            : value === undefined
              ? '—'
              : duration(value)}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t('usage.title')}
        </Text>
      </View>
      <UsageBarChart
        chart={
          unavailable || !current
            ? null
            : { ...current, empty: current.total === 0 }
        }
        range={range}
        selected={selected}
        onSelect={index =>
          setSelected(previous => (previous === index ? null : index))
        }
        formatValue={duration}
        formatAxis={axisDuration}
        minimumValue={MS_PER_MINUTE}
        axisUnit={MS_PER_MINUTE}
      />
    </>
  );
}
