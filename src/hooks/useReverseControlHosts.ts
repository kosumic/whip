import { useEffect, useRef, useState } from 'react';
import { subscribeReverseControlEvents } from 'react-native-whip-ssh';

import { requiresBiometricForKeyUse } from '../lib/biometricSecurity';
import { isLiveHostSshConnected } from '../lib/liveHostLatency';
import { deleteAgentTranscriptsForHost } from 'react-native-whip-ssh';
import { deleteHostProfile, loadConnectionProfile, saveHostMetadata } from '../services/hostProfiles';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { ReverseControlHosts, type HostControlContext } from '../services/reverseControlHosts';
import type { DevicePreferencesController } from './useDevicePreferences';
import type { HostManagementController } from './useHostManagement';
import type { SessionRuntimeController } from './useSessionRuntimeManager';
import type { useApplicationSecurity } from './useApplicationSecurity';

export function useReverseControlHosts(
  hosts: HostManagementController,
  sessions: SessionRuntimeController,
  preferences: DevicePreferencesController,
  security: ReturnType<typeof useApplicationSecurity>,
): void {
  const context: HostControlContext = {
    ready: hosts.profilesLoaded && preferences.hydration.status === 'loaded',
    locked: security.locked,
    globalInstructions: preferences.value.reverseControlInstructions,
    getHosts: hosts.getHosts,
    connections: () => sessions.getState().sessions.map(session => ({ host_id: session.hostId, status: session.connectionStatus })),
    save: async (id, profile, sourceId, assertActive) => {
      const source = sourceId ? hosts.getHosts().find(host => host.id === sourceId) : undefined;
      if (source && requiresBiometricForKeyUse(source, security.isKeyProtectionEnabled()) && !await security.verifyBiometric())
        throw Object.assign(new Error('Credential use was not authorized'), { code: 'permission_denied' });
      assertActive();
      return saveHostMetadata(id, profile, sourceId, assertActive);
    },
    delete: async (hostId, assertActive) => {
      assertActive();
      await deleteAgentTranscriptsForHost(hostId);
      assertActive();
      await herdrSnapshotCache.delete(hostId);
      assertActive();
      await deleteHostProfile(hostId);
      await sessions.closeHostById(hostId, false);
    },
    connect: async (host, signal, assertActive) => {
      if (sessions.getState().sessions.some(session =>
        session.hostId === host.id && isLiveHostSshConnected(session.connectionStatus),
      )) return true;
      const profile = await loadConnectionProfile(host);
      if (signal.aborted) return false;
      assertActive();
      if (!profile.secret)
        throw Object.assign(new Error('Save an SSH credential for this host in Whip first'), { code: 'invalid_argument' });
      return sessions.connect(profile, {
        persistProfile: false, navigate: false, activateSession: false,
        promptForUnknownHosts: true, signal,
      });
    },
    disconnect: hostId => sessions.closeHostById(hostId),
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  const [bridge] = useState(() => new ReverseControlHosts(() => contextRef.current));
  useEffect(() => {
    const unsubscribe = subscribeReverseControlEvents((event, runtime) => {
      reportBackgroundFailure(bridge.event(event, runtime), 'reverse-control-host-action');
    });
    return () => { unsubscribe(); bridge.dispose(); };
  }, [bridge]);
}
