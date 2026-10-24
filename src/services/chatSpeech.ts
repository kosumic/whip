import { DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { NativeChatSpeechQueue } from 'react-native-whip-ssh';

import type { TranscriptMessage } from '../agentChat';
import { agentTranscriptService } from './NativeTranscriptService';
import { reportBackgroundFailure } from './backgroundOperations';
import { setChatSpeechFocus } from './chatSpeechFocus';
import { setSpeechInputActive } from './speechInputFocus';
import { getSpeechPlayback } from './speechPlayback';

export interface ChatSpeechTarget {
  agent: 'claude' | 'codex' | 'opencode';
  bindingToken: string;
  hostId: string;
  paneId: string;
  label: string;
}

interface ListeningSession {
  target: ChatSpeechTarget;
  stop: () => void;
  silence: () => Promise<void>;
}

const CHAT_SPEECH_STOPPED = 'WhipChatSpeechStopped';
type ChatSpeechEvents = {
  [CHAT_SPEECH_STOPPED]: [event: { token: string; error?: string }];
};
let active: ListeningSession | null = null;
let generation = 0;

/** Wait for native playback to release its audio session before recording. */
export async function suspendChatSpeechForInput(): Promise<void> {
  const stopped = active?.silence();
  setSpeechInputActive(true);
  await Promise.all([stopped, getSpeechPlayback().stopSpeech()]);
}

/** One process-wide listener, independent of the chat viewport's lifecycle. */
export function listenToChat(
  target: ChatSpeechTarget,
  onStopped: () => void,
  onError: (error: unknown) => void,
): () => void {
  return startChatSpeech(target, onStopped, onError);
}

/** Read the selected response once, without subscribing to future replies. */
export function readChatResponse(
  target: ChatSpeechTarget,
  messages: readonly TranscriptMessage[],
  onStopped: () => void,
  onError: (error: unknown) => void,
): () => void {
  return startChatSpeech(target, onStopped, onError, messages);
}

function startChatSpeech(
  target: ChatSpeechTarget,
  onStopped: () => void,
  onError: (error: unknown) => void,
  messages?: readonly TranscriptMessage[],
): () => void {
  const native = getSpeechPlayback();
  const queue = new NativeChatSpeechQueue();
  if (messages && !queue.readResponse(target.agent, messages)) {
    queue.dispose();
    onStopped();
    return () => {};
  }
  active?.stop();
  const token = `${target.bindingToken}:${++generation}`;
  let stopped = false;
  let ready = false;
  let draining = false;
  let unsubscribe = () => {};
  let stoppedPlayback = Promise.resolve();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    subscription.remove();
    queue.dispose();
    if (active?.stop === stop) {
      active = null;
      setChatSpeechFocus(null);
    }
    stoppedPlayback = native.stopChatSpeech(token);
    reportBackgroundFailure(stoppedPlayback, 'chat-speech-stop');
    onStopped();
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    onError(error);
  };
  const emitter: Pick<NativeEventEmitter<ChatSpeechEvents>, 'addListener'> =
    Platform.OS === 'ios' ? new NativeEventEmitter<ChatSpeechEvents>(native) : DeviceEventEmitter;
  const subscription = emitter.addListener(CHAT_SPEECH_STOPPED, event => {
    if (event.token !== token || stopped) return;
    if (event.error) {
      fail(new Error(event.error));
      return;
    }
    stop();
  });
  active = { target, stop, silence: () => { stop(); return stoppedPlayback; } };
  setChatSpeechFocus(target);

  const drain = async () => {
    if (!ready || stopped || draining) return;
    draining = true;
    try {
      while (!stopped) {
        const text = queue.next();
        if (!text) break;
        await native.speakChat(token, text);
      }
      if (messages) stop();
    } catch (error) {
      fail(error);
    } finally {
      draining = false;
    }
  };

  if (!messages) {
    unsubscribe = agentTranscriptService.subscribe(target.bindingToken, (state, baseline) => {
      if (stopped) return;
      if (!state || state.status === 'closed') {
        stop();
        return;
      }
      // Loading/stale snapshots are baselines, never a source of spoken catchup.
      if (baseline) queue.update(target.agent, false, []);
      queue.update(target.agent, state.status === 'live', state.transcript.messages);
      void drain();
    });
  }
  // Rust admission replaces any announcement or device speech atomically.
  Promise.resolve()
    .then(() => stopped ? undefined : native.startChatSpeech(token, target.label))
    .then(() => {
      if (stopped) return;
      ready = true;
      return drain();
    })
    .catch(fail);
  return stop;
}
