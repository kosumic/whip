import {
  activePaneForTerminal,
  agentChatControlState,
  chatAgentForPane,
} from '../src/lib/agentChatSession';
import {
  AgentChatPresentationPhase,
  chatPresentationLoading,
  chatPresentationMountsViewport,
  chatPresentationVisible,
  closeChatPresentation,
  dormantChatPresentation,
  requestChatPresentation,
  revealPreparedChat,
  updateChatTranscriptReadiness,
} from '../src/lib/agentChatPresentation';
import { emptyTranscript, type AgentChatState } from '../src/agentChat';
import { agentTranscriptReadiness } from '../src/services/NativeTranscriptService';
import type { TerminalSession } from '../src/terminalSessions';
import type { PaneInfo } from '../src/types';

const pane = (agent: string, sessionAgent = agent, value = ''): PaneInfo => ({
  pane_id: 'pane',
  terminal_id: 'terminal',
  tab_id: 'tab',
  workspace_id: 'workspace',
  focused: true,
  revision: 1,
  agent,
  display_agent: agent,
  agent_status: 'idle',
  ...(value
    ? {
        agent_session: {
          source: `herdr:${sessionAgent}`,
          agent: sessionAgent,
          kind: 'id' as const,
          value,
        },
      }
    : {}),
});

test('chat control is limited to Codex and OpenCode panes', () => {
  expect(chatAgentForPane(undefined)).toBeNull();
  expect(chatAgentForPane(pane('codex'))).toBe('codex');
  expect(chatAgentForPane(pane('opencode'))).toBe('opencode');
  expect(chatAgentForPane(pane('open-code'))).toBe('opencode');
  expect(chatAgentForPane(pane('claude'))).toBeNull();
});

test('chat control follows the supported active terminal pane', () => {
  const codex = pane('codex');
  const unsupported = { ...pane('claude'), terminal_id: 'other-terminal' };
  const sessions: TerminalSession[] = [
    {
      terminalId: codex.terminal_id,
      paneId: codex.pane_id,
      title: 'Codex',
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    },
    {
      terminalId: unsupported.terminal_id,
      paneId: unsupported.pane_id,
      title: 'Claude',
      kind: 'herdr',
      status: 'connected',
      reconnectAttempt: 0,
    },
  ];

  const activeCodex = activePaneForTerminal(
    [codex, unsupported],
    sessions,
    codex.terminal_id,
  );
  const activeUnsupported = activePaneForTerminal(
    [codex, unsupported],
    sessions,
    unsupported.terminal_id,
  );

  expect(agentChatControlState(activeCodex, false, false)).toEqual({
    agent: 'codex',
    disabled: false,
    loading: false,
  });
  expect(agentChatControlState(activeUnsupported, false, false)).toBeNull();
  expect(activePaneForTerminal([codex], sessions, 'missing')).toBeUndefined();
});

test('busy and history-loading states disable a supported chat control', () => {
  const codex = pane('codex');

  expect(agentChatControlState(codex, true, false)?.disabled).toBe(true);
  expect(agentChatControlState(codex, false, true)?.disabled).toBe(true);
  expect(agentChatControlState(codex, false, false)?.disabled).toBe(false);
});

const transcriptState = (
  status: AgentChatState['status'],
): AgentChatState => ({
  sessionId: 'session-1',
  transcript: emptyTranscript('session-1'),
  status,
});

