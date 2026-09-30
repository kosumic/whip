import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  browserPreferences,
  browserUserAgent,
  DEFAULT_BROWSER_PREFERENCES,
  BROWSER_VIEWPORT_PRESETS,
  browserViewportWarning,
  clampBrowserIdleMinutes,
  validBrowserViewport,
} from '../src/browser/preferences';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
});

test('mobile and desktop profiles use the installed browser version and custom UA stays exact', () => {
  const native =
    'Mozilla/5.0 (Linux; Android 16; Pixel; wv) AppleWebKit/537.36 Version/4.0 Chrome/151.0.1.2 Mobile Safari/537.36';
  expect(browserUserAgent(DEFAULT_BROWSER_PREFERENCES, native)).toBe(
    native.replace('; wv', '').replace('Version/4.0 ', ''),
  );
  const desktop = browserUserAgent(
    { ...DEFAULT_BROWSER_PREFERENCES, userAgent: 'desktop' },
    native,
  );
  expect(desktop).toContain('Chrome/151.0.1.2');
  expect(desktop).not.toContain('Mobile');
  expect(
    browserUserAgent(
      {
        ...DEFAULT_BROWSER_PREFERENCES,
        userAgent: 'custom',
        customUserAgent: 'Test Agent',
      },
      native,
    ),
  ).toBe('Test Agent');
});

test.each([
  'iPhone; CPU iPhone OS 26_5 like Mac OS X',
  'iPad; CPU OS 26_5 like Mac OS X',
])('WebKit profiles preserve the installed engine for %s', platform => {
  const native = `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;
  expect(browserUserAgent(DEFAULT_BROWSER_PREFERENCES, native)).toBe(native);
  expect(
    browserUserAgent(
      { ...DEFAULT_BROWSER_PREFERENCES, userAgent: 'desktop' },
      native,
    ),
  ).toBe(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  );
});

test('iOS leaves the native user agent in place while its profile is loading', () => {
  const platform = Platform.OS;
  try {
    Platform.OS = 'ios';
    expect(browserUserAgent(DEFAULT_BROWSER_PREFERENCES)).toBeUndefined();
    expect(
      browserUserAgent({
        ...DEFAULT_BROWSER_PREFERENCES,
        userAgent: 'desktop',
      }),
    ).toBeUndefined();
  } finally {
    Platform.OS = platform;
  }
});

test('viewport, custom user agent and idle settings persist and reject invalid dimensions', async () => {
  await browserPreferences.set({
    userAgent: 'custom',
    customUserAgent: 'Whip test',
    viewport: { width: 1280, height: 720 },
    idleMinutes: 37,
  });
  const saved = browserPreferences.getSnapshot();
  await browserPreferences.load();
  expect(browserPreferences.getSnapshot()).toEqual(saved);
  await expect(
    browserPreferences.set({ viewport: { width: -1, height: 720 } }),
  ).rejects.toThrow('Invalid');
  await expect(
    browserPreferences.set({ customUserAgent: 'invalid\nagent' }),
  ).rejects.toThrow('Invalid');
  expect(browserPreferences.getSnapshot()).toEqual(saved);
});

test('automatic viewport default, named presets and dimension limits', () => {
  expect(DEFAULT_BROWSER_PREFERENCES.viewport).toBeNull();
  expect(
    BROWSER_VIEWPORT_PRESETS.map(preset => [
      preset.label,
      preset.width,
      preset.height,
    ]),
  ).toEqual([
    ['Phone', 412, 915],
    ['Phone Pro', 430, 932],
    ['Tablet', 820, 1180],
    ['Laptop', 1280, 800],
    ['Desktop', 1440, 900],
    ['Full HD', 1920, 1080],
  ]);
  expect(validBrowserViewport({ width: 200, height: 4096 })).toBe(true);
  expect(validBrowserViewport({ width: 199, height: 4096 })).toBe(false);
  expect(validBrowserViewport({ width: 200, height: 4097 })).toBe(false);
});

test('viewport warnings follow draft width and the 768px breakpoint', () => {
  expect(browserViewportWarning('mobile', 767)).toBeNull();
  expect(browserViewportWarning('mobile', 768)).toContain('Desktop Chrome');
  expect(browserViewportWarning('custom', 768)).toContain('Desktop Chrome');
  expect(browserViewportWarning('desktop', 767)).toContain('Mobile Chrome');
  expect(browserViewportWarning('desktop', 768)).toBeNull();
  expect(browserViewportWarning('desktop', 0)).toBeNull();
});

test('idle timeout accepts any integer minute from 1 to 240 and migrates Never', async () => {
  for (const minutes of [1, 37, 240])
    await browserPreferences.set({ idleMinutes: minutes });
  for (const minutes of [0, 241, 1.5])
    await expect(
      browserPreferences.set({ idleMinutes: minutes }),
    ).rejects.toThrow('Invalid');
  expect(clampBrowserIdleMinutes(0)).toBe(1);
  expect(clampBrowserIdleMinutes(999)).toBe(240);
  expect(clampBrowserIdleMinutes(NaN)).toBe(15);
  await AsyncStorage.setItem(
    'whip.browser.preferences.v2',
    JSON.stringify({
      ...DEFAULT_BROWSER_PREFERENCES,
      userAgent: 'desktop',
      idleMinutes: 0,
    }),
  );
  await browserPreferences.load();
  expect(browserPreferences.getSnapshot()).toMatchObject({
    userAgent: 'desktop',
    idleMinutes: 1,
  });
});

test('legacy desktop settings migrate and late hydration cannot replace a user choice', async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem('whip.browser.user-agent.v1', 'desktop');
  await browserPreferences.load();
  expect(browserPreferences.getSnapshot().userAgent).toBe('desktop');
  let finish!: (value: string) => void;
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const loading = browserPreferences.load();
  await browserPreferences.set('mobile');
  finish(
    JSON.stringify({ ...DEFAULT_BROWSER_PREFERENCES, userAgent: 'desktop' }),
  );
  await loading;
  expect(browserPreferences.getSnapshot().userAgent).toBe('mobile');
});

test('search engine persists and old preferences acquire Google without losing other choices', async () => {
  await browserPreferences.set({ searchEngine: 'brave' });
  expect(
    JSON.parse((await AsyncStorage.getItem('whip.browser.preferences.v2'))!)
      .searchEngine,
  ).toBe('brave');
  await browserPreferences.load();
  expect(browserPreferences.getSnapshot().searchEngine).toBe('brave');
  await AsyncStorage.setItem(
    'whip.browser.preferences.v2',
    JSON.stringify({
      userAgent: 'desktop',
      customUserAgent: '',
      viewport: { width: 820, height: 1180 },
      idleMinutes: 37,
    }),
  );
  await browserPreferences.load();
  expect(browserPreferences.getSnapshot()).toMatchObject({
    searchEngine: 'google',
    userAgent: 'desktop',
    viewport: { width: 820, height: 1180 },
    idleMinutes: 37,
  });
  await expect(
    browserPreferences.set({ searchEngine: 'unknown' as never }),
  ).rejects.toThrow('Invalid browser settings');
  expect(browserPreferences.getSnapshot().searchEngine).toBe('google');
});
