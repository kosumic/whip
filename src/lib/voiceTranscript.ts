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
