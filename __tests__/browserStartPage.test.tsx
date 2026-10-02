import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserStartPage } from '../src/browser/BrowserStartPage';
import { browserLibrary } from '../src/browser/library';
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
jest.mock('lucide-react-native', () => ({ Plus: 'Plus' }));
jest.mock('../src/browser/BrowserFavicon', () => ({
  BrowserFavicon: 'BrowserFavicon',
}));
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    shortcuts: () => [{ url: 'https://x.com/', title: 'X', visitedAt: 0n }],
    addShortcut: jest.fn(async () => undefined),
    removeShortcut: jest.fn(async () => undefined),
  },
}));
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
