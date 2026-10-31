/** Transport-only attachment registry. Importing SSH never loads push SDKs or keys. */
export interface NotificationRuntime {
  readonly runtimeId: string;
  readonly runtimeIncarnation: number;
}
export const notificationRuntimes = new Map<string, NotificationRuntime>();
const listeners = new Set<
  (
    hostId: string,
    runtime?: NotificationRuntime,
    previous?: NotificationRuntime,
  ) => void
>();
export function subscribeNotificationRuntimeChanges(
  listener: (
    hostId: string,
    runtime?: NotificationRuntime,
    previous?: NotificationRuntime,
  ) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function bindNotificationRuntime(
  hostId: string,
  runtime: NotificationRuntime,
): void {
  notificationRuntimes.set(hostId, runtime);
  for (const listener of listeners) listener(hostId, runtime);
}
export function unbindNotificationRuntime(
  hostId: string,
  runtime: NotificationRuntime,
): void {
  if (notificationRuntimes.get(hostId) !== runtime) return;
  notificationRuntimes.delete(hostId);
  for (const listener of listeners) listener(hostId, undefined, runtime);
}
