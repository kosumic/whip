import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { BrowserStartPage } from '../src/browser/BrowserStartPage';
import { BrowserLibraryScreen } from '../src/browser/BrowserLibraryScreen';
import { BrowserAddressActions } from '../src/browser/BrowserAddressActions';
import { browserLibrary } from '../src/browser/library';
import { en } from '../src/locales/en';
import { es } from '../src/locales/es';
import { fr } from '../src/locales/fr';
import { ja } from '../src/locales/ja';
import { zhHans } from '../src/locales/zh-Hans';
import { zhHant } from '../src/locales/zh-Hant';
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: 'black' } }),
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('lucide-react-native/icons/plus', () => ('Plus'));
jest.mock('lucide-react-native/icons/copy', () => ('Copy'));
jest.mock('lucide-react-native/icons/pencil', () => ('Pencil'));
jest.mock('lucide-react-native/icons/share-2', () => ('Share'));
jest.mock('../src/services/interactionFeedback', () => ({ copyTextWithHaptic: jest.fn() }));
jest.mock('../src/browser/BrowserFavicon', () => ({
  BrowserFavicon: 'BrowserFavicon',
}));
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    shortcuts: () => [{ url: 'https://x.com/', title: 'X', visitedAt: 0n }],
    bookmarks: () => [{ url: 'https://x.com/', title: 'X', visitedAt: 0n }],
    history: () => [{ url: 'https://x.com/', title: 'X', visitedAt: 0n }],
    addShortcut: jest.fn(async () => undefined),
    removeShortcut: jest.fn(async () => undefined),
  },
}));

const resources = { en, es, fr, ja, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
const testI18n = createInstance();
void testI18n.use(initReactI18next).init({
  lng: 'en',
  resources: Object.fromEntries(Object.entries(resources).map(([language, translation]) => [language, { translation }])),
  keySeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});
beforeEach(async () => {
  jest.clearAllMocks();
  await testI18n.changeLanguage('en');
});
test('start page opens and removes shortcuts, and validates a new shortcut before saving', async () => {
  const onOpen = jest.fn();
  let view!: ReactTestRenderer;
  const button = (label: string) =>
    view.root.findByProps({ accessibilityLabel: label });
  await act(async () => {
    view = create(<BrowserStartPage onOpen={onOpen} runtimeId="host" />);
  });
  try {
    await act(async () => button('Visit X').props.onPress());
    expect(onOpen).toHaveBeenCalledWith('https://x.com/');
    await act(async () => button('Visit X').props.onLongPress());
    expect(browserLibrary.removeShortcut).toHaveBeenCalledWith(
      'https://x.com/',
    );
    await act(async () => button('Add shortcut').props.onPress());
    await act(async () => {
      button('Shortcut name').props.onChangeText('My wiki');
      button('Shortcut address').props.onChangeText('file:///private');
    });
    const save = () =>
      view.root
        .findAllByType('Button' as never)
        .find(node =>
          node
            .findAllByType('Text' as never)
            .some(text => text.children.includes('Save shortcut')),
        )!;
    await act(async () => save().props.onPress());
    expect(browserLibrary.addShortcut).not.toHaveBeenCalled();
    await act(async () =>
      button('Shortcut address').props.onChangeText('en.wikipedia.org'),
    );
    await act(async () => save().props.onPress());
    expect(browserLibrary.addShortcut).toHaveBeenCalledWith(
      'https://en.wikipedia.org/',
      'My wiki',
    );
    expect(
      view.root.findAllByProps({ accessibilityLabel: 'Shortcut address' }),
    ).toHaveLength(0);
  } finally {
    await act(async () => view.unmount());
  }
});

test.each(Object.entries(resources))('browser start, library, and address actions render in %s and update after a language change', async (language, locale) => {
  await testI18n.changeLanguage(language);
  let view!: ReactTestRenderer;
  const control = (label: string) => view.root.findByProps({ accessibilityLabel: label });
  const text = () => view.root.findAllByType('Text' as never).map(node => node.children.filter(child => typeof child === 'string').join('')).join('\n');
  await act(async () => {
    view = create(<>
      <BrowserStartPage onOpen={jest.fn()} runtimeId="host" />
      <BrowserLibraryScreen kind="bookmarks" onOpen={jest.fn()} />
      <BrowserAddressActions url="https://x.com/" onEdit={jest.fn()} />
    </>);
  });
  try {
    expect(control(locale['browser.searchBookmarks']).props.placeholder).toBe(locale['browser.searchBookmarks']);
    expect(control(testI18n.t('browser.openSite', { site: 'X' }))).toBeDefined();
    expect(control(locale['browser.shareAddress'])).toBeDefined();
    expect(text()).toContain(locale['browser.share']);
    await act(async () => control(locale['browser.addShortcut']).props.onPress());
    await act(async () => control(locale['browser.shortcutAddress']).props.onChangeText('file:///private'));
    const save = view.root.findAllByType('Button' as never).find(node =>
      node.findAllByType('Text' as never).some(child => child.children.includes(locale['browser.saveShortcut'])),
    )!;
    await act(async () => save.props.onPress());
    expect(text()).toContain(locale['browser.invalidAddress']);
    expect(browserLibrary.addShortcut).not.toHaveBeenCalled();
    await act(async () => { await testI18n.changeLanguage('en'); });
    expect(text()).toContain(en['browser.invalidAddress']);
    expect(control(en['browser.shareAddress'])).toBeDefined();
  } finally {
    await act(async () => view.unmount());
  }
});
