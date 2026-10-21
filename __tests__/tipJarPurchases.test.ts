import type Purchases from 'react-native-purchases';
import type { PurchasesStoreProduct } from 'react-native-purchases';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        distributionChannel: 'google-play',
        revenueCatAndroidPublicSdkKey: 'goog_test',
        revenueCatIosPublicSdkKey: 'appl_test',
      },
    },
  },
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    getProducts: jest.fn(),
    purchaseStoreProduct: jest.fn(),
    PRODUCT_CATEGORY: { NON_SUBSCRIPTION: 'NON_SUBSCRIPTION' },
    PURCHASES_ERROR_CODE: {
      PURCHASE_CANCELLED_ERROR: '1',
      PAYMENT_PENDING_ERROR: '20',
    },
  },
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: jest.fn(() => ({})),
  recordOperationalDiagnostic: jest.fn(),
}));

let billing: typeof import('../src/services/revenueCat');
let purchases: jest.Mocked<typeof Purchases>;
let extra: { distributionChannel: string | null };
let platform: { OS: string };

const storeProduct = {
  identifier: 'whip_tip_5',
  priceString: '5,00 €',
} as PurchasesStoreProduct;

beforeEach(() => {
  jest.resetModules();
  billing = jest.requireActual<typeof billing>('../src/services/revenueCat');
  purchases = jest.requireMock<{ default: typeof purchases }>(
    'react-native-purchases',
  ).default;
  extra = jest.requireMock<{
    default: { expoConfig: { extra: typeof extra } };
  }>('expo-constants').default.expoConfig.extra;
  platform = jest.requireMock<{ Platform: typeof platform }>(
    'react-native',
  ).Platform;
  purchases.getProducts.mockReset().mockResolvedValue([storeProduct]);
  purchases.purchaseStoreProduct
    .mockReset()
    .mockResolvedValue(
      {} as Awaited<ReturnType<typeof Purchases.purchaseStoreProduct>>,
    );
});

test.each([
  ['google-play', 'android', 'goog_test'],
  ['app-store', 'ios', 'appl_test'],
])(
  'loads the localized consumable on %s with its platform key',
  async (channel, os, apiKey) => {
    extra.distributionChannel = channel;
    platform.OS = os;
    await expect(billing.loadTipJarProduct()).resolves.toEqual({
      id: billing.TIP_JAR_PRODUCT_ID,
      localizedPrice: storeProduct.priceString,
      storeProduct,
    });
    expect(purchases.configure).toHaveBeenCalledWith({
      apiKey,
      automaticDeviceIdentifierCollectionEnabled: false,
    });
    expect(purchases.getProducts).toHaveBeenCalledWith(
      [billing.TIP_JAR_PRODUCT_ID],
      'NON_SUBSCRIPTION',
    );
  },
);

test.each(['github', null])(
  'never initializes or invokes store billing on %s builds',
  async channel => {
    extra.distributionChannel = channel;
    await expect(billing.loadTipJarProduct()).resolves.toBeNull();
    await expect(
      billing.purchaseTipProduct({
        id: billing.TIP_JAR_PRODUCT_ID,
        localizedPrice: storeProduct.priceString,
        storeProduct,
      }),
    ).rejects.toThrow('require an App Store or Google Play build');
    expect(purchases.configure).not.toHaveBeenCalled();
    expect(purchases.getProducts).not.toHaveBeenCalled();
    expect(purchases.purchaseStoreProduct).not.toHaveBeenCalled();
  },
);

test('does not offer a purchase when the product is absent', async () => {
  purchases.getProducts.mockResolvedValue([]);
  await expect(billing.loadTipJarProduct()).resolves.toBeNull();
  expect(purchases.purchaseStoreProduct).not.toHaveBeenCalled();
});

test('allows a second tip using the same consumable product', async () => {
  const product = (await billing.loadTipJarProduct())!;
  await expect(billing.purchaseTipProduct(product)).resolves.toBe('purchased');
  await expect(billing.purchaseTipProduct(product)).resolves.toBe('purchased');
  expect(purchases.purchaseStoreProduct).toHaveBeenCalledTimes(2);
  expect(purchases.purchaseStoreProduct).toHaveBeenLastCalledWith(storeProduct);
});

test.each([
  ['1', 'cancelled'],
  ['20', 'pending'],
])(
  'does not treat store result %s as a successful tip',
  async (code, outcome) => {
    const product = (await billing.loadTipJarProduct())!;
    purchases.purchaseStoreProduct.mockRejectedValue({ code });
    await expect(billing.purchaseTipProduct(product)).resolves.toBe(outcome);
  },
);

test('propagates catalog and payment failures', async () => {
  const error = new Error('Store unavailable');
  purchases.getProducts.mockRejectedValueOnce(error);
  await expect(billing.loadTipJarProduct()).rejects.toBe(error);
  const product = (await billing.loadTipJarProduct())!;
  purchases.purchaseStoreProduct.mockRejectedValueOnce(error);
  await expect(billing.purchaseTipProduct(product)).rejects.toBe(error);
});

test('keeps feedback products separate from the general tip jar', async () => {
  const feedbackProduct = {
    ...storeProduct,
    identifier: billing.TIP_PRODUCT_IDS[0],
  };
  purchases.getProducts.mockResolvedValue([storeProduct, feedbackProduct]);
  await expect(billing.loadTipProducts()).resolves.toEqual([
    {
      id: feedbackProduct.identifier,
      localizedPrice: feedbackProduct.priceString,
      storeProduct: feedbackProduct,
    },
  ]);
  expect(purchases.getProducts).toHaveBeenCalledWith(
    [...billing.TIP_PRODUCT_IDS],
    'NON_SUBSCRIPTION',
  );
});
