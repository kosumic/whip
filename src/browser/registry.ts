import { bestEffortCleanup } from '../services/backgroundOperations';
import { isLiveHostSshConnected } from '../lib/liveHostLatency';
import { closeDeviceSession, deviceAction } from './device';
import type { LiveHostSession } from '../liveHostSessions';
import { BrowserRouting, type BrowserHost } from './routing';
import {
  BROWSER_ACTION_TIMEOUT_MS,
  BrowserController,
  MAX_BROWSER_VIEWS,
  type BrowserAction,
  type PreviewTransport,
} from './controller';
import {
  browserArchive,
  type BrowserArchive,
  type SavedBrowserSession,
} from './archive';

export interface BrowserSessionIdentity {
  runtimeId: string;
  sessionId: string;
  paneId: string;
  terminalId: string;
}
export interface BrowserBridgeEvent {
  session: BrowserSessionIdentity;
  kind: string;
  requestId: string;
  action: string;
  argumentsJson: string;
}
export interface BrowserRuntime extends PreviewTransport {
  readonly runtimeId: string;
  startBrowserProxy?(): Promise<number>;
  stopBrowserProxy?(port: number): Promise<void>;
  reverseControlSessions(): BrowserSessionIdentity[];
  hostState?(): {
    freshness: string;
    syncStatus: string;
    snapshot?: { panes: { pane_id: string; terminal_id: string }[] };
  };
  reverseControlReply(
    sessionId: string,
    requestId: string,
    resultJson: string,
  ): void;
}

/** Snapshot freshness can change while the SSH browser session remains live. */
export function connectedBrowserRuntimes(
  sessions: readonly (Pick<LiveHostSession, 'id' | 'status'> &
    Partial<Pick<LiveHostSession, 'hostId' | 'host'>>)[],
  getRuntime: (id: string) => BrowserRuntime | undefined,
): BrowserRuntime[] {
  return sessions.flatMap(session => {
    if (!isLiveHostSshConnected(session.status)) return [];
    const runtime = getRuntime(session.id);
    if (runtime && session.hostId)
      runtimeHosts.set(runtime, {
        id: session.hostId,
        label: session.host?.name || session.host?.host || 'SSH host',
      });
    return runtime ? [runtime] : [];
  });
}
const runtimeHosts = new WeakMap<BrowserRuntime, BrowserHost>();
export interface BrowserEntry {
  identity: BrowserSessionIdentity;
  controller: BrowserController;
  reverseControl: boolean;
  unsubscribe: () => void;
}

