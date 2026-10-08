import type {
  NativeAgentFileDiff,
  NativeAgentQuestion,
  NativeAgentToolDiagnostic,
  NativeAgentToolState,
  NativeAgentTranscriptInfo,
  NativeAgentTranscriptMessage,
  NativeAgentTranscriptPart,
} from 'react-native-whip-ssh';

export type TranscriptFileDiff = NativeAgentFileDiff;
export type TranscriptQuestion = NativeAgentQuestion;
export type TranscriptToolDiagnostic = NativeAgentToolDiagnostic;
export type TranscriptToolState = NativeAgentToolState;
export type TranscriptPart = NativeAgentTranscriptPart;
export type TranscriptMessage = NativeAgentTranscriptMessage;
export type TranscriptToolPart = Extract<TranscriptPart, { type: 'tool' }>;

export interface TranscriptTurn {
  id: string;
  user?: TranscriptMessage;
  assistants: TranscriptMessage[];
  status: 'idle' | 'working' | 'interrupted' | 'error';
  startedAt?: number;
  completedAt?: number;
  diffs: TranscriptFileDiff[];
}

export interface AgentTranscript {
  sessionId: string;
  info?: NativeAgentTranscriptInfo;
  messages: TranscriptMessage[];
  turns: TranscriptTurn[];
}

export type AgentChatConnectionStatus =
  | 'loading'
  | 'live'
  | 'stale'
  | 'unavailable'
  | 'error'
  | 'closed';

export interface AgentChatState {
  sessionId: string;
  transcript: AgentTranscript;
  revision?: number;
  status: AgentChatConnectionStatus;
  error?: string;
}

export function emptyTranscript(sessionId: string): AgentTranscript {
  return { sessionId, messages: [], turns: [] };
}
