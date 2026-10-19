import { blendDiffColor, readableDiffColor } from '../src/lib/diffColors';

function luminance(hex: string) {
  return [1, 3, 5]
    .map(index => {
      const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}

it.each([
  '#1a1b26',
  '#ffffff',
  '#213a2b',
  '#4a221d',
  '#dafbe1',
  '#ffebe9',
  '#515177',
])('keeps syntax readable on %s', background => {
  for (const color of ['#545c7e', '#b48ead', '#777777', '#ffffff', '#000000']) {
    const result = readableDiffColor(color, background);
    const a = luminance(result);
    const b = luminance(background);
    expect(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    ).toBeGreaterThanOrEqual(4.5);
  }
});

it('preserves readable colors and paints a stable opaque diff surface', () => {
  expect(readableDiffColor('#ffffff', '#1a1b26')).toBe('#ffffff');
  expect(blendDiffColor('#ff0000', '#ffffff', 0.5)).toBe('#ff8080');
});
