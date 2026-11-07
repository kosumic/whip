import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';

import { getBillingDistribution } from '../src/billing/distribution';
import { TipJarSection } from '../src/components/TipJarSection';
import { en } from '../src/locales/en';
import {
  loadTipJarProduct,
  purchaseTipProduct,
  type TipJarProduct,
} from '../src/services/revenueCat';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
jest.mock('lucide-react-native/icons/chevron-down', () => ('ChevronDown'));
jest.mock('lucide-react-native/icons/chevron-up', () => ('ChevronUp'));
jest.mock('lucide-react-native/icons/heart', () => ('Heart'));
jest.mock('lucide-react-native/icons/copy', () => ('Copy'));
jest.mock('@react-native-clipboard/clipboard', () => ({ setString: jest.fn() }));
jest.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));
jest.mock('react-native-svg/css', () => ({ LocalSvg: 'LocalSvg' }));
jest.mock('../src/lib/bundledAsset', () => ({ bundledAsset: () => 1 }));
jest.mock('../src/billing/distribution', () => ({
  getBillingDistribution: jest.fn(),
}));
jest.mock('react-i18next', () => {
  const { en: translations } =
    jest.requireActual<typeof import('../src/locales/en')>('../src/locales/en');
  return {
    useTranslation: () => ({
      t: (key: keyof typeof translations, values: Record<string, string> = {}) =>
        translations[key].replace(/{{(.*?)}}/g, (_, name: string) => values[name] ?? ''),
    }),
  };
});
jest.mock('../src/services/revenueCat', () => ({
  loadTipJarProduct: jest.fn(),
  purchaseTipProduct: jest.fn(),
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (callback: () => void) => callback,
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
}));
jest.mock('../src/components/GlassControls', () => ({
  GlassButton: 'GlassButton',
  GlassIconBadge: 'GlassIconBadge',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const product = {
  id: 'whip_tip_5',
  localizedPrice: '¥750',
  storeProduct: {},
} as TipJarProduct;
let view: ReactTestRenderer;
const button = () => view.root.findByType('GlassButton' as never);
const copyButton = () => view.root.findByProps({ accessibilityLabel: en['tipJar.copyAddress'] });
const baseAddress = '0x5424bcf743D265BA8Ac4ACdE0d0A5DfC187eeB05';
const solanaAddress = '59Nqb3jEvexJV7HAwHJDMrqnipaxhN7VJbJe7C7pz7uV';
const content = () =>
  view.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter(child => typeof child === 'string')
    .join('\n');
const mount = async () => {
  await act(async () => {
    view = create(<TipJarSection />);
  });
};
const expand = async () => {
  await act(async () => {
    view.root
      .findByProps({ accessibilityLabel: en['tipJar.title'] })
      .props.onPress();
  });
};
const purchase = async () => {
  await act(async () => {
    await button().props.onPress();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getBillingDistribution).mockReturnValue({
    channel: 'google-play', rancherWebPurchaseUrl: null,
  });
  jest.mocked(Clipboard.setString).mockReset();
  jest.mocked(loadTipJarProduct).mockReset().mockResolvedValue(product);
  jest.mocked(purchaseTipProduct).mockReset().mockResolvedValue('purchased');
});

test('GitHub tips show Base USDC details and copy the recipient without store billing', async () => {
  jest.mocked(getBillingDistribution).mockReturnValue({
    channel: 'github', rancherWebPurchaseUrl: null,
  });
  await mount();
  await expand();
  expect(content()).toContain('USDC on Base');
  expect(content()).toContain('Select USDC and Base in your wallet before sending.');
  expect(content()).toContain(baseAddress);
  expect(view.root.findByType('SvgXml' as never).props.accessibilityLabel)
    .toBe(en['tipJar.addressQr']);
  await act(async () => { copyButton().props.onPress(); });
  expect(Clipboard.setString).toHaveBeenCalledWith(baseAddress);
  expect(content()).toContain(en['tipJar.addressCopied']);
  expect(content()).not.toContain(en['tipJar.thanks']);
  expect(loadTipJarProduct).not.toHaveBeenCalled();
  expect(purchaseTipProduct).not.toHaveBeenCalled();
});

test('switching tokens updates the address, QR, network instructions, and clipboard together', async () => {
  jest.mocked(getBillingDistribution).mockReturnValue({
    channel: 'github', rancherWebPurchaseUrl: null,
  });
  await mount();
  await expand();
  const baseQr = view.root.findByType('SvgXml' as never).props.xml;
  await act(async () => { copyButton().props.onPress(); });
  expect(content()).toContain(en['tipJar.addressCopied']);
  await act(async () => {
    view.root.findByProps({ accessibilityLabel: 'USDT on Solana' }).props.onPress();
  });
  expect(view.root.findByProps({ accessibilityLabel: 'USDT on Solana' }).props.accessibilityState)
    .toEqual({ checked: true });
  expect(view.root.findByProps({ accessibilityLabel: 'USDC on Base' }).props.accessibilityState)
    .toEqual({ checked: false });
  expect(content()).toContain('USDT on Solana');
  expect(content()).toContain('Select USDT and Solana in your wallet before sending.');
  expect(content()).toContain(solanaAddress);
  expect(content()).not.toContain(baseAddress);
  expect(content()).not.toContain(en['tipJar.addressCopied']);
  expect(view.root.findByType('SvgXml' as never).props.xml).not.toBe(baseQr);
  await act(async () => { copyButton().props.onPress(); });
  expect(Clipboard.setString).toHaveBeenLastCalledWith(solanaAddress);
  await act(async () => {
    view.root.findByProps({ accessibilityLabel: 'USDC on Base' }).props.onPress();
  });
  expect(view.root.findByType('SvgXml' as never).props.xml).toBe(baseQr);
  expect(content()).not.toContain(solanaAddress);
  expect(content()).not.toContain(en['tipJar.addressCopied']);
  await act(async () => { copyButton().props.onPress(); });
  expect(Clipboard.setString).toHaveBeenLastCalledWith(baseAddress);
  expect(loadTipJarProduct).not.toHaveBeenCalled();
  expect(purchaseTipProduct).not.toHaveBeenCalled();
});

test('a clipboard failure leaves the recipient available to select and retry', async () => {
  jest.mocked(getBillingDistribution).mockReturnValue({
    channel: 'github', rancherWebPurchaseUrl: null,
  });
  jest.mocked(Clipboard.setString).mockImplementationOnce(() => { throw new Error('Clipboard unavailable'); });
  await mount();
  await expand();
  await act(async () => { copyButton().props.onPress(); });
  expect(content()).toContain(en['tipJar.copyError']);
  expect(content()).not.toContain(en['tipJar.addressCopied']);
  expect(view.root.findByProps({ selectable: true }).children)
    .toEqual([baseAddress]);
  await act(async () => { copyButton().props.onPress(); });
  expect(content()).toContain(en['tipJar.addressCopied']);
});

test.each(['app-store', 'google-play', null] as const)(
  '%s does not show crypto tip controls',
  async channel => {
    jest.mocked(getBillingDistribution).mockReturnValue({ channel, rancherWebPurchaseUrl: null });
    await mount();
    await expand();
    expect(content()).not.toContain(baseAddress);
    expect(content()).not.toContain(solanaAddress);
    expect(view.root.findAllByProps({ accessibilityRole: 'radiogroup' })).toHaveLength(0);
    expect(view.root.findAllByType('SvgXml' as never)).toHaveLength(0);
  },
);
afterEach(() => {
  if (view) act(() => view.unmount());
});

test('loads only on expansion and shows the localized store price', async () => {
  await mount();
  expect(loadTipJarProduct).not.toHaveBeenCalled();
  await expand();
  expect(button().props.accessibilityLabel).toBe('Leave a ¥750 tip');
  expect(purchaseTipProduct).not.toHaveBeenCalled();
  expect(content()).toContain(en['tipJar.optional']);
});

test('thanks the user only after completion and allows another tip', async () => {
  await mount();
  await expand();
  await purchase();
  expect(content()).toContain(en['tipJar.thanks']);
  expect(button().props.disabled).toBe(false);
  await purchase();
  expect(purchaseTipProduct).toHaveBeenCalledTimes(2);
  expect(purchaseTipProduct).toHaveBeenLastCalledWith(product);
});

test('cancellation is silent and a pending payment is not shown as success', async () => {
  await mount();
  await expand();
  jest.mocked(purchaseTipProduct).mockResolvedValueOnce('cancelled');
  await purchase();
  expect(content()).not.toContain(en['tipJar.thanks']);
  expect(content()).not.toContain(en['tipJar.error']);
  jest.mocked(purchaseTipProduct).mockResolvedValueOnce('pending');
  await purchase();
  expect(content()).toContain(en['tipJar.pending']);
  expect(content()).not.toContain(en['tipJar.thanks']);
  expect(button().props.disabled).toBe(true);
});

test('prevents overlapping purchases even when tapped twice before rerendering', async () => {
  let complete!: (outcome: 'purchased') => void;
  jest.mocked(purchaseTipProduct).mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    }),
  );
  await mount();
  await expand();
  act(() => {
    void button().props.onPress();
    void button().props.onPress();
  });
  expect(purchaseTipProduct).toHaveBeenCalledTimes(1);
  expect(button().props.disabled).toBe(true);
  expect(content()).not.toContain(en['tipJar.thanks']);
  await act(async () => {
    complete('purchased');
  });
  expect(content()).toContain(en['tipJar.thanks']);
});

test('shows payment failures without a thank-you and permits retrying', async () => {
  jest.mocked(purchaseTipProduct).mockRejectedValueOnce(new Error('Offline'));
  await mount();
  await expand();
  await purchase();
  expect(content()).toContain(en['tipJar.error']);
  expect(content()).not.toContain(en['tipJar.thanks']);
  await purchase();
  expect(content()).toContain(en['tipJar.thanks']);
});

test.each(['missing', 'offline'])(
  'offers a catalog retry when the product is %s',
  async state => {
    if (state === 'missing')
      jest.mocked(loadTipJarProduct).mockResolvedValueOnce(null);
    else
      jest
        .mocked(loadTipJarProduct)
        .mockRejectedValueOnce(new Error('Offline'));
    await mount();
    await expand();
    expect(content()).toContain(en['tipJar.unavailable']);
    expect(purchaseTipProduct).not.toHaveBeenCalled();
    await act(async () => {
      button().props.onPress();
    });
    expect(loadTipJarProduct).toHaveBeenCalledTimes(2);
    expect(button().props.accessibilityLabel).toBe('Leave a ¥750 tip');
  },
);
