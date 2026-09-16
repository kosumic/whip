import { DeviceEventEmitter, NativeModules } from 'react-native';
import * as Speech from 'expo-speech';
import { NativeChatSpeechQueue } from 'react-native-whip-ssh';

import { agentTranscriptService } from './NativeTranscriptService';
import { reportBackgroundFailure } from './backgroundOperations';
import { setChatSpeechFocus } from './chatSpeechFocus';

export interface ChatSpeechTarget {
  agent: 'codex' | 'opencode';
  bindingToken: string;
  hostId: string;
  paneId: string;
  label: string;
}

interface ChatSpeechNativeModule {
  startChatSpeech(token: string, label: string): Promise<void>;
  speakChat(token: string, text: string): Promise<void>;
  stopChatSpeech(token: string): Promise<void>;
}

interface ListeningSession {
  target: ChatSpeechTarget;
  stop: () => void;
}

const CHAT_SPEECH_STOPPED = 'WhipChatSpeechStopped';
let active: ListeningSession | null = null;
let generation = 0;

/** One process-wide listener, independent of the chat viewport's lifecycle. */
export function listenToChat(
  target: ChatSpeechTarget,
  onStopped: () => void,
  onError: (error: unknown) => void,
): () => void {
  active?.stop();
  const native = NativeModules.HerdrBackground as ChatSpeechNativeModule;
  if (!native?.startChatSpeech) throw new Error('This build does not support chat speech. Install an updated Android build.');
  const queue = new NativeChatSpeechQueue();
  const token = `${target.bindingToken}:${++generation}`;
  let stopped = false;
  let ready = false;
  let draining = false;
  let unsubscribe = () => {};

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
    reportBackgroundFailure(native.stopChatSpeech(token), 'chat-speech-stop');
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    onError(error);
    onStopped();
  };
  const subscription = DeviceEventEmitter.addListener(CHAT_SPEECH_STOPPED, (event: { token: string; error?: string }) => {
    if (event.token !== token || stopped) return;
    if (event.error) {
      fail(new Error(event.error));
      return;
    }
    stop();
    onStopped();
  });
  active = { target, stop };
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
    } catch (error) {
      fail(error);
    } finally {
      draining = false;
    }
  };

  unsubscribe = agentTranscriptService.subscribe(target.bindingToken, (state, baseline) => {
    if (stopped) return;
    if (!state || state.status === 'closed') {
      stop();
      onStopped();
      return;
    }
    // Loading/stale snapshots are baselines, never a source of spoken catchup.
    if (baseline) queue.update(target.agent, false, []);
    queue.update(target.agent, state.status === 'live', state.transcript.messages);
    void drain();
  });
  // Stop any status announcement before handing playback to the chat reader.
  Speech.stop()
    .then(() => stopped ? undefined : native.startChatSpeech(token, target.label))
    .then(() => {
      if (stopped) return;
      ready = true;
      return drain();
    })
    .catch(fail);
  return stop;
}
