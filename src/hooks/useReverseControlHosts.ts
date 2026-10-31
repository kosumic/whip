import { useLayoutEffect, useRef } from 'react';
import { deleteAgentTranscriptsForHost } from 'react-native-whip-ssh';

import { deleteHostProfile, loadConnectionProfile, saveHostMetadata } from '../services/hostProfiles';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
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
    biometricForKeys: security.isKeyProtectionEnabled(),
    globalInstructions: preferences.value.reverseControlInstructions,
    getHosts: hosts.getHosts,
    connections: () => sessions.getState().sessions.map(session => ({ host_id: session.hostId, status: session.connectionStatus })),
    authenticate: security.verifyBiometric,
    saveMetadata: saveHostMetadata,
    readCredential: loadConnectionProfile,
    connect: (profile, signal) => sessions.connect(profile, {
      persistProfile: false,
      navigate: false,
      activateSession: false,
      promptForUnknownHosts: true,
      biometricVerified: true,
      signal,
    }),
    deleteTranscripts: deleteAgentTranscriptsForHost,
    deleteSnapshot: hostId => herdrSnapshotCache.delete(hostId),
    deleteProfile: deleteHostProfile,
    disconnect: (hostId, recordDisconnect) => sessions.closeHostById(hostId, recordDisconnect),
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  const bridgeRef = useRef<ReverseControlHosts | null>(null);
  useLayoutEffect(() => {
    const bridge = new ReverseControlHosts(() => contextRef.current);
    bridgeRef.current = bridge;
    return () => { bridgeRef.current = null; bridge.dispose(); };
  }, []);
  useLayoutEffect(() => { bridgeRef.current?.updateContext(); });
}
