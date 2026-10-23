const mockOpenSettings = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('react-native-permissions', () => ({
  openSettings: (...args: unknown[]) => mockOpenSettings(...args),
}));

import { Platform } from 'react-native';
import { openNotificationSettings } from '../src/services/notificationSettings';

beforeEach(() => {
  mockOpenSettings.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it.each(['android', 'ios'] as const)(
  'opens this app notification settings through react-native-permissions on %s',
  async platform => {
    jest.replaceProperty(Platform, 'OS', platform);
    mockOpenSettings.mockResolvedValue(undefined);

    await openNotificationSettings();

    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    expect(mockOpenSettings).toHaveBeenCalledWith('notifications');
  },
);
