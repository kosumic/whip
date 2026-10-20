import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AppShell } from '../src/components/AppShell';
import type { LiveSessionView } from '../src/components/LiveSessionView';
import type { useAgentChatOpen } from '../src/hooks/useAgentChatOpen';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';

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
jest.mock('../src/billing/rollout', () => ({
  getBillingRolloutPolicy: () => ({}),
}));
jest.mock('../src/billing/developerMembership', () => ({
  simulateDeveloperMembership: jest.fn(),
}));
jest.mock('../src/services/alerts', () => ({
  dismissAgentAlertsForTab: jest.fn(),
  alertAgent: jest.fn(),
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
jest.mock('../src/hooks/useSpinnerFrameRate', () => ({
  SpinnerFrameRateProvider: 'SpinnerProvider',
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
      const renderStatus = (connectionStatus: 'connected' | 'ready') => {
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
