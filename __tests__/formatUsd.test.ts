import { formatUsd } from '../src/lib/formatUsd';

test('nonzero API costs smaller than the display precision are never shown as zero', () => {
  expect(formatUsd(0.000001)).toBe('< USD 0.0001');
  expect(formatUsd(0)).toBe('USD 0.0000');
  expect(formatUsd(0.0001)).toBe('USD 0.0001');
  expect(formatUsd(0.00246)).toBe('USD 0.0025');
});
