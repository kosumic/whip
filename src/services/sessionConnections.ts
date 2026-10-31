import type { TFunction } from 'i18next';
import type { NativeAppCore } from 'react-native-whip-ssh';
import {
  SessionConnectionFailureKind as FailureKind,
  SessionConnectionPlatformError as PlatformError,
  SessionConnectionPresentation_Tags as Presentation,
  SessionConnectionOutcome_Tags as Outcome,
  type SessionConnectionFailure,
  type SessionConnectionPermitLike,
  type SessionConnectionPlatform,
  type SessionConnectionProfile,
} from 'react-native-whip-ssh/src/sessionConnections';
import type { HostManagementController } from '../hooks/useHostManagement';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { useApplicationSecurity } from '../hooks/useApplicationSecurity';
import type { useTerminalSessions } from '../hooks/useTerminalSessions';
import type { ConnectOptions, LiveRuntime, SessionRuntimeStore } from '../hooks/sessionRuntimeTypes';
import type { ConnectionProfile, HostProfile } from '../types';
import { classifyConnectionError, connectionErrorContext, connectionErrorTranslationKeys } from '../lib/connectionErrors';
import { waitForRuntimeDestruction } from '../lib/sessionRuntimePolicy';
import { credentialTransactions, hostProfile, material, nativeHost } from './credentialTransactions';
import { CredentialTransactionError } from 'react-native-whip-ssh/src/credentialTransactions';
import { parseChangedHostKey, parseUnknownHostKey } from './knownHosts';
import { herdrSnapshotCache } from './herdrSnapshotCache';
import { recordNetworkDiagnostic } from './networkDiagnostics';
import { reportBackgroundFailure } from './backgroundOperations';
import { loadConnectionProfile } from './hostProfiles';

const failureKinds = {
  authentication: FailureKind.Authentication,
  connectionRefused: FailureKind.ConnectionRefused,
  herdrUnavailable: FailureKind.HerdrUnavailable,
  hostKey: FailureKind.HostKey,
  incompatibleProtocol: FailureKind.IncompatibleProtocol,
  invalidKey: FailureKind.InvalidKey,
  timeout: FailureKind.Timeout,
  unsupportedHostCertificate: FailureKind.UnsupportedHostCertificate,
  unreachable: FailureKind.Unreachable,
  unknown: FailureKind.Unknown,
} as const;

function failure(error: unknown): never {
  const challenge = parseUnknownHostKey(error);
  if (challenge) throw new PlatformError.UnknownHostKey({ challenge });
  const changed = parseChangedHostKey(error);
  if (changed) throw new PlatformError.ChangedHostKey({ challenge: changed });
  const context = connectionErrorContext(error);
  throw new PlatformError.Failed({
    kind: failureKinds[classifyConnectionError(error)],
    expectedProtocol: context.expectedProtocol,
    receivedProtocol: context.receivedProtocol,
  });
}

function check(permit: SessionConnectionPermitLike): void {
  if (!permit.isCurrent()) throw new PlatformError.Cancelled();
}

function profile(value: SessionConnectionProfile): ConnectionProfile {
  return { ...hostProfile(value.host), ...value.credential };
}

export function connectionFailureMessage(value: SessionConnectionFailure, t: TFunction): string {
  if (value.kind === FailureKind.Credential) return t('app.enterCredential');
  const kind = Object.entries(failureKinds).find(([, native]) => native === value.kind)?.[0] as keyof typeof failureKinds | undefined;
  return t(connectionErrorTranslationKeys[kind ?? 'unknown'], {
    host: value.host,
    expectedProtocol: value.expectedProtocol,
    receivedProtocol: value.receivedProtocol,
  });
}

