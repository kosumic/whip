import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { usageChart, usageSummary } from 'react-native-whip-ssh';

import {
  usageChartPeriod,
  usagePeriodStarts,
  usageRanges,
  type UsageChartPeriod,
  type UsageRange,
} from '../lib/usagePeriods';
import { useTheme } from '../theme';
import { useSectionExpansion } from '../hooks/useSectionExpansion';
import { hapticPress, useReducedMotion } from './app-ui';
import { DetailsTitle } from './SettingsScreen';
import { Text } from './ui/text';
import { Icon } from './ui/icon';

const REFRESH_INTERVAL_MS = 5_000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const CHART_HEIGHT = 152;
const AXIS_HEIGHT = 28;
const TRANSITION_MS = 180;
const MAX_AXIS_LABELS = 6;

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

function axisMaximum(values: number[]) {
  const minutes = Math.max(1, ...values.map(value => value / MS_PER_MINUTE));
  const magnitude = 10 ** Math.floor(Math.log10(minutes));
  const step = [1, 2, 5, 10].find(value => value * magnitude >= minutes) ?? 10;
  return step * magnitude * MS_PER_MINUTE;
}

export function UsageSection() {
  const { t } = useTranslation();
  const { expanded, toggleExpanded } = useSectionExpansion('usage');
  const [range, setRange] = useState<UsageRange>('week');

  return (
    <View className="px-5 py-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('usage.title')}
        accessibilityState={{ expanded }}
        onPress={hapticPress(toggleExpanded)}
        className="min-h-12 flex-row items-center gap-3"
      >
        <View className="min-w-0 flex-1">
          <DetailsTitle
            title={t('usage.title')}
            titleClassName="text-[20px] font-semibold leading-7"
            copy={`${t('usage.copy')}\n\n${t('usage.calendarCopy')}`}
          />
        </View>
        <Icon
          as={expanded ? ChevronUp : ChevronDown}
          size={21}
          className="text-muted-foreground"
        />
      </Pressable>
      {expanded ? (
        <UsageContent range={range} onRangeChange={setRange} />
      ) : null}
    </View>
  );
}

function UsageContent({
  range,
  onRangeChange,
}: {
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const [chart, setChart] = useState<ChartView | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
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
  }, [range]);

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
  const dateLabel = (
    date: Date,
    unit: UsageChartPeriod['unit'],
    compact = false,
  ) => {
    const options: Intl.DateTimeFormatOptions =
      unit === 'hour'
        ? {
            hour: 'numeric',
            ...(compact ? {} : { minute: '2-digit', timeZoneName: 'short' }),
          }
        : unit === 'day'
          ? compact
            ? range === 'week'
              ? { weekday: 'narrow' }
              : { day: 'numeric' }
            : { weekday: 'short', month: 'short', day: 'numeric' }
          : unit === 'month'
            ? { month: 'short', ...(compact ? {} : { year: 'numeric' }) }
            : { year: 'numeric' };
    return new Intl.DateTimeFormat(i18n.language, options).format(date);
  };
  return (
    <>
      <View
        accessibilityRole="tablist"
        className="mb-5 mt-3 flex-row rounded-xl p-1"
        style={{ backgroundColor: colors.surfaceRaised }}
      >
        {usageRanges.map(option => (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected: option === range }}
            accessibilityLabel={t(`usage.${option}`)}
            onPress={hapticPress(() => {
              setSelected(null);
              onRangeChange(option);
            })}
            className="min-h-11 min-w-0 flex-1 items-center justify-center rounded-lg px-1 py-2"
            style={
              option === range ? { backgroundColor: colors.canvas } : undefined
            }
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className="text-xs font-semibold"
              style={{
                color: option === range ? colors.primary : colors.textSecondary,
              }}
            >
              {t(`usage.${option}`)}
            </Text>
          </Pressable>
        ))}
      </View>
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
      </View>
      <UsagePlot
        chart={unavailable ? null : current}
        range={range}
        selected={selected}
        onSelect={index =>
          setSelected(previous => (previous === index ? null : index))
        }
        duration={duration}
        axisDuration={axisDuration}
        dateLabel={dateLabel}
      />
    </>
  );
}

