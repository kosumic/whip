import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getInstallationTimeAsync } from 'expo-application';
import { AppState, Linking } from 'react-native';
import type {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
} from 'react-native-purchases';

import { reportBackgroundFailure } from '../services/backgroundOperations';
import type { WhipCapability } from './capabilities';
import { getBillingDistribution, type DistributionChannel } from './distribution';
import { resolveBillingPolicy, type BillingPolicy, type CustomerStatus } from './policy';
import {
  addRevenueCatCustomerInfoListener,
  loadRancherOffering,
  loadRevenueCatCustomerInfo,
  paywallResultRequiresRefresh,
  presentRancherPaywall,
  purchaseRancherPackage,
  restoreRevenueCatPurchases,
} from './rancherPurchases';
import type { DeveloperMembershipState } from './tiers';

export type WhipPurchaseActionResult =
  | 'purchased'
  | 'cancelled'
  | 'opened-web-checkout';

export interface WhipEntitlementsController extends BillingPolicy {
  hasCapability: (capability: WhipCapability) => boolean;
  rancherPackage: PurchasesPackage | null;
  localizedLifetimePrice: string | null;
  distributionChannel: DistributionChannel | null;
  purchaseRancher: () => Promise<WhipPurchaseActionResult>;
  presentRancherPaywall: () => Promise<WhipPurchaseActionResult>;
  restorePurchases: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface ControllerState {
  customerInfo: CustomerInfo | null;
  offering: PurchasesOffering | null;
  rancherPackage: PurchasesPackage | null;
  status: CustomerStatus;
  installationTime: Date | null;
  installationTimePending: boolean;
}

interface CustomerAction {
  generation: number;
  eventRevision: number;
  actionRevision: number;
}

const INITIAL_STATE: ControllerState = {
  customerInfo: null,
  offering: null,
  rancherPackage: null,
  status: 'loading',
  installationTime: null,
  installationTimePending: true,
};

export function useWhipEntitlements(
  preferencesLoaded: boolean,
  developerOptionsRequested = false,
  developerMembershipState: DeveloperMembershipState | null = null,
): WhipEntitlementsController {
  const distribution = useMemo(() => getBillingDistribution(), []);
  // These fence SDK/platform reads, not access decisions. A customer-info event
  // or purchase invalidates earlier reads, even within the same mounted hook.
  const generation = useRef(0);
  const customerRevision = useRef(0);
  const customerEventRevision = useRef(0);
  const actionRevision = useRef(0);
  const installationRevision = useRef(0);
  const [state, setState] = useState(INITIAL_STATE);
  const [, updateClock] = useState(0);
  const webPurchaseUrl = state.rancherPackage?.webCheckoutUrl
    ?? state.offering?.webCheckoutUrl
    ?? distribution.rancherWebPurchaseUrl;
  const policy = resolveBillingPolicy({
    channel: distribution.channel,
    developerOptionsRequested,
    developerMembershipState,
    customerStatus: state.status,
    customerInfo: state.customerInfo,
    installationTime: state.installationTime,
    installationTimePending: state.installationTimePending,
    nowMs: Date.now(),
    offeringAvailable: state.offering !== null,
    packageAvailable: state.rancherPackage !== null,
    webCheckoutAvailable: webPurchaseUrl !== null,
  });
  const billingEnabled = preferencesLoaded && policy.billingEnabled;

  const isCurrentCustomerRead = useCallback((owner: number, revision: number) => (
    generation.current === owner && customerRevision.current === revision
  ), []);

  const beginCustomerAction = useCallback((): CustomerAction => {
    ++customerRevision.current;
    return {
      generation: generation.current,
      eventRevision: customerEventRevision.current,
      actionRevision: ++actionRevision.current,
    };
  }, []);
  const completeCustomerAction = useCallback((action: CustomerAction, customerInfo: CustomerInfo) => {
    if (generation.current !== action.generation
      || customerEventRevision.current !== action.eventRevision
      || actionRevision.current !== action.actionRevision) return;
    ++customerRevision.current;
    ++customerEventRevision.current;
    setState(current => ({ ...current, customerInfo, status: 'ready' }));
  }, []);

  const refreshTrial = useCallback(async () => {
    if (!billingEnabled) return;
    const owner = generation.current;
    const revision = ++installationRevision.current;
    let installationTime: Date | null = null;
    try {
      installationTime = await getInstallationTimeAsync();
    } catch {
      // Unavailable install time is passed to Rust without inventing a date.
    }
    if (generation.current === owner && installationRevision.current === revision) {
      setState(current => ({ ...current, installationTime, installationTimePending: false }));
    }
  }, [billingEnabled]);

  const refresh = useCallback(async () => {
    if (!billingEnabled) return;
    const owner = generation.current;
    const revision = ++customerRevision.current;
    let customerInfo: CustomerInfo | null = null;
    try {
      customerInfo = await loadRevenueCatCustomerInfo();
    } catch {
      // A failed SDK read is unavailable, not a confirmed empty entitlement.
    }
    if (generation.current !== owner) return;
    if (isCurrentCustomerRead(owner, revision)) {
      setState(current => ({
        ...current,
        customerInfo,
        status: customerInfo === null ? 'unavailable' : 'ready',
      }));
    }
    // Offering latency must not delay publishing authoritative customer info.
    // Customer-info events also must not cancel independent price loading.
    const offering = await loadRancherOffering();
    if (generation.current !== owner) return;
    setState(current => ({
      ...current,
      offering: offering?.offering ?? current.offering,
      rancherPackage: offering?.rancherPackage ?? current.rancherPackage,
    }));
  }, [billingEnabled, isCurrentCustomerRead]);

  useEffect(() => {
    const owner = ++generation.current;
    setState(billingEnabled ? INITIAL_STATE : {
      ...INITIAL_STATE,
      status: 'unavailable',
      installationTimePending: false,
    });
    let removeListener: (() => void) | null = null;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
    if (billingEnabled) {
      reportBackgroundFailure(refresh(), 'revenuecat-entitlements-load');
      reportBackgroundFailure(refreshTrial(), 'rancher-trial-load');
      reportBackgroundFailure(
        addRevenueCatCustomerInfoListener(customerInfo => {
          if (generation.current !== owner) return;
          ++customerRevision.current;
          ++customerEventRevision.current;
          setState(current => ({ ...current, customerInfo, status: 'ready' }));
        }).then(remove => {
          if (generation.current !== owner) remove?.();
          else removeListener = remove;
        }),
        'revenuecat-customer-info-listener',
      );
      appStateSubscription = AppState.addEventListener('change', next => {
        if (next !== 'active') return;
        updateClock(current => current + 1);
        reportBackgroundFailure(refresh(), 'revenuecat-entitlements-refresh');
        reportBackgroundFailure(refreshTrial(), 'rancher-trial-refresh');
      });
    }
    return () => {
      generation.current = owner + 1;
      removeListener?.();
      appStateSubscription?.remove();
    };
  }, [billingEnabled, refresh, refreshTrial]);

  useEffect(() => {
    if (!billingEnabled || policy.nextUpdateAtMs === null) return;
    const timeout = setTimeout(
      () => updateClock(current => current + 1),
      Math.max(0, policy.nextUpdateAtMs - Date.now()) + 1,
    );
    return () => clearTimeout(timeout);
  }, [billingEnabled, policy.nextUpdateAtMs]);

  const openWebCheckout = useCallback(async () => {
    if (!webPurchaseUrl) throw new Error('Rancher web checkout is unavailable.');
    await Linking.openURL(webPurchaseUrl);
  }, [webPurchaseUrl]);

  const purchaseRancher = useCallback(async (): Promise<WhipPurchaseActionResult> => {
    if (!billingEnabled) throw new Error('Rancher purchases are unavailable in this build.');
    if (policy.purchaseMethod === 'web-checkout') {
      await openWebCheckout();
      return 'opened-web-checkout';
    }
    if (policy.purchaseMethod !== 'native-store' || !state.rancherPackage) {
      throw new Error('Rancher purchases are unavailable in this build.');
    }
    const action = beginCustomerAction();
    const result = await purchaseRancherPackage(state.rancherPackage);
    if (result.status === 'cancelled') return 'cancelled';
    completeCustomerAction(action, result.customerInfo);
    return 'purchased';
  }, [billingEnabled, policy.purchaseMethod, openWebCheckout, state.rancherPackage, beginCustomerAction, completeCustomerAction]);

  const openPaywall = useCallback(async (): Promise<WhipPurchaseActionResult> => {
    if (!billingEnabled) throw new Error('Rancher purchases are unavailable in this build.');
    if (policy.purchaseMethod === 'web-checkout') {
      await openWebCheckout();
      return 'opened-web-checkout';
    }
    if (policy.purchaseMethod !== 'native-store' || !state.offering) {
      throw new Error('Rancher purchases are unavailable in this build.');
    }
    const owner = generation.current;
    const result = await presentRancherPaywall(state.offering);
    if (generation.current !== owner) return 'cancelled';
    if (paywallResultRequiresRefresh(result)) {
      await refresh();
      return 'purchased';
    }
    return 'cancelled';
  }, [billingEnabled, policy.purchaseMethod, openWebCheckout, refresh, state.offering]);

  const restorePurchases = useCallback(async () => {
    if (!billingEnabled || !policy.canRestore) {
      throw new Error('Purchase restoration is unavailable in this build.');
    }
    const action = beginCustomerAction();
    const customerInfo = await restoreRevenueCatPurchases();
    completeCustomerAction(action, customerInfo);
  }, [billingEnabled, policy.canRestore, beginCustomerAction, completeCustomerAction]);

  return {
    ...policy,
    hasCapability: capability => policy.capabilities.has(capability),
    rancherPackage: state.rancherPackage,
    localizedLifetimePrice: state.rancherPackage?.product.priceString ?? null,
    distributionChannel: distribution.channel,
    purchaseRancher,
    presentRancherPaywall: openPaywall,
    restorePurchases,
    refresh,
  };
}
