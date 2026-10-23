import { Platform } from 'react-native';
import type { DeviceMotionMeasurement } from 'expo-sensors';
import { sampleSensor } from './sensorSample';

/** One native reading; never remove other consumers' listeners or change their interval. */
export function motionSnapshot(
  signal: AbortSignal,
  foreground: () => void,
): Promise<unknown> {
  foreground();
  const { DeviceMotion } =
    require('expo-sensors') as typeof import('expo-sensors');
  return sampleSensor(
    DeviceMotion,
    signal,
    foreground,
    (reading: DeviceMotionMeasurement) => {
      // Android can emit partial events before its component sensors initialize.
      if (!reading.accelerationIncludingGravity || !reading.rotation) return;
      return {
        timestamp_ms: Date.now(),
        orientation: reading.orientation,
        // Expo 57's iOS native implementation emits seconds, Android emits ms.
        interval_ms: reading.interval * (Platform.OS === 'ios' ? 1000 : 1),
        acceleration: reading.acceleration || null,
        accelerationIncludingGravity: reading.accelerationIncludingGravity,
        rotation: reading.rotation,
        rotationRate: reading.rotationRate || null,
      };
    },
  );
}
