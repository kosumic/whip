import { createRef, Profiler, type ComponentProps } from 'react';
import { Linking, Platform, type View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SessionScreen } from '../src/components/SessionScreen';
import { TerminalComposerStore } from '../src/lib/terminalComposerStore';
import { readSavedAgentTranscript } from 'react-native-whip-ssh';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import { listenToChat, readChatResponse } from '../src/services/chatSpeech';
import type { ChatAgent } from '../src/lib/agentChatSession';
import { AgentChatPresentationPhase } from '../src/lib/agentChatPresentation';
import { TerminalResidencyEndReason } from '../src/lib/terminalResidency';
import { terminalControlBarInset } from '../src/lib/floatingChrome';
import { browserRegistry, connectedBrowserRuntimes } from '../src/browser/registry';
import { supportsBrowserControl } from '../src/browser/native';
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
  requireNativeComponent: () => 'WhipTerminalInput',
  findNodeHandle: () => null,
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/chatSpeech', () => ({
  listenToChat: jest.fn(() => jest.fn()),
  readChatResponse: jest.fn((_target, _messages, onStopped) => jest.fn(onStopped)),
}));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-webview', () => 'WebView');
jest.mock('../src/browser/BrowserTunnelingSetting', () => ({
  BrowserTunnelingSetting: 'BrowserTunnelingSetting',
}));
jest.mock('../src/browser/native', () => ({
  supportsBrowserControl: jest.fn(() => false),
  supportsBrowserProxy: () => true,
  configureBrowserProxy: jest.fn(async () => undefined),
}));
const mockTunneledHosts = new Set<string>();
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    load: jest.fn(async () => undefined),
    tunneling: (hostId: string) => mockTunneledHosts.has(hostId),
  },
}));
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
  GlassSurface: 'GlassSurface',
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
        props.renderViewportOverlay?.({ top: 0, bottom: 0 }, 0, { open: false, onClose: noop }),
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
  FrostedAppBackground: 'FrostedAppBackground',
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
  addTerminalVolumeKeyListener: (listener: (key: 'up' | 'down') => void) => {
    mockVolumeKeyListeners.add(listener);
    return { remove: () => mockVolumeKeyListeners.delete(listener) };
  },
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
  sessionTabGlassStyle: () => ({}),
  sessionTabStatusColor: () => '',
  statusColor: () => '',
}));

type Props = ComponentProps<typeof SessionScreen> & {
  client: NonNullable<ComponentProps<typeof SessionScreen>['client']>;
};
const mockChatFrames: Array<{ visible: boolean; chat: boolean }> = [];
const mockVolumeKeyListeners = new Set<(key: 'up' | 'down') => void>();
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
    runtimeId: 'runtime-1',
    requestHerdrApi: jest.fn(async () => ({})),
    reverseControlSessions: () => [],
    reverseControlReply: jest.fn(),
    startBrowserProxy: jest.fn(async () => 9001),
    stopBrowserProxy: jest.fn(async () => undefined),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
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
    agentChatBindingIsCurrent: jest.fn(() => false),
    currentAgentChat: jest.fn(
      (terminalId: string, handler?: (event: NativeAgentTranscriptUpdate) => void): NativeAgentChatBinding | undefined => {
        if (handler) handlers.set(terminalId, handler);
        return bindings.get(terminalId);
      },
    ),
    startAgentChat: jest.fn(
      (_bindingToken: string): NativeAgentChatStartResult | Promise<NativeAgentChatStartResult> => ({ type: 'stale-binding' }),
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
    activeNative: native,
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
    hostId: 'saved-host',
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
    onOpenSshShell: jest.fn(),
    onSelectSshShell: jest.fn(),
    onRenameSshShell: jest.fn(),
    onCloseTerminal: jest.fn(),
    onTerminalStatus: jest.fn(),
    onTerminalFontSizeChange: jest.fn(),
    onTerminalChatSelect: jest.fn(),
    onOpenFiles: jest.fn(),
    composerStore: new TerminalComposerStore(),
    onTerminalControlUse: jest.fn(),
    onTerminalHistoryEntry: jest.fn(),
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
  Platform.OS = 'android';
  mockChatFrames.length = 0;
  mockVolumeKeyListeners.clear();
  mockTunneledHosts.clear();
  jest.mocked(supportsBrowserControl).mockReturnValue(false);
  jest.mocked(listenToChat).mockClear();
  jest.mocked(readChatResponse).mockClear();
  jest.mocked(Linking.openURL).mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.mocked(readSavedAgentTranscript).mockReset().mockResolvedValue(undefined);
});

test('attachment picker keeps the opening composer blur source and clears it for normal attachments', async () => {
  const host = setup('codex');
  const composerTarget = createRef<View>();
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  act(() => { ui('TerminalScreen').props.onRequestAttachment(composerTarget); });
  expect(ui('AttachmentSheet').props.visible).toBe(true);
  expect(ui('AttachmentSheet').props.blurTarget).toBe(composerTarget);

  act(() => { ui('AttachmentSheet').props.onClose(); });
  act(() => { ui('TerminalScreen').props.onRequestAttachment(); });
  expect(ui('AttachmentSheet').props.visible).toBe(true);
  expect(ui('AttachmentSheet').props.blurTarget).toBeUndefined();
});

