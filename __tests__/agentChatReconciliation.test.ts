import type {
  NativeAgentChatBinding,
  RuntimeHostState,
  NativeAgentTranscriptState,
} from 'react-native-whip-ssh';

import { emptyTranscript, type AgentChatState } from '../src/agentChat';
import {
  reconcileAgentChatViews,
  confirmedChatExit,
  type AgentChatViewState,
} from '../src/lib/agentChatReconciliation';
import { AgentChatPresentationPhase } from '../src/lib/agentChatPresentation';

const TERMINAL_ID = 'terminal-1';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function nativeState(revision: number): NativeAgentTranscriptState {
  return {
    agent: 'codex',
    messages: [],
    revision,
    sessionId: SESSION_ID,
    status: 'live',
    turns: [],
  };
}

function binding(state: NativeAgentTranscriptState): NativeAgentChatBinding {
  return {
    agent: 'codex',
    bindingGeneration: 1,
    bindingToken: 'binding-1',
    paneId: 'pane-1',
    runtimeIncarnation: 1,
    sessionId: SESSION_ID,
    state,
    terminalId: TERMINAL_ID,
    transcriptKey: 'transcript-1',
  };
}

function chatState(revision: number): AgentChatState {
  return {
    revision,
    sessionId: SESSION_ID,
    status: 'live',
    transcript: emptyTranscript(SESSION_ID),
  };
}

test('snapshot reconciliation preserves a concurrently revealed viewport', () => {
  const originalState = chatState(3);
  const visible: AgentChatViewState = {
    binding: binding(nativeState(3)),
    presentation: {
      generation: 7,
      phase: AgentChatPresentationPhase.Visible,
    },
    state: originalState,
  };
  const current = new Map([[TERMINAL_ID, visible]]);
  const updatedState = chatState(30);
  const projection = {
    type: 'bound' as const,
    binding: binding(nativeState(30)),
    state: updatedState,
  };

  const reconciled = reconcileAgentChatViews(
    current,
    new Set([TERMINAL_ID]),
    new Map([[TERMINAL_ID, projection]]),
    new Map(),
  );

  expect(reconciled).not.toBe(current);
  expect(reconciled.get(TERMINAL_ID)?.state).toBe(updatedState);
  expect(reconciled.get(TERMINAL_ID)?.presentation).toBe(visible.presentation);
  expect(reconciled.get(TERMINAL_ID)?.presentation.phase).toBe(
    AgentChatPresentationPhase.Visible,
  );
});

test('unchanged reconciliation preserves the map identity', () => {
  const state = chatState(3);
  const view: AgentChatViewState = {
    binding: binding(nativeState(3)),
    presentation: {
      generation: 7,
      phase: AgentChatPresentationPhase.Visible,
    },
    state,
  };
  const current = new Map([[TERMINAL_ID, view]]);

  const reconciled = reconcileAgentChatViews(
    current,
    new Set([TERMINAL_ID]),
    new Map([
      [TERMINAL_ID, { type: 'bound' as const, binding: view.binding, state }],
    ]),
    new Map(),
  );

  expect(reconciled).toBe(current);
});

const requestedPhases = [
  AgentChatPresentationPhase.LoadingTranscript,
  AgentChatPresentationPhase.PreparingViewport,
  AgentChatPresentationPhase.Visible,
];

test.each(requestedPhases)(
  'unexpected no-chat during %s retains a failed presentation instead of silently deleting it',
  phase => {
    const view: AgentChatViewState = {
      binding: binding(nativeState(1)),
      state: chatState(1),
      presentation: { generation: 7, phase },
    };
    const result = reconcileAgentChatViews(
      new Map([[TERMINAL_ID, view]]),
      new Set([TERMINAL_ID]),
      new Map([
        [
          TERMINAL_ID,
          {
            type: 'no-chat',
            terminalId: TERMINAL_ID,
            reason: 'unsupported-pane',
          },
        ],
      ]),
      new Map(),
    );
    expect(result.get(TERMINAL_ID)?.presentation.phase).toBe(
      AgentChatPresentationPhase.Failed,
    );
    expect(result.get(TERMINAL_ID)?.state.error).toContain('Try Chat again');
  },
);

test.each(requestedPhases)(
  'confirmed agent exit during %s removes Chat quietly',
  phase => {
    const view: AgentChatViewState = {
      binding: binding(nativeState(1)),
      state: chatState(1),
      presentation: { generation: 7, phase },
    };
    const result = reconcileAgentChatViews(
      new Map([[TERMINAL_ID, view]]),
      new Set([TERMINAL_ID]),
      new Map([
        [
          TERMINAL_ID,
          {
            type: 'no-chat',
            terminalId: TERMINAL_ID,
            reason: 'unsupported-pane',
          },
        ],
      ]),
      new Map(),
      new Set([TERMINAL_ID]),
    );
    expect(result.has(TERMINAL_ID)).toBe(false);
  },
);

test.each([
  AgentChatPresentationPhase.Dormant,
  AgentChatPresentationPhase.Warm,
])('background %s binding loss is quiet', phase => {
  const view: AgentChatViewState = {
    binding: binding(nativeState(1)),
    state: chatState(1),
    presentation: { generation: 7, phase },
  };
  const result = reconcileAgentChatViews(
    new Map([[TERMINAL_ID, view]]),
    new Set([TERMINAL_ID]),
    new Map([
      [
        TERMINAL_ID,
        {
          type: 'no-chat',
          terminalId: TERMINAL_ID,
          reason: 'unsupported-pane',
        },
      ],
    ]),
    new Map(),
  );
  expect(result.has(TERMINAL_ID)).toBe(false);
});

test('an unbound pane counts as an exit only in a fresh authoritative snapshot', () => {
  const host = {
    syncStatus: 'synced',
    freshness: 'fresh',
    snapshot: { panes: [{ terminal_id: TERMINAL_ID, agent: 'shell' }] },
  } as RuntimeHostState;
  expect(confirmedChatExit(host, TERMINAL_ID)).toBe(true);
  expect(confirmedChatExit({ ...host, freshness: 'stale' }, TERMINAL_ID)).toBe(
    false,
  );
  expect(
    confirmedChatExit({ ...host, syncStatus: 'syncing' }, TERMINAL_ID),
  ).toBe(false);
  expect(confirmedChatExit({ ...host, snapshot: undefined }, TERMINAL_ID)).toBe(
    false,
  );
});

test('a concurrent explicit request stays requested when reconciliation rebinds it', () => {
  const view: AgentChatViewState = {
    binding: binding(nativeState(1)),
    state: chatState(1),
    presentation: {
      generation: 7,
      phase: AgentChatPresentationPhase.LoadingTranscript,
    },
  };
  const nextBinding = { ...view.binding, bindingToken: 'binding-2' };
  const result = reconcileAgentChatViews(
    new Map([[TERMINAL_ID, view]]),
    new Set([TERMINAL_ID]),
    new Map([
      [
        TERMINAL_ID,
        { type: 'bound', binding: nextBinding, state: chatState(2) },
      ],
    ]),
    // The snapshot effect ran before the user's presentation update committed.
    new Map(),
  );
  expect(result.get(TERMINAL_ID)?.presentation.phase).toBe(
    AgentChatPresentationPhase.PreparingViewport,
  );
});
