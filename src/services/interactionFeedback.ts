import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';

import { reportBackgroundFailure } from './backgroundOperations';
import { watchClipboardChanges } from './clipboardChanges';

const HAPTIC_FEEDBACK_CONTEXT = 'haptic-feedback';
let clipboardFeedbackObservers = 0;
let clipboardFeedbackSubscription: ReturnType<typeof watchClipboardChanges> = null;

/** Observe native copy menus without reading or rewriting their clipboard data. */
export function observeClipboardCopyFeedback(): () => void {
  if (clipboardFeedbackObservers === 0) {
    clipboardFeedbackSubscription = watchClipboardChanges(() => {
      if (clipboardFeedbackObservers > 0) notifyCopySuccess();
    });
  }
  clipboardFeedbackObservers++;
  let observing = true;
  return () => {
    if (!observing) return;
    observing = false;
    if (--clipboardFeedbackObservers === 0) {
      clipboardFeedbackSubscription?.remove();
      clipboardFeedbackSubscription = null;
    }
  };
}

export function hapticPress(handler?: () => unknown) {
  return () => {
    reportBackgroundFailure(Haptics.selectionAsync(), HAPTIC_FEEDBACK_CONTEXT);
    const operation = handler?.();
    if (operation)
      reportBackgroundFailure(
        Promise.resolve(operation),
        'haptic-press-handler',
      );
  };
}

/** The composer reports acceptance into its outbox before we confirm the send. */
export function hapticSend(handler: () => boolean) {
  return () => {
    if (handler()) {
      reportBackgroundFailure(
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
        HAPTIC_FEEDBACK_CONTEXT,
      );
    }
  };
}

export function copyTextWithHaptic(text: string): void {
  Clipboard.setString(text);
  hapticCopySuccess();
}

/** The visible terminal/chat screen observes copies, including native menus. */
export function hapticCopySuccess(): void {
  if (!clipboardFeedbackSubscription) notifyCopySuccess();
}

function notifyCopySuccess(): void {
  reportBackgroundFailure(
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    HAPTIC_FEEDBACK_CONTEXT,
  );
}
