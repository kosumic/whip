import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserSurface } from '../src/browser/BrowserSurface';
import {
  browserRegistry,
  connectedBrowserRuntimes,
} from '../src/browser/registry';
import { prepareBrowserView } from '../src/browser/native';
import {
  browserPreferences,
  DEFAULT_BROWSER_PREFERENCES,
} from '../src/browser/preferences';

let mockMounted = 0;
let mockUnmounted = 0;
let mockRendered = 0;
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value },
  BackHandler: { addEventListener: () => ({ remove: jest.fn() }) },
  findNodeHandle: () => 42,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: React.forwardRef(
      (props: { source: { uri: string } }, ref: object) => {
        mockRendered++;
        React.useImperativeHandle(ref, () => ({
          documentUrl: props.source.uri,
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
  }),
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
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

test('host snapshot refresh retains the visible page until SSH disconnects', async () => {
  const { identity, runtime, entry } = browserSession('snapshot-refresh');
  const getRuntime = (id: string) =>
    id === runtime.runtimeId ? runtime : undefined;
  const runtimesFor = (status: 'ready' | 'connected' | 'reconnecting') =>
    connectedBrowserRuntimes([{ id: runtime.runtimeId, status }], getRuntime);
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
    for (const status of ['connected', 'ready'] as const) {
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
      view.update(<BrowserSurface runtimes={runtimesFor('reconnecting')} />);
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

test('a shared renderer crash preserves both tabs and reload restores only the selected page', async () => {
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
      webView.props.onRenderProcessGone();
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
  expect(view.root.findByType('BrowserWebView' as never).props.source.uri).toBe(
    'https://reddit.com/',
  );
  expect(first.lifecycle).toBe('crashed');
  await act(async () => {
    await browserRegistry.close(identity.sessionId);
    view.unmount();
  });
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
    await expect(entry.controller.action('snapshot')).resolves.toMatchObject({
      title: 'Shared page',
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
      .action('snapshot')
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
    await expect(entry.controller.action('snapshot')).resolves.toMatchObject({
      title: 'Shared page',
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
    const viewport = () =>
      view.root.findAllByProps({ collapsable: false })[0].props.style;
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
