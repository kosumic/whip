jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null },
}));

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
