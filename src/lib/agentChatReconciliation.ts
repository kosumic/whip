import type {
  NativeAgentChatBinding,
  RuntimeHostState,
} from 'react-native-whip-ssh';

import { chatAgentForPane } from './agentChatSession';
import type { AgentChatState } from '../agentChat';
import {
  agentTranscriptReadiness,
  type AgentChatProjection,
} from '../services/NativeTranscriptService';
import {
  chatPresentationRequested,
  AgentChatPresentationPhase,
  dormantChatPresentation,
  requestChatPresentation,
  type AgentChatPresentation,
} from './agentChatPresentation';

export interface AgentChatViewState {
  binding: NativeAgentChatBinding;
  presentation: AgentChatPresentation;
  state: AgentChatState;
}

/** Only a fresh native snapshot can confirm that a terminal became a shell. */
export function confirmedChatExit(
  host: RuntimeHostState,
  terminalId: string,
): boolean {
  if (
    host.syncStatus !== 'synced' ||
    host.freshness !== 'fresh' ||
    !host.snapshot
  )
    return false;
  const pane = host.snapshot.panes.find(
    item => item.terminal_id === terminalId,
  );
  return !pane || chatAgentForPane(pane) === null;
}

export function chatBindingLost(
  view: AgentChatViewState,
  exited: boolean,
): AgentChatViewState {
  if (!exited && view.presentation.phase === AgentChatPresentationPhase.Failed)
    return view;
  if (exited || !chatPresentationRequested(view.presentation)) {
    return { ...view, presentation: dormantChatPresentation() };
  }
  return {
    ...view,
    presentation: {
      ...view.presentation,
      phase: AgentChatPresentationPhase.Failed,
    },
    state: {
      ...view.state,
      status: 'error',
      error:
        'The host no longer has the requested Chat binding. Try Chat again to refresh the session.',
    },
  };
}

export function reconcileAgentChatViews(
  current: Map<string, AgentChatViewState>,
  liveTerminalIds: ReadonlySet<string>,
  projections: ReadonlyMap<string, AgentChatProjection>,
  reboundPresentations: ReadonlyMap<string, AgentChatPresentation>,
  exitedTerminalIds: ReadonlySet<string> = new Set(),
): Map<string, AgentChatViewState> {
  let next: Map<string, AgentChatViewState> | null = null;
  const mutable = () => {
    next ??= new Map(current);
    return next;
  };

  for (const [terminalId, view] of current) {
    if (!liveTerminalIds.has(terminalId)) {
      mutable().delete(terminalId);
      continue;
    }
    const projection = projections.get(terminalId);
    if (!projection) continue;
    if (projection.type === 'no-chat') {
      if (
        exitedTerminalIds.has(terminalId) ||
        !chatPresentationRequested(view.presentation)
      ) {
        if (
          view.presentation.phase !== AgentChatPresentationPhase.Failed ||
          exitedTerminalIds.has(terminalId)
        )
          mutable().delete(terminalId);
      } else {
        mutable().set(terminalId, chatBindingLost(view, false));
      }
      continue;
    }
    if (projection.binding.bindingToken !== view.binding.bindingToken) {
      mutable().set(terminalId, {
        binding: projection.binding,
        presentation: chatPresentationRequested(view.presentation)
          ? reboundPresentations.get(terminalId) ??
            requestChatPresentation(
              dormantChatPresentation(),
              agentTranscriptReadiness(projection.state),
              view.presentation.generation,
            )
          : dormantChatPresentation(),
        state: projection.state,
      });
      continue;
    }
    if (projection.state !== view.state) {
      mutable().set(terminalId, { ...view, state: projection.state });
    }
  }

  return next ?? current;
}
