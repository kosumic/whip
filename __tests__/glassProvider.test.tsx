import { createRef } from 'react';
import { Platform, type View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { BlurView } from 'expo-blur';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GlassPortal, GlassProvider, GlassSurface, useAppGlassEnabled } from '../src/components/GlassSurface';
import { ScreenUpdates } from '../src/components/ScreenUpdates';
import { COMPOSER_GLASS_SURFACE_PROPS } from '../src/lib/appGlass';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { absoluteFill: {} },
  View: 'View',
  useColorScheme: () => 'dark',
}));
jest.mock('@callstack/liquid-glass', () => ({
  get isLiquidGlassSupported() { return mockLiquidGlassSupported; },
  LiquidGlassView: 'LiquidGlassView',
}));
jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

let mockLiquidGlassSupported = false;

beforeEach(() => {
  Platform.OS = 'ios';
  mockLiquidGlassSupported = false;
});

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

test('portal content keeps its glass preference and blur target outside the provider', () => {
  const render = jest.fn();
  const blurTarget = createRef<View>();
  function GlassConsumer() {
    render(useAppGlassEnabled());
    return null;
  }
  const tree = (enabled: boolean) => (
    <>
      <GlassProvider blurTarget={blurTarget} enabled={enabled}>
        <GlassPortal name="composer-glass-test">
          <GlassSurface><GlassConsumer /></GlassSurface>
        </GlassPortal>
      </GlassProvider>
      <PortalHost />
    </>
  );
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(tree(true)); });
  expect(render).toHaveBeenLastCalledWith(true);
  expect(renderer!.root.findByType(BlurView).props.blurTarget).toBe(blurTarget);
  act(() => { renderer.update(tree(false)); });
  expect(render).toHaveBeenLastCalledWith(false);
  expect(renderer!.root.findAllByType(BlurView)).toHaveLength(0);
  act(() => { renderer.unmount(); });
});

test.each(['android', 'ios'] as const)('composer requests native blur without changing other glass surfaces on %s', platform => {
  Platform.OS = platform;
  mockLiquidGlassSupported = platform === 'ios';
  const blurTarget = createRef<View>();
  const tree = (composer: boolean, enabled = true) => (
    <GlassProvider blurTarget={blurTarget} enabled={enabled}>
      <GlassSurface {...(composer ? COMPOSER_GLASS_SURFACE_PROPS : {})} />
    </GlassProvider>
  );
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(tree(true)); });
  expect(renderer!.root.findByType(BlurView).props).toMatchObject({
    blurTarget,
    blurMethod: 'dimezisBlurViewSdk31Plus',
    intensity: 8,
  });
  expect(renderer!.root.findAll(node => String(node.type) === 'LiquidGlassView')).toHaveLength(0);

  act(() => { renderer.update(tree(false)); });
  expect(renderer!.root.findAllByType(BlurView)).toHaveLength(0);
  expect(renderer!.root.findAll(node => String(node.type) === 'LiquidGlassView')).toHaveLength(platform === 'ios' ? 1 : 0);

  act(() => { renderer.update(tree(true, false)); });
  expect(renderer!.root.findAllByType(BlurView)).toHaveLength(0);
  act(() => { renderer.unmount(); });
});
