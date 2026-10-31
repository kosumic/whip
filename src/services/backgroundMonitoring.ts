import { NativeModules, Platform } from 'react-native';

interface HerdrBackgroundNativeModule {
  start(hostCount: number): Promise<void>;
  stop(): Promise<void>;
  armPersistentAlert(
    notificationIdentifier: string,
    channelId: string,
    timeoutMs: number,
  ): Promise<void>;
  dismissPersistentAlert(notificationIdentifier: string | null): Promise<void>;
}

function nativeModule(): HerdrBackgroundNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const module = NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrBackground native module is not installed in this build');
  }
  return module;
}

let monitoringActive = false;
export function backgroundMonitoringActive(): boolean { return monitoringActive; }

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
  const module = nativeModule();
  if (!module) return;
  await module.dismissPersistentAlert(notificationIdentifier ?? null);
}
