import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_DEVELOPER_MEMBERSHIP_STATE,
  isDeveloperMembershipState,
  type DeveloperMembershipState,
} from '../billing/tiers';
import {
  parseTerminalDoubleTapAction,
  type TerminalDoubleTapAction,
} from '../lib/terminalDoubleTap';
import { parseTerminalControlUsage, type TerminalControlUsage } from '../lib/terminalControls';
import {
  parseTerminalVolumeKeyAction,
  type TerminalVolumeKeyAction,
} from '../lib/volumeKeys';
import {
  DEFAULT_XTERM_CACHE_CAPACITY,
  MIN_XTERM_CACHE_CAPACITY,
} from '../lib/terminalRendererLru';
import type { AppTab } from '../types';
import {
  migrateAppBackgroundImage,
  removeAppBackgroundImage,
} from './appBackground';
import {
  migrateTerminalBackgroundImage,
  removeTerminalBackgroundImage,
} from './terminalBackground';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

export const DEVICE_PREFERENCES_KEY = 'herdr.device.preferences.v3';
export const LEGACY_DEVICE_PREFERENCES_KEYS = [
  'herdr.device.preferences.v2',
  'herdr.device.preferences.v1',
];

export const MIN_PERSISTENT_ALERT_DURATION_SECONDS = 5;
export const MAX_PERSISTENT_ALERT_DURATION_SECONDS = 60;
export const PERSISTENT_ALERT_DURATION_STEP_SECONDS = 5;

export const agentAlertLevels = ['regular', 'persistent'] as const;
export type AgentAlertLevel = (typeof agentAlertLevels)[number];

export interface TerminalPreferences {
  fullscreen: boolean;
  useModifierKeyIcons: boolean;
  volumeUpAction: TerminalVolumeKeyAction;
  volumeDownAction: TerminalVolumeKeyAction;
  fontSize: number;
  scrollback: number;
  xtermCacheCapacity: number;
  cursorBlink: boolean;
  doubleTapAction: TerminalDoubleTapAction;
  openLinksInApp: boolean;
  pauseResizeInBackground: boolean;
  visualHints: boolean;
  backgroundImageUri: string | null;
  backgroundDimming: number;
}

export type AppearancePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'system' | 'en' | 'zh-Hant' | 'zh-Hans' | 'ja' | 'es';

type StoredTerminalPreferences = Partial<TerminalPreferences> & {
  backgroundOpacity?: unknown;
  doubleTapTab?: unknown;
};

export interface DevicePreferences {
  alertsEnabled: boolean;
  agentAlertLevel: AgentAlertLevel;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  appearance: AppearancePreference;
  fullscreenApp: boolean;
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  appGlassEnabled: boolean;
  developerOptionsEnabled: boolean;
  developerMembershipState: DeveloperMembershipState;
  language: LanguagePreference;
  keepScreenOn: boolean;
  reopenTerminalOnLaunch: boolean;
  agentCommand: string;
  lastTab: AppTab;
  terminal: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
}

export const defaultDevicePreferences: DevicePreferences = {
  alertsEnabled: true,
  agentAlertLevel: 'persistent',
  persistentAlertDurationSeconds: 30,
  ttsEnabled: false,
  biometricForKeys: false,
  biometricOnResume: false,
  appearance: 'system',
  fullscreenApp: false,
  appBackgroundImageUri: null,
  appBackgroundDimming: 60,
  appGlassEnabled: false,
  developerOptionsEnabled: false,
  developerMembershipState: DEFAULT_DEVELOPER_MEMBERSHIP_STATE,
  language: 'system',
  keepScreenOn: false,
  reopenTerminalOnLaunch: false,
  agentCommand: 'opencode',
  lastTab: 'hosts',
  terminal: {
    fullscreen: true,
    useModifierKeyIcons: false,
    volumeUpAction: 'none',
    volumeDownAction: 'none',
    fontSize: 8,
    scrollback: 5000,
    xtermCacheCapacity: DEFAULT_XTERM_CACHE_CAPACITY,
    cursorBlink: true,
    doubleTapAction: 'tab',
    openLinksInApp: true,
    pauseResizeInBackground: true,
    visualHints: false,
    backgroundImageUri: null,
    backgroundDimming: 60,
  },
  terminalControlUsage: {},
};