function UsagePlot({
  chart,
  range,
  selected,
  onSelect,
  duration,
  axisDuration,
  dateLabel,
}: {
  chart: ChartView | null;
  range: UsageRange;
  selected: number | null;
  onSelect: (index: number) => void;
  duration: (value: number) => string;
  axisDuration: (value: number) => string;
  dateLabel: (
    date: Date,
    unit: UsageChartPeriod['unit'],
    compact?: boolean,
  ) => string;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(1)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const transition = Animated.timing(progress, {
      toValue: 1,
      duration: TRANSITION_MS,
      useNativeDriver: true,
    });
    transition.start();
    return () => transition.stop();
  }, [progress, range, reduceMotion]);
  const values = chart?.values ?? [];
  const maximum = axisMaximum(values);
  const ticks = [1, 0.5, 0];
  const stride =
    values.length <= 7 ? 1 : Math.ceil(values.length / MAX_AXIS_LABELS);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [5, 0],
            }),
          },
        ],
      }}
    >
      <View className="flex-row">
        <View
          className="min-w-0 flex-1"
          onLayout={event => setWidth(event.nativeEvent.layout.width)}
        >
          <View style={styles.plot}>
            {ticks.map(tick => (
              <View
                key={tick}
                pointerEvents="none"
                style={[
                  styles.gridLine,
                  {
                    bottom: tick * CHART_HEIGHT,
                    backgroundColor: colors.divider,
                    opacity: tick === 0 ? 0.65 : 0.3,
                  },
                ]}
              />
            ))}
            <View style={styles.bars}>
              {values.map((milliseconds, index) => {
                const date = chart!.dates[index];
                const active = selected === index;
                const height =
                  milliseconds === 0
                    ? 0
                    : Math.max(2, (milliseconds / maximum) * CHART_HEIGHT);
                return (
                  <Pressable
                    key={date.getTime()}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${dateLabel(date, chart!.unit)}, ${duration(milliseconds)}`}
                    onPress={hapticPress(() => onSelect(index))}
                    className="active:opacity-60"
                    style={[
                      styles.barTarget,
                      {
                        backgroundColor: active
                          ? colors.surfaceRaised
                          : 'transparent',
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.bar,
                        {
                          height,
                          width: Math.min(
                            28,
                            Math.max(2, (width / values.length - 2) * 0.65),
                          ),
                          backgroundColor: colors.primary,
                          opacity: selected === null || active ? 1 : 0.3,
                        },
                      ]}
                    />
                  </Pressable>
                );
              })}
            </View>
            {chart?.total === 0 ? (
              <View pointerEvents="none" style={styles.emptyState}>
                <Text className="text-sm text-muted-foreground">
                  {t('usage.empty')}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.axis}>
            {chart?.dates.map((date, index) => {
              const last = index === values.length - 1;
              if (!last && index % stride !== 0) return null;
              if (!last && index > 0 && values.length - 1 - index < stride)
                return null;
              const labelWidth = 44;
              const left = Math.max(
                0,
                Math.min(
                  width - labelWidth,
                  ((index + 0.5) / values.length) * width - labelWidth / 2,
                ),
              );
              return (
                <Text
                  key={date.getTime()}
                  numberOfLines={1}
                  className="text-[10px] text-muted-foreground"
                  style={{
                    position: 'absolute',
                    left,
                    width: labelWidth,
                    top: 8,
                    textAlign: index === 0 ? 'left' : last ? 'right' : 'center',
                  }}
                >
                  {dateLabel(date, chart.unit, true)}
                </Text>
              );
            })}
          </View>
        </View>
        <View style={styles.valueAxis}>
          {ticks.map(tick => (
            <Text
              key={tick}
              className="text-[10px] text-muted-foreground"
              style={{
                position: 'absolute',
                right: 0,
                top: (1 - tick) * CHART_HEIGHT - 7,
              }}
            >
              {axisDuration(maximum * tick)}
            </Text>
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  plot: { height: CHART_HEIGHT },
  gridLine: {
    height: StyleSheet.hairlineWidth,
    position: 'absolute',
    left: 0,
    right: 0,
  },
  bars: {
    height: CHART_HEIGHT,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  barTarget: {
    flex: 1,
    height: CHART_HEIGHT,
    minWidth: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginHorizontal: 1,
    borderRadius: 4,
  },
  bar: {
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  axis: { height: AXIS_HEIGHT },
  valueAxis: { width: 42, height: CHART_HEIGHT },
  emptyState: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
