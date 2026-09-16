import type { AgentTranscriptReadiness } from '../services/NativeTranscriptService';

export enum AgentChatPresentationPhase {
  Dormant = 'dormant',
  LoadingTranscript = 'loading-transcript',
  PreparingViewport = 'preparing-viewport',
  Visible = 'visible',
  Warm = 'warm',
  Failed = 'failed',
}

export interface AgentChatPresentation {
  generation: number;
  phase: AgentChatPresentationPhase;
}

export function dormantChatPresentation(): AgentChatPresentation {
  return { generation: 0, phase: AgentChatPresentationPhase.Dormant };
}

export function requestChatPresentation(
  current: AgentChatPresentation,
  readiness: AgentTranscriptReadiness,
  generation: number,
): AgentChatPresentation {
  if (current.phase === AgentChatPresentationPhase.Warm) {
    return { ...current, phase: AgentChatPresentationPhase.Visible };
  }
  if (chatPresentationRequested(current)) return current;
  return {
    generation,
    phase:
      readiness === 'usable'
        ? AgentChatPresentationPhase.PreparingViewport
        : readiness === 'failed'
        ? AgentChatPresentationPhase.Failed
        : AgentChatPresentationPhase.LoadingTranscript,
  };
}

export function updateChatTranscriptReadiness(
  current: AgentChatPresentation,
  readiness: AgentTranscriptReadiness,
  resetGeneration: number,
): AgentChatPresentation {
  if (readiness === 'usable') {
    return current.phase === AgentChatPresentationPhase.LoadingTranscript ||
      current.phase === AgentChatPresentationPhase.Failed
      ? { ...current, phase: AgentChatPresentationPhase.PreparingViewport }
      : current;
  }
  if (readiness === 'failed') {
    return chatPresentationRequested(current)
      ? { ...current, phase: AgentChatPresentationPhase.Failed }
      : current.phase === AgentChatPresentationPhase.Warm
      ? {
          generation: resetGeneration,
          phase: AgentChatPresentationPhase.Dormant,
        }
      : current;
  }
  if (
    current.phase === AgentChatPresentationPhase.Visible ||
    current.phase === AgentChatPresentationPhase.PreparingViewport
  ) {
    return {
      generation: resetGeneration,
      phase: AgentChatPresentationPhase.LoadingTranscript,
    };
  }
  if (current.phase === AgentChatPresentationPhase.Warm) {
    return {
      generation: resetGeneration,
      phase: AgentChatPresentationPhase.Dormant,
    };
  }
  return current;
}

export function revealPreparedChat(
  current: AgentChatPresentation,
  generation: number,
): AgentChatPresentation {
  return current.generation === generation &&
    current.phase === AgentChatPresentationPhase.PreparingViewport
    ? { ...current, phase: AgentChatPresentationPhase.Visible }
    : current;
}

export function closeChatPresentation(
  current: AgentChatPresentation,
): AgentChatPresentation {
  if (current.phase === AgentChatPresentationPhase.Visible) {
    return { ...current, phase: AgentChatPresentationPhase.Warm };
  }
  if (
    current.phase === AgentChatPresentationPhase.LoadingTranscript ||
    current.phase === AgentChatPresentationPhase.PreparingViewport ||
    current.phase === AgentChatPresentationPhase.Failed
  ) {
    return { ...current, phase: AgentChatPresentationPhase.Dormant };
  }
  return current;
}

export function chatPresentationRequested(
  presentation: AgentChatPresentation,
): boolean {
  return (
    presentation.phase === AgentChatPresentationPhase.LoadingTranscript ||
    presentation.phase === AgentChatPresentationPhase.PreparingViewport ||
    presentation.phase === AgentChatPresentationPhase.Visible
  );
}

export function chatPresentationLoading(
  presentation: AgentChatPresentation | undefined,
): boolean {
  return (
    presentation?.phase === AgentChatPresentationPhase.LoadingTranscript ||
    presentation?.phase === AgentChatPresentationPhase.PreparingViewport
  );
}

export function chatPresentationMountsViewport(
  presentation: AgentChatPresentation,
): boolean {
  return (
    presentation.phase === AgentChatPresentationPhase.PreparingViewport ||
    presentation.phase === AgentChatPresentationPhase.Visible ||
    presentation.phase === AgentChatPresentationPhase.Warm
  );
}

export function chatPresentationVisible(
  presentation: AgentChatPresentation | undefined,
): boolean {
  return presentation?.phase === AgentChatPresentationPhase.Visible;
}