export async function loadDevicePreferences(): Promise<DevicePreferences> {
  const current = await readDevicePreferencesValue(DEVICE_PREFERENCES_KEY);
  if (current) return devicePreferencesFromStorage(current, []);
  const legacyValues: Array<string | null> = [];
  for (const key of LEGACY_DEVICE_PREFERENCES_KEYS) {
    const value = await readDevicePreferencesValue(key);
    legacyValues.push(value);
    if (value) break;
  }
  return devicePreferencesFromStorage(null, legacyValues);
}

export async function devicePreferencesFromStorage(
  current: string | null,
  legacyValues: readonly (string | null)[],
): Promise<DevicePreferences> {
  if (current) {
    return migrateDevicePreferences(parseDevicePreferences(current, DEVICE_PREFERENCES_KEY));
  }
  const legacyIndex = legacyValues.findIndex(value => Boolean(value));
  const legacy = legacyValues[legacyIndex];
  if (legacy) {
    return migrateDevicePreferences(parseDevicePreferences(
      legacy,
      LEGACY_DEVICE_PREFERENCES_KEYS[legacyIndex],
      true,
    ));
  }
  return defaultDevicePreferences;
}

async function readDevicePreferencesValue(storageKey: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(storageKey);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'device-preferences',
      storageKey,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'default-preferences',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

async function migrateDevicePreferences(preferences: DevicePreferences): Promise<DevicePreferences> {
  const previousTerminalUri = preferences.terminal.backgroundImageUri;
  const previousAppUri = preferences.appBackgroundImageUri;
  let failureDiagnosed = false;
  try {
    const [terminalBackgroundImageUri, appBackgroundImageUri] = await Promise.all([
      migrateTerminalBackgroundImage(previousTerminalUri),
      migrateAppBackgroundImage(previousAppUri),
    ]);
    if (
      terminalBackgroundImageUri === previousTerminalUri
      && appBackgroundImageUri === previousAppUri
    ) return preferences;

    const migrated = {
      ...preferences,
      appBackgroundImageUri,
      terminal: { ...preferences.terminal, backgroundImageUri: terminalBackgroundImageUri },
    };
    try {
      await AsyncStorage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(migrated));
    } catch (error) {
      recordDevicePreferencesWriteFailure(error, 'startup-migration');
      failureDiagnosed = true;
      throw error;
    }
    if (terminalBackgroundImageUri !== previousTerminalUri) {
      await removeTerminalBackgroundImage(previousTerminalUri);
    }
    if (appBackgroundImageUri !== previousAppUri) {
      await removeAppBackgroundImage(previousAppUri);
    }
    return migrated;
  } catch (error) {
    // Keep using the previous setting and retry the migration next launch.
    if (!failureDiagnosed) {
      recordOperationalDiagnostic('warn', 'Application', 'background-image-migration-failed', {
        fallbackUsed: 'previous-preferences',
        ...operationalErrorDetails(error),
      });
    }
    return preferences;
  }
}

