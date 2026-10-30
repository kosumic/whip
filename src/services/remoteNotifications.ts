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
import { settledPromise } from '../lib/promises';
import { bestEffortCleanup } from './backgroundOperations';
import * as Keychain from 'react-native-keychain';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  notificationKeyGenerate,
  notificationTokenGenerate,
  notificationOpen,
} from 'react-native-whip-ssh';
import { appStorage } from './appStorage';
import { waitForNotificationRegistration } from './notificationRegistration';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';

const SERVICE = 'dev.whip.notification-keys.v1';
const REPLAYS = 'whip.notify.replays.v1.';
const REMOTE_FIELD = 'whip_notify';
const ENCRYPTION_PREFERENCE = 'whip.notify.e2ee.v1.';
export const DEFAULT_NOTIFICATION_E2EE = false;
export const LEASE_RENEWAL_MS = 3000;
const RELAY_FAILURE_MESSAGES: Readonly<Partial<Record<number, string>>> = {
  400: 'The relay could not accept this registration. Update Whip and try again.',
  401: 'The relay could not authenticate this registration.',
  403: 'The relay could not authorize this registration. Unregister and try enabling again.',
  404: 'The notification relay endpoint was not found. Check the custom relay URL.',
  409: 'Push verification is already in progress. Wait two minutes and try again.',
  410: 'This device’s push token is no longer valid. Restart Whip and try again.',
  426: 'Update Whip to register with this notification relay.',
  429: 'Too many notification requests. Wait a minute and try again.',
  503: 'The relay or push provider is unavailable. Try again shortly.',
};
interface Paths {
  config: string;
  state: string;
  binary: string;
  notification_previews?: boolean;
}
interface Keys {
  private_key: string;
  public_key: string;
  key_id: string;
}
interface Discovery {
  paths: Paths;
  identity: { public_key: string; host_id: string };
  session: string;
}

interface Registration {
  hostId: string;
  deviceId: string;
  keys: Keys;
  hostKey: string;
  hostIdentity: string;
  managementToken: string;
  routeToken: string;
  relayUrl: string;
  session: string;
  paths: Paths;
  enabled: boolean;
  pendingHostRemoval: boolean;
  relayRevoked: boolean;
  endToEndEncrypted?: boolean;
  forgetAfterHostRemoval?: boolean;
}
export interface RemoteNotificationState {
  hostId: string;
  relayUrl: string;
  enabled: boolean;
  connected: boolean;
  pendingHostRemoval: boolean;
  endToEndEncrypted: boolean;
}
export interface NotificationPluginState {
  installed: boolean;
  enabled: boolean;
  version: string | null;
  install_command?: string;
  update_available?: boolean;
}
export interface NotificationPluginInstallProgress {
  stage: 'checking-host' | 'checking-release' | 'downloading' | 'enabling' | 'verifying' | 'complete';
  completed_stages: Array<NotificationPluginInstallProgress['stage']>;
  elapsed_ms: number;
  timeout_ms: number;
  running: boolean;
  error: string | null;
}
const INSTALL_PROGRESS_POLL_MS = 500;
const listeners = new Set<() => void>();
let operations: Promise<unknown> = Promise.resolve();
let cached: Registration[] | undefined;

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = operations.then(work);
  operations = settledPromise(result);
  return result;
}
async function load(): Promise<Registration[]> {
  if (cached) return cached;
  const value = await Keychain.getGenericPassword({ service: SERVICE });
  cached = value ? (JSON.parse(value.password) as Registration[]) : [];
  return cached;
}
async function save(values: Registration[]): Promise<void> {
  const stored = await Keychain.setGenericPassword(
    'whip-notifications',
    JSON.stringify(values),
    {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!stored) throw new Error('Could not store notification keys');
  cached = values;
  for (const listener of listeners) listener();
}
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Enter the HTTPS relay origin');
  return url.origin;
}
async function relay(
  registration: Registration,
  method: 'PUT' | 'POST' | 'DELETE',
  expoToken?: string,
  challenge?: string,
): Promise<void> {
  const response = await fetch(
    `${registration.relayUrl}/v1/devices/${registration.deviceId}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${registration.managementToken}`,
      },
      body:
        method === 'PUT'
          ? JSON.stringify({
              protocol: 2,
              expo_token: expoToken,
              route_token: registration.routeToken,
              host_id: registration.hostIdentity,
              key_id: registration.keys.key_id,
            })
          : method === 'POST'
            ? JSON.stringify({ challenge })
            : undefined,
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    const action = method === 'DELETE' ? 'cleanup' : method === 'POST' ? 'verification' : 'registration';
    let reason = RELAY_FAILURE_MESSAGES[response.status] ?? 'Try again shortly.';
    try {
      const details: unknown = await response.json();
      if (details && typeof details === 'object' && 'code' in details &&
          details.code === 'PUSH_PROVIDER_AUTH_FAILED')
        reason = 'The relay’s push service credentials need updating. Contact the relay administrator.';
    } catch {
      // Proxies and older relays may return a non-JSON error response.
    }
    throw new Error(`Notification relay ${action} failed (HTTP ${response.status}). ${reason}`);
  }
  if (method === 'PUT' && response.status !== 202)
    throw new Error(
      'This notification relay needs an update for automatic registration',
    );
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
  // Simulator tokens belong to APNs sandbox. Simulator builds have no embedded
  // provisioning profile, so Expo cannot infer this environment from a profile.
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
async function verifyRelayRegistration(
  registration: Registration,
  expoToken: string,
): Promise<void> {
  const verification = waitForNotificationRegistration(registration.deviceId);
  try {
    const [, challenge] = await Promise.all([
      relay(registration, 'PUT', expoToken),
      verification.promise,
    ]);
    await relay(registration, 'POST', undefined, challenge);
  } finally {
    verification.cancel();
  }
}
export function subscribeRemoteNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function remoteNotificationStates(): Promise<
  RemoteNotificationState[]
