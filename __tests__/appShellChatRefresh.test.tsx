import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';

import { AppShell } from '../src/components/AppShell';
import { LiveSessionView } from '../src/components/LiveSessionView';
import type { useAgentChatOpen } from '../src/hooks/useAgentChatOpen';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import type { TerminalRenderTarget } from '../src/lib/terminalRenderer';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('expo-blur', () => ({ BlurTargetView: 'BlurTargetView' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {}, isDark: false }),
}));
jest.mock('../src/billing/effectiveSettings', () => ({
  effectiveDevicePreferences: (value: unknown) => value,
}));
jest.mock('../src/services/alerts', () => ({
  dismissAgentAlertsForTab: jest.fn(),
  alertAgent: jest.fn(),
  transitionAgentAlert: jest.fn(),
}));
jest.mock('../src/services/backgroundMonitoring', () => ({
  startBackgroundMonitoring: jest.fn(),
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: jest.fn(),
  ignoreExpectedCancellation: jest.fn(),
}));
jest.mock('../src/services/NativeTranscriptService', () => ({
  agentTranscriptService: { activate: jest.fn() },
}));
jest.mock('../src/components/app-ui', () => ({
  AgentStatusAnimationProvider: 'AnimationProvider',
}));
jest.mock('../src/components/AppBackground', () => ({
  AppBackground: 'AppBackground',
}));
jest.mock('../src/components/AppOverlays', () => ({
  AppOverlays: 'AppOverlays',
}));
jest.mock('../src/components/BottomNavigation', () => ({
  BottomNavigation: 'BottomNavigation',
}));
jest.mock('../src/components/ConnectRequiredScreen', () => ({
  ConnectRequiredScreen: 'ConnectRequiredScreen',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassProvider: 'GlassProvider',
}));
jest.mock('../src/components/HerdScreen', () => ({ HerdScreen: 'HerdScreen' }));
jest.mock('../src/components/HostsScreen', () => ({
  HostsScreen: 'HostsScreen',
}));
jest.mock('../src/components/MoreScreen', () => ({ MoreScreen: 'MoreScreen' }));
jest.mock('../src/components/GlobalVoiceCall', () => ({ GlobalVoiceCall: 'GlobalVoiceCall' }));
jest.mock('../src/components/ScreenUpdates', () => ({
  ScreenUpdates: 'ScreenUpdates',
}));
jest.mock('../src/components/AppPlatformBindings', () => ({
  StableStatusBar: 'StatusBar',
  TerminalKeepAwake: 'KeepAwake',
  TerminalVolumeKeyBinding: 'VolumeKeys',
}));
jest.mock('../src/browser/BrowserSurface', () => ({
  BrowserSurface: 'BrowserSurface',
}));
jest.mock('../src/browser/registry', () => ({
  connectedBrowserRuntimes: () => [],
}));
jest.mock('../src/components/LiveSessionView', () => ({
  LiveSessionView: (props: ComponentProps<typeof LiveSessionView>) => {
    const { useAgentChatOpen } = require('../src/hooks/useAgentChatOpen');
    mockChatOpen = useAgentChatOpen({
      hostSessionId: props.session.id,
      terminalId: props.terminalState.activeTerminalId,
      pane: props.session.snapshot.panes[0],
      visible: props.visible,
      client: props.client,
      onBound: jest.fn(),
      onRefresh: jest.fn(),
    });
    return null;
  },
}));

let mockChatOpen: ReturnType<typeof useAgentChatOpen>;
type Props = ComponentProps<typeof AppShell>;

