import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  useAppNavigation,
  type AppNavigationController,
} from '../src/hooks/useAppNavigation';
import { beginAppPerformanceTrace } from '../src/services/performanceTrace';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  BackHandler: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('../src/services/performanceTrace', () => ({
  beginAppPerformanceTrace: jest.fn(() => null),
  endAppPerformanceTrace: jest.fn(),
}));

let navigation: AppNavigationController | null = null;

function NavigationHarness({
  onFirstTabMounted,
}: {
  onFirstTabMounted: () => void;
}) {
  navigation = useAppNavigation({
    appReady: true,
    preferencesLoaded: true,
    preferredTab: 'hosts',
    recordLastTab: jest.fn(),
    dismissTopOverlay: () => false,
    onFirstTabMounted,
  });
  return null;
}

describe('useAppNavigation', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    navigation = null;
    jest.clearAllMocks();
  });

  test('notifies once after the first tab mounts when performance tracing is disabled', () => {
    const onFirstTabMounted = jest.fn();

    act(() => {
      renderer = create(
        <NavigationHarness onFirstTabMounted={onFirstTabMounted} />,
      );
    });

    expect(beginAppPerformanceTrace).toHaveReturnedWith(null);
    expect(navigation?.mountedTabs.has('hosts')).toBe(true);
    expect(onFirstTabMounted).toHaveBeenCalledTimes(1);

    act(() => navigation?.selectTab('herd'));

    expect(navigation?.mountedTabs.has('herd')).toBe(true);
    expect(onFirstTabMounted).toHaveBeenCalledTimes(1);
  });

  test('keeps the terminal mounted after switching to another tab', () => {
    act(() => {
      renderer = create(<NavigationHarness onFirstTabMounted={jest.fn()} />);
    });

    act(() => navigation?.selectTab('terminal'));
    expect(navigation?.mountedTabs.has('terminal')).toBe(true);

    act(() => navigation?.selectTab('more'));

    expect(navigation?.state.tab).toBe('more');
    expect(navigation?.mountedTabs.has('terminal')).toBe(true);
    expect(navigation?.mountedTabs.has('more')).toBe(true);
  });

  test('owns Android back handling for terminal navigation', () => {
    act(() => {
      renderer = create(<NavigationHarness onFirstTabMounted={jest.fn()} />);
    });
    act(() => navigation?.selectTab('terminal'));

    const backHandler = jest.requireMock('react-native').BackHandler as {
      addEventListener: jest.Mock;
    };
    const listener = backHandler.addEventListener.mock.calls.at(-1)?.[1] as
      | (() => boolean)
      | undefined;
    let handled = false;
    act(() => {
      handled = listener?.() ?? false;
    });

    expect(handled).toBe(true);
    expect(navigation?.state.tab).toBe('herd');
  });

  test('coordinates terminal navigation and session filter cleanup without losing other hosts', () => {
    act(() => { renderer = create(<NavigationHarness onFirstTabMounted={jest.fn()} />); });
    act(() => {
      navigation?.showHerd('host-1', 'workspace-1');
      navigation?.showHerd('host-2', 'workspace-2');
      navigation?.selectPane('pane-2');
      navigation?.clearSessionView('host-1');
    });
    expect(navigation?.state.tab).toBe('herd');
    expect(navigation?.herdHostFilterId).toBe('host-2');
    expect(navigation?.herdWorkspaceFilterIds).toEqual({ 'host-2': 'workspace-2' });
    expect(navigation?.selectedPaneId).toBeNull();
    act(() => { navigation?.selectPane('pane-2'); navigation?.showTerminal(); });
    expect(navigation?.state.tab).toBe('terminal');
    expect(navigation?.selectedPaneId).toBeNull();
    act(() => { navigation?.clearSessionView('host-2'); });
    expect(navigation?.herdHostFilterId).toBeNull();
    expect(navigation?.herdWorkspaceFilterIds).toEqual({});
  });

  test('Back closes licenses and the selected pane before changing the tab', () => {
    act(() => { renderer = create(<NavigationHarness onFirstTabMounted={jest.fn()} />); });
    act(() => {
      navigation?.showTerminal();
      navigation?.selectPane('pane-1');
      navigation?.openLicenses();
    });
    const pressBack = () => {
      const listener = jest.requireMock('react-native').BackHandler.addEventListener.mock.calls.at(-1)[1] as () => boolean;
      let handled = false;
      act(() => { handled = listener(); });
      return handled;
    };
    expect(pressBack()).toBe(true);
    expect(navigation?.licensesOpen).toBe(false);
    expect(navigation?.selectedPaneId).toBe('pane-1');
    expect(navigation?.state.tab).toBe('terminal');
    expect(pressBack()).toBe(true);
    expect(navigation?.selectedPaneId).toBeNull();
    expect(navigation?.state.tab).toBe('terminal');
    expect(pressBack()).toBe(true);
    expect(navigation?.state.tab).toBe('herd');
  });
});
