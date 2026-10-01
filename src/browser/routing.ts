import { browserLibrary } from './library';
import { configureBrowserProxy, supportsBrowserProxy } from './native';
import type { BrowserRuntime } from './registry';

export interface BrowserHost {
  id: string;
  label: string;
}
async function stopProxy(runtime: BrowserRuntime, port: number) {
  if (runtime.stopBrowserProxy)
    await Promise.allSettled([runtime.stopBrowserProxy(port)]);
}

/** Android proxy changes are serialized; old documents are stopped before the switch. */
export class BrowserRouting {
  runtimeId: string | null = null;
  ready = true;
  private active: { runtime: BrowserRuntime; port: number } | null = null;
  private queue = Promise.resolve();
  constructor(
    private lookup: (
      id: string,
    ) => { runtime: BrowserRuntime; host: BrowserHost } | undefined,
    private invalidate: () => void,
  ) {}
  allows(runtimeId: string): boolean {
    if (!this.ready) return false;
    if (this.runtimeId) return this.runtimeId === runtimeId;
    const owner = this.lookup(runtimeId);
    return !!owner && !browserLibrary.tunneling(owner.host.id);
  }
  activate(runtimeId: string): Promise<void> {
    const operation = this.queue.then(async () => {
      await browserLibrary.load();
      const owner = this.lookup(runtimeId);
      if (!owner) throw new Error('Connect to this host to browse.');
      const enabled = browserLibrary.tunneling(owner.host.id);
      if (!supportsBrowserProxy()) {
        if (enabled)
          throw new Error(
            'Browser tunneling requires an Android WebView with proxy support.',
          );
        return;
      }
      if (
        this.ready &&
        this.active &&
        ((!enabled && this.active.port === 0) ||
          (enabled &&
            this.active.runtime === owner.runtime &&
            this.active.port > 0))
      )
        return;
      // A failed proxy stays blocked, never falls back to the phone connection.
      this.runtimeId = runtimeId;
      this.ready = false;
      this.invalidate();
      await configureBrowserProxy('', -1);
      const previous = this.active;
      this.active = null;
      if (previous?.port) await stopProxy(previous.runtime, previous.port);
      const port = enabled ? await owner.runtime.startBrowserProxy?.() : 0;
      if (typeof port !== 'number' || (enabled && port <= 0))
        throw new Error('SSH browser proxy is unavailable.');
      if (this.lookup(runtimeId)?.runtime !== owner.runtime) {
        if (port) await stopProxy(owner.runtime, port);
        throw new Error('Host disconnected while preparing the browser.');
      }
      try {
        await configureBrowserProxy(enabled ? runtimeId : '*', port);
      } catch (error) {
        if (port) await stopProxy(owner.runtime, port);
        throw error;
      }
      this.active = { runtime: owner.runtime, port };
      this.runtimeId = enabled ? runtimeId : null;
      this.ready = true;
      this.invalidate();
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async setTunneling(runtimeId: string, enabled: boolean) {
    const owner = this.lookup(runtimeId);
    if (!owner) throw new Error('Host disconnected.');
    await browserLibrary.setTunneling(owner.host.id, enabled);
    await this.activate(runtimeId);
  }
  async disconnect(runtimeId: string) {
    if (this.active?.runtime.runtimeId !== runtimeId) return;
    const previous = this.active;
    if (previous.port === 0) {
      this.active = null;
      return;
    }
    // Keep the dead proxy configured until another route is explicitly activated.
    this.active = null;
    this.runtimeId = runtimeId;
    this.ready = false;
    await configureBrowserProxy('', -1);
    if (previous.port) await stopProxy(previous.runtime, previous.port);
    this.invalidate();
  }
}
