import {
  AppState,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { motionSnapshot } from './motion';
import type { BrowserSessionIdentity } from './registry';

const NOTIFICATION_CHANNEL = 'reverse-control-v1';

interface NativeDevice {
  info(): Promise<Record<string, unknown>>;
  battery(): Promise<Record<string, unknown>>;
  location(requestId: string): Promise<Record<string, unknown>>;
  cancelLocation(requestId: string): void;
  network(requestId: string): Promise<Record<string, unknown>>;
  sensorSnapshot(
    requestId: string,
    sensor: string,
  ): Promise<Record<string, unknown>>;
  speak(
    sessionId: string,
    requestId: string,
    text: string,
    language: string | null,
    rate: number,
  ): Promise<Record<string, unknown>>;
  stopSpeaking(sessionId: string): Promise<Record<string, unknown>>;
  cancelRequest(requestId: string): void;
  releaseSession(sessionId: string): void;
}

/** Session teardown also releases speech acknowledged by an earlier tool call. */
export function closeDeviceSession(sessionId: string): void {
  (NativeModules?.WhipDevice as NativeDevice | undefined)?.releaseSession?.(
    sessionId,
  );
}

async function nativeRequest(
  work: () => Promise<unknown>,
  cancel: () => void,
  signal: AbortSignal,
  foreground?: () => void,
): Promise<unknown> {
  if (signal.aborted) throw failure('cancelled', 'Device action cancelled');
  foreground?.();
  signal.addEventListener('abort', cancel, { once: true });
  const subscription = foreground
    ? AppState.addEventListener('change', state => {
        if (state === 'background') cancel();
      })
    : undefined;
  try {
    const value = await work();
    if (signal.aborted) throw failure('cancelled', 'Device action cancelled');
    foreground?.();
    return value;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    subscription?.remove();
  }
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Native platform boundary only; Rust owns the tool schema and result contract. */
export async function deviceAction(
  action: string,
  args: Record<string, unknown>,
  requestId: string,
  signal: AbortSignal,
  identity?: BrowserSessionIdentity,
): Promise<unknown> {
  const native = NativeModules?.WhipDevice as NativeDevice | undefined;
  if (!native)
    throw failure(
      'device_unavailable',
      'Device tools require a native Whip build',
    );
  const active = () => {
    if (signal.aborted) throw failure('cancelled', 'Device action cancelled');
  };
  const foreground = () => {
    active();
    if (AppState.currentState !== 'active')
      throw failure(
        'device_unavailable',
        'Keep Whip foregrounded to use this device tool',
      );
  };
  active();
  if (action === 'device.motion') return motionSnapshot(signal, foreground);
  if (action === 'device.info') return native.info();
  if (action === 'device.battery') return native.battery();
  if (action === 'device.network')
    return nativeRequest(
      () => native.network(requestId),
      () => native.cancelRequest(requestId),
      signal,
    );
  if (action === 'device.sensor_snapshot')
    return nativeRequest(
      () => native.sensorSnapshot(requestId, String(args.sensor)),
      () => native.cancelRequest(requestId),
      signal,
      foreground,
    );
  if (action === 'device.speak')
    return nativeRequest(
      () =>
        native.speak(
          identity?.sessionId || requestId,
          requestId,
          String(args.text),
          typeof args.language === 'string' ? args.language : null,
          Number(args.rate),
        ),
      () => native.cancelRequest(requestId),
      signal,
    );
  if (action === 'device.stop_speaking')
    return native.stopSpeaking(identity?.sessionId || requestId);
  if (
    action === 'device.clipboard_read' ||
    action === 'device.clipboard_write'
  ) {
    foreground();
    if (action === 'device.clipboard_write') {
      Clipboard.setString(String(args.text));
      return { written: true };
    }
    const value = await Clipboard.getString();
    foreground();
    let text = value.slice(0, Number(args.max_chars));
    // Do not split a UTF-16 surrogate pair when bounding native clipboard text.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    return { text, truncated: text.length < value.length };
  }
  if (action === 'device.notify') {
    const Notifications =
      require('expo-notifications') as typeof import('expo-notifications');
    active();
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
        name: 'Reverse Control',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      active();
    }
    const allowed = (
      permission: Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>,
    ) =>
      permission.granted ||
      permission.ios?.status ===
        Notifications.IosAuthorizationStatus.PROVISIONAL ||
      permission.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
    let permission = await Notifications.getPermissionsAsync();
    active();
    if (!allowed(permission) && permission.canAskAgain) {
      foreground();
      permission = await Notifications.requestPermissionsAsync();
      active();
    }
    if (!allowed(permission))
      throw failure('permission_denied', 'Notification permission was denied');
    active();
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: String(args.title),
        body: String(args.body),
        data: {
          hostId: identity?.runtimeId,
          paneId: identity?.paneId,
          agentAlertLevel: 'regular',
        },
      },
      trigger:
        Platform.OS === 'android' ? { channelId: NOTIFICATION_CHANNEL } : null,
    });
    if (signal.aborted) {
      await Notifications.cancelScheduledNotificationAsync(id);
      await Notifications.dismissNotificationAsync(id);
      active();
    }
    return { notification_id: id };
  }
  if (action === 'device.haptic') {
    const Haptics = require('expo-haptics') as typeof import('expo-haptics');
    active();
    const style = {
      light: Haptics.ImpactFeedbackStyle.Light,
      medium: Haptics.ImpactFeedbackStyle.Medium,
      heavy: Haptics.ImpactFeedbackStyle.Heavy,
    }[String(args.style)];
    if (!style) throw failure('invalid_argument', 'Unknown haptic style');
    await Haptics.impactAsync(style);
    return { performed: true };
  }
  if (action !== 'device.location')
    throw failure('unknown_action', 'Unknown device action');
  foreground();
  if (Platform.OS === 'android') {
    const coarse = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
    const fine = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    if (!(await PermissionsAndroid.check(coarse))) {
      foreground();
      const permissions = await PermissionsAndroid.requestMultiple([
        coarse,
        fine,
      ]);
      foreground();
      if (
        permissions[coarse] !== PermissionsAndroid.RESULTS.GRANTED &&
        permissions[fine] !== PermissionsAndroid.RESULTS.GRANTED
      )
        throw failure('permission_denied', 'Location permission was denied');
    }
  }
  foreground();
  const cancel = () => native.cancelLocation(requestId);
  signal.addEventListener('abort', cancel, { once: true });
  const subscription = AppState.addEventListener('change', state => {
    // iOS permission sheets temporarily mark the app inactive.
    if (state === 'background') cancel();
  });
  try {
    const value = await native.location(requestId);
    foreground();
    return value;
  } finally {
    signal.removeEventListener('abort', cancel);
    subscription.remove();
    cancel();
  }
}
