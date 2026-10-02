import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { TFunction } from 'i18next';

import { deleteAgentChatCachesForHost } from '../services/agentChatCache';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  credentialRecoveryStatus,
  restoreCredentialBackups,
  type CredentialRecoveryStatus,
} from '../services/credentialVault';
import {
  loadGlobalSshKeys,
  unlockGlobalSshKeychain as unlockStoredGlobalSshKeychain,
} from '../services/globalSshKeychain';
import {
  deleteHostProfile,
  loadConnectionProfile,
  loadHostProfiles,
  loadHostProfilesFromStorage,
  markHostDisconnected,
  migrateCredentialBackupsIfNeeded,
  saveConnectionProfile,
} from '../services/hostProfiles';
import {
  deleteKnownHost,
  knownHostsFromStorage,
  loadKnownHosts,
  KnownHostsUnavailableError,
  trustKnownHost,
  type KnownHostsLoadState,
  type UnknownHostKeyChallenge,
} from '../services/knownHosts';
import { withAppPerformanceTrace } from '../services/performanceTrace';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import { emptyConnectionProfile } from '../lib/hostProfiles';
import {
  profileFromPairing,
  type PairHostResult,
  type PairingKeySelection,
} from '../lib/sshPairing';
import type {
  ConnectionProfile,
  GlobalSshKey,
  GlobalSshKeyMaterial,
  HostProfile,
  KnownHost,
} from '../types';
import type { LoadState } from './useStartupStorage';

interface HostManagementOptions {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
  t: TFunction;
  onDeleteConnectedHost: (hostId: string) => void;
}

export interface HostManagementController {
  hosts: HostProfile[];
  knownHosts: KnownHost[];
  globalSshKeys: GlobalSshKey[];
  unlockedGlobalKeys: GlobalSshKeyMaterial[] | null;
  editorProfile: ConnectionProfile | null;
  newHostOpen: boolean;
  knownHostsOpen: boolean;
  unknownHostChallenge: UnknownHostKeyChallenge | null;
  pairingSuccess: PairHostResult | null;
  profilesLoaded: boolean;
  knownHostsLoaded: boolean;
  knownHostsState: KnownHostsLoadState;
  error: string | null;
  credentialRecovery: CredentialRecoveryStatus;
  credentialRecoveryBusy: boolean;
  deleteHostTarget: HostProfile | null;
  deleteHostBusy: boolean;
  getHosts: () => HostProfile[];
  setError: (error: string | null) => void;
  replaceHosts: (hosts: HostProfile[]) => void;
  persistProfile: (
    profile: ConnectionProfile,
  ) => Promise<{ hosts: HostProfile[]; host: HostProfile }>;
  markDisconnected: (hostId: string) => void;
  confirmUnknownHost: (challenge: UnknownHostKeyChallenge) => Promise<boolean>;
  trustChallenge: (challenge: UnknownHostKeyChallenge) => Promise<void>;
  resolveUnknownHost: (trusted: boolean) => void;
  loadProfileForConnection: (
    host: HostProfile,
  ) => Promise<ConnectionProfile | null>;
  openNewHost: () => void;
  closeNewHost: () => void;
  openManualHost: () => void;
  openEditor: (host: HostProfile) => Promise<void>;
  closeEditor: () => void;
  saveHost: (profile: ConnectionProfile) => Promise<void>;
  savePairedHost: (
    result: PairHostResult,
    key: PairingKeySelection,
  ) => Promise<void>;
  unlockGlobalKeychain: () => Promise<GlobalSshKeyMaterial[] | null>;
  openGlobalKeychain: () => Promise<void>;
  closeGlobalKeychain: () => void;
  updateGlobalKeys: (keys: GlobalSshKeyMaterial[]) => void;
  retryKnownHosts: () => Promise<void>;
  forgetKnownHost: (id: string) => Promise<void>;
  openKnownHosts: () => void;
  closeKnownHosts: () => void;
  confirmDelete: (host: HostProfile) => void;
  cancelDelete: () => void;
  deleteConfirmed: () => Promise<void>;
  unlockCredentialRecovery: () => Promise<boolean>;
  dismissTopOverlay: () => boolean;
  closePairingSuccess: () => void;
  completeLiveHostRestore: () => void;
}

