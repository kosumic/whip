import { Platform } from 'react-native';
import { openSettings } from 'react-native-permissions';

export async function openNotificationSettings(): Promise<void> {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    await openSettings('notifications');
  }
}
