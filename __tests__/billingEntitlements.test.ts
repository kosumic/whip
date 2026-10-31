import { effectiveDevicePreferences } from '../src/billing/effectiveSettings';
import { revenueCatPublicSdkKey } from '../src/billing/revenueCatConfiguration';
import type { DevicePreferences } from '../src/services/devicePreferences';

describe('billing presentation adapters', () => {
  test('derives effective cosmetics without mutating stored preferences', () => {
    const stored: DevicePreferences = {
      alertsEnabled: true,
      agentAlertLevel: 'regular',
      persistentAlertDurationSeconds: 30,
      ttsEnabled: false,
      biometricForKeys: false,
      biometricOnResume: false,
      appearance: 'system',
      appFontSizePercent: 100,
      fullscreenApp: true,
      appBackgroundImageUri: 'file:///app.jpg',
      appBackgroundDimming: 35,
      appGlassEnabled: true,
      developerOptionsEnabled: false,
      developerMembershipState: 'cowboy',
      language: 'system',
      keepScreenOn: false,
      reopenTerminalOnLaunch: false,
      agentCommand: 'opencode',
      reverseControlInstructions: '',
      lastTab: 'hosts',
      terminal: {
        fullscreen: true,
        useModifierKeyIcons: false,
        volumeUpAction: 'none',
        volumeDownAction: 'none',
        fontSize: 8,
        scrollback: 5_000,
        xtermCacheCapacity: 8,
        cursorBlink: true,
        doubleTapAction: 'tab',
        pauseResizeInBackground: true,
        visualHints: false,
        backgroundImageUri: 'file:///terminal.jpg',
        backgroundDimming: 45,
      },
      terminalControlUsage: {},
    };
    const before = structuredClone(stored);

    const cowboy = effectiveDevicePreferences(stored, new Set());
    expect(cowboy.fullscreenApp).toBe(false);
    expect(cowboy.terminal.fullscreen).toBe(false);
    expect(cowboy.appBackgroundImageUri).toBeNull();
    expect(cowboy.appGlassEnabled).toBe(false);
    expect(cowboy.terminal.backgroundImageUri).toBeNull();
    expect(stored).toEqual(before);

    const rancher = effectiveDevicePreferences(stored, new Set(['fullscreen-app', 'fullscreen-terminal', 'custom-app-background', 'custom-terminal-background', 'glass']));
    expect(rancher).toBe(stored);
    expect(rancher.fullscreenApp).toBe(true);
    expect(rancher.terminal.fullscreen).toBe(true);
    expect(rancher.appBackgroundImageUri).toBe('file:///app.jpg');
    expect(rancher.appGlassEnabled).toBe(true);
    expect(rancher.terminal.backgroundImageUri).toBe('file:///terminal.jpg');
  });

  test('missing RevenueCat configuration safely has no SDK key', () => {
    expect(revenueCatPublicSdkKey({}, 'android', false)).toBeNull();
    expect(revenueCatPublicSdkKey(undefined, 'ios', false)).toBeNull();
    expect(revenueCatPublicSdkKey(
      { revenueCatTestPublicSdkKey: 'test_public' },
      'android',
      false,
    )).toBeNull();
  });
});
