import {
  BillingAccessReason,
  BillingCapability,
  BillingChannel,
  BillingCustomerStatus,
  BillingMembership,
  BillingPurchaseMethod,
  BillingTier,
  billingRolloutPolicy as nativeBillingRolloutPolicy,
  evaluateBillingPolicy,
} from 'react-native-whip-ssh';

import type { WhipCapability } from './capabilities';
import type { DistributionChannel } from './distribution';
import type { RevenueCatCustomerInfoLike } from './revenueCatEntitlements';
import type { DeveloperMembershipState, WhipTier } from './tiers';

export type CustomerStatus = 'loading' | 'ready' | 'unavailable';

const CHANNELS: Record<DistributionChannel, BillingChannel> = {
  'app-store': BillingChannel.AppStore,
  'google-play': BillingChannel.GooglePlay,
  github: BillingChannel.Github,
};
const MEMBERSHIPS: Record<DeveloperMembershipState, BillingMembership> = {
  cowboy: BillingMembership.Cowboy,
  'free-trial': BillingMembership.FreeTrial,
  rancher: BillingMembership.Rancher,
};
const CUSTOMER_STATUSES: Record<CustomerStatus, BillingCustomerStatus> = {
  loading: BillingCustomerStatus.Loading,
  ready: BillingCustomerStatus.Ready,
  unavailable: BillingCustomerStatus.Unavailable,
};
const TIERS: Record<BillingTier, WhipTier> = {
  [BillingTier.Cowboy]: 'cowboy',
  [BillingTier.Rancher]: 'rancher',
};
const CAPABILITIES: Record<BillingCapability, WhipCapability> = {
  [BillingCapability.FullscreenApp]: 'fullscreen-app',
  [BillingCapability.FullscreenTerminal]: 'fullscreen-terminal',
  [BillingCapability.CustomAppBackground]: 'custom-app-background',
  [BillingCapability.CustomTerminalBackground]: 'custom-terminal-background',
  [BillingCapability.Glass]: 'glass',
};
const PURCHASE_METHODS = {
  [BillingPurchaseMethod.Unavailable]: 'unavailable',
  [BillingPurchaseMethod.NativeStore]: 'native-store',
  [BillingPurchaseMethod.WebCheckout]: 'web-checkout',
} as const;

export interface BillingPolicyRequest {
  channel: DistributionChannel | null;
  developerOptionsRequested: boolean;
  developerMembershipState: DeveloperMembershipState | null;
  customerStatus: CustomerStatus;
  customerInfo: RevenueCatCustomerInfoLike | null;
  installationTime: Date | null;
  installationTimePending: boolean;
  nowMs: number;
  offeringAvailable: boolean;
  packageAvailable: boolean;
  webCheckoutAvailable: boolean;
}

function timestampMs(value: number): bigint | undefined {
  return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

export function resolveBillingRolloutPolicy(
  channel: DistributionChannel | null,
  developerOptionsRequested: boolean,
) {
  return nativeBillingRolloutPolicy(
    channel === null ? BillingChannel.Unknown : CHANNELS[channel],
    developerOptionsRequested,
  );
}

/** Only translates SDK/platform values and the native projection. */
export function resolveBillingPolicy(request: BillingPolicyRequest) {
  const policy = evaluateBillingPolicy({
    channel: request.channel === null ? BillingChannel.Unknown : CHANNELS[request.channel],
    developerOptionsRequested: request.developerOptionsRequested,
    developerMembership: request.developerMembershipState === null
      ? undefined
      : MEMBERSHIPS[request.developerMembershipState],
    customerStatus: CUSTOMER_STATUSES[request.customerStatus],
    entitlements: Object.entries(request.customerInfo?.entitlements.active ?? {})
      .map(([identifier, value]) => ({ identifier, isActive: value.isActive })),
    installationTimeMs: request.installationTime === null
      ? undefined
      : timestampMs(request.installationTime.getTime()),
    installationTimePending: request.installationTimePending,
    nowMs: timestampMs(request.nowMs) ?? 0n,
    offeringAvailable: request.offeringAvailable,
    packageAvailable: request.packageAvailable,
    webCheckoutAvailable: request.webCheckoutAvailable,
  });
  return {
    tier: TIERS[policy.tier],
    accessReason: policy.accessReason,
    customerStatus: policy.customerStatus,
    hasLifetimeAccess: policy.hasLifetimeAccess,
    capabilities: new Set(policy.capabilities.map(value => CAPABILITIES[value])) as ReadonlySet<WhipCapability>,
    isTrialActive: policy.trial.isActive,
    trialDaysRemaining: policy.trial.daysRemaining,
    trialEndsAt: policy.trial.endsAtMs === undefined
      ? null
      : new Date(Number(policy.trial.endsAtMs)),
    billingEnabled: policy.rollout.billingEnabled,
    isLoading: policy.isLoading,
    purchasesAvailable: policy.purchaseMethod !== BillingPurchaseMethod.Unavailable,
    purchaseMethod: PURCHASE_METHODS[policy.purchaseMethod],
    canRestore: policy.canRestore,
    nextUpdateAtMs: policy.nextUpdateAtMs === undefined ? null : Number(policy.nextUpdateAtMs),
  };
}

export type BillingPolicy = ReturnType<typeof resolveBillingPolicy>;
export { BillingAccessReason };
