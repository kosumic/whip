import {
  createHostRuntime,
  type HostRuntimeConnection,
  type HostRuntimeLifecycleEvent,
  type HostRuntimeState,
} from 'react-native-whip-ssh';
import type { HostLatencyMeasurement } from './latencyDiagnostics';

import { errorCode } from '../lib/connectionErrors';
import { DEFAULT_HERDR_COMMAND } from '../lib/hostProfiles';
import { normalizePrivateKey } from '../lib/privateKey';
import type { ConnectionProfile, HerdrSnapshot, ServerInfo } from '../types';
import {
  networkErrorKind,
  networkErrorMessage,
  recordNetworkDiagnostic,
} from './networkDiagnostics';
import {
  persistedHerdrSocketPathHint,
  persistHerdrSocketPathHint,
} from './herdrSocketPathCache';
import { TerminalBridgeController } from './TerminalBridgeController';
import { agentTranscriptService } from './NativeTranscriptService';
import { reportBackgroundFailure } from './backgroundOperations';

const HOST_KEY_CHALLENGE_CODES = new Set([
  'HOST_KEY_UNKNOWN',
  'HOST_KEY_CHANGED',
]);

function isHostKeyChallenge(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && HOST_KEY_CHALLENGE_CODES.has(code);
}

export { clearHerdrSocketPathCache } from './herdrSocketPathCache';

/** Owns one native host runtime and the small amount of app lifecycle around it. */
export class HerdrClient {
  private runtime: HostRuntimeConnection | null = null;
  private disconnecting: Promise<void> | null = null;
  private runtimeAwaitingHostKeyTrust = false;
  private runtimeEventHandler: ((event: HostRuntimeLifecycleEvent) => void) | null = null;
  private profile: ConnectionProfile | null = null;

  readonly terminal = new TerminalBridgeController(() => this.runtime);

  /** The Rust-owned backend API for the active connection. */
  get native(): HostRuntimeConnection {
    if (!this.runtime) throw new Error('Host runtime is not active');
    return this.runtime;
  }

