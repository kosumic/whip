import { AppState, Platform } from 'react-native';
import type { DeviceMotionMeasurement } from 'expo-sensors';

const SAMPLE_TIMEOUT_MS = 5000;

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** One native reading; never remove other consumers' listeners or change their interval. */
export async function motionSnapshot(
  signal: AbortSignal,
  foreground: () => void,
): Promise<unknown> {
  foreground();
  const { DeviceMotion } =
    require('expo-sensors') as typeof import('expo-sensors');
  const available = await DeviceMotion.isAvailableAsync();
  foreground();
  if (!available)
    throw failure(
      'sensor_unavailable',
      'DeviceMotion is unavailable on this phone',
    );
  let permission = await DeviceMotion.getPermissionsAsync();
  foreground();
  if (!permission.granted && permission.canAskAgain) {
    permission = await DeviceMotion.requestPermissionsAsync();
    foreground();
  }
  if (!permission.granted)
    throw failure('permission_denied', 'Motion permission was denied');

  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: ReturnType<typeof DeviceMotion.addListener> | undefined;
    const finish = (error?: Error, reading?: DeviceMotionMeasurement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      stateSubscription.remove();
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else if (reading)
        resolve({
          timestamp_ms: Date.now(),
          orientation: reading.orientation,
          // Expo 57's iOS native implementation emits seconds, Android emits ms.
          interval_ms: reading.interval * (Platform.OS === 'ios' ? 1000 : 1),
          acceleration: reading.acceleration || null,
          accelerationIncludingGravity: reading.accelerationIncludingGravity,
          rotation: reading.rotation,
          rotationRate: reading.rotationRate || null,
        });
    };
    const cancel = () =>
      finish(failure('cancelled', 'Motion request cancelled'));
    const stateSubscription = AppState.addEventListener('change', state => {
      if (state === 'background') cancel();
    });
    const timer = setTimeout(
      () =>
        finish(failure('timeout', 'No complete DeviceMotion reading arrived')),
      SAMPLE_TIMEOUT_MS,
    );
    signal.addEventListener('abort', cancel, { once: true });
    try {
      foreground();
      subscription = DeviceMotion.addListener(reading => {
        // Android can emit partial events before its component sensors initialize.
        if (!reading.accelerationIncludingGravity || !reading.rotation) return;
        try {
          foreground();
          finish(undefined, reading);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (settled) subscription.remove();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
