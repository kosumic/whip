import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserFavicon } from '../src/browser/BrowserFavicon';
import { browserFavicon } from '../src/browser/native';
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({ Image: 'Image' }));
jest.mock('lucide-react-native', () => ({ Globe: 'Globe' }));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: 'black' } }),
}));
jest.mock('../src/browser/native', () => ({ browserFavicon: jest.fn() }));
const fetchIcon = jest.mocked(browserFavicon);

test('shortcut loads its favicon through the host route and falls back if the image fails', async () => {
  fetchIcon.mockResolvedValueOnce('data:image/png;base64,icon');
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <BrowserFavicon
        url="https://www.youtube.com/watch?v=test"
        runtimeId="ssh-host"
      />,
    );
  });
  try {
    expect(fetchIcon).toHaveBeenCalledWith(
      'ssh-host',
      'https://www.google.com/s2/favicons?domain=www.youtube.com&sz=64',
    );
    expect(view.root.findByType('Image' as never).props.source.uri).toBe(
      'data:image/png;base64,icon',
    );
    await act(async () =>
      view.root.findByType('Image' as never).props.onError(),
    );
    expect(view.root.findAllByType('Image' as never)).toHaveLength(0);
    expect(view.root.findAllByType('Globe' as never)).toHaveLength(1);
  } finally {
    await act(async () => view.unmount());
  }
});

test('private shortcut names are not sent to the favicon service', async () => {
  fetchIcon.mockClear();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <BrowserFavicon url="http://localhost:3000/" runtimeId="ssh-host" />,
    );
  });
  try {
    expect(fetchIcon).not.toHaveBeenCalled();
    expect(view.root.findAllByType('Globe' as never)).toHaveLength(1);
  } finally {
    await act(async () => view.unmount());
  }
});
