jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null },
}));

import { billingRolloutPolicy } from '../src/billing/rollout';
import { billingDistributionFromExtra } from '../src/billing/distribution';

describe('billing distribution', () => {
  test('requires an explicit recognized channel', () => {
    expect(billingDistributionFromExtra(undefined)).toEqual({
      channel: null,
      rancherWebPurchaseUrl: null,
    });
    expect(billingDistributionFromExtra({ distributionChannel: 'android' }))
      .toEqual({ channel: null, rancherWebPurchaseUrl: null });
  });

  test('keeps GitHub separate from Google Play and validates checkout URLs', () => {
    expect(billingDistributionFromExtra({
      distributionChannel: 'github',
      rancherWebPurchaseUrl: 'https://pay.example.test/rancher',
    })).toEqual({
      channel: 'github',
      rancherWebPurchaseUrl: 'https://pay.example.test/rancher',
    });
    expect(billingDistributionFromExtra({
      distributionChannel: 'google-play',
      rancherWebPurchaseUrl: 'http://insecure.example.test/rancher',
    })).toEqual({
      channel: 'google-play',
      rancherWebPurchaseUrl: null,
    });
  });
});

describe.each(['app-store', 'google-play'] as const)('%s membership rollout', channel => {
  test.each([false, true])('uses live billing even with saved developer options %s', requested => {
    expect(billingRolloutPolicy(channel, requested)).toEqual({
      billingEnabled: true,
      developerOptionsAvailable: false,
      developerOptionsEnabled: false,
    });
  });

});

describe('development membership rollout', () => {
  test.each([null, 'github'] as const)(
    'preserves the developer preview on %s builds', channel => {
      expect(billingRolloutPolicy(channel, false)).toEqual({
        billingEnabled: false,
        developerOptionsAvailable: true,
        developerOptionsEnabled: false,
      });
      expect(billingRolloutPolicy(channel, true)).toEqual({
        billingEnabled: true,
        developerOptionsAvailable: true,
        developerOptionsEnabled: true,
      });
    },
  );
});