> {
  return (await load()).map(r => ({
    hostId: r.hostId,
    relayUrl: r.relayUrl,
    enabled: r.enabled,
    connected: runtimes.has(r.hostId),
    pendingHostRemoval: r.pendingHostRemoval,
    endToEndEncrypted: r.endToEndEncrypted ?? true,
  }));
}

async function encryptionPreference(hostId: string, registration?: Registration): Promise<boolean> {
  if (registration) return registration.endToEndEncrypted ?? true;
  const stored = await appStorage.getItem(ENCRYPTION_PREFERENCE + hostId);
  return stored === null ? DEFAULT_NOTIFICATION_E2EE : stored === 'true';
}

export async function remoteNotificationEncryption(hostId: string): Promise<boolean> {
  return encryptionPreference(hostId, (await load()).find(r => r.hostId === hostId));
}

async function registerHost(registration: Registration, runtime: NotificationRuntime): Promise<void> {
  const encrypted = registration.endToEndEncrypted ?? true;
  requirePreviewSupport(registration.paths, encrypted);
  await runtime.notificationCommand('register', JSON.stringify({
    paths: registration.paths,
    registration: {
      device_id: registration.deviceId,
      public_key: registration.keys.public_key,
      relay_url: registration.relayUrl,
      route_token: registration.routeToken,
      session: registration.session,
      ...(registration.paths.notification_previews ? { end_to_end_encrypted: encrypted } : {}),
    },
  }));
}

function requirePreviewSupport(paths: Paths, encrypted: boolean): void {
  if (!encrypted && !paths.notification_previews)
    throw new Error('Update whip-notify on this host to support notification previews');
}

export function setRemoteNotificationEncryption(hostId: string, endToEndEncrypted: boolean): Promise<void> {
  return serial(async () => {
    const values = await load();
    const registration = values.find(r => r.hostId === hostId);
    if (registration) {
      if (!registration.enabled && !registration.relayRevoked)
        throw new Error('Finish unregistering the previous registration before changing encryption');
      const next = { ...registration, endToEndEncrypted };
      const nextValues = values.map(r => r === registration ? next : r);
      if (registration.enabled) {
        const runtime = connectedRuntime(hostId);
        const discovery = await discoverRegisteredHost(registration, runtime);
        next.paths = discovery.paths;
        requirePreviewSupport(next.paths, endToEndEncrypted);
        // Persist disclosure before it can start; acknowledge encryption only
        // after the host stops disclosing. A failed write or ambiguous SSH
        // response must never leave the UI claiming plaintext is encrypted.
        if (!endToEndEncrypted) await save(nextValues);
        await registerHost(next, runtime);
      }
      if (endToEndEncrypted || !registration.enabled) await save(nextValues);
    }
    await appStorage.setItem(ENCRYPTION_PREFERENCE + hostId, String(endToEndEncrypted));
    for (const listener of listeners) listener();
  });
}

function connectedRuntime(hostId: string) {
  const runtime = runtimes.get(hostId);
  if (!runtime)
    throw new Error(
      'Connect to this saved host to manage its notification plugin',
    );
  return runtime;
}

export async function notificationPluginState(
  hostId: string,
): Promise<NotificationPluginState | undefined> {
  const runtime = runtimes.get(hostId);
  return runtime
    ? (JSON.parse(
        await runtime.notificationCommand('plugin-status', '{}'),
      ) as NotificationPluginState)
    : undefined;
}

