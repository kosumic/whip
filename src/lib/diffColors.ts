import type { ThemeColors } from '@/src/theme';

type Rgb = [number, number, number];
const MIN_CONTRAST = 4.5;
const DIFF_BACKGROUNDS = {
  dark: { addition: '#213a2b', deletion: '#4a221d' },
  light: { addition: '#dafbe1', deletion: '#ffebe9' },
} as const;

export function diffRowBackground(kind: string, colors: ThemeColors, isDark: boolean, selected = false): string {
  if (selected) return blendDiffColor(colors.primary, colors.canvas, 0.19);
  const palette = isDark ? DIFF_BACKGROUNDS.dark : DIFF_BACKGROUNDS.light;
  return kind === 'addition' ? palette.addition : kind === 'deletion' ? palette.deletion : colors.canvas;
}

function rgb(color: string): Rgb {
  return [1, 3, 5].map(index =>
    Number.parseInt(color.slice(index, index + 2), 16),
  ) as Rgb;
}

function hex(channels: Rgb): string {
  return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function mix(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha),
  ) as Rgb;
}

function luminance(channels: Rgb): number {
  const [red, green, blue] = channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function blendDiffColor(
  foreground: string,
  background: string,
  alpha: number,
): string {
  return hex(mix(rgb(foreground), rgb(background), alpha));
}

/** Resolve syntax colors against the actual opaque diff fill, including selection. */
export function readableDiffColor(
  foreground: string,
  background: string,
): string {
  const original = rgb(foreground);
  const surface = luminance(rgb(background));
  const contrast = (value: Rgb) => {
    const light = luminance(value);
    return (
      (Math.max(light, surface) + 0.05) / (Math.min(light, surface) + 0.05)
    );
  };
  if (contrast(original) >= MIN_CONTRAST) return foreground;
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const target = contrast(white) > contrast(black) ? white : black;
  for (let step = 1; step <= 20; step += 1) {
    const adjusted = hex(mix(target, original, step / 20));
    if (contrast(rgb(adjusted)) >= MIN_CONTRAST) return adjusted;
  }
  return hex(target);
}
