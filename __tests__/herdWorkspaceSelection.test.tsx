import { HerdrAgentKind, ReverseControlState } from 'react-native-whip-ssh';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomNavigation } from '../src/components/BottomNavigation';
import { HerdScreen } from '../src/components/HerdScreen';
import type { HerdHostQueue } from '../src/herdQueue';
import { AgentActionsPopup } from '../src/components/AgentActionsPopup';
import type { AgentInfo, AgentStatus, WorkspaceInfo } from '../src/types';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import type { AgentChatState } from '../src/agentChat';

jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/browser/native', () => ({
  supportsBrowserControl: () => true,
}));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name) }),
);
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  FlatList: (listProps: {
    data: unknown[];
    renderItem: (item: { item: unknown }) => unknown;
  }) => {
    const React = jest.requireActual('react');
    return React.createElement(
      'FlatList',
      listProps,
      listProps.data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: index },
          listProps.renderItem({ item }),
        ),
      ),
    );
  },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  PanResponder: { create: (handlers: unknown) => ({ panHandlers: handlers }) },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  Easing: {
    out: (value: unknown) => value,
    inOut: (value: unknown) => value,
    cubic: 'cubic',
    quad: 'quad',
  },
  useAnimatedStyle: (style: () => Record<string, unknown>) =>
    new Proxy({}, { get: (_target, property: string) => style()[property] }),
  useSharedValue: jest.fn((value: unknown) => {
    const React = jest.requireActual('react');
    return React.useRef({ value }).current;
  }),
  withDelay: (_delay: number, value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: jest.fn((value: unknown) => value),
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: jest.fn((fn, ...args) => fn(...args)),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ bottom: 0 })),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/src/herdQueue', () => jest.requireActual('../src/herdQueue'), {
  virtual: true,
});
jest.mock(
  '@/src/lib/herdTabSwipeActions',
  () => jest.requireActual('../src/lib/herdTabSwipeActions'),
  { virtual: true },
);
jest.mock('@/src/lib/motion', () => ({ DEFAULT_SPRING_CONFIG: {} }), {
  virtual: true,
});
jest.mock(
  '@/src/lib/herdrCreationFlows',
  () => ({
    createWorkspaceAndSelect: jest.fn(),
  }),
  { virtual: true },
);
jest.mock(
  '@/src/lib/inFlightSubmission',
  () => ({
    ...jest.requireActual('../src/lib/inFlightSubmission'),
  }),
  { virtual: true },
);
jest.mock(
  '@/src/lib/utils',
  () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }),
  {
    virtual: true,
  },
);
jest.mock(
  '@/src/hooks/useKeyboardInset',
  () => ({
    useKeyboardInset: () => ({ inset: 0, resetInset: jest.fn() }),
  }),
  { virtual: true },
);
jest.mock(
  '@/src/lib/terminalFonts',
  () => ({ terminalFontFamily: 'monospace' }),
  {
    virtual: true,
  },
);
jest.mock(
  '@/src/theme',
  () => ({
    appGlassControlStyle: () => undefined,
    colorWithAlpha: (color: string) => color,
    statusColor: () => '#000',
    useTheme: () => ({
      colors: {
        error: '#f00',
        primary: '#00f',
        text: '#000',
        textSecondary: '#333',
        textTertiary: '#666',
      },
    }),
  }),
  { virtual: true },
);
jest.mock('../src/components/app-ui', () => ({
  AgentStatusMedallion: 'AgentStatusMedallion',
  StatusBadge: 'StatusBadge',
  HerdrMark: 'HerdrMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/AppAlertPopup', () => ({
  AppAlertPopup: 'AppAlertPopup',
}));
jest.mock('../src/components/ConfirmationPopup', () => ({
  ConfirmationPopup: 'ConfirmationPopup',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassBackdrop: 'GlassBackdrop',
  GlassSurface: 'GlassSurface',
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/LiveSessionRail', () => ({
  LiveSessionRail: 'LiveSessionRail',
}));
jest.mock('../src/components/ResourceEditorSheet', () => ({
  ResourceEditorField: 'ResourceEditorField',
  ResourceEditorSheet: 'ResourceEditorSheet',
}));
jest.mock('../src/components/WorkspaceRail', () => ({
  WorkspaceRail: 'WorkspaceRail',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function workspace(id: string, focused = false): WorkspaceInfo {
  return {
    workspace_id: id,
    number: 1,
    label: id,
    focused,
    pane_count: 0,
    tab_count: 0,
    active_tab_id: `${id}-tab`,
    agent_status: 'idle',
  };
}

function queue(workspaces: WorkspaceInfo[]): HerdHostQueue {
  return {
    id: 'host-1',
    label: 'Host 1',
    address: 'host-1.example.test',
    running: true,
    refreshing: false,
    agents: [],
    workspaces,
    tabs: [],
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    queues: [queue([workspace('space-a', true), workspace('space-b')])],
    agents: [],
    sessions: [],
    selectedHostId: 'host-1',
    workspaceFilterId: 'space-a',
    agentCommand: 'codex',
    commandHistory: [],
    onSelectHost: jest.fn(),
    onWorkspaceFilterChange: jest.fn(),
    onCloseHost: jest.fn(),
    onNewHost: jest.fn(),
    onSelectWorkspace: jest.fn(),
    onFocusWorkspace: jest.fn().mockResolvedValue(undefined),
    onCreateWorkspace: jest.fn(),
    onRenameWorkspace: jest.fn(),
    onCloseWorkspace: jest.fn(),
    onCloseTab: jest.fn(),
    onRefresh: jest.fn(),
    onOpenTerminal: jest.fn(),
    onOpenFiles: jest.fn(),
    onLaunchTab: jest.fn(),
    onOpenSpace: jest.fn(),
    onStartServer: jest.fn(),
    onOpenSshShell: jest.fn(),
    ...overrides,
  };
}

function findHost(root: ReactTestInstance, type: string): ReactTestInstance {
  return root.find(node => node.type === type);
}

describe('Herd workspace selection intent', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    agentTranscriptService.reset();
  });

  test('a ready single host keeps its rail hidden and space actions available during refreshes', async () => {
    const screenProps = props({
      sessions: [{
        hostId: 'host-1',
        label: 'Host 1',
        status: 'ready',
        agentStatus: 'idle',
        terminalCount: 1,
      }],
    });
    act(() => { renderer = create(<HerdScreen {...screenProps} />); });

    for (const refreshing of [true, false]) {
      act(() => {
        renderer.update(<HerdScreen
          {...screenProps}
          queues={screenProps.queues.map(host => ({ ...host, refreshing }))}
        />);
      });
      expect(renderer.root.findAll(node => String(node.type) === 'LiveSessionRail')).toHaveLength(0);
      expect(findHost(renderer.root, 'WorkspaceRail').props.busy).toBe(false);
      await act(async () => {
        findHost(renderer.root, 'WorkspaceRail').props.onSelect('space-b');
      });
    }
    expect(screenProps.onFocusWorkspace).toHaveBeenCalledTimes(2);
    expect(screenProps.onFocusWorkspace).toHaveBeenCalledWith('host-1', 'space-b');
  });

  test.each(['connecting', 'connected', 'reconnecting', 'disconnected', 'error'] as const)(
    'a single host still shows its rail when %s',
    status => {
      act(() => {
        renderer = create(<HerdScreen {...props({
          sessions: [{ hostId: 'host-1', label: 'Host 1', status, agentStatus: 'idle', terminalCount: 1 }],
        })} />);
      });
      expect(findHost(renderer.root, 'LiveSessionRail').props.sessions[0].status).toBe(status);
    },
  );

  function agentTray(
    overrides: Record<string, unknown> = {},
  ): ComponentProps<typeof HerdScreen> {
    const agent: AgentInfo = {
      pane_id: 'pane-1',
      terminal_id: 'terminal-1',
      workspace_id: 'space-a',
      tab_id: 'tab-1',
      focused: false,
      agent: 'codex',
      agent_status: 'idle',
      revision: 1,
    };
    return props({
      agents: [
        {
          hostId: 'host-1',
          hostLabel: 'Host 1',
          agent,
          workspaceLabel: 'space-a',
          tabLabel: 'tab-1',
          primaryLabel: 'space-a',
          control: {
            terminalId: 'terminal-1',
            kind: HerdrAgentKind.Codex,
            sessionId: 'session-1',
            reverseControl: false,
            connected: false,
            reverseControlState: ReverseControlState.Off,
          },
        },
      ],
      onSetAgentReverseControl: jest.fn().mockResolvedValue(undefined),
      onRestartAgent: jest.fn().mockResolvedValue(undefined),
      onCopyAgent: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

  test('search filters tabs and paths and clearing restores the current view', () => {
    const screenProps = agentTray();
    const first = screenProps.agents[0];
    first.tabLabel = 'Terminal One';
    first.agent.cwd = '/srv/project';
    first.agent.foreground_cwd = '/tmp/build';
    screenProps.agents = [first, {
      ...first,
      tabLabel: 'Terminal Two',
      agent: { ...first.agent, pane_id: 'pane-2', terminal_id: 'terminal-2', tab_id: 'tab-2', cwd: '/home/user', foreground_cwd: undefined },
    }];
    act(() => { renderer = create(<HerdScreen {...screenProps} />); });
    const button = (label: string) => renderer.root.find(node =>
      String(node.type) === 'Button' && node.props.accessibilityLabel === label);
    act(() => { button('herd.searchAgents').props.onPress(); });
    const search = (query: string) => {
      act(() => { renderer.root.find(node =>
        String(node.type) === 'Input' && node.props.accessibilityLabel === 'herd.searchAgents',
      ).props.onChangeText(query); });
      return findHost(renderer.root, 'FlatList').props.data;
    };
    expect(search('PROJECT')).toEqual([first]);
    expect(search('build')).toEqual([first]);
    expect(search('terminal')).toEqual(screenProps.agents);
    expect(search('no match')).toEqual([]);
    const empty = findHost(renderer.root, 'FlatList').props.ListEmptyComponent;
    expect(empty.props.children[1].props.children).toBe('herd.noMatchingAgents');
    act(() => { button('herd.closeSearch').props.onPress(); });
    expect(findHost(renderer.root, 'FlatList').props.data).toEqual(screenProps.agents);
  });

  test.each([
    { sessionAgent: 'claude', agentType: 'codex', expected: ['claude'] },
    { sessionAgent: undefined, agentType: 'codex', expected: ['codex'] },
    { sessionAgent: undefined, agentType: undefined, expected: [] },
  ])('cards show only agent types when session type is $sessionAgent and detected type is $agentType', ({ sessionAgent, agentType, expected }) => {
    const screenProps = agentTray();
    const { agent } = screenProps.agents[0];
    agent.name = 'in';
    agent.display_agent = 'in';
    agent.agent = agentType;
    agent.agent_session = sessionAgent
      ? { agent: sessionAgent, source: 'herdr', kind: 'id', value: 'session-1' }
      : undefined;

    act(() => { renderer = create(<HerdScreen {...screenProps} />); });

    const texts = renderer.root.findAll(node => String(node.type) === 'Text');
    const agentLabels = texts.filter(node =>
      node.props.className?.includes('text-muted-foreground/70'));
    expect(agentLabels.map(node => node.props.children)).toEqual(expected);
    expect(texts.map(node => node.props.children)).not.toContain('in');
  });

  test('cards keep tab names and show only their loaded conversation title at the bottom', () => {
    const screenProps = agentTray({ selectedHostId: null, workspaceFilterId: null });
    const first = screenProps.agents[0];
    first.tabLabel = 'My manual tab';
    first.workspaceLabel = 'Project space';
    first.primaryLabel = 'Project space · My manual tab';
    first.agent.agent_session = { agent: 'codex', source: 'herdr', kind: 'id', value: 'session-1' };
    screenProps.agents = [first, {
      ...first, tabLabel: 'Other tab', primaryLabel: 'Other tab',
      agent: { ...first.agent, pane_id: 'pane-2', terminal_id: 'terminal-2', tab_id: 'tab-2',
        agent_session: { agent: 'claude', source: 'herdr', kind: 'id', value: 'session-2' } },
    }];
    const activate = jest.spyOn(agentTranscriptService, 'activate');
    const titleState = (sessionId: string, title?: string): AgentChatState => ({
      sessionId, status: 'live', revision: 1,
      transcript: { sessionId, info: { id: sessionId, title }, messages: [], turns: [] },
    });
    const publish = (index: number, title: string) => {
      const { agent } = screenProps.agents[index];
      agentTranscriptService.titles.observe('host-1', agent, {
        paneId: agent.pane_id, terminalId: agent.terminal_id,
        agent: index === 0 ? 'codex' : 'claude', sessionId: agent.agent_session!.value,
      }, titleState(agent.agent_session!.value, title));
    };
    const texts = () => renderer.root.findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    act(() => { renderer = create(<HerdScreen {...screenProps} />); });
    expect(texts()).toContain('My manual tab');
    expect(texts()).toContain('codex · Host 1 · Project space');
    expect(texts()).not.toContain('Loaded conversation');
    act(() => { publish(0, 'Loaded conversation'); });
    expect(texts()).toContain('My manual tab');
    const subtitle = renderer.root.find(node =>
      String(node.type) === 'Text' && node.props.children === 'Loaded conversation');
    expect(subtitle.props.className).toContain('text-[11px]');
    expect(subtitle.props.numberOfLines).toBe(1);
    expect(subtitle.parent!.children.at(-1)).toBe(subtitle);
    act(() => { publish(1, 'Claude conversation'); publish(0, 'Updated conversation'); });
    expect(texts()).toEqual(expect.arrayContaining(['Updated conversation', 'Claude conversation']));
    expect(texts()).not.toContain('Loaded conversation');

    const switched = { ...screenProps, agents: screenProps.agents.map((item, index) => index ? item : {
      ...item, agent: { ...item.agent,
        agent_session: { ...item.agent.agent_session!, value: 'resumed-session' } },
    }) };
    act(() => { renderer.update(<HerdScreen {...switched} />); });
    expect(texts()).not.toContain('Updated conversation');
    expect(texts()).toContain('Claude conversation');
    expect(activate).not.toHaveBeenCalled();
    activate.mockRestore();
  });

  function openAgentMenu() {
    const row = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityActions?.some(
          (action: { name: string }) => action.name === 'agent-actions',
        ),
    );
    act(() => {
      row.props.onLongPress();
    });
  }

  test.each([0, 24, 34])(
    'the queue can scroll its last card above navigation with a %i-pixel safe area',
    bottom => {
      const insets = { top: 0, right: 0, bottom, left: 0 };
      jest.mocked(useSafeAreaInsets)
        .mockReturnValueOnce(insets)
        .mockReturnValueOnce(insets);
      const screenProps = agentTray();
      act(() => {
        renderer = create(
          <>
            <HerdScreen {...screenProps} />
            <BottomNavigation activeTab="herd" blurTarget={{ current: null }} onSelect={jest.fn()} />
          </>,
        );
      });

      const list = findHost(renderer.root, 'FlatList');
      // The navigation container reaches 16 + 120 + bottom pixels above the
      // viewport edge. Preserve the queue's existing 32-pixel breathing room.
      expect(list.props.contentContainerStyle?.paddingBottom).toBe(
        16 + 120 + bottom + 32,
      );
      const navigation = renderer.root.find(
        node => String(node.type) === 'View' && node.props.className?.includes('z-30'),
      );
      const navigationStyle = navigation.props.style as { bottom: number; height: number };
      expect(list.props.contentContainerStyle.paddingBottom).toBe(
        navigationStyle.bottom + navigationStyle.height + 32,
      );
      const lastCard = renderer.root.findAll(
        node => String(node.type) === 'Button' && node.props.onLongPress,
      ).at(-1)!;
      act(() => { lastCard.props.onPress(); });
      expect(screenProps.onOpenTerminal).toHaveBeenCalledWith(
        'host-1',
        screenProps.agents[0].agent,
      );
    },
  );

  test('agent cards show reverse-control recovery and a focus icon', () => {
    const tray = agentTray();
    tray.agents[0].agent.focused = true;
    tray.agents[0].control = {
      terminalId: 'terminal-1',
      kind: HerdrAgentKind.Codex,
      reverseControl: true,
      connected: false,
      reverseControlState: ReverseControlState.Recovering,
    };
    act(() => {
      renderer = create(<HerdScreen {...tray} />);
    });
    const texts = renderer.root.findAll(node => String(node.type) === 'Text');
    expect(
      texts.some(node =>
        String(node.props.children).includes('herd.reverseControlRecovering'),
      ),
    ).toBe(true);
    expect(
      texts.some(node => String(node.props.children).includes('herd.focused')),
    ).toBe(false);
    expect(
      renderer.root.findAll(
        node => String(node.type) === 'Icon' && node.props.as === 'Focus',
      ),
    ).toHaveLength(1);
    openAgentMenu();
    expect(
      renderer.root.findByType(AgentActionsPopup).props.preference
        .reverseControlState,
    ).toBe(ReverseControlState.Recovering);
    act(() => {
      renderer.update(
        <HerdScreen
          {...tray}
          agents={tray.agents.map(item => ({
            ...item,
            control: {
              ...item.control!,
              connected: true,
              reverseControlState: ReverseControlState.Connected,
            },
          }))}
        />,
      );
    });
    expect(
      renderer.root
        .findAll(node => String(node.type) === 'Text')
        .some(node =>
          String(node.props.children).includes('herd.reverseControlRecovering'),
        ),
    ).toBe(false);
  });

  function findAgentTray() {
    return renderer.root.find(
      node => typeof node.props.accessibilityElementsHidden === 'boolean',
    );
  }

  test('a short swipe restores the row and a deliberate swipe closes after its animation', async () => {
    const onCloseTab = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...agentTray({ onCloseTab })} />);
    });
    const row = renderer.root.find(
      node =>
        String(node.type) === 'AnimatedView' && node.props.onPanResponderGrant,
    );
    expect(findAgentTray().props.style.width).toBe(0);
    expect(findAgentTray().props.style.opacity).toBe(0);
    expect(
      row.props.onMoveShouldSetPanResponderCapture(null, { dx: -10, dy: 2 }),
    ).toBe(true);
    expect(
      row.props.onMoveShouldSetPanResponderCapture(null, { dx: 40, dy: 2 }),
    ).toBe(false);
    const container = row.parent!;
    act(() => {
      container.props.onLayout({
        nativeEvent: { layout: { width: 350, height: 100 } },
      });
    });
    act(() => {
      row.props.onPanResponderGrant();
      row.props.onPanResponderMove(null, { dx: -40 });
    });
    expect(findAgentTray().props.style.width).toBe(40);
    expect(findAgentTray().props.style.opacity).toBe(1);
    act(() => {
      row.props.onPanResponderRelease(null, { dx: -40, vx: 0 });
    });
    expect(findAgentTray().props.style.width).toBe(0);
    expect(onCloseTab).not.toHaveBeenCalled();
    act(() => {
      row.props.onPanResponderGrant();
      row.props.onPanResponderMove(null, { dx: -200 });
    });
    expect(findAgentTray().props.style.width).toBe(144);
    act(() => {
      row.props.onPanResponderRelease(null, { dx: -100, vx: 0 });
    });
    expect(onCloseTab).not.toHaveBeenCalled();
    const completed = jest
      .requireMock('react-native-reanimated')
      .withTiming.mock.calls.at(-1)[2];
    await act(async () => {
      completed(true);
    });
    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith('host-1', 'tab-1');
  });

  test('an interrupted close animation restores the row without closing the tab', async () => {
    const onCloseTab = jest.fn();
    act(() => {
      renderer = create(<HerdScreen {...agentTray({ onCloseTab })} />);
    });
    const row = renderer.root.find(
      node =>
        String(node.type) === 'AnimatedView' && node.props.onPanResponderGrant,
    );
    act(() => {
      row.parent!.props.onLayout({
        nativeEvent: { layout: { width: 350, height: 100 } },
      });
      row.props.onPanResponderGrant();
      row.props.onPanResponderRelease(null, { dx: -100, vx: 0 });
    });
    const completed = jest
      .requireMock('react-native-reanimated')
      .withTiming.mock.calls.at(-1)[2];
    await act(async () => {
      completed(false);
    });
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(findAgentTray().props.style.width).toBe(0);
    expect(row.parent!.parent!.props.style.height).toBeUndefined();
    expect(
      row.props.onMoveShouldSetPanResponderCapture(null, { dx: -30, dy: 1 }),
    ).toBe(true);
  });

  test('long press opens a glass actions menu instead of remote files', () => {
    const onOpenFiles = jest.fn();
    act(() => {
      renderer = create(<HerdScreen {...agentTray({ onOpenFiles })} />);
    });
    expect(renderer.root.findByType(AgentActionsPopup).props.visible).toBe(
      false,
    );
    openAgentMenu();
    const menu = renderer.root.findByType(AgentActionsPopup);
    expect(menu.props.visible).toBe(true);
    expect(
      menu.findAll(node => String(node.type) === 'GlassSurface'),
    ).toHaveLength(1);
    expect(onOpenFiles).not.toHaveBeenCalled();
  });

  test('copies the latest session ID without duplicating or restarting the agent', () => {
    const tray = agentTray();
    act(() => { renderer = create(<HerdScreen {...tray} />); });
    openAgentMenu();
    const menu = renderer.root.findByType(AgentActionsPopup);
    expect(menu.findByProps({ selectable: true }).props.children).toBe('session-1');

    act(() => {
      renderer.update(<HerdScreen {...tray} agents={tray.agents.map(item => ({
        ...item,
        control: { ...item.control!, sessionId: 'session-2' },
      }))} />);
    });
    expect(menu.findByProps({ selectable: true }).props.children).toBe('session-2');
    act(() => {
      menu.find(node => String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.copySession').props.onPress();
    });
    expect(Clipboard.setString).toHaveBeenLastCalledWith('session-2');
    expect(tray.onCopyAgent).not.toHaveBeenCalled();
    expect(tray.onRestartAgent).not.toHaveBeenCalled();
    expect(menu.props.visible).toBe(true);
  });

  test.each(['id', 'path'] as const)(
    'shows and copies an integration-reported session %s for other agents',
    kind => {
      const tray = agentTray();
      tray.agents[0].control = undefined;
      tray.agents[0].agent.agent = 'pi';
      const value = kind === 'id' ? 'pi-session-1' : '/home/me/.pi/sessions/session.jsonl';
      tray.agents[0].agent.agent_session = {
        source: 'herdr:pi', agent: 'pi', kind, value,
      };
      act(() => { renderer = create(<HerdScreen {...tray} />); });
      openAgentMenu();
      const menu = renderer.root.findByType(AgentActionsPopup);
      expect(menu.findByProps({ selectable: true }).props.children).toBe(value);
      expect(menu.findAll(node => String(node.type) === 'Text' &&
        node.props.children === (kind === 'id' ? 'herd.sessionId' : 'herd.sessionPath'))).toHaveLength(1);
      act(() => {
        menu.find(node => String(node.type) === 'Button' &&
          node.props.accessibilityLabel === 'herd.copySession').props.onPress();
      });
      expect(Clipboard.setString).toHaveBeenLastCalledWith(value);
      expect(menu.findAll(node => ['herd.restart', 'herd.copyAgent', 'herd.reverseControl']
        .includes(node.props.accessibilityLabel))).toHaveLength(0);
    },
  );

  test.each([undefined, '   '])(
    'hides restart when the session ID is %s and keeps actions that do not require one',
    sessionId => {
      const tray = agentTray();
      tray.agents[0].control!.sessionId = sessionId;
      act(() => { renderer = create(<HerdScreen {...tray} />); });
      openAgentMenu();
      const menu = renderer.root.findByType(AgentActionsPopup);
      expect(menu.findAll(node => String(node.type) === 'Button' &&
        ['herd.restart', 'herd.copySession'].includes(node.props.accessibilityLabel))).toHaveLength(0);
      expect(menu.find(node => String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.copyAgent').props.disabled).toBe(false);
      expect(menu.find(node => String(node.type) === 'Switch').props.disabled).toBe(false);
    },
  );

  test('hides unsupported controls for a plain terminal tab', () => {
    const tray = agentTray();
    tray.agents[0].agent.agent = undefined;
    tray.agents[0].control = undefined;
    act(() => { renderer = create(<HerdScreen {...tray} />); });
    openAgentMenu();
    const menu = renderer.root.findByType(AgentActionsPopup);
    expect(menu.findAll(node => ['herd.restart', 'herd.copyAgent', 'herd.reverseControl', 'herd.copySession']
      .includes(node.props.accessibilityLabel))).toHaveLength(0);
    expect(menu.findAll(node => String(node.type) === 'Text' &&
      node.props.children === 'herd.noAgentActions')).toHaveLength(1);
  });

  test('a busy agent requires confirmation before restarting', async () => {
    const onRestartAgent = jest.fn().mockResolvedValue(undefined);
    const tray = agentTray({ onRestartAgent });
    tray.agents[0].agent.agent_status = 'working';
    act(() => {
      renderer = create(<HerdScreen {...tray} />);
    });
    openAgentMenu();
    const restart = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.restart',
    );
    expect(restart.findAll(node => String(node.type) === 'Text')).toHaveLength(
      0,
    );
    act(() => {
      restart.props.onPress();
    });
    expect(onRestartAgent).not.toHaveBeenCalled();
    const confirmation = renderer.root.find(
      node =>
        String(node.type) === 'ConfirmationPopup' &&
        node.props.title === 'herd.restartAgent',
    );
    expect(confirmation.props.visible).toBe(true);
    await act(async () => {
      confirmation.props.onConfirm();
    });
    expect(onRestartAgent).toHaveBeenCalledWith('host-1', 'terminal-1');
  });

  test.each([
    ['codex', HerdrAgentKind.Codex],
    ['opencode', HerdrAgentKind.OpenCode],
    ['claude', HerdrAgentKind.Claude],
  ])(
    'dismissing the %s menu preserves the reverse-control change',
    async (kind, controlKind) => {
      const onSetAgentReverseControl = jest.fn().mockResolvedValue(undefined);
      const onCloseTab = jest.fn();
      const tray = agentTray({ onSetAgentReverseControl, onCloseTab });
      tray.agents[0].agent.agent = kind;
      tray.agents[0].control!.kind = controlKind;
      act(() => {
        renderer = create(<HerdScreen {...tray} />);
      });
      openAgentMenu();
      const menu = renderer.root.findByType(AgentActionsPopup);
      const toggle = menu.find(
        node =>
          String(node.type) === 'Switch' &&
          node.props.accessibilityLabel === 'herd.reverseControl',
      );
      expect(toggle.props.disabled).toBe(false);
      await act(async () => toggle.props.onCheckedChange(true));
      expect(onSetAgentReverseControl).toHaveBeenCalledWith(
        'host-1',
        'terminal-1',
        true,
      );
      act(() => {
        menu.props.onClose();
      });
      expect(renderer.root.findByType(AgentActionsPopup).props.visible).toBe(
        false,
      );
      expect(onCloseTab).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['', undefined],
    ['  My copy  ', 'My copy'],
  ])(
    'Copy prompts before creating with optional name %s',
    async (draft, label) => {
      const onCopyAgent = jest.fn().mockResolvedValue(undefined);
      const onRestartAgent = jest.fn();
      const onCloseTab = jest.fn();
      act(() => {
        renderer = create(
          <HerdScreen
            {...agentTray({ onCopyAgent, onRestartAgent, onCloseTab })}
          />,
        );
      });
      openAgentMenu();
      const copy = renderer.root
        .findByType(AgentActionsPopup)
        .find(
          node =>
            String(node.type) === 'Button' &&
            node.props.accessibilityLabel === 'herd.copyAgent',
        );
      expect(copy.findAll(node => String(node.type) === 'Text')).toHaveLength(
        0,
      );
      act(() => {
        copy.props.onPress();
      });
      expect(onCopyAgent).not.toHaveBeenCalled();
      const prompt = renderer.root.find(
        node =>
          String(node.type) === 'ResourceEditorSheet' &&
          node.props.title === 'herd.copyAgent',
      );
      expect(prompt.props.visible).toBe(true);
      const input = prompt.find(
        node =>
          String(node.type) === 'Input' &&
          node.props.accessibilityLabel === 'herd.tabName',
      );
      act(() => {
        input.props.onChangeText(draft);
      });
      await act(async () => prompt.props.onSave());
      expect(onCopyAgent).toHaveBeenCalledWith('host-1', 'terminal-1', label);
      expect(prompt.props.visible).toBe(false);
      expect(onRestartAgent).not.toHaveBeenCalled();
      expect(onCloseTab).not.toHaveBeenCalled();
    },
  );

  test('cancelling the Copy name prompt creates nothing', () => {
    const onCopyAgent = jest.fn();
    act(() => {
      renderer = create(<HerdScreen {...agentTray({ onCopyAgent })} />);
    });
    openAgentMenu();
    const copy = renderer.root
      .findByType(AgentActionsPopup)
      .find(
        node =>
          String(node.type) === 'Button' &&
          node.props.accessibilityLabel === 'herd.copyAgent',
      );
    act(() => {
      copy.props.onPress();
    });
    const prompt = renderer.root.find(
      node =>
        String(node.type) === 'ResourceEditorSheet' &&
        node.props.title === 'herd.copyAgent',
    );
    act(() => {
      prompt.props.onClose();
    });
    expect(prompt.props.visible).toBe(false);
    expect(onCopyAgent).not.toHaveBeenCalled();
  });

  test.each<AgentStatus>(['working', 'done', 'idle'])(
    'replaces a blocked agent row with the latest %s status',
    finalStatus => {
      const render = (status: AgentStatus) => {
        const agent: AgentInfo = {
          pane_id: 'pane-1',
          terminal_id: 'terminal-1',
          workspace_id: 'space-a',
          tab_id: 'tab-1',
          focused: false,
          agent: 'codex',
          agent_status: status,
          // Herdr status events do not need a new pane/output revision.
          revision: 1,
        };
        return (
          <HerdScreen
            {...props({
              queues: [{ ...queue([workspace('space-a')]), agents: [agent] }],
              agents: [
                {
                  hostId: 'host-1',
                  hostLabel: 'Host 1',
                  agent,
                  workspaceLabel: 'space-a',
                  tabLabel: 'tab-1',
                  primaryLabel: 'space-a',
                },
              ],
            })}
          />
        );
      };
      act(() => {
        renderer = create(render('working'));
      });
      for (const status of ['blocked', finalStatus] as AgentStatus[]) {
        act(() => renderer.update(render(status)));
        expect(
          findHost(renderer.root, 'AgentStatusMedallion').props.status,
        ).toBe(status);
        expect(findHost(renderer.root, 'StatusBadge').props.status).toBe(
          status,
        );
      }
    },
  );

  test('a WorkspaceRail tap selects locally, focuses once, and does not open a terminal', async () => {
    const calls: string[] = [];
    let finishFocus: (() => void) | undefined;
    const onWorkspaceFilterChange = jest.fn(() => calls.push('filter'));
    const onSelectWorkspace = jest.fn(() => calls.push('select'));
    const onFocusWorkspace = jest.fn(() => {
      calls.push('focus');
      return new Promise<void>(resolve => {
        finishFocus = resolve;
      });
    });
    const onOpenTerminal = jest.fn();
    const onOpenSpace = jest.fn();
    act(() => {
      renderer = create(
        <HerdScreen
          {...props({
            onWorkspaceFilterChange,
            onSelectWorkspace,
            onFocusWorkspace,
            onOpenTerminal,
            onOpenSpace,
          })}
        />,
      );
    });

    await act(() =>
      findHost(renderer.root, 'WorkspaceRail').props.onSelect('space-b'),
    );

    expect(calls).toEqual(['filter', 'select', 'focus']);
    expect(onWorkspaceFilterChange).toHaveBeenCalledWith('host-1', 'space-b');
    expect(onSelectWorkspace).toHaveBeenCalledWith('host-1', 'space-b');
    expect(onFocusWorkspace).toHaveBeenCalledTimes(1);
    expect(onFocusWorkspace).toHaveBeenCalledWith('host-1', 'space-b');
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(onOpenSpace).not.toHaveBeenCalled();

    await act(async () => {
      finishFocus?.();
      await Promise.resolve();
    });
  });

  test('All Spaces only clears the local workspace filter', () => {
    const onWorkspaceFilterChange = jest.fn();
    const onSelectWorkspace = jest.fn();
    const onFocusWorkspace = jest.fn().mockResolvedValue(undefined);
    const onOpenTerminal = jest.fn();
    const onOpenSpace = jest.fn();
    act(() => {
      renderer = create(
        <HerdScreen
          {...props({
            onWorkspaceFilterChange,
            onSelectWorkspace,
            onFocusWorkspace,
            onOpenTerminal,
            onOpenSpace,
          })}
        />,
      );
    });

    act(() => {
      findHost(renderer.root, 'WorkspaceRail').props.onSelect(null);
    });

    expect(onWorkspaceFilterChange).toHaveBeenCalledTimes(1);
    expect(onWorkspaceFilterChange).toHaveBeenCalledWith('host-1', null);
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(onFocusWorkspace).not.toHaveBeenCalled();
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(onOpenSpace).not.toHaveBeenCalled();
  });

  test('accepts the Rust-projected single-workspace selection without echoing it', () => {
    const onSelectWorkspace = jest.fn();
    const onFocusWorkspace = jest.fn().mockResolvedValue(undefined);
    const onWorkspaceFilterChange = jest.fn();
    act(() => {
      renderer = create(
        <HerdScreen
          {...props({
            queues: [queue([workspace('only-space', true)])],
            workspaceFilterId: 'only-space',
            onSelectWorkspace,
            onFocusWorkspace,
            onWorkspaceFilterChange,
          })}
        />,
      );
    });

    expect(onWorkspaceFilterChange).not.toHaveBeenCalled();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(onFocusWorkspace).not.toHaveBeenCalled();
  });

  test('a server-originated focus projection does not echo a focus command', () => {
    const onFocusWorkspace = jest.fn().mockResolvedValue(undefined);
    const initial = props({ onFocusWorkspace });
    act(() => {
      renderer = create(<HerdScreen {...initial} />);
    });
    act(() => {
      renderer.update(
        <HerdScreen
          {...initial}
          queues={[queue([workspace('space-a'), workspace('space-b', true)])]}
          workspaceFilterId="space-b"
        />,
      );
    });

    expect(onFocusWorkspace).not.toHaveBeenCalled();
  });

  test('focus failure uses the existing Herdr command error presentation', async () => {
    const onFocusWorkspace = jest
      .fn()
      .mockRejectedValue(new Error('focus denied'));
    act(() => {
      renderer = create(<HerdScreen {...props({ onFocusWorkspace })} />);
    });

    await act(async () => {
      findHost(renderer.root, 'WorkspaceRail').props.onSelect('space-b');
      await Promise.resolve();
    });

    expect(findHost(renderer.root, 'AppAlertPopup').props).toEqual(
      expect.objectContaining({
        message: 'Error: focus denied',
        title: 'herd.commandFailed',
        visible: true,
      }),
    );
  });

  test('Run keeps the single command field and submits its configured command', async () => {
    const onLaunchTab = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...props({ onLaunchTab })} />);
    });

    const runButton = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.runCommand' &&
        node.props.className.includes('px-4'),
    );
    await act(() => runButton.props.onPress());

    const commandInput = renderer.root.find(
      node =>
        String(node.type) === 'Input' &&
        node.props.placeholder === 'herd.commandPlaceholder',
    );
    expect(commandInput.props.value).toBe('codex');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Reverse Control' }).props
        .checked,
    ).toBe(false);
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Button' &&
          ['claude', 'codex', 'opencode'].includes(
            node.props.accessibilityLabel,
          ),
      ),
    ).toHaveLength(0);

    const submitButton = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.runCommand' &&
        node.props.className.includes('size-12'),
    );
    await act(async () => submitButton.props.onPress());

    expect(onLaunchTab).toHaveBeenCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'codex',
    });
  });

  test('Reverse Control is opt-in for Claude Code, Codex and OpenCode and clears for unsupported commands', async () => {
    const onLaunchTab = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...props({ onLaunchTab })} />);
    });
    const open = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.runCommand' &&
        node.props.className.includes('px-4'),
    );
    await act(() => open.props.onPress());
    const toggle = renderer.root.findByProps({
      accessibilityLabel: 'Reverse Control',
    });
    await act(() => toggle.props.onCheckedChange(true));
    const submit = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.runCommand' &&
        node.props.className.includes('size-12'),
    );
    await act(async () => submit.props.onPress());
    expect(onLaunchTab).toHaveBeenLastCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'codex',
      reverseControl: true,
    });
    await act(() => open.props.onPress());
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Reverse Control' }).props
        .checked,
    ).toBe(false);
    const input = renderer.root.find(
      node =>
        String(node.type) === 'Input' &&
        node.props.placeholder === 'herd.commandPlaceholder',
    );
    await act(() => input.props.onChangeText('opencode --session ses_test'));
    const openCodeToggle = renderer.root.findByProps({
      accessibilityLabel: 'Reverse Control',
    });
    expect(openCodeToggle.props.checked).toBe(false);
    await act(() => openCodeToggle.props.onCheckedChange(true));
    await act(async () => submit.props.onPress());
    expect(onLaunchTab).toHaveBeenLastCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'opencode --session ses_test',
      reverseControl: true,
    });
    await act(() => open.props.onPress());
    await act(() => input.props.onChangeText('claude'));
    const claudeToggle = renderer.root.findByProps({
      accessibilityLabel: 'Reverse Control',
    });
    expect(claudeToggle.props.checked).toBe(false);
    await act(() => claudeToggle.props.onCheckedChange(true));
    await act(async () => submit.props.onPress());
    expect(onLaunchTab).toHaveBeenLastCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'claude',
      reverseControl: true,
    });
    await act(() => open.props.onPress());
    await act(() => input.props.onChangeText('claude'));
    await act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: 'Reverse Control',
        })
        .props.onCheckedChange(true),
    );
    await act(() => input.props.onChangeText('echo hello'));
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Reverse Control' }),
    ).toHaveLength(0);
    await act(async () => submit.props.onPress());
    expect(onLaunchTab).toHaveBeenLastCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'echo hello',
    });
  });

  test('Open forwards the selected workspace intent', async () => {
    const onOpenSpace = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...props({ onOpenSpace })} />);
    });

    const openButton = renderer.root.find(
      node =>
        String(node.type) === 'Button' &&
        node.props.accessibilityLabel === 'herd.openSpace',
    );
    await act(async () => openButton.props.onPress());

    expect(onOpenSpace).toHaveBeenCalledWith('host-1', 'space-a');
  });
});
