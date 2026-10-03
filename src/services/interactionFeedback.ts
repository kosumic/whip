import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';

import { reportBackgroundFailure } from './backgroundOperations';

const HAPTIC_FEEDBACK_CONTEXT = 'haptic-feedback';

export function hapticPress(handler?: () => void | Promise<void>) {
  return () => {
    reportBackgroundFailure(Haptics.selectionAsync(), HAPTIC_FEEDBACK_CONTEXT);
    const operation = handler?.();
    if (operation) reportBackgroundFailure(operation, 'haptic-press-handler');
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
  reportBackgroundFailure(
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    HAPTIC_FEEDBACK_CONTEXT,
  );
}
