import { act, create, type ReactTestRenderer } from 'react-test-renderer';

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
jest.mock('lucide-react-native', () => ({
  Heart: 'Heart',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));
jest.mock('react-i18next', () => {
  const { en: translations } =
    jest.requireActual<typeof import('../src/locales/en')>('../src/locales/en');
  return {
    useTranslation: () => ({
      t: (key: keyof typeof translations, values?: { price: string }) =>
        translations[key].replace('{{price}}', values?.price ?? ''),
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
  jest.mocked(loadTipJarProduct).mockReset().mockResolvedValue(product);
  jest.mocked(purchaseTipProduct).mockReset().mockResolvedValue('purchased');
});
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
