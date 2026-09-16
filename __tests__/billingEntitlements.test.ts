import { hasCapability } from '../src/billing/capabilities';
import { effectiveDevicePreferences } from '../src/billing/effectiveSettings';
import { simulateDeveloperMembership } from '../src/billing/developerMembership';
import { revenueCatPublicSdkKey } from '../src/billing/revenueCatConfiguration';
import { resolveWhipEntitlements } from '../src/billing/revenueCatEntitlements';
import {
  RANCHER_TRIAL_DURATION_MS,
  RANCHER_TRIAL_ELIGIBILITY_START_MS,
  resolveRancherTrial,
} from '../src/billing/rancherTrial';
import { resolveAccessTier } from '../src/billing/tiers';
import type { WhipEntitlementsController } from '../src/billing/useWhipEntitlements';
import type { DevicePreferences } from '../src/services/devicePreferences';

describe('Whip billing entitlements', () => {
  test('resolves missing and inactive Rancher entitlements to Cowboy', () => {
    expect(resolveWhipEntitlements(null)).toEqual({
      tier: 'cowboy',
    });
    expect(resolveWhipEntitlements({
      entitlements: {
        active: {},
      },
    }).tier).toBe('cowboy');
  });

  test('resolves only the active whip_rancher entitlement as Rancher', () => {
    expect(resolveWhipEntitlements({
      entitlements: {
        active: {
          whip_rancher: {
            isActive: true,
          },
        },
      },
    })).toEqual({
      tier: 'rancher',
    });

    expect(resolveWhipEntitlements({
      entitlements: {
        active: {
          rancher: {
            isActive: true,
          },
        },
      },
    })).toEqual({ tier: 'cowboy' });
  });

  test.each([
    'custom-app-background',
    'custom-terminal-background',
    'glass',
  ] as const)('%s is cosmetic Rancher capability', capability => {
    expect(hasCapability('cowboy', capability)).toBe(false);
    expect(hasCapability('rancher', capability)).toBe(true);
  });

  test('grants new installations exactly five days of Rancher access', () => {
    const installedAtMs = RANCHER_TRIAL_ELIGIBILITY_START_MS + 1_000;
    const installedAt = new Date(installedAtMs);

    expect(resolveRancherTrial(installedAt, installedAt)).toEqual({
      isActive: true,
      startedAt: installedAt,
      endsAt: new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS),
      daysRemaining: 5,
    });
    expect(resolveRancherTrial(
      installedAt,
      new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS - 1),
    ).daysRemaining).toBe(1);
    expect(resolveRancherTrial(
      installedAt,
      new Date(installedAtMs + RANCHER_TRIAL_DURATION_MS),
    ).isActive).toBe(false);
  });

  test('does not enroll existing or future-dated installations', () => {
    const now = new Date(RANCHER_TRIAL_ELIGIBILITY_START_MS + 10_000);
    expect(resolveRancherTrial(
      new Date(RANCHER_TRIAL_ELIGIBILITY_START_MS - 1),
      now,
    ).isActive).toBe(false);
    expect(resolveRancherTrial(new Date(now.getTime() + 1), now).isActive)
      .toBe(false);
  });

  test('resolves access from each developer membership state', () => {
    expect(resolveAccessTier(null)).toBe('rancher');
    expect(resolveAccessTier('cowboy')).toBe('cowboy');
    expect(resolveAccessTier('free-trial')).toBe('rancher');
    expect(resolveAccessTier('rancher')).toBe('rancher');
  });

  test('simulates Cowboy, free-trial, and Rancher without replacing purchase operations', () => {
    const purchaseRancher = jest.fn<Promise<'purchased'>, []>(
      async () => 'purchased',
    );
    const liveController: WhipEntitlementsController = {
      tier: 'cowboy',
      hasCapability: capability => hasCapability('cowboy', capability),
      isLoading: false,
      rancherPackage: null,
      localizedLifetimePrice: '$29.99',
      distributionChannel: 'google-play',
      hasLifetimeAccess: false,
      isTrialActive: false,
      trialDaysRemaining: 0,
      trialEndsAt: null,
      purchasesAvailable: true,
      canRestore: true,
      purchaseRancher,
      presentRancherPaywall: jest.fn(async () => 'cancelled'),
      restorePurchases: jest.fn(async () => undefined),
      refresh: jest.fn(async () => undefined),
    };
    const nowMs = Date.parse('2026-08-30T12:00:00.000Z');

    const cowboy = simulateDeveloperMembership(
      liveController,
      'cowboy',
      nowMs,
    );
    expect(cowboy).toMatchObject({
      tier: 'cowboy',
      hasLifetimeAccess: false,
      isTrialActive: false,
      trialDaysRemaining: 0,
      trialEndsAt: null,
    });

    const trial = simulateDeveloperMembership(
      liveController,
      'free-trial',
      nowMs,
    );
    expect(trial).toMatchObject({
      tier: 'rancher',
      hasLifetimeAccess: false,
      isTrialActive: true,
      trialDaysRemaining: 5,
      trialEndsAt: new Date(nowMs + RANCHER_TRIAL_DURATION_MS),
    });
    expect(trial.hasCapability('glass')).toBe(true);

    const rancher = simulateDeveloperMembership(
      liveController,
      'rancher',
      nowMs,
    );
    expect(rancher).toMatchObject({
      tier: 'rancher',
      hasLifetimeAccess: true,
      isTrialActive: false,
    });
    expect(rancher.purchaseRancher).toBe(purchaseRancher);
  });

  test('derives effective cosmetics without mutating stored preferences', () => {
    const stored: DevicePreferences = {
      alertsEnabled: true,
      agentAlertLevel: 'regular',
      persistentAlertDurationSeconds: 30,
      ttsEnabled: false,
      biometricForKeys: false,
      biometricOnResume: false,
      appearance: 'system',
      fullscreenApp: false,
      appBackgroundImageUri: 'file:///app.jpg',
      appBackgroundDimming: 35,
      appGlassEnabled: true,
      developerOptionsEnabled: false,
      developerMembershipState: 'cowboy',
      language: 'system',
      keepScreenOn: false,
      reopenTerminalOnLaunch: false,
      agentCommand: 'opencode',
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
        openLinksInApp: true,
        pauseResizeInBackground: true,
        visualHints: false,
        backgroundImageUri: 'file:///terminal.jpg',
        backgroundDimming: 45,
      },
      terminalControlUsage: {},
    };
    const before = structuredClone(stored);

    const cowboy = effectiveDevicePreferences(stored, 'cowboy');
    expect(cowboy.appBackgroundImageUri).toBeNull();
    expect(cowboy.appGlassEnabled).toBe(false);
    expect(cowboy.terminal.backgroundImageUri).toBeNull();
    expect(stored).toEqual(before);

    const rancher = effectiveDevicePreferences(stored, 'rancher');
    expect(rancher).toBe(stored);
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
