import { AppState, Platform } from 'react-native';
import type {
  ComposerDictationPhase, DictationAuthority, DictationCommand, DictationEffect,
  DictationEvent, DictationLifecycleView, DictationOutcome, DictationScope, DictationUpdate,
} from 'react-native-whip-ssh/src/composerDictation';

import { setSpeechInputActive } from './speechInputFocus';
import { settledPromise } from '../lib/promises';
import type { VoiceUsageEvent, VoiceHistoryCommand } from './voiceUsage';
import type { OpenAiSpeechCapture } from './openAiSpeechInput';

type Recognizer = Pick<typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule,
  'addListener' | 'start' | 'stop' | 'abort' | 'isRecognitionAvailable' | 'getStateAsync'> & {
    requestPermissionsAsync: () => Promise<{ granted: boolean }>;
    getPermissionsAsync: () => Promise<{ granted: boolean }>;
  } &
  Partial<Pick<typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule,
    'supportsOnDeviceRecognition' | 'supportsAudioChunkEvents' | 'supportsNativeAudioIngress' | 'supportsEchoCancellation'>>;
type Subscription = { remove: () => void };
export type SpeechInputError = 'permission' | 'unavailable' | 'noSpeech' | 'network' | 'interrupted' | 'failed';
export interface SpeechInputSnapshot {
  owner: string | null;
  phase: ComposerDictationPhase;
  interimText: string;
}
interface Request {
  owner: string;
  provider?: 'local' | 'openai';
  draft: string;
  readDraft: () => string;
  context: () => Promise<string[]>;
  append: (text: string) => void;
  onError: (error: SpeechInputError, message?: string) => void;
  localOnly?: boolean;
  managedCall?: boolean;
  duringPlayback?: boolean;
  onAudio?: (pcm: string) => void;
  audioCapture?: { open: () => string; close: (handle: string) => void };
}
interface Dependencies {
  recognizer: Recognizer;
  append: (draft: string, text: string) => string;
  locale: string;
  suspendPlayback: () => Promise<void>;
  createOpenAiCapture?: () => OpenAiSpeechCapture;
}
/** Adapter resources only. Admission, phases, result draining and deadlines live in Rust. */
interface Session {
  request: Request;
  dependencies?: Dependencies;
  cloud?: OpenAiSpeechCapture;
  subscriptions: Subscription[];
  audioHandle?: string;
  epoch: string;
  ready: () => void;
  history?: { id: string; startedAt: number; fragments: string[] };
}
const IDLE: SpeechInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
const MAX_HISTORY_FRAGMENTS = 64;
const MAX_HISTORY_TEXT = 16 * 1024;
const ANDROID_CONTINUOUS_API = 33;
const LOCAL_UNAVAILABLE = 'This build or device does not support on-device voice chat. Install an updated Whip build and an offline speech language.';

function recordSpeechHistory(event: VoiceUsageEvent | VoiceHistoryCommand): void {
  try {
    const { voiceUsageLedger } = require('./voiceUsage') as typeof import('./voiceUsage');
    void settledPromise(voiceUsageLedger.record(event));
  } catch { /* History must not interrupt microphone ownership. */ }
}
async function loadDependencies(): Promise<Dependencies> {
  const [speech, native, localization, playback] = await Promise.all([
    import('expo-speech-recognition'), import('react-native-whip-ssh/src/composerDictation'),
    import('expo-localization'), import('./chatSpeech'),
  ]);
  return {
    recognizer: speech.ExpoSpeechRecognitionModule,
    append: native.appendComposerDictation,
    locale: localization.getLocales()[0]?.languageTag || 'en-US',
    suspendPlayback: playback.suspendChatSpeechForInput,
    createOpenAiCapture: () => {
      const { createOpenAiSpeechCapture } = require('./openAiSpeechInput') as typeof import('./openAiSpeechInput');
      return createOpenAiSpeechCapture();
    },
  };
}
function loadAuthority(): DictationAuthority {
  const { getDictationAuthority } = require('react-native-whip-ssh/src/composerDictation') as typeof import('react-native-whip-ssh/src/composerDictation');
  return getDictationAuthority();
}