describe('initial Chat presentation lifecycle', () => {
  test('the transcript service distinguishes usable cached/live data from loading and failures', () => {
    expect(agentTranscriptReadiness(transcriptState('loading'))).toBe('loading');
    expect(agentTranscriptReadiness(transcriptState('live'))).toBe('usable');
    expect(agentTranscriptReadiness(transcriptState('stale'))).toBe('usable');
    expect(agentTranscriptReadiness(transcriptState('error'))).toBe('failed');
    expect(agentTranscriptReadiness(transcriptState('unavailable'))).toBe('failed');
  });

  test('a Chat request keeps Terminal visible and exposes loading until the transcript is usable', () => {
    const loading = requestChatPresentation(
      dormantChatPresentation(),
      agentTranscriptReadiness(transcriptState('loading')),
      1,
    );

    expect(loading.phase).toBe(AgentChatPresentationPhase.LoadingTranscript);
    expect(chatPresentationVisible(loading)).toBe(false);
    expect(chatPresentationMountsViewport(loading)).toBe(false);
    expect(chatPresentationLoading(loading)).toBe(true);
    expect(agentChatControlState(pane('codex'), false, chatPresentationLoading(loading)))
      .toEqual({ agent: 'codex', disabled: true, loading: true });

    const preparing = updateChatTranscriptReadiness(loading, 'usable', 1);
    expect(preparing.phase).toBe(AgentChatPresentationPhase.PreparingViewport);
    expect(chatPresentationMountsViewport(preparing)).toBe(true);
    expect(chatPresentationVisible(preparing)).toBe(false);
    expect(chatPresentationLoading(preparing)).toBe(true);
  });

  test('an empty successfully loaded transcript prepares and reveals after viewport readiness', () => {
    const emptyLive = transcriptState('live');
    expect(emptyLive.transcript.turns).toHaveLength(0);
    expect(agentTranscriptReadiness(emptyLive)).toBe('usable');

    const preparing = requestChatPresentation(
      dormantChatPresentation(),
      agentTranscriptReadiness(emptyLive),
      4,
    );
    expect(chatPresentationVisible(preparing)).toBe(false);

    const visible = revealPreparedChat(preparing, 4);
    expect(visible.phase).toBe(AgentChatPresentationPhase.Visible);
    expect(chatPresentationVisible(visible)).toBe(true);
    expect(chatPresentationLoading(visible)).toBe(false);
  });

  test('a loading failure exits the busy state while native recovery continues', () => {
    const loading = requestChatPresentation(
      dormantChatPresentation(),
      'loading',
      6,
    );
    const retrying = updateChatTranscriptReadiness(loading, 'failed', 6);

    expect(retrying.phase).toBe(AgentChatPresentationPhase.Failed);
    expect(chatPresentationLoading(retrying)).toBe(false);
    expect(chatPresentationVisible(retrying)).toBe(false);
    expect(chatPresentationMountsViewport(retrying)).toBe(false);
  });

  test('a first-open failure recovers without requiring a second Chat request', () => {
    const retrying = requestChatPresentation(
      dormantChatPresentation(),
      'failed',
      7,
    );
    const recovered = updateChatTranscriptReadiness(retrying, 'usable', 7);

    expect(retrying.phase).toBe(AgentChatPresentationPhase.Failed);
    expect(recovered.phase).toBe(AgentChatPresentationPhase.PreparingViewport);
    expect(chatPresentationLoading(recovered)).toBe(true);
  });

  test('a viewport callback from a replaced terminal or session generation is ignored', () => {
    const oldPreparing = requestChatPresentation(
      dormantChatPresentation(),
      'usable',
      7,
    );
    const replacementPreparing = requestChatPresentation(
      dormantChatPresentation(),
      'usable',
      8,
    );

    expect(revealPreparedChat(replacementPreparing, oldPreparing.generation))
      .toBe(replacementPreparing);
    expect(chatPresentationVisible(replacementPreparing)).toBe(false);
  });

  test('closing during preparation prevents its old callback from revealing Chat', () => {
    const preparing = requestChatPresentation(
      dormantChatPresentation(),
      'usable',
      10,
    );
    const closed = closeChatPresentation(preparing);

    expect(closed.phase).toBe(AgentChatPresentationPhase.Dormant);
    expect(revealPreparedChat(closed, preparing.generation)).toBe(closed);

    const reopened = requestChatPresentation(closed, 'usable', 11);
    expect(revealPreparedChat(reopened, preparing.generation)).toBe(reopened);
    expect(chatPresentationVisible(reopened)).toBe(false);
  });

  test('reopening an initialized projection uses its warm viewport immediately', () => {
    const preparing = requestChatPresentation(
      dormantChatPresentation(),
      agentTranscriptReadiness(transcriptState('stale')),
      12,
    );
    const visible = revealPreparedChat(preparing, 12);
    const warm = closeChatPresentation(visible);
    const reopened = requestChatPresentation(warm, 'usable', 13);

    expect(warm.phase).toBe(AgentChatPresentationPhase.Warm);
    expect(chatPresentationMountsViewport(warm)).toBe(true);
    expect(reopened).toEqual({
      generation: 12,
      phase: AgentChatPresentationPhase.Visible,
    });
    expect(chatPresentationLoading(reopened)).toBe(false);
  });
});
