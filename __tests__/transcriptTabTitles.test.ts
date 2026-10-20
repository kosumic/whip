import type { NativeAgentChatBinding } from 'react-native-whip-ssh';
import type { AgentChatState } from '../src/agentChat';
import { TranscriptTabTitles, transcriptTitleKey } from '../src/lib/transcriptTabTitles';
import type { PaneInfo, TabInfo } from '../src/types';

function conversation(agent: NativeAgentChatBinding['agent'], id: string, tabId = id) {
  const tab: TabInfo = {
    tab_id: tabId, workspace_id: 'workspace', label: `Herdr ${tabId}`,
    number: 1, focused: true, pane_count: 1, agent_status: 'idle', label_is_custom: false,
  };
  const pane: PaneInfo = {
    pane_id: `pane-${id}`, terminal_id: `terminal-${id}`, workspace_id: tab.workspace_id,
    tab_id: tabId, focused: true, agent_status: 'idle', revision: 1,
    agent_session: { agent, source: 'herdr', kind: 'id', value: id },
  };
  const binding = { paneId: pane.pane_id, terminalId: pane.terminal_id, agent, sessionId: id };
  const state = (title?: string, sessionId = id): AgentChatState => ({
    sessionId, revision: 1, status: 'live',
    transcript: { sessionId, info: { id: sessionId, title }, messages: [], turns: [] },
  });
  return { tab, pane, binding, state };
}

test('unloaded transcripts and unknown or explicit manual labels preserve Herdr naming', () => {
  const cache = new TranscriptTabTitles();
  const { tab, pane, binding, state } = conversation('claude', 'session');
  const label = () => cache.label('host', tab, [pane], null);
  expect(label()).toBe(tab.label);
  cache.observe('host', pane, binding, state('Conversation'));
  expect(label()).toBe('Conversation');
  tab.label_is_custom = true;
  // Manual origin wins even when its text happens to look like a default label.
  cache.observe('host', pane, binding, state('Updated conversation'));
  expect(label()).toBe(tab.label);
  tab.label_is_custom = undefined;
  expect(label()).toBe(tab.label);
  tab.label = '';
  expect(label()).toBe(tab.tab_id);
});

test.each([undefined, '', ' \t\n '])('empty title %p clears an earlier override', title => {
  const cache = new TranscriptTabTitles();
  const { tab, pane, binding, state } = conversation('codex', 'session');
  expect(cache.observe('host', pane, binding, state('First'))).toBe(true);
  expect(cache.observe('host', pane, binding, state('First'))).toBe(false);
  expect(cache.observe('host', pane, binding, state('Second'))).toBe(true);
  expect(cache.label('host', tab, [pane], null)).toBe('Second');
  cache.observe('host', pane, binding, state(title));
  expect(cache.label('host', tab, [pane], null)).toBe(tab.label);
});

test('tabs and focused panes isolate titles for every agent, including two sessions of one agent', () => {
  const cache = new TranscriptTabTitles();
  const sessions = [conversation('claude', 'a'), conversation('codex', 'b'),
    conversation('opencode', 'c'), conversation('codex', 'd', 'b')];
  const panes = sessions.map(session => session.pane);
  panes[3].focused = false;
  for (const { pane, binding, state } of sessions) {
    cache.observe('host', pane, binding, state(binding.sessionId));
  }
  for (const { tab, binding } of sessions.slice(0, 3)) {
    expect(cache.label('host', tab, panes, null)).toBe(binding.sessionId);
    expect(cache.label('other-host', tab, panes, null)).toBe(tab.label);
  }
  expect(cache.label('host', sessions[1].tab, panes, panes[3].terminal_id)).toBe('d');
  // An unloaded focused pane must not borrow another pane's title.
  panes[3].agent_session = { ...panes[3].agent_session!, value: 'not-loaded' };
  expect(cache.label('host', sessions[1].tab, panes, panes[3].terminal_id)).toBe(sessions[1].tab.label);
});

test('new, clear, resume and mismatched snapshots never borrow a different conversation title', () => {
  const cache = new TranscriptTabTitles();
  const { tab, pane, binding, state } = conversation('codex', 'original');
  cache.observe('host', pane, binding, state('Original'));
  const switched = { ...pane, agent_session: { ...pane.agent_session!, value: 'resumed' } };
  expect(cache.label('host', tab, [switched], null)).toBe(tab.label);
  expect(cache.observe('host', switched, binding, state('Late old update'))).toBe(false);
  cache.observe('host', switched, { ...binding, sessionId: 'resumed' }, state('Resumed', 'resumed'));
  expect(cache.label('host', tab, [switched], null)).toBe('Resumed');
  expect(cache.label('host', tab, [{ ...pane, agent_session: undefined }], null)).toBe(tab.label);
  expect(cache.label('host', tab, [{ ...pane, terminal_id: 'replacement-terminal' }], null)).toBe(tab.label);
  expect(cache.label('host', tab, [{ ...pane, agent_session: { ...pane.agent_session!, agent: 'claude' } }], null)).toBe(tab.label);
  cache.observe('host', pane, binding, state('Incorrect', 'other-session'));
  expect(cache.label('host', tab, [pane], null)).toBe(tab.label);
});

test('titles survive unloading and same-session reconnection in memory, and are forgotten with the pane', () => {
  const cache = new TranscriptTabTitles();
  const { tab, pane, binding, state } = conversation('opencode', 'session');
  cache.observe('host', pane, binding, state('Retained'));
  cache.retain('host', [{ ...pane }]);
  // There is no transport or loader in the display cache; reading stays local.
  expect(cache.label('host', tab, [pane], null)).toBe('Retained');
  expect(new TranscriptTabTitles().label('host', tab, [pane], null)).toBe(tab.label);
  cache.retain('host', []);
  expect(cache.label('host', tab, [pane], null)).toBe(tab.label);
});

test('card subscribers update only for their conversation and only when its title changes', () => {
  const cache = new TranscriptTabTitles();
  const first = conversation('codex', 'first');
  const second = conversation('claude', 'second');
  const listener = jest.fn();
  const stop = cache.subscribe(transcriptTitleKey('host', first.pane), listener);
  cache.observeBinding('host', second.binding, second.state('Other'));
  expect(listener).not.toHaveBeenCalled();
  cache.observeBinding('host', first.binding, first.state('First'));
  cache.observeBinding('host', first.binding, first.state('First'));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(cache.title(transcriptTitleKey('host', first.pane))).toBe('First');
  cache.clear();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(cache.title(transcriptTitleKey('host', first.pane))).toBeUndefined();
  stop();
  cache.observeBinding('host', first.binding, first.state('After unsubscribe'));
  expect(listener).toHaveBeenCalledTimes(2);
});