export function installNotificationPlugin(
  hostId: string,
  onProgress?: (progress: NotificationPluginInstallProgress) => void,
): Promise<void> {
  return serial(async () => {
    const runtime = connectedRuntime(hostId);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readProgress = async (finished = false) => {
      try {
        const progress = JSON.parse(
          await runtime.notificationCommand('plugin-install-progress', '{}'),
        ) as NotificationPluginInstallProgress | null;
        if (progress && (finished || (active && progress.running))) onProgress?.(progress);
      } catch {
        // Progress is best effort; the installation reports its own errors.
      }
    };
    const poll = async () => {
      await readProgress();
      if (active) timer = setTimeout(() => { void poll(); }, INSTALL_PROGRESS_POLL_MS);
    };
    const installation = runtime.notificationCommand('plugin-install', '{}');
    if (onProgress) void poll();
    try {
      await installation;
    } finally {
      active = false;
      clearTimeout(timer);
      if (onProgress) await readProgress(true);
    }
    for (const listener of listeners) listener();
  });
}

export function uninstallNotificationPlugin(hostId: string): Promise<void> {
  return serial(async () => {
    const runtime = connectedRuntime(hostId);
    let cleanupFailed = false;
    try {
      await disableRegistration(hostId, true);
    } catch (failure) {
      if ((await load()).some(r => r.hostId === hostId && r.enabled))
        throw failure;
      // Disabling commits locally first. Even if the relay is down, remove the
      // host hooks now and retain its management capability for a later retry.
      cleanupFailed = true;
    }
    await runtime.notificationCommand('plugin-uninstall', '{}');
    for (const listener of listeners) listener();
    if (cleanupFailed)
      throw new Error(
        'Host plugin uninstalled; retry Unregister to finish this device’s relay cleanup',
      );
  });
}
subscribeNotificationRuntimeChanges((hostId, runtime) => {
  for (const listener of listeners) listener();
  if (!runtime) return;
  bestEffortCleanup(
    serial(async () => {
      const values = await load();
      const registration = values.find(r => r.hostId === hostId);
      if (registration?.pendingHostRemoval) {
        await runtime.notificationCommand(
          'unregister',
          JSON.stringify({
            paths: registration.paths,
            device_id: registration.deviceId,
          }),
        );
        await save(
          values.flatMap(r =>
            r !== registration
              ? [r]
              : registration.forgetAfterHostRemoval && registration.relayRevoked
                ? []
                : [{ ...r, pendingHostRemoval: false }],
          ),
        );
      }
    }),
    'notification-host-cleanup',
  );
});

export function enableRemoteNotifications(
  hostId: string,
  relayUrl: string,
  endToEndEncrypted?: boolean,
): Promise<void> {
  return serial(async () => {
    const runtime = runtimes.get(hostId);
    if (!runtime)
      throw new Error(
        'Connect to this saved host before enabling remote notifications',
      );
    const values = await load();
    const previous = values.find(r => r.hostId === hostId);
    if (previous && (!previous.relayRevoked || previous.pendingHostRemoval))
      throw new Error(
        'Finish disabling the previous registration before rotating keys',
      );
    const expoToken = await pushToken();
    const discovery = JSON.parse(
      await runtime.notificationCommand('discover', '{}'),
    ) as Discovery;
    const encrypted = endToEndEncrypted ?? await encryptionPreference(hostId, previous);
    requirePreviewSupport(discovery.paths, encrypted);
    // Verify local persistence before either remote side can start sending.
    await appStorage.setItem(ENCRYPTION_PREFERENCE + hostId, String(encrypted));
    const keys = JSON.parse(notificationKeyGenerate()) as Keys;
    const registration: Registration = {
      hostId,
      deviceId: notificationTokenGenerate(),
      keys,
      hostKey: discovery.identity.public_key,
      hostIdentity: discovery.identity.host_id,
      managementToken: notificationTokenGenerate(),
      routeToken: notificationTokenGenerate(),
      relayUrl: origin(relayUrl),
      session: discovery.session,
      paths: discovery.paths,
      enabled: false,
      pendingHostRemoval: false,
      relayRevoked: false,
      endToEndEncrypted: encrypted,
    };
    // Commit keys and management capability before either remote side can send.
    const next = [...values.filter(r => r.hostId !== hostId), registration];
    await save(next);
    try {
      await verifyRelayRegistration(registration, expoToken);
    } catch (failure) {
      // A failed ownership check must leave no active or pending relay route.
      // Retain the management capability if the relay cannot confirm cleanup.
      try {
        await relay(registration, 'DELETE');
        registration.relayRevoked = true;
        await save(next);
      } catch {
        // Disable/Unregister can retry with the securely retained capability.
      }
      throw failure;
    }
    await registerHost(registration, runtime);
    await save(
      next.map(r => (r === registration ? { ...r, enabled: true } : r)),
    );
  });
}

