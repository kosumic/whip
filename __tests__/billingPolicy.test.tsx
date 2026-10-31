jest.mock('../packages/react-native-whip-ssh/src/generated/whip_ssh-ffi', () => ({
  __esModule: true,
  default: () => ({}),
}));
jest.mock('react-native-whip-ssh', () => ({
  ...jest.requireActual('../packages/react-native-whip-ssh/src/generated/whip_ssh'),
  evaluateBillingPolicy: jest.fn(),
  billingRolloutPolicy: jest.fn(),
}));
jest.mock('expo-application', () => ({ getInstallationTimeAsync: jest.fn() }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
  Linking: { openURL: jest.fn() },
}));
jest.mock('../src/billing/distribution', () => ({ getBillingDistribution: jest.fn() }));
jest.mock('../src/billing/rancherPurchases', () => ({
  addRevenueCatCustomerInfoListener: jest.fn(),
  loadRancherOffering: jest.fn(),
  loadRevenueCatCustomerInfo: jest.fn(),
  paywallResultRequiresRefresh: jest.fn(),
  presentRancherPaywall: jest.fn(),
  purchaseRancherPackage: jest.fn(),
  restoreRevenueCatPurchases: jest.fn(),
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: (promise: Promise<unknown>) => { void promise; },
}));

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { getInstallationTimeAsync } from 'expo-application';
import { AppState, Linking } from 'react-native';
import type { CustomerInfo, PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import {
  BillingAccessReason,
  BillingCapability,
  BillingChannel,
  BillingCustomerStatus,
  BillingMembership,
  BillingPurchaseMethod,
  BillingTier,
  billingRolloutPolicy,
  evaluateBillingPolicy,
  type BillingPolicyProjection,
} from 'react-native-whip-ssh';
import { getBillingDistribution } from '../src/billing/distribution';
import { resolveBillingPolicy, resolveBillingRolloutPolicy } from '../src/billing/policy';
import * as purchases from '../src/billing/rancherPurchases';
import { useWhipEntitlements, type WhipEntitlementsController } from '../src/billing/useWhipEntitlements';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const emptyCustomer = { entitlements: { active: {} } } as CustomerInfo;
const paidCustomer = {
  entitlements: { active: { whip_rancher: { isActive: true } } },
} as unknown as CustomerInfo;
const rancherPackage = { product: { priceString: '$29.99' } } as PurchasesPackage;
const offering = { identifier: 'default' } as PurchasesOffering;

function nativeProjection(overrides: Partial<BillingPolicyProjection> = {}): BillingPolicyProjection {
  return {
    tier: BillingTier.Cowboy,
    accessReason: BillingAccessReason.NoEntitlement,
    customerStatus: BillingCustomerStatus.Ready,
    hasLifetimeAccess: false,
    trial: { isActive: false, startedAtMs: undefined, endsAtMs: undefined, daysRemaining: 0 },
    capabilities: [],
    rollout: { billingEnabled: true, developerOptionsAvailable: false, developerOptionsEnabled: false },
    isLoading: false,
    purchaseMethod: BillingPurchaseMethod.NativeStore,
    canRestore: true,
    nextUpdateAtMs: undefined,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | undefined;
let controller: WhipEntitlementsController;
function Harness({ loaded = true }: { loaded?: boolean }) {
  controller = useWhipEntitlements(loaded);
  return null;
}
async function mount() {
  await act(async () => { renderer = create(<Harness />); });
}
function lastInput() {
  return jest.mocked(evaluateBillingPolicy).mock.calls.at(-1)![0];
}
function customerListener() {
  return jest.mocked(purchases.addRevenueCatCustomerInfoListener).mock.calls.at(-1)![0];
}
function resume() {
  const listener = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1];
  listener('active');
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection());
  jest.mocked(getBillingDistribution).mockReturnValue({ channel: 'google-play', rancherWebPurchaseUrl: null });
  jest.mocked(getInstallationTimeAsync).mockResolvedValue(new Date(NOW));
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockResolvedValue(emptyCustomer);
  jest.mocked(purchases.loadRancherOffering).mockResolvedValue({ offering, rancherPackage });
  jest.mocked(purchases.addRevenueCatCustomerInfoListener).mockResolvedValue(jest.fn());
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  jest.useRealTimers();
});

