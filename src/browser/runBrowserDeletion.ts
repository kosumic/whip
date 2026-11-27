import type { TFunction } from 'i18next';
import { Alert } from 'react-native';

export async function runBrowserDeletion(
  remove: () => Promise<void>,
  message: string,
  t: TFunction,
): Promise<void> {
  try {
    await remove();
  } catch {
    Alert.alert(message, undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.retry'),
        onPress: () => {
          void runBrowserDeletion(remove, message, t);
        },
      },
    ]);
  }
}
