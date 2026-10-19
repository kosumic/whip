export const APP_GLASS_FLOATING_CONTROL_CLASS =
  'bg-card/60 active:bg-card/70';

export const APP_GLASS_BORDER_CLASS_NAME =
  'border border-white/30 dark:border-white/10';

export const APP_FROSTED_GLASS_SURFACE_PROPS = {
  effect: 'blur',
  intensity: 8,
} as const;

export const COMPOSER_GLASS_SURFACE_PROPS = {
  ...APP_FROSTED_GLASS_SURFACE_PROPS,
  // Blur adds a native tint already; keep the extra overlay barely visible.
  tintOpacity: 0.08,
} as const;

export function shouldEnableAppGlass(
  preferenceEnabled: boolean,
  backgroundImageUri: string | null,
): boolean {
  return preferenceEnabled && Boolean(backgroundImageUri);
}

type GlassBackgroundClassName = 'bg-background' | 'bg-card' | 'bg-terminal-canvas' | 'bg-terminal-panel';

export function appGlassBackgroundClassName(
  enabled: boolean,
  fallback: GlassBackgroundClassName = 'bg-background',
): 'bg-transparent' | GlassBackgroundClassName {
  return enabled ? 'bg-transparent' : fallback;
}

export function appGlassModalPresentation(
  enabled: boolean,
  platform: string,
): { transparent: boolean; presentationStyle?: 'overFullScreen' } {
  if (!enabled) return { transparent: false };
  return platform === 'ios'
    ? { transparent: true, presentationStyle: 'overFullScreen' }
    : { transparent: true };
}