  async connect(profile: ConnectionProfile, jumpProfiles: ConnectionProfile[] = []): Promise<void> {
    await this.disconnecting;
    const port = Number(profile.port);
    validateSshPort(port);
    jumpProfiles.forEach(jumpProfile => validateSshPort(Number(jumpProfile.port)));

    const sshConfig = (value: ConnectionProfile) => ({
      host: value.host.trim(),
      port: Number(value.port),
      username: value.username.trim(),
      authMode: value.authMode,
      secret: value.authMode === 'password' ? value.secret : normalizePrivateKey(value.secret),
      passphrase: value.passphrase || undefined,
      forwardAgent: value.forwardAgent,
    } as const);
    const cachedSocketPath = profile.herdrSocketPath?.trim()
      ? undefined
      : persistedHerdrSocketPathHint(profile.id) || undefined;
    const endpoint = profile.host.trim();
    recordNetworkDiagnostic('info', 'host-runtime-connect-started', {
      sessionId: profile.id,
      endpoint,
      endpointKind: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpoint)
        ? 'ipv4'
        : endpoint.includes(':') ? 'ipv6' : 'hostname',
      port,
      authMode: profile.authMode,
      jumpHostCount: jumpProfiles.length,
      explicitSocketPath: Boolean(profile.herdrSocketPath?.trim()),
      cachedSocketPath: Boolean(cachedSocketPath),
    });
    const retryRuntime = this.runtimeAwaitingHostKeyTrust && this.profile === profile
      ? this.runtime
      : null;
    if (this.runtimeAwaitingHostKeyTrust && !retryRuntime) {
      await this.runtime?.disconnect().catch(error => {
        recordRuntimeCleanupFailure('stale-runtime-disconnect-failed', error);
      });
      this.runtime = null;
      this.runtimeAwaitingHostKeyTrust = false;
    }
    const runtime = retryRuntime ?? createHostRuntime({
      runtimeId: profile.id,
      ssh: sshConfig(profile),
      jumpHosts: jumpProfiles.map(sshConfig),
      sessionName: profile.sessionName.trim(),
      herdrCommand: profile.herdrCommand.trim() || DEFAULT_HERDR_COMMAND,
      socketPath: profile.herdrSocketPath?.trim() || undefined,
      cachedSocketPath,
    }, event => {
      if (this.runtime !== runtime) return;
      if (event.type === 'host-state' && event.transcriptRetention) {
        if (event.transcriptRetention.runtimeIncarnation !== runtime.runtimeIncarnation) return;
        reportBackgroundFailure(
          agentTranscriptService.retainTranscripts(event.transcriptRetention),
          'agent-transcript-retention',
        );
      }
      this.runtimeEventHandler?.(event);
    });
    this.runtime = runtime;
    this.profile = profile;
    try {
      await runtime.connect();
      this.runtimeAwaitingHostKeyTrust = false;
    } catch (error) {
      this.runtimeAwaitingHostKeyTrust = isHostKeyChallenge(error);
      if (this.runtime === runtime && !this.runtimeAwaitingHostKeyTrust) {
        await this.disconnect();
      }
      throw error;
    }
  }

  setRuntimeEventHandler(handler: ((event: HostRuntimeLifecycleEvent) => void) | null): void {
    this.runtimeEventHandler = handler;
  }

  async refreshHostState(): Promise<HostRuntimeState> {
    try {
      return await this.native.refreshState();
    } catch (error) {
      recordNetworkDiagnostic('warn', 'host-state-refresh-rejected', {
        error: networkErrorMessage(error),
        errorKind: networkErrorKind(error),
      });
      throw error;
    }
  }

  /** Ask the Rust-owned runtime to recover its transport and native resources. */
  async reconnectControl(profile: ConnectionProfile = this.requireProfile()): Promise<void> {
    this.profile = profile;
    await this.native.recover(true, 'control connection unavailable');
  }

  disconnect(): Promise<void> {
    if (!this.runtime) return this.disconnecting ?? Promise.resolve();

    const runtime = this.runtime;
    this.terminal.reset(runtime);
    this.runtime = null;
    this.runtimeAwaitingHostKeyTrust = false;
    this.profile = null;

    const disconnecting = runtime.disconnect()
      .catch(error => {
        recordRuntimeCleanupFailure('host-runtime-disconnect-failed', error);
      })
      .finally(() => {
        if (this.disconnecting === disconnecting) this.disconnecting = null;
      });
    this.disconnecting = disconnecting;
    return disconnecting;
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const state = await this.native.refreshState();
    const result = this.snapshotFromHostState(state);
    if (state.syncStatus === 'error') {
      throw new Error(state.error || 'Herdr host state refresh failed');
    }
    return result;
  }

  /** Load the authoritative snapshot from a newly authenticated native runtime. */
  async initialSnapshot(): Promise<HerdrSnapshot> {
    let state = this.native.hostState();
    if (state.revision === 0) state = await this.native.refreshState();
    return this.snapshotFromHostState(state);
  }

  /** Mechanical typed-FFI projection; Rust remains authoritative. */
  snapshotFromHostState(state: HostRuntimeState): HerdrSnapshot {
    const raw = state.snapshot;
    const socket = this.runtime?.resolvedSocketPath();
    if (!raw) return offlineSnapshot({ running: false, socket });
    if (socket && !this.requireProfile().herdrSocketPath?.trim()) {
      persistHerdrSocketPathHint(this.requireProfile().id, socket);
    }
    const server: ServerInfo = {
      running: true,
      version: raw.version,
      protocol: raw.protocol,
      compatible: true,
      socket,
    };
    return {
      server,
      focused_workspace_id: raw.focused_workspace_id ?? null,
      focused_tab_id: raw.focused_tab_id ?? null,
      focused_pane_id: raw.focused_pane_id ?? null,
      agents: raw.agents,
      workspaces: raw.workspaces,
      tabs: raw.tabs,
      panes: raw.panes,
      layouts: raw.layouts ?? [],
    };
  }

  /** Measure an SSH protocol ping/pong RTT without remote process startup. */
  async measureLatency(): Promise<HostLatencyMeasurement> {
    const measurement = await this.native.measureHostLatency();
    const { sshRttMs } = measurement;
    if (!Number.isFinite(sshRttMs) || sshRttMs <= 0) {
      throw new Error('Android returned an invalid host latency');
    }
    const roundMilliseconds = (value: number) => Math.round(value * 10) / 10;
    return {
      latencyMs: Math.round(sshRttMs),
      sshRttMs: roundMilliseconds(sshRttMs),
      totalMs: roundMilliseconds(measurement.totalMs),
      runtimeOverheadMs: roundMilliseconds(measurement.runtimeOverheadMs),
    };
  }

  setMonitoringState(
    appActive: boolean,
    hostsVisible: boolean,
    accessLocked: boolean,
  ): void {
    this.native.setMonitoringState(appActive, hostsVisible, accessLocked);
  }

  private requireProfile(): ConnectionProfile {
    if (!this.profile) throw new Error('SSH connection is not active');
    return this.profile;
  }
}

function validateSshPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be between 1 and 65535');
  }
}

function offlineSnapshot(server: ServerInfo): HerdrSnapshot {
  return {
    server,
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    agents: [],
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
  };
}

function recordRuntimeCleanupFailure(event: string, error: unknown): void {
  recordNetworkDiagnostic('warn', event, {
    error: networkErrorMessage(error),
    errorKind: networkErrorKind(error),
  });
}
