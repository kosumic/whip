import type { MutableRefObject } from 'react';
import type {
  AppCoreProjection,
  HostRuntimeState,
  NativeAppCore,
  RuntimeAgentStatusTransition,
} from 'react-native-whip-ssh';

import type { HerdrClient } from '../services/HerdrClient';
import type { ConnectionProfile, HostProfile } from '../types';

export interface LiveRuntime {
  client: HerdrClient;
  profile: ConnectionProfile;
  latencyDiagnosticFailureRecorded: boolean;
  acceptHostState: (
    state: HostRuntimeState,
    transitions?: RuntimeAgentStatusTransition[],
  ) => void;
}

export interface SessionRuntimeStore {
  state: AppCoreProjection;
  getState: () => AppCoreProjection;
  runtimesRef: MutableRefObject<Map<string, LiveRuntime>>;
  appCore: NativeAppCore;
  sessionProfilesRef: MutableRefObject<Map<string, HostProfile>>;
  commitAppCore: (view: AppCoreProjection) => void;
}

export interface ConnectOptions {
  persistProfile?: boolean;
  navigate?: boolean;
  trackConnecting?: boolean;
  activateSession?: boolean;
  reuseConnectingSession?: boolean;
  biometricVerified?: boolean;
  promptForUnknownHosts?: boolean;
  traceStartupRestore?: boolean;
}