export class ComposerSpeechInput {
  private authority?: DictationAuthority;
  private readonly sessions = new Map<string, Session>();
  private snapshot: SpeechInputSnapshot = IDLE;
  private view?: DictationLifecycleView;
  private readonly listeners = new Set<() => void>();
  private readonly effects: DictationEffect[] = [];
  private draining = false;

  constructor(private readonly load = loadDependencies, private readonly createAuthority = loadAuthority) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): SpeechInputSnapshot => this.snapshot;

  async authorizeLocal(): Promise<void> {
    const { recognizer } = await this.load();
    if (!this.supportsLocal(recognizer)) throw new Error(LOCAL_UNAVAILABLE);
    if (!(await recognizer.requestPermissionsAsync()).granted) throw new Error('Allow microphone access in Settings to use voice chat.');
  }
  async supportsPlaybackMonitoring(): Promise<boolean> {
    const { recognizer } = await this.load();
    return Platform.OS === 'ios' || recognizer.supportsEchoCancellation?.() === true;
  }
  private supportsLocal(recognizer: Recognizer): boolean {
    return Boolean(recognizer.supportsOnDeviceRecognition?.() && recognizer.supportsAudioChunkEvents?.() &&
      (Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version >= ANDROID_CONTINUOUS_API)));
  }
  private policy(): DictationAuthority {
    if (!this.authority) {
      this.authority = this.createAuthority();
      this.authority.setObserver({ changed: () => this.pump() });
    }
    return this.authority;
  }
  reserve(owner: string): boolean {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
    return this.send({ kind: 'reserve', owner });
  }
  releaseReservation(owner: string): void { if (this.authority) this.send({ kind: 'releaseReservation', owner }); }

  async start(request: Request): Promise<void> {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    try {
      const core = this.policy();
      const accepted = core.dispatch(JSON.stringify({ kind: 'begin', config: {
        owner: request.owner, draft: request.draft, android: Platform.OS === 'android', api: (Platform.OS === 'android' ? Platform.Version : 0),
        provider: request.provider ?? 'default', localOnly: Boolean(request.localOnly), managedCall: Boolean(request.managedCall),
        duringPlayback: Boolean(request.duringPlayback), nativeIngress: Boolean(request.audioCapture),
      } } satisfies DictationCommand));
      const update = JSON.parse(core.takeUpdate()) as DictationUpdate;
      if (!accepted || !update.view.generation) { this.consume(update); return; }
      let ready!: () => void;
      const prepared = new Promise<void>(resolve => { ready = resolve; });
      this.sessions.set(update.view.generation, { request, subscriptions: [], epoch: update.view.epoch, ready });
      this.consume(update);
      await prepared;
    } catch {
      request.onError('unavailable');
    }
  }
  stop(owner: string): void { if (this.authority) this.send({ kind: 'stop', owner }); }
  cancel(owner: string): void { if (this.authority) this.send({ kind: 'cancel', owner }); }

  private send(command: DictationCommand): boolean {
    const accepted = this.policy().dispatch(JSON.stringify(command));
    this.pump();
    return accepted;
  }
  private pump(): void {
    if (this.authority) this.consume(JSON.parse(this.authority.takeUpdate()) as DictationUpdate);
  }
  private consume(update: DictationUpdate): void {
    this.view = update.view;
    const { owner, phase, interimText, active } = update.view;
    this.effects.push(...update.effects);
    setSpeechInputActive(active);
    const changed = owner !== this.snapshot.owner || phase !== this.snapshot.phase || interimText !== this.snapshot.interimText;
    this.snapshot = { owner, phase, interimText };
    if (changed) for (const listener of this.listeners) listener();
    if (this.draining) return;
    this.draining = true;
    try {
      let effect: DictationEffect | undefined;
      while ((effect = this.effects.shift())) this.execute(effect);
    } finally { this.draining = false; }
  }
  private acknowledge(scope: DictationScope, outcome: DictationOutcome): void {
    const { id, generation, epoch } = scope;
    this.send({ id, generation, epoch, kind: 'ack', outcome });
  }
  private event(generation: string, session: Session, event: DictationEvent): void {
    // These are adapter cycle labels, not native event IDs. Rust also requires
    // start admission and an observed idle/quiet boundary between native cycles.
    this.send({ kind: 'event', generation, epoch: session.epoch, event });
  }
  private execute(effect: DictationEffect): void {
    const session = this.sessions.get(effect.generation);
    if (!session) return;
    const { request } = session;
    const notify = ['closeCapture', 'publishDraftAppend', 'reportError', 'release'].includes(effect.action);
    const { id, generation, epoch } = effect;
    if (!notify && !this.policy().dispatch(JSON.stringify({ id, generation, epoch, kind: 'execute' } satisfies DictationCommand))) { this.pump(); return; }
    try {
      switch (effect.action) {
        case 'load': {
          session.subscriptions.push(AppState.addEventListener('change', state => {
            if (state === 'background') this.send({ kind: 'background' });
          }));
          this.complete(effect, async () => {
            const dependencies = await this.load();
            // Dependency loading may finish after cancellation. Don't attach
            // listeners or allocate capture resources for the retired generation.
            if (!this.sessions.has(effect.generation)) return { kind: 'done' };
            session.dependencies = dependencies;
            this.listen(effect.generation, session);
            const r = dependencies.recognizer;
            return { kind: 'loaded', available: r.isRecognitionAvailable(), localSupported: this.supportsLocal(r), ingressSupported: r.supportsNativeAudioIngress?.() === true };
          });
          break;
        }
        case 'readContext':
          this.complete(effect, async () => ({ kind: 'context', recent: await request.context().catch(() => []) }));
          break;
        case 'requestPermission':
          this.complete(effect, async () => ({ kind: 'permission', granted: (await (effect.existing
            ? session.dependencies!.recognizer.getPermissionsAsync() : session.dependencies!.recognizer.requestPermissionsAsync())).granted }));
          break;
        case 'suspendPlayback':
          this.complete(effect, async () => { await session.dependencies!.suspendPlayback(); return { kind: 'done' }; });
          break;
        case 'startRecognition': {
          session.epoch = effect.epoch;
          this.startHistory(session);
          this.closeCapture(session);
          // Opening a sink can fail before any native recognizer was started.
          try { session.audioHandle = request.audioCapture?.open(); }
          catch {
            this.acknowledge(effect, { kind: 'captureFailed' });
            break;
          }
          session.dependencies!.recognizer.start({
            lang: session.dependencies!.locale, interimResults: true, maxAlternatives: 1,
            continuous: effect.continuous, contextualStrings: effect.context, iosTaskHint: 'dictation', recordingOptions: { persist: false },
            ...(effect.onDevice ? { requiresOnDeviceRecognition: true } : {}),
            ...(request.localOnly ? { audioChunkEvents: true } : {}),
            ...(request.managedCall ? { iosAudioSessionManaged: true, iosVoiceProcessingEnabled: true } : {}),
            ...(effect.monitoring ? { androidEchoCancellation: true } : {}),
            ...(session.audioHandle ? { audioIngressHandle: session.audioHandle, audioChunkEvents: false } : {}),
            ...(request.onAudio ? { audioChunkToken: `${effect.generation}:${effect.epoch}` } : {}),
          });
          this.acknowledge(effect, { kind: 'done' });
          session.ready();
          break;
        }
        case 'startCloud':
          session.epoch = effect.epoch;
          session.cloud = session.dependencies!.createOpenAiCapture!();
          this.complete(effect, async () => {
            const granted = await session.cloud!.start(failed => this.event(effect.generation, session, { kind: 'cloudEnd', failed }));
            return { kind: 'cloudStarted', granted };
          }, session.ready);
          break;
        case 'finishCloud':
          this.complete(effect, async () => ({ kind: 'transcript', text: await session.cloud!.finish(request.draft, effect.recent) }));
          break;
        case 'cancelCloud':
          this.complete(effect, async () => { await session.cloud!.cancel(); return { kind: 'done' }; });
          break;
        case 'stop': session.dependencies!.recognizer.stop(); this.acknowledge(effect, { kind: 'done' }); break;
        case 'abort': session.dependencies!.recognizer.abort(); this.acknowledge(effect, { kind: 'done' }); break;
        case 'checkIdle':
          this.complete(effect, async () => ({ kind: 'idle', inactive: (await session.dependencies!.recognizer.getStateAsync()) === 'inactive' }));
          break;
        case 'closeCapture': this.closeCapture(session); break;
        case 'publishDraftAppend': this.append(session, effect.text); break;
        case 'reportError':
          request.onError(effect.error as SpeechInputError, ...(effect.message ? [effect.message] : []));
          session.ready();
          break;
        case 'release': this.release(effect.generation, session); break;
      }
    } catch (error) {
      this.acknowledge(effect, { kind: 'failed', error: error instanceof Error && error.message === 'network' ? 'network' : 'failed' });
      session.ready();
    }
  }
  private complete(scope: DictationScope, work: () => Promise<DictationOutcome>, finallyDo?: () => void): void {
    void work().then(outcome => this.acknowledge(scope, outcome), error => this.acknowledge(scope, {
      kind: 'failed', error: error instanceof Error && error.message === 'network' ? 'network' : 'failed',
    })).finally(finallyDo);
  }
  private listen(generation: string, session: Session): void {
    const r = session.dependencies!.recognizer;
    session.subscriptions.push(
      r.addListener('start', () => this.event(generation, session, { kind: 'start' })),
      r.addListener('result', e => this.event(generation, session, { kind: 'result', text: e.results[0]?.transcript || '', isFinal: e.isFinal })),
      r.addListener('nomatch', () => this.event(generation, session, { kind: 'noMatch' })),
      r.addListener('error', e => this.event(generation, session, { kind: 'error', error: e.error, message: e.message })),
      r.addListener('end', () => this.event(generation, session, { kind: 'end' })),
    );
    if (session.request.onAudio) session.subscriptions.push(r.addListener('audiochunk', e => {
      if (this.view?.generation === generation && this.view.acceptsAudio && e.token === `${generation}:${session.epoch}`) session.request.onAudio?.(e.pcm);
    }));
  }
  private startHistory(session: Session): void {
    if (session.request.managedCall || session.history) return;
    try {
      const { createSecureId } = require('../lib/secureId') as typeof import('../lib/secureId');
      session.history = { id: createSecureId('speech'), startedAt: Date.now(), fragments: [] };
      recordSpeechHistory({ kind: 'started', call: { session_id: session.history.id, provider: 'local', mode: 'stt', scope: 'speech', model: null, voice: null, started_at_ms: session.history.startedAt } });
    } catch { /* Recognition remains available if history cannot start. */ }
  }
  private append(session: Session, text: string): void {
    if (session.history) {
      session.history.fragments.push(Array.from(text).slice(0, MAX_HISTORY_TEXT).join(''));
      session.history.fragments = session.history.fragments.slice(-MAX_HISTORY_FRAGMENTS);
    }
    session.request.append(session.dependencies!.append(session.request.readDraft(), text));
  }
  private closeCapture(session: Session): void {
    const handle = session.audioHandle;
    session.audioHandle = undefined;
    if (handle) session.request.audioCapture?.close(handle);
  }
  private release(generation: string, session: Session): void {
    this.closeCapture(session);
    for (const subscription of session.subscriptions) subscription.remove();
    this.sessions.delete(generation);
    session.ready();
    if (session.history) {
      const { id, startedAt, fragments } = session.history;
      if (fragments.length) recordSpeechHistory({ kind: 'transcript', session_id: id, fragments: fragments.map((text, index) => ({ id: `${id}:${index}`, role: 'user', text })) });
      recordSpeechHistory({ kind: 'ended', session_id: id, ended_at_ms: Math.max(startedAt, Date.now()) });
    }
  }
}
export const composerSpeechInput = new ComposerSpeechInput();
