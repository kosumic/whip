import {
  NotificationManager,
  NotificationError,
  NotificationRelayMethod,
  NotificationInstallStage,
  notificationLeasePulseIntervalMs,
  type NotificationPlatform,
  type NotificationPluginInstallProgress as NativeInstallProgress,
} from 'react-native-whip-ssh';
import {
  notificationRuntimes as runtimes,
  subscribeNotificationRuntimeChanges,
  type NotificationRuntime,
} from './notificationRuntimeRegistry';
export {
  bindNotificationRuntime,
  unbindNotificationRuntime,
  type NotificationRuntime,
} from './notificationRuntimeRegistry';
import * as Keychain from 'react-native-keychain';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { appStorage } from './appStorage';
import { waitForNotificationRegistration } from './notificationRegistration';
import { bestEffortCleanup } from './backgroundOperations';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';

const SERVICE = 'dev.whip.notification-keys.v1';
export const DEFAULT_NOTIFICATION_E2EE = false;
export { notificationLeasePulseIntervalMs };
export type { RemoteNotificationState } from 'react-native-whip-ssh';

export interface NotificationPluginState {
  installed: boolean;
  enabled: boolean;
  version: string | null;
  install_command?: string;
  update_available?: boolean;
}
export interface NotificationPluginInstallProgress {
  stage:
    | 'checking-host'
    | 'checking-release'
    | 'downloading'
    | 'enabling'
    | 'verifying'
    | 'complete';
  completed_stages: Array<NotificationPluginInstallProgress['stage']>;
  elapsed_ms: number;
  timeout_ms: number;
  running: boolean;
  error: string | null;
}

function installStages(): Record<
  NotificationInstallStage,
  NotificationPluginInstallProgress['stage']
> {
  return {
    [NotificationInstallStage.CheckingHost]: 'checking-host',
    [NotificationInstallStage.CheckingRelease]: 'checking-release',
    [NotificationInstallStage.Downloading]: 'downloading',
    [NotificationInstallStage.Enabling]: 'enabling',
    [NotificationInstallStage.Verifying]: 'verifying',
    [NotificationInstallStage.Complete]: 'complete',
  };
}
function relayMethods(): Record<NotificationRelayMethod, string> {
  return {
    [NotificationRelayMethod.Put]: 'PUT',
    [NotificationRelayMethod.Post]: 'POST',
    [NotificationRelayMethod.Delete]: 'DELETE',
  };
}
const listeners = new Set<() => void>();
const progressListeners = new Map<
  string,
  Set<(progress: NotificationPluginInstallProgress) => void>
>();
// These are OS push-listener handles, never registration or application state.
const verifications = new Map<
  string,
  ReturnType<typeof waitForNotificationRegistration>
>();
let manager: NotificationManager | undefined;

