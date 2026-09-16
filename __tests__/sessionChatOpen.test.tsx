import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SessionScreen } from '../src/components/SessionScreen';
import { agentChatCache } from '../src/services/agentChatCache';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import { listenToChat } from '../src/services/chatSpeech';
import type { ChatAgent } from '../src/lib/agentChatSession';
import { AgentChatPresentationPhase } from '../src/lib/agentChatPresentation';
import type { HerdrSnapshot, PaneInfo } from '../src/types';
import type {
  NativeAgentChatBinding,
  NativeAgentChatOpenResult,
  NativeAgentChatStartResult,
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
  Platform: { OS: 'android' },
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
jest.mock('../src/components/TerminalScreen', () => ({
  TerminalScreen: 'TerminalScreen',
  TerminalBackground: 'TerminalBackground',
}));
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
const mockAppStateListeners = new Set<(state: string) => void>();
function setup(agent: ChatAgent) {
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
      (): NativeAgentChatOpenResult => ({
        type: 'no-chat',
        terminalId: 'terminal-1',
        reason: 'unsupported-pane',
      }),
    ),
    currentAgentChat: jest.fn(
      (_terminalId: string): NativeAgentChatBinding | undefined => undefined,
    ),
    startAgentChat: jest.fn(
      (): NativeAgentChatStartResult => ({ type: 'stale-binding' }),
    ),
    detachAgentChat: jest.fn(),
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
    terminalPreferences: { fullscreen: true } as Props['terminalPreferences'],
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
  jest.mocked(listenToChat).mockClear();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(agentChatCache, 'loadNative').mockResolvedValue(null);
});
afterEach(() => {
  act(() => renderer?.unmount());
  agentTranscriptService.reset();
  jest.restoreAllMocks();
});

function bindChat(host: ReturnType<typeof setup>, agent: ChatAgent) {
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
    },
  };
  host.native.openAgentChat.mockReturnValue(result);
  return result.binding;
}

async function openReadyChat(host: ReturnType<typeof setup>, agent: ChatAgent) {
  const binding = bindChat(host, agent);
  host.native.currentAgentChat.mockImplementation(terminalId =>
    terminalId === binding.terminalId ? binding : undefined,
  );
  host.native.startAgentChat.mockImplementation(() => {
    binding.state = { ...binding.state, status: 'live', revision: 1 };
    return { type: 'started', state: binding.state };
  });
  act(() => {
    renderer = create(<SessionScreen {...host.props} />);
  });
  await act(async () => {
    await control().onPress();
  });
  return binding;
}

function revealChat() {
  const viewport = ui('TerminalScreen').props.renderViewportOverlay(
    { top: 0, bottom: 0 },
    0,
  );
  act(() => { viewport.props.onInitialViewportReady(); });
  expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
}

describe.each(['codex', 'opencode'] as const)('%s SessionScreen', agent => {
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

  test.each(['unavailable', 'replaced'] as const)('restores a suspended chat after its host was %s on return', async reason => {
    const host = setup(agent);
    await openReadyChat(host, agent);
    revealChat();
    act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
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
    'bottom-tab navigation archives and restores %s Chat',
    async phase => {
      const host = setup(agent);
      await openReadyChat(host, agent);
      if (phase === AgentChatPresentationPhase.Visible) revealChat();

      act(() => renderer.update(<SessionScreen {...host.props} visible={false} />));
      expect(ui('TerminalScreen').props.visible).toBe(false);
      act(() => renderer.update(<SessionScreen {...host.props} visible />));

      await act(async () => {});
      expect(control().loading).toBe(true);
      revealChat();
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
      expect(control().active).toBe(true);
      expect(host.native.detachAgentChat).toHaveBeenCalledWith('terminal-1');
    },
  );

  test.each(navigationPhases)(
    'switching terminals releases A\'s %s Chat and restores its selection',
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
      expect(ui('TerminalScreen').props.renderViewportOverlay).toBeUndefined();
      act(() => renderer.update(<SessionScreen {...host.props} />));

      await act(async () => {});
      expect(control().loading).toBe(true);
      revealChat();
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(true);
      expect(control().active).toBe(true);
      act(selectB);
      expect(ui('TerminalScreen').props.chatViewEnabled).toBe(false);
      expect(host.native.detachAgentChat).toHaveBeenCalledWith('terminal-1');
    },
  );

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
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(2);
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
    const viewport = ui('TerminalScreen').props.renderViewportOverlay(
      { top: 0, bottom: 0 },
      0,
    );
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
