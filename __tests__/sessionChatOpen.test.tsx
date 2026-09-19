import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SessionScreen } from '../src/components/SessionScreen';
import { agentChatCache } from '../src/services/agentChatCache';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import { listenToChat } from '../src/services/chatSpeech';
import type { ChatAgent } from '../src/lib/agentChatSession';
import { AgentChatPresentationPhase } from '../src/lib/agentChatPresentation';
import { TerminalResidencyEndReason } from '../src/lib/terminalResidency';
import type { HerdrSnapshot, PaneInfo } from '../src/types';
import type {
  NativeAgentChatBinding,
  NativeAgentChatOpenResult,
  NativeAgentChatStartResult,
  NativeAgentTranscriptUpdate,
  RuntimeAgentIntegrationStatus,
} from 'react-native-whip-ssh';

jest.mock('react-native', () => ({
  View: 'View',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'Spinner',
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn((_event, listener) => {
      mockAppStateListeners.add(listener);
      return { remove: () => mockAppStateListeners.delete(listener) };
    }),
  },
  NativeModules: {},
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
  Linking: { openURL: jest.fn() },
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/chatSpeech', () => ({
  listenToChat: jest.fn(() => jest.fn()),
}));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-webview', () => 'WebView');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../src/components/app-ui', () => ({
  AnimatedAgentStatusGlyph: 'AgentGlyph',
  hapticPress: (fn: unknown) => fn,
}));
jest.mock('../src/components/GlassSurface', () => ({
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));
jest.mock('../src/components/TerminalScreen', () => {
  const { createElement: element, useLayoutEffect } = require('react');
  const { TerminalRendererHost } = require('../src/components/TerminalRendererHost');
  const noop = () => {};
  return {
    TerminalScreen: (props: ComponentProps<typeof import('../src/components/TerminalScreen').TerminalScreen>) => {
      useLayoutEffect(() => {
        mockChatFrames.push({ visible: props.visible, chat: props.chatViewEnabled });
      });
      return element('TerminalScreen', props,
        element(TerminalRendererHost, {
          activeTarget: props.activeTarget, targets: props.targets,
          preferences: props.preferences, visible: props.visible,
          onResidencyEnd: props.onResidencyEnd,
          onInput: noop, onScroll: noop, onOfflineScroll: noop, onOfflineSnapshot: noop,
          onSearchResult: noop, onLinksScanned: noop, onOpenLink: noop, onPaste: noop,
          onBufferModeChange: noop, onVisualScrollState: noop, onProtocolStateChange: noop,
          onTitleChange: noop, onFontSizeChange: noop, onStatus: noop, onError: noop,
        }),
        props.renderViewportOverlay?.({ top: 0, bottom: 0 }, 0),
      );
    },
    TerminalBackground: 'TerminalBackground',
  };
});
jest.mock('../src/components/AgentChatView', () => ({
  AgentChatView: 'AgentChatView',
}));
jest.mock('../src/components/AgentIntegrationInstallSheet', () => ({
  AgentIntegrationInstallSheet: 'IntegrationSheet',
}));
jest.mock('../src/components/AgentIdentityWarningSheet', () => ({
  AgentIdentityWarningSheet: 'IdentitySheet',
}));
jest.mock('../src/components/AppAlertPopup', () => ({
  AppAlertPopup: 'Alert',
}));
jest.mock('../src/components/AppBackground', () => ({
  AppBackground: 'AppBackground',
}));
jest.mock('../src/components/AttachmentPasteSheet', () => ({
  AttachmentPasteSheet: 'AttachmentSheet',
}));
jest.mock('../src/components/ResourceEditorSheet', () => ({
  ResourceEditorSheet: 'EditorSheet',
  ResourceEditorField: 'EditorField',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/volumeKeys', () => ({
  addTerminalVolumeKeyListener: () => ({ remove: jest.fn() }),
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
  sessionTabGlassStyle: () => ({}),
  sessionTabStatusColor: () => '',
  statusColor: () => '',
}));

type Props = ComponentProps<typeof SessionScreen>;
const mockChatFrames: Array<{ visible: boolean; chat: boolean }> = [];
const mockAppStateListeners = new Set<(state: string) => void>();
function setup(agent: ChatAgent) {
  const bindings = new Map<string, NativeAgentChatBinding>();
  const availableBindings = new Map<string, NativeAgentChatBinding>();
  const handlers = new Map<string, (event: NativeAgentTranscriptUpdate) => void>();
  const pane: PaneInfo = {
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
    tab_id: 'tab-1',
    workspace_id: 'workspace-1',
    focused: true,
    revision: 1,
    agent,
    display_agent: agent,
    agent_status: 'idle',
    agent_session: {
      agent,
      source: `herdr:${agent}`,
      kind: 'id',
      value:
        agent === 'codex'
          ? '11111111-1111-4111-8111-111111111111'
          : 'ses_abc123',
    },
  };
  let snapshot = {
    server: { running: true },
    agents: [],
    panes: [pane],
    layouts: [],
    workspaces: [
      { workspace_id: 'workspace-1', active_tab_id: 'tab-1', focused: true },
    ],
    tabs: [{ workspace_id: 'workspace-1', tab_id: 'tab-1', focused: true }],
  } as unknown as HerdrSnapshot;
  const native = {
    hostState: jest.fn(() => ({
      syncStatus: 'synced',
      freshness: 'fresh',
      snapshot,
    })),
    openAgentChat: jest.fn(
      (terminalId: string, handler?: (event: NativeAgentTranscriptUpdate) => void): NativeAgentChatOpenResult => {
        const binding = availableBindings.get(terminalId);
        if (!binding) return { type: 'no-chat', terminalId, reason: 'unsupported-pane' };
        bindings.set(terminalId, binding);
        if (handler) handlers.set(terminalId, handler);
        return { type: 'bound', binding };
      },
    ),
    currentAgentChat: jest.fn(
      (terminalId: string, handler?: (event: NativeAgentTranscriptUpdate) => void): NativeAgentChatBinding | undefined => {
        if (handler) handlers.set(terminalId, handler);
        return bindings.get(terminalId);
      },
    ),
    startAgentChat: jest.fn(
      (_bindingToken: string, _cacheBlob?: ArrayBuffer): NativeAgentChatStartResult => ({ type: 'stale-binding' }),
    ),
    detachAgentChat: jest.fn((terminalId: string) => {
      bindings.delete(terminalId);
      return undefined as { namespace: string; key: string; blob: ArrayBuffer } | undefined;
    }),
    agentIntegrationStatus: jest.fn(
      async (): Promise<RuntimeAgentIntegrationStatus> => 'current',
    ),
    installAgentIntegration: jest.fn(async () => ({
      kind: agent,
      messages: [],
    })),
  };
  const client = {
    native,
    terminal: { closeTerminalBridge: jest.fn(), detachTerminal: jest.fn(), isTerminalBridgeRetained: jest.fn(() => false) },
    snapshot: jest.fn(async () => snapshot),
  } as unknown as Props['client'];
  const terminal = {
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
    title: 'Agent',
    status: 'connected' as const,
    reconnectAttempt: 0,
  };
  const props: Props = {
    hostSessionId: 'host-1',
    visible: true,
    ttsEnabled: false,
    snapshot,
    client,
    terminalState: {
      sessions: [terminal],
      activeTerminalId: terminal.terminalId,
    },
    terminalTargets: [
      { key: 'target', hostSessionId: 'host-1', client, session: terminal },
    ],
    terminalPreferences: { fullscreen: true, xtermCacheCapacity: 3 } as Props['terminalPreferences'],
    terminalControlUsage: {},
    terminalHistory: [],
    latencyMs: null,
    latencyWarningActive: false,
    appBackgroundImageUri: null,
    appBackgroundDimming: 60,
    onRefresh: jest.fn(async () => {}),
    onOpenPane: jest.fn(),
    onActivateTerminal: jest.fn(),
    onCloseTerminal: jest.fn(),
    onTerminalStatus: jest.fn(),
    onTerminalFontSizeChange: jest.fn(),
    onOpenFiles: jest.fn(),
    getComposerDraft: () => '',
    onComposerDraftChange: jest.fn(),
    onTerminalControlUse: jest.fn(),
    onTerminalHistoryEntry: jest.fn(),
    onTerminalOpenLinksInAppChange: jest.fn(),
    onInteraction: jest.fn(),
    onExit: jest.fn(),
  };
  return {
    bindings,
    availableBindings,
    handlers,
    injected: [] as string[],
    props,
    native,
    client,
    pane,
    setSnapshot: (next: HerdrSnapshot) => {
      snapshot = next;
    },
  };
}

let renderer: ReactTestRenderer;
const ui = (name: string) =>
  renderer.root.find(node => String(node.type) === name);
const control = () => ui('TerminalScreen').props.chatControl;
const navigationPhases = [
  AgentChatPresentationPhase.Visible,
  AgentChatPresentationPhase.PreparingViewport,
];

beforeEach(() => {
  mockChatFrames.length = 0;
  jest.mocked(listenToChat).mockClear();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(agentChatCache, 'loadNative').mockResolvedValue(null);
});
afterEach(() => {
  act(() => renderer?.unmount());
  agentTranscriptService.reset();
  jest.restoreAllMocks();
});

function bindChat(host: ReturnType<typeof setup>, agent: ChatAgent, overrides: Partial<NativeAgentChatBinding> = {}) {
  const result: NativeAgentChatOpenResult = {
    type: 'bound',
    binding: {
      bindingToken: 'binding-1',
      bindingGeneration: 1,
      runtimeIncarnation: 1,
      terminalId: 'terminal-1',
      paneId: 'pane-1',
      agent,
      sessionId: 'opaque-native-id',
      transcriptKey: 'transcript-1',
      state: {
        agent,
        sessionId: 'opaque-native-id',
        status: 'loading',
        revision: 0,
        messages: [],
        turns: [],
      },
      ...overrides,
    },
  };
  host.availableBindings.set(result.binding.terminalId, result.binding);
  return result.binding;
}

async function openReadyChat(host: ReturnType<typeof setup>, agent: ChatAgent) {
  const binding = bindChat(host, agent);
  host.native.startAgentChat.mockImplementation(() => {
    binding.state = { ...binding.state, status: 'live', revision: 1 };
    return { type: 'started', state: binding.state };
  });
  act(() => {
    renderer = create(<SessionScreen {...host.props} />, {
      createNodeMock: element => element.type === 'WebView' ? {
        injectJavaScript: (script: string) => host.injected.push(script),
      } : null,
    });
  });
  await act(async () => {
    await control().onPress();
    await ui('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'ready' }) } });
  });
  return binding;
}

function revealChat() {
  const viewport = ui('AgentChatView');
  act(() => { viewport.props.onInitialViewportReady(); });
  expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
}

function addCachePressure(host: ReturnType<typeof setup>) {
  const first = host.props.terminalState.sessions[0];
  const terminals = [2, 3, 4].map(index => ({
    ...first, terminalId: `terminal-${index}`, paneId: `pane-${index}`,
  }));
  host.props.terminalState = {
    ...host.props.terminalState,
    sessions: [first, ...terminals],
  };
  host.props.terminalTargets = [
    ...host.props.terminalTargets,
    ...terminals.map(session => ({
      key: session.terminalId, hostSessionId: host.props.hostSessionId, client: host.client, session,
    })),
  ];
  return terminals.map(terminal => () => renderer.update(
    <SessionScreen {...host.props} terminalState={{
      ...host.props.terminalState, activeTerminalId: terminal.terminalId,
    }} />,
  ));
}

describe.each(['codex', 'opencode'] as const)('%s SessionScreen', agent => {
  test.each(['hidden', 'background', 'ssh', 'shell', 'no-target'] as const)('does not preload an ineligible %s terminal', async reason => {
    const host = setup(agent);
    bindChat(host, agent);
    if (reason === 'hidden') host.props.visible = false;
    if (reason === 'ssh') host.props.terminalTargets[0].session.kind = 'ssh';
    if (reason === 'shell') Object.assign(host.pane, { agent: 'shell', display_agent: 'shell', agent_session: undefined });
    if (reason === 'no-target') host.props.terminalTargets = [];
    // Mount hidden first so the AppState listener can receive a background event.
    if (reason === 'background') host.props.visible = false;
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    if (reason === 'background') {
      act(() => {
        for (const listener of mockAppStateListeners) listener('background');
        renderer.update(<SessionScreen {...host.props} visible />);
      });
    }
    await act(async () => {});
    expect(host.native.openAgentChat).not.toHaveBeenCalled();
    expect(agentChatCache.loadNative).not.toHaveBeenCalled();
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    if (reason === 'hidden' || reason === 'background') {
      await act(async () => {
        for (const listener of mockAppStateListeners) listener('active');
        renderer.update(<SessionScreen {...host.props} visible />);
      });
      expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    }
  });

  test('Chat can request a preloaded binding while remote synchronization is still loading', async () => {
    const host = setup(agent);
    const binding = bindChat(host, agent);
    host.native.startAgentChat.mockImplementation(() => ({ type: 'started', state: binding.state }));
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(control().loading).toBe(false);
    act(() => { control().onPress(); });
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    act(() => {
      binding.state = { ...binding.state, status: 'live', revision: 1 };
      host.handlers.get(binding.terminalId)?.({
        key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
        revision: 1, deltas: [{ type: 'reset', state: binding.state }],
      });
    });
    expect(control().loading).toBe(true);
    revealChat();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
  });

  test('a failed background transcript is silent and explicit Chat retries its native lifecycle', async () => {
    const host = setup(agent);
    const binding = bindChat(host, agent);
    host.native.startAgentChat.mockImplementation(() => {
      binding.state = { ...binding.state, status: 'error', revision: 1, error: 'source unavailable' };
      return { type: 'started', state: binding.state };
    });
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    expect(ui('Alert').props.visible).toBe(false);
    expect(control().loading).toBe(false);
    host.native.startAgentChat.mockImplementation(() => {
      binding.state = { ...binding.state, status: 'live', revision: 2, error: undefined };
      return { type: 'started', state: binding.state };
    });
    await act(async () => { await control().onPress(); });
    revealChat();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(2);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])('preloads silently and reuses its binding when cache finishes before Chat: %s', async readyBeforePress => {
    const host = setup(agent);
    const binding = bindChat(host, agent);
    let restore!: (blob: ArrayBuffer) => void;
    jest.mocked(agentChatCache.loadNative).mockReturnValueOnce(new Promise(resolve => { restore = resolve; }));
    host.native.startAgentChat.mockImplementation(() => {
      binding.state = { ...binding.state, status: 'stale', revision: 1 };
      return { type: 'started', state: binding.state };
    });
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    const terminal = ui('WebView');
    expect(mockChatFrames[0]).toEqual({ visible: true, chat: false });
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(agentChatCache.loadNative).toHaveBeenCalledWith(binding.transcriptKey);
    expect(host.native.startAgentChat).not.toHaveBeenCalled();
    expect(control()).toMatchObject({ active: false, loading: false, disabled: false });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(ui('Alert').props.visible).toBe(false);
    expect(ui('IntegrationSheet').props.integration).toBeNull();
    expect(ui('IdentitySheet').props.warning).toBeNull();
    expect(host.client.snapshot).not.toHaveBeenCalled();
    expect(host.props.onRefresh).not.toHaveBeenCalled();
    expect(host.native.agentIntegrationStatus).not.toHaveBeenCalled();

    const blob = new Uint8Array([1, 2]).buffer;
    if (readyBeforePress) {
      await act(async () => { restore(blob); });
      expect(control().loading).toBe(false);
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    }
    act(() => { control().onPress(); });
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    if (!readyBeforePress) {
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
      await act(async () => { restore(blob); });
    }
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(binding.bindingToken, blob);
    expect(ui('AgentChatView').parent?.props).toMatchObject({
      pointerEvents: 'none', accessibilityElementsHidden: true, style: { opacity: 0 },
    });
    revealChat();
    expect(ui('WebView')).toBe(terminal);
    expect(host.client.terminal.closeTerminalBridge).not.toHaveBeenCalled();
  });

  test('evicts older chat UI without detaching transcripts and restores its saved viewport', async () => {
    const host = setup(agent);
    const first = await openReadyChat(host, agent);
    revealChat();
    const saved = { offset: 240, followEnd: false, expandedBlocks: new Set(['tool-1']) };
    act(() => { ui('AgentChatView').props.onSaveViewport(saved); });
    const visits = addCachePressure(host);
    const others = [2, 3].map(index => bindChat(host, agent, {
      bindingToken: `binding-${index}`,
      terminalId: `terminal-${index}`,
      paneId: `pane-${index}`,
      transcriptKey: `transcript-${index}`,
    }));
    const bindings = [first, ...others];
    const snapshot = {
      ...host.props.snapshot,
      panes: bindings.map(binding => ({ ...host.pane, terminal_id: binding.terminalId, pane_id: binding.paneId })),
    };
    host.props.snapshot = snapshot;
    host.setSnapshot(snapshot);
    host.native.startAgentChat.mockImplementation(token => {
      const binding = bindings.find(item => item.bindingToken === token)!;
      binding.state = { ...binding.state, status: 'live', revision: 1 };
      return { type: 'started', state: binding.state };
    });
    const viewports = () => renderer.root.findAll(node => String(node.type) === 'AgentChatView');
    for (const visit of visits.slice(0, 2)) {
      await act(async () => { visit(); });
      await act(async () => { await control().onPress(); });
      act(() => { viewports().find(view => view.props.active)!.props.onInitialViewportReady(); });
    }
    expect(viewports()).toHaveLength(2);
    expect(viewports().every(view => view.props.savedViewport === undefined)).toBe(true);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(agentTranscriptService.getState(first.bindingToken)).not.toBeNull();

    act(() => {
      first.state = { ...first.state, revision: 2 };
      host.handlers.get(first.terminalId)?.({
        key: first.transcriptKey, runtimeIncarnation: first.runtimeIncarnation,
        revision: 2, deltas: [{ type: 'reset', state: first.state }],
      });
      renderer.update(<SessionScreen {...host.props} />);
    });
    const restored = viewports().find(view => view.props.active)!;
    expect(viewports()).toHaveLength(2);
    expect(restored.props.savedViewport).toBe(saved);
    expect(restored.props.state.revision).toBe(2);
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(3);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
  });

  test.each(['hidden', 'background'] as const)('%s chat catches up only when foregrounded', async reason => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    const viewport = ui('AgentChatView');
    act(() => {
      if (reason === 'hidden') renderer.update(<SessionScreen {...host.props} visible={false} />);
      else for (const listener of mockAppStateListeners) listener('background');
    });
    expect(viewport.props.active).toBe(false);
    const hiddenProps = viewport.props;
    act(() => {
      binding.state = { ...binding.state, revision: 2 };
      host.handlers.get(binding.terminalId)?.({
        key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
        revision: 2, deltas: [{ type: 'reset', state: binding.state }],
      });
    });
    expect(viewport.props).toBe(hiddenProps);
    expect(agentTranscriptService.getState(binding.bindingToken)?.revision).toBe(2);
    act(() => {
      if (reason === 'hidden') renderer.update(<SessionScreen {...host.props} />);
      else for (const listener of mockAppStateListeners) listener('active');
    });
    expect(viewport.props.active).toBe(true);
    expect(viewport.props.state.revision).toBe(2);
  });

  test('returning to Terminal pauses viewport updates while transcript syncing continues', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    const viewport = ui('AgentChatView');
    const terminal = ui('WebView');
    act(() => { control().onPress(); });
    expect(ui('AgentChatView')).toBe(viewport);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(control()).toMatchObject({ active: false, loading: false, disabled: false });
    expect(viewport.parent?.props).toMatchObject({
      pointerEvents: 'none', accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants', style: { opacity: 0 },
    });
    expect(viewport.props.active).toBe(false);
    act(() => {
      binding.state = { ...binding.state, revision: 2 };
      host.handlers.get(binding.terminalId)?.({
        key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
        revision: 2, deltas: [{ type: 'reset', state: binding.state }],
      });
    });
    expect(viewport.props.state.revision).toBe(1);
    expect(agentTranscriptService.getState(binding.bindingToken)?.revision).toBe(2);
    act(() => { control().onPress(); });
    expect(ui('AgentChatView')).toBe(viewport);
    expect(ui('WebView')).toBe(terminal);
    expect(viewport.props.active).toBe(true);
    expect(viewport.props.state.revision).toBe(2);
    expect(viewport.parent?.props.style.opacity).toBe(0);
    expect(control().loading).toBe(true);
    revealChat();
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
    expect(control().loading).toBe(false);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
  });

  test.each(['dormant', 'warm'] as const)('%s preload is released on real residency eviction', async phase => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    act(() => { control().onPress(); });
    if (phase === 'dormant') {
      // A native loading reset drops the hidden warm viewport back to dormancy.
      act(() => host.handlers.get(binding.terminalId)?.({
        key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
        revision: 2, deltas: [{ type: 'status-changed', status: 'loading' }],
      }));
    }
    const visits = addCachePressure(host);
    for (const visit of visits) act(visit);
    expect(host.native.detachAgentChat).toHaveBeenCalledTimes(1);
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    expect(renderer.root.findAll(node => String(node.type) === 'AgentChatView')).toHaveLength(0);
  });

  test('A → B → A keeps pending preloads tied to their terminal and starts each only once', async () => {
    const host = setup(agent);
    const visits = addCachePressure(host);
    const paneB = { ...host.pane, terminal_id: 'terminal-2', pane_id: 'pane-2', focused: false };
    host.props.snapshot.panes.push(paneB);
    const a = bindChat(host, agent);
    const b = bindChat(host, agent, {
      terminalId: paneB.terminal_id, paneId: paneB.pane_id,
      bindingToken: 'binding-2', transcriptKey: 'transcript-2', sessionId: 'session-2',
    });
    const restores = new Map<string, (blob: null) => void>();
    jest.mocked(agentChatCache.loadNative).mockImplementation(key => new Promise(resolve => { restores.set(key, resolve); }));
    host.native.startAgentChat.mockImplementation(token => {
      const binding = token === a.bindingToken ? a : b;
      binding.state = { ...binding.state, status: 'live', revision: 1, sessionId: binding.sessionId };
      return { type: 'started', state: binding.state };
    });
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    act(visits[0]);
    await act(async () => { restores.get(a.transcriptKey)?.(null); });
    expect(control()).toMatchObject({ active: false, loading: false });
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    act(() => renderer.update(<SessionScreen {...host.props} />));
    await act(async () => { restores.get(b.transcriptKey)?.(null); });
    act(() => { control().onPress(); });
    expect(ui('AgentChatView').props.state.sessionId).toBe(a.sessionId);
    revealChat();
    act(visits[0]);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(agentTranscriptService.getState(b.bindingToken)?.sessionId).toBe(b.sessionId);
    expect(host.native.openAgentChat.mock.calls.map(call => call[0])).toEqual([a.terminalId, b.terminalId]);
    expect(host.native.startAgentChat.mock.calls.map(call => call[0])).toEqual([a.bindingToken, b.bindingToken]);
  });

  test('authoritative identity replacement cancels the old cache completion and keeps the new preload dormant', async () => {
    const host = setup(agent);
    const old = bindChat(host, agent);
    let restoreOld!: (blob: null) => void;
    jest.mocked(agentChatCache.loadNative).mockReturnValueOnce(new Promise(resolve => { restoreOld = resolve; }));
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    const replacement = bindChat(host, agent, { bindingToken: 'binding-2', transcriptKey: 'transcript-2', sessionId: 'session-2' });
    // Rust's authoritative reconciliation may already have rebound the terminal.
    host.bindings.set(replacement.terminalId, replacement);
    host.native.startAgentChat.mockImplementation(() => {
      replacement.state = { ...replacement.state, status: 'live', revision: 1 };
      return { type: 'started', state: replacement.state };
    });
    const snapshot = { ...host.props.snapshot, panes: [{
      ...host.pane, revision: 2,
      agent_session: { ...host.pane.agent_session!, value: replacement.sessionId },
    }] };
    host.setSnapshot(snapshot);
    await act(async () => renderer.update(<SessionScreen {...host.props} snapshot={snapshot} />));
    await act(async () => { restoreOld(null); });
    expect(agentTranscriptService.getState(old.bindingToken)).toBeNull();
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(replacement.bindingToken, undefined);
    expect(control().loading).toBe(false);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    act(() => { control().onPress(); });
    revealChat();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
  });

  test.each(['no-chat', 'throw', 'stale-start'] as const)('background %s is silent and later explicit Chat still offers remediation', async failure => {
    const host = setup(agent);
    if (failure === 'throw') host.native.openAgentChat.mockImplementationOnce(() => { throw new Error('host replaced'); });
    if (failure === 'stale-start') bindChat(host, agent);
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    expect(ui('Alert').props.visible).toBe(false);
    expect(ui('IdentitySheet').props.warning).toBeNull();
    expect(ui('IntegrationSheet').props.integration).toBeNull();
    expect(control()).toMatchObject({ loading: false, disabled: false });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(host.client.snapshot).not.toHaveBeenCalled();
    host.bindings.clear();
    host.availableBindings.clear();
    host.native.agentIntegrationStatus.mockResolvedValue('not-installed');
    await act(async () => { await control().onPress(); });
    expect(ui('IntegrationSheet').props.integration.agent).toBe(agent);
    expect(host.client.snapshot).toHaveBeenCalledTimes(1);
  });

  test('unmount while cache hydration is pending prevents native startup', async () => {
    const host = setup(agent);
    const binding = bindChat(host, agent);
    let restore!: (blob: null) => void;
    jest.mocked(agentChatCache.loadNative).mockReturnValueOnce(new Promise(resolve => { restore = resolve; }));
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    act(() => renderer.unmount());
    await act(async () => { restore(null); });
    expect(host.native.detachAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).not.toHaveBeenCalled();
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
  });

  test.each(['terminal', 'host', 'pane'] as const)('keeps focused chat speech in background and stops on leaving the %s', async destination => {
    const host = setup(agent);
    host.props.ttsEnabled = true;
    const binding = await openReadyChat(host, agent);
    revealChat();
    expect(listenToChat).toHaveBeenCalledWith(expect.objectContaining({
      bindingToken: binding.bindingToken, hostId: 'host-1', paneId: 'pane-1', agent,
    }), expect.any(Function), expect.any(Function));
    const stop = jest.mocked(listenToChat).mock.results[0].value;
    act(() => { for (const listener of mockAppStateListeners) listener('background'); });
    expect(listenToChat).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    if (destination === 'terminal') act(() => { control().onPress(); });
    if (destination === 'host') act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
    if (destination === 'pane') act(() => renderer.update(<SessionScreen {...host.props}
      terminalState={{ ...host.props.terminalState, activeTerminalId: null }} />));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listenToChat).toHaveBeenCalledTimes(1);
  });

  test('the shared TTS setting starts and stops reading the selected chat', async () => {
    const host = setup(agent);
    await openReadyChat(host, agent);
    revealChat();
    expect(listenToChat).not.toHaveBeenCalled();

    act(() => renderer.update(<SessionScreen {...host.props} ttsEnabled />));
    expect(listenToChat).toHaveBeenCalledTimes(1);
    const stop = jest.mocked(listenToChat).mock.results[0].value;

    act(() => renderer.update(<SessionScreen {...host.props} ttsEnabled={false} />));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listenToChat).toHaveBeenCalledTimes(1);

    act(() => renderer.update(<SessionScreen {...host.props} ttsEnabled />));
    expect(listenToChat).toHaveBeenCalledTimes(2);
  });

  test.each(['unavailable', 'replaced'] as const)('restores an evicted chat after its host was %s on return', async reason => {
    const host = setup(agent);
    await openReadyChat(host, agent);
    revealChat();
    act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
    act(() => { ui('TerminalScreen').props.onResidencyEnd(host.props.terminalTargets[0], TerminalResidencyEndReason.Evicted); });
    host.native.openAgentChat.mockImplementationOnce(() => {
      if (reason === 'replaced') throw new Error('runtime replaced during reconnect');
      return { type: 'no-chat', terminalId: 'terminal-1', reason: 'host-state-unavailable' };
    });
    await act(async () => renderer.update(<SessionScreen {...host.props} />));
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    const snapshot = { ...host.props.snapshot, panes: [...host.props.snapshot.panes] };
    await act(async () => renderer.update(<SessionScreen {...host.props} snapshot={snapshot} />));
    revealChat();
    expect(control().active).toBe(true);
  });

  test('background bridge release and reattachment keep Chat visible and bound', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    const state = agentTranscriptService.getState(binding.bindingToken);
    const transitions = [
      { appState: 'inactive', status: 'connected' },
      { appState: 'background', status: 'disconnected' },
      { appState: 'active', status: 'connecting' },
      { appState: 'active', status: 'connected' },
    ] as const;
    for (const { appState, status } of transitions) {
      await act(async () => {
        for (const listener of mockAppStateListeners) listener(appState);
        renderer.update(<SessionScreen
          {...host.props}
          terminalState={{
            ...host.props.terminalState,
            sessions: host.props.terminalState.sessions.map(terminal => ({ ...terminal, status })),
          }}
        />);
      });
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeDefined();
      expect(control().active).toBe(true);
      expect(control().loading).toBe(false);
      expect(agentTranscriptService.getState(binding.bindingToken)).toBe(state);
      expect(host.native.detachAgentChat).not.toHaveBeenCalled();
      expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
      expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    }
  });

  test('foreground reconciles an agent exit missed while backgrounded', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    host.injected.length = 0;
    act(() => { for (const listener of mockAppStateListeners) listener('background'); });
    host.native.currentAgentChat.mockReturnValue(undefined);
    host.setSnapshot({
      ...host.props.snapshot,
      panes: [{ ...host.pane, agent: 'shell', display_agent: 'shell', agent_session: undefined }],
    });

    await act(async () => { for (const listener of mockAppStateListeners) listener('active'); });

    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    expect(ui('Alert').props.visible).toBe(false);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.injected.join('\n')).not.toContain('window.herdrRemove(');
    act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
    act(() => renderer.update(<SessionScreen {...host.props} />));
    expect(host.injected.join('\n')).not.toContain('window.herdrCreate(');
    expect(host.client.terminal.closeTerminalBridge).not.toHaveBeenCalled();
  });

  test('foreground adopts a replacement native binding after a real reconnect', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    act(() => { for (const listener of mockAppStateListeners) listener('background'); });
    const replacement = { ...binding, runtimeIncarnation: 2, bindingGeneration: 2, bindingToken: 'binding-2' };
    host.native.currentAgentChat.mockReturnValue(replacement);

    await act(async () => { for (const listener of mockAppStateListeners) listener('active'); });

    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    expect(agentTranscriptService.getState(replacement.bindingToken)).not.toBeNull();
    revealChat();
    expect(control().active).toBe(true);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
  });
  test.each(navigationPhases)(
    'bottom-tab navigation keeps %s Chat mounted and bound',
    async phase => {
      const host = setup(agent);
      await openReadyChat(host, agent);
      if (phase === AgentChatPresentationPhase.Visible) revealChat();
      const viewport = ui('AgentChatView');
      const state = viewport.props.state;
      mockChatFrames.length = 0;

      act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
      expect(ui('TerminalScreen').props.visible).toBe(false);
      expect(ui('AgentChatView')).toBe(viewport);
      act(() => renderer.update(<SessionScreen {...host.props} visible />));

      await act(async () => {});
      expect(ui('AgentChatView')).toBe(viewport);
      expect(ui('AgentChatView').props.state).toBe(state);
      if (phase === AgentChatPresentationPhase.Visible) {
        expect(mockChatFrames.filter(frame => frame.visible).every(frame => frame.chat)).toBe(true);
      }
      expect(control().loading).toBe(phase === AgentChatPresentationPhase.PreparingViewport);
      if (phase === AgentChatPresentationPhase.PreparingViewport) revealChat();
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
      expect(control().active).toBe(true);
      expect(host.native.detachAgentChat).not.toHaveBeenCalled();
      expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
      expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    },
  );

  test('LRU eviction archives Chat with its terminal and restores persisted history without a terminal frame', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    const archive = { namespace: 'host-1', key: binding.transcriptKey, blob: new Uint8Array([9, 8]).buffer };
    const save = jest.spyOn(agentChatCache, 'saveNative').mockResolvedValue();
    host.native.detachAgentChat.mockReturnValue(archive);
    const visits = addCachePressure(host);
    host.injected.length = 0;
    for (const visit of visits.slice(0, 2)) act(visit);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(agentTranscriptService.getState(binding.bindingToken)).not.toBeNull();
    expect(ui('AgentChatView')).toBeDefined();

    act(visits[2]);
    expect(host.injected.join('\n')).toContain('window.herdrRemove("target")');
    expect(host.native.detachAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.detachAgentChat).toHaveBeenCalledWith(binding.terminalId);
    expect(save).toHaveBeenCalledWith(archive);
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    expect(renderer.root.findAll(node => String(node.type) === 'AgentChatView')).toHaveLength(0);

    binding.state = { ...binding.state, status: 'loading', revision: 0 };
    let finishRestore!: (blob: ArrayBuffer) => void;
    jest.mocked(agentChatCache.loadNative).mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve; }));
    mockChatFrames.length = 0;
    act(() => renderer.update(<SessionScreen {...host.props} />));
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(agentChatCache.loadNative).toHaveBeenLastCalledWith(archive.key);

    await act(async () => { finishRestore(archive.blob); });
    expect(host.native.startAgentChat).toHaveBeenLastCalledWith(binding.bindingToken, archive.blob);
    expect(control().loading).toBe(true);
    revealChat();
    expect(control().loading).toBe(false);
    expect(mockChatFrames.length).toBeGreaterThan(0);
    expect(mockChatFrames.every(frame => frame.chat)).toBe(true);
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(2);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(2);
  });

  test.each(navigationPhases)(
    'switching terminals keeps A\'s %s Chat warm',
    async phase => {
      const host = setup(agent);
      const terminalB = {
        ...host.props.terminalState.sessions[0],
        terminalId: 'terminal-2',
        paneId: 'pane-2',
      };
      host.props.terminalState.sessions = [
        ...host.props.terminalState.sessions,
        terminalB,
      ];
      host.props.snapshot.panes.push({
        ...host.pane,
        terminal_id: terminalB.terminalId,
        pane_id: terminalB.paneId,
        focused: false,
      });
      host.props.terminalTargets = [
        ...host.props.terminalTargets,
        {
          key: 'target-2',
          hostSessionId: host.props.hostSessionId,
          client: host.client,
          session: terminalB,
        },
      ];
      await openReadyChat(host, agent);
      if (phase === AgentChatPresentationPhase.Visible) revealChat();
      const selectB = () => renderer.update(
        <SessionScreen
          {...host.props}
          terminalState={{
            ...host.props.terminalState,
            activeTerminalId: terminalB.terminalId,
          }}
        />,
      );

      act(selectB);
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
      expect(control().active).toBe(false);
      expect(ui('AgentChatView')).toBeDefined();
      act(() => renderer.update(<SessionScreen {...host.props} />));

      await act(async () => {});
      expect(control().loading).toBe(phase === AgentChatPresentationPhase.PreparingViewport);
      if (phase === AgentChatPresentationPhase.PreparingViewport) revealChat();
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
      expect(control().active).toBe(true);
      act(selectB);
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
      expect(host.native.detachAgentChat).not.toHaveBeenCalled();
      expect(host.native.openAgentChat.mock.calls.map(call => call[0]))
        .toEqual(['terminal-1', 'terminal-2', 'terminal-2']);
      expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    },
  );

  test('host selection keeps Chat attached to its resident terminal key', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    const viewport = ui('AgentChatView');
    const other = setup(agent);
    other.props.hostSessionId = 'host-2';
    const targets = [...host.props.terminalTargets, {
      ...other.props.terminalTargets[0], key: 'other-host-target', hostSessionId: 'host-2',
    }];

    act(() => renderer.update(<SessionScreen {...other.props} terminalTargets={targets} />));
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(ui('AgentChatView')).toBe(viewport);
    expect(agentTranscriptService.getState(binding.bindingToken)).not.toBeNull();
    mockChatFrames.length = 0;
    act(() => renderer.update(<SessionScreen {...host.props} terminalTargets={targets} />));
    expect(ui('AgentChatView')).toBe(viewport);
    expect(mockChatFrames.every(frame => frame.chat)).toBe(true);
    expect(host.native.detachAgentChat).not.toHaveBeenCalled();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(other.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(other.native.startAgentChat).not.toHaveBeenCalled();
  });

  test('unmounting the terminal cache releases its attached Chat resources', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    act(() => renderer.unmount());
    expect(host.native.detachAgentChat).toHaveBeenCalledTimes(1);
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
  });

  test('explicitly toggling Chat off restores Terminal View across navigation', async () => {
    const host = setup(agent);
    await openReadyChat(host, agent);
    revealChat();

    act(() => { control().onPress(); });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(control().active).toBe(false);
    act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
    act(() => renderer.update(<SessionScreen {...host.props} />));
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
  });

  test('removing a terminal clears its Chat selection and detaches its transcript', async () => {
    const host = setup(agent);
    const binding = await openReadyChat(host, agent);
    revealChat();
    expect(agentTranscriptService.getState(binding.bindingToken)).not.toBeNull();

    act(() => renderer.update(
      <SessionScreen
        {...host.props}
        visible={false}
        terminalState={{ sessions: [], activeTerminalId: null }}
        terminalTargets={[]}
      />,
    ));
    expect(host.native.detachAgentChat).toHaveBeenCalledWith(binding.terminalId);
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    // Reusing the ID must not resurrect the removed terminal's presentation.
    act(() => renderer.update(<SessionScreen {...host.props} />));
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(control().loading).toBe(false);
  });

  test('tap Chat starts the spinner immediately, then persistent native no-chat shows remediation and stops it', async () => {
    const host = setup(agent);
    act(() => {
      renderer = create(<SessionScreen {...host.props} />);
    });
    let opening!: Promise<void>;
    act(() => {
      opening = control().onPress();
    });
    expect(control().loading).toBe(true);
    await act(async () => {
      await opening;
    });
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(3);
    expect(host.native.agentIntegrationStatus).toHaveBeenCalledWith(agent);
    expect(ui('IdentitySheet').props.warning).toMatchObject({
      agent,
      title: expect.stringContaining('identity unavailable'),
    });
    expect(control().loading).toBe(false);
  });

  test('stale native start after explicit open shows an alert and clears the presentation spinner', async () => {
    const host = setup(agent);
    bindChat(host, agent);
    act(() => {
      renderer = create(<SessionScreen {...host.props} />);
    });
    await act(async () => {
      await control().onPress();
    });
    expect(ui('Alert').props.visible).toBe(true);
    expect(ui('Alert').props.message).toContain('requested Chat binding');
    expect(control().loading).toBe(false);
    act(() => { ui('Alert').props.onClose(); });
    // Even if native reuses a token, a new explicit presentation must subscribe.
    await act(async () => {
      await control().onPress();
    });
    expect(ui('Alert').props.visible).toBe(true);
    expect(control().loading).toBe(false);
  });

  test('a usable transcript keeps loading until the viewport is ready, then becomes visible', async () => {
    const host = setup(agent);
    bindChat(host, agent);
    host.native.startAgentChat.mockReturnValue({
      type: 'started',
      state: {
        agent,
        sessionId: 'opaque-native-id',
        status: 'live',
        revision: 1,
        messages: [],
        turns: [],
      },
    });
    act(() => {
      renderer = create(<SessionScreen {...host.props} />);
    });
    await act(async () => {
      await control().onPress();
    });
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    const viewport = ui('AgentChatView');
    act(() => { viewport.props.onInitialViewportReady(); });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
    expect(control().loading).toBe(false);
    expect(ui('Alert').props.visible).toBe(false);
  });

  test('integration remediation installs the actual agent and settles into a restart warning', async () => {
    const host = setup(agent);
    host.native.agentIntegrationStatus.mockResolvedValueOnce('not-installed');
    act(() => {
      renderer = create(<SessionScreen {...host.props} />);
    });
    await act(async () => {
      await control().onPress();
    });
    expect(ui('IntegrationSheet').props.integration.agent).toBe(agent);
    expect(control().loading).toBe(false);
    await act(async () => {
      await ui('IntegrationSheet').props.onInstall();
    });
    expect(host.native.installAgentIntegration).toHaveBeenCalledWith(agent);
    expect(ui('IdentitySheet').props.warning.title).toContain('Restart');
    expect(control().loading).toBe(false);
  });

  test('a confirmed agent-to-shell transition during cache restoration closes quietly', async () => {
    const host = setup(agent);
    bindChat(host, agent);
    let restore!: (value: null) => void;
    jest.mocked(agentChatCache.loadNative).mockReturnValueOnce(
      new Promise(resolve => {
        restore = resolve;
      }),
    );
    act(() => {
      renderer = create(<SessionScreen {...host.props} />);
    });
    await act(async () => {
      await control().onPress();
    });
    expect(control().loading).toBe(true);
    const snapshot = {
      ...host.props.snapshot,
      panes: [
        {
          ...host.pane,
          agent: 'shell',
          display_agent: 'shell',
          agent_session: undefined,
        },
      ],
    };
    host.setSnapshot(snapshot);
    await act(async () => {
      renderer.update(<SessionScreen {...host.props} snapshot={snapshot} />);
      restore(null);
    });
    expect(ui('Alert').props.visible).toBe(false);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(control()).toBeUndefined();
  });
});
