import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { HerdScreen } from '../src/components/HerdScreen';
import type { HerdHostQueue } from '../src/herdQueue';
import type { AgentInfo, AgentStatus, WorkspaceInfo } from '../src/types';

jest.mock('lucide-react-native', () => new Proxy({}, { get: (_, name) => String(name) }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  FlatList: (listProps: { data: unknown[]; renderItem: (item: { item: unknown }) => unknown }) => {
    const React = jest.requireActual('react');
    return React.createElement('FlatList', listProps, listProps.data.map((item, index) =>
      React.createElement(React.Fragment, { key: index }, listProps.renderItem({ item })),
    ));
  },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  PanResponder: { create: () => ({ panHandlers: {} }) },
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
  Easing: { out: (value: unknown) => value, cubic: 'cubic' },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withDelay: (_delay: number, value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/src/herdQueue', () => jest.requireActual('../src/herdQueue'), { virtual: true });
jest.mock(
  '@/src/lib/herdTabSwipeActions',
  () => jest.requireActual('../src/lib/herdTabSwipeActions'),
  { virtual: true },
);
jest.mock('@/src/lib/motion', () => ({ DEFAULT_SPRING_CONFIG: {} }), { virtual: true });
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
    runWithInFlightGuard: async (_guard: unknown, action: () => Promise<unknown>) => action(),
  }),
  { virtual: true },
);
jest.mock('@/src/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }), {
  virtual: true,
});
jest.mock('@/src/hooks/useKeyboardInset', () => ({
  useKeyboardInset: () => ({ inset: 0, resetInset: jest.fn() }),
}), { virtual: true });
jest.mock('@/src/lib/terminalFonts', () => ({ terminalFontFamily: 'monospace' }), {
  virtual: true,
});
jest.mock('@/src/theme', () => ({
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
}), { virtual: true });
jest.mock('../src/components/app-ui', () => ({
  AgentStatusMedallion: 'AgentStatusMedallion',
  StatusBadge: 'StatusBadge',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/AppAlertPopup', () => ({ AppAlertPopup: 'AppAlertPopup' }));
jest.mock('../src/components/ConfirmationPopup', () => ({
  ConfirmationPopup: 'ConfirmationPopup',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassBackdrop: 'GlassBackdrop',
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/LiveSessionRail', () => ({ LiveSessionRail: 'LiveSessionRail' }));
jest.mock('../src/components/ResourceEditorSheet', () => ({
  ResourceEditorField: 'ResourceEditorField',
  ResourceEditorSheet: 'ResourceEditorSheet',
}));
jest.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: 'WorkspaceRail' }));
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

  test.each<AgentStatus>(['working', 'done', 'idle'])(
    'replaces a blocked agent row with the latest %s status',
    finalStatus => {
      const render = (status: AgentStatus) => {
        const agent: AgentInfo = {
          pane_id: 'pane-1', terminal_id: 'terminal-1', workspace_id: 'space-a',
          tab_id: 'tab-1', focused: false, agent: 'codex', agent_status: status,
          // Herdr status events do not need a new pane/output revision.
          revision: 1,
        };
        return <HerdScreen {...props({
          queues: [{ ...queue([workspace('space-a')]), agents: [agent] }],
          agents: [{ hostId: 'host-1', hostLabel: 'Host 1', agent,
            workspaceLabel: 'space-a', tabLabel: 'tab-1', primaryLabel: 'space-a' }],
        })} />;
      };
      act(() => { renderer = create(render('working')); });
      for (const status of ['blocked', finalStatus] as AgentStatus[]) {
        act(() => renderer.update(render(status)));
        expect(findHost(renderer.root, 'AgentStatusMedallion').props.status).toBe(status);
        expect(findHost(renderer.root, 'StatusBadge').props.status).toBe(status);
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
      return new Promise<void>(resolve => { finishFocus = resolve; });
    });
    const onOpenTerminal = jest.fn();
    const onOpenSpace = jest.fn();
    act(() => {
      renderer = create(<HerdScreen {...props({
        onWorkspaceFilterChange,
        onSelectWorkspace,
        onFocusWorkspace,
        onOpenTerminal,
        onOpenSpace,
      })} />);
    });

    await act(() => findHost(renderer.root, 'WorkspaceRail').props.onSelect('space-b'));

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
      renderer = create(<HerdScreen {...props({
        onWorkspaceFilterChange,
        onSelectWorkspace,
        onFocusWorkspace,
        onOpenTerminal,
        onOpenSpace,
      })} />);
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
      renderer = create(<HerdScreen {...props({
        queues: [queue([workspace('only-space', true)])],
        workspaceFilterId: 'only-space',
        onSelectWorkspace,
        onFocusWorkspace,
        onWorkspaceFilterChange,
      })} />);
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
      renderer.update(<HerdScreen
        {...initial}
        queues={[queue([workspace('space-a'), workspace('space-b', true)])]}
        workspaceFilterId="space-b"
      />);
    });

    expect(onFocusWorkspace).not.toHaveBeenCalled();
  });

  test('focus failure uses the existing Herdr command error presentation', async () => {
    const onFocusWorkspace = jest.fn().mockRejectedValue(new Error('focus denied'));
    act(() => {
      renderer = create(<HerdScreen {...props({ onFocusWorkspace })} />);
    });

    await act(async () => {
      findHost(renderer.root, 'WorkspaceRail').props.onSelect('space-b');
      await Promise.resolve();
    });

    expect(findHost(renderer.root, 'AppAlertPopup').props).toEqual(expect.objectContaining({
      message: 'Error: focus denied',
      title: 'herd.commandFailed',
      visible: true,
    }));
  });

  test('Run keeps the single command field and submits its configured command', async () => {
    const onLaunchTab = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...props({ onLaunchTab })} />);
    });

    const runButton = renderer.root.find(node =>
      String(node.type) === 'Button'
      && node.props.accessibilityLabel === 'herd.runCommand'
      && node.props.className.includes('px-4'),
    );
    await act(() => runButton.props.onPress());

    const commandInput = renderer.root.find(node =>
      String(node.type) === 'Input'
      && node.props.placeholder === 'herd.commandPlaceholder',
    );
    expect(commandInput.props.value).toBe('codex');
    expect(renderer.root.findAll(node =>
      String(node.type) === 'Button'
      && ['claude', 'codex', 'opencode'].includes(node.props.accessibilityLabel),
    )).toHaveLength(0);

    const submitButton = renderer.root.find(node =>
      String(node.type) === 'Button'
      && node.props.accessibilityLabel === 'herd.runCommand'
      && node.props.className.includes('size-12'),
    );
    await act(async () => submitButton.props.onPress());

    expect(onLaunchTab).toHaveBeenCalledWith(
      'host-1',
      'space-a',
      '',
      { type: 'command', command: 'codex' },
    );
  });

  test('Open forwards the selected workspace intent', async () => {
    const onOpenSpace = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(<HerdScreen {...props({ onOpenSpace })} />);
    });

    const openButton = renderer.root.find(node =>
      String(node.type) === 'Button'
      && node.props.accessibilityLabel === 'herd.openSpace',
    );
    await act(async () => openButton.props.onPress());

    expect(onOpenSpace).toHaveBeenCalledWith('host-1', 'space-a');
  });
});
