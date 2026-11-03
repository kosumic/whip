import { AgentTranscriptKind, VoiceChat, VoiceChatPhase } from './generated-entry';
import type { AgentChatState } from '../../../src/agentChat';
import type { RuntimeAgentKind } from './index';
import { speechMessages } from './chatSpeech';

const AGENT = {
  claude: AgentTranscriptKind.Claude,
  codex: AgentTranscriptKind.Codex,
  opencode: AgentTranscriptKind.OpenCode,
  pi: AgentTranscriptKind.Pi,
} as const;
const PHASE = {
  [VoiceChatPhase.Setup]: 'setup',
  [VoiceChatPhase.Preparing]: 'preparing',
  [VoiceChatPhase.Listening]: 'listening',
  [VoiceChatPhase.Finishing]: 'finishing',
  [VoiceChatPhase.Waiting]: 'waiting',
  [VoiceChatPhase.Speaking]: 'speaking',
  [VoiceChatPhase.Muted]: 'muted',
  [VoiceChatPhase.Closed]: 'closed',
} as const;

/** Only marshaling lives here. Rust owns turn boundaries and transcript correlation. */
export class NativeVoiceChat {
  private readonly core: VoiceChat;
  private transcriptSession?: string;
  constructor(root: string) { this.core = new VoiceChat(root); }
  view() {
    const view = this.core.view();
    return { ...view, phase: PHASE[view.phase], progress: Number(view.downloadedBytes) / Number(view.totalBytes) };
  }
  async prepare(install: boolean) { await this.core.prepare(install); }
  beginPreparation() { this.core.beginPreparation(); }
  useVad() { this.core.useVad(); }
  setVadSensitivity(value: number) { this.core.setVadSensitivity(value); }
  audio(input: bigint, pcm: string) { this.core.audio(input, pcm); }
  async analyze(input: bigint) { await this.core.analyze(input); }
  finish() { this.core.finish(); }
  recognition(input: bigint, text: string) { this.core.recognition(input, text); }
  ended(input: bigint) { this.core.recognitionEnded(input); }
  takePrompt() { return this.core.takePrompt(); }
  submitText(text: string) { this.core.submitText(text); }
  transcript(agent: RuntimeAgentKind, state: AgentChatState, baseline: boolean) {
    // A resync snapshot and a brief "Agent activity resumed" stale status
    // still describe the same conversation. Only a session replacement resets
    // voice history; treating every snapshot as new history hangs up each turn.
    const replaced = this.transcriptSession !== undefined && this.transcriptSession !== state.sessionId;
    const initial = this.transcriptSession === undefined;
    const available = state.status === 'live' || state.status === 'stale' || state.status === 'loading';
    this.core.transcript(AGENT[agent], available, replaced || (initial && baseline), state.transcript.turns.map(turn => ({
      id: turn.id,
      userText: turn.user?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? '',
      // Idle can cover prompt acknowledgements and gaps between assistant
      // segments. Only the provider's final outcome completes the whole reply.
      completed: turn.status === 'idle' && turn.details?.outcome === 'completed',
      failed: turn.status === 'error' || turn.status === 'interrupted',
      messages: speechMessages(turn.assistants),
    })));
    this.transcriptSession = state.sessionId;
  }
  nextSpeech() { return this.core.nextSpeech(); }
  speechFinished() { return this.core.speechFinished(); }
  skipResponse() { this.core.skipResponse(); }
  playbackEnded() { this.core.playbackEnded(); }
  setMuted(muted: boolean) { this.core.setMuted(muted); }
  close() { this.core.close(); }
  dispose() { this.core.uniffiDestroy(); }
}

export type VoiceChatView = ReturnType<NativeVoiceChat['view']>;