function parseDevicePreferences(
  value: string,
  storageKey: string,
  migratingLegacy = false,
): DevicePreferences {
  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new TypeError('Stored device preferences must be an object');
    }
    const parsed = parsedValue as Partial<DevicePreferences>;
    const terminal = (parsed.terminal || {}) as StoredTerminalPreferences;
    const fontSize = migratingLegacy && terminal.fontSize === 11
      ? defaultDevicePreferences.terminal.fontSize
      : clampNumber(terminal.fontSize, 8, 24, defaultDevicePreferences.terminal.fontSize);
    return {
      alertsEnabled: parsed.alertsEnabled ?? defaultDevicePreferences.alertsEnabled,
      agentAlertLevel: isAgentAlertLevel(parsed.agentAlertLevel)
        ? parsed.agentAlertLevel
        : defaultDevicePreferences.agentAlertLevel,
      persistentAlertDurationSeconds: clampNumber(
        parsed.persistentAlertDurationSeconds,
        MIN_PERSISTENT_ALERT_DURATION_SECONDS,
        MAX_PERSISTENT_ALERT_DURATION_SECONDS,
        defaultDevicePreferences.persistentAlertDurationSeconds,
      ),
      ttsEnabled: parsed.ttsEnabled ?? defaultDevicePreferences.ttsEnabled,
      biometricForKeys: parsed.biometricForKeys === true,
      biometricOnResume: parsed.biometricOnResume === true,
      appearance: isAppearancePreference(parsed.appearance)
        ? parsed.appearance
        : defaultDevicePreferences.appearance,
      fullscreenApp: parsed.fullscreenApp === true,
      appBackgroundImageUri: typeof parsed.appBackgroundImageUri === 'string' && parsed.appBackgroundImageUri
        ? parsed.appBackgroundImageUri
        : null,
      appBackgroundDimming: clampNumber(
        parsed.appBackgroundDimming,
        0,
        100,
        defaultDevicePreferences.appBackgroundDimming,
      ),
      appGlassEnabled: parsed.appGlassEnabled === true,
      developerOptionsEnabled: parsed.developerOptionsEnabled === true,
      developerMembershipState: isDeveloperMembershipState(
        parsed.developerMembershipState,
      )
        ? parsed.developerMembershipState
        : DEFAULT_DEVELOPER_MEMBERSHIP_STATE,
      language: isLanguagePreference(parsed.language)
        ? parsed.language
        : defaultDevicePreferences.language,
      keepScreenOn: parsed.keepScreenOn === true,
      reopenTerminalOnLaunch: parsed.reopenTerminalOnLaunch === true,
      agentCommand: typeof parsed.agentCommand === 'string' && parsed.agentCommand.trim()
        ? parsed.agentCommand
        : defaultDevicePreferences.agentCommand,
      lastTab: isAppTab(parsed.lastTab) ? parsed.lastTab : defaultDevicePreferences.lastTab,
      terminalControlUsage: parseTerminalControlUsage(parsed.terminalControlUsage),
      terminal: {
        fullscreen: typeof terminal.fullscreen === 'boolean'
          ? terminal.fullscreen
          : defaultDevicePreferences.terminal.fullscreen,
        useModifierKeyIcons: terminal.useModifierKeyIcons === true,
        volumeUpAction: parseTerminalVolumeKeyAction(
          terminal.volumeUpAction,
          defaultDevicePreferences.terminal.volumeUpAction,
        ),
        volumeDownAction: parseTerminalVolumeKeyAction(
          terminal.volumeDownAction,
          defaultDevicePreferences.terminal.volumeDownAction,
        ),
        fontSize,
        scrollback: clampNumber(terminal.scrollback, 1000, 20000, defaultDevicePreferences.terminal.scrollback),
        xtermCacheCapacity: parseXtermCacheCapacity(terminal.xtermCacheCapacity),
        cursorBlink: terminal.cursorBlink ?? defaultDevicePreferences.terminal.cursorBlink,
        doubleTapAction: parseTerminalDoubleTapAction(
          terminal.doubleTapAction,
          typeof terminal.doubleTapTab === 'boolean'
            ? terminal.doubleTapTab ? 'tab' : 'none'
            : defaultDevicePreferences.terminal.doubleTapAction,
        ),
        openLinksInApp: typeof terminal.openLinksInApp === 'boolean'
          ? terminal.openLinksInApp
          : defaultDevicePreferences.terminal.openLinksInApp,
        pauseResizeInBackground: typeof terminal.pauseResizeInBackground === 'boolean'
          ? terminal.pauseResizeInBackground
          : defaultDevicePreferences.terminal.pauseResizeInBackground,
        visualHints: parsed.developerOptionsEnabled === true && terminal.visualHints === true,
        backgroundImageUri: typeof terminal.backgroundImageUri === 'string' && terminal.backgroundImageUri
          ? terminal.backgroundImageUri
          : null,
        backgroundDimming: clampNumber(
          terminal.backgroundDimming ?? terminal.backgroundOpacity,
          0,
          100,
          defaultDevicePreferences.terminal.backgroundDimming,
        ),
      },
    };
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'device-preferences',
      storageKey,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'default-preferences',
      ...storageParseErrorDetails(error),
    });
    return defaultDevicePreferences;
  }
}

export async function saveDevicePreferences(preferences: DevicePreferences): Promise<void> {
  try {
    await AsyncStorage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (error) {
    recordDevicePreferencesWriteFailure(error, 'persistence');
    throw error;
  }
}

function recordDevicePreferencesWriteFailure(error: unknown, phase: string): void {
  recordStorageDiagnostic('error', 'storage-write-failed', {
    store: 'device-preferences',
    storageKey: DEVICE_PREFERENCES_KEY,
    phase,
    operation: 'setItem',
    ...storageErrorDetails(error),
  });
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function parseXtermCacheCapacity(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_XTERM_CACHE_CAPACITY
    ? value
    : DEFAULT_XTERM_CACHE_CAPACITY;
}

function isAppTab(value: unknown): value is AppTab {
  return value === 'hosts' || value === 'herd' || value === 'terminal' || value === 'more';
}

function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isAgentAlertLevel(value: unknown): value is AgentAlertLevel {
  return agentAlertLevels.some(level => level === value);
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'zh-Hant' || value === 'zh-Hans' || value === 'ja' || value === 'es';
}
