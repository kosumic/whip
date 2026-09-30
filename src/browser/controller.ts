import { browserDomScript } from './dom';
import { terminalWebLinkTarget } from '../lib/terminalLinks';
import { browserAddress } from './address';

export const MAX_BROWSER_TABS = 3;
export const MAX_BROWSER_VIEWS = 9;
export const BROWSER_ACTION_TIMEOUT_MS = 15000;
const BROWSER_RENDERER_STOPPED_MESSAGE =
  'Browser renderer stopped. Reload this tab to restore its page.';
export type BrowserAction =
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'reload'
  | 'list_tabs'
  | 'new_tab'
  | 'close_tab'
  | 'wait_for_dom';
export interface BrowserDriver {
  evaluate(script: string): Promise<unknown>;
  documentState(): Promise<BrowserDocumentState | null>;
  screenshot(): Promise<string>;
  navigate(url: string): void | Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  clearData(): Promise<void>;
}
export interface BrowserDocumentState {
  id: string;
  url: string;
  ready: boolean;
}
export interface PreviewTransport {
  startWebPreview(url: string): Promise<{ id: string; url: string }>;
  stopPreview(id: string): Promise<void>;
}
export interface BrowserTab {
  id: string;
  source: string;
  url: string;
  title: string;
  loading: boolean;
  loadError: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  generation: number;
  viewGeneration: number;
  lifecycle: 'active' | 'suspended' | 'crashed';
  lastUsedAt: number;
  driver: BrowserDriver | null;
  previews: Map<string, { id: string; local: string; remote: string }>;
}
function publicUrl(value: string) {
  if (value === 'about:blank') return value;
  const url = new URL(value);
  return url.origin + url.pathname;
}
function requireString(
  args: Record<string, unknown>,
  name: string,
  maximum = 16384,
): string {
  const value = args[name];
  if (typeof value !== 'string' || !value || value.length > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
}

/** Owns mounted tab handles; presentation only selects or hides this controller. */
export class BrowserController {
  readonly tabs: BrowserTab[] = [];
  selectedTabId = '';
  disposed = false;
  private nextTab = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private readonly domKey: string;
  private readonly previews: PreviewTransport;
  private readonly busyTabs = new Set<string>();
  constructor(
    readonly id: string,
    previews: PreviewTransport,
    private readonly admit: () => boolean = () => true,
  ) {
    this.previews = previews;
    this.domKey = '__whip_browser_' + id;
    if (this.admit()) this.newTab();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private ensureLive() {
    if (this.disposed) throw new Error('Browser session closed');
  }
  tab(id = this.selectedTabId): BrowserTab {
    this.ensureLive();
    const tab = this.tabs.find(item => item.id === id);
    if (!tab) throw new Error('Browser tab closed or unknown');
    return tab;
  }
  select(id: string) {
    this.touch(id);
    this.selectedTabId = id;
    this.changed();
  }
  newTab() {
    this.ensureLive();
    if (this.tabs.length >= MAX_BROWSER_TABS || !this.admit())
      throw new Error('Browser tab limit reached; close a tab first');
    const id = `${this.id}-tab-${++this.nextTab}`;
    this.tabs.push({
      id,
      source: 'about:blank',
      url: 'about:blank',
      title: '',
      loading: false,
      loadError: null,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
      viewGeneration: 0,
      lifecycle: 'active',
      lastUsedAt: Date.now(),
      driver: null,
      previews: new Map(),
    });
    this.selectedTabId = id;
    this.changed();
    return this.tab(id);
  }
  attach(id: string, driver: BrowserDriver | null, viewGeneration?: number) {
    const tab = this.tabs.find(item => item.id === id);
    if (
      tab &&
      (viewGeneration === undefined || viewGeneration === tab.viewGeneration)
    ) {
      tab.driver = driver;
      this.changed();
    }
  }
  touch(id: string) {
    this.tab(id).lastUsedAt = Date.now();
  }
  rendererGone(
    id: string,
    viewGeneration: number,
    message = BROWSER_RENDERER_STOPPED_MESSAGE,
  ) {
    const tab = this.tabs.find(item => item.id === id);
    if (viewGeneration !== tab?.viewGeneration) return;
    tab.generation++;
    tab.viewGeneration++;
    tab.driver = null;
    tab.lifecycle = 'crashed';
    tab.loading = false;
    tab.loadError = message;
    this.changed();
  }
  async suspendInactive(cutoff: number, visibleTabId?: string) {
    const stopped: Promise<void>[] = [];
    for (const tab of this.tabs) {
      if (
        tab.lifecycle !== 'active' ||
        tab.id === visibleTabId ||
        this.busyTabs.has(tab.id) ||
        tab.lastUsedAt > cutoff
      )
        continue;
      tab.lifecycle = 'suspended';
      tab.driver = null;
      tab.loading = false;
      tab.generation++;
      tab.viewGeneration++;
      // A suspended renderer loses history; its old forwards are no longer used.
      for (const preview of tab.previews.values())
        stopped.push(this.previews.stopPreview(preview.id));
      tab.previews.clear();
      this.changed();
    }
    await Promise.all(stopped);
  }
  restoreTabs(
    tabs: readonly { url: string; title: string }[],
    selected: number,
  ) {
    for (const [index, saved] of tabs.entries()) {
      const tab = index === 0 ? this.tabs[0] : this.newTab();
      if (!tab) throw new Error('Browser tab limit reached');
      tab.url = saved.url;
      tab.title = saved.title;
      tab.lifecycle = 'suspended';
    }
    this.selectedTabId = this.tabs[selected]?.id || this.tabs[0]?.id || '';
    this.changed();
  }
  loadStart(id: string) {
    const tab = this.tab(id);
    const notify = !tab.loading || !!tab.loadError;
    tab.generation++;
    tab.loading = true;
    tab.loadError = null;
    if (notify) this.changed();
  }
  loadEnd(id: string) {
    const tab = this.tab(id);
    if (!tab.loading) return;
    tab.loading = false;
    this.changed();
  }
  loadError(id: string, code: number) {
    const tab = this.tab(id);
    tab.loading = false;
    tab.loadError = `Browser page failed to load (WebView error ${code})`;
    this.changed();
  }
  navigation(
    id: string,
    state: {
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading?: boolean;
    },
  ) {
    const tab = this.tab(id);
    const url = this.remoteUrl(tab, state.url);
    const loading = state.loading ?? tab.loading;
    if (
      url === tab.url &&
      state.title === tab.title &&
      state.canGoBack === tab.canGoBack &&
      state.canGoForward === tab.canGoForward &&
      loading === tab.loading
    )
      return;
    if (url !== tab.url) tab.generation++;
    Object.assign(tab, {
      url,
      title: state.title,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      loading,
    });
    this.changed();
    // Keep tunnels represented in WebView history, until their tab is closed.
  }
  remoteUrl(tab: BrowserTab, value: string) {
    for (const preview of tab.previews.values()) {
      const local = new URL(preview.local);
      const url = new URL(value);
      if (url.origin === local.origin) {
        const remote = new URL(preview.remote);
        url.protocol = remote.protocol;
        url.hostname = remote.hostname;
        url.port = remote.port;
        return url.toString();
      }
    }
    return value;
  }
  isLocalPreview(id: string, value: string) {
    const tab = this.tab(id);
    return [...tab.previews.values()].some(
      preview => new URL(preview.local).origin === new URL(value).origin,
    );
  }
  private async until(
    check: () => boolean,
    signal: AbortSignal,
    timeout = BROWSER_ACTION_TIMEOUT_MS,
  ) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      this.ensureLive();
      if (signal.aborted || this.abort.signal.aborted)
        throw new Error('Browser action cancelled');
      if (Date.now() >= deadline) throw new Error('Browser action timed out');
      await new Promise<void>(resolve => setTimeout(resolve, 30));
    }
    if (signal.aborted) throw new Error('Browser action cancelled');
  }
  private async driver(tab: BrowserTab, signal: AbortSignal) {
    if (tab.lifecycle === 'suspended') return this.resume(tab, signal);
    await this.until(() => {
      this.tab(tab.id);
      if (tab.lifecycle === 'crashed')
        throw new Error(tab.loadError || BROWSER_RENDERER_STOPPED_MESSAGE);
      return !!tab.driver;
    }, signal);
    return tab.driver!;
  }
  private async waitNavigation(
    tab: BrowserTab,
    driver: BrowserDriver,
    before: BrowserDocumentState | null,
    signal: AbortSignal,
    target?: string,
    history = false,
  ) {
    const deadline = Date.now() + BROWSER_ACTION_TIMEOUT_MS;
    while (true) {
      this.ensureLive();
      this.tab(tab.id);
      if (signal.aborted) throw new Error('Browser action cancelled');
      if (tab.loadError) throw new Error(tab.loadError);
      if (Date.now() >= deadline)
        throw new Error('Browser navigation timed out');
      const state = await this.bounded(driver.documentState(), signal);
      this.tab(tab.id);
      // A document can be usable while media or other resources still load.
      // Do not mistake the old document (or a late blank-page event) for success.
      const sameDocument =
        !!target &&
        !!before &&
        target !== before.url &&
        target.split('#')[0] === before.url.split('#')[0] &&
        state?.url === target;
      const historyChanged = history && !!before && state?.url !== before.url;
      const waitingForInitialPage =
        !before && target !== 'about:blank' && state?.url === 'about:blank';
      if (
        state?.ready &&
        !waitingForInitialPage &&
        (state.id !== before?.id || sameDocument || historyChanged)
      ) {
        const observedUrl = this.remoteUrl(tab, state.url);
        if (tab.url !== observedUrl) {
          tab.url = observedUrl;
          tab.generation++;
          this.changed();
        }
        return { tab_id: tab.id, url: publicUrl(observedUrl) };
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  }
  private async resolveUrl(
    tab: BrowserTab,
    value: string,
    signal: AbortSignal,
  ) {
    const target = terminalWebLinkTarget(browserAddress(value));
    const url = new URL(target.url);
    if (target.requiresSshTunnel) {
      let preview = tab.previews.get(url.origin);
      if (!preview) {
        const started = await this.previews.startWebPreview(target.url);
        if (this.disposed || !this.tabs.includes(tab) || signal.aborted) {
          await this.previews.stopPreview(started.id);
          throw new Error('Browser navigation cancelled');
        }
        preview = { id: started.id, local: started.url, remote: target.url };
        tab.previews.set(url.origin, preview);
      }
      const local = new URL(preview.local);
      url.hostname = local.hostname;
      url.port = local.port;
    }
    return { remote: target.url, local: url.toString() };
  }
  private async resume(
    tab: BrowserTab,
    signal: AbortSignal,
  ): Promise<BrowserDriver> {
    const url =
      tab.url === 'about:blank'
        ? 'about:blank'
        : (await this.resolveUrl(tab, tab.url, signal)).local;
    this.tab(tab.id);
    if (signal.aborted) throw new Error('Browser action cancelled');
    tab.source = url;
    tab.lifecycle = 'active';
    tab.loading = url !== 'about:blank';
    tab.loadError = null;
    tab.canGoBack = false;
    tab.canGoForward = false;
    tab.generation++;
    tab.viewGeneration++;
    this.changed();
    const driver = await this.driver(tab, signal);
    if (url !== 'about:blank')
      await this.waitNavigation(tab, driver, null, signal, url);
    return driver;
  }
  private async navigate(tab: BrowserTab, value: string, signal: AbortSignal) {
    const target = await this.resolveUrl(tab, value, signal);
    if (tab.lifecycle !== 'active') {
      tab.url = target.remote;
      await this.resume(tab, signal);
      return { tab_id: tab.id, url: publicUrl(tab.url) };
    }
    const driver = await this.driver(tab, signal);
    const before = await this.bounded(driver.documentState(), signal);
    this.tab(tab.id);
    if (signal.aborted) throw new Error('Browser action cancelled');
    tab.generation++;
    tab.loading = true;
    tab.loadError = null;
    tab.url = target.remote;
    // Navigate the mounted WebView; its initial source prop remains stable.
    await this.bounded(Promise.resolve(driver.navigate(target.local)), signal);
    this.changed();
    return this.waitNavigation(tab, driver, before, signal, target.local);
  }
  private bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        cleanup();
        reject(new Error('Browser action cancelled'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Browser action timed out'));
      }, BROWSER_ACTION_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.abort.signal.removeEventListener('abort', cancel);
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted || this.abort.signal.aborted) cancel();
      operation.then(
        value => {
          cleanup();
          resolve(value);
        },
        error => {
          cleanup();
          reject(
            error instanceof Error ? error : new Error('Browser action failed'),
          );
        },
      );
    });
  }
  private async dom(
    tab: BrowserTab,
    action: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const driver = await this.driver(tab, signal);
    const generation = tab.generation;
    const raw = await this.bounded(
      driver.evaluate(
        browserDomScript(this.domKey, action, args, `${tab.id}-${generation}`),
      ),
      signal,
    );
    if (signal.aborted || this.abort.signal.aborted)
      throw new Error('Browser action cancelled');
    this.tab(tab.id);
    if (tab.generation !== generation)
      throw new Error(
        'Page changed during action; take a new browser.snapshot',
      );
    if (!raw || typeof raw !== 'object')
      throw new Error('Browser DOM unavailable');
    const result = raw as {
      ok: boolean;
      error?: string;
      value?: Record<string, unknown>;
    };
    if (!result.ok)
      throw new Error(result.error || 'Browser DOM action failed');
    const value = result.value!;
    if (typeof value.url === 'string')
      value.url = publicUrl(this.remoteUrl(tab, value.url));
    return { ...value, tab_id: tab.id };
  }
  /** Capture target at arrival, before waiting for another call. Never redirect a queued call. */
  action(
    action: BrowserAction,
    args: Record<string, unknown> = {},
    signal: AbortSignal = this.abort.signal,
  ): Promise<unknown> {
    let tab: BrowserTab | undefined;
    try {
      this.ensureLive();
      if (!['new_tab', 'list_tabs'].includes(action))
        tab = this.tab(
          typeof args.tab_id === 'string' ? args.tab_id : undefined,
        );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Browser action failed'),
      );
    }
    const operation = this.queue
      .then(async () => {
        this.ensureLive();
        if (signal.aborted) throw new Error('Browser action cancelled');
        if (tab) this.tab(tab.id);
        if (tab) {
          this.touch(tab.id);
          this.busyTabs.add(tab.id);
        }
        switch (action) {
          case 'list_tabs':
            return {
              tabs: this.tabs.map(item => ({
                tab_id: item.id,
                url: publicUrl(item.url),
                title: item.title.slice(0, 160),
                selected: item.id === this.selectedTabId,
              })),
            };
          case 'new_tab': {
            const created = this.newTab();
            if (args.url !== undefined) {
              try {
                return await this.navigate(
                  created,
                  requireString(args, 'url', 8192),
                  signal,
                );
              } catch (error) {
                await this.closeTab(created.id);
                throw error;
              }
            }
            return { tab_id: created.id };
          }
          case 'close_tab':
            await this.closeTab(tab!.id);
            return { closed: true };
          case 'navigate':
            return this.navigate(
              tab!,
              requireString(args, 'url', 8192),
              signal,
            );
          case 'snapshot':
            return this.dom(tab!, action, args, signal);
          case 'click':
            requireString(args, 'ref', 256);
            return this.dom(tab!, action, args, signal);
          case 'type':
            requireString(args, 'ref', 256);
            if (typeof args.text !== 'string' || args.text.length > 16384)
              throw new Error('Invalid text');
            return this.dom(tab!, action, args, signal);
          case 'scroll':
            for (const key of ['x', 'y'])
              if (
                (key === 'y' || args[key] !== undefined) &&
                (!Number.isInteger(args[key]) ||
                  Math.abs(Number(args[key])) > 10000)
              )
                throw new Error(`Invalid ${key}`);
            return this.dom(tab!, action, args, signal);
          case 'wait_for_dom': {
            if (args.selector !== undefined)
              requireString(args, 'selector', 1024);
            const timeout =
              args.timeout_ms === undefined ? 5000 : Number(args.timeout_ms);
            if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
              throw new Error('Invalid timeout_ms');
            await this.driver(tab!, signal);
            const generation = tab!.generation;
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (this.tab(tab!.id).generation !== generation)
                throw new Error('Page changed while waiting');
              const result = await this.dom(tab!, action, args, signal);
              if ((result as Record<string, unknown>).ready) return result;
              await new Promise<void>(resolve => setTimeout(resolve, 100));
            }
            throw new Error('DOM wait timed out');
          }
          case 'screenshot': {
            const driver = await this.driver(tab!, signal);
            const generation = tab!.generation;
            const data = await this.bounded(driver.screenshot(), signal);
            if (
              signal.aborted ||
              tab!.generation !== generation ||
              !this.tabs.includes(tab!)
            )
              throw new Error('Page changed during screenshot');
            return { image: data };
          }
          case 'back':
          case 'forward':
          case 'reload': {
            if (action === 'reload' && tab!.lifecycle !== 'active') {
              await this.resume(tab!, signal);
              return { tab_id: tab!.id, url: publicUrl(tab!.url) };
            }
            const driver = await this.driver(tab!, signal);
            if (
              (action === 'back' && !tab!.canGoBack) ||
              (action === 'forward' && !tab!.canGoForward)
            )
              return { navigated: false };
            const before = await this.bounded(driver.documentState(), signal);
            this.tab(tab!.id);
            if (signal.aborted) throw new Error('Browser action cancelled');
            tab!.generation++;
            tab!.loading = true;
            tab!.loadError = null;
            driver[action]();
            this.changed();
            return this.waitNavigation(
              tab!,
              driver,
              before,
              signal,
              undefined,
              action !== 'reload',
            );
          }
          default:
            throw new Error('Unknown browser action');
        }
      })
      .finally(() => {
        if (tab) this.busyTabs.delete(tab.id);
      });
    // Settlement releases serialization even after a cancelled/failed operation.
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async closeTab(id: string) {
    const tab = this.tab(id);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    tab.generation++;
    tab.driver = null;
    if (this.selectedTabId === id) this.selectedTabId = this.tabs[0]?.id || '';
    this.changed();
    const previews = [...tab.previews.values()];
    tab.previews.clear();
    await Promise.all(
      previews.map(preview => this.previews.stopPreview(preview.id)),
    );
  }
  async clearData() {
    for (const tab of this.tabs) {
      tab.generation++;
      await tab.driver?.clearData();
    }
    this.changed();
  }
  async dispose() {
    if (this.disposed) return;
    this.abort.abort();
    this.disposed = true;
    const tabs = this.tabs.splice(0);
    this.selectedTabId = '';
    for (const tab of tabs) {
      tab.generation++;
      tab.driver = null;
    }
    this.changed();
    this.listeners.clear();
    await Promise.all(
      tabs.flatMap(tab =>
        [...tab.previews.values()].map(preview =>
          this.previews.stopPreview(preview.id),
        ),
      ),
    );
  }
}
