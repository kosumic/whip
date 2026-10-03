import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { BackgroundMonitoringMode } from '../lib/backgroundMonitoringPolicy';
import { reportBackgroundFailure } from './backgroundOperations';

interface HerdrBackgroundNativeModule {
  configure(hostCount: number, connectedHostCount: number, mode: BackgroundMonitoringMode, appActive: boolean): Promise<void>;
  stop(): Promise<void>;
  networkAvailable(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  armPersistentAlert(
    notificationIdentifier: string,
    channelId: string,
    timeoutMs: number,
  ): Promise<void>;
  dismissPersistentAlert(): Promise<void>;
}

function nativeModule(): HerdrBackgroundNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const module = NativeModules.HerdrBackground as HerdrBackgroundNativeModule | undefined;
  if (!module) {
    throw new Error('HerdrBackground native module is not installed in this build');
  }
  return module;
}

export async function configureBackgroundMonitoring(
  hostCount: number,
  connectedHostCount: number,
  mode: BackgroundMonitoringMode,
  appActive: boolean,
): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.configure(hostCount, connectedHostCount, mode, appActive);
}

/** Forward coarse connectivity only; Rust owns reconnect timing and budgets. */
export function observeMonitoringNetwork(onChange: (available: boolean) => void): () => void {
  const module = nativeModule();
  if (!module) return () => undefined;
  let current = true;
  let receivedEvent = false;
  const subscription = new NativeEventEmitter(module).addListener(
    'HerdrNetworkAvailable',
    (available: boolean) => {
      receivedEvent = true;
      if (current) onChange(available);
    },
  );
  // Do not let an older asynchronous initial snapshot overwrite a newer event.
  reportBackgroundFailure(
    module.networkAvailable().then(available => {
      if (current && !receivedEvent) onChange(available);
    }),
    'monitoring-network-initial-state',
  );
  return () => {
    current = false;
    subscription.remove();
  };
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