test('interacting with a completed agent acknowledges it through Herdr once per pending request', async () => {
  const host = setup('codex');
  host.pane.agent_status = 'done';
  let finishFocus!: (value: object) => void;
  host.native.requestHerdrApi.mockImplementationOnce(() => new Promise(resolve => {
    finishFocus = resolve;
  }));
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();

  const terminal = ui('TerminalScreen');
  let touchSurface = terminal.parent;
  while (touchSurface && !touchSurface.props.onTouchStart) touchSurface = touchSurface.parent;
  expect(touchSurface).not.toBeNull();
  act(() => {
    touchSurface!.props.onTouchStart();
    terminal.props.onInteraction(host.props.terminalTargets[0]);
    terminal.props.onInteraction(host.props.terminalTargets[0]);
  });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(1);
  expect(host.native.requestHerdrApi).toHaveBeenCalledWith({
    method: 'pane.focus', params: { pane_id: host.pane.pane_id },
  });
  // The UI waits for authoritative state; touching does not rewrite a cached status.
  expect(host.pane.agent_status).toBe('done');
  await act(async () => { finishFocus({}); });

  host.pane.agent_status = 'idle';
  act(() => { terminal.props.onInteraction(host.props.terminalTargets[0]); });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(1);
  host.pane.agent_status = 'done';
  await act(async () => { terminal.props.onInteraction(host.props.terminalTargets[0]); });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(2);
});

test.each(['working', 'blocked', 'idle'] as const)('interaction preserves an agent’s %s status', async status => {
  const host = setup('codex');
  host.pane.agent_status = status;
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  act(() => { ui('TerminalScreen').props.onInteraction(host.props.terminalTargets[0]); });
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
  expect(host.pane.agent_status).toBe(status);
});

test.each(['hidden', 'background', 'offline', 'stale', 'different-terminal'] as const)(
  'does not acknowledge completion from an ineligible %s interaction',
  async reason => {
    const host = setup('codex');
    host.pane.agent_status = 'done';
    if (reason === 'hidden') host.props.visible = false;
    if (reason === 'offline') Object.assign(host.client, { activeNative: null });
    if (reason === 'stale') host.native.hostState.mockReturnValue({
      syncStatus: 'synced', freshness: 'stale', snapshot: host.props.snapshot,
    });
    const target = host.props.terminalTargets[0];
    if (reason === 'different-terminal') target.session = {
      ...target.session, terminalId: 'replaced-terminal',
    };
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    if (reason === 'background') {
      act(() => { for (const listener of mockAppStateListeners) listener('background'); });
    }
    act(() => { ui('TerminalScreen').props.onInteraction(target); });
    expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
  },
);

test('session rail follows measured terminal controls and keyboard visibility', async () => {
  const host = setup('codex');
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  const back = renderer.root.findByProps({ accessibilityLabel: 'session.backToHerd' });
  const rail = back.parent!;
  const railContainer = rail.parent!;
  const measuredBottom = terminalControlBarInset(34) + 8;

  expect(railContainer.props.style.bottom).toBe(terminalControlBarInset(0));
  for (const { keyboardInset, visible } of [
    { keyboardInset: 300, visible: false },
    { keyboardInset: 0, visible: true },
  ]) {
    act(() => {
      ui('TerminalScreen').props.onSessionChromeLayoutChange({
        bottom: measuredBottom + keyboardInset, visible,
      });
    });
    expect(railContainer.props.style.bottom).toBe(measuredBottom + keyboardInset);
    expect(rail.props.pointerEvents).toBe(visible ? 'auto' : 'none');
    expect(rail.props.style?.display).toBe(visible ? undefined : 'none');
  }
});

