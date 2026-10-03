import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserSurface } from '../src/browser/BrowserSurface';
import {
  browserRegistry,
  connectedBrowserRuntimes,
} from '../src/browser/registry';
import { prepareBrowserView } from '../src/browser/native';
import { AppState, BackHandler, Keyboard, Linking } from 'react-native';
import { browserSearchHistory } from '../src/browser/searchHistory';
import {
  browserPreferences,
  DEFAULT_BROWSER_PREFERENCES,
} from '../src/browser/preferences';

let mockMounted = 0;
jest.mock('../src/hooks/useKeyboardInset', () => ({
  useKeyboardInset: () => ({ inset: 0, resetInset: jest.fn() }),
}));
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    load: jest.fn(async () => undefined),
    bookmarks: () => [],
    history: () => [],
    shortcuts: () => [],
    tunneling: () => false,
    visit: jest.fn(async () => undefined),
    bookmark: jest.fn(async () => undefined),
  },
}));
let mockUnmounted = 0;
let mockRendered = 0;
let mockCameraPermission = { granted: true, canAskAgain: true };
const mockRequestCameraPermission = jest.fn(async () => mockCameraPermission);
const mockGetCameraPermission = jest.fn(async () => mockCameraPermission);
let mockRecentSearches: string[] = [];
let mockHistoryRevision = 0;
const mockHistoryListeners = new Set<() => void>();
jest.mock('../src/browser/searchHistory', () => ({
  browserSearchHistory: {
    subscribe: (listener: () => void) => {
      mockHistoryListeners.add(listener);
      return () => {
        mockHistoryListeners.delete(listener);
      };
    },
    getSnapshot: () => mockHistoryRevision,
    load: jest.fn(async () => undefined),
    suggestions: (query: string) =>
      mockRecentSearches.filter(saved =>
        saved.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    record: jest.fn(async (query: string) => {
      mockRecentSearches = [
        query.trim(),
        ...mockRecentSearches.filter(saved => saved !== query.trim()),
      ];
      mockHistoryRevision++;
      for (const listener of mockHistoryListeners) listener();
    }),
    clear: jest.fn(async () => {
      mockRecentSearches = [];
      mockHistoryRevision++;
      for (const listener of mockHistoryListeners) listener();
    }),
    remove: jest.fn(async (query: string) => {
      mockRecentSearches = mockRecentSearches.filter(saved => saved !== query);
      mockHistoryRevision++;
      for (const listener of mockHistoryListeners) listener();
    }),
  },
}));
jest.mock('expo-camera', () => {
  const React = jest.requireActual('react');
  return {
    CameraView: 'CameraView',
    useCameraPermissions: () => {
      const [permission, setPermission] = React.useState(mockCameraPermission);
      const request = React.useCallback(async () => {
        const response = await mockRequestCameraPermission();
        setPermission(response);
        return response;
      }, []);
      const get = React.useCallback(async () => {
        const response = await mockGetCameraPermission();
        setPermission(response);
        return response;
      }, []);
      return [permission, request, get];
    },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
  View: 'View',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Share: { share: jest.fn(async () => undefined) },
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Keyboard: { dismiss: jest.fn() },
  Linking: { openSettings: jest.fn(async () => undefined) },
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  StyleSheet: { create: (value: unknown) => value },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  findNodeHandle: () => 42,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: React.forwardRef(
      (props: { source?: { uri: string } }, ref: object) => {
        mockRendered++;
        const currentProps = React.useRef(props);
        currentProps.current = props;
        React.useImperativeHandle(ref, () => ({
          get documentUrl() {
            return currentProps.current.source?.uri || 'about:blank';
          },
          injectJavaScript: jest.fn(),
          goBack: jest.fn(),
          goForward: jest.fn(),
          reload: jest.fn(),
        }));
        React.useEffect(() => {
          mockMounted++;
          return () => {
            mockUnmounted++;
          };
        }, []);
        return React.createElement('BrowserWebView', props);
      },
    ),
  };
});
jest.mock('react-native-whip-ssh', () => ({
  subscribeReverseControlEvents: () => () => undefined,
}));
jest.mock('../src/browser/native', () => ({
  supportsBrowserProxy: () => false,
  supportsBrowserControl: () => true,
  prepareBrowserView: jest.fn(async () => undefined),
  defaultBrowserUserAgent: jest.fn(async () => undefined),
  recordBrowserSite: jest.fn(),
  nativeBrowserDriver: (_tag: number, handle: { documentUrl: string }) => ({
    documentState: jest.fn(async () => ({
      id: handle.documentUrl,
      url: handle.documentUrl,
      ready: true,
    })),
    evaluate: jest.fn(async () => ({
      ok: true,
      value: { title: 'Shared page' },
    })),
    navigate: jest.fn(),
    screenshot: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    clearData: jest.fn(),
    siteInfo: jest.fn(async (url: string) => ({
      url,
      secure: true,
      hasCookies: false,
      thirdPartyCookiesAllowed: true,
      canClearSiteData: true,
      permissions: { location: 'blocked', camera: 'ask', microphone: 'ask' },
    })),
    clearSiteData: jest.fn(async () => undefined),
  }),
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ConfirmationPopup', () => ({
  ConfirmationPopup: 'ConfirmationPopup',
}));
jest.mock('../src/browser/SearchEngineIcon', () => ({
  SearchEngineIcon: 'SearchEngineIcon',
}));
jest.mock('../src/browser/BrowserSettings', () => ({
  BrowserSettings: 'BrowserSettings',
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: 'black', primary: 'blue' } }),
}));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name) }),
);

