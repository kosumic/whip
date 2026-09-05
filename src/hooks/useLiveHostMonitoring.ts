import { useEffect, useEffectEvent, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { flushLatencyDiagnosticWrites } from '../services/latencyDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  configureBackgroundMonitoring,
  observeMonitoringNetwork,
} from '../services/backgroundMonitoring';
import type { BackgroundMonitoringMode } from '../lib/backgroundMonitoringPolicy';

interface LiveHostMonitoringOptions {
  hostCount: number;
  connectedHostCount: number;
  runtimeKey: string;
  backgroundMonitoringMode: BackgroundMonitoringMode;
  restoreComplete: boolean;
  hostsVisible: boolean;
  appAccessLocked: boolean;
  setRuntimeMonitoringState: (
    appActive: boolean,
    hostsVisible: boolean,
    accessLocked: boolean,
    mode: BackgroundMonitoringMode,
    networkAvailable: boolean,
    networkRevision: number,
  ) => void;
  onBackgroundMonitoringError: (error: unknown) => void;
}

/** Forwards coarse platform lifecycle signals to Rust-owned runtime policy. */
export function useLiveHostMonitoring({
  hostCount,
  connectedHostCount,
  runtimeKey,
  backgroundMonitoringMode,
  restoreComplete,
  hostsVisible,
  appAccessLocked,
  setRuntimeMonitoringState,
  onBackgroundMonitoringError,
}: LiveHostMonitoringOptions): void {
  const networkAvailable = useRef(true);
  const networkRevision = useRef(0);
  const reportBackgroundError = useEffectEvent(onBackgroundMonitoringError);
  const updateMonitoring = useEffectEvent((appActive: boolean) => {
    setRuntimeMonitoringState(
      appActive, hostsVisible, appAccessLocked,
      // These user-selectable modes currently have Android UI/service support.
      // Preserve iOS reconnect behavior rather than apply a hidden migrated opt-out.
      Platform.OS === 'android' ? backgroundMonitoringMode : 'continuous',
      networkAvailable.current, networkRevision.current,
    );
    if (!restoreComplete) return;
    configureBackgroundMonitoring(
      hostCount, connectedHostCount, backgroundMonitoringMode, appActive,
    ).catch(reportBackgroundError);
  });

  useEffect(() => {
    let previousState = AppState.currentState;
    const removeNetworkListener = observeMonitoringNetwork(available => {
      networkAvailable.current = available;
      networkRevision.current += 1;
      updateMonitoring(AppState.currentState === 'active');
    });
    const subscription = AppState.addEventListener('change', state => {
      recordNetworkDiagnostic('info', 'app-state-changed', {
        from: previousState,
        to: state,
      });
      previousState = state;
      updateMonitoring(state === 'active');
      if (state !== 'active') {
        reportBackgroundFailure(
          flushLatencyDiagnosticWrites(),
          'latency-diagnostics-flush',
        );
      }
    });
    return () => {
      subscription.remove();
      removeNetworkListener();
      updateMonitoring(false);
    };
  }, []);

  useEffect(() => {
    updateMonitoring(AppState.currentState === 'active');
  }, [
    appAccessLocked, hostsVisible, hostCount, connectedHostCount,
    runtimeKey, restoreComplete, backgroundMonitoringMode,
  ]);
}
