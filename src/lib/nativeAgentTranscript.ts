import type {
  NativeAgentTranscriptState,
  NativeAgentTranscriptTurn,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import type {
  AgentChatState,
  AgentTranscript,
  TranscriptMessage,
  TranscriptTurn,
} from '../agentChat';

const nativeMessageIndexes = new WeakMap<AgentChatState, Map<string, TranscriptMessage>>();

function turn(value: NativeAgentTranscriptTurn, byId: ReadonlyMap<string, TranscriptMessage>): TranscriptTurn {
  return {
    id: value.id,
    user: value.userMessageId ? byId.get(value.userMessageId) : undefined,
    assistants: value.assistantMessageIds.flatMap(id => {
      const current = byId.get(id);
      return current ? [current] : [];
    }),
    messages: value.messageIds?.length ? value.messageIds.flatMap(id => {
      const current = byId.get(id);
      return current ? [current] : [];
    }) : undefined,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    diffs: value.diffs,
    details: value.details,
  };
}

/** Mechanical typed-FFI projection into the existing presentation model. */
export function agentChatStateFromNative(value: NativeAgentTranscriptState): AgentChatState {
  const messages = value.messages;
  const byId = new Map(messages.map(current => [current.id, current]));
  const turns = value.turns.map(nativeTurn => turn(nativeTurn, byId));
  const transcript: AgentTranscript = {
    sessionId: value.sessionId,
    info: value.info,
    messages,
    turns,
  };
  const state: AgentChatState = {
    sessionId: value.sessionId,
    transcript,
    revision: value.revision,
    status: value.status,
    error: value.error,
  };
  nativeMessageIndexes.set(state, byId);
  return state;
}

/** Applies one contiguous native revision while retaining all untouched objects. */
export function applyNativeAgentTranscriptUpdate(
  current: AgentChatState,
  update: NativeAgentTranscriptUpdate,
): AgentChatState | null {
  const revision = current.revision;
  if (revision !== undefined && update.revision <= revision) return current;
  const reset = update.deltas.find(delta => delta.type === 'reset');
  if (reset?.type === 'reset') {
    const next = agentChatStateFromNative(reset.state);
    next.revision = update.revision;
    for (const delta of update.deltas) {
      if (delta.type === 'status-changed') {
        next.status = delta.status;
        next.error = delta.error;
      }
    }
    return next;
  }
  if (revision === undefined || update.revision !== revision + 1) return null;

  let messages = current.transcript.messages;
  let turns = current.transcript.turns;
  let transcriptInfo = current.transcript.info;
  let status = current.status;
  let error = current.error;
  const byId = nativeMessageIndexes.get(current)
    || new Map(messages.map(value => [value.id, value]));
  let messagesChanged = false;
  let turnsChanged = false;
  const mutableMessages = () => {
    if (!messagesChanged) {
      messages = [...messages];
      messagesChanged = true;
    }
    return messages;
  };
  const mutableTurns = () => {
    if (!turnsChanged) {
      turns = [...turns];
      turnsChanged = true;
    }
    return turns;
  };

  for (const delta of update.deltas) {
    switch (delta.type) {
      case 'reset': break;
      case 'info-changed':
        transcriptInfo = delta.info;
        break;
      case 'message-upserted': {
        const values = mutableMessages();
        if (delta.index > values.length) return null;
        if (delta.index < values.length && values[delta.index].id !== delta.message.id) return null;
        const next = delta.message;
        if (delta.index === values.length) values.push(next);
        else values[delta.index] = next;
        byId.set(next.id, next);
        break;
      }
      case 'message-removed': {
        const values = mutableMessages();
        if (values[delta.index]?.id !== delta.messageId) return null;
        values.splice(delta.index, 1);
        byId.delete(delta.messageId);
        break;
      }
      case 'messages-truncated': {
        const values = mutableMessages();
        if (delta.length > values.length) return null;
        for (const removed of values.slice(delta.length)) byId.delete(removed.id);
        values.length = delta.length;
        break;
      }
      case 'turn-upserted': {
        const values = mutableTurns();
        if (delta.index > values.length) return null;
        if (delta.index < values.length && values[delta.index].id !== delta.turn.id) return null;
        const next = turn(delta.turn, byId);
        if (delta.index === values.length) values.push(next);
        else values[delta.index] = next;
        break;
      }
      case 'turns-truncated': {
        const values = mutableTurns();
        if (delta.length > values.length) return null;
        values.length = delta.length;
        break;
      }
      case 'status-changed':
        status = delta.status;
        error = delta.error;
        break;
    }
  }

  const next: AgentChatState = {
    sessionId: current.sessionId,
    revision: update.revision,
    status,
    error,
    transcript: {
      sessionId: current.transcript.sessionId,
      info: transcriptInfo,
      messages,
      turns,
    },
  };
  nativeMessageIndexes.set(next, byId);
  return next;
}