export function sessionConnectionPlatform({
  appCore, commitAppCore, runtimesRef, sessionProfilesRef, hosts, security,
  terminals, navigation, createRuntime, refresh, trackConnecting, t,
}: Pick<SessionRuntimeStore, 'appCore' | 'commitAppCore' | 'runtimesRef' | 'sessionProfilesRef'> & {
  hosts: HostManagementController;
  security: ReturnType<typeof useApplicationSecurity>;
  terminals: ReturnType<typeof useTerminalSessions>;
  navigation: AppNavigationController;
  createRuntime: (id: string, profile: ConnectionProfile) => LiveRuntime;
  refresh: (id: string) => Promise<void>;
  trackConnecting: (ids: string[]) => void;
  t: TFunction;
}): SessionConnectionPlatform {
  // Physical UI handles only. The native attempt owns admission and all policy.
  const handles = new Map<string, LiveRuntime>();
  const bind = (permit: SessionConnectionPermitLike, runtime: LiveRuntime) => {
    handles.set(permit.operationId(), runtime);
    return runtime;
  };
  return {
    async loadProfile(permit, host, interactive) {
      check(permit);
      try {
        const loaded = interactive ? await hosts.loadProfileForConnection(hostProfile(host)) : await loadConnectionProfile(hostProfile(host));
        return loaded?.secret ? { host: nativeHost(loaded), credential: material(loaded) } : undefined;
      } catch (error) {
        if (CredentialTransactionError.Cancelled.instanceOf(error)) throw new PlatformError.Cancelled();
        throw new PlatformError.Failed({ kind: FailureKind.Credential, expectedProtocol: undefined, receivedProtocol: undefined });
      }
    },
    async verifyKeys(permit) {
      check(permit);
      try { return await security.verifyBiometric(); }
      catch { throw new PlatformError.Cancelled(); }
    },
    async waitForCleanup(permit, id) {
      check(permit);
      await waitForRuntimeDestruction(id);
    },
    async connectRuntime(permit, value, jumps) {
      check(permit);
      const connection = profile(value);
      const runtime = handles.get(permit.operationId()) ?? bind(permit, createRuntime(value.host.id, connection));
      runtimesRef.current.set(value.host.id, runtime);
      try {
        await runtime.client.connect(connection, jumps.map(profile), () => permit.isCurrent());
        check(permit);
        return runtime.client.native.connectionHandle;
      } catch (error) {
        if (!permit.isCurrent()) throw new PlatformError.Cancelled();
        return failure(error);
      }
    },
    async confirmTrust(permit, challenge) { check(permit); return hosts.confirmUnknownHost(challenge); },
    async recordTrust(permit, challenge) { check(permit); await hosts.trustChallenge(challenge); },
    async restoreTerminals(permit, id) {
      check(permit);
      try {
        const state = await terminals.restore(id, id, () => permit.isCurrent());
        return Boolean(state.activeTerminalId);
      } catch (error) { return failure(error); }
    },
    async cleanup(permit, id, retainTransport) {
      check(permit);
      const owned = handles.get(permit.operationId());
      if (!owned) return;
      handles.delete(permit.operationId());
      if (runtimesRef.current.get(id) === owned) runtimesRef.current.delete(id);
      if (retainTransport) owned.client.detach();
      else {
        const native = owned.client.activeNative;
        await owned.client.disconnect();
        if (native && native.status().state !== 'disconnected') throw new PlatformError.Failed({ kind: FailureKind.Platform, expectedProtocol: undefined, receivedProtocol: undefined });
      }
    },
    present(permit, event) {
      check(permit);
      if (event.tag === Presentation.Started) {
        hosts.setError(null);
        const host = hostProfile(event.inner.host);
        const previous = runtimesRef.current.get(host.id);
        if (previous && event.inner.replaceRuntime) bind(permit, previous);
        sessionProfilesRef.current.set(host.id, host);
        if (event.inner.showPlaceholder) {
          navigation.showHerd(host.id);
        }
      } else if (event.tag === Presentation.Prepared) {
        const host = hostProfile(event.inner.host);
        sessionProfilesRef.current.set(host.id, host);
        const runtime = handles.get(permit.operationId());
        if (runtime) {
          const state = runtime.client.native.hostState();
          runtime.client.snapshotFromHostState(state);
          if (state.freshness === 'fresh') herdrSnapshotCache.schedule(host.id, runtime.client.native);
        }
      } else if (event.tag === Presentation.Selected) {
        const { sessionId, terminal } = event.inner;
        navigation.selectPane(null);
        if (terminal) navigation.showTerminal(sessionId);
        else navigation.showHerd(sessionId);
        if (event.inner.refresh) reportBackgroundFailure(refresh(sessionId), 'connection-selection-refresh');
      } else if (event.tag === Presentation.Ready) {
        handles.delete(permit.operationId());
        if (event.inner.navigate) {
          hosts.closeEditor();
          if (event.inner.terminal) navigation.showTerminal(event.inner.sessionId);
          else navigation.showHerd(event.inner.sessionId);
        }
      } else if (event.tag === Presentation.Failed) {
        hosts.setError(connectionFailureMessage(event.inner.failure, t));
        if (event.inner.navigate) navigation.selectTab('hosts');
      }
    },
    failureMessage: value => connectionFailureMessage(value, t),
    stateChanged: () => commitAppCore(appCore.view()),
    connectingChanged: () => trackConnecting(appCore.connectionCore.connectingHosts()),
    diagnostic: (hostId, phase, elapsedMs, failed) => recordNetworkDiagnostic(failed ? 'warn' : 'info', 'connection-phase', { hostId, phase, elapsedMs: Number(elapsedMs), failed }),
  };
}

export async function runSessionConnection(appCore: NativeAppCore, platform: SessionConnectionPlatform, host: HostProfile | ConnectionProfile, options: ConnectOptions, saved: boolean, existing?: LiveRuntime, protectKeys = false, sshShellTitle = 'SSH'): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const operation = appCore.connectionCore.startConnection({
    host: nativeHost(host), credential: 'secret' in host ? material(host) : undefined,
    saved, persistProfile: options.persistProfile ?? !saved,
    navigate: options.navigate ?? !saved, activate: options.activateSession ?? true,
    reusePlaceholder: options.reuseConnectingSession ?? saved,
    biometricVerified: options.biometricVerified ?? false, protectKeys,
    promptForTrust: options.promptForUnknownHosts ?? options.navigate ?? !saved,
    existingHost: existing ? nativeHost(existing.profile) : undefined,
    sshShellTitle, attempt: options.connectionAttempt,
  }, credentialTransactions.native, platform);
  const cancel = () => operation.cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const result = await operation.result();
    return result.tag === Outcome.Ready || result.tag === Outcome.Selected;
  } finally { options.signal?.removeEventListener('abort', cancel); }
}
