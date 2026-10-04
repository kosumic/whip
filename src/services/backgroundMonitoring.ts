import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { reportBackgroundFailure } from './backgroundOperations';

interface HerdrBackgroundNativeModule {
  start(hostCount: number): Promise<void>;
  stop(): Promise<void>;
  armPersistentAlert(
    notificationIdentifier: string,
    channelId: string,
    timeoutMs: number,
  ): Promise<void>;
  dismissPersistentAlert(): Promise<void>;
  startSpeechShake(token: string): Promise<void>;
  stopSpeechShake(token: string): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

const SPEECH_SHAKE = 'WhipSpeechShake';
let speechShakeGeneration = 0;

function nativeModule(): HerdrBackgroundNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const module = NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrBackground native module is not installed in this build');
  }
  return module;
}

export async function startBackgroundMonitoring(hostCount: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.start(Math.max(1, Math.trunc(hostCount)));
}

export async function stopBackgroundMonitoring(): Promise<void> {
  // Stop Android execution protection only; runtime lifetime is process-owned.
  const module = nativeModule();
  if (!module) return;
  await module.stop();
}

export async function armPersistentAgentAlert(
  notificationIdentifier: string,
  channelId: string,
  timeoutMs: number,
): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.armPersistentAlert(notificationIdentifier, channelId, timeoutMs);
}

export async function dismissPersistentAgentAlert(): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.dismissPersistentAlert();
}

/** Watch only while an Expo speech announcement is pending or playing. */
export function watchSpeechShake(onShake: () => void): () => void {
  const module = Platform.OS === 'ios'
    ? NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined
    : nativeModule();
  if (!module?.startSpeechShake) return () => {};
  const token = `speech:${++speechShakeGeneration}`;
  let stopped = false;
  const emitter = Platform.OS === 'ios' ? new NativeEventEmitter(module) : DeviceEventEmitter;
  const subscription = emitter.addListener(SPEECH_SHAKE, (event: { token: string }) => {
    if (!stopped && event.token === token) onShake();
  });
  reportBackgroundFailure(module.startSpeechShake(token), 'speech-shake-start');
  return () => {
    if (stopped) return;
    stopped = true;
    subscription.remove();
    reportBackgroundFailure(module.stopSpeechShake(token), 'speech-shake-stop');
  };
}