function setup() {
  const pane = {
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
    agent: 'codex',
  };
  const snapshot = { panes: [pane] };
  const native = {
    agentIntegrationStatus: jest.fn(async () => 'current'),
    installAgentIntegration: jest.fn(),
  };
  let finishRefresh!: (value: typeof snapshot) => void;
  const client = {
    native,
    activeNative: native,
    snapshot: jest.fn(
      () =>
        new Promise<typeof snapshot>(resolve => {
          finishRefresh = resolve;
        }),
    ),
  };
  const session = { id: 'host-1', connectionStatus: 'ready', snapshot };
  const props = {
    preferences: { value: { terminal: {} } },
    entitlements: {},
    hosts: {
      hosts: [],
      editorProfile: null,
      newHostOpen: false,
      unlockedGlobalKeys: null,
      knownHostsOpen: false,
    },
    sessions: {
      state: { revision: 1, sessions: [session] },
      herdView: () => ({ agents: [] }),
      getClient: () => client,
      activeSession: session,
      activeClient: client,
      presentationSessions: [session],
    },
    navigation: {
      state: { tab: 'terminal' },
      mountedTabs: new Set(['terminal']),
      licensesOpen: false,
    },
    remoteFiles: {},
    security: {},
    terminals: {
      get: () => ({ activeTerminalId: pane.terminal_id, sessions: [] }),
    },
    telemetry: { get: () => ({ latencyWarning: { active: false } }) },
    history: {},
  } as unknown as Props;
  return {
    props,
    client,
    native,
    snapshot,
    finishRefresh: () => finishRefresh(snapshot),
  };
}

test.each([false, true])('prepares the first three agents before opening Terminal (host selected=%s)', selected => {
  const host = setup();
  const panes = Array.from({ length: 5 }, (_, index) => ({
    ...host.snapshot.panes[0], terminal_id: `terminal-${index}`, pane_id: `pane-${index}`,
    agent_session: { agent: 'codex', kind: 'id', value: `session-${index}` },
  }));
  const herdView = jest.fn(() => ({ agents: [3, 1, 4, 0, 2].map(index => ({ hostId: 'host-1', agent: panes[index] })) }));
  const native = { ...host.native, hostState: jest.fn(() => { throw new Error('Use the committed presentation snapshot'); }) };
  const client = { ...host.client, native, activeNative: native };
  const session = { ...host.props.sessions.activeSession!, snapshot: { ...host.snapshot, panes } };
  const props = {
    ...host.props,
    navigation: { ...host.props.navigation, state: { ...host.props.navigation.state, tab: 'hosts' }, mountedTabs: new Set(['hosts']) },
    sessions: { ...host.props.sessions, activeSession: selected ? session : null, presentationSessions: [session], herdView, getClient: () => client },
  } as unknown as Props;
  let renderer!: ReactTestRenderer;
  try {
    act(() => { renderer = create(<AppShell {...props} />); });
    const view = renderer.root.findByType(LiveSessionView);
    expect(herdView).toHaveBeenCalledWith([]);
    expect(view.props.visible).toBe(false);
    expect(view.props.priorityChatTargets?.map((target: TerminalRenderTarget) => target.session.terminalId)).toEqual(['terminal-3', 'terminal-1', 'terminal-4']);
    const preparedTargets = view.props.priorityChatTargets;
    const terminalState = view.props.terminalState;
    act(() => { renderer.update(<AppShell {...props} sessions={{ ...props.sessions }} />); });
    expect(renderer.root.findByType(LiveSessionView).props.priorityChatTargets).toBe(preparedTargets);
    expect(renderer.root.findByType(LiveSessionView).props.terminalState).toBe(terminalState);
    expect(herdView).toHaveBeenCalledTimes(1);
  } finally {
    act(() => renderer?.unmount());
  }
});

test('tab switches reuse Herd presentation until native session data changes', () => {
  const { props: initial } = setup();
  const session = {
    ...initial.sessions.activeSession!, host: { name: 'Host', host: 'host', username: 'user' },
    snapshot: { ...initial.sessions.activeSession!.snapshot, workspaces: [], tabs: [] },
  };
  const herdView = jest.fn(() => ({ hosts: [], agents: [] }));
  let props = {
    ...initial,
    sessions: { ...initial.sessions, activeSession: session, presentationSessions: [session], herdView },
    navigation: { ...initial.navigation, state: { ...initial.navigation.state, tab: 'herd' }, mountedTabs: new Set(['herd']),
      herdHostFilterId: null, herdWorkspaceFilterIds: {} },
  } as unknown as Props;
  let renderer!: ReactTestRenderer;
  const herd = () => renderer.root.find(node => String(node.type) === 'ScreenUpdates').props.children().props;
  try {
    act(() => { renderer = create(<AppShell {...props} />); });
    const first = herd();
    const calls = herdView.mock.calls.length;
    props = { ...props, navigation: { ...props.navigation, state: { ...props.navigation.state, tab: 'more' } } };
    act(() => { renderer.update(<AppShell {...props} />); });
    expect(herd().agents).toBe(first.agents);
    expect(herd().queues).toBe(first.queues);
    expect(herdView).toHaveBeenCalledTimes(calls);
    props = { ...props, sessions: { ...props.sessions, state: { ...props.sessions.state, revision: props.sessions.state.revision + 1 } } };
    act(() => { renderer.update(<AppShell {...props} />); });
    expect(herd().agents).not.toBe(first.agents);
    expect(herdView.mock.calls.length).toBeGreaterThan(calls);
  } finally { act(() => { renderer.unmount(); }); }
});

