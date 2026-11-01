import { NativeModules, Platform } from 'react-native';
import {toNativeHerdrBackend,fromNativeHerdrBackend} from 'react-native-whip-ssh/src/herdrBackend';
import * as Keychain from 'react-native-keychain';
import {
  CredentialCoordinator,
  CredentialEffect_Tags,
  CredentialEffectResult,
  CredentialPlatformError,
  CredentialTransactionError,
  CredentialStorageKey,
  CredentialSlot_Tags,
  HostAuthMode,
  type CredentialPlatform,
  type CredentialProfileView,
  type CredentialRequest,
  type CredentialMaterial,
  type CredentialResult,
  type HostActionPermitLike,
  type HostProfileRecord,
  type CredentialEffect,
} from 'react-native-whip-ssh/src/credentialTransactions';

import { appStorage } from './appStorage';
import { hostCredentialService, LEGACY_CREDENTIAL_SERVICE } from '../lib/hostProfiles';
import type { ConnectionProfile, HostProfile } from '../types';
import { recordOperationalDiagnostic } from './operationalDiagnostics';
import { recordStorageDiagnostic } from './storageDiagnostics';

const STORAGE_KEYS = {
  [CredentialStorageKey.Hosts]: 'herdr.hosts.v2',
  [CredentialStorageKey.LegacyProfile]: 'herdr.connection.v1',
  [CredentialStorageKey.GlobalKeys]: 'herdr.global-ssh-keys.v1',
  [CredentialStorageKey.Backups]: 'herdr.credential.backups.v1',
  [CredentialStorageKey.BackupMigration]: 'herdr.credentials.backup-migration',
  [CredentialStorageKey.Transactions]: 'whip.credentials.transactions.v1',
} as const;
export const GLOBAL_SSH_KEYCHAIN_SERVICE = 'io.github.kaminarios.whip.ssh.global-keychain.v1';

interface NativeVault {
  hasLocalRecoveryKey(): Promise<boolean>;
  encryptCredential(plaintext: string, credentialId: string): Promise<string>;
  decryptCredential(ciphertext: string, credentialId: string): Promise<string>;
  unlockRecoveryKey(): Promise<boolean>;
  clearRecoveryKey(): Promise<void>;
}
function vault(): NativeVault | undefined {
  return Platform.OS === 'android' ? NativeModules.HerdrCredentialVault as NativeVault | undefined : undefined;
}
function requireVault(): NativeVault {
  const module = vault();
  if (!module) throw new CredentialPlatformError.Unsupported();
  return module;
}
function service(slot: Extract<CredentialEffect, { tag: CredentialEffect_Tags.ReadSecure }>['inner']['slot']): string {
  switch (slot.tag) {
    case CredentialSlot_Tags.Host: return hostCredentialService(slot.inner.id);
    case CredentialSlot_Tags.Legacy: return LEGACY_CREDENTIAL_SERVICE;
    case CredentialSlot_Tags.Global: return GLOBAL_SSH_KEYCHAIN_SERVICE;
  }
}

