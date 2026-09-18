import { useEffect, useEffectEvent } from 'react';
import { AppState } from 'react-native';

import { flushLatencyDiagnosticWrites } from '../services/latencyDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
} from '../services/backgroundMonitoring';

interface LiveHostMonitoringOptions {
  liveHostCount: number;
  alertsEnabled: boolean;
  restoreComplete: boolean;
  hostsVisible: boolean;
  appAccessLocked: boolean;
  setRuntimeMonitoringState: (
    appActive: boolean,
    hostsVisible: boolean,
    accessLocked: boolean,
  ) => void;
  onBackgroundMonitoringError: (error: unknown) => void;
}

/** UI visibility only. Android service lifecycle supplies background health policy directly. */
export function useLiveHostMonitoring({
  liveHostCount,
  alertsEnabled,
  restoreComplete,
  hostsVisible,
  appAccessLocked,
  setRuntimeMonitoringState,
  onBackgroundMonitoringError,
}: LiveHostMonitoringOptions): void {
  const updateRuntimeMonitoring = useEffectEvent(setRuntimeMonitoringState);
  const reportBackgroundError = useEffectEvent(onBackgroundMonitoringError);

  useEffect(() => {
    if (!restoreComplete) return;
    const operation =
      alertsEnabled && liveHostCount > 0
        ? startBackgroundMonitoring(liveHostCount)
        : stopBackgroundMonitoring();
    operation.catch(reportBackgroundError);
  }, [alertsEnabled, liveHostCount, restoreComplete]);

  useEffect(() => {
    if (liveHostCount === 0) return;
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      recordNetworkDiagnostic('info', 'app-state-changed', {
        from: previousState,
        to: state,
        liveHostCount,
      });
      previousState = state;
      if (state === 'active') {
        updateRuntimeMonitoring(true, hostsVisible, appAccessLocked);
      } else {
        updateRuntimeMonitoring(false, hostsVisible, appAccessLocked);
        reportBackgroundFailure(
          flushLatencyDiagnosticWrites(),
          'latency-diagnostics-flush',
        );
      }
    });
    updateRuntimeMonitoring(
      AppState.currentState === 'active',
      hostsVisible,
      appAccessLocked,
    );
    return () => {
      subscription.remove();
      // Detaching the UI stops visible latency polling. It does not change
      // native background health policy or disconnect process-owned runtimes.
      updateRuntimeMonitoring(false, false, appAccessLocked);
    };
  }, [appAccessLocked, hostsVisible, liveHostCount]);

  useEffect(() => {
    updateRuntimeMonitoring(
      AppState.currentState === 'active',
      hostsVisible,
      appAccessLocked,
    );
  }, [appAccessLocked, hostsVisible, liveHostCount]);
}
