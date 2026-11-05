import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  formatUsageChartDate,
  usageRanges,
  type UsageChartPeriod,
  type UsageRange,
} from '../lib/usagePeriods';
import { appGlassControlStyle, useTheme } from '../theme';
import { hapticPress, useReducedMotion } from './app-ui';
import { GlassBackdrop, useAppGlassEnabled } from './GlassSurface';
import { Text } from './ui/text';

const CHART_HEIGHT = 152;
const AXIS_HEIGHT = 28;
const TRANSITION_MS = 180;
const MAX_AXIS_LABELS = 6;

export type UsageBarChartData = Pick<UsageChartPeriod, 'dates' | 'unit'> & {
  values: number[];
  empty: boolean;
  unknown?: boolean[];
};

function axisMaximum(values: number[], minimum: number) {
  const value = Math.max(minimum, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find(option => option * magnitude >= value) ?? 10;
  return step * magnitude;
}

export function UsageRangeTabs({
  range,
  onChange,
}: {
  range: UsageRange;
  onChange: (range: UsageRange) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <View
      accessibilityRole="tablist"
      className="relative mb-5 mt-3 flex-row overflow-hidden rounded-xl p-1"
      style={
        appGlassEnabled ? undefined : { backgroundColor: colors.surfaceRaised }
      }
    >
      {appGlassEnabled ? <GlassBackdrop shapeClassName="rounded-xl" /> : null}
      {usageRanges.map(option => (
        <Pressable
          key={option}
          accessibilityRole="tab"
          accessibilityState={{ selected: option === range }}
          accessibilityLabel={t(`usage.${option}`)}
          onPress={hapticPress(() => {
            onChange(option);
          })}
          className="min-h-11 min-w-0 flex-1 items-center justify-center rounded-lg border px-1 py-2 active:opacity-70"
          style={
            appGlassEnabled && option === range
              ? appGlassControlStyle(true, colors)
              : {
                  borderColor: 'transparent',
                  backgroundColor:
                    !appGlassEnabled && option === range
                      ? colors.canvas
                      : 'transparent',
                }
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
  );
}

export function UsageBarChart({
  chart,
  range,
  selected,
  onSelect,
  formatValue,
  formatAxis,
  minimumValue = 1,
  axisUnit = 1,
}: {
  chart: UsageBarChartData | null;
  range: UsageRange;
  selected: number | null;
  onSelect: (index: number) => void;
  formatValue: (value: number, index: number) => string;
  formatAxis: (value: number) => string;
  minimumValue?: number;
  axisUnit?: number;
}) {
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const dateLabel = (
    date: Date,
    unit: UsageChartPeriod['unit'],
    compact = false,
  ) => formatUsageChartDate(date, unit, range, i18n.language, compact);
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
  const maximum =
    axisMaximum(
      values.map(value => value / axisUnit),
      minimumValue / axisUnit,
    ) * axisUnit;
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
              {values.map((value, index) => {
                const date = chart!.dates[index];
                const active = selected === index;
                const height =
                  value === 0
                    ? 0
                    : Math.max(2, (value / maximum) * CHART_HEIGHT);
                return (
                  <Pressable
                    key={date.getTime()}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${dateLabel(date, chart!.unit)}, ${formatValue(value, index)}`}
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
                    {chart?.unknown?.[index] && (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.unknownMarker,
                          {
                            borderColor: colors.textSecondary,
                            backgroundColor: colors.canvas,
                          },
                        ]}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>
            {chart?.empty ? (
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
              {formatAxis(maximum * tick)}
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
  unknownMarker: {
    position: 'absolute',
    bottom: 3,
    width: 8,
    height: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 2,
  },
  axis: { height: AXIS_HEIGHT },
  valueAxis: { width: 42, height: CHART_HEIGHT },
  emptyState: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
