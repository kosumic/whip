import { AudioModule, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { createSecureId } from '../lib/secureId';
import { settledPromise } from '../lib/promises';
import { getSpeechPlayback } from './speechPlayback';
import { onOpenAiVoiceCredentialChange } from './openAiVoiceCredentials';

const MAX_RECORDING_SECONDS = 300;
const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1 };

export interface OpenAiSpeechCapture {
  start: (onEnd: (failed: boolean) => void) => Promise<boolean>;
  finish: (draft: string, recent: string[]) => Promise<string>;
  cancel: () => Promise<void>;
}

/** Platform capture only; Rust owns the request, context budget and credentials. */
export function createOpenAiSpeechCapture(): OpenAiSpeechCapture {
  const id = createSecureId('dictation');
  const native = getSpeechPlayback();
  const recorder = new AudioModule.AudioRecorder({ ...RECORDING_OPTIONS,
    ...(Platform.OS === 'ios' ? RECORDING_OPTIONS.ios : RECORDING_OPTIONS.android),
  });
  let cancelled = false;
  let finished = false;
  let released = false;
  let cleanupTask: Promise<void> | undefined;
  let audioModeSet = false;
  let subscription: { remove: () => void } | undefined;
  let preparation: Promise<boolean> | undefined;
  let unsubscribeCredential: (() => void) | undefined;
  const cleanup = () => {
    cleanupTask ??= (async () => {
      released = true;
      subscription?.remove();
      unsubscribeCredential?.();
      const uri = recorder.uri;
      recorder.release();
      try {
        if (uri) {
          const file = new File(uri);
          if (file.exists) file.delete();
        }
      } finally {
        if (audioModeSet) await setAudioModeAsync({ allowsRecording: false });
      }
    })();
    return cleanupTask;
  };
  const cancel = async () => {
    cancelled = true;
    // Native cancellation bypasses the settings worker that's doing the upload.
    const abort = settledPromise(native.speechBackendCommand(`stt-cancel:${id}`));
    await settledPromise(preparation ?? Promise.resolve(false));
    await settledPromise(native.speechBackendCommand(`stt-cancel:${id}`));
    try { if (!released && recorder.isRecording) await recorder.stop(); }
    finally { await cleanup(); await abort; }
  };
  return {
    start(onEnd) {
      preparation = (async () => {
        if (!(await requestRecordingPermissionsAsync()).granted) return false;
        if (cancelled) return false;
        await native.speechBackendCommand(`stt-start:${id}`);
        if (cancelled) return false;
        unsubscribeCredential = onOpenAiVoiceCredentialChange(() => onEnd(true));
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        audioModeSet = true;
        if (cancelled) return false;
        await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
        if (cancelled) return false;
        subscription = recorder.addListener('recordingStatusUpdate', status => {
          if (!cancelled && !finished && (status.isFinished || status.hasError)) onEnd(status.hasError);
        });
        recorder.record({ forDuration: MAX_RECORDING_SECONDS });
        return true;
      })();
      return preparation;
    },
    async finish(draft, recent) {
      finished = true;
      try {
        if (recorder.isRecording) await recorder.stop();
        if (cancelled || !recorder.uri) return '';
        const value = JSON.parse(await native.speechBackendCommand(`stt:${JSON.stringify({ id, uri: recorder.uri, draft, recent })}`)) as { text: string };
        return cancelled ? '' : value.text;
      } finally { await cleanup(); }
    },
    cancel,
  };
}
