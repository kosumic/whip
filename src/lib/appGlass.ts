export const APP_GLASS_FLOATING_CONTROL_CLASS =
  'bg-card/60 active:bg-card/70';

export const APP_GLASS_BORDER_CLASS_NAME =
  'border border-white/30 dark:border-white/10';

export function shouldEnableAppGlass(
  preferenceEnabled: boolean,
  backgroundImageUri: string | null,
): boolean {
  return preferenceEnabled && Boolean(backgroundImageUri);
}

export function appGlassBackgroundClassName(enabled: boolean): 'bg-transparent' | 'bg-background' {
  return enabled ? 'bg-transparent' : 'bg-background';
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
