import { createRef } from 'react';
import { runInNewContext } from 'node:vm';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import {
  TerminalRendererHost,
  type TerminalRendererHandle,
} from '../src/components/TerminalRendererHost';
import type { TerminalControlEvent, TerminalOutput } from '../src/lib/terminalBridge';
import type { TerminalRenderTarget } from '../src/lib/terminalRenderer';
import { MIN_XTERM_CACHE_CAPACITY } from '../src/lib/terminalRendererLru';
import type { TerminalPreferences } from '../src/services/devicePreferences';
import type { TerminalBatchRenderer } from '../src/services/TerminalBridgeController';

jest.mock('expo/virtual/env', () => ({ env: {} }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => {
  const mockListeners = new Set<(mockState: string) => void>();
  return {
    AppState: {
      currentState: 'active',
      listeners: mockListeners,
      addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
        mockListeners.add(listener);
        return { remove: () => mockListeners.delete(listener) };
      }),
    },
    Platform: {
      OS: 'android',
      select: (options: Record<string, unknown>) => options.android,
    },
  };
});
jest.mock('react-native-reanimated', () => ({
  useAnimatedReaction: jest.fn(),
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    callback(...args),
}));
jest.mock('react-native-webview', () => ({
  __esModule: true,
  default: 'WebView',
}));
jest.mock('../src/services/networkDiagnostics', () => ({
  networkErrorMessage: (reason: unknown) => String(reason),
  recordNetworkDiagnostic: jest.fn(),
}));
jest.mock(
  '../src/services/performanceTrace',
  () =>
    new Proxy(
      { __esModule: true },
      {
        get: (target, property) =>
          property in target
            ? target[property as keyof typeof target]
            : jest.fn(() => null),
      },
    ),
);
jest.mock('../src/services/terminalAssets', () => ({
  IOS_TERMINAL_ASSETS: null,
}));

const mockAppState = jest.requireMock('react-native').AppState as {
  currentState: string;
  listeners: Set<(state: string) => void>;
  addEventListener: jest.Mock;
};

const preferences: TerminalPreferences = {
  fullscreen: true,
  useModifierKeyIcons: false,
  volumeUpAction: 'none',
  volumeDownAction: 'none',
  fontSize: 14,
  scrollback: 2000,
  xtermCacheCapacity: 4,
  cursorBlink: true,
  doubleTapAction: 'none',
  pauseResizeInBackground: false,
  visualHints: false,
  backgroundImageUri: null,
  backgroundDimming: 0,
};

