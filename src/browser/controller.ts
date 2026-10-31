import { terminalWebLinkTarget } from '../lib/terminalLinks';
import { browserAddress } from './address';
import type { BrowserAnnotations, BrowserDownload } from './native';
import type { BrowserSiteInfo } from './siteInfo';
import { bestEffortCleanup } from '../services/backgroundOperations';
import {
  BrowserOperationSession,
  BrowserTabChange,
  BrowserTabLifecycle,
  BrowserPlatformAction_Tags,
  BrowserPlatformResult,
  type BrowserOwner,
  type BrowserTabProjection,
  type BrowserEffectPermitLike,
  type BrowserPlatformAction,
} from 'react-native-whip-ssh/src/browserOperations';

export const BROWSER_LIVE_VIEW_BUDGET = 9;
export const BROWSER_ACTION_TIMEOUT_MS = 15000;
export const BROWSER_DATA_CLEARED_MESSAGE =
  'Browser data was cleared. Reload this page to continue.';
const BROWSER_RENDERER_STOPPED_MESSAGE =
  'Browser renderer stopped. Reload this tab to restore its page.';
const BROWSER_PAGE_LOAD_FAILED_MESSAGE =
  'Browser page failed to load. Reload this tab to retry.';
export type BrowserAction =
  | 'resolve_tab'
  | 'document_state'
  | 'evaluate'
  | 'navigate'
  | 'screenshot'
  | 'download'
  | 'back'
  | 'forward'
  | 'reload'
  | 'list_tabs'
  | 'new_tab'
  | 'close_tab';