async function layoutBrowserViews(view: ReactTestRenderer) {
  await act(async () => {
    for (const container of view.root.findAllByProps({ collapsable: false }))
      if (container.props.onLayout)
        container.props.onLayout({ currentTarget: 42 });
  });
}

function browserSession(id: string) {
  const identity = {
    runtimeId: id + '-host',
    sessionId: id + '-session',
    paneId: 'pane',
    terminalId: 'terminal',
  };
  const runtime = {
    runtimeId: identity.runtimeId,
    reverseControlSessions: () => [identity],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  return {
    identity,
    runtime,
    entry: browserRegistry.ensure(identity, runtime),
  };
}

test('host refresh and SSH reconnect retain the visible page until explicit disconnect', async () => {
  const { identity, runtime, entry } = browserSession('snapshot-refresh');
  const getRuntime = (id: string) =>
    id === runtime.runtimeId ? runtime : undefined;
  const runtimesFor = (
    status: 'ready' | 'connected' | 'reconnecting' | 'disconnected',
  ) =>
    connectedBrowserRuntimes(
      [{ id: runtime.runtimeId, connectionStatus: status }],
      getRuntime,
    );
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={runtimesFor('ready')} />);
      browserRegistry.open(identity.sessionId);
    });
    await layoutBrowserViews(view);
    const tab = entry.controller.tab();
    const driver = tab.driver;
    const page = {
      url: 'https://m.youtube.com/',
      title: 'YouTube',
      canGoBack: true,
      canGoForward: false,
    };
    await act(async () => entry.controller.navigation(tab.id, page));
    for (const status of [
      'connected',
      'reconnecting',
      'connected',
      'ready',
    ] as const) {
      await act(async () => {
        view.update(<BrowserSurface runtimes={runtimesFor(status)} />);
      });
      expect(browserRegistry.entries.get(identity.sessionId)).toBe(entry);
      expect(browserRegistry.visibleId).toBe(identity.sessionId);
      expect(entry.controller.tab()).toBe(tab);
      expect(tab.driver).toBe(driver);
      expect(tab).toMatchObject(page);
      expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(
        1,
      );
    }
    await act(async () => {
      view.update(<BrowserSurface runtimes={runtimesFor('disconnected')} />);
    });
    expect(browserRegistry.entries.has(identity.sessionId)).toBe(false);
    expect(browserRegistry.visibleId).toBeNull();
    expect(entry.controller.disposed).toBe(true);
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(0);
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
  }
});