export function disableRemoteNotifications(
  hostId: string,
  forget = false,
): Promise<void> {
  return serial(() => disableRegistration(hostId, forget));
}

async function disableRegistration(
  hostId: string,
  forget: boolean,
): Promise<void> {
  const values = await load();
  const registration = values.find(r => r.hostId === hostId);
  if (!registration) return;
  // Stop local acceptance and heartbeats even if the relay is unavailable.
  const disabled = {
    ...registration,
    enabled: false,
    pendingHostRemoval: true,
    forgetAfterHostRemoval: forget,
  };
  await save(values.map(r => (r === registration ? disabled : r)));
  await relay(registration, 'DELETE');
  await appStorage.removeItem(REPLAYS + registration.deviceId);
  disabled.relayRevoked = true;
  if (forget) disabled.keys = { ...disabled.keys, private_key: '' };
  const runtime = runtimes.get(hostId);
  if (runtime) {
    await runtime.notificationCommand(
      'unregister',
      JSON.stringify({
        paths: registration.paths,
        device_id: registration.deviceId,
      }),
    );
    disabled.pendingHostRemoval = false;
  }
  // Retain an SSH cleanup tombstone while the host is disconnected.
  await save(
    values.flatMap(r =>
      r !== registration
        ? [r]
        : forget && !disabled.pendingHostRemoval
          ? []
          : [disabled],
    ),
  );
}

export async function renewNotificationLeases(): Promise<void> {
  const registrations = await load();
  await Promise.all(
    registrations
      .filter(r => r.enabled)
      .map(async registration => {
        const runtime = runtimes.get(registration.hostId);
        if (!runtime) return;
        try {
          await runtime.notificationCommand(
            'renew',
            JSON.stringify({
              paths: registration.paths,
              device_id: registration.deviceId,
            }),
          );
        } catch {
          /* Fail toward remote delivery; never interfere with local alerts. */
        }
      }),
  );
}
export function refreshRemotePushTokens(): Promise<void> {
  return serial(async () => {
    const registrations = (await load()).filter(r => r.enabled);
    if (!registrations.length) return;
    const token = await pushToken();
    await Promise.all(
      registrations.map(r => verifyRelayRegistration(r, token)),
    );
  });
}

export function remoteNotificationTarget(
  data: Record<string, unknown>,
  notificationId: string,
): Promise<AgentNotificationTarget | null> {
  return serial(async () => {
    const payload = data[REMOTE_FIELD];
    if (!payload) return null;
    const envelope = payload as { header?: { device_id?: string } };
    const registration = (await load()).find(
      r => r.enabled && r.deviceId === envelope.header?.device_id,
    );
    if (!registration)
      throw new Error('Notification registration is unavailable or revoked');
    const opened = JSON.parse(
      notificationOpen(
        JSON.stringify(registration.keys),
        registration.hostKey,
        registration.deviceId,
        JSON.stringify(payload),
        (await appStorage.getItem(REPLAYS + registration.deviceId)) || '{}',
      ),
    ) as {
      event: { pane_id: string; session: string };
      ledger: Record<string, number>;
    };
    if (opened.event.session !== registration.session)
      throw new Error('Notification session mismatch');
    // Durable replay receipt before reconnecting or navigating, including cold starts.
    await appStorage.setItem(
      REPLAYS + registration.deviceId,
      JSON.stringify(opened.ledger),
    );
    return {
      notificationId,
      hostId: registration.hostId,
      paneId: opened.event.pane_id,
      remoteDeviceId: registration.deviceId,
    };
  });
}
export function isRemoteNotification(
  data: Record<string, unknown> | undefined,
): boolean {
  return Boolean(data?.[REMOTE_FIELD]);
}

/** Recheck the SSH endpoint and session after reconnect, including edited saved profiles. */
export function verifyRemoteNotificationHost(
  hostId: string,
  deviceId: string,
  runtime: import('./notificationRuntimeRegistry').NotificationRuntime,
): Promise<void> {
  return serial(async () => {
    const registration = (await load()).find(
      r => r.enabled && r.hostId === hostId && r.deviceId === deviceId,
    );
    if (!registration) throw new Error('Notification registration was revoked');
    await discoverRegisteredHost(registration, runtime);
  });
}

async function discoverRegisteredHost(registration: Registration, runtime: NotificationRuntime): Promise<Discovery> {
  const discovery = JSON.parse(await runtime.notificationCommand('discover', '{}')) as Discovery;
  if (discovery.identity.public_key !== registration.hostKey ||
      discovery.identity.host_id !== registration.hostIdentity ||
      discovery.session !== registration.session)
    throw new Error('The notification host or Herdr session changed; register this device again');
  return discovery;
}
