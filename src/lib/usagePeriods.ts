/** Calendar boundaries use device-local dates so midnight and DST stay correct. */
export function usagePeriodStarts(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(today);
  const daysSinceMonday = (today.getDay() + 6) % 7;
  week.setDate(week.getDate() - daysSinceMonday);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    today: BigInt(today.getTime()),
    week: BigInt(week.getTime()),
    month: BigInt(month.getTime()),
  };
}

export const usageRanges = ['today', 'week', 'month', 'lifetime'] as const;
export type UsageRange = (typeof usageRanges)[number];
export type UsageChartPeriod = {
  boundaries: bigint[];
  dates: Date[];
  unit: 'hour' | 'day' | 'month' | 'year';
};

const HOUR_MS = 60 * 60 * 1_000;
const MIN_LIFETIME_MONTHS = 6;
const MAX_LIFETIME_MONTHS = 24;

/** Only calendar layout lives here; Rust owns clipping and summing usage. */
export function usageChartPeriod(
  range: UsageRange,
  now = new Date(),
  startedAt?: bigint,
): UsageChartPeriod {
  const starts = usagePeriodStarts(now);
  const dates: Date[] = [];
  let unit: UsageChartPeriod['unit'] = 'day';
  if (range === 'today') {
    unit = 'hour';
    const start = Number(starts.today);
    const end = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    // Elapsed hours preserve repeated and missing hours on DST days.
    for (let timestamp = start; timestamp < end; timestamp += HOUR_MS) {
      dates.push(new Date(timestamp));
    }
    dates.push(new Date(end));
  } else if (range === 'week' || range === 'month') {
    const start = new Date(Number(starts[range]));
    const days =
      range === 'week'
        ? 7
        : new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let day = 0; day <= days; day++) {
      dates.push(
        new Date(start.getFullYear(), start.getMonth(), start.getDate() + day),
      );
    }
  } else {
    const first = startedAt === undefined ? now : new Date(Number(startedAt));
    const months =
      (now.getFullYear() - first.getFullYear()) * 12 +
      now.getMonth() -
      first.getMonth() +
      1;
    if (months <= MAX_LIFETIME_MONTHS) {
      unit = 'month';
      const count = Math.max(MIN_LIFETIME_MONTHS, months);
      for (let month = 1 - count; month <= 1; month++) {
        dates.push(new Date(now.getFullYear(), now.getMonth() + month, 1));
      }
    } else {
      unit = 'year';
      for (
        let year = first.getFullYear();
        year <= now.getFullYear() + 1;
        year++
      ) {
        dates.push(new Date(year, 0, 1));
      }
    }
  }
  return {
    boundaries: dates.map(date => BigInt(date.getTime())),
    dates: dates.slice(0, -1),
    unit,
  };
}