test('the actual browser surface keeps its WebView mounted across hide/reopen and unmounts on session cleanup', async () => {
  mockMounted = mockUnmounted = mockRendered = 0;
  const identity = {
    runtimeId: 'surface-host',
    sessionId: 'surface-session',
    paneId: 'pane',
    terminalId: 'terminal',
  };
  const runtime = {
    runtimeId: 'surface-host',
    reverseControlSessions: () => [identity],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  const entry = browserRegistry.ensure(identity, runtime);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<BrowserSurface runtimes={[runtime]} />);
  });
  await layoutBrowserViews(view);
  expect(mockMounted).toBe(1);
  const driver = entry.controller.tab().driver;
  await act(async () => {
    browserRegistry.open(identity.sessionId);
  });
  await act(async () => {
    browserRegistry.hide();
  });
  await act(async () => {
    browserRegistry.open(identity.sessionId);
  });
  expect(mockMounted).toBe(1);
  expect(mockUnmounted).toBe(0);
  expect(entry.controller.tab().driver).toBe(driver);
  await act(async () => {
    await browserRegistry.close(identity.sessionId);
  });
  expect(mockUnmounted).toBe(1);
  await act(async () => view.unmount());
});

test('loading a second tab keeps the first WebView mounted and does not rerender it', async () => {
  mockMounted = mockUnmounted = mockRendered = 0;
  const identity = {
    runtimeId: 'multi-host',
    sessionId: 'multi-session',
    paneId: 'multi-pane',
    terminalId: 'multi-terminal',
  };
  const runtime = {
    runtimeId: identity.runtimeId,
    reverseControlSessions: () => [identity],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  const entry = browserRegistry.ensure(identity, runtime);
  const runtimes = [runtime];
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<BrowserSurface runtimes={runtimes} />);
    browserRegistry.open(identity.sessionId);
  });
  await layoutBrowserViews(view);
  const first = entry.controller.tab();
  const firstDriver = first.driver;
  await act(async () => {
    entry.controller.newTab();
  });
  await layoutBrowserViews(view);
  expect(mockMounted).toBe(2);
  const rendered = mockRendered;
  const second = entry.controller.tab();
  await act(async () => {
    entry.controller.loadStart(second.id);
    entry.controller.navigation(second.id, {
      url: 'https://google.com/',
      title: 'Google',
      canGoBack: true,
      canGoForward: false,
      loading: true,
    });
    entry.controller.loadEnd(second.id);
  });
  expect(mockRendered).toBe(rendered);
  expect(first.driver).toBe(firstDriver);
  expect(mockUnmounted).toBe(0);
  await act(async () => {
    entry.controller.select(first.id);
    browserRegistry.hide();
    browserRegistry.open(identity.sessionId);
  });
  expect(mockMounted).toBe(2);
  await act(async () => {
    await browserRegistry.close(identity.sessionId);
    view.unmount();
  });
});

test.each(['onRenderProcessGone', 'onContentProcessDidTerminate'])(
  '%s preserves both tabs and reload restores only the selected page',
  async event => {
    const identity = {
      runtimeId: 'crash-host',
      sessionId: 'crash-session',
      paneId: 'pane',
      terminalId: 'terminal',
    };
    const runtime = {
      runtimeId: identity.runtimeId,
      reverseControlSessions: () => [identity],
      reverseControlReply: jest.fn(),
      startWebPreview: jest.fn(),
      stopPreview: jest.fn(),
    };
    const entry = browserRegistry.ensure(identity, runtime);
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<BrowserSurface runtimes={[runtime]} />);
      browserRegistry.open(identity.sessionId);
    });
    await layoutBrowserViews(view);
    const first = entry.controller.tab();
    await act(async () => {
      entry.controller.navigation(first.id, {
        url: 'https://google.com/',
        title: 'Google',
        canGoBack: true,
        canGoForward: false,
      });
      entry.controller.newTab();
    });
    const second = entry.controller.tab();
    await layoutBrowserViews(view);
    await act(async () => {
      entry.controller.navigation(second.id, {
        url: 'https://reddit.com/',
        title: 'Reddit',
        canGoBack: false,
        canGoForward: false,
      });
      for (const webView of view.root.findAllByType('BrowserWebView' as never))
        webView.props[event]();
    });
    expect(entry.controller.tabs).toHaveLength(2);
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(0);
    expect(first.url).toBe('https://google.com/');
    expect(second.url).toBe('https://reddit.com/');
    let restored!: Promise<unknown>;
    await act(async () => {
      restored = entry.controller.action('reload', { tab_id: second.id });
    });
    await layoutBrowserViews(view);
    await act(async () => {
      await restored;
    });
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(1);
    expect(
      view.root.findByType('BrowserWebView' as never).props.source.uri,
    ).toBe('https://reddit.com/');
    expect(first.lifecycle).toBe('crashed');
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
  },
);

