import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Keyboard, type KeyboardEvent, type View } from 'react-native';

import { useKeyboardInset } from '../src/hooks/useKeyboardInset';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Keyboard: {
    metrics: jest.fn(),
    isVisible: jest.fn(),
    addListener: jest.fn(),
  },
}));

const keyboardFrame = { screenX: 0, screenY: 500, width: 400, height: 300 };
const keyboardStateApis = { metrics: Keyboard.metrics, isVisible: Keyboard.isVisible };
type Measurement = Parameters<View['measureInWindow']>[0];

let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useKeyboardInset>;
let measurements: Measurement[];
let listeners: Map<string, (event: KeyboardEvent) => void>;
const onVisibilityChange = jest.fn();
const measuredViewRef = {
  current: {
    measureInWindow: (callback: Measurement) => measurements.push(callback),
  } as unknown as View,
};

function Harness({ enabled = true }: { enabled?: boolean }) {
  result = useKeyboardInset(measuredViewRef, { enabled, onVisibilityChange });
  return null;
}

function render(enabled = true) {
  act(() => {
    if (renderer) renderer.update(<Harness enabled={enabled} />);
    else renderer = create(<Harness enabled={enabled} />);
  });
}

function show(screenY = keyboardFrame.screenY) {
  const metrics = { ...keyboardFrame, screenY };
  jest.mocked(Keyboard.metrics).mockReturnValue(metrics);
  jest.mocked(Keyboard.isVisible).mockReturnValue(true);
  act(() =>
    listeners.get('keyboardDidShow')?.({
      duration: 0,
      easing: 'keyboard',
      endCoordinates: metrics,
    }),
  );
}

function hide() {
  jest.mocked(Keyboard.metrics).mockReturnValue(undefined);
  jest.mocked(Keyboard.isVisible).mockReturnValue(false);
  act(() =>
    listeners.get('keyboardDidHide')?.({
      duration: 0,
      easing: 'keyboard',
      endCoordinates: { ...keyboardFrame, screenY: 800, height: 0 },
    }),
  );
}

function measure(index = measurements.length - 1) {
  act(() => measurements[index](0, 750, 400, 50));
}

beforeEach(() => {
  measurements = [];
  listeners = new Map();
  onVisibilityChange.mockClear();
  jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
    listeners.set(event, callback);
    return { remove: () => listeners.delete(event) } as unknown as ReturnType<
      typeof Keyboard.addListener
    >;
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
  Object.assign(Keyboard, keyboardStateApis);
});

test('normal keyboard show and hide measure overlap and report visibility', () => {
  render();
  expect(result.inset).toBe(0);
  show();
  measure();
  expect(result.inset).toBe(300);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  hide();
  expect(result.inset).toBe(0);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
});

test('disabled → enabled seeds an already visible IME without another show event', () => {
  render(false);
  show();
  expect(measurements).toHaveLength(0);
  render(true);
  expect(measurements).toHaveLength(1);
  measure();
  expect(result.inset).toBe(300);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
});

test('mounting with a visible IME seeds its current geometry', () => {
  show();
  render();
  expect(measurements).toHaveLength(1);
  measure();
  expect(result.inset).toBe(300);
});

test('enable and disable during show invalidate measurements and reseed on enable', () => {
  render(false);
  render(true);
  show();
  render(false);
  measure(0);
  expect(result.inset).toBe(0);
  render(true);
  expect(measurements).toHaveLength(2);
  measure(1);
  expect(result.inset).toBe(300);
});

test('enable and disable during hide do not resurrect a hidden IME', () => {
  render();
  show();
  measure();
  render(false);
  // Native state still says visible until keyboardDidHide completes.
  render(true);
  expect(measurements).toHaveLength(2);
  hide();
  measure(1);
  expect(result.inset).toBe(0);
  render(false);
  render(true);
  expect(measurements).toHaveLength(2);
  expect(result.inset).toBe(0);
});

test('a stale measurement after keyboard hide cannot restore the inset', () => {
  render();
  show();
  hide();
  measure();
  expect(result.inset).toBe(0);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
});

test('a newer show measurement wins even when callbacks finish out of order', () => {
  render();
  show();
  show(450);
  measure(1);
  measure(0);
  expect(result.inset).toBe(350);
});

test('reset invalidates outstanding measurements', () => {
  render();
  show();
  act(() => result.resetInset());
  measure();
  expect(result.inset).toBe(0);
});

test('unmount removes listeners and invalidates outstanding measurements', () => {
  render();
  show();
  act(() => renderer?.unmount());
  expect(listeners.size).toBe(0);
  measure();
  expect(result.inset).toBe(0);
});

test('keyboard events still work when cached state APIs are unavailable', () => {
  Object.defineProperty(Keyboard, 'metrics', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(Keyboard, 'isVisible', {
    configurable: true,
    value: undefined,
  });
  render();
  act(() =>
    listeners.get('keyboardDidShow')?.({
      duration: 0,
      easing: 'keyboard',
      endCoordinates: keyboardFrame,
    }),
  );
  measure();
  expect(result.inset).toBe(300);
});
