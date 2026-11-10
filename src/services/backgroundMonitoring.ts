import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

interface HerdrBackgroundNativeModule {
  start(hostCount: number): Promise<void>;
  stop(): Promise<void>;
  setNotificationConsumerPulseInterval(intervalMs: number): void;
  armPersistentAlert(
    notificationIdentifier: string,
    channelId: string,
    timeoutMs: number,
  ): Promise<void>;
  dismissPersistentAlert(notificationIdentifier: string | null): Promise<void>;
  prepareSpokenAlert(
    notificationIdentifier: string,
    channelId: string,
    persistent: boolean,
    vibrationPattern: number[],
    effectId: string,
  ): Promise<void>;
}

function nativeModule(includeIos = false): HerdrBackgroundNativeModule | null {
  if (Platform.OS !== 'android' && !(includeIos && Platform.OS === 'ios')) return null;
  const module = NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrBackground native module is not installed in this build');
  }
  return module;
}

let monitoringActive = false;
export function backgroundMonitoringActive(): boolean { return monitoringActive; }

/** Android pauses RN's JS timers in background even with a foreground service.
 * This clock only wakes JS; permission/delivery/runtime checks still gate leases.
 */
export function observeBackgroundNotificationPulses(
  pulse: () => void,
  intervalMs: number,
): () => void {
  const module = nativeModule();
  if (!module) return () => {};
  const subscription = DeviceEventEmitter.addListener('WhipNotificationConsumerPulse', pulse);
  module.setNotificationConsumerPulseInterval(intervalMs);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    subscription.remove();
    module.setNotificationConsumerPulseInterval(0);
  };
}

export async function startBackgroundMonitoring(hostCount: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.start(Math.max(1, Math.trunc(hostCount)));
  monitoringActive = true;
}

export async function stopBackgroundMonitoring(): Promise<void> {
  // Stop Android execution protection only; runtime lifetime is process-owned.
  const module = nativeModule();
  if (!module) return;
  monitoringActive = false;
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

export async function dismissPersistentAgentAlert(notificationIdentifier?: string): Promise<void> {
  const module = nativeModule(true);
  if (!module) return;
  await module.dismissPersistentAlert(notificationIdentifier ?? null);
}

export async function prepareSpokenAgentAlert(
  notificationIdentifier: string,
  channelId: string,
  persistent: boolean,
  vibrationPattern: number[],
  effectId: string,
): Promise<void> {
  const module = nativeModule(true);
  if (!module) return;
  await module.prepareSpokenAlert(notificationIdentifier, channelId, persistent, vibrationPattern, effectId);
}