/** Physical I/O only: Rust chooses ordering, compensation and recovery. */
export function credentialPlatform(changed: (view: CredentialProfileView) => void = () => {}): CredentialPlatform {
  return {
    effect: async (permit, effect) => {
      try {
        permit.checkActive();
        switch (effect.tag) {
          case CredentialEffect_Tags.ReadMetadata: {
            const keys = effect.inner.keys.map(key => STORAGE_KEYS[key]);
            const values = keys.length === 1 ? [[keys[0], await appStorage.getItem(keys[0])] as const] : await appStorage.multiGet(keys);
            if (values.length !== keys.length || values.some(([key], index) => key !== keys[index])) throw new CredentialPlatformError.MetadataStorage();
            return new CredentialEffectResult.Metadata({ entries: values.map(([, value], index) => ({ key: effect.inner.keys[index], value: value ?? undefined })) });
          }
          case CredentialEffect_Tags.WriteMetadata: {
            const entries = effect.inner.entries.map(({ key, value }) => {
              if (value === undefined) throw new CredentialPlatformError.MetadataStorage();
              return [STORAGE_KEYS[key], value] as const;
            });
            if (entries.length === 1) await appStorage.setItem(...entries[0]);
            else await appStorage.multiSet(entries);
            return new CredentialEffectResult.Done();
          }
          case CredentialEffect_Tags.ReadSecure: {
            const value = await Keychain.getGenericPassword({ service: service(effect.inner.slot) });
            return new CredentialEffectResult.Text({ value: value ? value.password : undefined });
          }
          case CredentialEffect_Tags.WriteSecure: {
            const value = await Keychain.setGenericPassword(effect.inner.username, effect.inner.value, {
              accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
              service: service(effect.inner.slot),
            });
            if (!value) throw new CredentialPlatformError.SecureStorage();
            return new CredentialEffectResult.Done();
          }
          case CredentialEffect_Tags.ClearSecure: {
            const slot = service(effect.inner.slot);
            const cleared = await Keychain.resetGenericPassword({ service: slot });
            if (!cleared && await Keychain.getGenericPassword({ service: slot })) throw new CredentialPlatformError.SecureStorage();
            return new CredentialEffectResult.Done();
          }
          case CredentialEffect_Tags.Encrypt:
            return new CredentialEffectResult.Text({ value: await requireVault().encryptCredential(effect.inner.plaintext, effect.inner.id) });
          case CredentialEffect_Tags.Decrypt:
            return new CredentialEffectResult.Text({ value: await requireVault().decryptCredential(effect.inner.ciphertext, effect.inner.id) });
          case CredentialEffect_Tags.VaultAvailable:
            return new CredentialEffectResult.Boolean({ value: !!vault() });
          case CredentialEffect_Tags.HasRecoveryKey:
            return new CredentialEffectResult.Boolean({ value: await requireVault().hasLocalRecoveryKey() });
          case CredentialEffect_Tags.UnlockRecoveryKey:
            return new CredentialEffectResult.Boolean({ value: await requireVault().unlockRecoveryKey() });
          case CredentialEffect_Tags.ClearRecoveryKey:
            await requireVault().clearRecoveryKey();
            return new CredentialEffectResult.Done();
          case CredentialEffect_Tags.AuthenticateGlobal:
            await (await import('./appAuthentication')).authenticateGlobalKeychain();
            return new CredentialEffectResult.Boolean({ value: true });
        }
      } catch (error) {
        if (error instanceof CredentialPlatformError.Unsupported) throw error;
        if (error instanceof CredentialTransactionError.Cancelled) throw new CredentialPlatformError.Cancelled();
        if (error && typeof error === 'object' && 'code' in error && error.code === 'E_CREDENTIAL_VAULT_CANCELLED') throw new CredentialPlatformError.Cancelled();
        if (effect.tag === CredentialEffect_Tags.AuthenticateGlobal || effect.tag === CredentialEffect_Tags.UnlockRecoveryKey) throw new CredentialPlatformError.Denied();
        const metadata = effect.tag === CredentialEffect_Tags.ReadMetadata || effect.tag === CredentialEffect_Tags.WriteMetadata;
        if (metadata) recordStorageDiagnostic('error', effect.tag === CredentialEffect_Tags.ReadMetadata ? 'storage-read-failed' : 'storage-write-failed', { store: 'credential-transactions', operation: effect.tag });
        else recordOperationalDiagnostic('error', 'Credential', 'credential-platform-effect-failed', { operation: effect.tag });
        // Foreign exception text can contain credentials, private keys or URLs.
        // Only bounded typed outcomes cross back into the native workflow.
        throw metadata ? new CredentialPlatformError.MetadataStorage() : new CredentialPlatformError.SecureStorage();
      }
    },
    profilesChanged: view => {
      try { changed(view); }
      catch { recordOperationalDiagnostic('error', 'Credential', 'host-profile-observer-failed', {}); }
    },
    diagnostic: (event, hostId) => recordOperationalDiagnostic('warn', 'Credential', event, { hostId }),
  };
}

export function nativeHost(host: HostProfile): HostProfileRecord {
  return {
    id: host.id, name: host.name, host: host.host, port: host.port, username: host.username,
    authMode: host.authMode === 'key' ? HostAuthMode.Key : HostAuthMode.Password,
    jumpHostId: host.jumpHostId, forwardAgent: !!host.forwardAgent, tailcatEnabled: !!host.tailcatEnabled,
    tailcatSshServer: !!host.tailcatSshServer, herdrEnabled: host.herdrEnabled !== false,
    herdrCommand: host.herdrCommand, herdrSocketPath: host.herdrSocketPath ?? '', sessionName: host.sessionName,
    herdrBackend: toNativeHerdrBackend(host.herdrBackend),
    agentInstructions: host.agentInstructions ?? '', createdAt: host.createdAt, updatedAt: host.updatedAt,
    lastConnectedAt: host.lastConnectedAt,
  };
}
export function hostProfile(host: HostProfileRecord): HostProfile {
  return { ...host, authMode: host.authMode === HostAuthMode.Key ? 'key' : 'password',herdrBackend:fromNativeHerdrBackend(host.herdrBackend) };
}
export function material(profile: Pick<ConnectionProfile, 'secret' | 'passphrase' | 'tailcatAddress' | 'tailcatPrivateKey' | 'tailcatPublicKey'>): CredentialMaterial {
  return { secret: profile.secret, passphrase: profile.passphrase ?? '', tailcatAddress: profile.tailcatAddress, tailcatPrivateKey: profile.tailcatPrivateKey, tailcatPublicKey: profile.tailcatPublicKey };
}

export class CredentialTransactions {
  readonly native: CredentialCoordinator;
  constructor(changed?: (view: CredentialProfileView) => void) { this.native = new CredentialCoordinator(credentialPlatform(changed)); }
  async run(command: CredentialRequest, guard?: HostActionPermitLike, signal?: AbortSignal): Promise<CredentialResult> {
    const operation = this.native.begin(command, guard);
    const cancel = () => operation.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { return await operation.result(); }
    finally { signal?.removeEventListener('abort', cancel); }
  }
  dispose() { this.native.close(); }
}

export const credentialTransactions = new CredentialTransactions();
