import { useEffect, useRef, useSyncExternalStore } from 'react';
import { KeyboardController, KeyboardEvents, useKeyboardHandler, useKeyboardState, type IKeyboardState, type KeyboardHandler } from 'react-native-keyboard-controller';

const closed: IKeyboardState = { isVisible: false, height: 0, duration: 0, timestamp: 0, target: -1, type: 'default', appearance: 'light' };
let state = closed;
const listeners = new Set<() => void>();
const handlers = new Set<KeyboardHandler>();
const hideListeners = new Set<() => void>();
const dismissals = new Set<() => void>();
export const keyboardWindow = { width: 400, height: 800, scale: 1, fontScale: 1 };
export const keyboardViewport = { pageX: 0, pageY: 0, x: 0, y: 0, width: 400, height: 800 };

// Extend the library's documented Jest mock with deterministic native events.
export function resetKeyboardController() {
  state = closed;
  listeners.clear(); handlers.clear(); hideListeners.clear(); dismissals.clear();
  Object.assign(keyboardWindow, { width: 400, height: 800 });
  Object.assign(keyboardViewport, { pageY: 0, height: 800 });
  jest.mocked(KeyboardController.state).mockImplementation(() => state);
  jest.mocked(KeyboardController.isVisible).mockImplementation(() => state.isVisible);
  jest.mocked(KeyboardEvents.addListener).mockImplementation((event, callback) => {
    const listener = () => callback(state);
    if (event === 'keyboardDidHide') hideListeners.add(listener);
    return { remove: () => { hideListeners.delete(listener); } } as ReturnType<typeof KeyboardEvents.addListener>;
  });
  jest.mocked(KeyboardController.dismiss).mockImplementation(() => state.isVisible
    ? new Promise<void>(resolve => dismissals.add(resolve)) : Promise.resolve());
  jest.mocked(useKeyboardState).mockImplementation((selector = value => value) =>
    useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => selector(state)),
  );
  jest.mocked(useKeyboardHandler).mockImplementation(handler => {
    useEffect(() => { handlers.add(handler); return () => { handlers.delete(handler); }; }, [handler]);
  });
}

export function moveKeyboard(height: number, interactive = false) {
  for (const handler of handlers) (interactive ? handler.onInteractive : handler.onMove)?.({ height, progress: height / 300, duration: 0, target: 1 });
}

export function endKeyboard(visible: boolean, height = visible ? 300 : 0) {
  for (const handler of handlers) handler.onEnd?.({ height, progress: visible ? 1 : 0, duration: 0, target: 1 });
}

export function startKeyboard(visible: boolean, height = visible ? 300 : 0) {
  for (const handler of handlers) handler.onStart?.({ height, progress: visible ? 1 : 0, duration: 0, target: 1 });
}

export function commitKeyboardState(visible: boolean, height = visible ? 300 : 0) {
  state = { ...state, isVisible: visible, height };
  for (const listener of listeners) listener();
  if (!visible) {
    for (const listener of hideListeners) listener();
    for (const resolve of dismissals) { resolve(); }
    dismissals.clear();
  }
}
export function publishKeyboard(visible: boolean, height = visible ? 300 : 0) {
  startKeyboard(visible, height);
  moveKeyboard(height);
  commitKeyboardState(visible, height);
}
export function keyboardSubscriberCount() { return listeners.size + handlers.size + hideListeners.size; }

function animatedProperties(callback: () => Record<string, unknown>) {
  return new Proxy({}, {
    get: (_target, key) => callback()[String(key)],
    ownKeys: () => Reflect.ownKeys(callback()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}

export const reanimatedKeyboardMock = {
  __esModule: true,
  default: { View: 'AnimatedView' },
  useAnimatedRef: () => useRef(null),
  useSharedValue: (value: unknown) => useRef({ value }).current,
  useDerivedValue: (callback: () => unknown) => ({ get value() { return callback(); } }),
  useAnimatedStyle: animatedProperties,
  useAnimatedProps: animatedProperties,
  measure: jest.fn(() => ({ ...keyboardViewport })),
  runOnUI: (callback: unknown) => callback,
  runOnJS: (callback: unknown) => callback,
  cancelAnimation: jest.fn(),
  withTiming: (value: number) => value,
};
