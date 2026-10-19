import { CHAT_WORKING_LABEL, CHAT_WORKING_SHIMMER_PERIOD_MS, workingShimmerOpacity } from '../src/lib/chatWorkingAnimation';

const frame = (milliseconds: number) => Array.from(CHAT_WORKING_LABEL, (_, index) =>
  workingShimmerOpacity((milliseconds % CHAT_WORKING_SHIMMER_PERIOD_MS) / CHAT_WORKING_SHIMMER_PERIOD_MS, index));

test('the highlight travels from the first letter through the middle to the last letter', () => {
  const brightest = (milliseconds: number) => {
    const values = frame(milliseconds);
    return values.indexOf(Math.max(...values));
  };
  expect([850, 1100, 1350].map(brightest)).toEqual([0, 3, 6]);
  const middle = frame(1100);
  expect(middle[3]).toBe(1);
  expect(middle[0]).toBe(0.5);
  expect(middle[6]).toBe(0.5);
});

test('the wave has an initial delay and a quiet gap before the next left-to-right sweep', () => {
  const dim = Array.from(CHAT_WORKING_LABEL, () => 0.5);
  for (const ms of [0, 599, 1600, 3600, 4600]) expect(frame(ms)).toEqual(dim);
  expect(frame(5100)).toEqual(frame(1100));
});

test('adjacent letters overlap smoothly instead of flashing the entire word', () => {
  let previous = frame(0);
  for (let ms = 32; ms <= 5600; ms += 32) {
    const current = frame(ms);
    if (Math.max(...current) > 0.95) {
      expect(current.filter(value => value > 0.65).length).toBeGreaterThanOrEqual(2);
      expect(Math.min(...current)).toBe(0.5);
    }
    for (let index = 0; index < current.length; index++) {
      expect(Math.abs(current[index] - previous[index])).toBeLessThan(0.12);
    }
    previous = current;
  }
});
