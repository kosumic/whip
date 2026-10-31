import {
  appGlassModalPresentation,
  shouldEnableAppGlass,
} from '../src/lib/appGlass';

describe('app glass', () => {
  test('requires both the preference and an app background image', () => {
    expect(shouldEnableAppGlass(true, 'file:///wallpaper.jpg')).toBe(true);
    expect(shouldEnableAppGlass(false, 'file:///wallpaper.jpg')).toBe(false);
    expect(shouldEnableAppGlass(true, null)).toBe(false);
    expect(shouldEnableAppGlass(false, null)).toBe(false);
  });

  test('uses an overlay presentation for glass modals on iOS', () => {
    expect(appGlassModalPresentation(true, 'ios')).toEqual({
      transparent: true,
      presentationStyle: 'overFullScreen',
    });
    expect(appGlassModalPresentation(true, 'android')).toEqual({ transparent: true });
    expect(appGlassModalPresentation(false, 'ios')).toEqual({ transparent: false });
  });
});
