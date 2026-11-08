import { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ListViewToken } from 'react-native';
import { useDecorativeProgress } from '../src/hooks/useDecorativeProgress';
import { useViewableKeys } from '../src/hooks/useViewableKeys';
import { AnimationVisibilityProvider } from '../src/lib/animationVisibility';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

const mockFrames: { active: boolean; setActive: (active: boolean) => void }[] = [];
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value: unknown) => jest.requireActual('react').useRef({ value }).current,
  useFrameCallback: () => {
    const react = jest.requireActual('react');
    const frame = react.useRef(null);
    if (!frame.current) {
      frame.current = {
        active: false,
        setActive(active: boolean) { this.active = active; },
      };
      mockFrames.push(frame.current);
    }
    return frame.current;
  },
}));

function Decoration() {
  useDecorativeProgress(true, 1000);
  return null;
}

test('offscreen rows pause, visible rows resume, and a hidden screen overrides row visibility', () => {
  let report!: (change: { viewableItems: ListViewToken[] }) => void;
  function List({ visible }: { visible: boolean }) {
    const { viewableKeys, onViewableItemsChanged } = useViewableKeys();
    report = onViewableItemsChanged;
    const keys = useRef(['first', 'second']).current;
    return <AnimationVisibilityProvider enabled={visible}>
      {keys.map(key => <AnimationVisibilityProvider key={key} enabled={viewableKeys.has(key)}>
        <Decoration />
      </AnimationVisibilityProvider>)}
    </AnimationVisibilityProvider>;
  }
  const show = (...keys: string[]) => report({
    viewableItems: keys.map((key, index) => ({ key, item: key, index, isViewable: true })),
  });
  const playing = () => mockFrames.map(frame => frame.active);
  mockFrames.length = 0;
  let renderer!: ReactTestRenderer;
  try {
    act(() => { renderer = create(<List visible />); });
    expect(playing()).toEqual([false, false]);
    act(() => show('first'));
    expect(playing()).toEqual([true, false]);
    act(() => show('second'));
    expect(playing()).toEqual([false, true]);
    act(() => { renderer.update(<List visible={false} />); });
    expect(playing()).toEqual([false, false]);
    act(() => show('first', 'second'));
    expect(playing()).toEqual([false, false]);
    act(() => { renderer.update(<List visible />); });
    expect(playing()).toEqual([true, true]);
    act(() => show());
    expect(playing()).toEqual([false, false]);
  } finally {
    if (renderer) act(() => renderer.unmount());
  }
  expect(playing()).toEqual([false, false]);
});
