import {
  agentNotificationTitle,
  tabNameForAgent,
} from '../src/lib/agentStatusEvents';
import type { AgentInfo } from '../src/types';

const agent: AgentInfo = {
  terminal_id: 'terminal-1',
  agent: 'codex',
  agent_status: 'working',
  workspace_id: 'workspace-1',
  tab_id: 'tab-1',
  pane_id: 'pane-1',
  focused: true,
  revision: 1,
};

describe('agent status events', () => {
  test('uses the tab label and Herdr agent kind in notification titles', () => {
    const tabs = [{
      tab_id: 'tab-1',
      workspace_id: 'workspace-1',
      number: 1,
      label: 'Gold research',
      focused: true,
      pane_count: 1,
      agent_status: 'working' as const,
    }];

    expect(tabNameForAgent(agent, tabs)).toBe('Gold research');
    expect(agentNotificationTitle({ ...agent, agent_status: 'done' }, 'Gold research'))
      .toBe('Gold research · codex finished');
    expect(agentNotificationTitle({ ...agent, agent_status: 'blocked' }, 'Gold research'))
      .toBe('Gold research · codex needs attention');
  });

  test('does not mistake a tab-derived managed name for the agent type', () => {
    const rev = { ...agent, name: 'rev', display_agent: 'rev', agent_status: 'done' as const };
    expect(agentNotificationTitle(rev, 'rev')).toBe('rev · codex finished');
    expect(agentNotificationTitle({ ...rev, agent_status: 'blocked' }, 'rev'))
      .toBe('rev · codex needs attention');
  });

  test('has safe fallbacks and no duplicated tab label', () => {
    const unnamed = { ...agent, agent: undefined, name: 'rev', agent_status: 'done' as const };
    expect(agentNotificationTitle(unnamed, 'rev')).toBe('rev · Agent finished');
    expect(agentNotificationTitle({ ...unnamed, display_agent: 'opencode' }, 'rev'))
      .toBe('rev · opencode finished');
    expect(agentNotificationTitle({ ...agent, agent_status: 'done' }, 'codex'))
      .toBe('codex finished');
    expect(agentNotificationTitle({ ...agent, agent_status: 'done' }))
      .toBe('codex finished');
    expect(tabNameForAgent(agent, [])).toBe('');
  });

  test('preserves conversation title overrides for speech announcements', () => {
    expect(agentNotificationTitle({ ...agent, agent_status: 'done' }, undefined, undefined, 'Fix keyboard jitter'))
      .toBe('Fix keyboard jitter finished');
  });

});
