import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';
import { NativeEventEmitter, NativeModules, Platform, type AppStateStatus } from 'react-native';

import { useClipboardCopyFeedback } from '../src/hooks/useClipboardCopyFeedback';
import {
  copyTextWithHaptic,
  hapticCopySuccess,
} from '../src/services/interactionFeedback';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(),
  },
  Platform: { OS: 'android' },
  NativeModules: {},
  NativeEventEmitter: jest.fn(),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: (error: Error) => ({ message: error.message }),
  recordOperationalDiagnostic: jest.fn(),
}));

const appState = jest.requireMock('react-native').AppState;
const clipboardListeners = new Set<() => void>();
const appStateListeners = new Set<(state: AppStateStatus) => void>();
let renderer: ReactTestRenderer | undefined;

function Harness({ visible }: { visible: boolean }) {
  useClipboardCopyFeedback(visible);
  return null;
}

function render(visible = true) {
  act(() => {
    if (renderer) renderer.update(<Harness visible={visible} />);
    else renderer = create(<Harness visible={visible} />);
  });
}

function changeAppState(state: AppStateStatus) {
  act(() => {
    appState.currentState = state;
    appStateListeners.forEach(listener => listener(state));
  });
}

function nativeCopy() {
  act(() => clipboardListeners.forEach(listener => listener()));
}

beforeEach(() => {
  jest.clearAllMocks();
  clipboardListeners.clear();
  appStateListeners.clear();
  appState.currentState = 'active';
  Platform.OS = 'android';
  NativeModules.ClipboardAttachment = undefined;
  appState.addEventListener.mockImplementation((
    _event: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  });
  jest.mocked(Clipboard.addListener).mockImplementation(listener => {
    clipboardListeners.add(listener);
    return { remove: () => { clipboardListeners.delete(listener); } };
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

test('confirms each native copy without reading or rewriting clipboard formats', () => {
  render();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();

  nativeCopy();
  nativeCopy();

  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  expect(Clipboard.getString).not.toHaveBeenCalled();
  expect(Clipboard.setString).not.toHaveBeenCalled();
});

test('app copy callbacks and clipboard notifications produce one haptic per copy in either event order', () => {
  render();
  copyTextWithHaptic('same text');
  expect(Clipboard.setString).toHaveBeenCalledWith('same text');
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  nativeCopy();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);

  hapticCopySuccess();
  nativeCopy();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);

  nativeCopy();
  hapticCopySuccess();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(3);
});

test('existing copy buttons keep their feedback outside the observed screen', () => {
  render(false);
  copyTextWithHaptic('text');
  expect(Clipboard.setString).toHaveBeenCalledWith('text');
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  expect(Clipboard.addListener).not.toHaveBeenCalled();
});

test('stops observing while hidden or backgrounded and resumes without a haptic', () => {
  render();
  const queuedClipboardEvent = [...clipboardListeners][0];
  changeAppState('background');
  expect(clipboardListeners.size).toBe(0);
  queuedClipboardEvent();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();

  changeAppState('active');
  expect(clipboardListeners.size).toBe(1);
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  nativeCopy();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);

  render(false);
  expect(clipboardListeners.size).toBe(0);
  expect(appStateListeners.size).toBe(0);
  nativeCopy();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
});

test('waits for the foreground when mounted in the background and removes listeners on unmount', () => {
  appState.currentState = 'background';
  render();
  expect(Clipboard.addListener).not.toHaveBeenCalled();
  changeAppState('active');
  nativeCopy();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  act(() => renderer?.unmount());
  renderer = undefined;
  expect(clipboardListeners.size).toBe(0);
  expect(appStateListeners.size).toBe(0);
});

test('overlapping screen lifetimes share a listener and retain it until the last screen leaves', () => {
  render();
  let second: ReactTestRenderer;
  act(() => { second = create(<Harness visible />); });
  try {
    expect(Clipboard.addListener).toHaveBeenCalledTimes(1);
    nativeCopy();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    render(false);
    expect(clipboardListeners.size).toBe(1);
    nativeCopy();
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
  } finally {
    act(() => second.unmount());
  }
  expect(clipboardListeners.size).toBe(0);
});

test('iOS uses the app clipboard bridge and removes only its own event subscription', () => {
  Platform.OS = 'ios';
  const native = { setCopyFeedbackEnabled: jest.fn(), addListener: jest.fn(), removeListeners: jest.fn() };
  NativeModules.ClipboardAttachment = native;
  const remove = jest.fn();
  const addListener = jest.fn((_event, listener) => {
    clipboardListeners.add(listener);
    return { remove };
  });
  jest.mocked(NativeEventEmitter).mockImplementation(() => ({ addListener } as unknown as NativeEventEmitter));
  render();
  expect(NativeEventEmitter).toHaveBeenCalledWith(native);
  expect(addListener).toHaveBeenCalledWith('WhipClipboardChanged', expect.any(Function));
  expect(native.setCopyFeedbackEnabled).toHaveBeenLastCalledWith(true);
  expect(Clipboard.addListener).not.toHaveBeenCalled();
  nativeCopy();
  hapticCopySuccess();
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  render(false);
  expect(native.setCopyFeedbackEnabled).toHaveBeenLastCalledWith(false);
  expect(remove).toHaveBeenCalledTimes(1);
});

test('older iOS binaries retain existing copy haptics until the clipboard bridge is rebuilt', () => {
  Platform.OS = 'ios';
  render();
  copyTextWithHaptic('text');
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  expect(Clipboard.setString).toHaveBeenCalledWith('text');
});
