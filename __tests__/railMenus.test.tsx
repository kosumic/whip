import { StrictMode, type ReactElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Modal, Platform, Pressable } from 'react-native';

import { LiveSessionRail, type LiveSessionRailItem } from '../src/components/LiveSessionRail';
import { RailAction, RailItemButton } from '../src/components/RailItemButton';
import { TerminalTabRail, type TerminalTab } from '../src/components/TerminalTabRail';
import { WorkspaceRail } from '../src/components/WorkspaceRail';
import { Button } from '../src/components/ui/button';
import { en } from '../src/locales/en';
import type { TabInfo, WorkspaceInfo } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Modal: ({ visible, children, ...props }: { visible: boolean; children: ReactNode }) => visible
    ? jest.requireActual<typeof import('react')>('react').createElement('Modal', { visible, ...props }, children) : null,
  Platform: { OS: 'android', isPad: false },
  Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: keyof typeof en, values: Record<string, string> = {}) =>
    jest.requireActual<typeof import('../src/locales/en')>('../src/locales/en').en[key]
      .replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => values[name] ?? name),
}) }));
jest.mock('lucide-react-native/icons/layers', () => ('Layers3'));
jest.mock('lucide-react-native/icons/pencil', () => ('Pencil'));
jest.mock('lucide-react-native/icons/plus', () => ('Plus'));
jest.mock('lucide-react-native/icons/server', () => ('Server'));
jest.mock('lucide-react-native/icons/server-off', () => ('ServerOff'));
jest.mock('lucide-react-native/icons/square-terminal', () => ('SquareTerminal'));
jest.mock('lucide-react-native/icons/unplug', () => ('Unplug'));
jest.mock('lucide-react-native/icons/x', () => ('X'));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: '#fff', error: '#f00' } }),
  appGlassControlStyle: jest.fn(), statusColor: jest.fn(), sessionTabGlassStyle: jest.fn(), sessionTabStatusColor: jest.fn(),
}));
jest.mock('../src/components/app-ui', () => ({
  AnimatedAgentStatusGlyph: 'AnimatedAgentStatusGlyph', AnimatedStatusIndicator: 'AnimatedStatusIndicator',
  hapticPress: (handler: () => unknown) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', useAppGlassEnabled: () => false }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

let tree: ReactTestRenderer;
const host: LiveSessionRailItem = { hostId: 'host-1', label: 'Dev', status: 'ready', agentStatus: 'idle', terminalCount: 2 };
const workspace: WorkspaceInfo = {
  workspace_id: 'space-1', label: 'Project', number: 1, focused: false,
  pane_count: 1, tab_count: 1, active_tab_id: 'tab-1', agent_status: 'idle',
};
const herdrTab: TabInfo = {
  tab_id: 'tab-1', workspace_id: workspace.workspace_id, label: 'Agent', number: 1,
  focused: false, pane_count: 2, agent_status: 'idle',
};
const tabs: TerminalTab[] = [
  { id: herdrTab.tab_id, label: herdrTab.label, agentStatus: 'idle', paneCount: 2, herdrTab },
  { id: 'ssh-1', label: 'Shell', agentStatus: 'idle', paneCount: 1 },
];

const button = (label: string) => tree.root.findAllByType(Button).find(item => item.props.accessibilityLabel === label)!;
const hasButton = (label: string) => Boolean(button(label));
const modal = () => tree.root.findAllByType(Modal).find(item => item.props.visible)!;
function mount(element: ReactElement) { act(() => { tree = create(element); }); }
function longPress(label: string) {
  act(() => {
    button(label).props.onPressIn();
    button(label).props.onLongPress();
  });
}
function accessibilityAction(label: string, actionName: string) {
  act(() => { button(label).props.onAccessibilityAction({ nativeEvent: { actionName } }); });
}
async function selectAction(label: string) {
  const dismiss = modal().props.onDismiss;
  await act(async () => { button(label).props.onPress(); });
  if (Platform.OS === 'ios') await act(async () => { dismiss(); });
}

beforeEach(() => { Object.assign(Platform, { OS: 'android', isPad: false }); });
afterEach(() => { act(() => tree?.unmount()); jest.restoreAllMocks(); });

test('host taps select, while long press opens Disconnect without selecting or disconnecting', async () => {
  const onSelect = jest.fn();
  const onClose = jest.fn();
  mount(<LiveSessionRail sessions={[host]} activeHostId={null} onSelect={onSelect} onClose={onClose} onNew={jest.fn()} />);
  const hostLabel = 'Open Dev, Idle';
  expect(hasButton('Disconnect Dev')).toBe(false);
  act(() => { button(hostLabel).props.onPress(); });
  expect(onSelect).toHaveBeenCalledWith(host.hostId);
  onSelect.mockClear();
  longPress(hostLabel);
  act(() => { button(hostLabel).props.onPress(); });
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(hasButton('Disconnect Dev')).toBe(true);
  expect(hasButton('Rename tab')).toBe(false);
  const disconnect = button('Disconnect Dev').props.onPress;
  await selectAction('Disconnect Dev');
  act(() => { disconnect(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith(host.hostId);
});

test('All Hosts selects the aggregate view and offers a new host session without destructive actions', async () => {
  const onSelect = jest.fn();
  const onNew = jest.fn();
  mount(<LiveSessionRail sessions={[host]} activeHostId={host.hostId} onSelect={onSelect} onClose={jest.fn()} onNew={onNew} />);
  const all = button('Show All hosts, Idle');
  expect(hasButton('New host session')).toBe(false);
  act(() => { all.props.onPress(); });
  expect(onSelect).toHaveBeenCalledWith(null);
  longPress('Show All hosts, Idle');
  expect(hasButton('Disconnect Dev')).toBe(false);
  await selectAction('New host session');
  expect(onNew).toHaveBeenCalledTimes(1);
});

test('a screen reader can disconnect a host without a long press', () => {
  const onClose = jest.fn();
  mount(<LiveSessionRail sessions={[host]} activeHostId={host.hostId} onSelect={jest.fn()} onClose={onClose} onNew={jest.fn()} />);
  accessibilityAction('Open Dev, Idle', RailAction.Disconnect);
  expect(onClose).toHaveBeenCalledWith(host.hostId);
});

test.each([RailAction.Rename, RailAction.Close])('a space long press offers Rename and Close and runs only %s', async action => {
  const onSelect = jest.fn();
  const onRename = jest.fn();
  const onClose = jest.fn();
  mount(<WorkspaceRail workspaces={[workspace]} selectedWorkspaceId={null} busy={false} onSelect={onSelect} onNew={jest.fn()} onRename={onRename} onClose={onClose} />);
  expect(hasButton('Close Project space')).toBe(false);
  longPress('Project, idle');
  expect(hasButton('Rename space')).toBe(true);
  expect(hasButton('Close Project space')).toBe(true);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onRename).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await selectAction(action === RailAction.Rename ? 'Rename space' : 'Close Project space');
  expect(action === RailAction.Rename ? onRename : onClose).toHaveBeenCalledWith(workspace);
  expect(action === RailAction.Rename ? onClose : onRename).not.toHaveBeenCalled();
});

test.each([{ readOnly: true, busy: false }, { readOnly: false, busy: true }])('space actions respect $readOnly read-only and $busy busy states while selection works', ({ readOnly, busy }) => {
  const onSelect = jest.fn();
  mount(<WorkspaceRail workspaces={[workspace]} selectedWorkspaceId={null} readOnly={readOnly} busy={busy} onSelect={onSelect} onNew={jest.fn()} onRename={jest.fn()} onClose={jest.fn()} />);
  const pill = button('Project, idle');
  expect(pill.props.onLongPress).toBeUndefined();
  expect(pill.props.accessibilityActions).toBeUndefined();
  act(() => { pill.props.onPress(); });
  expect(onSelect).toHaveBeenCalledWith(workspace.workspace_id);
});

test('All Spaces offers a new space without destructive actions', async () => {
  const onNew = jest.fn();
  mount(<WorkspaceRail workspaces={[workspace, { ...workspace, workspace_id: 'space-2' }]} selectedWorkspaceId={null} busy={false} onSelect={jest.fn()} onNew={onNew} onRename={jest.fn()} onClose={jest.fn()} />);
  expect(hasButton('New space')).toBe(false);
  longPress('All spaces, idle');
  expect(hasButton('Rename space')).toBe(false);
  expect(hasButton('Close Project space')).toBe(false);
  await selectAction('New space');
  expect(onNew).toHaveBeenCalledTimes(1);
});

function terminalProps() {
  return {
    tabs, selectedTabId: null, readOnly: false, busy: false,
    onSelect: jest.fn(), onNew: jest.fn(), onRenameTab: jest.fn(), onRenameSshTab: jest.fn(),
    onCloseTab: jest.fn().mockResolvedValue(undefined), onCloseTerminal: jest.fn(),
  };
}

test('terminal selection reuses unchanged buttons and dispatches their latest tab metadata', () => {
  const props = terminalProps();
  const many = Array.from({ length: 5 }, (_, index) => ({
    ...tabs[0], id: `tab-${index}`, label: `Agent ${index}`,
    herdrTab: { ...herdrTab, tab_id: `tab-${index}` },
  }));
  mount(<TerminalTabRail {...props} tabs={many} selectedTabId={many[0].id} />);
  const unchanged = button('Open Agent 4 tab').props;
  const current = many.map(item => ({ ...item, herdrTab: { ...item.herdrTab, number: 10 } }));
  act(() => { tree.update(<TerminalTabRail {...props} tabs={current} selectedTabId={many[1].id} />); });
  expect(button('Open Agent 4 tab').props).toBe(unchanged);
  act(() => { unchanged.onPress(); });
  expect(props.onSelect).toHaveBeenCalledWith(current[4]);
  accessibilityAction('Open Agent 4 tab', RailAction.Rename);
  expect(props.onRenameTab).toHaveBeenCalledWith(current[4].herdrTab);
});

test('workspace selection reuses unchanged chips and keeps their actions current', () => {
  const workspaces = Array.from({ length: 4 }, (_, index) => ({ ...workspace, workspace_id: `space-${index}`, label: `Project ${index}` }));
  const props = { workspaces, selectedWorkspaceId: workspaces[0].workspace_id, busy: false,
    onSelect: jest.fn(), onNew: jest.fn(), onRename: jest.fn(), onClose: jest.fn() };
  mount(<WorkspaceRail {...props} />);
  const label = 'Project 3, idle';
  const unchanged = button(label).props;
  const current = workspaces.map(item => ({ ...item, number: 10 }));
  act(() => { tree.update(<WorkspaceRail {...props} workspaces={current} selectedWorkspaceId={workspaces[1].workspace_id} />); });
  expect(button(label).props).toBe(unchanged);
  accessibilityAction(label, RailAction.Rename);
  expect(props.onRename).toHaveBeenCalledWith(current[3]);
});

describe.each(['android', 'ios'] as const)('%s terminal rail', platform => {
  beforeEach(() => { Object.assign(Platform, { OS: platform, isPad: platform === 'ios' }); });

  test.each(tabs)('taps select $label without showing a close button', item => {
    const props = terminalProps();
    mount(<TerminalTabRail {...props} />);
    expect(hasButton(`Close ${item.label} tab`)).toBe(false);
    act(() => { button(`Open ${item.label} tab`).props.onPress(); });
    expect(props.onSelect).toHaveBeenCalledWith(item);
  });

  test.each(tabs)('renames $label through its existing handler', async item => {
    const props = terminalProps();
    mount(<TerminalTabRail {...props} />);
    longPress(`Open ${item.label} tab`);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRenameTab).not.toHaveBeenCalled();
    expect(props.onRenameSshTab).not.toHaveBeenCalled();
    await selectAction('Rename tab');
    expect(item.herdrTab ? props.onRenameTab : props.onRenameSshTab).toHaveBeenCalledWith(item.herdrTab ?? item);
    expect(item.herdrTab ? props.onRenameSshTab : props.onRenameTab).not.toHaveBeenCalled();
  });

  test.each(tabs)('closes $label through its existing handler', async item => {
    const props = terminalProps();
    mount(<TerminalTabRail {...props} />);
    longPress(`Open ${item.label} tab`);
    await selectAction(`Close ${item.label} tab`);
    expect(item.herdrTab ? props.onCloseTab : props.onCloseTerminal).toHaveBeenCalledWith(item.herdrTab ?? item.id);
    expect(item.herdrTab ? props.onCloseTerminal : props.onCloseTab).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

test.each([{ readOnly: true, busy: false }, { readOnly: false, busy: true }])('terminal menu actions are unavailable when $readOnly read-only or $busy busy', overrides => {
  mount(<TerminalTabRail {...terminalProps()} {...overrides} />);
  for (const item of tabs) {
    expect(button(`Open ${item.label} tab`).props.onLongPress).toBeUndefined();
    expect(button(`Open ${item.label} tab`).props.accessibilityActions).toBeUndefined();
  }
});

test('screen-reader actions rename and close the correct terminal tab', () => {
  const props = terminalProps();
  mount(<TerminalTabRail {...props} />);
  accessibilityAction('Open Shell tab', RailAction.Rename);
  expect(props.onRenameSshTab).toHaveBeenCalledWith(tabs[1]);
  accessibilityAction('Open Agent tab', RailAction.Close);
  expect(props.onCloseTab).toHaveBeenCalledWith(herdrTab);
  expect(props.onSelect).not.toHaveBeenCalled();
});

test('a screen reader can open the same action menu and create a tab without a long press', async () => {
  const props = terminalProps();
  mount(<TerminalTabRail {...props} />);
  expect(hasButton('New tab')).toBe(false);
  accessibilityAction('Open Shell tab', 'rail-menu');
  expect(hasButton('Rename tab')).toBe(true);
  expect(hasButton('Close Shell tab')).toBe(true);
  await selectAction('New tab');
  expect(props.onNew).toHaveBeenCalledTimes(1);
  expect(props.onSelect).not.toHaveBeenCalled();
});

test('Cancel and Android Back dismiss the menu without taking action; a later tap selects normally', () => {
  const props = terminalProps();
  mount(<TerminalTabRail {...props} />);
  longPress('Open Shell tab');
  act(() => { tree.root.findByType(Pressable).props.onPress(); });
  longPress('Open Shell tab');
  act(() => { modal().props.onRequestClose(); });
  expect(props.onCloseTerminal).not.toHaveBeenCalled();
  expect(props.onRenameSshTab).not.toHaveBeenCalled();
  act(() => { button('Open Shell tab').props.onPressIn(); button('Open Shell tab').props.onPress(); });
  expect(props.onSelect).toHaveBeenCalledWith(tabs[1]);
});

test('a menu closes and its stale action cannot run after permissions change', () => {
  const props = terminalProps();
  mount(<TerminalTabRail {...props} />);
  longPress('Open Shell tab');
  const close = button('Close Shell tab').props.onPress;
  act(() => { tree.update(<TerminalTabRail {...props} readOnly />); });
  expect(hasButton('Close Shell tab')).toBe(false);
  act(() => { close(); });
  expect(props.onCloseTerminal).not.toHaveBeenCalled();
});

test.each(['removed', 'read-only', 'busy'] as const)('iOS waits for native dismissal and drops Rename if the tab becomes %s', async state => {
  Object.assign(Platform, { OS: 'ios' });
  const props = terminalProps();
  mount(<TerminalTabRail {...props} />);
  longPress('Open Shell tab');
  const dismiss = modal().props.onDismiss;
  act(() => { button('Rename tab').props.onPress(); });
  expect(props.onRenameSshTab).not.toHaveBeenCalled();
  act(() => { tree.update(<TerminalTabRail {...props}
    tabs={state === 'removed' ? [tabs[0]] : tabs}
    readOnly={state === 'read-only'}
    busy={state === 'busy'}
  />); });
  await act(async () => { dismiss(); });
  expect(props.onRenameSshTab).not.toHaveBeenCalled();
});

test('Strict Mode preserves menu actions after replaying mount effects', () => {
  const onClose = jest.fn();
  mount(<StrictMode><RailItemButton label="Test" accessibilityLabel="Test" onPress={jest.fn()} actions={[{ id: RailAction.Close, accessibilityLabel: 'Close Test', onPress: onClose }]} /></StrictMode>);
  accessibilityAction('Test', RailAction.Close);
  expect(onClose).toHaveBeenCalledTimes(1);
});
