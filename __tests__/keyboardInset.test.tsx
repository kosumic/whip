import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import { useAnimatedRef } from 'react-native-reanimated';
import { useAnimatedKeyboardHeight, useKeyboardInset } from '../src/hooks/useKeyboardInset';
import { commitKeyboardState, endKeyboard, keyboardSubscriberCount, keyboardViewport, keyboardWindow, moveKeyboard, publishKeyboard, resetKeyboardController, startKeyboard } from '../test-support/keyboardAnimation';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Animated: { Value: jest.fn() },
  View: 'View',
  ScrollView: 'ScrollView',
  useWindowDimensions: () => require('../test-support/keyboardAnimation').keyboardWindow,
  AppState: { currentState: 'active', addEventListener: jest.fn() },
}));
jest.mock('react-native-reanimated', () => require('../test-support/keyboardAnimation').reanimatedKeyboardMock);

let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useKeyboardInset>;
let sessionKeyboardHeight: ReturnType<typeof useAnimatedKeyboardHeight>;
let renders: Array<{ visible: boolean; inset: number }>;
const appStateListeners = new Set<(state: import('react-native').AppStateStatus) => void>();
function Harness({ enabled = true }: { enabled?: boolean }) {
  result = useKeyboardInset(useAnimatedRef(), { enabled });
  sessionKeyboardHeight = useAnimatedKeyboardHeight();
  renders.push({ visible: result.visible, inset: result.inset });
  return null;
}
function render(enabled = true) {
  act(() => {
    if (renderer) renderer.update(<Harness enabled={enabled} />);
    else renderer = create(<Harness enabled={enabled} />);
  });
}
function keyboard(visible: boolean, height?: number) { act(() => publishKeyboard(visible, height)); }
function appState(state: import('react-native').AppStateStatus) {
  act(() => {
    AppState.currentState = state;
    for (const listener of appStateListeners) listener(state);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resetKeyboardController();
  renders = [];
  AppState.currentState = 'active';
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    appStateListeners.add(callback);
    return { remove: () => { appStateListeners.delete(callback); } };
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
});

test('show and hide publish consistent discrete geometry together', () => {
  render();
  keyboard(true);
  expect(renders.at(-1)).toMatchObject({ visible: true, inset: 300 });
  expect(result.animatedInset.value).toBe(300);
  keyboard(false);
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  expect(renders.every(frame => frame.visible || frame.inset === 0)).toBe(true);
});

test('rapid show → hide → show uses the latest keyboard geometry', () => {
  render();
  keyboard(true);
  keyboard(false);
  expect(result).toMatchObject({ visible: false, inset: 0 });
  keyboard(true, 320);
  act(() => jest.advanceTimersByTime(200));
  expect(result).toMatchObject({ visible: true, inset: 320 });
  expect(result.animatedInset.value).toBe(320);
  keyboard(false);
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
});

test('a hidden animation end clears a retained IME height without a React commit', () => {
  render(); keyboard(true);
  const count = renders.length;
  act(() => endKeyboard(false, 300));
  expect(result.animatedInset.value).toBe(0);
  expect(renders).toHaveLength(count);
  act(() => endKeyboard(true, 320));
  expect(result.animatedInset.value).toBe(320);
});

test('confirmed hide repairs a missed animation end and does not seed a stale height on remount', () => {
  render(); keyboard(true);
  act(() => commitKeyboardState(false, 300));
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  act(() => renderer?.unmount()); renderer = undefined;
  render();
  expect(result.animatedInset.value).toBe(0);
  keyboard(true, 320);
  expect(result.animatedInset.value).toBe(320);
});

test('mounting or re-enabling with the keyboard open seeds both geometry paths', () => {
  keyboard(true);
  render();
  expect(result.inset).toBe(300);
  expect(result.animatedInset.value).toBe(300);
  render(false);
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  render();
  expect(result.inset).toBe(300);
  expect(result.animatedInset.value).toBe(300);
});

test('uses viewport overlap, including bottom safe area already outside the viewport', () => {
  keyboardViewport.pageY = 50;
  keyboardViewport.height = 716; // bottom is 34 points above the window bottom
  render();
  act(() => result.onLayout());
  keyboard(true);
  expect(result.inset).toBe(266);
  expect(result.animatedInset.value).toBe(266);
});

test('rotation and folding remeasure layout without another keyboard event', () => {
  render(); keyboard(true);
  Object.assign(keyboardWindow, { height: 400, width: 800 });
  Object.assign(keyboardViewport, { pageY: 20, height: 346 });
  render();
  act(() => result.onLayout());
  expect(result.inset).toBe(266);
  expect(result.animatedInset.value).toBe(266);
  Object.assign(keyboardViewport, { pageY: 20, height: 100 });
  act(() => result.onLayout());
  expect(result.animatedInset.value).toBe(20);
});

test('animation and interactive dismissal frames stay off React', () => {
  render(); keyboard(true);
  const count = renders.length;
  for (const height of [290, 240, 180, 120, 50, 0, 120, 300]) {
    act(() => moveKeyboard(height, true));
    expect(result.animatedInset.value).toBe(height);
  }
  expect(renders).toHaveLength(count);
  expect(result.inset).toBe(300); // stable end spacer until the controller commits
});

test('background clears presentation and a fresh foreground keyboard event restores it', () => {
  render(); keyboard(true);
  appState('background');
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  keyboard(false);
  appState('active');
  expect(result.inset).toBe(0);
  expect(result.animatedInset.value).toBe(0);
  keyboard(true, 250);
  expect(result.inset).toBe(250);
});

test('returning from another app cannot restore a keyboard whose hide event was missed', () => {
  render(); keyboard(true);
  appState('background');
  expect(sessionKeyboardHeight.value).toBe(0);
  // An interrupted native animation may still arrive while the app is hidden.
  act(() => endKeyboard(true, 300));
  appState('active');
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  expect(sessionKeyboardHeight.value).toBe(0);

  // Queued movement/end callbacks from the interrupted animation are stale too.
  act(() => { moveKeyboard(300); endKeyboard(true, 300); });
  expect(result.animatedInset.value).toBe(0);
  expect(sessionKeyboardHeight.value).toBe(0);
  // Notification navigation may replace the terminal after the app resumes.
  act(() => renderer?.unmount()); renderer = undefined;
  render();
  expect(result).toMatchObject({ visible: false, inset: 0 });
  expect(result.animatedInset.value).toBe(0);
  expect(sessionKeyboardHeight.value).toBe(0);

  // Reopening the same-size keyboard must work even though height is unchanged.
  keyboard(true);
  expect(result).toMatchObject({ visible: true, inset: 300 });
  expect(result.animatedInset.value).toBe(300);
  expect(sessionKeyboardHeight.value).toBe(300);
});

test('transient inactive overlays preserve the keyboard without requiring a new event', () => {
  render(); keyboard(true);
  appState('inactive');
  appState('active');
  expect(result).toMatchObject({ visible: true, inset: 300 });
  expect(result.animatedInset.value).toBe(300);
  expect(sessionKeyboardHeight.value).toBe(300);
});

test.each(['cold', 'resume'])('a keyboard hide on %s cannot revive the previous app keyboard geometry', lifecycle => {
  render();
  if (lifecycle === 'resume') {
    keyboard(true);
    appState('background');
    act(() => commitKeyboardState(false, 300));
    appState('active');
  }
  act(() => { startKeyboard(false, 300); moveKeyboard(280); });
  expect(result.animatedInset.value).toBe(0);
  expect(sessionKeyboardHeight.value).toBe(0);
  act(() => { endKeyboard(false, 300); moveKeyboard(300); });
  expect(sessionKeyboardHeight.value).toBe(0);

  keyboard(true);
  expect(sessionKeyboardHeight.value).toBe(300);
  // Once a fresh keyboard has opened, its normal hide must still animate.
  act(() => { startKeyboard(false); moveKeyboard(150); });
  expect(result.animatedInset.value).toBe(150);
  expect(sessionKeyboardHeight.value).toBe(150);
  keyboard(false);
  expect(sessionKeyboardHeight.value).toBe(0);
});

test('unmount removes keyboard subscriptions', () => {
  render(); keyboard(true); keyboard(false);
  act(() => renderer?.unmount()); renderer = undefined;
  expect(appStateListeners.size).toBe(0);
  expect(keyboardSubscriberCount()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  const count = renders.length;
  keyboard(true);
  expect(renders).toHaveLength(count);
});

test('clamps both discrete and animated overlap to a fully obscured viewport', () => {
  keyboardViewport.pageY = 600;
  keyboardViewport.height = 100;
  render();
  act(() => result.onLayout());
  keyboard(true);
  expect(result.inset).toBe(100);
  expect(result.animatedInset.value).toBe(100);
});
