import {
  parseAgentNotificationTarget,
  resolveAgentNotificationTarget,
  restoreAgentNotificationTarget,
} from '../src/lib/notificationNavigation';
import type { AppSessionProjection, WhipHostSnapshot } from 'react-native-whip-ssh';
import type { PaneInfo } from '../src/types';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

function response(data: Record<string, unknown>, actionIdentifier = DEFAULT_ACTION) {
  return {
    actionIdentifier,
    notification: {
      request: {
        identifier: 'notification-42',
        content: { data },
      },
    },
  };
}

function pane(paneId: string, terminalId: string): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    focused: false,
    agent_status: 'done',
    revision: 1,
  };
}

function snapshot(panes: PaneInfo[]): WhipHostSnapshot {
  return {
    version: '1', protocol: 22,
    focused_workspace_id: undefined,
    focused_tab_id: undefined,
    focused_pane_id: undefined,
    agents: [],
    workspaces: [],
    tabs: [],
    panes,
    layouts: [],
  };
}

function session(id: string, hostId: string, panes: PaneInfo[]): AppSessionProjection {
  return { id, hostId, connectionStatus: 'ready', reconnectAttempt: 0, selection: {},
    agentControls: [],
    terminalRail: { terminals: [], resumeBlob: '' },
    hostState: { revision: 1, connectionGeneration: 1, syncGeneration: 1, syncStatus: 'synced', freshness: 'fresh', needsResync: false, focus: {}, snapshot: snapshot(panes) },
  };
}

describe('agent notification navigation', () => {
  test('parses a default notification tap with its host and pane', () => {
    expect(parseAgentNotificationTarget(
      response({ hostId: 'savior', paneId: 'w1:p4' }),
      DEFAULT_ACTION,
    )).toEqual({
      notificationId: 'notification-42',
      hostId: 'savior',
      paneId: 'w1:p4',
    });
  });

  test('ignores non-default actions and incomplete routing data', () => {
    expect(parseAgentNotificationTarget(
      response({ hostId: 'savior', paneId: 'w1:p4' }, 'dismiss'),
      DEFAULT_ACTION,
    )).toBeNull();
    expect(parseAgentNotificationTarget(response({ paneId: 'w1:p4' }), DEFAULT_ACTION)).toBeNull();
  });

  test('resolves the pane on the originating host even when pane ids overlap', () => {
    const saviorPane = pane('w1:p4', 'savior-terminal');
    const builderPane = pane('w1:p4', 'builder-terminal');
    const state = {
      revision: 1,
      sessions: [
        session('savior-live', 'savior', [saviorPane]),
        session('builder-live', 'builder', [builderPane]),
      ],
    };

    expect(resolveAgentNotificationTarget(state, { hostId: 'builder', paneId: 'w1:p4' })).toEqual({
      sessionId: 'builder-live',
      pane: builderPane,
    });
    expect(resolveAgentNotificationTarget(state, { hostId: 'missing', paneId: 'w1:p4' })).toBeNull();
  });
});

test.each(['disconnected', 'terminated'])('restores a %s host and fresh snapshot before navigation', async initial => {
  const oldPane = pane('w1:p4', 'old-terminal');
  const newPane = pane('w1:p4', 'fresh-terminal');
  const state = {revision:1, sessions: initial === 'terminated' ? [] : [session('saved', 'origin', [oldPane])]};
  const order:string[]=[];
  const resolved = await restoreAgentNotificationTarget({
    target:{hostId:'origin',paneId:'w1:p4'}, getState:() => state,
    connect:() => {order.push('connect'); state.sessions=[session('saved','origin',[oldPane])]; return Promise.resolve();},
    refresh:sessionId => {order.push('refresh:'+sessionId); state.sessions=[session('saved','origin',[newPane])]; return Promise.resolve();},
  });
  expect(order).toEqual(['connect','refresh:saved']);
  expect(resolved).toEqual({sessionId:'saved',pane:newPane});
});
test('does not navigate to a closed pane after refreshing', async () => {
  const state = {revision:1,sessions:[session('saved','origin',[])]};
  await expect(restoreAgentNotificationTarget({target:{hostId:'origin',paneId:'closed'},getState:() => state,connect:() => Promise.resolve(),refresh:() => Promise.resolve()})).rejects.toThrow('no longer available');
});
