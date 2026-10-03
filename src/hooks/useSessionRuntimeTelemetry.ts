import { startTransition, useCallback, useEffect, useRef } from 'react';
import type {
  RuntimeDiagnostic,
  RuntimeHostLatencyMeasurement,
} from 'react-native-whip-ssh';

import type { useLiveHostTelemetry } from './useLiveHostTelemetry';
import type { LiveRuntime, SessionRuntimeStore } from './sessionRuntimeTypes';
import type { BackgroundMonitoringMode } from '../lib/backgroundMonitoringPolicy';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  SLOW_HOST_LATENCY_MS,
  isSlowHostLatency,
  recordHostLatencyFailure,
  recordSlowHostLatency,
  type HostLatencyMeasurement,
} from '../services/latencyDiagnostics';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  type AppPerformanceTrace,
} from '../services/performanceTrace';

function recordLatencyMeasurement(
  sessionId: string,
  measurement: HostLatencyMeasurement,
): void {
  if (!isSlowHostLatency(measurement)) return;
  recordNetworkDiagnostic('warn', 'latency-probe-slow', {
    sessionId,
    latencyMs: measurement.latencyMs,
    sshRttMs: measurement.sshRttMs,
    totalMs: measurement.totalMs,
    runtimeOverheadMs: measurement.runtimeOverheadMs,
  });
  reportBackgroundFailure(
    recordSlowHostLatency(sessionId, measurement),
    'slow-host-latency-persist',
  );
}

export function useSessionRuntimeTelemetry({
  runtimesRef,
  telemetry,
}: Pick<SessionRuntimeStore, 'runtimesRef'> & {
  telemetry: ReturnType<typeof useLiveHostTelemetry>;
}) {
  const latencyStateApplyTracesRef = useRef(new Set<AppPerformanceTrace>());
  const { clearLatency, recordLatency } = telemetry;

  useEffect(() => {
    for (const trace of latencyStateApplyTracesRef.current) {
      endAppPerformanceTrace(trace);
    }
    latencyStateApplyTracesRef.current.clear();
  }, [telemetry.state]);

  useEffect(
    () => () => {
      for (const trace of latencyStateApplyTracesRef.current) {
        endAppPerformanceTrace(trace);
      }
      latencyStateApplyTracesRef.current.clear();
    },
    [],
  );

  const handleRuntimeDiagnostic = useCallback(
    (
      sessionId: string,
      runtime: LiveRuntime,
      diagnostic: RuntimeDiagnostic,
    ) => {
      recordNetworkDiagnostic(
        diagnostic.outcome === 'failed'
          ? 'error'
          : diagnostic.durationMs >= SLOW_HOST_LATENCY_MS
          ? 'warn'
          : 'info',
        'native-runtime-diagnostic',
        {
          sessionId,
          operation: diagnostic.operation,
          outcome: diagnostic.outcome,
          durationMs: Math.round(diagnostic.durationMs * 10) / 10,
          transportDurationMs:
            diagnostic.transportDurationMs === undefined
              ? undefined
              : Math.round(diagnostic.transportDurationMs * 10) / 10,
          terminalId: diagnostic.terminalId,
          error: diagnostic.error,
        },
      );
      if (
        diagnostic.operation === 'host-latency-probe' &&
        diagnostic.outcome === 'failed' &&
        !runtime.latencyDiagnosticFailureRecorded
      ) {
        runtime.latencyDiagnosticFailureRecorded = true;
        reportBackgroundFailure(
          recordHostLatencyFailure(
            sessionId,
            diagnostic.durationMs,
            diagnostic.error || 'Host latency probe failed',
          ),
          'host-latency-failure-persist',
        );
      }
    },
    [],
  );

  const handleReconnectRecovered = useCallback(
    (_sessionId: string, runtime: LiveRuntime) => {
      runtime.latencyDiagnosticFailureRecorded = false;
    },
    [],
  );

  const handleLatencyMeasurement = useCallback((
    sessionId: string,
    runtime: LiveRuntime,
    native: RuntimeHostLatencyMeasurement,
  ) => {
    if (runtimesRef.current.get(sessionId) !== runtime) return;
    const round = (value: number) => Math.round(value * 10) / 10;
    const measurement: HostLatencyMeasurement = {
      latencyMs: Math.round(native.sshRttMs),
      sshRttMs: round(native.sshRttMs),
      totalMs: round(native.totalMs),
      runtimeOverheadMs: round(native.runtimeOverheadMs),
    };
    runtime.latencyDiagnosticFailureRecorded = false;
    const trace = beginAppPerformanceTrace('Whip host latency state apply');
    startTransition(() => {
      const changed = recordLatency(sessionId, measurement.latencyMs);
      if (trace && changed) latencyStateApplyTracesRef.current.add(trace);
      else endAppPerformanceTrace(trace);
    });
    recordLatencyMeasurement(sessionId, measurement);
  }, [recordLatency, runtimesRef]);

  const setMonitoringState = useCallback((
    appActive: boolean,
    hostsVisible: boolean,
    accessLocked: boolean,
    mode: BackgroundMonitoringMode,
    networkAvailable: boolean,
    networkRevision: number,
  ) => {
    for (const runtime of runtimesRef.current.values()) {
      runtime.client.setMonitoringState(appActive, hostsVisible, accessLocked, mode, networkAvailable, networkRevision);
    }
  }, [runtimesRef]);

  return {
    clearLatency,
    handleReconnectRecovered,
    handleRuntimeDiagnostic,
    handleLatencyMeasurement,
    setMonitoringState,
  };
}