test('clearing the visible browser releases its renderer without automatically repopulating site data', async () => {
  const { identity, runtime, entry } = browserSession('clear-visible');
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={[runtime]} />);
      browserRegistry.open(identity.sessionId);
    });
    await layoutBrowserViews(view);
    const action = jest.spyOn(entry.controller, 'action');
    await act(async () => {
      await entry.controller.clearData();
    });
    expect(entry.controller.tab().lifecycle).toBe('cleared');
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(0);
    expect(action).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
  }
});

test('a tab becomes controllable when native layout arrives after the React commit', async () => {
  const { identity, runtime, entry } = browserSession('late-mount');
  let nativeMounted = false;
  jest.mocked(prepareBrowserView).mockImplementation(async () => {
    if (!nativeMounted) throw new Error('Browser tab is no longer mounted');
  });
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={[runtime]} />);
    });
    await act(async () => {
      nativeMounted = true;
    });
    await layoutBrowserViews(view);
    expect(entry.controller.tab().driver).not.toBeNull();
    await expect(
      entry.controller.action('evaluate', { js: 'test' }),
    ).resolves.toMatchObject({
      value: { title: 'Shared page' },
    });
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
    jest.mocked(prepareBrowserView).mockResolvedValue(undefined);
  }
});

test('native preparation failure releases a waiting action and reload retries the same tab', async () => {
  const { identity, runtime, entry } = browserSession('prepare-failure');
  let failPreparation!: (error: Error) => void;
  jest.mocked(prepareBrowserView).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failPreparation = reject;
      }),
  );
  const diagnostic = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={[runtime]} />);
    });
    await layoutBrowserViews(view);
    const tab = entry.controller.tab();
    const failed = entry.controller
      .action('evaluate', { js: 'test' })
      .catch((error: unknown) => error);
    await act(async () => {
      failPreparation(new Error('Browser tab is no longer mounted'));
    });
    expect(await failed).toMatchObject({
      message: expect.stringContaining(
        'Browser renderer could not be prepared',
      ),
    });
    expect(tab.lifecycle).toBe('crashed');
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(0);
    let restored!: Promise<unknown>;
    await act(async () => {
      restored = entry.controller.action('reload');
    });
    await layoutBrowserViews(view);
    await act(async () => {
      await restored;
    });
    expect(entry.controller.tab()).toBe(tab);
    expect(tab.lifecycle).toBe('active');
    await expect(
      entry.controller.action('evaluate', { js: 'test' }),
    ).resolves.toMatchObject({
      value: { title: 'Shared page' },
    });
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
    diagnostic.mockRestore();
  }
});

