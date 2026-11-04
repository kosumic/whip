import { DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { CHAT_SPEECH_STOPPED, isChatResponsePlaying, registerAutomaticSpeech, type ChatSpeechStoppedEvent } from './chatSpeech';
import { isSpeechInputActive, subscribeSpeechInput } from './speechInputFocus';
import { setChatSpeechFocus } from './chatSpeechFocus';
import { getSpeechPlayback } from './speechPlayback';

const AUTOMATIC_OWNER = 'automatic-chat-speech';
const AUTOMATIC_FOCUS = 'WhipAutomaticSpeechFocus';
type Focus = { hostId?: string; paneId?: string };
type SpeechEvents = { [CHAT_SPEECH_STOPPED]: [event: ChatSpeechStoppedEvent]; [AUTOMATIC_FOCUS]: [event: Focus] };

export function setAutomaticChatSpeechEnabled(enabled: boolean): Promise<void> {
  return getSpeechPlayback().automaticSpeechControl('enable', enabled);
}

/** Attach controls/presentation to the process-owned Rust/native reader.
 * Detaching a React surface leaves playback and preferences with that reader.
 */
export function listenToAllTranscripts(onError: (error: unknown) => void): () => void {
  const native = getSpeechPlayback();
  const pause = () => native.automaticSpeechControl('pause', true);
  const resume = () => {
    if (!isSpeechInputActive() && !isChatResponsePlaying()) {
      void native.automaticSpeechControl('pause', false).catch(onError);
    }
  };
  const unregister = registerAutomaticSpeech({ pause, resume });
  const unsubscribeInput = subscribeSpeechInput(() => {
    if (isSpeechInputActive()) void pause().catch(onError);
    else resume();
  });
  const emitter: Pick<NativeEventEmitter<SpeechEvents>, 'addListener'> =
    Platform.OS === 'ios' ? new NativeEventEmitter<SpeechEvents>(native) : DeviceEventEmitter;
  const stopped = emitter.addListener(CHAT_SPEECH_STOPPED, event => {
    if (event.token === AUTOMATIC_OWNER && event.error) onError(new Error(event.error));
  });
  const focus = emitter.addListener(AUTOMATIC_FOCUS, event => {
    if (isChatResponsePlaying() || isSpeechInputActive()) return;
    setChatSpeechFocus(event.hostId && event.paneId ? { hostId: event.hostId, paneId: event.paneId } : null);
  });
  // Repeated enable calls preserve native Stop's silenced state. Only an explicit
  // off/on preference transition enables it again.
  void native.automaticSpeechControl('pause', isSpeechInputActive() || isChatResponsePlaying()).catch(onError);
  void setAutomaticChatSpeechEnabled(true).catch(onError);
  return () => {
    unregister();
    unsubscribeInput();
    stopped.remove();
    focus.remove();
  };
}
