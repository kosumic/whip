import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type {
  SessionRestorePlatform,
  SessionConnectionAttemptLike,
} from 'react-native-whip-ssh';
import { SessionRestoreError } from 'react-native-whip-ssh';
import type { TFunction } from 'i18next';
import type { AppNavigationController } from './useAppNavigation';
import type { HostManagementController } from './useHostManagement';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { LoadState } from './useStartupStorage';
import type {
  ConnectOptions,
  SessionRuntimeStore,
} from './sessionRuntimeTypes';
import { hostDisplayName } from '../lib/hostProfiles';
import {
  hydrateHerdrSocketPathCache,
  loadHerdrSocketPathCache,
} from '../services/herdrSocketPathStorage';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { withAppPerformanceTrace } from '../services/performanceTrace';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type { HostProfile } from '../types';

/** React supplies ready signals and platform effects; AppCore owns restoration. */
export function useSessionStartupRestore({
  startupStorage,
  deferredHydrationReady,
  preferencesLoaded,
  terminalHistoryLoaded,
  reopenTerminalOnLaunch,
  appCore,
  sessionProfilesRef,
  commitAppCore,
  hosts,
  navigation,
  security,
  connect,
  t,
}: Pick<
  SessionRuntimeStore,
  'state' | 'getState' | 'appCore' | 'sessionProfilesRef' | 'commitAppCore'
> & {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
  preferencesLoaded: boolean;
  terminalHistoryLoaded: boolean;
  reopenTerminalOnLaunch: boolean;
  hosts: HostManagementController;
  navigation: AppNavigationController;
  security: ReturnType<typeof useApplicationSecurity>;
  connect: (
    profile: HostProfile,
    options?: ConnectOptions,
  ) => Promise<boolean>;
  t: TFunction;
}): boolean {
  const [complete, setComplete] = useState(false);
  const attached = useRef(true);
  useEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
      appCore.cancelSessionRestore();
    };
  }, [appCore]);
  const prepare = useEffectEvent(async () => {
    const loading = Promise.resolve(
      startupStorage.status === 'loaded'
        ? hydrateHerdrSocketPathCache(startupStorage.value.herdrSocketPaths)
        : loadHerdrSocketPathCache(),
    );
    reportBackgroundFailure(loading, 'socket-path-cache-hydration');
    await Promise.allSettled([loading]);
  });
  const verify = useEffectEvent(() =>
    withAppPerformanceTrace(
      'Whip startup restore: biometric',
      security.verifyBiometric,
    ),
  );
  const connectHost = useEffectEvent(
    async (
      hostId: string,
      biometricVerified: boolean,
      signal?: AbortSignal,
      attempt?: SessionConnectionAttemptLike,
    ) => {
      const host = hosts.getHosts().find(candidate => candidate.id === hostId);
      if (
        !host ||
        signal?.aborted ||
        !attached.current ||
        (attempt && !attempt.isCurrent())
      )
        return false;
      try {
        return await connect(host, {
          loadSavedCredential: true,
          signal,
          connectionAttempt: attempt,
          persistProfile: false,
          navigate: false,
          activateSession: false,
          reuseConnectingSession: true,
          biometricVerified,
        });
      } catch (error) {
        if (
          signal?.aborted ||
          !attached.current ||
          (attempt && !attempt.isCurrent())
        )
          return false;
        throw new SessionRestoreError.Failed({
          message: t('app.restoreHostError', {
            host: hostDisplayName(host),
            error: String(error),
          }),
        });
      }
    },
  );
  const changed = useEffectEvent(() => {
    if (attached.current) commitAppCore(appCore.view());
  });
  const failed = useEffectEvent((_hostId: string, message: string) => {
    if (attached.current) hosts.setError(message);
  });
  const terminalReady = useEffectEvent((sessionId: string) => {
    if (attached.current) navigation.showTerminal(sessionId);
  });
  const start = useEffectEvent(async () => {
    for (const host of hosts.getHosts())
      sessionProfilesRef.current.set(host.id, host);
    const platform: SessionRestorePlatform = {
      prepare: () => prepare(),
      verifyKeys: () => verify(),
      connectHost: (hostId, verified, attempt, options) =>
        connectHost(hostId, verified, options?.signal, attempt),
      stateChanged: () => changed(),
      hostFailed: (hostId, message) => failed(hostId, message),
      terminalReady: sessionId => terminalReady(sessionId),
    };
    const loaded = startupStorage.status === 'loaded';
    const result = await withAppPerformanceTrace(
      'Whip startup restore live hosts',
      () =>
        appCore.restoreSessions({
          loaded,
          raw: loaded
            ? (startupStorage.value.liveHosts ?? undefined)
            : undefined,
          hosts: hosts.getHosts(),
          protectKeys: security.isKeyProtectionEnabled(),
          reopenTerminal: reopenTerminalOnLaunch,
          platform,
        }),
    );
    return result;
  });
  const report = useEffectEvent((error: unknown) => {
    if (attached.current)
      hosts.setError(t('app.restoreLiveHostsError', { error: String(error) }));
  });
  const finish = useEffectEvent(() => {
    if (attached.current) {
      commitAppCore(appCore.view());
      setComplete(true);
      hosts.completeLiveHostRestore();
    }
  });
  const ready =
    deferredHydrationReady &&
    hosts.profilesLoaded &&
    hosts.knownHostsLoaded &&
    preferencesLoaded &&
    terminalHistoryLoaded;
  useEffect(() => {
    if (!ready) return;
    let observing = true;
    start()
      .catch(error => {
        if (observing) report(error);
      })
      .finally(() => {
        if (observing) finish();
      });
    return () => {
      observing = false;
    };
  }, [appCore, ready]);
  return complete;
}
