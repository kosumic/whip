import {
  DeviceEventEmitter,
  Linking,
  NativeModules,
  Platform,
} from 'react-native';

export type ShizukuStatus =
  | 'unavailable'
  | 'not_installed'
  | 'stopped'
  | 'unsupported'
  | 'permission_required'
  | 'denied'
  | 'ready';

interface ShizukuNativeModule {
  getStatus(): Promise<ShizukuStatus>;
  requestPermission(): Promise<ShizukuStatus>;
  openManager(): Promise<void>;
  diagnostics(): Promise<ShizukuDiagnostics>;
  execute(
    sessionId: string,
    requestId: string,
    argv: string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<string>;
  cancelRequest(requestId: string): void;
  releaseSession(sessionId: string): void;
}

export interface ShizukuDiagnostics {
  status: ShizukuStatus;
  authorized: boolean;
  backend: 'shizuku' | 'sui' | null;
  uid: number | null;
  server_version: number | null;
}

export async function getShizukuDiagnostics(): Promise<ShizukuDiagnostics> {
  const native = nativeModule();
  return (
    native?.diagnostics?.() ?? {
      status: 'unavailable',
      authorized: false,
      backend: null,
      uid: null,
      server_version: null,
    }
  );
}

export async function executeShizukuCommand(
  sessionId: string,
  requestId: string,
  argv: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<unknown> {
  const native = nativeModule();
  if (!native?.execute) {
    throw Object.assign(
      new Error(
        'Privileged tools require an updated Android Whip build and Shizuku',
      ),
      { code: 'device_unavailable' },
    );
  }
  return JSON.parse(
    await native.execute(sessionId, requestId, argv, timeoutMs, maxOutputBytes),
  ) as unknown;
}

export function cancelShizukuCommand(requestId: string): void {
  nativeModule()?.cancelRequest?.(requestId);
}
export function releaseShizukuSession(sessionId: string): void {
  nativeModule()?.releaseSession?.(sessionId);
}

const STATUS_EVENT = 'whipShizukuStatus';
const SHIZUKU_DOWNLOAD_URL = 'https://shizuku.rikka.app/download/';
const nativeModule = (): ShizukuNativeModule | undefined =>
  Platform.OS === 'android'
    ? (NativeModules.WhipShizuku as ShizukuNativeModule | undefined)
    : undefined;

export async function getShizukuStatus(): Promise<ShizukuStatus> {
  return nativeModule()?.getStatus() ?? 'unavailable';
}

export async function pairShizuku(): Promise<ShizukuStatus> {
  return nativeModule()?.requestPermission() ?? 'unavailable';
}

export async function openShizukuManager(): Promise<void> {
  const native = nativeModule();
  if (!native) throw new Error('Shizuku is unavailable in this build');
  await native.openManager();
}

export async function downloadShizuku(): Promise<void> {
  await Linking.openURL(SHIZUKU_DOWNLOAD_URL);
}

export function subscribeToShizukuStatus(
  listener: (status: ShizukuStatus) => void,
): () => void {
  if (!nativeModule()) return () => undefined;
  const subscription = DeviceEventEmitter.addListener(STATUS_EVENT, listener);
  return () => subscription.remove();
}
