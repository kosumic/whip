import { AppState } from 'react-native';
import { setWhipAppControl, type WhipToolPermit } from 'react-native-whip-ssh';
import { deviceAction } from '../browser/device';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import { isLiveHostSshConnected } from '../lib/liveHostLatency';
import type { AppTab } from '../types';

export interface GlobalVoiceApproval {
  hostId: string;
  paneId: string;
  prompt: string;
}
export interface GlobalVoiceControlContext {
  navigation: AppNavigationController;
  sessions: SessionRuntimeController;
  locked: boolean;
  showNavigation: () => void;
  confirm: (request: GlobalVoiceApproval, signal: AbortSignal) => Promise<boolean>;
}

/** Presentation/OS adapter. Rust validates names, arguments and call rights. */
export class GlobalVoiceControl {
  private readonly operations = new Map<string, Set<AbortController>>();
  private disposed = false;
  private operationSequence = 0;

  constructor(private readonly context: () => GlobalVoiceControlContext) {
    setWhipAppControl({
      execute: (permit, action, args) => this.execute(permit, action, args),
      cancel: id => this.cancel(id),
    });
  }

  private cancel(id: string): void {
    for (const operation of this.operations.get(id) ?? []) operation.abort();
    this.operations.delete(id);
  }

  private async execute(permit: Pick<WhipToolPermit, 'callId' | 'checkActive'>, action: string, argumentsJson: string): Promise<string> {
    const abort = new AbortController();
    const id = permit.callId();
    const operations = this.operations.get(id) ?? new Set<AbortController>();
    operations.add(abort);
    this.operations.set(id, operations);
    const check = () => {
      if (this.disposed || abort.signal.aborted || !permit.checkActive() || this.context().locked || AppState.currentState !== 'active') throw new Error('unavailable');
    };
    try {
      check();
      const args = JSON.parse(argumentsJson) as Record<string, string>;
      const context = this.context();
      let value: unknown;
      if (action === 'confirm_delegation') {
        const approved = await context.confirm({ hostId: args.host_id, paneId: args.pane_id, prompt: args.prompt }, abort.signal);
        check();
        value = { approved };
      } else if (action.startsWith('device.')) {
        value = await deviceAction(action, args, `${id}:${++this.operationSequence}`, abort.signal);
        check();
      } else if (action === 'app_snapshot') {
        value = { foreground: true, tab: context.navigation.state.tab, host_id: context.sessions.activeSession?.hostId ?? null, pane_id: context.navigation.selectedPaneId };
      } else if (action === 'app_navigate') {
        context.navigation.selectTab(args.tab as AppTab);
        context.showNavigation();
        value = { navigated: true };
      } else {
        const session = context.sessions.presentationSessions.find(item => item.hostId === args.host_id);
        if (!session || !isLiveHostSshConnected(session.connectionStatus)) throw new Error('unavailable');
        if (action === 'app_focus_host') {
          context.sessions.select(session.id, 'herd');
          context.navigation.selectHerdHost(session.id);
        } else {
          const pane = session.snapshot.panes.find(item => action === 'app_focus_tab' ? item.tab_id === args.tab_id : item.pane_id === args.pane_id);
          if (!pane || !['app_focus_tab', 'app_open_agent'].includes(action)) throw new Error('unavailable');
          context.sessions.openPaneTerminal(session.id, pane);
        }
        context.showNavigation();
        value = { navigated: true, host_id: args.host_id };
      }
      check();
      return JSON.stringify(value);
    } catch {
      // Native/OS error bodies can include credentials or private platform data.
      return JSON.stringify({ error: 'unavailable_or_denied' });
    } finally {
      operations.delete(abort);
      if (operations.size === 0 && this.operations.get(id) === operations) this.operations.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.operations.keys()) this.cancel(id);
  }
}
