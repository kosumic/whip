import { settledPromise } from './promises';

export type SavedHostConnectionAction = 'select' | 'wait' | 'connect';

export function savedHostConnectionAction(
  status: string | undefined,
  hasRuntime: boolean,
): SavedHostConnectionAction {
  if (hasRuntime) return 'select';
  return status === 'connecting' ? 'wait' : 'connect';
}

export function shouldRetainBackgroundRuntimes(
  platform: string,
  monitoringEnabled: boolean,
  liveHostCount: number,
): boolean {
  return platform === 'android' && monitoringEnabled && liveHostCount > 0;
}

export interface ReleasableRuntime {
  client: {
    disconnect: () => Promise<void>;
    terminal: {
      releaseAllTerminals: () => void;
    };
  };
}

// Module scope keeps teardown visible across session-manager unmount/remount cycles.
const runtimeDestructions = new Map<string, Promise<void>>();

export function destroyRuntime(
  runtimeId: string,
  runtime: ReleasableRuntime,
): Promise<void> {
  const previous = runtimeDestructions.get(runtimeId) ?? Promise.resolve();
  const destruction = settledPromise(previous)
    .then(async () => {
      try {
        runtime.client.terminal.releaseAllTerminals();
      } finally {
        await runtime.client.disconnect();
      }
    });
  runtimeDestructions.set(runtimeId, destruction);
  const removeDestruction = () => {
    if (runtimeDestructions.get(runtimeId) === destruction) {
      runtimeDestructions.delete(runtimeId);
    }
  };
  destruction.then(removeDestruction, removeDestruction);
  return destruction;
}

export function waitForRuntimeDestruction(runtimeId: string): Promise<void> {
  return runtimeDestructions.get(runtimeId) ?? Promise.resolve();
}

export function disposeRuntimeMap<Runtime extends ReleasableRuntime>(
  target: Map<string, Runtime>,
): Promise<void> {
  const destructions = [...target].map(([runtimeId, runtime]) =>
    destroyRuntime(runtimeId, runtime),
  );
  target.clear();
  return Promise.all(destructions).then(() => undefined);
}