describe('TerminalRendererHost lifecycle', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    mockAppState.currentState = 'active';
    mockAppState.listeners.clear();
    mockAppState.addEventListener.mockClear();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  const createCallbacks = () => ({
    onInput: jest.fn(),
    onScroll: jest.fn(),
    onOfflineScroll: jest.fn(),
    onOfflineSnapshot: jest.fn(),
    onSearchResult: jest.fn(),
    onLinksScanned: jest.fn(),
    onOpenLink: jest.fn(),
    onPaste: jest.fn(),
    onAddToComposer: jest.fn(),
    onBufferModeChange: jest.fn(),
    onVisualScrollState: jest.fn(),
    onScrollActivity: jest.fn(),
    onProtocolStateChange: jest.fn(),
    onTitleChange: jest.fn(),
    onFontSizeChange: jest.fn(),
    onStatus: jest.fn(),
    onError: jest.fn(),
  });

  const createClient = (
    paneScrolls: Record<
      string,
      {
        offset_from_bottom: number;
        max_offset_from_bottom: number;
        viewport_rows: number;
      }
    >,
  ) => {
    const retained = new Set<string>();
    let nextAttachmentId = 0;
    let frameHandler: ((frame: TerminalOutput) => void) | null = null;
    let closedHandler: ((reason?: string) => void) | undefined;
    let controlHandler: ((event: TerminalControlEvent) => void) | undefined;
    const closeTerminalBridge = jest.fn((terminalId: string) => {
      retained.delete(terminalId);
    });
    const detachTerminal = jest.fn(
      (_terminalId: string, _attachmentId: unknown): void => undefined,
    );
    const isTerminalBridgeRetained = jest.fn((terminalId = 'term-1') => retained.has(terminalId));
    const openTerminal = jest.fn(
      async (
        terminalId: string,
        onFrame: (frame: TerminalOutput) => void,
        onClosed?: (reason?: string) => void,
        onControl?: (event: TerminalControlEvent) => void,
        _initialGeometry?: unknown,
        _renderer?: TerminalBatchRenderer,
      ) => {
        retained.add(terminalId);
        frameHandler = onFrame;
        closedHandler = onClosed;
        controlHandler = onControl;
        return { testAttachmentId: ++nextAttachmentId };
      },
    );
    const releaseTerminal = jest.fn(
      (terminalId: string, _attachmentId: unknown): void => {
        retained.delete(terminalId);
        frameHandler = null;
        closedHandler = undefined;
      },
    );
    const resizeTerminal = jest.fn(async () => undefined);
    const scrollTerminal = jest.fn(async () => '');
    return {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
        openTerminal,
        releaseTerminal,
        resizeTerminal,
        scrollTerminal,
        acknowledgeTerminalBatch: jest.fn(),
      },
      native: {
        requestHerdrApi: jest.fn(async () => ({ type: 'ok' as const })),
        readTerminalSelection: jest.fn(async () => 'server selection'),
        submitPastes: jest.fn(async () => undefined),
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
      emitFrame: (frame: TerminalOutput) => frameHandler?.(frame),
      emitControl: (event: TerminalControlEvent) => controlHandler?.(event),
      disconnect: (terminalId = 'term-1') => {
        retained.delete(terminalId);
        closedHandler?.('Transport disconnected');
      },
      openTerminal,
      releaseTerminal,
      resizeTerminal,
      scrollTerminal,
      snapshot: jest.fn(async () => ({
        panes: Object.entries(paneScrolls).map(([terminalId, scroll]) => ({
          terminal_id: terminalId,
          scroll,
        })),
      })),
    };
  };

  const createTarget = (
    terminalId: string,
    client: ReturnType<typeof createClient>,
    scroll: {
      offset_from_bottom: number;
      max_offset_from_bottom: number;
      viewport_rows: number;
    },
  ) =>
    ({
      key: `host-1:${terminalId}`,
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId,
        paneId: `pane-${terminalId}`,
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
      scroll,
    } as unknown as TerminalRenderTarget);

  const emitAppState = async (state: string) => {
    await act(async () => {
      mockAppState.currentState = state;
      for (const listener of mockAppState.listeners) listener(state);
      await Promise.resolve();
    });
  };

  const sendRendererMessage = async (
    webView: ReactTestInstance,
    message: Record<string, unknown>,
  ) => {
    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: { data: JSON.stringify(message) },
      });
      await Promise.resolve();
    });
  };

  const mountReadyHost = async (
    activeTarget: TerminalRenderTarget,
    targets: TerminalRenderTarget[] = [activeTarget],
    pauseResizeInBackground = true,
    xtermCacheCapacity = preferences.xtermCacheCapacity,
  ) => {
    const eventCallbacks = createCallbacks();
    const injected: string[] = [];
    const handle = createRef<TerminalRendererHandle>();
    const requestFocus = jest.fn();
    const renderHost = (
      target: TerminalRenderTarget,
      renderingEnabled = true,
      visible = true,
      fontSize = preferences.fontSize,
    ) => (
      <TerminalRendererHost
        ref={handle}
        {...eventCallbacks}
        activeTarget={target}
        preferences={{ ...preferences, fontSize, pauseResizeInBackground, xtermCacheCapacity }}
        targets={targets}
        visible={visible}
        renderingEnabled={renderingEnabled}
      />
    );
    await act(async () => {
      renderer = create(
        renderHost(activeTarget),
        {
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus,
                }
              : null,
        },
      );
    });
    const webView = renderer.root.find(
      node => typeof node.props.onMessage === 'function',
    );
    await sendRendererMessage(webView, { type: 'ready' });
    await sendRendererMessage(webView, {
      type: 'terminal-ready',
      key: activeTarget.key,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: activeTarget.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });
    const activateTarget = async (target: TerminalRenderTarget) => {
      await act(async () => {
        renderer.update(renderHost(target));
        await Promise.resolve();
      });
    };
    const setPresentation = async (renderingEnabled: boolean, visible = true) => {
      await act(async () => { renderer.update(renderHost(activeTarget, renderingEnabled, visible)); });
    };
    const setFontPreference = async (
      fontSize: number,
      target = activeTarget,
    ) => {
      await act(async () => {
        renderer.update(renderHost(target, true, true, fontSize));
        await Promise.resolve();
      });
    };
    return {
      activateTarget,
      setPresentation,
      setFontPreference,
      eventCallbacks,
      handle,
      injected,
      requestFocus,
      webView,
    };
  };

  test('credits only the current renderer generation after a completed batch', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected } = await mountReadyHost(target);
    const delivery = client.openTerminal.mock.calls.at(-1)?.[5];
    expect(delivery).toBeDefined();
    delivery!.onBatch({ batchId: '7', json: '[]', chunkCount: 1, payloadBytes: 3 }, '99', 123);
    expect(injected.at(-1)).toContain('window.herdrDeliverBatch([]');
    const written = {
      type: 'terminal-batch-written', key: target.key, identity: delivery!.identity,
      generation: '99', batchId: '7', inboundCookie: 123, localMs: 2, base64Ms: 0.1,
    };
    await sendRendererMessage(webView, { ...written, identity: 'retired' });
    await sendRendererMessage(webView, { ...written, generation: '98' });
    expect(client.terminal.acknowledgeTerminalBatch).not.toHaveBeenCalled();
    await sendRendererMessage(webView, written);
    expect(client.terminal.acknowledgeTerminalBatch).toHaveBeenCalledWith('term-1', delivery!.identity, '99', '7');
  });

  test('writes graphics intact between consecutive terminal repaint frames', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { injected } = await mountReadyHost(target);
    const frame = {
      type: 'terminal.frame' as const,
      encoding: 'ansi' as const,
      seq: 7, full: true, width: 80, height: 24,
      bytes: Buffer.from('before').toString('base64'),
      final: true,
    };
    act(() => client.emitFrame(frame));
    injected.length = 0;
    client.resizeTerminal.mockClear();
    const protocol = '\u001b_Ga=T,f=24,s=128,t=d,m=0;' + 'abcd'.repeat(20_000) + '\u001b\\';
    const image = new TextEncoder().encode(protocol);
    const storage = new Uint8Array(image.length + 2);
    storage.set(image, 1);
    act(() => {
      client.emitFrame({ type: 'terminal.graphics', bytes: storage.subarray(1, -1) });
      client.emitFrame({ ...frame, seq: 8, full: false, bytes: Buffer.from('after').toString('base64') });
    });

    const written: string[] = [];
    const pending = new Map<number, string>();
    const window = {
      herdrWriteBase64Chunk: (key: string, sequence: number, data: string, final: boolean) => {
        expect(key).toBe(target.key);
        const encoded = (pending.get(sequence) || '') + data;
        if (final) {
          written.push(Buffer.from(encoded, 'base64').toString('utf8'));
          pending.delete(sequence);
        } else {
          pending.set(sequence, encoded);
        }
      },
    };
    for (const script of injected) runInNewContext(script, { window });
    expect(written).toEqual([protocol, 'after']);
    expect(pending.size).toBe(0);
    expect(client.resizeTerminal).not.toHaveBeenCalled();
  });

  test('forwards SSH byte views without UTF-8 loss or surrounding buffer bytes', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({});
    const base = createTarget('ssh-shell', client, scroll);
    const target = { ...base, session: { ...base.session, kind: 'ssh' as const } };
    const { injected } = await mountReadyHost(target);
    injected.length = 0;
    const storage = Uint8Array.of(42, 0xff, 0, 0xe7, 0x95, 0x8c, 43);
    act(() => client.emitFrame({
      type: 'terminal.frame', encoding: 'utf8', seq: 1, full: false,
      width: 80, height: 24, bytes: storage.subarray(1, -1),
    }));
    const written: Buffer[] = [];
    const window = {
      herdrReset: jest.fn(),
      herdrWriteBase64Chunk: (_key: string, _sequence: number, data: string) => written.push(Buffer.from(data, 'base64')),
    };
    for (const script of injected) runInNewContext(script, { window });
    expect(Buffer.concat(written)).toEqual(Buffer.from(storage.subarray(1, -1)));
  });

  test('reads context for its requesting pane and drops it after switching panes', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll, 'term-2': scroll });
    const first = createTarget('term-1', client, scroll);
    const second = createTarget('term-2', client, scroll);
    const { handle, webView, activateTarget } = await mountReadyHost(first, [first, second]);
    const context = handle.current!.readContext();
    await sendRendererMessage(webView, { type: 'dictation-context', key: first.key, requestId: 1, text: 'WhipSsh terminal context' });
    expect(await context).toBe('WhipSsh terminal context');
    const stale = handle.current!.readContext();
    await activateTarget(second);
    await sendRendererMessage(webView, { type: 'dictation-context', key: first.key, requestId: 2, text: 'Old pane text' });
    expect(await stale).toBe('');
  });

  test('pauses painting under chat without releasing the terminal, then restores presentation', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { injected, setPresentation } = await mountReadyHost(target);
    injected.length = 0;
    await setPresentation(false);
    expect(injected).toContain('window.herdrActivate(null); true;');
    expect(client.terminal.releaseTerminal).not.toHaveBeenCalled();
    expect(client.terminal.detachTerminal).not.toHaveBeenCalled();
    injected.length = 0;
    await setPresentation(true);
    expect(injected).toContain(`window.herdrActivate(${JSON.stringify(target.key)}); true;`);
    injected.length = 0;
    await setPresentation(true, false);
    expect(injected).toContain('window.herdrActivate(null); true;');
  });

  test('a WebView reload under chat does not reveal the terminal', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { injected, setPresentation, webView } = await mountReadyHost(target);
    await setPresentation(false);
    injected.length = 0;
    await sendRendererMessage(webView, { type: 'ready' });
    expect(injected.filter(script => script.includes('window.herdrActivate(')))
      .toEqual(['window.herdrActivate(null); true;']);
  });

  test('touches do not take WebView focus while terminal keyboard input is disabled', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { handle, injected, requestFocus, webView } = await mountReadyHost(target);

    for (const enabled of [true, false, true]) {
      act(() => handle.current?.setKeyboardEnabled(enabled));
      expect(injected.at(-1)).toContain(`herdrSetKeyboardEnabled("${target.key}", ${enabled})`);
      requestFocus.mockClear();
      injected.length = 0;
      act(() => { webView.props.onTouchStart(); });
      expect(requestFocus).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) expect(injected.at(-1)).toContain(`herdrFocus("${target.key}")`);
      else expect(injected).toEqual([]);
    }
  });

  test('metadata updates do not reactivate the selected terminal; tab changes do', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll, 'term-2': scroll });
    const first = createTarget('term-1', client, scroll);
    const second = createTarget('term-2', client, scroll);
    const { activateTarget, injected } = await mountReadyHost(first, [first, second]);
    injected.length = 0;

    await activateTarget({
      ...first,
      session: { ...first.session, title: 'updated shell' },
      scroll: { ...scroll, max_offset_from_bottom: 200 },
    });
    expect(injected.filter(script => script.includes('window.herdrActivate('))).toEqual([]);

    await activateTarget(second);
    expect(injected).toContain(`window.herdrActivate(${JSON.stringify(second.key)}); true;`);
    injected.length = 0;
    await activateTarget(first);
    expect(injected).toContain(`window.herdrActivate(${JSON.stringify(first.key)}); true;`);
  });

  test('a global font preference change resets every persisted pane zoom', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 };
    const client = createClient({
      'term-1': scroll,
      'term-2': scroll,
      'term-3': scroll,
      'term-4': scroll,
      'term-5': scroll,
    });
    const first = createTarget('term-1', client, scroll);
    const second = createTarget('term-2', client, scroll);
    const third = createTarget('term-3', client, scroll);
    const unzoomed = createTarget('term-4', client, scroll);
    const nonresidentUnzoomed = createTarget('term-5', client, scroll);
    first.session.fontSize = 10;
    second.session.fontSize = 12;
    third.session.fontSize = 14;
    const {
      activateTarget,
      eventCallbacks,
      injected,
      setFontPreference,
    } = await mountReadyHost(
      first,
      [first, second, third, unzoomed, nonresidentUnzoomed],
    );
    await activateTarget(unzoomed);
    eventCallbacks.onFontSizeChange.mockClear();
    injected.length = 0;

    await setFontPreference(16, second);

    expect(eventCallbacks.onFontSizeChange.mock.calls).toEqual([
      [first, 16],
      [second, 16],
      [third, 16],
    ]);
    for (const target of [second, unzoomed]) {
      expect(injected.some(script =>
        script.includes(`window.herdrConfigure(${JSON.stringify(target.key)}`)
        && script.includes('"fontSize":16'),
      )).toBe(true);
    }

    eventCallbacks.onFontSizeChange.mockClear();
    await setFontPreference(16, second);
    expect(eventCallbacks.onFontSizeChange).not.toHaveBeenCalled();
  });

  test('a global font preference change replaces a locally pending pane zoom', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { eventCallbacks, setFontPreference, webView } = await mountReadyHost(target);

    await sendRendererMessage(webView, {
      type: 'font-size-change',
      key: target.key,
      fontSize: 20,
    });
    eventCallbacks.onFontSizeChange.mockClear();

    await setFontPreference(16);

    expect(eventCallbacks.onFontSizeChange).toHaveBeenCalledWith(target, 16);
  });

  test('ordinary fit resize requests use native geometry deduplication', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView } = await mountReadyHost(target);
    client.resizeTerminal.mockClear();

    await sendRendererMessage(webView, {
      type: 'resize', source: 'fit', key: target.key,
      cols: 90, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(client.resizeTerminal).toHaveBeenCalledWith('term-1', 90, 30, 8, 16, null);
  });

  test('an unchanged fit retries a failed resize and then stops dispatching', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView } = await mountReadyHost(target);
    client.resizeTerminal.mockClear();
    client.resizeTerminal.mockRejectedValueOnce(new Error('resize failed'));

    await expect(sendRendererMessage(webView, {
      type: 'resize', source: 'fit', key: target.key,
      cols: 90, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    })).rejects.toThrow('resize failed');
    await sendRendererMessage(webView, { type: 'fit-complete', key: target.key });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(2);
    expect(client.resizeTerminal).toHaveBeenLastCalledWith('term-1', 90, 30, 8, 16);
    await sendRendererMessage(webView, { type: 'fit-complete', key: target.key });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(2);
  });

  test('forwards and replays application mouse capture when the WebView reloads', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected } = await mountReadyHost(target);
    const captureScript = `window.herdrSetApplicationMouseCapture(${JSON.stringify(target.key)}, true);`;

    act(() => client.emitControl({ type: 'mouse-capture', enabled: true }));
    expect(injected.at(-1)).toContain(captureScript);
    injected.length = 0;
    await sendRendererMessage(webView, { type: 'ready' });
    expect(injected.some(script => script.includes(captureScript))).toBe(true);

    act(() => client.emitControl({ type: 'mouse-capture', enabled: false }));
    expect(injected.at(-1)).toContain(`window.herdrSetApplicationMouseCapture(${JSON.stringify(target.key)}, false);`);
  });

  test('copies terminal text and pastes clipboard text through the maintained native module', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, eventCallbacks } = await mountReadyHost(target);
    const text = 'printf "你好 🌍"';

    await sendRendererMessage(webView, { type: 'clipboard-write', key: target.key, text });
    expect(Clipboard.setString).toHaveBeenCalledWith(text);

    jest.mocked(Clipboard.getString).mockResolvedValueOnce(text);
    await sendRendererMessage(webView, { type: 'clipboard-read', key: target.key });
    expect(client.native.requestHerdrApi).toHaveBeenCalledWith({
      method: 'pane.send_input',
      params: { pane_id: target.session.paneId, text, keys: [] },
    });
    expect(eventCallbacks.onPaste).toHaveBeenCalledWith(target, text);
  });

  test('application clipboard replies pass through the pending selection guard', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected } = await mountReadyHost(target);
    const text = 'Hi! What would you like to work on?';
    jest.mocked(Clipboard.setString).mockClear();
    act(() => client.emitControl({ type: 'clipboard-write', text }));
    expect(injected.at(-1)).toContain(`window.herdrClipboardWrite(${JSON.stringify(target.key)}, ${JSON.stringify(text)});`);
    expect(Clipboard.setString).not.toHaveBeenCalled();

    await sendRendererMessage(webView, { type: 'clipboard-write', key: target.key, text });
    expect(Clipboard.setString).toHaveBeenCalledWith(text);
  });

  test('a renderer clipboard request with no text sends no terminal input', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, eventCallbacks } = await mountReadyHost(target);
    client.native.requestHerdrApi.mockClear();
    jest.mocked(Clipboard.getString).mockResolvedValueOnce('');

    await sendRendererMessage(webView, { type: 'clipboard-read', key: target.key });

    expect(client.native.requestHerdrApi).not.toHaveBeenCalled();
    expect(eventCallbacks.onPaste).not.toHaveBeenCalled();
  });

  test('reads Herdr selections on the server before completing clipboard copy', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 2 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected } = await mountReadyHost(target);
    const selection = {
      columns: 12, text: 'abcdefghijkl\nmnop', rows: ['abcdefghijkl', 'mnop'], offsetFromBottom: 0,
      startRow: 0, startColumn: 0, endRow: 1, endColumn: 4,
    };
    client.native.readTerminalSelection.mockResolvedValueOnce('abcdefghijklmnop\nreal newline');
    jest.mocked(Clipboard.setString).mockClear();
    await sendRendererMessage(webView, { type: 'selection-copy', key: target.key, requestId: 17, selection });
    expect(client.native.readTerminalSelection).toHaveBeenCalledWith('term-1', 'pane-term-1', selection);
    expect(injected.at(-1)).toContain('window.herdrSelectionCopied("host-1:term-1", 17, "abcdefghijklmnop\\nreal newline");');
    expect(Clipboard.setString).not.toHaveBeenCalled();
  });

  test('routes selected text to the active composer without clipboard or terminal writes', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 2 };
    const client = createClient({ 'term-1': scroll, 'term-2': scroll });
    const target = createTarget('term-1', client, scroll);
    const other = createTarget('term-2', client, scroll);
    const { webView, eventCallbacks, setPresentation } = await mountReadyHost(target, [target, other]);
    jest.mocked(Clipboard.setString).mockClear();
    client.native.requestHerdrApi.mockClear();
    const message = { type: 'composer-add', key: target.key, text: 'selected\ntext' };
    await sendRendererMessage(webView, message);
    expect(eventCallbacks.onAddToComposer).toHaveBeenCalledWith(target, message.text);
    expect(Clipboard.setString).not.toHaveBeenCalled();
    expect(client.native.requestHerdrApi).not.toHaveBeenCalled();
    expect(eventCallbacks.onInput).not.toHaveBeenCalled();
    eventCallbacks.onAddToComposer.mockClear();
    await sendRendererMessage(webView, { ...message, key: other.key });
    await sendRendererMessage(webView, { ...message, text: 123 });
    await sendRendererMessage(webView, { ...message, text: '' });
    await setPresentation(false);
    await sendRendererMessage(webView, message);
    await setPresentation(true, false);
    await sendRendererMessage(webView, message);
    expect(eventCallbacks.onAddToComposer).not.toHaveBeenCalled();
  });

  test('returns a failed server copy to the renderer for local fallback', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 2 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected, eventCallbacks } = await mountReadyHost(target);
    client.native.readTerminalSelection.mockRejectedValueOnce(new Error('stale_content'));
    jest.mocked(Clipboard.setString).mockClear();
    await sendRendererMessage(webView, {
      type: 'selection-copy', key: target.key, requestId: 18,
      selection: { columns: 12, text: 'text', rows: ['text', ''], startRow: 0, startColumn: 0, endRow: 0, endColumn: 4, offsetFromBottom: 0 },
    });
    expect(injected.at(-1)).toContain('window.herdrSelectionCopied("host-1:term-1", 18, null);');
    expect(Clipboard.setString).not.toHaveBeenCalled();
    expect(eventCallbacks.onError).not.toHaveBeenCalled();
  });

  test('rejects malformed selection coordinates before reaching the native runtime', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 2 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView, injected } = await mountReadyHost(target);
    await sendRendererMessage(webView, {
      type: 'selection-copy', key: target.key, requestId: 19,
      selection: { columns: 12, text: 'text', rows: ['text'], startRow: -1, startColumn: 0, endRow: 0, endColumn: 4, offsetFromBottom: 0 },
    });
    expect(client.native.readTerminalSelection).not.toHaveBeenCalled();
    expect(injected.at(-1)).toContain('window.herdrSelectionCopied("host-1:term-1", 19, null);');
  });

  test('closes the native bridge when a terminal target is removed', () => {
    const closeTerminalBridge = jest.fn();
    const detachTerminal = jest.fn();
    const isTerminalBridgeRetained = jest.fn(() => false);
    const client = {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
    };
    const target = {
      key: 'host-1:term-1',
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId: 'term-1',
        paneId: 'pane-1',
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
    } as unknown as TerminalRenderTarget;
    const callbacks = {
      onInput: jest.fn(),
      onScroll: jest.fn(),
      onOfflineScroll: jest.fn(),
      onOfflineSnapshot: jest.fn(),
      onSearchResult: jest.fn(),
      onLinksScanned: jest.fn(),
      onOpenLink: jest.fn(),
      onPaste: jest.fn(),
      onBufferModeChange: jest.fn(),
      onVisualScrollState: jest.fn(),
      onProtocolStateChange: jest.fn(),
      onTitleChange: jest.fn(),
      onFontSizeChange: jest.fn(),
      onStatus: jest.fn(),
      onError: jest.fn(),
    };

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
        />,
      );
    });
    expect(client.closeTerminalBridge).not.toHaveBeenCalled();

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={null}
          preferences={preferences}
          targets={[]}
          visible
        />,
      );
    });

    expect(client.closeTerminalBridge).toHaveBeenCalledWith('term-1');
    expect(client.detachTerminal).not.toHaveBeenCalled();
  });

  test('updates visual insets without fitting or resizing the terminal', async () => {
    const injected: string[] = [];
    const closeTerminalBridge = jest.fn();
    const detachTerminal = jest.fn();
    const isTerminalBridgeRetained = jest.fn(() => false);
    const client = {
      terminal: {
        closeTerminalBridge,
        detachTerminal,
        isTerminalBridgeRetained,
      },
      closeTerminalBridge,
      detachTerminal,
      isTerminalBridgeRetained,
    };
    const target = {
      key: 'host-1:term-1',
      hostSessionId: 'host-1',
      client,
      session: {
        terminalId: 'term-1',
        paneId: 'pane-1',
        title: 'shell',
        kind: 'herdr',
        status: 'connected',
        reconnectAttempt: 0,
      },
    } as unknown as TerminalRenderTarget;
    const callbacks = {
      onInput: jest.fn(),
      onScroll: jest.fn(),
      onOfflineScroll: jest.fn(),
      onOfflineSnapshot: jest.fn(),
      onSearchResult: jest.fn(),
      onLinksScanned: jest.fn(),
      onOpenLink: jest.fn(),
      onPaste: jest.fn(),
      onBufferModeChange: jest.fn(),
      onVisualScrollState: jest.fn(),
      onProtocolStateChange: jest.fn(),
      onTitleChange: jest.fn(),
      onFontSizeChange: jest.fn(),
      onStatus: jest.fn(),
      onError: jest.fn(),
    };
    const visualViewport = {
      insets: { top: 55, bottom: 84 },
      geometryBottomInset: 84,
      scroll: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 100,
        viewport_rows: 24,
      },
    };

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={visualViewport}
        />,
        {
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus: jest.fn(),
                }
              : null,
        },
      );
    });
    const webView = renderer.root.find(
      node => typeof node.props.onMessage === 'function',
    );
    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'ready' }) },
      });
    });
    injected.length = 0;

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={{
            ...visualViewport,
            alternateScreen: true,
            insets: { top: 92, bottom: 196 },
          }}
        />,
      );
    });

    expect(injected.join('\n')).toContain('window.herdrSetVisualInsets');
    expect(injected.join('\n')).toContain('"alternateScreen":true');
    expect(injected.join('\n')).toContain('"debug":false');
    expect(injected.join('\n')).not.toContain('window.herdrFit');
    expect(client).not.toHaveProperty('resizeTerminal');

    injected.length = 0;
    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...callbacks}
          activeTarget={target}
          preferences={{ ...preferences, visualHints: true }}
          targets={[target]}
          visible
          visualViewport={visualViewport}
        />,
      );
    });

    expect(injected.join('\n')).toContain('"debug":true');
    expect(injected.join('\n')).not.toContain('window.herdrFit');
  });

  test('scrollToVisualBottom synchronizes remote rows and invokes the renderer', () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 100,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, {
      offset_from_bottom: 17,
      max_offset_from_bottom: 100,
      viewport_rows: 24,
    });
    const callbacks = createCallbacks();
    const handle = createRef<TerminalRendererHandle>();
    const injected: string[] = [];

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          ref={handle}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={{
            insets: { top: 0, bottom: 84 },
            geometryBottomInset: 0,
            scroll: target.scroll,
          }}
        />,
        {
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus: jest.fn(),
                }
              : null,
        },
      );
    });

    act(() => handle.current?.scrollToVisualBottom());

    expect(callbacks.onScroll).toHaveBeenCalledWith(target, 'down', 17);
    expect(client.scrollTerminal).toHaveBeenCalledWith('term-1', 'down', 17);
    expect(injected.join('\n')).toContain('window.herdrScrollToVisualBottom');
    expect(callbacks.onVisualScrollState).not.toHaveBeenCalled();
  });

  test('scrollToVisualBottom still invokes the reveal when remote rows are already latest', () => {
    const client = createClient({});
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 100,
      viewport_rows: 24,
    });
    const callbacks = createCallbacks();
    const handle = createRef<TerminalRendererHandle>();
    const injected: string[] = [];

    act(() => {
      renderer = create(
        <TerminalRendererHost
          {...callbacks}
          ref={handle}
          activeTarget={target}
          preferences={preferences}
          targets={[target]}
          visible
          visualViewport={{
            insets: { top: 0, bottom: 84 },
            geometryBottomInset: 0,
            scroll: target.scroll,
          }}
        />,
        {
          createNodeMock: element =>
            element.type === 'WebView'
              ? {
                  injectJavaScript: (script: string) => injected.push(script),
                  requestFocus: jest.fn(),
                }
              : null,
        },
      );
    });

    act(() => handle.current?.scrollToVisualBottom());

    expect(client.scrollTerminal).not.toHaveBeenCalled();
    expect(injected.join('\n')).toContain('window.herdrScrollToVisualBottom');
  });

  test('reports visual-bottom state from the renderer without inferring it from rows', async () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 100,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 100,
      viewport_rows: 24,
    });
    const { eventCallbacks, webView } = await mountReadyHost(target);

    await sendRendererMessage(webView, {
      type: 'scroll-activity',
      key: target.key,
      scrolling: true,
    });
    await sendRendererMessage(webView, {
      type: 'scroll-activity',
      key: target.key,
      scrolling: false,
    });
    expect(eventCallbacks.onScrollActivity.mock.calls).toEqual([
      [target, true],
      [target, false],
    ]);

    await sendRendererMessage(webView, {
      type: 'visual-scroll-state',
      key: target.key,
      atVisualBottom: false,
    });
    await sendRendererMessage(webView, {
      type: 'visual-scroll-state',
      key: target.key,
      atVisualBottom: true,
    });

    expect(eventCallbacks.onVisualScrollState).toHaveBeenNthCalledWith(
      1,
      target,
      false,
    );
    expect(eventCallbacks.onVisualScrollState).toHaveBeenNthCalledWith(
      2,
      target,
      true,
    );
  });

  test('live frames make lifecycle transitions persist the renderer cache', async () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 24,
    });
    const { injected } = await mountReadyHost(target);
    injected.length = 0;

    act(() => {
      client.emitFrame({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'utf8',
        width: 80,
        height: 24,
        full: true,
        bytes: 'live output',
      });
    });
    expect(injected.join('\n')).toContain('window.herdrWrite');

    injected.length = 0;
    await emitAppState('background');
    expect(injected.join('\n')).toContain('window.herdrSnapshot');
    expect(injected.join('\n')).toContain('background');
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'restores the prior offset without new output',
      checkpoint: {
        offset_from_bottom: 200,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      expected: ['up', 200] as const,
    },
    {
      name: 'adds background scrollback growth to the prior offset',
      checkpoint: {
        offset_from_bottom: 200,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_050,
        viewport_rows: 24,
      },
      expected: ['up', 250] as const,
    },
    {
      name: 'keeps following latest output',
      checkpoint: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_100,
        viewport_rows: 24,
      },
      expected: null,
    },
    {
      name: 'clamps the prior offset when scrollback shrinks',
      checkpoint: {
        offset_from_bottom: 500,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
      current: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 300,
        viewport_rows: 24,
      },
      expected: ['up', 300] as const,
    },
  ])(
    '$name after foreground and an unchanged final fit',
    async ({ checkpoint, current, expected }) => {
      const client = createClient({ 'term-1': current });
      const target = createTarget('term-1', client, checkpoint);
      const { webView } = await mountReadyHost(target);
      const resizeCount = client.resizeTerminal.mock.calls.length;

      await emitAppState('background');
      await emitAppState('active');
      expect(client.snapshot).not.toHaveBeenCalled();
      expect(client.scrollTerminal).not.toHaveBeenCalled();
      await sendRendererMessage(webView, {
        type: 'fit-complete',
        key: target.key,
      });

      expect(client.resizeTerminal).toHaveBeenCalledTimes(resizeCount);

      expect(client.releaseTerminal).toHaveBeenCalledWith(
        'term-1', expect.objectContaining({ testAttachmentId: 1 }),
      );
      expect(client.detachTerminal).not.toHaveBeenCalled();
      expect(client.closeTerminalBridge).not.toHaveBeenCalled();
      expect(client.openTerminal).toHaveBeenCalledTimes(2);
      expect(client.snapshot).toHaveBeenCalledTimes(1);
      if (expected) {
        expect(client.scrollTerminal).toHaveBeenCalledWith(
          'term-1',
          ...expected,
        );
        expect(
          client.resizeTerminal.mock.invocationCallOrder.at(-1),
        ).toBeLessThan(client.scrollTerminal.mock.invocationCallOrder[0]);
      } else {
        expect(client.scrollTerminal).not.toHaveBeenCalled();
      }
    },
  );

  test.each([true, false])('resume passes the measured grid into attachment with resize pausing %s', async pauseResizeInBackground => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 31 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { webView } = await mountReadyHost(target, [target], pauseResizeInBackground);
    const size = { columns: 33, rows: 31, cellWidthPx: 28, cellHeightPx: 68 };
    await sendRendererMessage(webView, {
      type: 'resize', source: 'fit', key: target.key,
      cols: size.columns, rows: size.rows,
      cellWidthPx: size.cellWidthPx, cellHeightPx: size.cellHeightPx,
    });
    client.resizeTerminal.mockClear();
    client.openTerminal.mockClear();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await emitAppState('background');
      await emitAppState('active');
      expect(client.openTerminal).toHaveBeenLastCalledWith(
        'term-1', expect.any(Function), expect.any(Function), expect.any(Function), size,
        expect.objectContaining({ key: target.key, identity: expect.any(String) }),
      );
      await sendRendererMessage(webView, { type: 'fit-complete', key: target.key });
    }

    expect(client.openTerminal).toHaveBeenCalledTimes(3);
    expect(client.resizeTerminal).not.toHaveBeenCalled();
  });

  test.each([true, false])('background releases Herdr sizing with resize pausing %s', async pauseResizeInBackground => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { activateTarget, webView, injected } = await mountReadyHost(target, [target], pauseResizeInBackground);
    client.resizeTerminal.mockClear();
    injected.length = 0;

    await emitAppState('inactive');
    await emitAppState('background');
    expect(client.releaseTerminal).toHaveBeenCalledTimes(1);
    expect(client.isTerminalBridgeRetained()).toBe(false);
    await sendRendererMessage(webView, {
      type: 'resize', source: 'fit', key: target.key,
      cols: 90, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    });
    await sendRendererMessage(webView, { type: 'terminal-ready', key: target.key });
    await activateTarget({ ...target });
    expect(client.resizeTerminal).not.toHaveBeenCalled();
    expect(client.openTerminal).toHaveBeenCalledTimes(1);
    expect(client.isTerminalBridgeRetained()).toBe(false);

    await emitAppState('active');

    expect(client.releaseTerminal).toHaveBeenCalledTimes(1);
    expect(client.detachTerminal).not.toHaveBeenCalled();
    expect(client.closeTerminalBridge).not.toHaveBeenCalled();
    expect(client.openTerminal).toHaveBeenCalledTimes(2);
    expect(client.isTerminalBridgeRetained()).toBe(true);
    expect(injected.join('\n')).toContain('window.herdrFit');
  });

  test.each([true, false])('foreground reconnects a failed bridge with resize pausing %s', async pauseResizeInBackground => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    const { injected } = await mountReadyHost(target, [target], pauseResizeInBackground);
    act(() => client.disconnect());
    expect(client.isTerminalBridgeRetained()).toBe(false);
    await emitAppState('background');

    await emitAppState('active');

    expect(client.openTerminal).toHaveBeenCalledTimes(2);
    expect(client.isTerminalBridgeRetained()).toBe(true);
    injected.length = 0;
    act(() => client.emitFrame({
      type: 'terminal.frame', seq: 1, encoding: 'utf8', width: 80, height: 24,
      full: true, bytes: 'reconnected output',
    }));
    expect(injected.join('\n')).toContain('reconnected output');
    await emitAppState('active');
    expect(client.openTerminal).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])('background keeps plain SSH attached with resize pausing %s', async pauseResizeInBackground => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    target.session.kind = 'ssh';
    const { webView } = await mountReadyHost(target, [target], pauseResizeInBackground);
    client.resizeTerminal.mockClear();

    await emitAppState('background');
    await sendRendererMessage(webView, {
      type: 'resize', source: 'fit', key: target.key,
      cols: 90, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(pauseResizeInBackground ? 0 : 1);
    await emitAppState('active');
    await sendRendererMessage(webView, { type: 'fit-complete', key: target.key });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(client.resizeTerminal.mock.calls[0].slice(0, 5)).toEqual(['term-1', 90, 30, 8, 16]);
    await sendRendererMessage(webView, { type: 'fit-complete', key: target.key });
    expect(client.resizeTerminal).toHaveBeenCalledTimes(1);

    expect(client.releaseTerminal).not.toHaveBeenCalled();
    expect(client.detachTerminal).not.toHaveBeenCalled();
    expect(client.closeTerminalBridge).not.toHaveBeenCalled();
    expect(client.openTerminal).toHaveBeenCalledTimes(1);
    expect(client.isTerminalBridgeRetained()).toBe(true);
  });

  test('a renderer mounted in background waits for foreground before claiming Herdr sizing', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({ 'term-1': scroll });
    const target = createTarget('term-1', client, scroll);
    mockAppState.currentState = 'background';
    await mountReadyHost(target);
    expect(client.openTerminal).not.toHaveBeenCalled();
    expect(client.resizeTerminal).not.toHaveBeenCalled();

    await emitAppState('active');
    expect(client.openTerminal).toHaveBeenCalledTimes(1);
  });

  test('background also releases warm bridges belonging to evicted renderers', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({});
    const targets = Array.from({ length: MIN_XTERM_CACHE_CAPACITY + 1 }, (_, index) =>
      createTarget(`term-${index + 1}`, client, scroll),
    );
    const { activateTarget, webView } = await mountReadyHost(targets[0], targets, true, MIN_XTERM_CACHE_CAPACITY);
    for (const target of targets.slice(1)) {
      await activateTarget(target);
      await sendRendererMessage(webView, { type: 'terminal-ready', key: target.key });
      await sendRendererMessage(webView, {
        type: 'resize', source: 'fit', key: target.key,
        cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16,
      });
    }
    expect(client.detachTerminal).toHaveBeenCalledWith('term-1', expect.anything());
    expect(client.isTerminalBridgeRetained('term-1')).toBe(true);

    await emitAppState('background');

    expect(client.closeTerminalBridge).toHaveBeenCalledWith('term-1');
    expect(client.releaseTerminal).toHaveBeenCalledTimes(MIN_XTERM_CACHE_CAPACITY);
    for (const target of targets) {
      expect(client.isTerminalBridgeRetained(target.session.terminalId)).toBe(false);
    }
  });

  test('SSH tabs retain their shells and renderers beyond the cache capacity', async () => {
    const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 };
    const client = createClient({});
    const targets = Array.from({ length: MIN_XTERM_CACHE_CAPACITY + 1 }, (_, index) => {
      const target = createTarget(`__whip_ssh_shell__:${index + 1}`, client, scroll);
      return { ...target, session: { ...target.session, kind: 'ssh' as const } };
    });
    const { activateTarget, webView, injected } = await mountReadyHost(
      targets[0], targets, true, MIN_XTERM_CACHE_CAPACITY,
    );
    for (const target of targets.slice(1)) {
      await activateTarget(target);
      await sendRendererMessage(webView, { type: 'terminal-ready', key: target.key });
      await sendRendererMessage(webView, {
        type: 'resize', source: 'fit', key: target.key,
        cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16,
      });
    }
    await activateTarget(targets[0]);
    await emitAppState('background');
    expect(client.openTerminal).toHaveBeenCalledTimes(targets.length);
    expect(client.detachTerminal).not.toHaveBeenCalled();
    expect(client.closeTerminalBridge).not.toHaveBeenCalled();
    expect(client.releaseTerminal).not.toHaveBeenCalled();
    expect(injected.some(script => script.includes('window.herdrRemove('))).toBe(false);
  });

  test('in-app visibility changes do not enter the resume restore path', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const eventCallbacks = createCallbacks();
    await mountReadyHost(target);

    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...eventCallbacks}
          activeTarget={target}
          preferences={{ ...preferences, pauseResizeInBackground: true }}
          targets={[target]}
          visible={false}
        />,
      );
    });
    act(() => {
      renderer.update(
        <TerminalRendererHost
          {...eventCallbacks}
          activeTarget={target}
          preferences={{ ...preferences, pauseResizeInBackground: true }}
          targets={[target]}
          visible
        />,
      );
    });

    expect(client.releaseTerminal).not.toHaveBeenCalled();
    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).not.toHaveBeenCalled();
  });

  test('an old renderer unmount cannot detach a replacement renderer controller', async () => {
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 24,
      },
    });
    let owner: object | null = null;
    client.openTerminal.mockImplementation(async () => {
      owner = {};
      return owner as { testAttachmentId: number };
    });
    client.detachTerminal.mockImplementation(
      (_terminalId, attachmentId) => {
        if (owner === attachmentId) owner = null;
      },
    );
    const target = createTarget('term-1', client, {
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 24,
    });
    const mount = async (): Promise<ReactTestRenderer> => {
      let host!: ReactTestRenderer;
      act(() => {
        host = create(
          <TerminalRendererHost
            {...createCallbacks()}
            activeTarget={target}
            preferences={preferences}
            targets={[target]}
            visible
          />,
          {
            createNodeMock: element =>
              element.type === 'WebView'
                ? {
                    injectJavaScript: jest.fn(),
                    requestFocus: jest.fn(),
                  }
                : null,
          },
        );
      });
      const webView = host.root.find(
        node => typeof node.props.onMessage === 'function',
      );
      await sendRendererMessage(webView, { type: 'ready' });
      await sendRendererMessage(webView, {
        type: 'terminal-ready',
        key: target.key,
      });
      await sendRendererMessage(webView, {
        type: 'resize',
        source: 'fit',
        key: target.key,
        cols: 80,
        rows: 24,
        cellWidthPx: 8,
        cellHeightPx: 16,
      });
      return host;
    };

    const oldRenderer = await mount();
    const oldOwner = owner;
    renderer = await mount();
    const replacementOwner = owner;
    expect(replacementOwner).not.toBe(oldOwner);

    await act(async () => {
      oldRenderer.unmount();
      await Promise.resolve();
    });

    expect(client.detachTerminal).toHaveBeenCalledWith('term-1', oldOwner);
    expect(owner).toBe(replacementOwner);
  });

  test('explicit user scrolling cancels a pending resume restore', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const { webView } = await mountReadyHost(target);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'scroll',
      key: target.key,
      direction: 'up',
      lines: 3,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: target.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).toHaveBeenCalledTimes(1);
    expect(client.scrollTerminal).toHaveBeenCalledWith(
      'term-1',
      'up',
      3,
      undefined,
      undefined,
    );
  });

  test('alternate-screen activation cancels normal-buffer resume restoration', async () => {
    const checkpoint = {
      offset_from_bottom: 200,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_000,
        viewport_rows: 24,
      },
    });
    const target = createTarget('term-1', client, checkpoint);
    const { webView } = await mountReadyHost(target);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'buffer-mode',
      key: target.key,
      alternate: true,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: target.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.scrollTerminal).not.toHaveBeenCalled();
  });

  test('restores checkpoints only onto their matching terminal keys', async () => {
    const firstScroll = {
      offset_from_bottom: 100,
      max_offset_from_bottom: 1_000,
      viewport_rows: 24,
    };
    const secondScroll = {
      offset_from_bottom: 300,
      max_offset_from_bottom: 2_000,
      viewport_rows: 24,
    };
    const client = createClient({
      'term-1': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 1_020,
        viewport_rows: 24,
      },
      'term-2': {
        offset_from_bottom: 0,
        max_offset_from_bottom: 2_040,
        viewport_rows: 24,
      },
    });
    const first = createTarget('term-1', client, firstScroll);
    const second = createTarget('term-2', client, secondScroll);
    const { activateTarget, webView } = await mountReadyHost(first, [first, second]);

    await activateTarget(second);
    await sendRendererMessage(webView, {
      type: 'terminal-ready',
      key: second.key,
    });
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: second.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });
    await activateTarget(first);

    await emitAppState('background');
    await emitAppState('active');
    await sendRendererMessage(webView, {
      type: 'resize',
      source: 'fit',
      key: first.key,
      cols: 80,
      rows: 24,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });

    expect(client.scrollTerminal).toHaveBeenCalledWith('term-1', 'up', 120);
    expect(client.scrollTerminal).toHaveBeenCalledWith('term-2', 'up', 340);
  });
});