export interface BrowserDriver {
  saveState?(): Promise<BrowserSavedState | null>;
  restoreState?(token: string): Promise<boolean>;
  download?(
    url: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<BrowserDownload>;
  siteInfo?(url: string): Promise<BrowserSiteInfo>;
  clearSiteData?(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  documentState(): Promise<BrowserDocumentState | null>;
  screenshot(annotations?: BrowserAnnotations): Promise<string>;
  navigate(url: string): void | Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  clearData(): Promise<void>;
}
/** Native history stays in memory, separate from page-location recovery on disk. */
export interface BrowserSavedState {
  restore(driver: BrowserDriver): Promise<boolean>;
  dispose(): void;
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
  lifecycle: 'active' | 'suspended' | 'crashed' | 'cleared' | 'closed';
  lastUsedAt: number;
  driver: BrowserDriver | null;
  savedState: BrowserSavedState | null;
  previews: Map<string, { id: string; local: string; remote: string }>;
}
/** WebView error documents (chrome-error:, data:, etc.) are not tab locations. */
function isBrowserPageUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
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
  readonly operations: BrowserOperationSession;
  // Only local UI commands use this queue. Agent effects enter directly with
  // native permits; their ordering, leases and deadlines stay in Rust.
  private uiQueue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private readonly previews: PreviewTransport;
  private readonly suspensions = new Map<string, Promise<boolean>>();
  releaseLease(lease: string) {
    this.operations.releaseLease(lease);
    if (!this.canActivate()) this.changed();
  }
  constructor(
    readonly id: string,
    previews: PreviewTransport,
    private readonly canActivate: () => boolean = () => true,
    private readonly routing?: { activate(): Promise<void> },
    private readonly activateView?: (tab: BrowserTab) => Promise<void>,
    owner?: BrowserOwner,
  ) {
    this.previews = previews;
    this.operations = new BrowserOperationSession(owner ?? { runtimeId: id, sessionId: id, paneId: '', terminalId: '' });
    this.adoptTab(this.operations.initialTab(this.canActivate()));
    this.selectedTabId = this.operations.selectedTab() ?? '';
    if (!owner) this.operations.initialize();
  }

  private applyNative(tab: BrowserTab, view: BrowserTabProjection) {
    const lifecycles = {
      [BrowserTabLifecycle.Active]: 'active',
      [BrowserTabLifecycle.Suspended]: 'suspended',
      [BrowserTabLifecycle.Crashed]: 'crashed',
      [BrowserTabLifecycle.Cleared]: 'cleared',
      [BrowserTabLifecycle.Closed]: 'closed',
    } as const;
    tab.generation = Number(view.generation);
    tab.viewGeneration = Number(view.viewGeneration);
    tab.lifecycle = lifecycles[view.lifecycle];
  }

  private change(tab: BrowserTab, event: BrowserTabChange) {
    this.applyNative(tab, this.operations.change(tab.id, event));
  }

  private publishLocation(tab: BrowserTab) {
    this.applyNative(tab, this.operations.location(tab.id, tab.url, tab.title));
  }

  synchronize() {
    if (this.disposed) return;
    const live = this.operations.tabs();
    for (const tab of [...this.tabs]) {
      if (!live.some(view => view.id === tab.id))
        bestEffortCleanup(this.closeTab(tab.id), 'browser-native-tab-close');
    }
    for (const view of live) {
      const tab = this.tabs.find(item => item.id === view.id);
      if (tab) this.applyNative(tab, view);
      else this.adoptTab(view);
    }
    this.selectedTabId = this.operations.selectedTab() ?? '';
    this.changed();
  }

  reserveView(tab: BrowserTab) { this.change(tab, BrowserTabChange.ReserveView); }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Network route changes invalidate old documents and reload original URLs. */
  resetRoute() {
    for (const tab of this.tabs) {
      this.discardState(tab);
      tab.driver = null;
      tab.source = tab.url;
      this.change(tab, BrowserTabChange.Route);
      tab.loading = tab.url !== 'about:blank';
      tab.loadError = null;
      for (const preview of tab.previews.values())
        bestEffortCleanup(
          this.previews.stopPreview(preview.id),
          'browser-route-preview-stop',
        );
      tab.previews.clear();
    }
    this.changed();
  }
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
    this.operations.select(id);
    this.selectedTabId = id;
    this.changed();
  }
  newTab(activate = true) {
    this.ensureLive();
    const view = this.operations.createTab(activate && this.canActivate());
    const tab = this.adoptTab(view);
    this.selectedTabId = view.id;
    this.changed();
    return tab;
  }
  private adoptTab(view: BrowserTabProjection): BrowserTab {
    const existing = this.tabs.find(tab => tab.id === view.id);
    if (existing) { this.applyNative(existing, view); return existing; }
    const id = view.id;
    this.tabs.push({
      id,
      source: view.url,
      url: view.url,
      title: view.title,
      loading: false,
      loadError: null,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
      viewGeneration: 0,
      lifecycle: 'suspended',
      lastUsedAt: Date.now(),
      driver: null,
      savedState: null,
      previews: new Map(),
    });
    const tab = this.tabs[this.tabs.length - 1];
    this.applyNative(tab, view);
    return tab;
  }
  attach(id: string, driver: BrowserDriver | null, viewGeneration?: number) {
    const tab = this.tabs.find(item => item.id === id);
    if (
      tab &&
      (viewGeneration === undefined || viewGeneration === tab.viewGeneration)
    ) {
      if (tab.driver === driver) return;
      this.operations.setDriverAttached(id, driver !== null);
      tab.driver = driver;
      this.changed();
    }
  }
  touch(id: string) {
    const tab = this.tab(id);
    tab.lastUsedAt = Math.max(Date.now(), tab.lastUsedAt + 1);
  }
  /** WebKit can reload the surviving view without discarding its history. */
  reloadRenderer(id: string, viewGeneration: number) {
    const tab = this.tabs.find(item => item.id === id);
    if (tab?.viewGeneration !== viewGeneration || tab.lifecycle !== 'active')
      return;
    const driver = tab.driver;
    if (!driver) {
      this.rendererGone(id, viewGeneration);
      return;
    }
    this.discardState(tab);
    // Invalidate pending observations before asking the new process to load.
    this.change(tab, BrowserTabChange.ProcessRestart);
    tab.loading = true;
    tab.loadError = null;
    this.changed();
    try {
      driver.reload();
    } catch {
      this.rendererGone(id, viewGeneration);
    }
  }
  rendererGone(
    id: string,
    viewGeneration: number,
    message = BROWSER_RENDERER_STOPPED_MESSAGE,
  ) {
    const tab = this.tabs.find(item => item.id === id);
    if (viewGeneration !== tab?.viewGeneration) return;
    this.discardState(tab);
    this.change(tab, BrowserTabChange.Crash);
    tab.driver = null;
    tab.loading = false;
    tab.loadError = message;
    this.changed();
  }
  canSuspend(tab: BrowserTab) {
    return (
      this.operations.canSuspend(tab.id)
    );
  }
  private discardState(tab: BrowserTab) {
    tab.savedState?.dispose();
    tab.savedState = null;
  }
  async restoreState(
    id: string,
    driver: BrowserDriver,
    viewGeneration: number,
  ) {
    const tab = this.tab(id);
    if (tab.viewGeneration !== viewGeneration) return false;
    const saved = tab.savedState;
    if (!saved) return false;
    let restored = false;
    try {
      restored = await saved.restore(driver);
    } catch {
      // A missing native snapshot falls back to loading the saved location.
    } finally {
      if (tab.savedState === saved) this.discardState(tab);
    }
    if (
      this.disposed ||
      !this.tabs.includes(tab) ||
      tab.viewGeneration !== viewGeneration
    )
      return false;
    if (!restored) {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
    return restored;
  }
  suspendTab(
    tab: BrowserTab,
    eligible: () => boolean = () => true,
  ): Promise<boolean> {
    const pending = this.suspensions.get(tab.id);
    if (pending) return pending;
    const operation = (async () => {
      if (!this.canSuspend(tab) || !eligible()) return false;
      const generation = tab.generation;
      const lastUsedAt = tab.lastUsedAt;
      let saved: BrowserSavedState | null = null;
      try {
        saved = (await tab.driver?.saveState?.()) || null;
      } catch {
        // Renderer failures must not prevent reclaiming the view.
      }
      if (
        this.disposed ||
        !this.tabs.includes(tab) ||
        !this.canSuspend(tab) ||
        !eligible() ||
        tab.generation !== generation ||
        tab.lastUsedAt !== lastUsedAt
      ) {
        saved?.dispose();
        return false;
      }
      this.discardState(tab);
      tab.savedState = saved;
      this.change(tab, BrowserTabChange.Suspend);
      tab.driver = null;
      tab.loading = false;
      // Native history can still reference these loopback tunnel addresses.
      const previews = saved ? [] : [...tab.previews.values()];
      if (!saved) {
        tab.previews.clear();
        tab.canGoBack = false;
        tab.canGoForward = false;
      }
      this.changed();
      await Promise.all(
        previews.map(preview => this.previews.stopPreview(preview.id)),
      );
      return true;
    })().finally(() => this.suspensions.delete(tab.id));
    this.suspensions.set(tab.id, operation);
    return operation;
  }
  async suspendInactive(cutoff: number, visibleTabId?: string) {
    for (const tab of this.tabs) {
      await this.suspendTab(
        tab,
        () => tab.id !== visibleTabId && tab.lastUsedAt <= cutoff,
      );
    }
  }
  restoreTabs(
    tabs: readonly { url: string; title: string }[],
    selected: number,
  ) {
    for (const [index, saved] of tabs.entries()) {
      const tab =
        index === 0 && this.tabs[0] ? this.tabs[0] : this.newTab(false);
      tab.url = saved.url;
      tab.title = saved.title;
      this.publishLocation(tab);
      this.change(tab, BrowserTabChange.Suspend);
    }
    this.selectedTabId = this.tabs[selected]?.id || this.tabs[0]?.id || '';
    if (this.selectedTabId) this.operations.select(this.selectedTabId);
    this.changed();
  }
  loadStart(id: string) {
    const tab = this.tab(id);
    const notify = !tab.loading || !!tab.loadError;
    this.change(tab, BrowserTabChange.Document);
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
    this.change(tab, BrowserTabChange.Document);
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
    if (!isBrowserPageUrl(state.url)) return;
    if (state.url === 'about:blank' && tab.url !== 'about:blank') return;
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
    Object.assign(tab, {
      url,
      title: state.title,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      loading,
    });
    this.publishLocation(tab);
    this.changed();
    // Keep tunnels represented in WebView history, until their tab is closed.
  }
  private documentUrl(tab: BrowserTab, value: string) {
    if (!isBrowserPageUrl(value)) {
      tab.loading = false;
      tab.loadError ||= BROWSER_PAGE_LOAD_FAILED_MESSAGE;
      this.changed();
      throw new Error(tab.loadError);
    }
    return this.remoteUrl(tab, value);
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
    const suspension = this.suspensions.get(tab.id);
    if (suspension) await suspension;
    if (tab.lifecycle === 'suspended') return this.resume(tab, signal);
    if (tab.lifecycle === 'cleared')
      throw new Error(BROWSER_DATA_CLEARED_MESSAGE);
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
        tab.url !== 'about:blank' && state?.url === 'about:blank';
      if (
        state?.ready &&
        !waitingForInitialPage &&
        (state.id !== before?.id || sameDocument || historyChanged)
      ) {
        const observedUrl = this.documentUrl(tab, state.url);
        if (tab.url !== observedUrl) {
          tab.url = observedUrl;
          this.publishLocation(tab);
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
    if (!this.routing && target.requiresSshTunnel) {
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
    // Recover tabs poisoned by error-page URLs in earlier versions. The mount
    // source may still identify the page; otherwise return to the start page.
    if (!isBrowserPageUrl(tab.url)) {
      this.discardState(tab);
      tab.url = isBrowserPageUrl(tab.source)
        ? this.remoteUrl(tab, tab.source)
        : 'about:blank';
      if (tab.url === 'about:blank') tab.title = '';
    }
    const url =
      tab.url === 'about:blank'
        ? 'about:blank'
        : (await this.resolveUrl(tab, tab.url, signal)).local;
    this.tab(tab.id);
    if (signal.aborted) throw new Error('Browser action cancelled');
    tab.source = url;
    this.publishLocation(tab);
    if (this.activateView) await this.activateView(tab);
    this.tab(tab.id);
    if (signal.aborted) throw new Error('Browser action cancelled');
    this.change(tab, BrowserTabChange.Resume);
    tab.loading = url !== 'about:blank';
    tab.loadError = null;
    if (!tab.savedState) {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
    this.changed();
    const driver = await this.driver(tab, signal);
    if (url !== 'about:blank')
      await this.waitNavigation(tab, driver, null, signal, url);
    return driver;
  }
  private async navigate(tab: BrowserTab, value: string, signal: AbortSignal) {
    const target = await this.resolveUrl(tab, value, signal);
    if (
      tab.lifecycle === 'cleared' ||
      tab.lifecycle === 'crashed' ||
      !isBrowserPageUrl(tab.url)
    ) {
      this.discardState(tab);
      tab.url = target.remote;
      await this.resume(tab, signal);
      return { tab_id: tab.id, url: publicUrl(tab.url) };
    }
    const driver = await this.driver(tab, signal);
    const before = await this.bounded(driver.documentState(), signal);
    this.tab(tab.id);
    if (signal.aborted) throw new Error('Browser action cancelled');
    this.change(tab, BrowserTabChange.Document);
    tab.loading = true;
    tab.loadError = null;
    tab.url = target.remote;
    this.publishLocation(tab);
    // Navigate the mounted WebView; its initial source prop remains stable.
    await this.bounded(Promise.resolve(driver.navigate(target.local)), signal);
    this.changed();
    return this.waitNavigation(tab, driver, before, signal, target.local);
  }
  private tabMetadata() {
    return this.tabs.map(tab => ({
      tab_id: tab.id,
      url: publicUrl(tab.url),
      title: tab.title.slice(0, 160),
      selected: tab.id === this.selectedTabId,
    }));
  }
  private documentIdentity(tab: BrowserTab) {
    return `${tab.id}-${tab.generation}`;
  }
  private assertIdentity(tab: BrowserTab, identity: unknown) {
    if (identity !== undefined && identity !== this.documentIdentity(tab))
      throw Object.assign(new Error('Page changed during action'), {
        code: 'stale_page',
      });
  }
  /** Physical view acquisition only. Rust supplies the deadline and cancellation. */
  async prepareAgentTab(
    permit: BrowserEffectPermitLike,
    id: string,
    resume: boolean,
    navigation: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const tab = this.tab(id);
    const suspension = this.suspensions.get(id);
    if (suspension) await suspension;
    permit.checkActive();
    if (resume) {
      if (!isBrowserPageUrl(tab.url)) {
        this.discardState(tab);
        tab.url = isBrowserPageUrl(tab.source) ? this.remoteUrl(tab, tab.source) : 'about:blank';
        this.publishLocation(tab);
      }
      const source = navigation && !tab.savedState ? 'about:blank'
        : tab.url === 'about:blank' ? tab.url : (await this.resolveUrl(tab, tab.url, signal)).local;
      permit.checkActive();
      tab.source = source;
      if (this.activateView) await this.activateView(tab);
      permit.checkActive();
      this.applyNative(tab, this.operations.tab(id));
      tab.loading = source !== 'about:blank';
      tab.loadError = null;
      if (!tab.savedState) { tab.canGoBack = false; tab.canGoForward = false; }
      this.changed();
    }
    if (tab.driver) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(new Error('Browser action cancelled')); };
      const check = () => {
        try {
          permit.checkActive();
          if (!tab.driver) return;
          cleanup();
          resolve();
        } catch {
          cleanup();
          reject(new Error('Browser operation unavailable'));
        }
      };
      const unsubscribe = this.subscribe(check);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      else check();
    });
    permit.checkActive();
  }

  async activateAgentRoute(permit: BrowserEffectPermitLike): Promise<void> {
    permit.checkActive();
    await this.routing?.activate();
    permit.checkActive();
  }

  /** Typed WebView effects; no agent queue, timeout, identity or result policy. */
  async agentEffect(
    permit: BrowserEffectPermitLike,
    action: BrowserPlatformAction,
    signal: AbortSignal,
  ): Promise<BrowserPlatformResult> {
    permit.checkActive();
    const id = action.inner.tabId;
    if (action.tag === BrowserPlatformAction_Tags.CreateTab) {
      const tab = this.adoptTab(this.operations.tab(id));
      if (this.canActivate()) this.reserveView(tab);
      this.selectedTabId = this.operations.selectedTab() ?? '';
      this.changed();
      return new BrowserPlatformResult.Done();
    }
    if (action.tag === BrowserPlatformAction_Tags.CloseTab) {
      if (this.tabs.some(tab => tab.id === id)) await this.closeTab(id);
      return new BrowserPlatformResult.Done();
    }
    const tab = this.tab(id);
    const driver = tab.driver;
    if (!driver || tab.loadError) throw new Error('Browser renderer is unavailable');
    switch (action.tag) {
      case BrowserPlatformAction_Tags.Document: {
        const state = await driver.documentState();
        if (!state) throw new Error('Browser document unavailable');
        const pageUrl = this.documentUrl(tab, state.url);
        return new BrowserPlatformResult.Document({ document: {
          ...state,
          publicUrl: pageUrl,
          ready: state.ready && !(tab.url !== 'about:blank' && state.url === 'about:blank'),
        } });
      }
      case BrowserPlatformAction_Tags.Evaluate: {
        const result = JSON.stringify(await driver.evaluate(action.inner.script));
        if (result === undefined) throw new Error('Browser evaluation result unavailable');
        return new BrowserPlatformResult.Json({ valueJson: result });
      }
      case BrowserPlatformAction_Tags.Navigate: {
        const target = await this.resolveUrl(tab, action.inner.url, signal);
        permit.checkActive();
        this.change(tab, BrowserTabChange.Document);
        tab.url = target.remote;
        this.publishLocation(tab);
        tab.loading = true;
        tab.loadError = null;
        await driver.navigate(target.local);
        permit.checkActive();
        this.changed();
        return new BrowserPlatformResult.Navigation({ target: target.local, navigated: true });
      }
      case BrowserPlatformAction_Tags.Screenshot:
        return new BrowserPlatformResult.Image({ image: await driver.screenshot(action.inner.annotationsJson === undefined ? undefined : JSON.parse(action.inner.annotationsJson) as BrowserAnnotations) });
      case BrowserPlatformAction_Tags.Download: {
        if (!driver.download) throw new Error('Browser download unavailable');
        const target = await this.resolveUrl(tab, action.inner.url, signal);
        permit.checkActive();
        const result = await driver.download(target.local, action.inner.maxBytes, signal);
        return new BrowserPlatformResult.Download({ localPath: result.local_path, bytes: BigInt(result.bytes), mimeType: result.mime_type });
      }
      case BrowserPlatformAction_Tags.Back:
      case BrowserPlatformAction_Tags.Forward:
      case BrowserPlatformAction_Tags.Reload: {
        const method = action.tag === BrowserPlatformAction_Tags.Back ? 'back' : action.tag === BrowserPlatformAction_Tags.Forward ? 'forward' : 'reload';
        if ((method === 'back' && !tab.canGoBack) || (method === 'forward' && !tab.canGoForward))
          return new BrowserPlatformResult.Navigation({ target: undefined, navigated: false });
        this.change(tab, BrowserTabChange.Document);
        tab.loading = true;
        tab.loadError = null;
        driver[method]();
        this.changed();
        return new BrowserPlatformResult.Navigation({ target: undefined, navigated: true });
      }
    }
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
  /** Capture target at arrival, before waiting for another call. Never redirect a queued call. */
  action(
    action: BrowserAction,
    args: Record<string, unknown> = {},
    signal: AbortSignal = this.abort.signal,
  ): Promise<unknown> {
    let tab: BrowserTab | undefined;
    try {
      this.ensureLive();
      if (
        !['new_tab', 'list_tabs'].includes(action) &&
        !(action === 'resolve_tab' && !this.tabs.length)
      )
        tab = this.tab(
          typeof args.tab_id === 'string' ? args.tab_id : undefined,
        );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Browser action failed'),
      );
    }
    const busyLease = this.operations.newLease();
    const operation = this.uiQueue
      .then(async () => {
        this.ensureLive();
        if (signal.aborted) throw new Error('Browser action cancelled');
        if (this.routing && !['list_tabs', 'close_tab'].includes(action))
          await this.routing.activate();
        if (signal.aborted) throw new Error('Browser action cancelled');
        if (tab) this.tab(tab.id);
        if (tab) {
          if (['navigate', 'back', 'forward', 'reload', 'close_tab', 'evaluate'].includes(action))
            this.change(tab, BrowserTabChange.UserAction);
          this.touch(tab.id);
          this.operations.holdTab(tab.id, busyLease);
          if (typeof args.lease_id === 'string') {
            this.operations.holdTab(tab.id, args.lease_id);
          }
        }
        switch (action) {
          case 'resolve_tab':
            return { tab_id: tab?.id || '', tabs: this.tabMetadata() };
          case 'document_state': {
            const driver = await this.driver(tab!, signal);
            const generation = tab!.generation;
            const state = await this.bounded(driver.documentState(), signal);
            if (generation !== tab!.generation)
              throw Object.assign(
                new Error('Page changed during observation'),
                { code: 'stale_page' },
              );
            if (tab!.loadError) throw new Error(tab!.loadError);
            if (!state) throw new Error('Browser document unavailable');
            return {
              ...state,
              identity: this.documentIdentity(tab!),
              public_url: publicUrl(this.documentUrl(tab!, state.url)),
            };
          }
          case 'evaluate': {
            const driver = await this.driver(tab!, signal);
            const generation = tab!.generation;
            this.assertIdentity(tab!, args.identity);
            const result = await this.bounded(
              driver.evaluate(requireString(args, 'js', 262144)),
              signal,
            );
            if (tab!.generation !== generation)
              throw Object.assign(new Error('Page changed during evaluation'), {
                code: 'stale_page',
              });
            this.tab(tab!.id);
            return result;
          }
          case 'download': {
            const driver = await this.driver(tab!, signal);
            this.assertIdentity(tab!, args.identity);
            if (!driver.download)
              throw new Error('Browser download unavailable');
            const url = requireString(args, 'url', 8192);
            const address = new URL(url);
            if (
              !['http:', 'https:'].includes(address.protocol) ||
              address.username ||
              address.password
            )
              throw new Error('Invalid download URL');
            const maxBytes = args.max_bytes;
            if (
              typeof maxBytes !== 'number' ||
              !Number.isInteger(maxBytes) ||
              maxBytes < 1 ||
              maxBytes > 64 * 1024 * 1024
            )
              throw new Error('Invalid download size limit');
            const target = await this.resolveUrl(tab!, url, signal);
            return driver.download(target.local, maxBytes, signal);
          }
          case 'list_tabs':
            return {
              tabs: this.tabMetadata(),
            };
          case 'new_tab': {
            const created = this.newTab();
            tab = created;
            this.operations.holdTab(created.id, busyLease);
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
          case 'screenshot': {
            const driver = await this.driver(tab!, signal);
            const generation = tab!.generation;
            this.assertIdentity(tab!, args.identity);
            const annotations = args.annotations as
              BrowserAnnotations | undefined;
            const data = await this.bounded(
              driver.screenshot(annotations),
              signal,
            );
            if (
              signal.aborted ||
              tab!.generation !== generation ||
              !this.tabs.includes(tab!)
            )
              throw Object.assign(new Error('Page changed during screenshot'), {
                code: 'stale_page',
              });
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
            this.change(tab!, BrowserTabChange.Document);
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
        this.operations.releaseLease(busyLease);
        if (!this.canActivate()) this.changed();
      });
    // Settlement releases serialization even after a cancelled/failed operation.
    this.uiQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async closeTab(id: string) {
    const tab = this.tab(id);
    this.operations.closeTab(id);
    this.discardState(tab);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.applyNative(tab, this.operations.tab(id));
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
      this.change(tab, BrowserTabChange.Clear);
      this.discardState(tab);
      await tab.driver?.clearData();
      // Releasing the renderer clears WebKit's history, form and session state
      // through public APIs. Keep the URL so the user can explicitly reload.
      tab.driver = null;
      this.change(tab, BrowserTabChange.ClearFinished);
      tab.loading = false;
      tab.loadError = null;
      tab.canGoBack = false;
      tab.canGoForward = false;
      const previews = [...tab.previews.values()];
      tab.previews.clear();
      this.changed();
      await Promise.all(
        previews.map(preview => this.previews.stopPreview(preview.id)),
      );
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.abort.abort();
    this.disposed = true;
    this.operations.close();
    const tabs = this.tabs.splice(0);
    this.selectedTabId = '';
    for (const tab of tabs) {
      this.discardState(tab);
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