/** Owns host profiles, credentials, trust data, and host-management flows. */
export function useHostManagement({
  startupStorage,
  deferredHydrationReady,
  t,
  onDeleteConnectedHost,
}: HostManagementOptions): HostManagementController {
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [knownHostsState, setKnownHostsState] = useState<KnownHostsLoadState>({
    status: 'loading',
  });
  const [globalSshKeys, setGlobalSshKeys] = useState<GlobalSshKey[]>([]);
  const [unlockedGlobalKeys, setUnlockedGlobalKeys] = useState<
    GlobalSshKeyMaterial[] | null
  >(null);
  const [editorProfile, setEditorProfile] = useState<ConnectionProfile | null>(
    null,
  );
  const [newHostOpen, setNewHostOpen] = useState(false);
  const [knownHostsOpen, setKnownHostsOpen] = useState(false);
  const [unknownHostChallenge, setUnknownHostChallenge] =
    useState<UnknownHostKeyChallenge | null>(null);
  const [pairingSuccess, setPairingSuccess] = useState<PairHostResult | null>(
    null,
  );
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialRecovery, setCredentialRecovery] =
    useState<CredentialRecoveryStatus>({ state: 'none', count: 0 });
  const [credentialRecoveryBusy, setCredentialRecoveryBusy] = useState(false);
  const [deleteHostTarget, setDeleteHostTarget] = useState<HostProfile | null>(
    null,
  );
  const [deleteHostBusy, setDeleteHostBusy] = useState(false);
  const hostsRef = useRef(hosts);
  const knownHostsStateRef = useRef(knownHostsState);
  const profileHydrationStartedRef = useRef(false);
  const deferredHydrationStartedRef = useRef(false);
  const credentialMigrationStartedRef = useRef(false);
  const unknownHostResolutionRef = useRef<((trusted: boolean) => void) | null>(
    null,
  );
  const onDeleteConnectedHostRef = useRef(onDeleteConnectedHost);
  onDeleteConnectedHostRef.current = onDeleteConnectedHost;
  hostsRef.current = hosts;
  knownHostsStateRef.current = knownHostsState;

  const knownHosts = useMemo(
    () => knownHostsState.status === 'loaded' ? knownHostsState.hosts : [],
    [knownHostsState],
  );
  const knownHostsLoaded = knownHostsState.status === 'loaded';

  const replaceHosts = useCallback((value: HostProfile[]) => {
    hostsRef.current = value;
    setHosts(value);
  }, []);

  const replaceKnownHostsState = useCallback((value: KnownHostsLoadState) => {
    knownHostsStateRef.current = value;
    setKnownHostsState(value);
  }, []);

  useEffect(() => {
    reportBackgroundFailure(
      loadGlobalSshKeys().then(setGlobalSshKeys),
      'global-ssh-keys-load',
    );
  }, []);

  useEffect(() => {
    if (
      startupStorage.status === 'loading' ||
      profileHydrationStartedRef.current
    )
      return;
    profileHydrationStartedRef.current = true;
    const load =
      startupStorage.status === 'loaded'
        ? loadHostProfilesFromStorage(
            startupStorage.value.hosts,
            startupStorage.value.legacyHost,
          )
        : loadHostProfiles();
    withAppPerformanceTrace('Whip startup store: hosts', () => load)
      .then(replaceHosts)
      .catch(loadError => {
        setError(t('app.loadHostsError', { error: String(loadError) }));
        replaceHosts([]);
      })
      .finally(() => setProfilesLoaded(true));
  }, [replaceHosts, startupStorage, t]);

  useEffect(() => {
    if (!deferredHydrationReady || deferredHydrationStartedRef.current) return;
    deferredHydrationStartedRef.current = true;
    const load =
      startupStorage.status === 'loaded'
        ? knownHostsFromStorage(startupStorage.value.knownHosts)
        : loadKnownHosts();
    reportBackgroundFailure(
      withAppPerformanceTrace(
        'Whip startup store: known hosts',
        () => load,
      ).then(replaceKnownHostsState),
      'known-hosts-load',
    );
    reportBackgroundFailure(
      withAppPerformanceTrace(
        'Whip startup store: credential status',
        credentialRecoveryStatus,
      ).then(setCredentialRecovery),
      'credential-recovery-status-load',
    );
  }, [deferredHydrationReady, replaceKnownHostsState, startupStorage]);

  const retryKnownHosts = useCallback(async () => {
    replaceKnownHostsState({ status: 'loading' });
    replaceKnownHostsState(await withAppPerformanceTrace(
      'Whip known hosts: retry storage load',
      loadKnownHosts,
    ));
  }, [replaceKnownHostsState]);

  const completeLiveHostRestore = useCallback(() => {
    if (!deferredHydrationReady || credentialMigrationStartedRef.current)
      return;
    credentialMigrationStartedRef.current = true;
    reportBackgroundFailure(
      withAppPerformanceTrace('Whip startup store: credential backups', () =>
        migrateCredentialBackupsIfNeeded(hostsRef.current),
      ),
      'credential-backup-migration',
    );
  }, [deferredHydrationReady]);

  const persistProfile = useCallback(
    async (profile: ConnectionProfile) => {
      const saved = await saveConnectionProfile(hostsRef.current, profile);
      replaceHosts(saved.hosts);
      return saved;
    },
    [replaceHosts],
  );

  const markDisconnected = useCallback(
    (hostId: string) => {
      reportBackgroundFailure(
        markHostDisconnected(hostsRef.current, hostId).then(replaceHosts),
        'host-disconnected-persist',
      );
    },
    [replaceHosts],
  );

  const unlockCredentialRecovery = useCallback(async (): Promise<boolean> => {
    setCredentialRecoveryBusy(true);
    setError(null);
    try {
      const result = await restoreCredentialBackups(hostsRef.current);
      setCredentialRecovery(await credentialRecoveryStatus());
      if (result.failed > 0) {
        setError(
          t('app.restoreCredentialsPartial', {
            restored: result.restored,
            failed: result.failed,
          }),
        );
      }
      return result.restored > 0;
    } catch (restoreError) {
      if (
        (restoreError as { code?: string }).code !==
        'E_CREDENTIAL_VAULT_CANCELLED'
      ) {
        setError(
          t('app.restoreCredentialsError', { error: String(restoreError) }),
        );
      }
      setCredentialRecovery(await credentialRecoveryStatus());
      return false;
    } finally {
      setCredentialRecoveryBusy(false);
    }
  }, [t]);

  const loadProfileForConnection = useCallback(
    async (host: HostProfile): Promise<ConnectionProfile | null> => {
      let profile = await loadConnectionProfile(host);
      if (
        !profile.secret
        && credentialRecovery.state === 'locked'
        && await unlockCredentialRecovery()
      ) {
        profile = await loadConnectionProfile(host);
      }
      if (profile.secret) return profile;
      setEditorProfile(profile);
      setError(t('app.enterCredential'));
      return null;
    },
    [credentialRecovery.state, t, unlockCredentialRecovery],
  );

  const saveHost = useCallback(
    async (profile: ConnectionProfile) => {
      setError(null);
      try {
        await persistProfile(profile);
        setCredentialRecovery(await credentialRecoveryStatus());
        setEditorProfile(null);
      } catch (saveError) {
        setError(t('app.saveHostError', { error: String(saveError) }));
      }
    },
    [persistProfile, t],
  );

  const savePairedHost = useCallback(
    async (result: PairHostResult, key: PairingKeySelection) => {
      const nextKnownHosts = await trustKnownHost({
        host: result.sshHost,
        port: result.sshPort,
        keyType: result.sshHostKeyType,
        publicKey: result.sshHostPublicKey,
        fingerprint: result.sshHostFingerprint,
      });
      replaceKnownHostsState({ status: 'loaded', hosts: nextKnownHosts });
      await persistProfile(profileFromPairing(result, key));
      setCredentialRecovery(await credentialRecoveryStatus());
      setNewHostOpen(false);
      if (key.privateKey) setPairingSuccess(result);
    },
    [persistProfile, replaceKnownHostsState],
  );

  const openEditor = useCallback(
    async (host: HostProfile) => {
      setError(null);
      try {
        setEditorProfile(await loadConnectionProfile(host));
      } catch (loadError) {
        setError(t('app.loadCredentialsError', { error: String(loadError) }));
      }
    },
    [t],
  );

  const unlockGlobalKeychain = useCallback(async () => {
    try {
      return await unlockStoredGlobalSshKeychain();
    } catch (unlockError) {
      if (
        (unlockError as { code?: string }).code !==
        'E_GLOBAL_KEYCHAIN_CANCELLED'
      ) {
        Alert.alert(
          t('keychain.unlockError'),
          t('keychain.unlockErrorCopy', { error: String(unlockError) }),
        );
      }
      return null;
    }
  }, [t]);

  const openGlobalKeychain = useCallback(async () => {
    const keys = await unlockGlobalKeychain();
    if (keys !== null) setUnlockedGlobalKeys(keys);
  }, [unlockGlobalKeychain]);

  const updateGlobalKeys = useCallback((keys: GlobalSshKeyMaterial[]) => {
    setUnlockedGlobalKeys(keys);
    setGlobalSshKeys(
      keys.map(({ secret: _secret, passphrase: _passphrase, ...key }) => key),
    );
  }, []);

  const confirmUnknownHost = useCallback(
    (challenge: UnknownHostKeyChallenge): Promise<boolean> => {
      if (knownHostsStateRef.current.status !== 'loaded') {
        return Promise.reject(new KnownHostsUnavailableError());
      }
      return new Promise(resolve => {
        unknownHostResolutionRef.current?.(false);
        unknownHostResolutionRef.current = resolve;
        setUnknownHostChallenge(challenge);
      });
    },
    [],
  );

  const resolveUnknownHost = useCallback((trusted: boolean) => {
    const resolve = unknownHostResolutionRef.current;
    unknownHostResolutionRef.current = null;
    setUnknownHostChallenge(null);
    resolve?.(trusted);
  }, []);

  const trustChallenge = useCallback(
    async (challenge: UnknownHostKeyChallenge) => {
      const trustedHosts = await trustKnownHost(challenge);
      replaceKnownHostsState({ status: 'loaded', hosts: trustedHosts });
    },
    [replaceKnownHostsState],
  );

  const forgetKnownHost = useCallback(async (id: string) => {
    const remainingHosts = await deleteKnownHost(id);
    replaceKnownHostsState({ status: 'loaded', hosts: remainingHosts });
  }, [replaceKnownHostsState]);

  const deleteConfirmed = useCallback(async () => {
    if (!deleteHostTarget || deleteHostBusy) return;
    const target = deleteHostTarget;
    setDeleteHostBusy(true);
    onDeleteConnectedHostRef.current(target.id);
    try {
      await deleteAgentChatCachesForHost(target.id);
      await herdrSnapshotCache.delete(target.id);
      replaceHosts(await deleteHostProfile(hostsRef.current, target.id));
      setCredentialRecovery(await credentialRecoveryStatus());
      setEditorProfile(null);
      setError(null);
      setDeleteHostTarget(null);
    } catch (deleteError) {
      setDeleteHostTarget(null);
      setError(t('app.deleteHostError', { error: String(deleteError) }));
    } finally {
      setDeleteHostBusy(false);
    }
  }, [deleteHostBusy, deleteHostTarget, replaceHosts, t]);

  const dismissTopOverlay = useCallback(() => {
    if (knownHostsOpen) setKnownHostsOpen(false);
    else if (unlockedGlobalKeys !== null) setUnlockedGlobalKeys(null);
    else if (editorProfile) {
      setEditorProfile(null);
      setError(null);
    } else if (newHostOpen) {
      setNewHostOpen(false);
      setError(null);
    } else return false;
    return true;
  }, [editorProfile, knownHostsOpen, newHostOpen, unlockedGlobalKeys]);

  const getHosts = useCallback(() => hostsRef.current, []);
  const openNewHost = useCallback(() => {
    setError(null);
    setNewHostOpen(true);
  }, []);
  const closeNewHost = useCallback(() => {
    setNewHostOpen(false);
    setError(null);
  }, []);
  const openManualHost = useCallback(() => {
    setNewHostOpen(false);
    setEditorProfile(emptyConnectionProfile());
  }, []);
  const closeEditor = useCallback(() => {
    setEditorProfile(null);
    setError(null);
  }, []);
  const closeGlobalKeychain = useCallback(
    () => setUnlockedGlobalKeys(null),
    [],
  );
  const openKnownHosts = useCallback(() => setKnownHostsOpen(true), []);
  const closeKnownHosts = useCallback(() => setKnownHostsOpen(false), []);
  const cancelDelete = useCallback(() => setDeleteHostTarget(null), []);
  const closePairingSuccess = useCallback(() => setPairingSuccess(null), []);

  return useMemo(
    () => ({
      hosts,
      knownHosts,
      globalSshKeys,
      unlockedGlobalKeys,
      editorProfile,
      newHostOpen,
      knownHostsOpen,
      unknownHostChallenge,
      pairingSuccess,
      profilesLoaded,
      knownHostsLoaded,
      knownHostsState,
      error,
      credentialRecovery,
      credentialRecoveryBusy,
      deleteHostTarget,
      deleteHostBusy,
      getHosts,
      setError,
      replaceHosts,
      persistProfile,
      markDisconnected,
      confirmUnknownHost,
      trustChallenge,
      resolveUnknownHost,
      loadProfileForConnection,
      openNewHost,
      closeNewHost,
      openManualHost,
      openEditor,
      closeEditor,
      saveHost,
      savePairedHost,
      unlockGlobalKeychain,
      openGlobalKeychain,
      closeGlobalKeychain,
      updateGlobalKeys,
      retryKnownHosts,
      forgetKnownHost,
      openKnownHosts,
      closeKnownHosts,
      confirmDelete: setDeleteHostTarget,
      cancelDelete,
      deleteConfirmed,
      unlockCredentialRecovery,
      dismissTopOverlay,
      closePairingSuccess,
      completeLiveHostRestore,
    }),
    [
      cancelDelete,
      closeEditor,
      closeGlobalKeychain,
      closeKnownHosts,
      closeNewHost,
      closePairingSuccess,
      completeLiveHostRestore,
      confirmUnknownHost,
      credentialRecovery,
      credentialRecoveryBusy,
      deleteConfirmed,
      deleteHostBusy,
      deleteHostTarget,
      dismissTopOverlay,
      editorProfile,
      error,
      forgetKnownHost,
      getHosts,
      globalSshKeys,
      hosts,
      knownHosts,
      knownHostsLoaded,
      knownHostsState,
      knownHostsOpen,
      loadProfileForConnection,
      markDisconnected,
      newHostOpen,
      openEditor,
      openGlobalKeychain,
      openKnownHosts,
      openManualHost,
      openNewHost,
      pairingSuccess,
      persistProfile,
      profilesLoaded,
      replaceHosts,
      retryKnownHosts,
      resolveUnknownHost,
      saveHost,
      savePairedHost,
      trustChallenge,
      unknownHostChallenge,
      unlockedGlobalKeys,
      unlockCredentialRecovery,
      unlockGlobalKeychain,
      updateGlobalKeys,
    ],
  );
}
