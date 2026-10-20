import { AppState, Platform } from 'react-native';
import type { NativeComposerDictation, ComposerDictationPhase } from 'react-native-whip-ssh/src/composerDictation';

import { setSpeechInputActive } from './speechInputFocus';

type Recognizer = Pick<typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule,
  'addListener' | 'start' | 'stop' | 'abort' | 'isRecognitionAvailable' | 'requestPermissionsAsync'>;
type RecognitionOptions = Parameters<Recognizer['start']>[0];
type Subscription = { remove: () => void };
export type SpeechInputError = 'permission' | 'unavailable' | 'noSpeech' | 'network' | 'interrupted' | 'failed';
export interface SpeechInputSnapshot {
  owner: string | null;
  phase: ComposerDictationPhase;
  interimText: string;
}
interface Request {
  owner: string;
  draft: string;
  readDraft: () => string;
  context: () => Promise<string[]>;
  append: (text: string) => void;
  onError: (error: SpeechInputError) => void;
}
interface Dependencies {
  recognizer: Recognizer;
  createCore: () => NativeComposerDictation;
  context: (draft: string, recent: string[]) => string[];
  append: (draft: string, text: string) => string;
  locale: string;
  suspendPlayback: () => Promise<void>;
}
interface Session {
  request: Request;
  core?: NativeComposerDictation;
  dependencies?: Dependencies;
  options?: RecognitionOptions;
  android: boolean;
  subscriptions: Subscription[];
  /** A native cycle is in flight, including its terminal event drain. */
  started: boolean;
  cancelled: boolean;
  stopping: boolean;
  ending: boolean;
  receivedFinal?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  restart?: ReturnType<typeof setTimeout>;
  restartDelay: number;
}

const IDLE: SpeechInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
const CONTEXT_TIMEOUT_MS = 1_500;
const FINAL_RESULT_TIMEOUT_MS = 10_000;
const ANDROID_CONTINUOUS_API = 33;
// Yield after end so Expo can finish tearing down the previous recognizer.
// Back off empty cycles without imposing a limit on how long users can pause.
const RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 2_000;
const EMPTY_ERRORS = new Set(['no-speech', 'speech-timeout']);
const CONTINUOUS_ERRORS = new Set(['client', 'audio-capture']);
const ERROR_REASONS: Record<string, SpeechInputError> = {
  'not-allowed': 'permission',
  'service-not-allowed': 'unavailable',
  'language-not-supported': 'unavailable',
  'no-speech': 'noSpeech',
  'speech-timeout': 'noSpeech',
  network: 'network',
  interrupted: 'interrupted',
};

async function loadDependencies(): Promise<Dependencies> {
  // Loading on demand also lets older development builds report an unavailable
  // recognizer instead of failing while opening the terminal.
  const [speech, native, localization, playback] = await Promise.all([
    import('expo-speech-recognition'),
    import('react-native-whip-ssh/src/composerDictation'),
    import('expo-localization'),
    import('./chatSpeech'),
  ]);
  return {
    recognizer: speech.ExpoSpeechRecognitionModule,
    createCore: () => new native.NativeComposerDictation(),
    context: native.composerDictationContext,
    append: native.appendComposerDictation,
    locale: localization.getLocales()[0]?.languageTag || 'en-US',
    suspendPlayback: playback.suspendChatSpeechForInput,
  };
}