export class BrowserRegistry {
  readonly entries = new Map<string, BrowserEntry>();
  visibleId: string | null = null;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly calls = new Map<string, AbortController>();
  private readonly runtimes = new Map<string, BrowserRuntime>();
  readonly routing?: BrowserRouting;
  constructor(
    private readonly archive?: BrowserArchive,
    routeNetworks = false,
  ) {
    if (routeNetworks)
      this.routing = new BrowserRouting(
        id => {
          const runtime = this.runtimes.get(id);
          return runtime
            ? { runtime, host: runtimeHosts.get(runtime) || { id, label: id } }
            : undefined;
        },
        () => {
          for (const entry of this.entries.values())
            entry.controller.resetRoute();
          this.changed();
        },
      );
  }
  host(runtimeId: string): BrowserHost | undefined {
    const runtime = this.runtimes.get(runtimeId);
    return runtime
      ? runtimeHosts.get(runtime) || { id: runtimeId, label: runtimeId }
      : undefined;
  }
  loadArchive = () => this.archive?.load() || Promise.resolve();
  registerRuntimes(runtimes: readonly BrowserRuntime[]) {
    const changed =
      runtimes.length !== this.runtimes.size ||
      runtimes.some(
        runtime => this.runtimes.get(runtime.runtimeId) !== runtime,
      );
    this.runtimes.clear();
    for (const runtime of runtimes)
      this.runtimes.set(runtime.runtimeId, runtime);
    if (changed) this.changed();
  }
  canRestore = (record: SavedBrowserSession) =>
    this.runtimes.has(record.runtimeId);
  async restore(record: SavedBrowserSession) {
    if (this.entries.has(record.id)) {
      this.open(record.id);
      return;
    }
    const runtime = this.runtimes.get(record.runtimeId);
    if (!runtime)
      throw new Error('Connect to this host to restore its browser tabs.');
    // Restore for the user. A saved location never grants an old agent MCP access.
    const entry = this.ensure(
      {
        runtimeId: record.runtimeId,
        sessionId: 'restored-' + record.id,
        paneId: '',
        terminalId: '',
      },
      runtime,
      false,
    );
    try {
      entry.controller.restoreTabs(record.tabs, record.selected);
      this.open(entry.identity.sessionId);
      this.archive?.remove(record.id);
    } catch (error) {
      await this.close(entry.identity.sessionId);
      throw error;
    }
  }
  private save(entry: BrowserEntry) {
    this.archive?.save({
      id: entry.identity.sessionId,
      runtimeId: entry.identity.runtimeId,
      paneId: entry.identity.paneId,
      terminalId: entry.identity.terminalId,
      selected: entry.controller.tabs.findIndex(
        tab => tab.id === entry.controller.selectedTabId,
      ),
      tabs: entry.controller.tabs.map(tab => ({
        url: tab.url,
        title: tab.title,
      })),
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  changed = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  totalTabs = () =>
    [...this.entries.values()].reduce(
      (total, entry) => total + entry.controller.tabs.length,
      0,
    );
  ensure(
    identity: BrowserSessionIdentity,
    runtime: PreviewTransport,
    reverseControl = true,
  ): BrowserEntry {
    const existing = this.entries.get(identity.sessionId);
    if (existing) {
      if (
        existing.identity.runtimeId !== identity.runtimeId ||
        existing.identity.paneId !== identity.paneId
      )
        throw new Error('Browser identity mismatch');
      return existing;
    }
    const controller = new BrowserController(
      identity.sessionId,
      runtime,
      () => this.totalTabs() < MAX_BROWSER_VIEWS,
      this.routing
        ? { activate: () => this.routing!.activate(identity.runtimeId) }
        : undefined,
    );
    const entry: BrowserEntry = {
      identity,
      controller,
      reverseControl,
      unsubscribe: () => undefined,
    };
    entry.unsubscribe = controller.subscribe(() => {
      this.save(entry);
      this.changed();
    });
    this.entries.set(identity.sessionId, entry);
    this.changed();
    return entry;
  }
  forPane(runtimeId: string, paneId: string | undefined) {
    return [...this.entries.values()].find(
      entry =>
        entry.reverseControl &&
        entry.identity.runtimeId === runtimeId &&
        entry.identity.paneId === paneId,
    );
  }
  open(id: string) {
    if (!this.entries.has(id)) {
      throw new Error('Browser session closed');
    }
    this.visibleId = id;
    const controller = this.entries.get(id)!.controller;
    if (controller.selectedTabId) controller.touch(controller.selectedTabId);
    this.changed();
  }
  hide() {
    this.visibleId = null;
    this.changed();
  }
  async close(id: string) {
    closeDeviceSession(id);
    for (const [key, call] of this.calls)
      if (key.startsWith(id + ':')) {
        call.abort();
        this.calls.delete(key);
      }
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.archive?.remove(id);
    entry.unsubscribe();
    if (this.visibleId === id) {
      this.visibleId = null;
    }
    this.changed();
    await entry.controller.dispose();
  }
  async closeTerminal(runtimeId: string, terminalId: string) {
    await Promise.all(
      [...this.entries.values()]
        .filter(
          entry =>
            entry.identity.runtimeId === runtimeId &&
            entry.identity.terminalId === terminalId,
        )
        .map(entry => this.close(entry.identity.sessionId)),
    );
  }
  async closeHost(runtimeId: string) {
    await this.routing?.disconnect(runtimeId);
    await Promise.all(
      [...this.entries.values()]
        .filter(entry => entry.identity.runtimeId === runtimeId)
        .map(entry => this.close(entry.identity.sessionId)),
    );
    const visible = this.visibleId
      ? this.entries.get(this.visibleId)
      : undefined;
    if (
      visible &&
      visible.identity.runtimeId !== runtimeId &&
      this.routing &&
      !this.routing.ready
    )
      await this.routing.activate(visible.identity.runtimeId);
  }
  reconcile(runtime: BrowserRuntime) {
    const sessions = runtime.reverseControlSessions();
    const authorized = new Set(sessions.map(session => session.sessionId));
    const host = runtime.hostState?.();
    if (
      host?.freshness === 'fresh' &&
      host.syncStatus === 'synced' &&
      host.snapshot
    ) {
      for (const entry of this.entries.values()) {
        if (
          !entry.reverseControl &&
          entry.identity.runtimeId === runtime.runtimeId &&
          entry.identity.paneId &&
          !host.snapshot.panes.some(
            pane =>
              pane.pane_id === entry.identity.paneId &&
              pane.terminal_id === entry.identity.terminalId,
          )
        ) {
          bestEffortCleanup(
            this.close(entry.identity.sessionId),
            'browser-preview-pane-close',
          );
        }
      }
    }
    for (const entry of this.entries.values())
      if (
        entry.reverseControl &&
        entry.identity.runtimeId === runtime.runtimeId &&
        !authorized.has(entry.identity.sessionId)
      )
        bestEffortCleanup(
          this.close(entry.identity.sessionId),
          'browser-reconcile-close',
        );
    for (const identity of sessions) this.ensure(identity, runtime);
  }
  async event(event: BrowserBridgeEvent, runtime: BrowserRuntime) {
    const id = event.session.sessionId;
    if (event.session.runtimeId !== runtime.runtimeId) return;
    if (event.kind === 'closed') {
      await this.close(id);
      return;
    }
    if (event.kind === 'cancel') {
      this.calls.get(id + ':' + event.requestId)?.abort();
      return;
    }
    if (event.kind === 'release') {
      this.entries.get(id)?.controller.releaseLease(event.requestId);
      return;
    }
    if (event.kind === 'opened') {
      if (
        runtime
          .reverseControlSessions()
          .some(
            session =>
              session.sessionId === id &&
              session.paneId === event.session.paneId,
          )
      )
        this.ensure(event.session, runtime);
      return;
    }
    if (event.kind !== 'action') return;
    const key = id + ':' + event.requestId;
    const abort = new AbortController();
    this.calls.set(key, abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, BROWSER_ACTION_TIMEOUT_MS);
    let response: unknown;
    try {
      const authorized = runtime
        .reverseControlSessions()
        .some(
          session =>
            session.sessionId === id && session.paneId === event.session.paneId,
        );
      if (!authorized) throw new Error('Browser session is not authorized');
      const args = JSON.parse(event.argumentsJson) as Record<string, unknown>;
      const result = event.action.startsWith('device.')
        ? await deviceAction(
            event.action,
            args,
            key,
            abort.signal,
            event.session,
          )
        : await this.ensure(event.session, runtime).controller.action(
            event.action as BrowserAction,
            {
              ...args,
              primitive: true,
            },
            abort.signal,
          );
      response = { ok: true, value: result };
    } catch (error) {
      const message = timedOut
        ? 'Browser action timed out'
        : error instanceof Error
          ? error.message
          : 'Browser action failed';
      const deviceCode =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      const code =
        event.action.startsWith('device.') &&
        typeof deviceCode === 'string' &&
        [
          'device_unavailable',
          'permission_denied',
          'unauthorized',
          'location_unavailable',
          'sensor_unavailable',
          'timeout',
          'cancelled',
          'unknown_action',
          'invalid_argument',
        ].includes(deviceCode)
          ? deviceCode
          : error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'stale_page'
            ? 'stale_page'
            : timedOut || message.includes('timed out')
              ? 'timeout'
              : message.includes('cancelled')
                ? 'cancelled'
                : message.includes('not authorized')
                  ? 'unauthorized'
                  : message.includes('limit')
                    ? 'tab_limit'
                    : message.includes('tab closed')
                      ? 'tab_closed'
                      : message.includes('session closed')
                        ? 'session_closed'
                        : event.action.startsWith('device.')
                          ? 'device_unavailable'
                          : 'browser_unavailable';
      response = { ok: false, error: { code, message } };
    } finally {
      clearTimeout(timer);
      this.calls.delete(key);
    }
    runtime.reverseControlReply(id, event.requestId, JSON.stringify(response));
  }
}
export const browserRegistry = new BrowserRegistry(browserArchive, true);