test.each([
  ['android', true, ['left', 'right']],
  ['android', false, ['top', 'left', 'right']],
  ['ios', true, ['left', 'right']],
  ['ios', false, ['top', 'left', 'right']],
] as const)('%s respects full screen %s across app and terminal screens', (platform, fullscreen, edges) => {
  const { props } = setup();
  Platform.OS = platform;
  props.navigation.state.tab = 'hosts';
  props.preferences.value.fullscreenApp = fullscreen;
  props.preferences.value.terminal.fullscreen = fullscreen;
  let renderer!: ReactTestRenderer;
  try {
    act(() => { renderer = create(<AppShell {...props} />); });
    for (const tab of ['hosts', 'more', 'terminal'] as const) {
      props.navigation.state.tab = tab;
      act(() => { renderer.update(<AppShell {...props} />); });
      const safeArea = renderer.root.find(node => (node.type as unknown) === 'SafeAreaView');
      const statusBar = renderer.root.find(node => (node.type as unknown) === 'StatusBar');
      expect(safeArea.props.edges).toEqual(edges);
      expect(statusBar.props.hidden).toBe(fullscreen);
    }
  } finally {
    act(() => renderer?.unmount());
    Platform.OS = 'android';
  }
});

test.each(['current', 'not-installed'] as const)(
  'a Chat refresh preserves the connected SSH client and shows %s remediation without installing',
  async status => {
    const host = setup();
    host.native.agentIntegrationStatus.mockResolvedValue(status);
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const activate = jest
      .spyOn(agentTranscriptService, 'activate')
      .mockClear()
      .mockReturnValue({
        type: 'no-chat',
        terminalId: 'terminal-1',
        reason: 'unsupported-pane',
      });
    let renderer!: ReactTestRenderer;
    try {
      act(() => {
        renderer = create(<AppShell {...host.props} />);
      });
      let opening!: Promise<void>;
      act(() => {
        opening = mockChatOpen.open();
      });
      expect(mockChatOpen.pendingTerminalId).toBe('terminal-1');
      // Rust projects an in-flight refresh as connected, then returns to ready.
      const renderStatus = (connectionStatus: 'connected' | 'ready' | 'reconnecting' | 'disconnected') => {
        const sessions = {
          ...host.props.sessions,
          activeSession: {
            ...host.props.sessions.activeSession!,
            connectionStatus,
          },
        };
        act(() => {
          renderer.update(<AppShell {...host.props} sessions={sessions} />);
        });
      };
      renderStatus('connected');
      expect(mockChatOpen.pendingTerminalId).toBe('terminal-1');
      renderStatus('reconnecting');
      expect(mockChatOpen.pendingTerminalId).toBe('terminal-1');
      expect(renderer.root.findByType(LiveSessionView).props.client).toBe(host.client);
      renderStatus('disconnected');
      expect(mockChatOpen.pendingTerminalId).toBe('terminal-1');
      expect(renderer.root.findByType(LiveSessionView).props.client).toBe(host.client);
      renderStatus('ready');
      await act(async () => {
        host.finishRefresh();
        await opening;
      });
      expect(activate).toHaveBeenCalledTimes(2);
      expect(host.native.agentIntegrationStatus).toHaveBeenCalledWith('codex');
      expect(mockChatOpen.pendingTerminalId).toBeNull();
      expect(mockChatOpen.notice).toMatchObject(
        status === 'not-installed'
          ? { type: 'integration', integration: { agent: 'codex', status } }
          : { type: 'identity', agent: 'codex' },
      );
      expect(host.native.installAgentIntegration).not.toHaveBeenCalled();
    } finally {
      act(() => renderer?.unmount());
      jest.restoreAllMocks();
    }
  },
);