async function boundedContext(read: () => Promise<string[]>): Promise<string[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => []),
      new Promise<string[]>(resolve => { timeout = setTimeout(() => resolve([]), CONTEXT_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** One microphone owner. A cancelled native session drains its end event before
 * another owner can start, since Expo's recognition events have no session ID. */
export class ComposerSpeechInput {
  private current: Session | null = null;
  private snapshot: SpeechInputSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private androidContinuousFailed = false;

  constructor(private readonly load = loadDependencies) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): SpeechInputSnapshot => this.snapshot;

  async start(request: Request): Promise<void> {
    if (this.current || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
    const session: Session = {
      request, subscriptions: [], android: Platform.OS === 'android',
      started: false, cancelled: false, stopping: false, ending: false,
      restartDelay: RESTART_DELAY_MS,
    };
    this.current = session;
    this.publish({ owner: request.owner, phase: 'preparing', interimText: '' });
    session.subscriptions.push(AppState.addEventListener('change', state => {
      if (state === 'background') this.cancel(request.owner);
    }));
    // Freeze view context at the tap, alongside the existing draft.
    const context = boundedContext(request.context);
    try {
      const dependencies = await this.load();
      if (this.current !== session) return;
      const { recognizer } = dependencies;
      if (!recognizer.isRecognitionAvailable()) {
        request.onError('unavailable');
        this.release(session);
        return;
      }
      session.dependencies = dependencies;
      session.core = dependencies.createCore();
      session.core.begin();
      const permission = await recognizer.requestPermissionsAsync();
      if (this.current !== session) return;
      if (!permission.granted) {
        request.onError('permission');
        this.release(session);
        return;
      }
      const recent = await context;
      if (this.current !== session) return;
      const stoppedPlayback = dependencies.suspendPlayback();
      setSpeechInputActive(true);
      await stoppedPlayback;
      if (this.current !== session) return;
      session.subscriptions.push(
        recognizer.addListener('start', () => {
          if (this.current !== session || session.cancelled) return;
          if (session.ending || session.stopping) return;
          clearTimeout(session.timeout);
          session.core!.listening();
          this.refresh(session);
        }),
        recognizer.addListener('result', event => {
          if (this.current !== session || session.cancelled || session.ending) return;
          const text = event.results[0]?.transcript || '';
          if (text.trim()) session.restartDelay = RESTART_DELAY_MS;
          else if (event.isFinal && this.fallback(session)) return;
          const final = session.core!.result(text, event.isFinal);
          if (final) {
            session.receivedFinal = true;
            this.append(session, final);
          }
          this.refresh(session);
        }),
        recognizer.addListener('nomatch', () => {
          if (this.current !== session || session.cancelled || session.ending) return;
          this.fallback(session);
        }),
        recognizer.addListener('error', event => {
          if (this.current !== session || session.cancelled || session.ending) return;
          session.ending = true;
          if (!session.stopping) clearTimeout(session.timeout);
          if (session.android && !session.stopping &&
              (EMPTY_ERRORS.has(event.error) ||
                (session.options!.continuous && CONTINUOUS_ERRORS.has(event.error)))) {
            this.disableContinuous(session);
            return;
          }
          if (!session.stopping || !EMPTY_ERRORS.has(event.error)) {
            request.onError(ERROR_REASONS[event.error] || 'failed');
          }
          // Keep ownership until end, which the native API emits after errors.
          // A manual stop still drains its pending hypothesis on error.
          if (!session.stopping) {
            session.cancelled = true;
            session.core!.end();
            this.publish({ owner: request.owner, phase: 'finishing', interimText: '' });
          }
        }),
        recognizer.addListener('end', () => {
          if (this.current !== session || !session.started) return;
          session.started = false;
          session.ending = true;
          clearTimeout(session.timeout);
          if (session.android && !session.cancelled && !session.stopping) {
            // Includes providers which ignore segmented mode and end after one
            // utterance, and empty sessions from unsupported injected audio.
            this.disableContinuous(session);
            session.restart = setTimeout(() => {
              if (this.current !== session || session.cancelled || session.stopping) return;
              session.core!.result('', false);
              this.startRecognition(session);
            }, session.restartDelay);
            session.restartDelay = Math.min(session.restartDelay * 2, MAX_RESTART_DELAY_MS);
            return;
          }
          if (!session.cancelled && !session.stopping && !session.receivedFinal) request.onError('noSpeech');
          this.release(session);
        }),
      );
      session.options = {
        lang: dependencies.locale,
        interimResults: true,
        maxAlternatives: 1,
        continuous: !session.android ||
          (Number(Platform.Version) >= ANDROID_CONTINUOUS_API && !this.androidContinuousFailed),
        contextualStrings: dependencies.context(request.draft, recent),
        iosTaskHint: 'dictation',
        recordingOptions: { persist: false },
      };
      this.startRecognition(session);
    } catch {
      if (this.current !== session) return;
      request.onError(session.core ? 'failed' : 'unavailable');
      if (session.started) this.cancel(request.owner);
      else this.release(session);
    }
  }

  stop(owner: string): void {
    const session = this.current;
    if (session?.request.owner !== owner || this.snapshot.phase !== 'listening') return;
    session.stopping = true;
    session.core!.finish();
    this.refresh(session);
    clearTimeout(session.restart);
    if (!session.started) {
      this.release(session);
      return;
    }
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => {
      if (this.current !== session) return;
      this.fail(session);
    }, FINAL_RESULT_TIMEOUT_MS);
    if (!session.ending) {
      try { session.dependencies!.recognizer.stop(); } catch { this.fail(session); }
    }
  }

  cancel(owner: string): void {
    const session = this.current;
    if (session?.request.owner !== owner || session.cancelled) return;
    session.cancelled = true;
    session.core?.end();
    clearTimeout(session.restart);
    if (!session.started) {
      this.release(session);
      return;
    }
    clearTimeout(session.timeout);
    this.publish({ owner, phase: 'finishing', interimText: '' });
    try { session.dependencies!.recognizer.abort(); } catch { this.release(session); }
  }

  private startRecognition(session: Session): void {
    session.started = true;
    session.ending = false;
    // This guards missing native startup/final events, never listening silence.
    session.timeout = setTimeout(() => {
      if (this.current !== session || session.cancelled || session.ending) return;
      if (!this.fallback(session)) this.fail(session);
    }, FINAL_RESULT_TIMEOUT_MS);
    try { session.dependencies!.recognizer.start({ ...session.options! }); } catch {
      if (!this.fallback(session)) this.fail(session);
    }
  }

  /** Downgrade the injected-audio path once, then let the service own the mic.
   * Restart only after end: Expo's events do not carry native session IDs. */
  private fallback(session: Session): boolean {
    if (!session.android || !session.options!.continuous || session.stopping) return false;
    this.disableContinuous(session);
    session.ending = true;
    clearTimeout(session.timeout);
    try { session.dependencies!.recognizer.abort(); } catch { this.fail(session); }
    return true;
  }

  private disableContinuous(session: Session): void {
    if (!session.options!.continuous) return;
    session.options!.continuous = false;
    this.androidContinuousFailed = true;
  }

  private fail(session: Session): void {
    session.request.onError('failed');
    if (session.stopping) this.append(session, session.core!.end());
    this.cancel(session.request.owner);
  }

  private append(session: Session, text: string | undefined): void {
    if (text) session.request.append(session.dependencies!.append(session.request.readDraft(), text));
  }

  private refresh(session: Session): void {
    if (this.current !== session || session.cancelled) return;
    this.publish({ owner: session.request.owner, ...session.core!.view() });
  }

  private release(session: Session): void {
    if (this.current !== session) return;
    if (!session.cancelled) this.append(session, session.core?.end());
    this.current = null;
    clearTimeout(session.timeout);
    clearTimeout(session.restart);
    for (const subscription of session.subscriptions) subscription.remove();
    session.core?.dispose();
    setSpeechInputActive(false);
    this.publish(IDLE);
  }

  private publish(snapshot: SpeechInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const composerSpeechInput = new ComposerSpeechInput();
