import './global.css';

import { useEffect, useRef, useState } from 'react';
import { useFonts } from 'expo-font';
import { PortalHost } from '@rn-primitives/portal';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { AppShell } from './src/components/AppShell';
import { ReducedMotionProvider, WhipMark } from './src/components/app-ui';
import { guiFontFamilies } from './src/lib/guiFonts';
import { bundledAsset } from './src/lib/bundledAsset';
import { terminalFontFamily } from './src/lib/terminalFonts';
import { reportBackgroundFailure } from './src/services/backgroundOperations';
import { useAgentNotifications } from './src/hooks/useAgentNotifications';
import { useAppNavigation } from './src/hooks/useAppNavigation';
import { useApplicationSecurity } from './src/hooks/useApplicationSecurity';
import { useDevicePreferences } from './src/hooks/useDevicePreferences';
import { useHostManagement } from './src/hooks/useHostManagement';
import { useLiveHostTelemetry } from './src/hooks/useLiveHostTelemetry';
import { useRemoteFilesController } from './src/hooks/useRemoteFilesController';
import {
  useSessionRuntimeManager,
  type SessionRuntimeController,
} from './src/hooks/useSessionRuntimeManager';
import { useStartupStorage } from './src/hooks/useStartupStorage';
import { useTerminalHistory } from './src/hooks/useTerminalHistory';
import { useTerminalSessions } from './src/hooks/useTerminalSessions';
import { useWhipEntitlements } from './src/billing/useWhipEntitlements';

const guiFontAssets = {
  [guiFontFamilies.regular]: bundledAsset(require('./assets/gui-fonts/Inter-Regular.ttf')),
  [guiFontFamilies.medium]: bundledAsset(require('./assets/gui-fonts/Inter-Medium.ttf')),
  [guiFontFamilies.semiBold]: bundledAsset(require('./assets/gui-fonts/Inter-SemiBold.ttf')),
  [guiFontFamilies.bold]: bundledAsset(require('./assets/gui-fonts/Inter-Bold.ttf')),
  [guiFontFamilies.extraBold]: bundledAsset(require('./assets/gui-fonts/Inter-ExtraBold.ttf')),
  [guiFontFamilies.black]: bundledAsset(require('./assets/gui-fonts/Inter-Black.ttf')),
  [terminalFontFamily]: bundledAsset(require('./assets/terminal-fonts/JetBrainsMono-Regular.ttf')),
};

function App() {
  const [guiFontsLoaded, guiFontError] = useFonts(guiFontAssets);
  if (!guiFontsLoaded && !guiFontError) return null;

  return (
    <SafeAreaProvider>
      <ReducedMotionProvider>
        <AppContent />
        <PortalHost />
      </ReducedMotionProvider>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const { t } = useTranslation();
  const startupStorage = useStartupStorage();
  const preferences = useDevicePreferences(startupStorage);
  const preferencesLoaded = preferences.hydration.status !== 'loading';
  const membershipSimulationEnabled =
    preferencesLoaded &&
    preferences.value.developerOptionsEnabled;
  const entitlements = useWhipEntitlements(membershipSimulationEnabled);
  const terminals = useTerminalSessions();
  const telemetry = useLiveHostTelemetry();
  const notifications = useAgentNotifications();
  const [deferredHydrationReady, setDeferredHydrationReady] = useState(false);
  const sessionsRef = useRef<SessionRuntimeController | null>(null);

  const security = useApplicationSecurity({
    preferencesLoaded,
    biometricForKeys: preferences.value.biometricForKeys,
    biometricOnResume: preferences.value.biometricOnResume,
    onBiometricForKeysChange: enabled =>
      preferences.setPreference('biometricForKeys', enabled),
    onBiometricOnResumeChange: enabled =>
      preferences.setPreference('biometricOnResume', enabled),
    biometricUnavailableTitle: t('settings.biometricUnavailable'),
    biometricUnavailableMessage: error =>
      t('settings.biometricUnavailableCopy', { error: String(error) }),
  });

  const hosts = useHostManagement({
    startupStorage,
    deferredHydrationReady,
    t,
    onDeleteConnectedHost: hostId => {
      const operation = sessionsRef.current?.closeHostById(hostId, false);
      if (operation) reportBackgroundFailure(operation, 'delete-connected-host');
    },
  });
  const appReady = hosts.profilesLoaded && preferencesLoaded;

  const navigation = useAppNavigation({
    appReady,
    preferencesLoaded,
    preferredTab: preferences.value.lastTab,
    recordLastTab: preferences.recordLastTab,
    dismissTopOverlay: hosts.dismissTopOverlay,
    onFirstTabMounted: () => setDeferredHydrationReady(true),
  });
  const history = useTerminalHistory({
    startupStorage,
    deferredHydrationReady,
  });
  const sessions = useSessionRuntimeManager({
    startupStorage,
    deferredHydrationReady,
    preferencesLoaded,
    terminalHistoryLoaded: history.loaded,
    reopenTerminalOnLaunch: preferences.value.reopenTerminalOnLaunch,
    alertsEnabled: preferences.value.alertsEnabled,
    agentAlertLevel: preferences.value.agentAlertLevel,
    persistentAlertDurationSeconds:
      preferences.value.persistentAlertDurationSeconds,
    ttsEnabled: preferences.value.ttsEnabled,
    appAccessLocked: security.locked,
    hostsVisible: navigation.state.tab === 'hosts',
    t,
    hosts,
    navigation,
    security,
    notifications,
    terminals,
    telemetry,
  });
  sessionsRef.current = sessions;

  const remoteFiles = useRemoteFilesController({
    getSessions: sessions.getState,
    getClient: sessions.getClient,
  });
  const { request: remoteFilesRequest, close: closeRemoteFiles } = remoteFiles;
  useEffect(() => {
    const request = remoteFilesRequest;
    if (
      request &&
      !sessions.state.sessions.some(
        session => session.id === request.hostSessionId,
      )
    ) {
      closeRemoteFiles(request.id);
    }
  }, [closeRemoteFiles, remoteFilesRequest, sessions.state.sessions]);

  if (!appReady) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <WhipMark accessibilityLabel={t('app.loading')} size={64} />
      </View>
    );
  }

  return (
    <AppShell
      preferences={preferences}
      entitlements={entitlements}
      hosts={hosts}
      sessions={sessions}
      navigation={navigation}
      remoteFiles={remoteFiles}
      security={security}
      terminals={terminals}
      telemetry={telemetry}
      history={history}
    />
  );
}

export default App;
