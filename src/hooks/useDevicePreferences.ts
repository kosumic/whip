import { AppState, Appearance } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocales } from 'expo-localization';

import { applyDeveloperOptionsPolicy, getBillingRolloutPolicy } from '../billing/rollout';
import i18n, { languageForLocale } from '../i18n';
import type { TerminalControlId } from '../lib/terminalControls';
import {
  defaultDevicePreferences,
  devicePreferencesFromStorage,
  loadDevicePreferences,
  saveDevicePreferences,
  type DevicePreferences,
  type TerminalPreferences,
} from '../services/devicePreferences';
import {
  DEVICE_PREFERENCES_FLUSH_INTERVAL_MS,
  DevicePreferencesPersistence,
} from '../services/devicePreferencesPersistence';
import { setAppLogCaptureEnabled } from '../services/appLogs';
import { setLatencyDiagnosticsEnabled } from '../services/latencyDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from '../services/operationalDiagnostics';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type { AppTab } from '../types';
import type { LoadState } from './useStartupStorage';

type PreferenceHydration =
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'failed'; error: unknown };

type PreferenceKey = Exclude<
  keyof DevicePreferences,
  'terminal' | 'terminalControlUsage'
>;

export interface DevicePreferencesController {
  value: DevicePreferences;
  hydration: PreferenceHydration;
  setPreference: <Key extends PreferenceKey>(
    key: Key,
    value: DevicePreferences[Key],
  ) => void;
  setTerminalPreferences: (
    value:
      | TerminalPreferences
      | ((current: TerminalPreferences) => TerminalPreferences),
  ) => void;
  recordTerminalControlUse: (control: TerminalControlId) => void;
  recordLastTab: (tab: AppTab) => void;
}

interface ControllerState {
  value: DevicePreferences;
  hydration: PreferenceHydration;
  revision: number;
}

export function shouldPersistDevicePreferences(
  hydration: PreferenceHydration,
  revision: number,
): boolean {
  return hydration.status === 'loaded' && revision > 0;
}

/** Owns preference hydration, mutation side effects, and durable writes. */
export function useDevicePreferences(
  startupStorage: LoadState<StartupStorageSnapshot>,
): DevicePreferencesController {
  const locales = useLocales();
  const hydrationStarted = useRef(false);
  const [persistence] = useState(
    () => new DevicePreferencesPersistence(saveDevicePreferences),
  );
  const [state, setState] = useState<ControllerState>({
    value: defaultDevicePreferences,
    hydration: { status: 'loading' },
    revision: 0,
  });

  useEffect(() => {
    if (startupStorage.status === 'loading' || hydrationStarted.current) return;
    hydrationStarted.current = true;
    const load =
      startupStorage.status === 'loaded'
        ? devicePreferencesFromStorage(
            startupStorage.value.preferences,
            startupStorage.value.legacyPreferences,
          )
        : loadDevicePreferences();
    load
      .then(value => {
        persistence.hydrate(value);
        setState({ value, hydration: { status: 'loaded' }, revision: 0 });
      })
      .catch(error => {
        // Defaults keep the UI usable, but revision stays zero and the failed
        // hydration state prevents an I/O failure from being persisted as empty.
        setState({
          value: defaultDevicePreferences,
          hydration: { status: 'failed', error },
          revision: 0,
        });
      });
  }, [startupStorage, persistence]);

  useEffect(() => {
    if (!shouldPersistDevicePreferences(state.hydration, state.revision))
      return;
    persistence.update(state.value);
    reportBackgroundFailure(
      persistence.flush(),
      'device-preferences-persist',
    );
  }, [state, persistence]);

  useEffect(() => {
    const flush = () => {
      reportBackgroundFailure(persistence.flush(), 'device-preferences-persist');
    };
    const timer = setInterval(flush, DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') flush();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      flush();
    };
  }, [persistence]);

  useEffect(() => {
    Appearance.setColorScheme(
      state.value.appearance === 'system' ? 'unspecified' : state.value.appearance,
    );
  }, [state.value.appearance]);

  const resolvedLanguage =
    state.value.language === 'system'
      ? languageForLocale(locales[0])
      : state.value.language;
  useEffect(() => {
    i18n.changeLanguage(resolvedLanguage).catch(error => {
      recordOperationalDiagnostic('warn', 'Application', 'language-change-failed', {
        language: resolvedLanguage,
        ...operationalErrorDetails(error),
      });
    });
  }, [resolvedLanguage]);

  const { developerOptionsAvailable } = getBillingRolloutPolicy();
  // Pick up accumulated usage on ordinary renders without scheduling a render
  // for each press (or for a periodic persistence flush).
  const terminalControlUsage = persistence.terminalControlUsage;
  const effectiveValue = useMemo(
    () => applyDeveloperOptionsPolicy(
      { ...state.value, terminalControlUsage },
      developerOptionsAvailable,
    ),
    [state.value, terminalControlUsage, developerOptionsAvailable],
  );

  useEffect(() => {
    if (state.hydration.status !== 'loaded') return;
    setAppLogCaptureEnabled(effectiveValue.developerOptionsEnabled);
    reportBackgroundFailure(
      setLatencyDiagnosticsEnabled(effectiveValue.developerOptionsEnabled),
      'latency-diagnostics-setting-persist',
    );
  }, [state.hydration.status, effectiveValue.developerOptionsEnabled]);

  const mutate = useCallback(
    (updater: (current: DevicePreferences) => DevicePreferences) => {
      setState(current => {
        const value = updater(current.value);
        return value === current.value
          ? current
          : { ...current, value, revision: current.revision + 1 };
      });
    },
    [],
  );

  const setPreference = useCallback(
    <Key extends PreferenceKey>(key: Key, value: DevicePreferences[Key]) => {
      mutate(current =>
        current[key] === value ? current : { ...current, [key]: value },
      );
    },
    [mutate],
  );

  const setTerminalPreferences = useCallback(
    (
      value:
        | TerminalPreferences
        | ((current: TerminalPreferences) => TerminalPreferences),
    ) => {
      mutate(current => {
        const terminal =
          typeof value === 'function' ? value(current.terminal) : value;
        return terminal === current.terminal
          ? current
          : { ...current, terminal };
      });
    },
    [mutate],
  );

  const recordTerminalControlUse = useCallback(
    (control: TerminalControlId) => {
      persistence.recordTerminalControlUse(control);
    },
    [persistence],
  );

  const recordLastTab = useCallback(
    (tab: AppTab) => {
      setPreference('lastTab', tab);
    },
    [setPreference],
  );

  return {
    value: effectiveValue,
    hydration: state.hydration,
    setPreference,
    setTerminalPreferences,
    recordTerminalControlUse,
    recordLastTab,
  };
}
