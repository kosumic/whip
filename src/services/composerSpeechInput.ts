import { AppState, Platform } from 'react-native';
import type { NativeComposerDictation, ComposerDictationPhase } from 'react-native-whip-ssh/src/composerDictation';

import { setSpeechInputActive } from './speechInputFocus';

type Recognizer = Pick<typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule,
  'addListener' | 'start' | 'stop' | 'abort' | 'isRecognitionAvailable' | 'requestPermissionsAsync'>;
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
  recognizer?: Recognizer;
  subscriptions: Subscription[];
  started: boolean;
  cancelled: boolean;
  receivedFinal?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}

const IDLE: SpeechInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
const CONTEXT_TIMEOUT_MS = 1_500;
const FINAL_RESULT_TIMEOUT_MS = 10_000;
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

  constructor(private readonly load = loadDependencies) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): SpeechInputSnapshot => this.snapshot;

  async start(request: Request): Promise<void> {
    if (this.current || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
    const session: Session = { request, subscriptions: [], started: false, cancelled: false };
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
      session.recognizer = recognizer;
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
          clearTimeout(session.timeout);
          session.core!.listening();
          this.refresh(session);
        }),
        recognizer.addListener('result', event => {
          if (this.current !== session || session.cancelled) return;
          const final = session.core!.result(event.results[0]?.transcript || '', event.isFinal);
          if (final) {
            session.receivedFinal = true;
            request.append(dependencies.append(request.readDraft(), final));
          }
          this.refresh(session);
        }),
        recognizer.addListener('error', event => {
          if (this.current !== session || session.cancelled || event.error === 'aborted') return;
          request.onError(ERROR_REASONS[event.error] || 'failed');
          // Keep ownership until end, which the native API emits after errors.
          session.cancelled = true;
          session.core!.end();
          this.publish({ owner: request.owner, phase: 'finishing', interimText: '' });
        }),
        recognizer.addListener('end', () => {
          if (this.current !== session) return;
          if (!session.cancelled && !session.receivedFinal) request.onError('noSpeech');
          this.release(session);
        }),
      );
      session.started = true;
      recognizer.start({
        lang: dependencies.locale,
        interimResults: true,
        maxAlternatives: 1,
        // Android continuous mode pipes a separate AudioRecord into the speech
        // service. Some providers accept the session but return empty segments.
        // Let the Android recognizer own the microphone and finish on a pause.
        continuous: Platform.OS === 'ios',
        contextualStrings: dependencies.context(request.draft, recent),
        iosTaskHint: 'dictation',
        recordingOptions: { persist: false },
      });
      session.timeout = setTimeout(() => {
        if (this.current !== session || this.snapshot.phase !== 'preparing') return;
        request.onError('failed');
        this.cancel(request.owner);
      }, FINAL_RESULT_TIMEOUT_MS);
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
    session.core!.finish();
    this.refresh(session);
    session.timeout = setTimeout(() => {
      if (this.current !== session) return;
      session.request.onError('failed');
      this.cancel(owner);
    }, FINAL_RESULT_TIMEOUT_MS);
    try { session.recognizer!.stop(); } catch { this.cancel(owner); }
  }

  cancel(owner: string): void {
    const session = this.current;
    if (session?.request.owner !== owner || session.cancelled) return;
    session.cancelled = true;
    session.core?.end();
    if (!session.started) {
      this.release(session);
      return;
    }
    clearTimeout(session.timeout);
    this.publish({ owner, phase: 'finishing', interimText: '' });
    try { session.recognizer!.abort(); } catch { this.release(session); }
  }

  private refresh(session: Session): void {
    if (this.current !== session || session.cancelled) return;
    this.publish({ owner: session.request.owner, ...session.core!.view() });
  }

  private release(session: Session): void {
    if (this.current !== session) return;
    this.current = null;
    clearTimeout(session.timeout);
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
