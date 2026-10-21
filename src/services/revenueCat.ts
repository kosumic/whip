import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, {
  type PurchasesError,
  type PurchasesStoreProduct,
} from 'react-native-purchases';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';
import { revenueCatPublicSdkKey } from '../billing/revenueCatConfiguration';
import {
  getBillingDistribution,
  isNativeStoreChannel,
} from '../billing/distribution';

export const TIP_JAR_PRODUCT_ID = 'whip_tip_5';

export const TIP_PRODUCT_IDS = [
  'whip_tip_small',
  'whip_tip_medium',
  'whip_tip_large',
] as const;

export type TipProductId = (typeof TIP_PRODUCT_IDS)[number];

export interface TipProduct<ProductId extends string = TipProductId> {
  id: ProductId;
  localizedPrice: string;
  storeProduct: PurchasesStoreProduct;
}

export type TipJarProduct = TipProduct<typeof TIP_JAR_PRODUCT_ID>;

let initialization: Promise<boolean> | null = null;

function publicSdkKey(): string | null {
  return revenueCatPublicSdkKey(
    Constants.expoConfig?.extra,
    Platform.OS,
    __DEV__,
  );
}

export function initializeRevenueCat(): Promise<boolean> {
  if (initialization) return initialization;

  initialization = Promise.resolve().then(() => {
    const apiKey = publicSdkKey();
    if (!apiKey || (Platform.OS !== 'ios' && Platform.OS !== 'android'))
      return false;

    try {
      Purchases.configure({
        apiKey,
        automaticDeviceIdentifierCollectionEnabled: false,
      });
      return true;
    } catch (error) {
      recordRevenueCatFailure('error', 'revenuecat-initialization-failed', error);
      return false;
    }
  });
  return initialization;
}

export async function getRevenueCatAppUserId(): Promise<string | null> {
  if (!(await initializeRevenueCat())) return null;
  try {
    return await Purchases.getAppUserID();
  } catch (error) {
    recordRevenueCatFailure('warn', 'revenuecat-app-user-id-read-failed', error);
    return null;
  }
}

async function loadSupportProducts<ProductId extends string>(
  productIds: readonly ProductId[],
): Promise<TipProduct<ProductId>[]> {
  if (!(await initializeRevenueCat())) return [];

  let products: PurchasesStoreProduct[];
  try {
    products = await Purchases.getProducts(
      [...productIds],
      Purchases.PRODUCT_CATEGORY.NON_SUBSCRIPTION,
    );
  } catch (error) {
    recordRevenueCatFailure('error', 'revenuecat-products-load-failed', error);
    throw error;
  }
  const byId = new Map(products.map(product => [product.identifier, product]));
  return productIds.flatMap(id => {
    const storeProduct = byId.get(id);
    return storeProduct
      ? [{ id, localizedPrice: storeProduct.priceString, storeProduct }]
      : [];
  });
}

export function loadTipProducts(): Promise<TipProduct[]> {
  return loadSupportProducts(TIP_PRODUCT_IDS);
}

export async function loadTipJarProduct(): Promise<TipJarProduct | null> {
  if (!isNativeStoreChannel(getBillingDistribution().channel)) return null;
  const [product] = await loadSupportProducts([TIP_JAR_PRODUCT_ID]);
  return product ?? null;
}

export async function purchaseTipProduct(
  product: TipProduct | TipJarProduct,
): Promise<'purchased' | 'cancelled' | 'pending'> {
  if (
    product.id === TIP_JAR_PRODUCT_ID &&
    !isNativeStoreChannel(getBillingDistribution().channel)
  ) {
    throw new Error(
      'Tip jar purchases require an App Store or Google Play build.',
    );
  }
  try {
    await Purchases.purchaseStoreProduct(product.storeProduct);
    return 'purchased';
  } catch (error) {
    if (isPurchaseCancellation(error)) return 'cancelled';
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === Purchases.PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR
    )
      return 'pending';
    recordRevenueCatFailure('error', 'revenuecat-purchase-failed', error);
    throw error;
  }
}

export function recordRevenueCatFailure(
  level: 'warn' | 'error',
  event: string,
  error: unknown,
): void {
  recordOperationalDiagnostic(level, 'RevenueCat', event, {
    ...operationalErrorDetails(error),
  });
}

export function isPurchaseCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const purchasesError = error as Partial<PurchasesError>;
  return (
    purchasesError.code ===
    Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
  );
}