test('translates typed SDK inputs and uses the native projection without inferring capabilities from tier', () => {
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection({
    tier: BillingTier.Rancher,
    capabilities: [BillingCapability.Glass],
    trial: { isActive: true, startedAtMs: BigInt(NOW), endsAtMs: BigInt(NOW + 1234), daysRemaining: 3 },
    nextUpdateAtMs: BigInt(NOW + 123),
  }));
  const result = resolveBillingPolicy({
    channel: 'github', developerOptionsRequested: true, developerMembershipState: 'free-trial',
    customerStatus: 'unavailable', customerInfo: paidCustomer,
    installationTime: new Date(NOW), installationTimePending: false, nowMs: NOW,
    offeringAvailable: false, packageAvailable: false, webCheckoutAvailable: true,
  });
  expect(lastInput()).toEqual({
    channel: BillingChannel.Github, developerOptionsRequested: true, developerMembership: BillingMembership.FreeTrial,
    customerStatus: BillingCustomerStatus.Unavailable,
    entitlements: [{ identifier: 'whip_rancher', isActive: true }],
    installationTimeMs: BigInt(NOW), installationTimePending: false, nowMs: BigInt(NOW),
    offeringAvailable: false, packageAvailable: false, webCheckoutAvailable: true,
  });
  expect(result.capabilities).toEqual(new Set(['glass']));
  expect(result.trialEndsAt).toEqual(new Date(NOW + 1234));
  expect(result.trialDaysRemaining).toBe(3);
  expect(result.nextUpdateAtMs).toBe(NOW + 123);
});

test('passes unknown distribution, missing/invalid install dates and SDK status explicitly', () => {
  for (const installationTime of [null, new Date(Number.NaN)]) {
    resolveBillingPolicy({
      channel: null, developerOptionsRequested: false, developerMembershipState: null,
      customerStatus: 'loading', customerInfo: null, installationTime,
      installationTimePending: true, nowMs: NOW,
      offeringAvailable: false, packageAvailable: false, webCheckoutAvailable: false,
    });
    expect(lastInput()).toMatchObject({
      channel: BillingChannel.Unknown, customerStatus: BillingCustomerStatus.Loading,
      developerMembership: undefined, installationTimeMs: undefined, entitlements: [],
    });
  }
});

test('rollout adapter returns the native build policy unchanged', () => {
  const projection = { billingEnabled: false, developerOptionsAvailable: true, developerOptionsEnabled: false };
  jest.mocked(billingRolloutPolicy).mockReturnValue(projection);
  expect(resolveBillingRolloutPolicy(null, false)).toBe(projection);
  expect(billingRolloutPolicy).toHaveBeenCalledWith(BillingChannel.Unknown, false);
});

test('publishes customer info before offering loading completes and preserves localized pricing', async () => {
  const pending = deferred<{ offering: PurchasesOffering; rancherPackage: PurchasesPackage }>();
  jest.mocked(purchases.loadRancherOffering).mockReturnValue(pending.promise);
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockResolvedValue(paidCustomer);
  await mount();
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
  expect(lastInput().customerStatus).toBe(BillingCustomerStatus.Ready);
  await act(async () => { pending.resolve({ offering, rancherPackage }); });
  expect(controller.localizedLifetimePrice).toBe('$29.99');
});

test('a customer-info event fences an older pending refresh', async () => {
  const pending = deferred<CustomerInfo>();
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockReturnValue(pending.promise);
  await mount();
  await act(async () => { customerListener()(paidCustomer); });
  await act(async () => { pending.resolve(emptyCustomer); });
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
  expect(controller.localizedLifetimePrice).toBe('$29.99');
});

test('overlapping refreshes cannot publish their results in reverse order', async () => {
  await mount();
  const older = deferred<CustomerInfo>();
  const newer = deferred<CustomerInfo>();
  jest.mocked(purchases.loadRevenueCatCustomerInfo)
    .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => { first = controller.refresh(); second = controller.refresh(); });
  await act(async () => { newer.resolve(paidCustomer); await second; });
  await act(async () => { older.resolve(emptyCustomer); await first; });
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
});

test('failed installation-time reads reach Rust as unavailable and stop loading', async () => {
  jest.mocked(getInstallationTimeAsync).mockRejectedValue(new Error('unsupported'));
  await mount();
  expect(lastInput()).toMatchObject({ installationTimeMs: undefined, installationTimePending: false });
});

test('listener registration completing after unmount releases the platform listener', async () => {
  const registration = deferred<() => void>();
  jest.mocked(purchases.addRevenueCatCustomerInfoListener).mockReturnValue(registration.promise);
  await mount();
  await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  const remove = jest.fn();
  await act(async () => { registration.resolve(remove); });
  expect(remove).toHaveBeenCalledTimes(1);
});

