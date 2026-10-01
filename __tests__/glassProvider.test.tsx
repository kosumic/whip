import { createRef } from 'react';
import type { View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GlassProvider, useAppGlassEnabled } from '../src/components/GlassSurface';
import { ScreenUpdates } from '../src/components/ScreenUpdates';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('@callstack/liquid-glass', () => ({
  isLiquidGlassSupported: false,
  LiquidGlassView: 'LiquidGlassView',
}));
jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

test('hidden glass consumers skip unrelated parent updates and receive preference changes', () => {
  const render = jest.fn();
  const blurTarget = createRef<View>();
  function HiddenScreen() {
    render(useAppGlassEnabled());
    return null;
  }
  const tree = (enabled: boolean) => (
    <GlassProvider blurTarget={blurTarget} enabled={enabled}>
      <ScreenUpdates active={false}>{() => <HiddenScreen />}</ScreenUpdates>
    </GlassProvider>
  );
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(tree(true)); });
  expect(render).toHaveBeenLastCalledWith(true);
  render.mockClear();
  act(() => { renderer.update(tree(true)); });
  act(() => { renderer.update(tree(true)); });
  expect(render).not.toHaveBeenCalled();
  act(() => { renderer.update(tree(false)); });
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenLastCalledWith(false);
  act(() => { renderer.unmount(); });
});
