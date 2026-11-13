import { nativeVoiceSessions, voiceSourceIdentity } from './voiceSession';
import { AgentTranscriptKind, VoiceChat, VoiceChatPhase } from './generated-entry';
import type { RuntimeAgentKind } from './index';
import type { TerminalSubmissionQueue } from './generated-entry';
import type { VoiceTranscriptEntry } from '../../../src/lib/voiceTranscript';

export type LocalVoiceSource = { runtimeId: string; incarnation: bigint; terminalId: string; paneId: string; agent: RuntimeAgentKind; queue: TerminalSubmissionQueue; targetKey: string };
const AGENT = { claude: AgentTranscriptKind.Claude, codex: AgentTranscriptKind.Codex, opencode: AgentTranscriptKind.OpenCode, pi: AgentTranscriptKind.Pi } as const;
const EFFECT_VERSION = 1;
export type VoiceSpeechEffect =
  | { type: 'start'; token: string; filler: boolean }
  | { type: 'stop'; token: string }
  | { type: 'speak'; token: string; chunk: string; filler: boolean; text: string; messageId: string; partId: string; startUtf16: number };

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

/** Marshals the stable native API. voice-call-local owns turn policy; Whip's Rust adapter correlates transcripts. */
export class NativeVoiceChat {
  private readonly core: VoiceChat;
  constructor(root: string) { this.core = new VoiceChat(root); }
  bindSession(id: string, source: LocalVoiceSource) { nativeVoiceSessions().bindLocal(id, this.core, JSON.stringify(voiceSourceIdentity(source))); }
  view() {
    const view = this.core.view();
    const totalBytes = Number(view.totalBytes);
    const events = JSON.parse(view.eventsJson ?? '[]') as VoiceTranscriptEntry[];
    return { ...view, events, phase: PHASE[view.phase], progress: totalBytes > 0 ? Number(view.downloadedBytes) / totalBytes : 0 };
  }
  async prepare(install: boolean) { await this.core.prepare(install); }
  beginPreparation() { this.core.beginPreparation(); }
  useVad() { this.core.useVad(); }
  setVadSensitivity(value: number) { this.core.setVadSensitivity(value); }
  openAudioCapture(input: bigint) { return this.core.openAudioCapture(input); }
  closeAudioCapture(handle: bigint) { this.core.closeAudioCapture(handle); }
  audio(input: bigint, pcm: string) { this.core.audio(input, pcm); }
  async analyze(input: bigint) { await this.core.analyze(input); }
  finish() { this.core.finish(); }
  recognition(input: bigint, text: string) { this.core.recognition(input, text); }
  playbackText(token: string, text: string, active: boolean) { this.core.playbackEvent(token, text, active); }
  ended(input: bigint) { this.core.recognitionEnded(input); }
  submitText(text: string) { this.core.submitText(text); }
  connect(source: LocalVoiceSource, changed: () => void, playbackCapacity: number) {
    this.core.connect(source.runtimeId, source.incarnation, source.terminalId, source.paneId, source.queue, source.targetKey, { changed }, playbackCapacity, AGENT[source.agent]);
  }
  takeEffects(): VoiceSpeechEffect[] {
    const effects = JSON.parse(this.core.takeEffects()) as (VoiceSpeechEffect & { version: number })[];
    if (effects.some(effect => effect.version !== EFFECT_VERSION)) throw new Error('Unsupported Local voice effect version. Install a matching Whip build.');
    return effects;
  }
  playbackCurrent(token: string) { return this.core.playbackCurrent(token); }
  acknowledgeSpeech(token: string, chunk: string, event: 'started' | 'played' | 'failed' | 'stopped') {
    this.core.acknowledgeSpeech(token, BigInt(chunk), event);
  }
  skipResponse() { this.core.skipResponse(); }
  setMuted(muted: boolean) { this.core.setMuted(muted); }
  close() { this.core.close(); }
  dispose() { this.core.uniffiDestroy(); }
}

export type VoiceChatView = ReturnType<NativeVoiceChat['view']>;
