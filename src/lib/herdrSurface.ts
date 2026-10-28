/* eslint-disable no-bitwise -- Herdr uses packed wire colors and modifier masks. */
import {
  terminalAnsiPalette as ANSI,
  terminalTheme,
} from './terminalAppearance';
export function isSkiaHerdrRenderer(
  renderer: string | undefined,
  kind: string | undefined,
  paneId: string | undefined,
): boolean {
  return renderer === 'skia' && kind === 'herdr' && Boolean(paneId);
}

export interface SurfaceCell {
  symbol: string;
  fg: number;
  bg: number;
  modifier: number;
  skip: boolean;
  hyperlink: number | null;
}
export interface SurfaceCursor {
  x: number;
  y: number;
  visible: boolean;
  shape: number;
}
export interface SurfaceUpdate {
  width: number;
  height: number;
  revision: number;
  reset: boolean;
  cursor: SurfaceCursor | null;
  hyperlinks: string[];
  /** Row, first column, changed cells including adjacent glyphs. */
  rows: [number, number, SurfaceCell[]][];
}

export const SURFACE_BACKGROUND = terminalTheme.background;
export const SURFACE_FOREGROUND = terminalTheme.foreground;
export const CellModifier = {
  Bold: 1,
  Dim: 2,
  Italic: 4,
  Underline: 8,
  Inverse: 64,
  Hidden: 128,
  Strike: 256,
} as const;

export function surfaceCellForeground(cell: SurfaceCell): string {
  return cell.modifier & CellModifier.Inverse
    ? surfaceColor(cell.bg, '#000000')
    : surfaceColor(cell.fg, SURFACE_FOREGROUND);
}

export function surfaceCellBackground(cell: SurfaceCell): string {
  return cell.modifier & CellModifier.Inverse
    ? surfaceColor(cell.fg, SURFACE_FOREGROUND)
    : surfaceColor(cell.bg, SURFACE_BACKGROUND);
}

/** Herdr wire colors are tagged ratatui colors, not ARGB. */
export function surfaceColor(value: number, fallback: string): string {
  const tag = value >>> 24;
  const index = value & 255;
  if (tag === 2) return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  if (tag === 0) return index === 0 ? fallback : (ANSI[index - 1] ?? fallback);
  if (tag !== 1) return fallback;
  if (index < ANSI.length) return ANSI[index];
  if (index >= 232) {
    const gray = (8 + (index - 232) * 10).toString(16).padStart(2, '0');
    return `#${gray.repeat(3)}`;
  }
  const cube = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return `#${[Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map(i => levels[i].toString(16).padStart(2, '0')).join('')}`;
}
/** UniFFI structured errors keep the actionable reason outside Error.message. */
export function surfaceErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'inner' in error) {
    const inner = error.inner;
    if (
      inner &&
      typeof inner === 'object' &&
      'reason' in inner &&
      typeof inner.reason === 'string'
    )
      return inner.reason;
  }
  return error instanceof Error ? error.message : String(error);
}
