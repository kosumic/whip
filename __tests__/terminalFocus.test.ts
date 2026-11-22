import {
  activateCreatedTabLocally,
  includePendingCreatedSelection,
  reconcilePendingCreatedSelection,
  serverFocusMatchesPendingPane,
  shouldFollowServerTerminalFocus,
} from '../src/lib/terminalFocus';
import type { TerminalSessionsState } from '../src/terminalSessions';
import type { PaneInfo, TabInfo } from '../src/types';

const createdTab = {
  tab: {
    tab_id: 'tab-new',
    workspace_id: 'workspace-1',
    number: 2,
    label: 'New tab',
    focused: true,
    pane_count: 1,
    agent_status: 'idle',
  } as TabInfo,
  root_pane: {
    pane_id: 'pane-new',
    terminal_id: 'terminal-new',
    workspace_id: 'workspace-1',
    tab_id: 'tab-new',
    focused: true,
    agent_status: 'idle',
    revision: 0,
  } as PaneInfo,
};

test('locally created tabs select the tab and activate the returned root terminal together', () => {
  let selectedWorkspaceId = 'workspace-1';
  let selectedTabId = 'tab-old';
  let terminals = terminalFixture({
    ...createdTab.root_pane,
    pane_id: 'pane-old',
    terminal_id: 'terminal-old',
    tab_id: 'tab-old',
  });
  const terminalSelectionStarted = jest.fn();

  activateCreatedTabLocally(createdTab, {
    select: (workspaceId, tabId) => {
      selectedWorkspaceId = workspaceId;
      selectedTabId = tabId;
    },
    terminalSelectionStarted,
    activateTerminal: pane => {
      terminals = terminalFixture(pane, terminals);
    },
  });

  expect(selectedWorkspaceId).toBe('workspace-1');
  expect(selectedTabId).toBe('tab-new');
  expect(terminals.activeTerminalId).toBe('terminal-new');
  expect(terminalSelectionStarted).toHaveBeenCalledWith('terminal-new');
});

function terminalFixture(
  pane: PaneInfo,
  current: TerminalSessionsState = { sessions: [], activeTerminalId: null },
): TerminalSessionsState {
  const sessions = current.sessions.filter(
    terminal => terminal.terminalId !== pane.terminal_id,
  );
  sessions.push({
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
    title: pane.label || pane.pane_id,
    kind: 'herdr',
    status: 'connecting',
    reconnectAttempt: 0,
  });
  return { sessions, activeTerminalId: pane.terminal_id };
}

test('keeps a created tab selected across a stale snapshot until its tab and pane are confirmed', () => {
  const oldTab = {
    ...createdTab.tab,
    tab_id: 'tab-old',
    number: 1,
    label: 'Old tab',
  };
  const oldPane = {
    ...createdTab.root_pane,
    pane_id: 'pane-old',
    terminal_id: 'terminal-old',
    tab_id: 'tab-old',
  };
  let selectedTabId = createdTab.tab.tab_id;
  let pending = reconcilePendingCreatedSelection(createdTab, {
    tabs: [oldTab],
    panes: [oldPane],
  });

  const staleResources = includePendingCreatedSelection({
    tabs: [oldTab],
    panes: [oldPane],
  }, pending);
  const selectedFromStaleSnapshot = staleResources.tabs.find(tab => tab.tab_id === selectedTabId)
    || staleResources.tabs.find(tab => tab.focused)
    || staleResources.tabs[0];
  if (selectedFromStaleSnapshot && selectedFromStaleSnapshot.tab_id !== selectedTabId) {
    selectedTabId = selectedFromStaleSnapshot.tab_id;
  }

  expect(pending).toBe(createdTab);
  expect(selectedTabId).toBe('tab-new');
  expect(staleResources.panes).toContain(createdTab.root_pane);
  expect(serverFocusMatchesPendingPane(oldPane.pane_id, pending?.root_pane.pane_id || null)).toBe(false);

  const caughtUpResources = {
    tabs: [oldTab, createdTab.tab],
    panes: [oldPane, createdTab.root_pane],
  };
  pending = reconcilePendingCreatedSelection(pending, caughtUpResources);
  const selectedFromCaughtUpSnapshot = caughtUpResources.tabs.find(tab => tab.tab_id === selectedTabId)
    || caughtUpResources.tabs.find(tab => tab.focused)
    || caughtUpResources.tabs[0];

  expect(pending).toBeNull();
  expect(selectedFromCaughtUpSnapshot?.tab_id).toBe('tab-new');
  expect(selectedTabId).toBe('tab-new');
});

test('does not clear a pending creation from a partial snapshot', () => {
  expect(reconcilePendingCreatedSelection(createdTab, {
    tabs: [createdTab.tab],
    panes: [],
  })).toBe(createdTab);
  expect(reconcilePendingCreatedSelection(createdTab, {
    tabs: [],
    panes: [createdTab.root_pane],
  })).toBe(createdTab);
});

test('rapid creates activate immediately while metadata recovery remains pending', () => {
  const first = createdTab;
  const second = {
    tab: { ...first.tab, tab_id: 'tab-next' },
    root_pane: { ...first.root_pane, tab_id: 'tab-next', pane_id: 'pane-next', terminal_id: 'terminal-next' },
  };
  const select = jest.fn();
  const activateTerminal = jest.fn();
  const terminalSelectionStarted = jest.fn();
  for (const created of [first, second]) {
    activateCreatedTabLocally(created, { select, activateTerminal, terminalSelectionStarted });
  }
  expect(activateTerminal.mock.calls.map(([pane]) => pane.terminal_id)).toEqual(['terminal-new', 'terminal-next']);
  const pending = reconcilePendingCreatedSelection(second, { tabs: [first.tab], panes: [first.root_pane] });
  const projected = includePendingCreatedSelection({ tabs: [first.tab], panes: [first.root_pane] }, pending);
  expect(projected.tabs).toEqual([first.tab, second.tab]);
  expect(projected.panes[0]).toBe(first.root_pane);
  expect(select).toHaveBeenLastCalledWith(second.tab.workspace_id, second.tab.tab_id);
  expect(activateTerminal).toHaveBeenLastCalledWith(second.root_pane);
});

test('ignores stale server focus while a selected pane is pending', () => {
  expect(serverFocusMatchesPendingPane('previous-pane', 'selected-pane')).toBe(false);
  expect(serverFocusMatchesPendingPane('selected-pane', 'selected-pane')).toBe(true);
});

test('follows server focus when there is no pending user selection', () => {
  expect(serverFocusMatchesPendingPane('remote-pane', null)).toBe(true);
});

test('does not let startup focus updates steal an already visible terminal tab', () => {
  expect(shouldFollowServerTerminalFocus(true, 'selected-pane')).toBe(false);
  expect(shouldFollowServerTerminalFocus(false, 'selected-pane')).toBe(true);
  expect(shouldFollowServerTerminalFocus(true, null)).toBe(true);
});
