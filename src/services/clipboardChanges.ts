import Clipboard from '@react-native-clipboard/clipboard';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const CLIPBOARD_CHANGED_EVENT = 'WhipClipboardChanged';

interface ClipboardObservationNativeModule {
  setCopyFeedbackEnabled(enabled: boolean): void;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export function watchClipboardChanges(onChange: () => void): { remove(): void } | null {
  if (Platform.OS !== 'ios') return Clipboard.addListener(onChange);

  // RNCClipboard's iOS addListener override never calls startObserving.
  const native = NativeModules.ClipboardAttachment as ClipboardObservationNativeModule | undefined;
  if (!native?.setCopyFeedbackEnabled) return null;
  const subscription = new NativeEventEmitter(native).addListener(CLIPBOARD_CHANGED_EVENT, onChange);
  native.setCopyFeedbackEnabled(true);
  return {
    remove() {
      native.setCopyFeedbackEnabled(false);
      subscription.remove();
    },
  };
}
