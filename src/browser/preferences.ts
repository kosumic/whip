import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  BROWSER_SEARCH_ENGINES,
  DEFAULT_BROWSER_SEARCH_ENGINE,
  type BrowserSearchEngine,
} from './search';

export type BrowserUserAgent = 'mobile' | 'desktop' | 'custom';
export interface BrowserViewport {
  width: number;
  height: number;
}
export interface BrowserPreferences {
  searchEngine: BrowserSearchEngine;
  userAgent: BrowserUserAgent;
  customUserAgent: string;
  viewport: BrowserViewport | null;
  idleMinutes: number;
}
export const BROWSER_IDLE_MINUTES = {
  minimum: 1,
  maximum: 240,
  default: 15,
} as const;
export const BROWSER_VIEWPORT_LIMITS = { minimum: 200, maximum: 4096 } as const;
export const BROWSER_VIEWPORT_BREAKPOINT = 768;
const MOBILE_PROFILE_LABEL =
  Platform.OS === 'ios' ? 'Mobile WebKit' : 'Mobile Chrome';
const DESKTOP_PROFILE_LABEL =
  Platform.OS === 'ios' ? 'Desktop WebKit' : 'Desktop Chrome';
export const BROWSER_USER_AGENT_PROFILES = [
  { value: 'mobile', label: MOBILE_PROFILE_LABEL },
  { value: 'desktop', label: DESKTOP_PROFILE_LABEL },
  { value: 'custom', label: 'Custom' },
] as const;
export const BROWSER_VIEWPORT_PRESETS = [
  { label: 'Phone', width: 412, height: 915 },
  { label: 'Phone Pro', width: 430, height: 932 },
  { label: 'Tablet', width: 820, height: 1180 },
  { label: 'Laptop', width: 1280, height: 800 },
  { label: 'Desktop', width: 1440, height: 900 },
  { label: 'Full HD', width: 1920, height: 1080 },
] as const;
export function browserViewportWarning(
  profile: BrowserUserAgent,
  width: number,
): string | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  if (profile === 'desktop' && width < BROWSER_VIEWPORT_BREAKPOINT)
    return `This viewport is narrower than 768 px with a Desktop user agent. Sites may use an awkward mobile layout. Consider ${MOBILE_PROFILE_LABEL}.`;
  if (profile !== 'desktop' && width >= BROWSER_VIEWPORT_BREAKPOINT)
    return `This viewport is at least 768 px with a Mobile or Custom user agent. Sites may use an awkward desktop layout. Consider ${DESKTOP_PROFILE_LABEL}.`;
  return null;
}
export function clampBrowserIdleMinutes(minutes: number): number {
  return Number.isFinite(minutes)
    ? Math.max(
        BROWSER_IDLE_MINUTES.minimum,
        Math.min(BROWSER_IDLE_MINUTES.maximum, Math.trunc(minutes)),
      )
    : BROWSER_IDLE_MINUTES.default;
}
export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  searchEngine: DEFAULT_BROWSER_SEARCH_ENGINE,
  userAgent: 'mobile',
  customUserAgent: '',
  viewport: null,
  idleMinutes: BROWSER_IDLE_MINUTES.default,
};
const STORAGE_KEY = 'whip.browser.preferences.v2';
const LEGACY_STORAGE_KEY = 'whip.browser.user-agent.v1';
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
export function browserUserAgent(
  settings: BrowserPreferences,
  nativeAgent?: string,
): string | undefined {
  if (settings.userAgent === 'custom')
    return settings.customUserAgent || undefined;
  // WKWebView's agent has no Chrome version. Preserve its installed WebKit
  // engine and use a Mac platform for desktop mode instead of spoofing Chrome.
  if (nativeAgent?.includes('AppleWebKit/') && !nativeAgent.includes('Chrome/'))
    return settings.userAgent === 'mobile'
      ? nativeAgent
      : nativeAgent
          .replace(
            /\((?:iPhone|iPad|iPod)[^)]*\)/,
            '(Macintosh; Intel Mac OS X 10_15_7)',
          )
          .replace(/ Mobile\/\S+/g, '');
  if (!nativeAgent && Platform.OS === 'ios') return undefined;
  if (settings.userAgent === 'mobile')
    return (
      nativeAgent?.replace('; wv', '').replace('Version/4.0 ', '') ||
      MOBILE_USER_AGENT
    );
  const chrome = nativeAgent?.match(/Chrome\/[\d.]+/)?.[0];
  return chrome
    ? DESKTOP_USER_AGENT.replace(/Chrome\/[\d.]+/, chrome)
    : DESKTOP_USER_AGENT;
}
export function validBrowserViewport(value: BrowserViewport | null): boolean {
  return (
    value === null ||
    [value.width, value.height].every(
      size =>
        Number.isInteger(size) &&
        size >= BROWSER_VIEWPORT_LIMITS.minimum &&
        size <= BROWSER_VIEWPORT_LIMITS.maximum,
    )
  );
}
function validate(value: BrowserPreferences) {
  if (
    !BROWSER_SEARCH_ENGINES.some(engine => engine.id === value.searchEngine) ||
    !['mobile', 'desktop', 'custom'].includes(value.userAgent) ||
    typeof value.customUserAgent !== 'string' ||
    value.customUserAgent.length > 512 ||
    /[^\x20-\x7e]/.test(value.customUserAgent) ||
    !validBrowserViewport(value.viewport) ||
    !Number.isInteger(value.idleMinutes) ||
    value.idleMinutes < BROWSER_IDLE_MINUTES.minimum ||
    value.idleMinutes > BROWSER_IDLE_MINUTES.maximum
  )
    throw new Error('Invalid browser settings');
}
let settings = DEFAULT_BROWSER_PREFERENCES;
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
export const browserPreferences = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => settings,
  async load() {
    const before = revision;
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    let loaded: BrowserPreferences;
    try {
      loaded = stored
        ? {
            ...DEFAULT_BROWSER_PREFERENCES,
            ...(JSON.parse(stored) as Partial<BrowserPreferences>),
          }
        : {
            ...DEFAULT_BROWSER_PREFERENCES,
            userAgent:
              (await AsyncStorage.getItem(LEGACY_STORAGE_KEY)) === 'desktop'
                ? 'desktop'
                : 'mobile',
          };
      // Migrate the earlier Never option into the reference's supported range.
      if (loaded.idleMinutes === 0)
        loaded.idleMinutes = BROWSER_IDLE_MINUTES.minimum;
      validate(loaded);
    } catch {
      return;
    }
    if (revision !== before) return;
    settings = loaded;
    changed();
  },
  async set(update: Partial<BrowserPreferences> | BrowserUserAgent) {
    const next = {
      ...settings,
      ...(typeof update === 'string' ? { userAgent: update } : update),
    };
    validate(next);
    revision++;
    settings = next;
    changed();
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  },
};
