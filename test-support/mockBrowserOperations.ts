import {
  BrowserTabChange,
  BrowserTabLifecycle,
  BrowserPlatformAction_Tags,
  BrowserPlatformAction,
  BrowserPlatformResult,
  BrowserPlatformResult_Tags,
  BrowserPlatformError,
  BrowserOperationError,
} from '../packages/react-native-whip-ssh/src/generated/whip_ssh';
import type { BrowserOwner, BrowserTabProjection, BrowserOperationPlatform } from 'react-native-whip-ssh/src/browserOperations';

export { BrowserTabChange, BrowserTabLifecycle, BrowserPlatformAction, BrowserPlatformAction_Tags, BrowserPlatformResult, BrowserPlatformResult_Tags, BrowserPlatformError, BrowserOperationError };

// A view-adapter fixture. The real Rust tests exercise admission, authorization,
// operation queues, leases across requests, deadlines and cancellation races.
export class BrowserOperationSession {
  private readonly values: BrowserTabProjection[] = [];
  private readonly leases = new Map<string, Set<string>>();
  private selected?: string;
  private sequence = 0;
  constructor(readonly owner: BrowserOwner) {}
  initialize() { /* Native admission and hydration races are tested in Rust. */ }
  tabs() { return this.values.filter(tab => tab.lifecycle !== BrowserTabLifecycle.Closed).map(tab => ({ ...tab })); }
  private value(id: string) {
    const tab = this.values.find(value => value.id === id);
    if (!tab) throw new Error('Browser tab closed or unknown');
    return tab;
  }
  tab(id: string) { return { ...this.value(id) }; }
  initialTab(active: boolean) { return this.tabs()[0] ?? this.createTab(active); }
  createTab(active: boolean) {
    const tab = { id: `${this.owner.sessionId}-tab-${++this.sequence}`, generation: 0n, viewGeneration: 0n, driverGeneration: 0n, interactionGeneration: 0n, attached: false,
      lifecycle: active ? BrowserTabLifecycle.Active : BrowserTabLifecycle.Suspended, url: 'about:blank', title: '' };
    this.values.push(tab);
    this.selected = tab.id;
    return { ...tab };
  }
  selectedTab() { return this.selected; }
  select(id: string) { this.tab(id); this.selected = id; }
  change(id: string, event: BrowserTabChange) {
    const tab = this.value(id);
    if (event !== BrowserTabChange.ReserveView && event !== BrowserTabChange.ClearFinished && event !== BrowserTabChange.UserAction) tab.generation++;
    if (event === BrowserTabChange.UserAction) tab.interactionGeneration++;
    if (event === BrowserTabChange.ProcessRestart || event === BrowserTabChange.Clear) tab.driverGeneration++;
    if ([BrowserTabChange.Route, BrowserTabChange.Crash, BrowserTabChange.Suspend, BrowserTabChange.Resume, BrowserTabChange.ClearFinished].includes(event)) tab.viewGeneration++;
    if ([BrowserTabChange.Route, BrowserTabChange.Crash, BrowserTabChange.Suspend, BrowserTabChange.Resume, BrowserTabChange.Clear].includes(event)) tab.attached = false;
    const lifecycle = {
      [BrowserTabChange.Crash]: BrowserTabLifecycle.Crashed,
      [BrowserTabChange.Suspend]: BrowserTabLifecycle.Suspended,
      [BrowserTabChange.Resume]: BrowserTabLifecycle.Active,
      [BrowserTabChange.ReserveView]: BrowserTabLifecycle.Active,
      [BrowserTabChange.Clear]: BrowserTabLifecycle.Cleared,
      [BrowserTabChange.ClearFinished]: BrowserTabLifecycle.Cleared,
      [BrowserTabChange.Document]: undefined,
      [BrowserTabChange.Route]: undefined,
      [BrowserTabChange.UserAction]: undefined,
      [BrowserTabChange.ProcessRestart]: undefined,
    }[event];
    if (lifecycle !== undefined) tab.lifecycle = lifecycle;
    return { ...tab };
  }
  location(id: string, url: string, title: string) {
    const tab = this.value(id);
    if (tab.url !== url) tab.generation++;
    tab.url = url; tab.title = title;
    return { ...tab };
  }
  closeTab(id: string) {
    const tab = this.value(id);
    if (tab.lifecycle !== BrowserTabLifecycle.Closed) { tab.generation++; tab.viewGeneration++; tab.lifecycle = BrowserTabLifecycle.Closed; tab.attached = false; }
    if (this.selected === id) this.selected = this.tabs()[0]?.id;
  }
  setDriverAttached(id: string, attached: boolean) {
    const tab = this.value(id);
    tab.driverGeneration++; tab.attached = attached;
  }
  newLease() { return `fixture-lease-${++this.sequence}`; }
  holdTab(id: string, lease: string) { const tabs = this.leases.get(lease) ?? new Set<string>(); tabs.add(id); this.leases.set(lease, tabs); }
  releaseLease(lease: string) { this.leases.delete(lease); }
  canSuspend(id: string) { return this.tab(id).lifecycle === BrowserTabLifecycle.Active && ![...this.leases.values()].some(tabs => tabs.has(id)); }
  close() { for (const tab of this.tabs()) this.closeTab(tab.id); }
}

export class BrowserOperationCoordinator {
  constructor(readonly platform: BrowserOperationPlatform) {}
  close() { /* This fixture does not run native MCP operations. */ }
}
