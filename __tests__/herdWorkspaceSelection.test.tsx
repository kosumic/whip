import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { ComponentProps } from 'react';

import { HerdScreen } from '../src/components/HerdScreen';
import type { HerdHostQueue } from '../src/herdQueue';
import { AgentActionsPopup } from '../src/components/AgentActionsPopup';
import type { AgentInfo, AgentStatus, WorkspaceInfo } from '../src/types';

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
  useSafeAreaInsets: () => ({ bottom: 0 }),
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
  });

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
        },
      ],
      agentPreferences: new Map([
        [
          'host-1',
          [
            {
              terminalId: 'terminal-1',
              kind: 'codex',
              reverseControl: false,
              connected: false,
            },
          ],
        ],
      ]),
      onSetAgentReverseControl: jest.fn().mockResolvedValue(undefined),
      onRestartAgent: jest.fn().mockResolvedValue(undefined),
      onCopyAgent: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

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

  test('agent cards show reverse-control recovery and a focus icon', () => {
    const tray = agentTray();
    tray.agents[0].agent.focused = true;
    tray.agentPreferences = new Map([
      [
        'host-1',
        [
          {
            terminalId: 'terminal-1',
            kind: 'codex',
            reverseControl: true,
            connected: false,
            reverseControlState: 'recovering',
          },
        ],
      ],
    ]);
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
    ).toBe('recovering');
    act(() => {
      renderer.update(
        <HerdScreen
          {...tray}
          agentPreferences={
            new Map([
              [
                'host-1',
                [
                  {
                    terminalId: 'terminal-1',
                    kind: 'codex',
                    reverseControl: true,
                    connected: true,
                    reverseControlState: 'connected',
                  },
                ],
              ],
            ])
          }
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
    expect(row.parent!.parent!.props.style.height).toBe(100);
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

  test('dismissing the menu preserves the reverse-control change', async () => {
    const onSetAgentReverseControl = jest.fn().mockResolvedValue(undefined);
    const onCloseTab = jest.fn();
    act(() => {
      renderer = create(
        <HerdScreen {...agentTray({ onSetAgentReverseControl, onCloseTab })} />,
      );
    });
    openAgentMenu();
    const menu = renderer.root.findByType(AgentActionsPopup);
    const toggle = menu.find(
      node =>
        String(node.type) === 'Switch' &&
        node.props.accessibilityLabel === 'herd.reverseControl',
    );
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
  });

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

  test('Reverse Control is opt-in for Codex and OpenCode and clears for unsupported commands', async () => {
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
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Reverse Control' }),
    ).toHaveLength(0);
    await act(async () => submit.props.onPress());
    expect(onLaunchTab).toHaveBeenLastCalledWith('host-1', 'space-a', '', {
      type: 'command',
      command: 'claude',
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
