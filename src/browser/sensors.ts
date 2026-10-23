import { Platform } from 'react-native';
import type {
  AccelerometerMeasurement,
  BarometerMeasurement,
} from 'expo-sensors';
import { sampleSensor, sensorFailure } from './sensorSample';

const STANDARD_GRAVITY = 9.80665;
const VECTOR_UNITS = {
  accelerometer: 'm/s2',
  gyroscope: 'rad/s',
  magnetometer: 'uT',
} as const;

/** Adapt Expo measurements to the sensor result contract validated by Rust. */
export function sensorSnapshot(
  kind: string,
  signal: AbortSignal,
  foreground: () => void,
): Promise<unknown> {
  foreground();
  const {
    Accelerometer,
    Gyroscope,
    Magnetometer,
    MagnetometerUncalibrated,
    Barometer,
    DeviceMotion,
  } = require('expo-sensors') as typeof import('expo-sensors');
  if (kind === 'barometer') {
    return sampleSensor(
      Barometer,
      signal,
      foreground,
      ({ pressure }: BarometerMeasurement) => {
        if (!Number.isFinite(pressure)) return;
        return {
          sensor: kind,
          unit: 'hPa',
          timestamp_ms: Date.now(),
          reading: { pressure },
        };
      },
      // Expo 57's Barometer permission methods are no-ops on iOS.
      Platform.OS === 'ios' ? DeviceMotion : Barometer,
    );
  }
  if (
    kind !== 'accelerometer' &&
    kind !== 'gyroscope' &&
    kind !== 'magnetometer'
  )
    throw sensorFailure('invalid_argument', 'Unknown sensor');
  const sensor = {
    accelerometer: Accelerometer,
    gyroscope: Gyroscope,
    // Match the previous native CMMagnetometerData reading on iOS.
    magnetometer:
      Platform.OS === 'ios' ? MagnetometerUncalibrated : Magnetometer,
  }[kind];
  const scale =
    kind === 'accelerometer'
      ? STANDARD_GRAVITY * (Platform.OS === 'ios' ? -1 : 1)
      : 1;
  return sampleSensor(
    sensor,
    signal,
    foreground,
    ({ x, y, z }: AccelerometerMeasurement) => {
      if (![x, y, z].every(Number.isFinite)) return;
      return {
        sensor: kind,
        unit: VECTOR_UNITS[kind],
        timestamp_ms: Date.now(),
        reading: { x: x * scale, y: y * scale, z: z * scale },
      };
    },
  );
}
