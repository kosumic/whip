import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { TFunction } from 'i18next';

import type { AppNavigationController } from './useAppNavigation';
import type { HostManagementController } from './useHostManagement';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { LoadState } from './useStartupStorage';
import type {
  ConnectOptions,
  SessionRuntimeStore,
} from './sessionRuntimeTypes';
import { requiresBiometricForSavedKey } from '../lib/biometricSecurity';
import { hostDisplayName, resolveJumpHostChain } from '../lib/hostProfiles';
import { allSettledWithConcurrency } from '../lib/promisePool';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  hydrateHerdrSocketPathCache,
  loadHerdrSocketPathCache,
} from '../services/herdrSocketPathStorage';
import { loadConnectionProfile } from '../services/hostProfiles';
import {
  loadPersistedLiveHosts,
  persistedLiveHostsFromSessions,
  persistedLiveHostsFromStorage,
  persistedLiveHostsIdentity,
  savePersistedLiveHosts,
  type PersistedLiveHosts,
} from '../services/persistedLiveHosts';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
} from '../services/performanceTrace';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type { ConnectionProfile, HostProfile } from '../types';

const BACKGROUND_HOST_RESTORE_CONCURRENCY = 2;

export function useSessionStartupRestore({
  startupStorage,
  deferredHydrationReady,
  preferencesLoaded,
  terminalHistoryLoaded,
  reopenTerminalOnLaunch,
  state,
  getState,
  appCore,
  sessionProfilesRef,
  commitAppCore,
  restoredTerminalHostIdsRef,
  hosts,
  navigation,
  security,
  connect,
  t,
}: Pick<
  SessionRuntimeStore,
  | 'state'
  | 'getState'
  | 'appCore'
  | 'sessionProfilesRef'
  | 'commitAppCore'
> & {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
  preferencesLoaded: boolean;
  terminalHistoryLoaded: boolean;
  reopenTerminalOnLaunch: boolean;
  restoredTerminalHostIdsRef: MutableRefObject<Set<string>>;
  hosts: HostManagementController;
  navigation: AppNavigationController;
  security: ReturnType<typeof useApplicationSecurity>;
  connect: (
    profile: ConnectionProfile,
    options?: ConnectOptions,
  ) => Promise<boolean>;
  t: TFunction;
}): boolean {
  const [persistedHostsLoaded, setPersistedHostsLoaded] = useState(false);
  const [socketPathsLoaded, setSocketPathsLoaded] = useState(false);
  const [safeToPersist, setSafeToPersist] = useState(false);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const persistedHostsRef = useRef<PersistedLiveHosts>({
    hostIds: [],
    activeHostId: null,
  });
  const deferredHydrationStartedRef = useRef(false);
  const restoreStartedRef = useRef(false);

  useEffect(() => {
    if (!deferredHydrationReady || deferredHydrationStartedRef.current) return;
    deferredHydrationStartedRef.current = true;
    const snapshot =
      startupStorage.status === 'loaded' ? startupStorage.value : null;
    const liveHostsLoad = snapshot
      ? persistedLiveHostsFromStorage(snapshot.liveHosts)
      : loadPersistedLiveHosts();
    withAppPerformanceTrace(
      'Whip startup store: live hosts',
      () => liveHostsLoad,
    )
      .then(value => {
        persistedHostsRef.current = value;
        setSafeToPersist(true);
      })
      .catch(() => {
        persistedHostsRef.current = { hostIds: [], activeHostId: null };
        setSafeToPersist(false);
      })
      .finally(() => setPersistedHostsLoaded(true));
    const loadSocketPaths = withAppPerformanceTrace(
      'Whip startup store: socket paths',
      () =>
        snapshot
          ? hydrateHerdrSocketPathCache(snapshot.herdrSocketPaths)
          : loadHerdrSocketPathCache(),
    );
    reportBackgroundFailure(loadSocketPaths, 'socket-path-cache-hydration');
    const markSocketPathsLoaded = () => setSocketPathsLoaded(true);
    loadSocketPaths.then(markSocketPathsLoaded, markSocketPathsLoaded);
  }, [deferredHydrationReady, startupStorage]);

  const persistedIdentity = persistedLiveHostsIdentity(
    persistedLiveHostsFromSessions(state),
  );
  const persistSelection = useEffectEvent(() => {
    reportBackgroundFailure(
      savePersistedLiveHosts(persistedLiveHostsFromSessions(getState())),
      'live-host-selection-persist',
    );
  });
  useEffect(() => {
    if (!restoreComplete || !safeToPersist) return;
    persistSelection();
  }, [persistedIdentity, restoreComplete, safeToPersist]);

  const restorePersistedHosts = useEffectEvent(async () => {
    const trace = beginAppPerformanceTrace('Whip startup restore live hosts');
    try {
      const persisted = persistedHostsRef.current;
      const persistedHosts = persisted.hostIds
        .map(hostId => hosts.getHosts().find(item => item.id === hostId))
        .filter((host): host is HostProfile => Boolean(host));
      let initialView = appCore.view();
      for (const host of persistedHosts) {
        sessionProfilesRef.current.set(host.id, host);
        initialView = appCore.openSession(
          host.id,
          host.id,
          false,
        );
      }
      if (persisted.activeHostId) {
        initialView = appCore.selectHost(persisted.activeHostId);
      }
      commitAppCore(initialView);
      const hasProtectedKey = persistedHosts.some(host => {
        try {
          return [host, ...resolveJumpHostChain(hosts.getHosts(), host)].some(
            candidate =>
              requiresBiometricForSavedKey(
                candidate,
                security.isKeyProtectionEnabled(),
              ),
          );
        } catch {
          return requiresBiometricForSavedKey(
            host,
            security.isKeyProtectionEnabled(),
          );
        }
      });
      const protectedKeyAccessGranted =
        !hasProtectedKey ||
        (await withAppPerformanceTrace(
          'Whip startup restore: biometric',
          security.verifyBiometric,
        ));
      const restoreHost = async (hostId: string) => {
        const host = hosts.getHosts().find(item => item.id === hostId);
        if (!host) return;
        let protectedKey = requiresBiometricForSavedKey(
          host,
          security.isKeyProtectionEnabled(),
        );
        try {
          protectedKey = [
            host,
            ...resolveJumpHostChain(hosts.getHosts(), host),
          ].some(candidate =>
            requiresBiometricForSavedKey(
              candidate,
              security.isKeyProtectionEnabled(),
            ),
          );
        } catch {
          // The connect path reports missing or cyclic jump-host configuration.
        }
        if (protectedKey && !protectedKeyAccessGranted) {
          commitAppCore(appCore.closeSession(hostId));
          return;
        }
        try {
          const profile = await withAppPerformanceTrace(
            'Whip startup restore: credentials',
            () => loadConnectionProfile(host),
          );
          if (!profile.secret) {
            throw new Error('Saved SSH credential is unavailable');
          }
          await connect(profile, {
            persistProfile: false,
            navigate: false,
            trackConnecting: false,
            activateSession: false,
            reuseConnectingSession: true,
            biometricVerified: protectedKey,
            traceStartupRestore: true,
          });
        } catch (restoreError) {
          const message = t('app.restoreHostError', {
            host: hostDisplayName(host),
            error: String(restoreError),
          });
          hosts.setError(message);
          commitAppCore(
            appCore.setPlaceholderConnection(
              hostId,
              'error',
              message,
            ),
          );
        }
      };
      const validHostIds = persistedHosts.map(host => host.id);
      const activeHostId =
        persisted.activeHostId && validHostIds.includes(persisted.activeHostId)
          ? persisted.activeHostId
          : null;
      let activeTerminalReopened = false;
      if (activeHostId) {
        await withAppPerformanceTrace('Whip startup restore: active host', () =>
          restoreHost(activeHostId),
        );
        if (
          reopenTerminalOnLaunch &&
          appCore.view().activeSessionId === activeHostId &&
          restoredTerminalHostIdsRef.current.has(activeHostId)
        ) {
          navigation.showTerminal(activeHostId);
          activeTerminalReopened = true;
        }
      }
      const backgroundHostIds = validHostIds.filter(id => id !== activeHostId);
      await withAppPerformanceTrace(
        'Whip startup restore: background hosts',
        () =>
          allSettledWithConcurrency(
            backgroundHostIds,
            BACKGROUND_HOST_RESTORE_CONCURRENCY,
            restoreHost,
          ),
      );
      if (reopenTerminalOnLaunch && !activeTerminalReopened
        && appCore.view().activeSessionId === activeHostId) {
        const terminalHostId =
          (persisted.activeHostId &&
          restoredTerminalHostIdsRef.current.has(persisted.activeHostId)
            ? persisted.activeHostId
            : undefined) ??
          [...persisted.hostIds]
            .reverse()
            .find(hostId => restoredTerminalHostIdsRef.current.has(hostId));
        if (terminalHostId) {
          commitAppCore(appCore.selectHost(terminalHostId));
          navigation.showTerminal(terminalHostId);
        }
      }
      setRestoreComplete(true);
      hosts.completeLiveHostRestore();
    } finally {
      endAppPerformanceTrace(trace);
    }
  });

  useEffect(() => {
    if (
      !hosts.profilesLoaded ||
      !preferencesLoaded ||
      !terminalHistoryLoaded ||
      !persistedHostsLoaded ||
      !socketPathsLoaded ||
      !hosts.knownHostsLoaded ||
      restoreStartedRef.current
    ) {
      return;
    }
    restoreStartedRef.current = true;
    restorePersistedHosts().catch(restoreError => {
      hosts.setError(
        t('app.restoreLiveHostsError', { error: String(restoreError) }),
      );
      setRestoreComplete(true);
      hosts.completeLiveHostRestore();
    });
  }, [
    hosts.knownHostsLoaded,
    hosts.profilesLoaded,
    hosts,
    persistedHostsLoaded,
    preferencesLoaded,
    socketPathsLoaded,
    terminalHistoryLoaded,
    t,
  ]);

  return restoreComplete;
}