test('viewport settings resize the shared WebView while idle changes leave its renderer alone', async () => {
  await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  const { identity, runtime } = browserSession('settings-viewport');
  const runtimes = [runtime];
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={runtimes} />);
    });
    await layoutBrowserViews(view);
    const webView = () => view.root.findByType('BrowserWebView' as never);
    expect(webView().props.contentMode).toBe('mobile');
    const viewport = () =>
      view.root
        .findAllByProps({ collapsable: false })
        .find(node => node.props.onLayout)?.props.style;
    expect(viewport()).toMatchObject({
      width: 390,
      height: 844,
      transform: [{ scale: 1 }],
    });
    const resize = async (width: number, height: number) =>
      act(async () => {
        view.root
          .find(
            node =>
              typeof node.props.onLayout === 'function' &&
              node.props.collapsable !== false,
          )
          .props.onLayout({ nativeEvent: { layout: { width, height } } });
      });
    await resize(360, 640);
    expect(viewport()).toMatchObject({
      width: 360,
      height: 640,
      left: 0,
      top: 0,
      transform: [{ scale: 1 }],
    });
    await resize(720, 320);
    expect(viewport()).toMatchObject({
      width: 720,
      height: 320,
      transform: [{ scale: 1 }],
    });
    await act(async () => {
      await browserPreferences.set('desktop');
    });
    expect(webView().props.contentMode).toBe('desktop');
    expect(viewport()).toMatchObject({
      width: 720,
      height: 320,
      transform: [{ scale: 1 }],
    });
    await act(async () => {
      await browserPreferences.set({ viewport: { width: 1920, height: 1080 } });
    });
    expect(viewport()).toMatchObject({ width: 1920, height: 1080 });
    await resize(360, 640);
    expect(viewport()).toMatchObject({
      width: 1920,
      height: 1080,
      transform: [{ scale: 360 / 1920 }],
    });
    await act(async () => {
      await browserPreferences.set({ viewport: null });
    });
    expect(viewport()).toMatchObject({
      width: 360,
      height: 640,
      left: 0,
      top: 0,
      transform: [{ scale: 1 }],
    });
    const rendered = mockRendered;
    const mounted = mockMounted;
    await act(async () => {
      await browserPreferences.set({ idleMinutes: 37 });
    });
    expect(mockRendered).toBe(rendered);
    expect(mockMounted).toBe(mounted);
    await act(async () => {
      await browserPreferences.set({
        userAgent: 'custom',
        customUserAgent: 'Test Agent',
      });
    });
    expect(webView().props.contentMode).toBe('recommended');
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
    await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  }
});

test('the address bar submits searches to the shared selected tab and respects engine changes', async () => {
  await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  const { identity, runtime, entry } = browserSession('omnibox');
  const submit = jest.spyOn(entry.controller, 'action').mockResolvedValue({});
  browserRegistry.open(identity.sessionId);
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserSurface runtimes={[runtime]} />);
    });
    await layoutBrowserViews(view);
    const input = () =>
      view.root.findByProps({
        accessibilityLabel: 'Browser address or search',
      });
    expect(input().props.value).toBe('');
    const enter = async (text: string) => {
      await act(async () => input().props.onChangeText(text));
      await act(async () => input().props.onSubmitEditing());
    };
    const id = entry.controller.selectedTabId;
    await enter('reverse control');
    expect(submit).toHaveBeenLastCalledWith('navigate', {
      url: 'https://www.google.com/search?q=reverse%20control',
      tab_id: id,
    });
    await act(async () => {
      await browserPreferences.set({ searchEngine: 'brave' });
    });
    await enter('whip');
    expect(submit).toHaveBeenLastCalledWith('navigate', {
      url: 'https://search.brave.com/search?q=whip',
      tab_id: id,
    });
    await enter('localhost:3000');
    expect(submit).toHaveBeenLastCalledWith('navigate', {
      url: 'http://localhost:3000/',
      tab_id: id,
    });
    const before = submit.mock.calls.length;
    await enter('   ');
    await enter('https://user:secret@example.test/');
    expect(submit).toHaveBeenCalledTimes(before);
  } finally {
    await act(async () => {
      await browserRegistry.close(identity.sessionId);
      view.unmount();
    });
    await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  }
});

test('restoring a suspended renderer leaves native history in control of its source', async () => {
  const session = browserSession('native-history');
  let view!: ReactTestRenderer;
  const saved = { restore: jest.fn(async () => true), dispose: jest.fn() };
  try {
    await act(async () => {
      browserRegistry.open(session.identity.sessionId);
      view = create(<BrowserSurface runtimes={[session.runtime]} />);
    });
    await layoutBrowserViews(view);
    const tab = session.entry.controller.tab();
    tab.driver!.saveState = jest.fn(async () => saved);
    tab.canGoBack = true;
    await act(async () => {
      browserRegistry.hide();
      await session.entry.controller.suspendTab(tab);
    });
    expect(view.root.findAllByType('BrowserWebView' as never)).toHaveLength(0);
    await act(async () => browserRegistry.open(session.identity.sessionId));
    await layoutBrowserViews(view);
    await act(async () => {
      await session.entry.controller.action('list_tabs');
    });
    expect(saved.restore).toHaveBeenCalledTimes(1);
    expect(saved.dispose).toHaveBeenCalledTimes(1);
    expect(
      view.root.findByType('BrowserWebView' as never).props.source,
    ).toBeUndefined();
    expect(tab.canGoBack).toBe(true);
    expect(tab.driver).not.toBeNull();
  } finally {
    await act(async () => {
      await browserRegistry.close(session.identity.sessionId);
      view.unmount();
    });
  }
});