test.each([false, true])('offline terminal shows cached chat (restored selection=%s)', async chatSelected => {
  const host = setup('codex');
  host.props.snapshot.tabs[0].label_is_custom = false;
  jest.mocked(readSavedAgentTranscript).mockResolvedValue({
    sessionId: host.pane.agent_session!.value,
    info: { id: host.pane.agent_session!.value, title: 'Explicitly loaded saved conversation' },
    agent: 'codex',
    revision: 1,
    status: 'stale',
    messages: [],
    turns: [],
  });
  await act(async () => {
    renderer = create(<SessionScreen
      {...host.props}
      client={null}
      terminalTargets={[]}
      terminalState={{
        activeTerminalId: host.pane.terminal_id,
        sessions: [{
          ...host.props.terminalState.sessions[0],
          status: 'disconnected',
          chatSelected,
        }],
      }}
    />);
  });
  if (!chatSelected) await act(async () => { await control().onPress(); });
  expect(readSavedAgentTranscript).toHaveBeenCalledWith('host-1', 'codex', host.pane.agent_session!.value);
  expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
  expect(ui('AgentChatView').props.state.transcript.sessionId)
    .toBe(host.pane.agent_session!.value);
  expect(host.native.openAgentChat).not.toHaveBeenCalled();
  expect(tabLabels()).toContain('Explicitly loaded saved conversation');
  expect(readSavedAgentTranscript).toHaveBeenCalledTimes(1);
  await act(async () => {
    ui('AgentChatView').props.onOpenWebLink('https://example.com/docs');
  });
  expect(renderer.root.find(node => String(node.type) === 'WebView' && node.props.source?.uri === 'https://example.com/docs')).toBeDefined();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('volume key tab navigation uses the current action after settings change', async () => {
  const host = setup('codex');
  const nextPane = {
    ...host.pane,
    pane_id: 'pane-2',
    terminal_id: 'terminal-2',
    tab_id: 'tab-2',
    focused: false,
  };
  const snapshot = {
    ...host.props.snapshot,
    panes: [host.pane, nextPane],
    tabs: [
      ...host.props.snapshot.tabs,
      { workspace_id: 'workspace-1', tab_id: 'tab-2', focused: false },
    ],
  } as HerdrSnapshot;
  host.props.snapshot = snapshot;
  host.setSnapshot(snapshot);
  Object.assign(host.native, { requestHerdrApi: jest.fn(async () => ({})) });

  act(() => { renderer = create(<SessionScreen {...host.props} />); });
  act(() => renderer.update(<SessionScreen {...host.props} terminalPreferences={{
    ...host.props.terminalPreferences,
    volumeDownAction: 'terminal-tab',
  }} />));
  await act(async () => { for (const listener of mockVolumeKeyListeners) listener('down'); });

  expect(host.props.onActivateTerminal).toHaveBeenCalledWith(nextPane);
});

test('plain SSH tabs use the shared create, switch, rename, close and volume controls', async () => {
  const host = setup('codex');
  const shells = ['Build', 'Logs'].map((title, index) => ({
    terminalId: `__whip_ssh_shell__:${index + 1}`,
    paneId: `__whip_ssh_shell__:${index + 1}`,
    title,
    kind: 'ssh' as const,
    status: 'connected' as const,
    reconnectAttempt: 0,
  }));
  host.props.terminalState = { sessions: shells, activeTerminalId: shells[0].terminalId };
  host.props.terminalTargets = shells.map(session => ({
    key: session.terminalId, hostSessionId: host.props.hostSessionId, client: host.client, session,
  }));
  host.props.snapshot = {
    ...host.props.snapshot, server: { ...host.props.snapshot.server, running: false },
    panes: [], tabs: [], workspaces: [], agents: [],
  };
  host.setSnapshot(host.props.snapshot);
  host.props.terminalPreferences = { ...host.props.terminalPreferences, volumeDownAction: 'terminal-tab' };
  act(() => { renderer = create(<SessionScreen {...host.props} />); });
  const tabButtons = (label: string) => renderer.root.findAll(node =>
    String(node.type) === 'Button' && node.props.accessibilityLabel === label);
  expect(tabButtons('session.openTab')).toHaveLength(2);
  expect(host.props.onActivateTerminal).not.toHaveBeenCalled();
  act(() => { tabButtons('session.openTab')[1].props.onPress(); });
  expect(host.props.onSelectSshShell).toHaveBeenLastCalledWith(shells[1].terminalId);
  act(() => { for (const listener of mockVolumeKeyListeners) listener('down'); });
  expect(host.props.onSelectSshShell).toHaveBeenLastCalledWith(shells[1].terminalId);

  act(() => { tabButtons('session.openTab')[1].props.onLongPress(); });
  expect(ui('EditorSheet').props.title).toBe('session.renameTab');
  expect(ui('Input').props.value).toBe('Logs');
  act(() => { ui('Input').props.onChangeText('Server logs'); });
  await act(async () => { await ui('EditorSheet').props.onSave(); });
  expect(host.props.onRenameSshShell).toHaveBeenCalledWith(shells[1].terminalId, 'Server logs');

  act(() => { tabButtons('session.newTab')[0].props.onPress(); });
  expect(ui('EditorSheet').props.title).toBe('session.newTab');
  expect(ui('Input').props.placeholder).toBe('terminal.sshShell');
  act(() => { ui('Input').props.onChangeText('Deploy'); });
  await act(async () => { await ui('EditorSheet').props.onSave(); });
  expect(host.props.onOpenSshShell).toHaveBeenCalledWith('Deploy');
  act(() => { tabButtons('session.closeTab')[0].props.onPress(); });
  expect(host.props.onCloseTerminal).toHaveBeenCalledWith(shells[0].terminalId);
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
});

test('an active SSH tab remains selected when a focused Herdr workspace appears', () => {
  const host = setup('codex');
  const shell = {
    terminalId: '__whip_ssh_shell__:1', paneId: '__whip_ssh_shell__:1',
    title: 'Build', kind: 'ssh' as const, status: 'connected' as const, reconnectAttempt: 0,
  };
  host.props.terminalState = { sessions: [shell], activeTerminalId: shell.terminalId };
  host.props.terminalTargets = [{
    key: shell.terminalId, hostSessionId: host.props.hostSessionId, client: host.client, session: shell,
  }];
  act(() => { renderer = create(<SessionScreen {...host.props} />); });
  expect(host.props.onActivateTerminal).not.toHaveBeenCalled();
  expect(renderer.root.findAll(node => String(node.type) === 'Button' &&
    node.props.accessibilityLabel === 'session.openTab')).toHaveLength(1);
  expect(ui('TerminalScreen').props.activeTarget.session.terminalId).toBe(shell.terminalId);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await browserRegistry.closeHost('runtime-1');
  });
  browserRegistry.registerRuntimes([]);
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

function bindTitledChat(host: ReturnType<typeof setup>, agent: ChatAgent, title: string) {
  const sessionId = host.pane.agent_session!.value;
  const binding = bindChat(host, agent, { sessionId });
  binding.state = { ...binding.state, sessionId, status: 'live', revision: 1, info: { id: sessionId, title } };
  host.native.startAgentChat.mockImplementation(() => ({ type: 'started', state: binding.state }));
  host.props.snapshot.tabs[0] = {
    ...host.props.snapshot.tabs[0], label: 'Herdr label', label_is_custom: false,
  };
  return binding;
}

function tabLabels() {
  return renderer.root.findAll(node => String(node.type) === 'Text' && node.props.numberOfLines === 1)
    .map(node => node.props.children);
}

function emitTitle(host: ReturnType<typeof setup>, binding: NativeAgentChatBinding, title?: string) {
  binding.state = { ...binding.state, revision: binding.state.revision + 1, info: { id: binding.sessionId, title } };
  host.handlers.get(binding.terminalId)!({
    key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
    revision: binding.state.revision,
    deltas: [{ type: 'info-changed', info: binding.state.info }],
  });
}

test.each(['claude', 'codex', 'opencode'] as const)('%s titles follow loaded metadata without opening inactive transcripts', async agent => {
  const host = setup(agent);
  const binding = bindTitledChat(host, agent, 'Loaded conversation');
  host.props.snapshot.tabs.push({ ...host.props.snapshot.tabs[0], tab_id: 'inactive', label: 'Inactive' });
  host.props.snapshot.panes.push({ ...host.pane, tab_id: 'inactive', pane_id: 'inactive-pane', terminal_id: 'inactive-terminal' });
  const renders = jest.fn();
  await act(async () => { renderer = create(<Profiler id="tabs" onRender={renders}><SessionScreen {...host.props} /></Profiler>); });
  expect(tabLabels()).toEqual(expect.arrayContaining(['Loaded conversation', 'Inactive']));
  const openCount = host.native.openAgentChat.mock.calls.length;
  const startCount = host.native.startAgentChat.mock.calls.length;
  const renderCount = renders.mock.calls.length;
  act(() => { emitTitle(host, binding, 'Loaded conversation'); });
  expect(renders).toHaveBeenCalledTimes(renderCount);
  act(() => { emitTitle(host, binding, 'Updated conversation'); });
  expect(tabLabels()).toContain('Updated conversation');
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(openCount);
  expect(host.native.openAgentChat.mock.calls.every(([terminalId]) => terminalId === binding.terminalId)).toBe(true);
  expect(host.native.startAgentChat).toHaveBeenCalledTimes(startCount);
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
  expect(readSavedAgentTranscript).not.toHaveBeenCalled();
});

test.each([true, undefined])('manual or unknown rename origin (%s) preserves the tab label as metadata changes', async origin => {
  const host = setup('claude');
  const binding = bindTitledChat(host, 'claude', 'Automatic');
  host.props.snapshot.tabs[0].label_is_custom = origin;
  const renders = jest.fn();
  await act(async () => { renderer = create(<Profiler id="tabs" onRender={renders}><SessionScreen {...host.props} /></Profiler>); });
  const renderCount = renders.mock.calls.length;
  act(() => { emitTitle(host, binding, 'Changed automatic'); });
  expect(renders).toHaveBeenCalledTimes(renderCount);
  expect(tabLabels()).toContain('Herdr label');
  expect(tabLabels()).not.toContain('Changed automatic');
});

test('a title remains after transcript eviction without reloading, and never survives a session switch', async () => {
  const host = setup('codex');
  bindTitledChat(host, 'codex', 'Retained conversation');
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  const openCount = host.native.openAgentChat.mock.calls.length;
  const startCount = host.native.startAgentChat.mock.calls.length;
  await act(async () => { renderer.update(<SessionScreen {...host.props} visible={false} />); });
  act(() => { ui('TerminalScreen').props.onResidencyEnd(host.props.terminalTargets[0], TerminalResidencyEndReason.Evicted); });
  expect(tabLabels()).toContain('Retained conversation');
  const snapshot = { ...host.props.snapshot, panes: [{
    ...host.pane, agent_session: { ...host.pane.agent_session!, value: 'resumed-session' },
  }] };
  host.setSnapshot(snapshot);
  await act(async () => { renderer.update(<SessionScreen {...host.props} snapshot={snapshot} visible={false} />); });
  expect(tabLabels()).toContain('Herdr label');
  expect(tabLabels()).not.toContain('Retained conversation');
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(openCount);
  expect(host.native.startAgentChat).toHaveBeenCalledTimes(startCount);
  expect(readSavedAgentTranscript).not.toHaveBeenCalled();
});

test('metadata changes and transcript resets update the label while Chat is open', async () => {
  const host = setup('opencode');
  const binding = bindTitledChat(host, 'opencode', 'Initial conversation');
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  await act(async () => { await control().onPress(); });
  act(() => { emitTitle(host, binding, 'Renamed conversation'); });
  expect(tabLabels()).toContain('Renamed conversation');
  act(() => {
    binding.state = { ...binding.state, revision: binding.state.revision + 1, info: undefined, messages: [], turns: [] };
    host.handlers.get(binding.terminalId)!({
      key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
      revision: binding.state.revision, deltas: [{ type: 'reset', state: binding.state }],
    });
  });
  expect(tabLabels()).toContain('Herdr label');
  expect(tabLabels()).not.toContain('Renamed conversation');
});

test('loaded background tabs receive title changes without activating their transcripts', async () => {
  const host = setup('codex');
  const first = bindTitledChat(host, 'codex', 'Codex conversation');
  const second = bindChat(host, 'opencode', {
    bindingToken: 'binding-2', bindingGeneration: 2, transcriptKey: 'transcript-2',
    terminalId: 'terminal-2', paneId: 'pane-2', sessionId: 'session-2',
  });
  second.state = { ...second.state, sessionId: second.sessionId, status: 'live', revision: 1,
    info: { id: second.sessionId, title: 'OpenCode conversation' } };
  const pane = { ...host.pane, pane_id: second.paneId, terminal_id: second.terminalId, tab_id: 'tab-2',
    agent_session: { ...host.pane.agent_session!, agent: second.agent, value: second.sessionId } };
  host.props.snapshot.panes.push(pane);
  host.props.snapshot.tabs.push({ ...host.props.snapshot.tabs[0], tab_id: pane.tab_id, label: 'Second tab' });
  const terminal = { ...host.props.terminalState.sessions[0], terminalId: pane.terminal_id, paneId: pane.pane_id };
  host.props.terminalState.sessions.push(terminal);
  host.props.terminalTargets = [...host.props.terminalTargets,
    { ...host.props.terminalTargets[0], key: 'target-2', session: terminal }];
  host.native.startAgentChat.mockImplementation(token => ({
    type: 'started', state: token === first.bindingToken ? first.state : second.state,
  }));
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
  expect(tabLabels()).toContain('Second tab');
  const select = async (terminalId: string) => {
    host.props.terminalState = { ...host.props.terminalState, activeTerminalId: terminalId };
    await act(async () => { renderer.update(<SessionScreen {...host.props} />); });
  };
  await select(second.terminalId);
  await select(first.terminalId);
  expect(tabLabels()).toEqual(expect.arrayContaining(['Codex conversation', 'OpenCode conversation']));
  const calls = host.native.openAgentChat.mock.calls.length;
  act(() => { emitTitle(host, second, 'Updated background conversation'); });
  expect(tabLabels()).toEqual(expect.arrayContaining(['Codex conversation', 'Updated background conversation']));
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(calls);
});

test('resume rebinds title identity and ignores late updates from the previous conversation', async () => {
  const host = setup('codex');
  const first = bindTitledChat(host, 'codex', 'Original conversation');
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
  const oldHandler = host.handlers.get(first.terminalId)!;
  const resumed = bindChat(host, 'codex', {
    bindingToken: 'binding-2', bindingGeneration: 2, sessionId: 'resumed-session', transcriptKey: 'resumed-transcript',
  });
  resumed.state = { ...resumed.state, sessionId: resumed.sessionId, revision: 1, status: 'live',
    info: { id: resumed.sessionId, title: 'Resumed conversation' } };
  host.bindings.set(resumed.terminalId, resumed);
  host.native.startAgentChat.mockImplementation(() => ({ type: 'started', state: resumed.state }));
  const snapshot = { ...host.props.snapshot, panes: [{ ...host.pane,
    agent_session: { ...host.pane.agent_session!, value: resumed.sessionId },
  }] };
  host.setSnapshot(snapshot);
  await act(async () => { renderer.update(<SessionScreen {...host.props} snapshot={snapshot} />); });
  expect(tabLabels()).toContain('Resumed conversation');
  act(() => { oldHandler({
    key: first.transcriptKey, runtimeIncarnation: first.runtimeIncarnation, revision: 10,
    deltas: [{ type: 'info-changed', info: { id: first.sessionId, title: 'Late old title' } }],
  }); });
  expect(tabLabels()).toContain('Resumed conversation');
  expect(tabLabels()).not.toContain('Late old title');
});

test('Codex identity reads follow visible chat entry and activity without repeating on transcript updates', async () => {
  const host = setup('codex');
  const binding = await openReadyChat(host, 'codex');
  const identityRequest = {
    method: 'pane.get', params: { pane_id: host.pane.pane_id },
  };
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(1);
  expect(host.native.requestHerdrApi).toHaveBeenLastCalledWith(identityRequest);
  revealChat();
  act(() => {
    binding.state = { ...binding.state, revision: 2 };
    host.handlers.get(binding.terminalId)?.({
      key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
      revision: 2, deltas: [{ type: 'reset', state: binding.state }],
    });
    renderer.update(<SessionScreen {...host.props} />);
  });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(1);

  await act(async () => {
    host.pane.agent_status = 'working';
    renderer.update(<SessionScreen {...host.props} snapshot={{ ...host.props.snapshot }} />);
  });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(2);
  expect(host.native.requestHerdrApi).toHaveBeenLastCalledWith(identityRequest);

  // A warm Chat is retained after closing, but does not read identity while hidden.
  act(() => { control().onPress(); });
  await act(async () => {
    host.pane.agent_status = 'idle';
    renderer.update(<SessionScreen {...host.props} />);
  });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(2);
  await act(async () => { control().onPress(); });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(3);
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
});

test.each(['hidden', 'background'] as const)('Codex identity refreshes once when %s Chat returns', async reason => {
  const host = setup('codex');
  await openReadyChat(host, 'codex');
  revealChat();
  host.native.requestHerdrApi.mockClear();
  act(() => {
    if (reason === 'hidden') renderer.update(<SessionScreen {...host.props} visible={false} />);
    else for (const listener of mockAppStateListeners) listener('background');
  });
  await act(async () => {
    host.pane.agent_status = 'working';
    renderer.update(<SessionScreen {...host.props} visible={reason !== 'hidden'} />);
  });
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
  await act(async () => {
    if (reason === 'hidden') renderer.update(<SessionScreen {...host.props} />);
    else for (const listener of mockAppStateListeners) listener('active');
  });
  expect(host.native.requestHerdrApi).toHaveBeenCalledTimes(1);
  expect(host.native.requestHerdrApi).toHaveBeenCalledWith({
    method: 'pane.get', params: { pane_id: host.pane.pane_id },
  });
  expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
});

test('other chat agents do not make Codex identity reads', async () => {
  const host = setup('opencode');
  await openReadyChat(host, 'opencode');
  revealChat();
  await act(async () => {
    host.pane.agent_status = 'working';
    renderer.update(<SessionScreen {...host.props} />);
  });
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
});

test('Codex identity refresh skips a detached host runtime', async () => {
  const host = setup('codex');
  await openReadyChat(host, 'codex');
  revealChat();
  host.native.requestHerdrApi.mockClear();
  Object.assign(host.client, { activeNative: null });
  await act(async () => {
    host.pane.agent_status = 'working';
    renderer.update(<SessionScreen {...host.props} />);
  });
  expect(host.native.requestHerdrApi).not.toHaveBeenCalled();
});

test('chat web links open in app without a global browser preference', async () => {
  const host = setup('codex');
  await openReadyChat(host, 'codex');
  revealChat();
  const url = 'https://example.com/docs';
  await act(async () => { ui('AgentChatView').props.onOpenWebLink(url); });
  const browsers = renderer.root.findAll(node => String(node.type) === 'WebView' && node.props.source?.uri === url);
  expect(browsers).toHaveLength(1);
  expect(browsers[0].parent?.parent?.parent?.props.visible).toBe(true);
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test.each([true, false])('chat links use the host browser with tunneling=%s', async tunneling => {
  const host = setup('codex');
  const url = 'http://localhost:5173/docs';
  if (tunneling) mockTunneledHosts.add('saved-host');
  browserRegistry.registerRuntimes(connectedBrowserRuntimes([
    { id: 'host-1', hostId: 'saved-host', connectionStatus: 'ready' },
  ], () => host.native));
  const identity = { runtimeId: host.native.runtimeId, sessionId: 'manual-host-1-' + host.pane.terminal_id, paneId: host.pane.pane_id, terminalId: host.pane.terminal_id };
  const entry = browserRegistry.ensure(identity, host.native, false);
  const navigate = jest.spyOn(entry.controller, 'action').mockResolvedValue({});
  jest.mocked(supportsBrowserControl).mockReturnValue(true);
  await openReadyChat(host, 'codex');
  revealChat();
  await act(async () => { ui('AgentChatView').props.onOpenWebLink(url); });
  expect(navigate).toHaveBeenCalledWith('new_tab', { url });
  expect(browserRegistry.visibleId).toBe(identity.sessionId);
  expect(ui('BrowserTunnelingSetting').props.runtimeId).toBe(host.native.runtimeId);
  expect(mockTunneledHosts.has('saved-host')).toBe(tunneling);
  expect(host.native.startWebPreview).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test.each(['terminal', 'terminal links'])('%s opens a new tab or focuses the matching tab', async source => {
  const host = setup('codex');
  const url = 'https://example.com/docs?view=terminal#setup';
  const identity = { runtimeId: host.native.runtimeId, sessionId: 'manual-host-1-' + host.pane.terminal_id, paneId: host.pane.pane_id, terminalId: host.pane.terminal_id };
  const entry = browserRegistry.ensure(identity, host.native, false);
  const original = entry.controller.tab();
  entry.controller.navigation(original.id, { url: 'https://example.com/current', title: 'Current page', canGoBack: true, canGoForward: false });
  const action = jest.spyOn(entry.controller, 'action').mockResolvedValue({});
  jest.mocked(supportsBrowserControl).mockReturnValue(true);
  await act(async () => { renderer = create(<SessionScreen {...host.props} />); });

  const openLink = async () => {
    if (source === 'terminal') {
      await act(async () => { ui('TerminalScreen').props.onOpenLink(url); });
      return;
    }
    act(() => { ui('TerminalScreen').props.onRequestLinks(); });
    act(() => { ui('TerminalScreen').props.onLinksScanned([url]); });
    const link = renderer.root.find(node => String(node.type) === 'Button' && node.findAll(child => String(child.type) === 'Text' && child.props.children === url).length > 0);
    await act(async () => { link.props.onPress(); });
  };

  await openLink();
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith('new_tab', { url });

  act(() => {
    const tab = entry.controller.newTab();
    entry.controller.navigation(tab.id, { url, title: 'Docs', canGoBack: true, canGoForward: false });
    entry.controller.select(original.id);
    browserRegistry.hide();
  });
  await openLink();

  expect(entry.controller.selectedTabId).toBe(entry.controller.tabs[1].id);
  expect(browserRegistry.visibleId).toBe(identity.sessionId);
  expect(entry.controller.tabs).toHaveLength(2);
  expect(original).toMatchObject({ url: 'https://example.com/current', title: 'Current page', canGoBack: true });
  expect(action).toHaveBeenCalledTimes(1);
});

test('legacy browser opens localhost directly when host tunneling is disabled', async () => {
  const host = setup('codex');
  const url = 'http://localhost:5173/docs';
  await openReadyChat(host, 'codex');
  revealChat();
  await act(async () => { ui('AgentChatView').props.onOpenWebLink(url); });
  expect(renderer.root.find(node => String(node.type) === 'WebView' && node.props.source?.uri === url)).toBeDefined();
  expect(host.native.startWebPreview).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('legacy browser cannot silently bypass an enabled host tunnel', async () => {
  const host = setup('codex');
  mockTunneledHosts.add('saved-host');
  browserRegistry.registerRuntimes(connectedBrowserRuntimes([
    { id: 'host-1', hostId: 'saved-host', connectionStatus: 'ready' },
  ], () => host.native));
  await openReadyChat(host, 'codex');
  revealChat();
  const url = 'https://example.com/docs';
  await act(async () => {
    ui('AgentChatView').props.onOpenWebLink(url);
  });
  expect(renderer.root.findAll(node => String(node.type) === 'WebView' && node.props.source?.uri === url)).toHaveLength(0);
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(host.native.startWebPreview).not.toHaveBeenCalled();
});

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
  test.each([false, true])('restores Chat after remount (late storage=%s) and saves Terminal selection', async lateStorage => {
    const host = setup(agent);
    await openReadyChat(host, agent);
    revealChat();
    expect(host.props.onTerminalChatSelect).toHaveBeenLastCalledWith('host-1', 'terminal-1', true);
    const selected = { ...host.props.terminalState.sessions[0], chatSelected: true };
    act(() => renderer.unmount());

    if (!lateStorage) {
      host.props.terminalState = { activeTerminalId: selected.terminalId, sessions: [selected] };
      host.props.terminalTargets = [{ ...host.props.terminalTargets[0], session: selected }];
    }
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    if (lateStorage) {
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
      host.props.terminalState = { activeTerminalId: selected.terminalId, sessions: [selected] };
      host.props.terminalTargets = [{ ...host.props.terminalTargets[0], session: selected }];
      await act(async () => { renderer.update(<SessionScreen {...host.props} />); });
    }
    expect(control().loading).toBe(true);
    revealChat();
    act(() => { control().onPress(); });
    expect(host.props.onTerminalChatSelect).toHaveBeenLastCalledWith('host-1', 'terminal-1', false);
    const terminal = { ...selected, chatSelected: false };
    host.props.terminalState = { activeTerminalId: terminal.terminalId, sessions: [terminal] };
    host.props.terminalTargets = [{ ...host.props.terminalTargets[0], session: terminal }];
    act(() => renderer.unmount());
    await act(async () => { renderer = create(<SessionScreen {...host.props} />); });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(control().active).toBe(false);
  });

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
    expect(host.native.startAgentChat).not.toHaveBeenCalled();
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
    let restore!: () => void;
    host.native.startAgentChat.mockImplementation(() => new Promise(resolve => { restore = () => {
      binding.state = { ...binding.state, status: 'stale', revision: 1 };
      resolve({ type: 'started', state: binding.state });
    }; }));
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    const terminal = ui('WebView');
    expect(mockChatFrames[0]).toEqual({ visible: true, chat: false });
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(binding.bindingToken);
    expect(control()).toMatchObject({ active: false, loading: false, disabled: false });
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(ui('Alert').props.visible).toBe(false);
    expect(ui('IntegrationSheet').props.integration).toBeNull();
    expect(ui('IdentitySheet').props.warning).toBeNull();
    expect(host.client.snapshot).not.toHaveBeenCalled();
    expect(host.props.onRefresh).not.toHaveBeenCalled();
    expect(host.native.agentIntegrationStatus).not.toHaveBeenCalled();

    if (readyBeforePress) {
      await act(async () => { restore(); });
      expect(control().loading).toBe(false);
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    }
    act(() => { control().onPress(); });
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    if (!readyBeforePress) {
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
      await act(async () => { restore(); });
    }
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(binding.bindingToken);
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
      collapsable: false,
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
    expect(viewport.parent?.props).toMatchObject({
      collapsable: false, pointerEvents: 'auto', style: { opacity: 1 },
    });
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
    const restores = new Map<string, () => void>();
    host.native.startAgentChat.mockImplementation(token => new Promise(resolve => {
      restores.set(token, () => {
        const binding = token === a.bindingToken ? a : b;
        binding.state = { ...binding.state, status: 'live', revision: 1, sessionId: binding.sessionId };
        resolve({ type: 'started', state: binding.state });
      });
    }));
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    act(visits[0]);
    await act(async () => { restores.get(a.bindingToken)?.(); });
    expect(control()).toMatchObject({ active: false, loading: false });
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    act(() => renderer.update(<SessionScreen {...host.props} />));
    await act(async () => { restores.get(b.bindingToken)?.(); });
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
    let restoreOld!: () => void;
    host.native.startAgentChat.mockImplementationOnce(() => new Promise(resolve => {
      restoreOld = () => resolve({type: 'stale-binding'});
    }));
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
    await act(async () => { restoreOld(); });
    expect(agentTranscriptService.getState(old.bindingToken)).toBeNull();
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(2);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(replacement.bindingToken);
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

  test('unmount while Rust restoration is pending discards its completion', async () => {
    const host = setup(agent);
    const binding = bindChat(host, agent);
    let restore!: () => void;
    host.native.startAgentChat.mockImplementationOnce(() => new Promise(resolve => {
      restore = () => resolve({type: 'stale-binding'});
    }));
    act(() => { renderer = create(<SessionScreen {...host.props} />); });
    act(() => renderer.unmount());
    await act(async () => { restore(); });
    expect(host.native.detachAgentChat).toHaveBeenCalledTimes(1);
    expect(host.native.startAgentChat).toHaveBeenCalledWith(binding.bindingToken);
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
  });

  test('manual reading pauses automatic listening and resumes it after playback', async () => {
    const host = setup(agent);
    host.props.ttsEnabled = true;
    const binding = await openReadyChat(host, agent);
    revealChat();
    act(() => {
      binding.state = {
        ...binding.state,
        revision: 2,
        messages: [{
          id: 'reply', role: 'assistant', completedAt: 1,
          diffs: [],
          parts: [{ id: 'prose', type: 'text', text: 'Latest response' }],
        }],
      };
      host.handlers.get(binding.terminalId)?.({
        key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
        revision: 2, deltas: [{ type: 'reset', state: binding.state }],
      });
    });
    const automaticStop = jest.mocked(listenToChat).mock.results[0].value;
    const turn = { id: 'selected-response', status: 'idle' as const, assistants: binding.state.messages, diffs: [] };
    expect(ui('AgentChatView').props.readAloud.canRead(turn)).toBe(true);
    expect(ui('TerminalScreen').props.chatReadAloud).toBeUndefined();
    act(() => { ui('AgentChatView').props.readAloud.toggle(turn); });
    expect(ui('AgentChatView').props.readAloud.readingTurnId).toBe(turn.id);
    expect(automaticStop).toHaveBeenCalledTimes(1);
    expect(readChatResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agent, bindingToken: binding.bindingToken }),
      binding.state.messages, expect.any(Function), expect.any(Function),
    );
    act(() => { jest.mocked(readChatResponse).mock.calls[0][2](); });
    expect(ui('AgentChatView').props.readAloud.readingTurnId).toBeNull();
    expect(listenToChat).toHaveBeenCalledTimes(2);
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

  test.each(['android', 'ios'] as const)('the shared TTS setting starts and stops reading the selected chat on %s', async platform => {
    Platform.OS = platform;
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
    expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
    expect(renderer.root.findAll(node => String(node.type) === 'AgentChatView')).toHaveLength(0);

    binding.state = { ...binding.state, status: 'loading', revision: 0 };
    let finishRestore!: () => void;
    host.native.startAgentChat.mockImplementationOnce(() => new Promise(resolve => {
      finishRestore = () => {
        binding.state = {...binding.state,status:'stale',revision:1};
        resolve({type:'started',state:binding.state});
      };
    }));
    mockChatFrames.length = 0;
    act(() => renderer.update(<SessionScreen {...host.props} />));
    expect(control().loading).toBe(true);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
    expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
    expect(host.native.startAgentChat).toHaveBeenCalledTimes(2);

    await act(async () => { finishRestore(); });
    expect(host.native.startAgentChat).toHaveBeenLastCalledWith(binding.bindingToken);
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
    let restore!: () => void;
    host.native.startAgentChat.mockImplementationOnce(() => new Promise(resolve => {
      restore = () => resolve({type:'stale-binding'});
    }));
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
      restore();
    });
    expect(ui('Alert').props.visible).toBe(false);
    expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
    expect(control()).toBeUndefined();
  });
});
