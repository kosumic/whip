import {
  BrowserOperationCoordinator,
  BrowserPlatformAction_Tags,
  BrowserPlatformError,
  type BrowserEffectPermitLike,
  type BrowserOperationPlatform,
} from 'react-native-whip-ssh/src/browserOperations';

import type { BrowserRegistry } from './registry';

/** WebView/mount and OS cancellation handles, without an agent request queue. */
export function browserOperationPlatform(registry: BrowserRegistry) {
  const handles = new Map<string, AbortController>();
  const effect = async <T>(permit: BrowserEffectPermitLike, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const id = permit.effectId();
    const abort = new AbortController();
    handles.set(id, abort);
    try {
      permit.checkActive();
      const value = await run(abort.signal);
      permit.checkActive();
      return value;
    } finally {
      handles.delete(id);
    }
  };
  const controller = (id: string) => {
    const entry = registry.entries.get(id);
    if (!entry) throw new BrowserPlatformError.Unavailable();
    return entry.controller;
  };
  const platform: BrowserOperationPlatform = {
    ensureSession: async (permit, owner, activateRoute) => {
      try {
        await effect(permit, async () => {
          await registry.loadArchive();
          permit.checkActive();
          if (!registry.entries.has(owner.sessionId)) {
            const runtime = registry.runtime(owner.runtimeId);
            if (!runtime) throw new BrowserPlatformError.Unavailable();
            registry.ensure(owner, runtime);
          }
          if (activateRoute) await controller(owner.sessionId).activateAgentRoute(permit);
        });
      } catch { throw new BrowserPlatformError.Unavailable(); }
    },
    prepareTab: async (permit, id, tabId, resume, navigation) => {
      try { await effect(permit, signal => controller(id).prepareAgentTab(permit, tabId, resume, navigation, signal)); }
      catch { throw new BrowserPlatformError.Unavailable(); }
    },
    perform: async (permit, id, action) => {
      try { return await effect(permit, signal => controller(id).agentEffect(permit, action, signal)); }
      catch {
        if (action.tag === BrowserPlatformAction_Tags.Evaluate) throw new BrowserPlatformError.EvalFailed();
        if (action.tag === BrowserPlatformAction_Tags.Download) throw new BrowserPlatformError.DownloadFailed();
        throw new BrowserPlatformError.Unavailable();
      }
    },
    cancel: id => handles.get(id)?.abort(),
    changed: id => registry.entries.get(id)?.controller.synchronize(),
  };
  return {
    platform,
    dispose: () => {
      for (const handle of handles.values()) handle.abort();
      handles.clear();
    },
  };
}

export class BrowserOperations {
  private readonly native: BrowserOperationCoordinator;
  private readonly disposeHandles: () => void;
  constructor(registry: BrowserRegistry) {
    const { platform, dispose } = browserOperationPlatform(registry);
    this.native = new BrowserOperationCoordinator(platform);
    this.disposeHandles = dispose;
  }
  dispose() { this.native.close(); this.disposeHandles(); }
}