describe('browser QR scanning and recent searches', () => {
  let view: ReactTestRenderer;
  let session: ReturnType<typeof browserSession>;
  let navigate: jest.SpyInstance;
  const control = (label: string) =>
    view.root.findByProps({ accessibilityLabel: label });
  const camera = () => view.root.findByType('CameraView' as never);
  const press = async (label: string) =>
    act(async () => control(label).props.onPress());
  beforeEach(async () => {
    mockCameraPermission = { granted: true, canAskAgain: true };
    mockRecentSearches = [];
    mockRequestCameraPermission.mockImplementation(
      async () => mockCameraPermission,
    );
    jest.clearAllMocks();
    session = browserSession('qr-history');
    navigate = jest
      .spyOn(session.entry.controller, 'action')
      .mockResolvedValue({});
    await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
    browserRegistry.open(session.identity.sessionId);
    await act(async () => {
      view = create(<BrowserSurface runtimes={[session.runtime]} />);
    });
    await layoutBrowserViews(view);
  });
  afterEach(async () => {
    await act(async () => {
      await browserRegistry.close(session.identity.sessionId);
      view.unmount();
    });
    await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  });

  test('QR scan navigates the selected tab once and keeps the browser renderer mounted', async () => {
    const mounts = mockMounted;
    await press('Scan QR code');
    expect(Keyboard.dismiss).toHaveBeenCalled();
    expect(mockRequestCameraPermission).toHaveBeenCalledTimes(1);
    expect(camera().props.barcodeScannerSettings).toEqual({
      barcodeTypes: ['qr'],
    });
    await press('Toggle scanner flashlight');
    expect(camera().props.enableTorch).toBe(true);
    const scan = camera().props.onBarcodeScanned;
    await act(async () => {
      scan({ data: ' https://example.test/from-qr ' });
      scan({ data: 'https://example.test/from-qr' });
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('navigate', {
      url: 'https://example.test/from-qr',
      tab_id: session.entry.controller.selectedTabId,
    });
    expect(control('Browser address or search').props.value).toBe(
      'https://example.test/from-qr',
    );
    expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
    expect(mockMounted).toBe(mounts);
    expect(browserSearchHistory.record).not.toHaveBeenCalled();
  });

  test('unsafe QR links stay in the scanner and a subsequent valid scan works', async () => {
    await press('Scan QR code');
    const scan = camera().props.onBarcodeScanned;
    for (const data of [
      'data:text/html,private',
      'https://user:secret@example.test/',
      'WIFI:T:WPA;S:home;P:secret;;',
    ]) {
      await act(async () => scan({ data }));
      expect(
        view.root.findAllByProps({ accessibilityRole: 'alert' }),
      ).toHaveLength(1);
    }
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => scan({ data: 'example.test' }));
    expect(navigate).toHaveBeenCalledWith('navigate', {
      url: 'https://example.test/',
      tab_id: session.entry.controller.selectedTabId,
    });
  });

  test('permanent camera denial offers settings without mounting a camera', async () => {
    mockCameraPermission = { granted: false, canAskAgain: false };
    await press('Scan QR code');
    expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
    const settings = view.root
      .findAllByType('Button' as never)
      .find(node =>
        node
          .findAllByType('Text' as never)
          .some(text => text.children.includes('Open Settings')),
      )!;
    await act(async () => settings.props.onPress());
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    await press('Close QR scanner');
    expect(view.root.findAllByType('Modal' as never)).toHaveLength(0);
  });

  test('backgrounding releases the camera and stale scans after close or browser hide do nothing', async () => {
    await press('Scan QR code');
    const scan = camera().props.onBarcodeScanned;
    const stateChanged = jest.mocked(AppState.addEventListener).mock
      .calls[0][1];
    await act(async () => stateChanged('background'));
    expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
    await act(async () => scan({ data: 'https://example.test/stale' }));
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => stateChanged('active'));
    expect(view.root.findAllByType('CameraView' as never)).toHaveLength(1);
    await act(async () =>
      view.root.findByType('Modal' as never).props.onRequestClose(),
    );
    await act(async () => scan({ data: 'https://example.test/stale' }));
    expect(navigate).not.toHaveBeenCalled();
    await press('Scan QR code');
    const nextScan = camera().props.onBarcodeScanned;
    await act(async () => browserRegistry.hide());
    await act(async () => nextScan({ data: 'https://example.test/stale' }));
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => browserRegistry.open(session.identity.sessionId));
    expect(view.root.findAllByType('Modal' as never)).toHaveLength(0);
  });

  test('changing tabs cancels the scanner before a native callback can navigate', async () => {
    await press('Scan QR code');
    const scan = camera().props.onBarcodeScanned;
    await act(async () => {
      const next = session.entry.controller.newTab();
      session.entry.controller.select(next.id);
      scan({ data: 'https://example.test/stale' });
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
  });

  test('recent searches can be filtered, edited, rerun with the selected engine, and cleared', async () => {
    const input = () => control('Browser address or search');
    await act(async () => {
      input().props.onChangeText('proot ubuntu');
    });
    await act(async () => input().props.onSubmitEditing());
    expect(browserSearchHistory.record).toHaveBeenCalledWith('proot ubuntu');
    await act(async () => browserSearchHistory.record('tradingview'));
    await act(async () => input().props.onFocus());
    expect(control('Search again: proot ubuntu')).toBeDefined();
    expect(control('Search again: tradingview')).toBeDefined();
    await act(async () => input().props.onChangeText('PROOT'));
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Search again: tradingview',
      }),
    ).toHaveLength(0);
    await press('Edit search: proot ubuntu');
    expect(input().props.value).toBe('proot ubuntu');
    await act(async () => browserPreferences.set({ searchEngine: 'brave' }));
    expect(input().props.placeholder).toBe('Search or type URL');
    await press('Search again: proot ubuntu');
    expect(navigate).toHaveBeenLastCalledWith('navigate', {
      url: 'https://search.brave.com/search?q=proot%20ubuntu',
      tab_id: session.entry.controller.selectedTabId,
    });
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Search again: proot ubuntu',
      }),
    ).toHaveLength(0);
    await act(async () => input().props.onFocus());
    await press('Clear search history');
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Search again: proot ubuntu',
      }),
    ).toHaveLength(0);
    const saved = jest.mocked(browserSearchHistory.record).mock.calls.length;
    await act(async () => input().props.onChangeText('https://example.test/'));
    await act(async () => input().props.onSubmitEditing());
    expect(browserSearchHistory.record).toHaveBeenCalledTimes(saved);
  });

  test('Back dismisses recent searches while retaining the current browser tab', async () => {
    await act(async () => {
      await browserSearchHistory.record('whip');
      control('Browser address or search').props.onFocus();
    });
    expect(control('Search again: whip')).toBeDefined();
    const back = jest
      .mocked(BackHandler.addEventListener)
      .mock.calls.at(-1)![1];
    await act(async () => {
      expect(back({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
    });
    expect(browserRegistry.visibleId).toBe(session.identity.sessionId);
    expect(
      view.root.findAllByProps({ accessibilityLabel: 'Search again: whip' }),
    ).toHaveLength(0);
    expect(Keyboard.dismiss).toHaveBeenCalled();
  });

  test('holding a recent search removes it without navigating', async () => {
    await act(async () => {
      await browserSearchHistory.record('remove me');
      control('Browser address or search').props.onFocus();
    });
    await act(async () =>
      control('Search again: remove me').props.onLongPress(),
    );
    expect(browserSearchHistory.remove).toHaveBeenCalledWith('remove me');
    expect(navigate).not.toHaveBeenCalled();
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Search again: remove me',
      }),
    ).toHaveLength(0);
  });

  test('the bottom engine icon changes the provider and closes its menu', async () => {
    expect(
      view.root.findAllByProps({ accessibilityLabel: 'Browser back' }),
    ).toHaveLength(0);
    await press('Change browser search engine');
    expect(
      control('Search with Google').props.accessibilityState.selected,
    ).toBe(true);
    await press('Search with Brave');
    expect(browserPreferences.getSnapshot().searchEngine).toBe('brave');
    expect(
      control('Change browser search engine').props.accessibilityState.expanded,
    ).toBe(false);
    expect(
      view.root.findAllByProps({ accessibilityLabel: 'Search with Google' }),
    ).toHaveLength(0);
    await act(async () => control('Browser address or search').props.onFocus());
    expect(control('Browser address or search').props.placeholder).toBe(
      'Search or type URL',
    );
  });

  test('a website shows a site button and a compact address, while editing restores search and QR controls', async () => {
    const tabId = session.entry.controller.selectedTabId;
    await act(async () =>
      session.entry.controller.navigation(tabId, {
        url: 'https://google.com/search?q=proot+ubuntu',
        title: 'Search',
        canGoBack: false,
        canGoForward: false,
        loading: false,
      }),
    );
    expect(control('Current browser address').children).toEqual([
      'google.com/search?q=proot+ubuntu',
    ]);
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Browser address or search',
      }),
    ).toHaveLength(0);
    expect(
      view.root.findAllByProps({
        accessibilityLabel: 'Change browser search engine',
      }),
    ).toHaveLength(0);
    await press('Open site information');
    expect(control('Connection is secure')).toBeDefined();
    expect(control('Cookies and site data')).toBeDefined();
    expect(control('Permissions')).toBeDefined();
    await press('Close browser panel');
    await press('Edit browser address');
    expect(control('Browser address or search').props.autoFocus).toBe(true);
    expect(control('Change browser search engine')).toBeDefined();
    expect(control('Scan QR code')).toBeDefined();
  });

  test('the tab count opens a picker that switches tabs without remounting their renderers', async () => {
    const first = session.entry.controller.selectedTabId;
    await act(async () => {
      session.entry.controller.newTab();
    });
    await layoutBrowserViews(view);
    const mounts = mockMounted;
    expect(control('Open browser tabs').props.accessibilityHint).toBe(
      '2 open tabs',
    );
    await press('Open browser tabs');
    await press(`Switch to browser tab ${first}`);
    expect(session.entry.controller.selectedTabId).toBe(first);
    expect(control('Open browser tabs').props.accessibilityState.expanded).toBe(
      false,
    );
    expect(mockMounted).toBe(mounts);
    await press('Open browser tabs');
    await press('New browser tab');
    expect(navigate).toHaveBeenCalledWith('new_tab', {});
  });

  test('the tab picker keeps creation available beyond three tabs', async () => {
    await act(async () => {
      for (let index = 0; index < 4; index++) session.entry.controller.newTab();
    });
    await press('Open browser tabs');
    expect(control('New browser tab').props.disabled).toBeFalsy();
    expect(control('Open browser tabs').props.accessibilityHint).toBe(
      '5 open tabs',
    );
    await press('New browser tab');
    expect(navigate).toHaveBeenCalledWith('new_tab', {});
  });

  test('the three-dot menu exposes navigation and opens browser settings in place', async () => {
    await press('Open browser menu');
    expect(control('Browser back').props.disabled).toBe(true);
    expect(control('Reload browser')).toBeDefined();
    await press('Open browser settings');
    expect(
      view.root.findAllByProps({ accessibilityLabel: 'Open browser menu' }),
    ).toHaveLength(0);
    expect(view.root.findByType('BrowserSettings' as never)).toBeTruthy();
    await press('Close browser panel');
    expect(browserRegistry.visibleId).toBe(session.identity.sessionId);
    expect(view.root.findAllByType('BrowserSettings' as never)).toHaveLength(0);
    await press('Open browser menu');
    await press('Close browser');
    expect(browserRegistry.visibleId).toBeNull();
  });
});
