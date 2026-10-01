import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import type { TFunction } from 'i18next';

const PREFIX = 'whip.agent.preferences.v1.';

export const ReverseControlState = {
  Off: 'off',
  RestartRequired: 'restartRequired',
  Recovering: 'recovering',
  Connected: 'connected',
} as const;

export interface AgentPreferenceView {
  terminalId: string;
  kind: 'codex' | 'opencode' | 'claude';
  sessionId?: string;
  reverseControl: boolean;
  connected: boolean;
  reverseControlState?: (typeof ReverseControlState)[keyof typeof ReverseControlState];
}

export function reverseControlStateLabel(
  preference: AgentPreferenceView | undefined,
  t: TFunction,
): string {
  const state =
    preference?.reverseControlState ??
    (preference?.connected
      ? ReverseControlState.Connected
      : preference?.reverseControl
        ? ReverseControlState.RestartRequired
        : ReverseControlState.Off);
  switch (state) {
    case ReverseControlState.Connected:
      return t('herd.reverseControlConnected');
    case ReverseControlState.Recovering:
      return t('herd.reverseControlRecovering');
    case ReverseControlState.RestartRequired:
      return t('herd.reverseControlRestart');
    case ReverseControlState.Off:
      return t('herd.reverseControlOff');
  }
}

/** Storage only; Rust owns identity, defaults, and launch decisions. */
export class AgentPreferencesStorage {
  private readonly loads = new WeakMap<HostRuntimeConnection, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly savedValues = new WeakMap<HostRuntimeConnection, string>();

  load(hostId: string, runtime: HostRuntimeConnection): Promise<void> {
    const existing = this.loads.get(runtime);
    if (existing) return existing;
    const pending = (async () => {
      await this.writes.get(hostId);
      const value = await AsyncStorage.getItem(`${PREFIX}${hostId}`);
      if (value) runtime.restoreAgentPreferences(value);
      if (value) this.savedValues.set(runtime, value);
    })();
    this.loads.set(runtime, pending);
    pending.catch(() => {
      this.loads.delete(runtime);
    });
    return pending;
  }

  async save(hostId: string, runtime: HostRuntimeConnection): Promise<void> {
    await this.load(hostId, runtime);
    const value = runtime.agentPreferencesJson();
    if (this.savedValues.get(runtime) === value) return;
    const previous = this.writes.get(hostId) ?? Promise.resolve();
    const write = () => AsyncStorage.setItem(`${PREFIX}${hostId}`, value);
    const pending = previous.then(write, write);
    this.writes.set(hostId, pending);
    try {
      await pending;
      this.savedValues.set(runtime, value);
    } finally {
      if (this.writes.get(hostId) === pending) this.writes.delete(hostId);
    }
  }
}

export function agentPreferenceViews(
  runtime: HostRuntimeConnection,
): readonly AgentPreferenceView[] {
  return (
    JSON.parse(runtime.agentControlStatusJson()) as {
      agents: AgentPreferenceView[];
    }
  ).agents;
}
