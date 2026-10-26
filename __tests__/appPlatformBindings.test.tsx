import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, Platform, StatusBar, type AppStateStatus } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { StableStatusBar } from '../src/components/AppPlatformBindings';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
  Platform: { OS: 'android' },
  StatusBar: Object.assign(function MockStatusBar() { return null; }, {
    setHidden: jest.fn(),
  }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const context = React.createContext({ top: 0 });
  return {
    SafeAreaInsetsContext: context,
    useSafeAreaInsets: () => React.useContext(context),
  };
});
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('../src/services/volumeKeys', () => ({
  configureTerminalVolumeKeys: jest.fn(),
}));

let topInset = 0;
let renderer: ReactTestRenderer | undefined;
const stateListeners = new Set<(state: AppStateStatus) => void>();
const focusListeners = new Set<() => void>();

function render(hidden = true) {
  act(() => {
    const bar = (
      <SafeAreaInsetsContext.Provider value={{ top: topInset, bottom: 0, left: 0, right: 0 }}>
        <StableStatusBar hidden={hidden} isDark />
      </SafeAreaInsetsContext.Provider>
    );
    if (renderer) renderer.update(bar);
    else renderer = create(bar);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  topInset = 0;
  jest.mocked(AppState.addEventListener).mockImplementation((event, listener) => {
    if (event === 'change') {
      const onChange = listener as (state: AppStateStatus) => void;
      stateListeners.add(onChange);
      return { remove: () => { stateListeners.delete(onChange); } };
    }
    focusListeners.add(listener);
    return { remove: () => { focusListeners.delete(listener); } };
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

test('restores full screen after Android focus or resume without changing props', () => {
  render();
  jest.mocked(StatusBar.setHidden).mockClear();

  act(() => {
    for (const listener of stateListeners) listener('background');
  });
  expect(StatusBar.setHidden).not.toHaveBeenCalled();

  act(() => {
    for (const listener of stateListeners) listener('active');
    for (const listener of focusListeners) listener();
  });
  expect(StatusBar.setHidden).toHaveBeenCalledTimes(2);
  expect(StatusBar.setHidden).toHaveBeenLastCalledWith(true, 'none');
});

test('hides a status bar that reappears and changes the top inset', () => {
  render();
  jest.mocked(StatusBar.setHidden).mockClear();

  topInset = 28;
  render();

  expect(StatusBar.setHidden).toHaveBeenCalledWith(true, 'none');
});

test('uses the current preference after leaving full screen and cleans up listeners', () => {
  render();
  render(false);
  jest.mocked(StatusBar.setHidden).mockClear();

  act(() => {
    for (const listener of focusListeners) listener();
  });
  expect(StatusBar.setHidden).toHaveBeenCalledTimes(1);
  expect(StatusBar.setHidden).toHaveBeenCalledWith(false, 'none');

  act(() => renderer?.unmount());
  renderer = undefined;
  expect(stateListeners.size).toBe(0);
  expect(focusListeners.size).toBe(0);
});

test('leaves iOS status bar lifecycle to React Native', () => {
  Platform.OS = 'ios';
  render();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
  expect(StatusBar.setHidden).not.toHaveBeenCalled();
});
