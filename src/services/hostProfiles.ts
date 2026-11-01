import {
  CredentialCommand,
  CredentialResult_Tags,
  CredentialTransactionError,
  HostAuthMode,
  type CredentialResult,
  type HostActionPermitLike,
  type HostActionProfilePatch,
} from 'react-native-whip-ssh/src/credentialTransactions';
import type { ConnectionProfile, HostProfile } from '../types';
import {toNativeHerdrBackend} from 'react-native-whip-ssh/src/herdrBackend';
import { CredentialTransactions, credentialTransactions, hostProfile, material, nativeHost } from './credentialTransactions';
import { reportBackgroundFailure } from './backgroundOperations';

export type HostMetadataPatch = Partial<Omit<HostProfile, 'jumpHostId'>> & { jumpHostId?: string | null };
export const CREDENTIAL_BACKUP_MIGRATION_KEY = 'herdr.credentials.backup-migration';
export const CREDENTIAL_BACKUP_MIGRATION_VERSION = '1';

export class HostProfilesUnavailableError extends Error {
  constructor() {
    super('Host profiles must be loaded successfully before they can be changed');
    this.name = 'HostProfilesUnavailableError';
  }
}

function hosts(result: CredentialResult): HostProfile[] {
  if (result.tag !== CredentialResult_Tags.Hosts) throw new Error('Invalid native host profile result');
  return result.inner.hosts.map(hostProfile);
}

/** Presentation subscriptions over the native transaction owner. */
export class HostProfileRepository {
  private readonly transactions: CredentialTransactions;
  private readonly listeners = new Set<(hosts: HostProfile[]) => void>();
  private revision = 0n;
  constructor() {
    this.transactions = new CredentialTransactions(view => {
      if (view.revision < this.revision) return;
      this.revision = view.revision;
      for (const listener of this.listeners) listener(view.hosts.map(hostProfile));
    });
  }
  subscribe(listener: (hosts: HostProfile[]) => void): () => void {
    this.listeners.add(listener);
    const view = this.transactions.native.view();
    if (view.revision > this.revision) this.revision = view.revision;
    if (view.loaded) listener(view.hosts.map(hostProfile));
    return () => { this.listeners.delete(listener); };
  }
  private async run(command: Parameters<CredentialTransactions['run']>[0], guard?: HostActionPermitLike) {
    try { return await this.transactions.run(command, guard); }
    catch (error) {
      if (error instanceof CredentialTransactionError.ProfilesUnavailable) throw new HostProfilesUnavailableError();
      throw error;
    }
  }
  async loadHostProfiles(): Promise<HostProfile[]> {
    const result = hosts(await this.run(new CredentialCommand.LoadHosts({ fromStorage: false })));
    scheduleCredentialBackupMigration(result);
    return result;
  }
  async loadHostProfilesFromStorage(stored: string | null, legacy: string | null): Promise<HostProfile[]> {
    return hosts(await this.run(new CredentialCommand.LoadHosts({ fromStorage: true, hosts: stored ?? undefined, legacy: legacy ?? undefined })));
  }
  async saveConnectionProfile(profile: ConnectionProfile): Promise<{ hosts: HostProfile[]; host: HostProfile }> {
    const result = await this.run(new CredentialCommand.SaveHost({ profile: nativeHost(profile), credential: material(profile) }));
    if (result.tag !== CredentialResult_Tags.Saved) throw new Error('Invalid native host save result');
    return { hosts: result.inner.hosts.map(hostProfile), host: hostProfile(result.inner.host) };
  }
  async ensureTailcatIdentity(profile: ConnectionProfile): Promise<ConnectionProfile> {
    const result = await this.run(new CredentialCommand.EnsureIdentity({ host: nativeHost(profile), credential: material(profile) }));
    if (result.tag !== CredentialResult_Tags.Material) throw new Error('Invalid native credential result');
    return { ...profile, ...result.inner.credential };
  }
  async saveHostMetadata(id: string, patch: HostMetadataPatch, source?: string, guard?: HostActionPermitLike): Promise<{ host: HostProfile }> {
    const nativePatch: HostActionProfilePatch = {
      name: patch.name, host: patch.host, port: patch.port, username: patch.username,
      authMode: patch.authMode === undefined ? undefined : patch.authMode === 'key' ? HostAuthMode.Key : HostAuthMode.Password,
      herdrCommand: patch.herdrCommand, herdrSocketPath: patch.herdrSocketPath,
      herdrBackend: patch.herdrBackend === undefined ? undefined : toNativeHerdrBackend(patch.herdrBackend),
      sessionName: patch.sessionName, forwardAgent: patch.forwardAgent,
      jumpHostId: patch.jumpHostId ?? undefined, jumpHostChanged: patch.jumpHostId !== undefined,
    };
    const result = await this.run(new CredentialCommand.SaveMetadata({ id, patch: nativePatch, source }), guard);
    if (result.tag !== CredentialResult_Tags.Host) throw new Error('Invalid native metadata result');
    return { host: hostProfile(result.inner.host) };
  }
  async markHostDisconnected(id: string): Promise<HostProfile[]> {
    return hosts(await this.run(new CredentialCommand.MarkDisconnected({ id })));
  }
  async deleteHostProfile(id: string, guard?: HostActionPermitLike): Promise<HostProfile[]> {
    return hosts(await this.run(new CredentialCommand.DeleteHost({ id }), guard));
  }
}

const repository = new HostProfileRepository();
export const loadHostProfiles = repository.loadHostProfiles.bind(repository);
export const loadHostProfilesFromStorage = repository.loadHostProfilesFromStorage.bind(repository);
export const saveConnectionProfile = repository.saveConnectionProfile.bind(repository);
export const ensureTailcatIdentity = repository.ensureTailcatIdentity.bind(repository);
export const saveHostMetadata = repository.saveHostMetadata.bind(repository);
export const markHostDisconnected = repository.markHostDisconnected.bind(repository);
export const deleteHostProfile = repository.deleteHostProfile.bind(repository);
export const subscribeToHostProfiles = repository.subscribe.bind(repository);

export function scheduleCredentialBackupMigration(_hosts: readonly HostProfile[]): void {
  reportBackgroundFailure(migrateCredentialBackupsIfNeeded(_hosts), 'credential-backup-migration');
}
export async function migrateCredentialBackupsIfNeeded(_hosts: readonly HostProfile[]): Promise<void> {
  await credentialTransactions.run(new CredentialCommand.MigrateBackups());
}
export async function loadConnectionProfile(host: HostProfile, guard?: HostActionPermitLike): Promise<ConnectionProfile> {
  const result = await credentialTransactions.run(new CredentialCommand.ReadHost({ host: nativeHost(host), strict: false }), guard);
  if (result.tag !== CredentialResult_Tags.Material) throw new Error('Invalid native credential result');
  return { ...host, ...result.inner.credential };
}
export async function loadJumpHostConnectionProfiles(profiles: HostProfile[], profile: Pick<HostProfile, 'id' | 'jumpHostId'>): Promise<ConnectionProfile[]> {
  const { resolveJumpHostChain } = await import('../lib/hostProfiles');
  return Promise.all(resolveJumpHostChain(profiles, profile).map(host => loadConnectionProfile(host)));
}
