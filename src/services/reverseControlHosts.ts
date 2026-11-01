import {
  AppConnectionStatus,
  HostActionCoordinator,
  HostActionPlatformError,
  HostAuthMode,
  fromNativeHostProfileRecord,
  fromNativeHerdrBackend,
  toNativeHostProfileRecord,
  type HostActionPermitLike,
  type HostActionProfilePatch,
} from 'react-native-whip-ssh';

import type { LiveHostConnectionStatus } from '../liveHostSessions';
import type { ConnectionProfile, HostProfile } from '../types';
import type { HostMetadataPatch } from './hostProfiles';

export interface HostControlContext {
  ready: boolean;
  locked: boolean;
  biometricForKeys: boolean;
  globalInstructions: string;
  getHosts: () => HostProfile[];
  connections: () => { host_id: string; status: LiveHostConnectionStatus }[];
  authenticate: () => Promise<boolean>;
  saveMetadata: (id: string, patch: HostMetadataPatch, source: string | undefined, permit: HostActionPermitLike) => Promise<{ host: HostProfile }>;
  readCredential: (host: HostProfile, permit: HostActionPermitLike) => Promise<ConnectionProfile>;
  connect: (profile: ConnectionProfile, signal: AbortSignal) => Promise<boolean>;
  deleteTranscripts: (hostId: string) => Promise<void>;
  deleteSnapshot: (hostId: string) => Promise<void>;
  deleteProfile: (hostId: string, permit: HostActionPermitLike) => Promise<unknown>;
  disconnect: (hostId: string, recordDisconnect: boolean) => Promise<void>;
}

const CONNECTION_STATUSES: Record<LiveHostConnectionStatus, AppConnectionStatus> = {
  connecting: AppConnectionStatus.Connecting,
  connected: AppConnectionStatus.Connected,
  ready: AppConnectionStatus.Ready,
  reconnecting: AppConnectionStatus.Reconnecting,
  disconnected: AppConnectionStatus.Disconnected,
  error: AppConnectionStatus.Error,
};

function hostRecord(host: HostProfile) {
  return toNativeHostProfileRecord({
    ...host,
    forwardAgent: host.forwardAgent ?? false,
    herdrEnabled: host.herdrEnabled !== false,
    herdrSocketPath: host.herdrSocketPath ?? '',
  });
}

function metadataPatch(patch: HostActionProfilePatch): HostMetadataPatch {
  return {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.host === undefined ? {} : { host: patch.host }),
    ...(patch.port === undefined ? {} : { port: patch.port }),
    ...(patch.username === undefined ? {} : { username: patch.username }),
    ...(patch.authMode === undefined ? {} : {
      authMode: patch.authMode === HostAuthMode.Key ? 'key' : 'password',
    }),
    ...(patch.herdrCommand === undefined ? {} : { herdrCommand: patch.herdrCommand }),
    ...(patch.herdrBackend === undefined ? {} : {herdrBackend:fromNativeHerdrBackend(patch.herdrBackend)}),
    ...(patch.herdrSocketPath === undefined ? {} : { herdrSocketPath: patch.herdrSocketPath }),
    ...(patch.sessionName === undefined ? {} : { sessionName: patch.sessionName }),
    ...(patch.forwardAgent === undefined ? {} : { forwardAgent: patch.forwardAgent }),
    ...(patch.jumpHostChanged ? { jumpHostId: patch.jumpHostId ?? null } : {}),
  };
}

async function platformEffect<T>(permit: HostActionPermitLike, run: () => Promise<T>): Promise<T> {
  try {
    permit.checkActive();
    const value = await run();
    permit.checkActive();
    return value;
  } catch {
    // Never pass arbitrary Keychain/storage payloads across the native boundary.
    // Rust preserves the authoritative cancellation/authorization outcome.
    throw new HostActionPlatformError.Unavailable();
  }
}

/** Typed OS/storage/connection effects; all host workflow policy is native. */
export class ReverseControlHosts {
  private readonly native: HostActionCoordinator;
  private readonly cancelConnections: () => void;

  constructor(private readonly context: () => HostControlContext) {
    // Only live platform cancellation handles are retained here. Rust owns
    // admission, operation IDs, ordering, revocation and authoritative results.
    const connections = new Map<string, AbortController>();
    this.cancelConnections = () => {
      for (const connection of connections.values()) connection.abort();
      connections.clear();
    };
    this.native = new HostActionCoordinator({
      authenticate: permit => platformEffect(permit, () => context().authenticate()),
      saveMetadata: (permit, hostId, patch, sourceId) => platformEffect(permit, async () => {
        const result = await context().saveMetadata(hostId, metadataPatch(patch), sourceId, permit);
        return hostRecord(result.host);
      }),
      readCredential: (permit, host) => platformEffect(permit, async () => {
        const profile = await context().readCredential(fromNativeHostProfileRecord(host), permit);
        return {
          secret: profile.secret,
          passphrase: profile.passphrase,
          tailcatAddress: profile.tailcatAddress,
          tailcatPrivateKey: profile.tailcatPrivateKey,
          tailcatPublicKey: profile.tailcatPublicKey,
        };
      }),
      connect: (permit, host, credential) => platformEffect(permit, async () => {
        const abort = new AbortController();
        const operationId = permit.operationId();
        connections.set(operationId, abort);
        try {
          permit.checkActive();
          return await context().connect({ ...fromNativeHostProfileRecord(host), ...credential }, abort.signal);
        } finally {
          connections.delete(operationId);
        }
      }),
      deleteTranscripts: (permit, hostId) => platformEffect(permit, () => context().deleteTranscripts(hostId)),
      deleteSnapshot: (permit, hostId) => platformEffect(permit, () => context().deleteSnapshot(hostId)),
      deleteProfile: (permit, hostId) => platformEffect(permit, async () => {
        await context().deleteProfile(hostId, permit);
      }),
      disconnect: (permit, hostId, recordDisconnect) => platformEffect(permit, () => context().disconnect(hostId, recordDisconnect)),
      cancel: operationId => {
        connections.get(operationId)?.abort();
        connections.delete(operationId);
      },
    });
  }

  updateContext(): void {
    const context = this.context();
    this.native.updateContext({
      ready: context.ready,
      locked: context.locked,
      biometricForKeys: context.biometricForKeys,
      globalInstructions: context.globalInstructions,
      hosts: context.getHosts().map(hostRecord),
      connections: context.connections().map(connection => ({
        hostId: connection.host_id,
        status: CONNECTION_STATUSES[connection.status],
      })),
    });
  }

  dispose(): void {
    this.native.close();
    // Release OS resources before this JS adapter/runtime can be collected.
    this.cancelConnections();
  }
}
