import type { TranscriptToolPart } from '../agentChat';
import { parseJsonToolOutput } from './toolOutput';

/** Shared by active calls, native event adapters and saved voice chats. */
export interface VoiceTranscriptEvent {
  kind: 'delegation' | 'tool';
  name: string;
  status: string;
  input?: string;
  output?: string;
}

export interface VoiceTranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  event?: VoiceTranscriptEvent | null;
}

export interface VoiceTranscriptMessage extends VoiceTranscriptEntry {
  /** Estimated native playback cursor; absent from durable transcript data. */
  spokenUtf16: number;
  active: boolean;
}

/** Adapt the compact voice event to the shared chat tool presentation. */
export function voiceToolPart(id: string, event: VoiceTranscriptEvent): TranscriptToolPart {
  const parsed = event.input ? parseJsonToolOutput(event.input)?.value : undefined;
  const input: TranscriptToolPart['state']['input'] = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') input[key] = value;
    }
  }
  const status = event.status === 'failed' || event.status === 'error' ? 'error'
    : event.status === 'pending' || event.status === 'requested' ? 'pending'
    : event.status === 'running' ? 'running' : 'completed';
  return {
    type: 'tool', id, callId: id, tool: event.name,
    state: {
      status, input, inputJson: event.input, title: event.status.replaceAll('_', ' '),
      output: status === 'error' ? undefined : event.output,
      error: status === 'error' ? event.output : undefined,
      files: [], diagnostics: [], loaded: [],
    },
  };
}
