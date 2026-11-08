import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { FrameInfo } from 'react-native-reanimated';
import { useDecorativeProgress } from '../src/hooks/useDecorativeProgress';
import { NativeAgentSpinner } from '../src/components/NativeAgentSpinner';
import { AnimationVisibilityProvider } from '../src/lib/animationVisibility';

jest.mock('expo-modules-core', () => ({
  requireNativeViewManager: () => 'NativeSpinner',
}));

type TestFrameCallback = { run: (info: FrameInfo) => void; active: boolean };
const mockCallbacks = new Set<TestFrameCallback>();

jest.mock('react-native-reanimated', () => {
  const React = require('react') as typeof import('react');
  return {
    useSharedValue: <T,>(initial: T) => React.useRef({ value: initial }).current,
    useFrameCallback: (run: TestFrameCallback['run']) => {
      const ref = React.useRef({
        run,
        active: false,
        setActive(active: boolean) { this.active = active; },
      });
      ref.current.run = run;
      React.useEffect(() => {
        const callback = ref.current;
        mockCallbacks.add(callback);
        return () => { mockCallbacks.delete(callback); };
      }, []);
      return ref.current;
    },
  };
});

describe('decorative animation timing', () => {
  let renderer: ReactTestRenderer;
  let progress: ReturnType<typeof useDecorativeProgress>;
  function Harness({ enabled = true, reverse = false, framesPerSecond = 30 }) {
    progress = useDecorativeProgress(enabled, 1000, reverse, framesPerSecond);
    return null;
  }
  function frame(timestamp: number) {
    for (const callback of mockCallbacks) {
      if (callback.active) callback.run({ timestamp, timeSincePreviousFrame: null, timeSinceFirstFrame: 0 });
    }
    return progress.value;
  }
  afterEach(() => act(() => renderer.unmount()));

  test.each([30, 60].flatMap(fps => [60, 90, 120].map(refreshRate => [fps, refreshRate])))
  ('limits style changes to %s per second on a %s Hz display', (fps, refreshRate) => {
    act(() => {
      renderer = create(
        <Harness framesPerSecond={fps} />,
      );
    });
    let changes = 0;
    let previous = -1;
    for (let index = 0; index < refreshRate * 2; index += 1) {
      const value = frame((index + 0.1) * 1000 / refreshRate);
      if (value !== previous) changes += 1;
      previous = value;
    }
    expect(changes).toBe(fps * 2);
  });

  test('always renders native spinners at 60 FPS without a settings provider', () => {
    act(() => {
      renderer = create(<NativeAgentSpinner color="#00ff00" durationMs={700} enabled size={24} />);
    });
    expect(renderer.root.findByProps({ pointerEvents: 'none' }).props.framesPerSecond).toBe(60);
  });

  test('preserves animation speed across dropped frames', () => {
    act(() => { renderer = create(<Harness />); });
    expect(frame(0)).toBe(0);
    expect(frame(100)).toBeCloseTo(0.1);
    expect(frame(250)).toBeCloseTo(0.25);
    expect(frame(450)).toBeCloseTo(0.45);
  });

  test('preserves the breathing curve and reversal', () => {
    act(() => { renderer = create(<Harness reverse />); });
    expect(frame(0)).toBe(0);
    expect(frame(250)).toBeCloseTo(0.125);
    frame(500);
    frame(750);
    expect(frame(1000)).toBe(1);
    frame(1250);
    expect(frame(1500)).toBeCloseTo(0.5);
    frame(1750);
    expect(frame(2000)).toBe(0);
  });

  test('stops and resets disabled motion, then resumes from its starting pose', () => {
    act(() => { renderer = create(<Harness />); });
    frame(0);
    frame(250);
    expect(frame(500)).toBeCloseTo(0.5);
    act(() => { renderer.update(<Harness enabled={false} />); });
    expect([...mockCallbacks].every(callback => !callback.active)).toBe(true);
    expect(frame(800)).toBe(0);
    act(() => { renderer.update(<Harness />); });
    expect(frame(2000)).toBe(0);
    frame(2250);
    expect(frame(2500)).toBeCloseTo(0.5);
  });

  test('resumes the first native frame after suspension without a React update or phase reset', () => {
    act(() => { renderer = create(<Harness framesPerSecond={60} />); });
    frame(0);
    frame(200);
    expect(frame(400)).toBeCloseTo(0.4);
    expect(frame(10400)).toBeCloseTo(0.4 + 1 / 60);
    expect(frame(10420)).toBeCloseTo(0.4 + 1 / 60 + 0.02);
    expect(mockCallbacks.size).toBe(1);
  });

  test('retains phase while a screen is hidden and repeated visibility changes keep one loop', () => {
    const screen = (visible: boolean) => (
      <AnimationVisibilityProvider enabled={visible}><Harness /></AnimationVisibilityProvider>
    );
    act(() => { renderer = create(screen(true)); });
    frame(0);
    frame(200);
    expect(frame(400)).toBeCloseTo(0.4);
    for (let index = 0; index < 10; index += 1) {
      act(() => { renderer.update(screen(false)); });
      expect([...mockCallbacks].every(callback => !callback.active)).toBe(true);
      expect(frame(5000)).toBeCloseTo(0.4);
      act(() => { renderer.update(screen(true)); });
      expect(frame(6000)).toBeCloseTo(0.4);
      expect(mockCallbacks.size).toBe(1);
    }
    expect(frame(6200)).toBeCloseTo(0.6);
  });
});
