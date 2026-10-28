/* eslint-disable no-bitwise -- Exercise combined terminal modifier masks. */
import {
  CellModifier,
  isSkiaHerdrRenderer,
  surfaceColor,
  surfaceCellBackground,
  surfaceCellForeground,
  SURFACE_BACKGROUND,
  SURFACE_FOREGROUND,
  type SurfaceCell,
} from '../src/lib/herdrSurface';
import {
  terminalAnsiPalette,
  terminalTheme,
} from '../src/lib/terminalAppearance';

it.each([
  [undefined, 'herdr', 'pane', false],
  ['xterm.js', 'herdr', 'pane', false],
  ['skia', 'ssh', 'pane', false],
  ['skia', undefined, 'pane', false],
  ['skia', 'herdr', undefined, false],
  ['skia', 'herdr', 'pane', true],
])('gates %s rendering for %s panes', (renderer, kind, pane, expected) => {
  expect(isSkiaHerdrRenderer(renderer, kind, pane)).toBe(expected);
});
it('decodes Herdr named, indexed, and RGB colors', () => {
  expect(surfaceColor(0, 'default')).toBe('default');
  expect(surfaceColor(2, 'default')).toBe(terminalTheme.red);
  expect(surfaceColor(0x01000001, 'default')).toBe(terminalTheme.red);
  expect(surfaceColor(0x01000010, 'default')).toBe('#000000');
  expect(surfaceColor(0x010000e7, 'default')).toBe('#ffffff');
  expect(surfaceColor(0x010000ff, 'default')).toBe('#eeeeee');
  expect(surfaceColor(0x0212abef, 'default')).toBe('#12abef');
  expect(surfaceColor(0x03000000, 'default')).toBe('default');
  expect(
    CellModifier.Bold |
      CellModifier.Italic |
      CellModifier.Underline |
      CellModifier.Inverse,
  ).toBe(77);
});

it('uses Whip terminal colors while preserving its transparent background and inverse contrast', () => {
  const cell: SurfaceCell = {
    symbol: 'a',
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
  };
  expect(surfaceCellBackground(cell)).toBe(terminalTheme.background);
  expect(surfaceCellForeground(cell)).toBe(terminalTheme.foreground);
  expect(SURFACE_BACKGROUND).toBe(terminalTheme.background);
  expect(SURFACE_FOREGROUND).toBe(terminalTheme.foreground);
  for (let i = 0; i < terminalAnsiPalette.length; i++)
    expect(surfaceColor(0x01000000 + i, 'default')).toBe(
      terminalAnsiPalette[i],
    );
  const inverse = { ...cell, modifier: CellModifier.Inverse };
  expect(surfaceCellBackground(inverse)).toBe(terminalTheme.foreground);
  expect(surfaceCellForeground(inverse)).toBe('#000000');
  expect(surfaceCellForeground({ ...inverse, bg: 0x02123456 })).toBe('#123456');
});

it('preserves structured native failure details for recovery', () => {
  const { surfaceErrorMessage } = require('../src/lib/herdrSurface');
  expect(
    surfaceErrorMessage({ inner: { reason: 'SSH stream disconnected' } }),
  ).toBe('SSH stream disconnected');
  expect(surfaceErrorMessage(new Error('revision gap'))).toBe('revision gap');
});
