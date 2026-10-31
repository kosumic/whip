export const RANCHER_ENTITLEMENT_IDENTIFIER = 'whip_rancher';

interface RevenueCatEntitlementLike {
  isActive: boolean;
}

export interface RevenueCatCustomerInfoLike {
  entitlements: {
    active: Readonly<Record<string, RevenueCatEntitlementLike>>;
  };
}
