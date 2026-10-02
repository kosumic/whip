import { usageChartPeriod, usagePeriodStarts } from '../src/lib/usagePeriods';

const localDate = (timestamp: bigint) => new Date(Number(timestamp));

it('uses Monday as the start of a week crossing a month and year boundary', () => {
  const starts = usagePeriodStarts(new Date(2027, 0, 3, 18, 45));
  expect(localDate(starts.today)).toEqual(new Date(2027, 0, 3));
  expect(localDate(starts.week)).toEqual(new Date(2026, 11, 28));
  expect(localDate(starts.month)).toEqual(new Date(2027, 0, 1));
});

it('starts a new week at local Monday midnight', () => {
  const starts = usagePeriodStarts(new Date(2026, 8, 21, 0, 0));
  expect(starts.week).toBe(starts.today);
});

it('uses calendar midnights rather than subtracting 24-hour durations across DST', () => {
  // Run with TZ=America/New_York to exercise the spring-forward transition.
  const starts = usagePeriodStarts(new Date(2026, 2, 8, 23, 30));
  expect(localDate(starts.today)).toEqual(new Date(2026, 2, 8));
  expect(localDate(starts.week)).toEqual(new Date(2026, 2, 2));
  expect(localDate(starts.month)).toEqual(new Date(2026, 2, 1));
});

it.each([new Date(2026, 2, 8, 12), new Date(2026, 10, 1, 12)])(
  'keeps every elapsed hour on a DST day: %s',
  now => {
    const period = usageChartPeriod('today', now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const expectedHours =
      24 + (end.getTimezoneOffset() - start.getTimezoneOffset()) / 60;
    expect(period.dates).toHaveLength(expectedHours);
    expect(period.boundaries[0]).toBe(BigInt(start.getTime()));
    expect(period.boundaries.at(-1)).toBe(BigInt(end.getTime()));
    expect(new Set(period.boundaries).size).toBe(period.boundaries.length);
  },
);

it('includes all seven local days and the end boundary for the week', () => {
  const period = usageChartPeriod('week', new Date(2027, 0, 3, 12));
  expect(period.dates).toHaveLength(7);
  expect(period.dates[0]).toEqual(new Date(2026, 11, 28));
  expect(localDate(period.boundaries.at(-1)!)).toEqual(new Date(2027, 0, 4));
});

it('includes leap day in the month chart', () => {
  const period = usageChartPeriod('month', new Date(2028, 1, 12));
  expect(period.dates).toHaveLength(29);
  expect(period.dates.at(-1)).toEqual(new Date(2028, 1, 29));
  expect(localDate(period.boundaries.at(-1)!)).toEqual(new Date(2028, 2, 1));
});

it('shows six months for a new lifetime and switches long histories to years', () => {
  const now = new Date(2026, 8, 22);
  const recent = usageChartPeriod('lifetime', now, BigInt(now.getTime()));
  expect(recent.unit).toBe('month');
  expect(recent.dates).toHaveLength(6);
  expect(recent.dates[0]).toEqual(new Date(2026, 3, 1));
  const years = usageChartPeriod(
    'lifetime',
    now,
    BigInt(new Date(2022, 5, 1).getTime()),
  );
  expect(years.unit).toBe('year');
  expect(years.dates[0]).toEqual(new Date(2022, 0, 1));
  expect(localDate(years.boundaries.at(-1)!)).toEqual(new Date(2027, 0, 1));
});
