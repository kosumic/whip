import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppBackground } from '../src/components/AppBackground';

let mockCanvasColor = '#ffffff';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Image: 'Image',
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
  },
  View: 'View',
}));
jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
  BlurTargetView: 'BlurTargetView',
}));
jest.mock('@callstack/liquid-glass', () => ({
  isLiquidGlassSupported: false,
  LiquidGlassView: 'LiquidGlassView',
}));
jest.mock(
  '@/src/theme',
  () => ({
    useTheme: () => ({ colors: { canvas: mockCanvasColor } }),
  }),
);

function findHosts(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('AppBackground', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test.each([
    ['light', '#f7f7f8'],
    ['dark', '#111214'],
  ])('paints the opaque %s theme canvas without an image', (_theme, canvas) => {
    mockCanvasColor = canvas;
    act(() => {
      renderer = create(<AppBackground uri={null} dimming={35} />);
    });

    const background = findHosts(renderer.root, 'View')[0];

    expect(background.props).toEqual(
      expect.objectContaining({
        accessibilityElementsHidden: true,
        pointerEvents: 'none',
      }),
    );
    expect(background.props.style).toEqual([
      { position: 'absolute', inset: 0 },
      { backgroundColor: canvas },
    ]);
    expect(findHosts(renderer.root, 'Image')).toHaveLength(0);
  });

  test('renders the image over the canvas with theme-aware dimming', () => {
    mockCanvasColor = '#15171a';
    act(() => {
      renderer = create(
        <AppBackground uri="file:///wallpaper.webp" dimming={42} />,
      );
    });

    const views = findHosts(renderer.root, 'View');
    const image = findHosts(renderer.root, 'Image')[0];

    expect(views[0].props.style).toEqual([
      { position: 'absolute', inset: 0 },
      { backgroundColor: '#15171a' },
    ]);
    expect(image.props).toEqual(
      expect.objectContaining({
        resizeMode: 'cover',
        source: { uri: 'file:///wallpaper.webp' },
        style: { position: 'absolute', inset: 0 },
      }),
    );
    expect(views[1].props.style).toEqual([
      { position: 'absolute', inset: 0 },
      { backgroundColor: '#15171a', opacity: 0.42 },
    ]);
  });
});