test.each(['purchase', 'restore'] as const)('%s results fence delayed pre-action refreshes', async action => {
  await mount();
  const pending = deferred<CustomerInfo>();
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockReturnValue(pending.promise);
  let refresh!: Promise<void>;
  await act(async () => { refresh = controller.refresh(); });
  jest.mocked(purchases.purchaseRancherPackage).mockResolvedValue({ status: 'purchased', customerInfo: paidCustomer });
  jest.mocked(purchases.restoreRevenueCatPurchases).mockResolvedValue(paidCustomer);
  await act(async () => {
    if (action === 'purchase') await controller.purchaseRancher();
    else await controller.restorePurchases();
  });
  await act(async () => { pending.resolve(emptyCustomer); await refresh; });
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
});

test('a purchase completion supersedes a refresh started while the purchase was pending', async () => {
  await mount();
  const pending = deferred<purchases.RancherPurchaseResult>();
  jest.mocked(purchases.purchaseRancherPackage).mockReturnValue(pending.promise);
  let purchase!: Promise<unknown>;
  await act(async () => { purchase = controller.purchaseRancher(); });
  await act(async () => { await controller.refresh(); });
  await act(async () => { pending.resolve({ status: 'purchased', customerInfo: paidCustomer }); await purchase; });
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
});

test('a late purchase result cannot override a newer customer-info revocation', async () => {
  await mount();
  const pending = deferred<purchases.RancherPurchaseResult>();
  jest.mocked(purchases.purchaseRancherPackage).mockReturnValue(pending.promise);
  let purchase!: Promise<unknown>;
  await act(async () => { purchase = controller.purchaseRancher(); });
  await act(async () => { customerListener()(emptyCustomer); });
  await act(async () => { pending.resolve({ status: 'purchased', customerInfo: paidCustomer }); await purchase; });
  expect(lastInput().entitlements).toEqual([]);
});

test('cancelled purchases preserve customer data', async () => {
  await mount();
  jest.mocked(purchases.purchaseRancherPackage).mockResolvedValue({ status: 'cancelled' });
  await act(async () => { expect(await controller.purchaseRancher()).toBe('cancelled'); });
  expect(lastInput().entitlements).toEqual([]);
});

test('unavailable SDK state clears stale entitlements without conflating it with confirmed no-access', async () => {
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockResolvedValue(paidCustomer);
  await mount();
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockRejectedValue(new Error('offline'));
  await act(async () => { await controller.refresh(); });
  expect(lastInput().entitlements).toEqual([]);
  expect(lastInput().customerStatus).toBe(BillingCustomerStatus.Unavailable);
});

test('disabled and re-enabled adapters ignore results and listener events from the old lifetime', async () => {
  const pending = deferred<CustomerInfo>();
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockReturnValueOnce(pending.promise);
  await mount();
  const oldListener = customerListener();
  await act(async () => { renderer!.update(<Harness loaded={false} />); });
  await act(async () => { renderer!.update(<Harness />); });
  await act(async () => { pending.resolve(paidCustomer); oldListener(paidCustomer); });
  expect(lastInput().entitlements).toEqual([]);
});

test('paywall success refreshes SDK state and projects the new native policy', async () => {
  await mount();
  jest.mocked(purchases.paywallResultRequiresRefresh).mockReturnValue(true);
  jest.mocked(purchases.loadRevenueCatCustomerInfo).mockResolvedValue(paidCustomer);
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection({ tier: BillingTier.Rancher, hasLifetimeAccess: true }));
  await act(async () => { expect(await controller.presentRancherPaywall()).toBe('purchased'); });
  expect(controller.tier).toBe('rancher');
  expect(controller.hasLifetimeAccess).toBe(true);
  expect(lastInput().entitlements).toEqual([{ identifier: 'whip_rancher', isActive: true }]);
});

test('web checkout uses the native route and retains platform URL handling', async () => {
  jest.mocked(getBillingDistribution).mockReturnValue({ channel: 'github', rancherWebPurchaseUrl: 'https://pay.example.test/' });
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection({ purchaseMethod: BillingPurchaseMethod.WebCheckout }));
  await mount();
  await act(async () => { expect(await controller.purchaseRancher()).toBe('opened-web-checkout'); });
  expect(Linking.openURL).toHaveBeenCalledWith('https://pay.example.test/');
  expect(purchases.purchaseRancherPackage).not.toHaveBeenCalled();
});

test('trial deadlines and resume re-evaluate Rust policy against the current clock', async () => {
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection({ nextUpdateAtMs: BigInt(NOW + 1000) }));
  await mount();
  jest.mocked(evaluateBillingPolicy).mockReturnValue(nativeProjection());
  await act(async () => { jest.advanceTimersByTime(1001); });
  expect(lastInput().nowMs).toBe(BigInt(NOW + 1001));
  jest.setSystemTime(NOW + 5000);
  await act(async () => { resume(); });
  expect(lastInput().nowMs).toBe(BigInt(NOW + 5000));
  expect(getInstallationTimeAsync).toHaveBeenCalledTimes(2);
});
