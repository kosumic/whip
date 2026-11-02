import { DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { NativeAutomaticChatSpeechQueue } from 'react-native-whip-ssh';

import { agentTranscriptService, type ObservedAgentTranscript } from './NativeTranscriptService';
import { CHAT_SPEECH_STOPPED, isChatResponsePlaying, registerAutomaticSpeech } from './chatSpeech';
import { isSpeechInputActive, subscribeSpeechInput } from './speechInputFocus';
import { setChatSpeechFocus } from './chatSpeechFocus';
import { getSpeechPlayback } from './speechPlayback';

let generation = 0;
type SpeechEvents = { [CHAT_SPEECH_STOPPED]: [event: { token: string; error?: string }] };

/** One bounded native queue and player for all ready transcripts, across screens. */
export function listenToAllTranscripts(onError: (error: unknown) => void): () => void {
  const native = getSpeechPlayback();
  const queue = new NativeAutomaticChatSpeechQueue();
  const transcripts = new Map<string, ObservedAgentTranscript>();
  let disposed = false;
  let silenced = false;
  let paused = isSpeechInputActive() || isChatResponsePlaying();
  let draining = false;
  let version = 0;
  let lease: { token: string; key: string } | null = null;
  let stopping = Promise.resolve();

  const allowed = () => !disposed && !silenced && !paused;
  const stopLease = (): Promise<void> => {
    if (!lease) return stopping;
    const token = lease.token;
    lease = null;
    setChatSpeechFocus(null);
    stopping = native.stopChatSpeech(token).catch(onError);
    return stopping;
  };
  const pause = (): Promise<void> => {
    paused = true;
    queue.reset();
    return stopLease();
  };
  const accept = (event: ObservedAgentTranscript) => {
    if (disposed) return;
    version++;
    if (!event.state || event.state.status === 'closed') {
      transcripts.delete(event.key);
      queue.remove(event.key);
    } else {
      transcripts.set(event.key, event);
      queue.update(event.key, event.binding.agent, event.tabName, allowed() && event.state.status === 'live', event.baseline, event.state.transcript.messages);
    }
    if ((event.state?.status !== 'live' || event.baseline) && lease?.key === event.key) void stopLease();
    void drain();
  };
  const resume = () => {
    if (disposed || silenced || isSpeechInputActive() || isChatResponsePlaying()) return;
    paused = false;
    queue.reset();
    for (const event of transcripts.values()) {
      if (event.state) queue.update(event.key, event.binding.agent, event.tabName, event.state.status === 'live', true, event.state.transcript.messages);
    }
  };
  const drain = async () => {
    if (!allowed() || draining) return;
    draining = true;
    let observedVersion = version;
    let playingToken: string | null = null;
    try {
      while (allowed()) {
        observedVersion = version;
        const next = queue.next();
        if (!next) break;
        const target = transcripts.get(next.key);
        if (target?.state?.status !== 'live') continue;
        if (!lease) {
          await stopping;
          if (!allowed()) break;
          const current = { token: `all-transcripts:${++generation}`, key: next.key };
          lease = current;
          playingToken = current.token;
          setChatSpeechFocus({ hostId: target.hostSessionId, paneId: target.binding.paneId });
          await native.startChatSpeech(current.token, target.tabName || 'Agent updates');
          if (lease !== current || !allowed()) continue;
        }
        const current = lease;
        if (!current) continue;
        playingToken = current.token;
        current.key = next.key;
        setChatSpeechFocus({ hostId: target.hostSessionId, paneId: target.binding.paneId });
        await native.speakChat(current.token, next.text);
      }
    } catch (error) {
      if (allowed() && lease?.token === playingToken) {
        silenced = true;
        queue.reset();
        onError(error);
      }
    } finally {
      await stopLease();
      draining = false;
      if (allowed() && version !== observedVersion) void drain();
    }
  };

  const emitter: Pick<NativeEventEmitter<SpeechEvents>, 'addListener'> =
    Platform.OS === 'ios' ? new NativeEventEmitter<SpeechEvents>(native) : DeviceEventEmitter;
  const subscription = emitter.addListener(CHAT_SPEECH_STOPPED, (event: { token: string; error?: string }) => {
    if (event.token !== lease?.token) return;
    silenced = true;
    queue.reset();
    void stopLease();
    if (event.error) onError(new Error(event.error));
  });
  const unregister = registerAutomaticSpeech({ pause, resume });
  const unsubscribeInput = subscribeSpeechInput(() => {
    if (isSpeechInputActive()) void pause();
    else resume();
  });
  const unsubscribe = agentTranscriptService.observe(accept);
  return () => {
    if (disposed) return;
    disposed = true;
    unregister();
    unsubscribeInput();
    unsubscribe();
    subscription.remove();
    void stopLease();
    queue.dispose();
    transcripts.clear();
  };
}
