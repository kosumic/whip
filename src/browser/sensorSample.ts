import { AppState } from 'react-native';
import type { DeviceSensor } from 'expo-sensors';

const SAMPLE_TIMEOUT_MS = 5000;
const SENSOR_ERROR_CODES = new Set<unknown>([
  'cancelled',
  'device_unavailable',
  'permission_denied',
  'sensor_unavailable',
  'timeout',
]);

export function sensorFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

type SensorSource<T> = Pick<
  DeviceSensor<T>,
  | 'isAvailableAsync'
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'addListener'
>;

/** Own only this request's subscription; leave shared sensor intervals untouched. */
export function sampleSensor<T, R>(
  sensor: SensorSource<T>,
  signal: AbortSignal,
  foreground: () => void,
  convert: (measurement: T) => R | undefined,
  permissions: Pick<
    SensorSource<T>,
    'getPermissionsAsync' | 'requestPermissionsAsync'
  > = sensor,
): Promise<R> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: ReturnType<typeof sensor.addListener> | undefined;
    let stateSubscription:
      ReturnType<typeof AppState.addEventListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, value?: R) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      stateSubscription?.remove();
      signal.removeEventListener('abort', cancel);
      if (error)
        reject(
          error instanceof Error &&
            'code' in error &&
            SENSOR_ERROR_CODES.has(error.code)
            ? error
            : sensorFailure(
                'sensor_unavailable',
                'Could not read device sensor',
              ),
        );
      else resolve(value!);
    };
    const cancel = () =>
      finish(sensorFailure('cancelled', 'Sensor request cancelled'));
    const start = async () => {
      const available = await sensor.isAvailableAsync();
      if (settled) return;
      foreground();
      if (!available)
        throw sensorFailure(
          'sensor_unavailable',
          'This device does not have the requested sensor',
        );
      let permission = await permissions.getPermissionsAsync();
      if (settled) return;
      foreground();
      if (!permission.granted && permission.canAskAgain) {
        permission = await permissions.requestPermissionsAsync();
        if (settled) return;
        foreground();
      }
      if (!permission.granted)
        throw sensorFailure(
          'permission_denied',
          'Sensor permission was denied',
        );
      timer = setTimeout(
        () => finish(sensorFailure('timeout', 'Device sensor timed out')),
        SAMPLE_TIMEOUT_MS,
      );
      subscription = sensor.addListener(measurement => {
        if (settled) return;
        try {
          foreground();
          const value = convert(measurement);
          if (value !== undefined) finish(undefined, value);
        } catch (error) {
          finish(error);
        }
      });
      // A sensor may deliver its first event while addListener is returning.
      if (settled) subscription.remove();
    };
    try {
      signal.addEventListener('abort', cancel, { once: true });
      stateSubscription = AppState.addEventListener('change', state => {
        // Permission sheets temporarily mark iOS inactive.
        if (state === 'background') cancel();
      });
      if (signal.aborted) cancel();
      else {
        foreground();
        void start().catch(finish);
      }
    } catch (error) {
      finish(error);
    }
  });
}