async function platformEffect<T>(effect: () => T | Promise<T>): Promise<T> {
  try {
    return await effect();
  } catch (error) {
    throw new NotificationError.Failed({
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Map the tagged native error mechanically; policy and guidance live in Rust. */
async function operation<T>(effect: () => Promise<T>): Promise<T> {
  try {
    return await effect();
  } catch (error) {
    if (NotificationError.Failed.instanceOf(error))
      throw new Error(error.inner.message);
    throw error;
  }
}

async function pushToken(): Promise<string> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted)
    throw new Error('Enable notification permission first');
  const projectId =
    Constants.easConfig?.projectId ||
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
      ?.projectId;
  if (!projectId)
    throw new Error(
      'This build needs its Expo project ID and APNs/FCM push credentials',
    );
  const simulator =
    Platform.OS === 'ios' &&
    (await Application.getIosApplicationReleaseTypeAsync()) ===
      Application.ApplicationReleaseType.SIMULATOR;
  return (
    await Notifications.getExpoPushTokenAsync({
      projectId,
      ...(simulator ? { development: true } : {}),
    })
  ).data;
}

function installProgress(
  progress: NativeInstallProgress,
): NotificationPluginInstallProgress {
  return {
    stage: installStages()[progress.stage],
    completed_stages: progress.completedStages.map(
      stage => installStages()[stage],
    ),
    elapsed_ms: Number(progress.elapsedMs),
    timeout_ms: Number(progress.timeoutMs),
    running: progress.running,
    error: progress.error ?? null,
  };
}

const platform: NotificationPlatform = {
  readRegistrations: () =>
    platformEffect(async () => {
      const value = await Keychain.getGenericPassword({ service: SERVICE });
      return value ? value.password : undefined;
    }),
  writeRegistrations: value =>
    platformEffect(async () => {
      const stored = await Keychain.setGenericPassword(
        'whip-notifications',
        value,
        {
          service: SERVICE,
          accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        },
      );
      if (!stored) throw new Error('Could not store notification keys');
    }),
  readData: key =>
    platformEffect(async () => (await appStorage.getItem(key)) ?? undefined),
  writeData: (key, value) =>
    platformEffect(() =>
      value === undefined
        ? appStorage.removeItem(key)
        : appStorage.setItem(key, value),
    ),
  pushToken: () => platformEffect(pushToken),
  beginVerification: deviceId =>
    platformEffect(() => {
      const verification = waitForNotificationRegistration(deviceId);
      // The native PUT can fail before the proof future is polled.
      bestEffortCleanup(verification.promise, 'notification-proof-listener');
      verifications.set(deviceId, verification);
    }),
  verificationProof: (deviceId, options) =>
    platformEffect(async () => {
      const verification = verifications.get(deviceId);
      if (!verification)
        throw new Error('Notification verification listener is unavailable');
      return new Promise<string>((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => {
          verification.cancel();
          reject(new Error('Notification verification canceled'));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        verification.promise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', abort));
      });
    }),
  cancelVerification: deviceId => {
    verifications.get(deviceId)?.cancel();
    verifications.delete(deviceId);
  },
  relayRequest: (request, options) =>
    platformEffect(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, 8000);
      options?.signal.addEventListener('abort', abort, { once: true });
      if (options?.signal.aborted) abort();
      try {
        const response = await fetch(request.url, {
          method: relayMethods()[request.method],
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${request.managementToken}`,
          },
          body: request.body,
          signal: controller.signal,
          redirect: 'error',
        });
        let code: string | undefined;
        if (!response.ok) {
          try {
            const details: unknown = await response.json();
            if (
              details &&
              typeof details === 'object' &&
              'code' in details &&
              typeof details.code === 'string'
            )
              code = details.code;
          } catch {
            /* Proxies and older relays can return non-JSON errors. */
          }
        }
        return { status: response.status, code };
      } finally {
        clearTimeout(timeout);
        options?.signal.removeEventListener('abort', abort);
      }
    }),
  changed: () => {
    for (const listener of listeners) listener();
  },
  installProgress: (hostId, progress) => {
    for (const listener of progressListeners.get(hostId) ?? [])
      listener(installProgress(progress));
  },
};

function attachRuntime(
  owner: NotificationManager,
  hostId: string,
  runtime: NotificationRuntime,
): void {
  owner.attachRuntime(
    hostId,
    runtime.runtimeId,
    BigInt(runtime.runtimeIncarnation),
  );
}

function native(): NotificationManager {
  if (!manager) {
    manager = new NotificationManager(platform);
    for (const [hostId, runtime] of runtimes)
      attachRuntime(manager, hostId, runtime);
  }
  return manager;
}

subscribeNotificationRuntimeChanges((hostId, runtime, previous) => {
  if (!manager) return;
  if (runtime) attachRuntime(manager, hostId, runtime);
  else if (previous)
    manager.detachRuntime(
      hostId,
      previous.runtimeId,
      BigInt(previous.runtimeIncarnation),
    );
});

export function subscribeRemoteNotifications(listener: () => void): () => void {
  // Initialize before subscribing: initial runtime attachment can emit a change.
  native();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function remoteNotificationStates() {
  return operation(() => native().states());
}
export function notificationConsumerState() {
  return operation(() => native().consumerState());
}
export function remoteNotificationEncryption(hostId: string): Promise<boolean> {
  return operation(() => native().encryption(hostId));
}
export function setRemoteNotificationEncryption(
  hostId: string,
  encrypted: boolean,
): Promise<void> {
  return operation(() => native().setEncryption(hostId, encrypted).wait());
}
export function enableRemoteNotifications(
  hostId: string,
  relayUrl: string,
  encrypted?: boolean,
): Promise<void> {
  return operation(() => native().enable(hostId, relayUrl, encrypted).wait());
}
export function disableRemoteNotifications(
  hostId: string,
  forget = false,
): Promise<void> {
  return operation(() => native().disable(hostId, forget).wait());
}
export function renewNotificationLeases(): Promise<void> {
  return operation(() => native().consumerPulse().wait());
}
export function refreshRemotePushTokens(): Promise<void> {
  return operation(() => native().refreshPushToken().wait());
}
export async function remoteNotificationTarget(
  data: Record<string, unknown>,
  notificationId: string,
): Promise<AgentNotificationTarget | null> {
  return (
    (await operation(() =>
      native()
        .notificationTarget(JSON.stringify(data), notificationId)
        .target(),
    )) ?? null
  );
}
export function isRemoteNotification(
  data: Record<string, unknown> | undefined,
): boolean {
  return Boolean(data?.whip_notify);
}
export function verifyRemoteNotificationHost(
  hostId: string,
  deviceId: string,
  runtime: NotificationRuntime,
): Promise<void> {
  return operation(() =>
    native()
      .verifyHost(
        hostId,
        deviceId,
        runtime.runtimeId,
        BigInt(runtime.runtimeIncarnation),
      )
      .wait(),
  );
}
export async function notificationPluginState(
  hostId: string,
): Promise<NotificationPluginState | undefined> {
  const value = await operation(() => native().pluginState(hostId));
  return (
    value && {
      installed: value.installed,
      enabled: value.enabled,
      version: value.version ?? null,
      install_command: value.installCommand,
      update_available: value.updateAvailable,
    }
  );
}
export async function installNotificationPlugin(
  hostId: string,
  onProgress?: (progress: NotificationPluginInstallProgress) => void,
): Promise<void> {
  if (onProgress) {
    const hostListeners = progressListeners.get(hostId) ?? new Set();
    hostListeners.add(onProgress);
    progressListeners.set(hostId, hostListeners);
  }
  try {
    await operation(() => native().installPlugin(hostId).wait());
  } finally {
    if (onProgress) progressListeners.get(hostId)?.delete(onProgress);
    if (!progressListeners.get(hostId)?.size) progressListeners.delete(hostId);
  }
}
export function uninstallNotificationPlugin(hostId: string): Promise<void> {
  return operation(() => native().uninstallPlugin(hostId).wait());
}
