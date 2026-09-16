import { useMemo, useRef } from 'react';
import { BlurTargetView } from 'expo-blur';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { DevicePreferencesController } from '../hooks/useDevicePreferences';
import type { HostManagementController } from '../hooks/useHostManagement';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { RemoteFilesController } from '../hooks/useRemoteFilesController';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import type { useApplicationSecurity } from '../hooks/useApplicationSecurity';
import type { useLiveHostTelemetry } from '../hooks/useLiveHostTelemetry';
import type { useTerminalHistory } from '../hooks/useTerminalHistory';
import type { useTerminalSessions } from '../hooks/useTerminalSessions';
import { effectiveDevicePreferences } from '../billing/effectiveSettings';
import { simulateDeveloperMembership } from '../billing/developerMembership';
import { resolveAccessTier } from '../billing/tiers';
import type { WhipEntitlementsController } from '../billing/useWhipEntitlements';
import {
  resolveHerdProjectionRequest,
  type HerdHostQueue,
} from '../herdQueue';
import { aggregateAgentStatus } from '../lib/agentStatusAggregate';
import { shouldEnableAppGlass } from '../lib/appGlass';
import { hostDisplayName } from '../lib/hostProfiles';
import { hostRuntimeSummary } from '../lib/hostRuntimeSummary';
import { hostSessionRecoveryState } from '../lib/hostSessionRecovery';
import {
  isLiveHostSshConnected,
  visibleLiveHostLatency,
} from '../lib/liveHostLatency';
import { dismissAgentAlertsForTab, alertAgent } from '../services/alerts';
import {
  ignoreExpectedCancellation,
  reportBackgroundFailure,
} from '../services/backgroundOperations';
import { startBackgroundMonitoring } from '../services/backgroundMonitoring';
import { useTheme } from '../theme';
import type { LiveSessionRailItem } from './LiveSessionRail';
import { AgentStatusAnimationProvider } from './app-ui';
import { AppBackground } from './AppBackground';
import { AppOverlays } from './AppOverlays';
import {
  StableStatusBar,
  TerminalKeepAwake,
  TerminalVolumeKeyBinding,
} from './AppPlatformBindings';
import { BottomNavigation } from './BottomNavigation';
import { ConnectRequiredScreen } from './ConnectRequiredScreen';
import { GlassProvider } from './GlassSurface';
import { HerdScreen } from './HerdScreen';
import { HostSessionRecoveryScreen } from './HostSessionRecoveryScreen';
import { HostsScreen } from './HostsScreen';
import { LiveSessionView } from './LiveSessionView';
import { MoreScreen } from './MoreScreen';

const NavigationBlurTarget = Platform.OS === 'android' ? View : BlurTargetView;

interface AppShellProps {
  preferences: DevicePreferencesController;
  entitlements: WhipEntitlementsController;
  hosts: HostManagementController;
  sessions: SessionRuntimeController;
  navigation: AppNavigationController;
  remoteFiles: RemoteFilesController;
  security: ReturnType<typeof useApplicationSecurity>;
  terminals: ReturnType<typeof useTerminalSessions>;
  telemetry: ReturnType<typeof useLiveHostTelemetry>;
  history: ReturnType<typeof useTerminalHistory>;
}

/** Main application presentation. State and lifecycle stay in domain controllers. */
export function AppShell({
  preferences,
  entitlements,
  hosts,
  sessions,
  navigation,
  remoteFiles,
  security,
  terminals,
  telemetry,
  history,
}: AppShellProps) {
  const { t } = useTranslation();
  const { colors: theme, isDark } = useTheme();
  const navigationBlurTargetRef = useRef<View | null>(null);
  const storedPreferences = preferences.value;
  const developerMembershipState = storedPreferences.developerOptionsEnabled
    ? storedPreferences.developerMembershipState
    : null;
  const displayedEntitlements = useMemo(
    () => developerMembershipState
      ? simulateDeveloperMembership(entitlements, developerMembershipState)
      : entitlements,
    [developerMembershipState, entitlements],
  );
  const accessTier = resolveAccessTier(developerMembershipState);
  const effectivePreferences = useMemo(
    () => effectiveDevicePreferences(storedPreferences, accessTier),
    [accessTier, storedPreferences],
  );
  const {
    alertsEnabled,
    agentAlertLevel,
    persistentAlertDurationSeconds,
    ttsEnabled,
    biometricForKeys,
    biometricOnResume,
    appearance,
    fullscreenApp,
    appBackgroundImageUri,
    appBackgroundDimming,
    appGlassEnabled,
    developerOptionsEnabled,
    language,
    keepScreenOn,
    reopenTerminalOnLaunch,
    agentCommand,
    terminal: terminalPreferences,
    terminalControlUsage,
  } = effectivePreferences;
  const activeSession = sessions.activeSession;
  const activeTelemetry = activeSession
    ? telemetry.get(activeSession.id)
    : null;
  const terminalVisible =
    navigation.state.tab === 'terminal' && !hosts.editorProfile;
  const terminalRecovery = hostSessionRecoveryState({
    activeClient: sessions.activeClient,
    activeSession,
    connectingHostIds: sessions.connectingHostIds,
    terminalVisible,
  });
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const activeTerminalVisible = Boolean(
    immersiveTerminal &&
      activeSession &&
      terminals.get(activeSession.id).activeTerminalId,
  );
  const fullscreenVisible = immersiveTerminal
    ? activeTerminalVisible && terminalPreferences.fullscreen
    : fullscreenApp;
  const herdProjectionRequest = resolveHerdProjectionRequest(
    sessions.state.sessions.map(session => session.id),
    navigation.herdHostFilterId,
    navigation.herdWorkspaceFilterIds,
  );
  const herdProjection = useMemo(
    () => sessions.herdView(
      sessions.state.sessions.map(session => ({
        sessionId: session.id,
        hostLabel: hostDisplayName(session.host),
        address: session.host.host,
      })),
      herdProjectionRequest.hostId ?? undefined,
      herdProjectionRequest.workspaceId ?? undefined,
    ),
    [herdProjectionRequest.hostId, herdProjectionRequest.workspaceId, sessions],
  );
  const railSessions: LiveSessionRailItem[] = sessions.state.sessions.map(
    session => ({
      hostId: session.id,
      label: hostDisplayName(session.host),
      status: session.status,
      agentStatus: aggregateAgentStatus(
        session.snapshot.workspaces.map(workspace => workspace.agent_status),
      ),
      terminalCount: terminals.get(session.id).sessions.length,
    }),
  );
  const herdQueues: HerdHostQueue[] = herdProjection.hosts;

  const openAgentFiles = (sessionId: string, paneId: string) => {
    const pane = sessions.state.sessions
      .find(session => session.id === sessionId)
      ?.snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) remoteFiles.open(sessionId, pane.terminal_id);
  };

  const overlaysVisible =
    hosts.editorProfile !== null ||
    hosts.newHostOpen ||
    hosts.unlockedGlobalKeys !== null ||
    hosts.knownHostsOpen ||
    navigation.licensesOpen;

  return (
    <>
      <StableStatusBar
        hidden={fullscreenVisible}
        backgroundColor={theme.canvas}
        isDark={isDark}
      />
      <SafeAreaView
        className="flex-1 bg-background"
        edges={fullscreenVisible ? ['left', 'right'] : ['top', 'left', 'right']}
      >
        <TerminalVolumeKeyBinding
          enabled={activeTerminalVisible}
          volumeUpAction={terminalPreferences.volumeUpAction}
          volumeDownAction={terminalPreferences.volumeDownAction}
        />
        {keepScreenOn && activeTerminalVisible ? <TerminalKeepAwake /> : null}
        <GlassProvider
          blurTarget={navigationBlurTargetRef}
          enabled={shouldEnableAppGlass(appGlassEnabled, appBackgroundImageUri)}
        >
          <View className="flex-1 bg-background">
            <NavigationBlurTarget
              ref={navigationBlurTargetRef}
              style={styles.navigationBlurTarget}
            >
              {/* Populated tabs remain mounted to preserve renderer/native-tree latency. */}
              <View
                importantForAccessibility={
                  immersiveTerminal ? 'no-hide-descendants' : 'auto'
                }
                pointerEvents={immersiveTerminal ? 'none' : 'auto'}
                style={
                  immersiveTerminal
                    ? styles.hiddenTab
                    : styles.navigationForeground
                }
              >
                <AppBackground
                  uri={appBackgroundImageUri}
                  dimming={appBackgroundDimming}
                />

                {navigation.mountedTabs.has('hosts') ? (
                  <View
                    importantForAccessibility={
                      navigation.state.tab === 'hosts'
                        ? 'auto'
                        : 'no-hide-descendants'
                    }
                    pointerEvents={
                      navigation.state.tab === 'hosts' ? 'auto' : 'none'
                    }
                    style={
                      navigation.state.tab === 'hosts'
                        ? styles.tabScreen
                        : styles.hiddenTab
                    }
                  >
                    <AgentStatusAnimationProvider
                      enabled={navigation.state.tab === 'hosts'}
                    >
                      <HostsScreen
                        hosts={hosts.hosts}
                        activeHostId={activeSession?.hostId || null}
                        connectedHostIds={sessions.state.sessions
                          .filter(session =>
                            isLiveHostSshConnected(session.status),
                          )
                          .map(session => session.hostId)}
                        latencyMsByHostId={Object.fromEntries(
                          sessions.state.sessions.map(session => [
                            session.hostId,
                            visibleLiveHostLatency(
                              session.status,
                              telemetry.get(session.id).latencyMs,
                            ),
                          ]),
                        )}
                        runtimeByHostId={Object.fromEntries(
                          sessions.state.sessions.map(session => [
                            session.hostId,
                            hostRuntimeSummary(session.snapshot),
                          ]),
                        )}
                        connectingHostIds={[
                          ...sessions.state.sessions
                            .filter(session => session.status === 'connecting')
                            .map(session => session.hostId),
                          ...sessions.connectingHostIds,
                        ]}
                        error={hosts.error}
                        credentialRecovery={hosts.credentialRecovery}
                        credentialRecoveryBusy={hosts.credentialRecoveryBusy}
                        onAdd={hosts.openNewHost}
                        onConnect={host => {
                          sessions
                            .connectSavedHost(host)
                            .catch(error => hosts.setError(String(error)));
                        }}
                        onDelete={hosts.confirmDelete}
                        onDisconnect={host => sessions.closeHostById(host.id)}
                        onEdit={hosts.openEditor}
                        onUnlockCredentials={hosts.unlockCredentialRecovery}
                      />
                    </AgentStatusAnimationProvider>
                  </View>
                ) : null}

                {navigation.mountedTabs.has('herd') ? (
                  <View
                    importantForAccessibility={
                      navigation.state.tab === 'herd'
                        ? 'auto'
                        : 'no-hide-descendants'
                    }
                    pointerEvents={
                      navigation.state.tab === 'herd' ? 'auto' : 'none'
                    }
                    style={
                      navigation.state.tab === 'herd'
                        ? styles.tabScreen
                        : styles.hiddenTab
                    }
                  >
                    <AgentStatusAnimationProvider
                      enabled={navigation.state.tab === 'herd'}
                    >
                      {sessions.state.sessions.length > 0 ? (
                        <HerdScreen
                          queues={herdQueues}
                          agents={herdProjection.agents}
                          sessions={railSessions}
                          selectedHostId={herdProjection.selectedHostId ?? null}
                          workspaceFilterId={herdProjection.selectedWorkspaceId ?? null}
                          agentCommand={agentCommand}
                          commandHistory={history.entries}
                          onSelectHost={sessionId => {
                            navigation.selectHerdHost(sessionId);
                            if (sessionId) sessions.select(sessionId, 'herd');
                          }}
                          onWorkspaceFilterChange={
                            navigation.setHerdWorkspaceFilter
                          }
                          onCloseHost={sessions.close}
                          onNewHost={() => navigation.selectTab('hosts')}
                          onSelectWorkspace={sessions.selectWorkspace}
                          onFocusWorkspace={sessions.focusWorkspace}
                          onCreateWorkspace={sessions.createWorkspace}
                          onRenameWorkspace={sessions.renameWorkspace}
                          onCloseWorkspace={sessions.closeWorkspace}
                          onCloseTab={sessions.closeTab}
                          onRefresh={async () => {
                            const ids = herdProjectionRequest.hostId
                              ? [herdProjectionRequest.hostId]
                              : sessions.state.sessions.map(
                                  session => session.id,
                                );
                            await Promise.all(ids.map(sessions.refresh));
                          }}
                          onOpenTerminal={sessions.openAgentTerminal}
                          onOpenFiles={(sessionId, agent) =>
                            openAgentFiles(sessionId, agent.pane_id)
                          }
                          onLaunchTab={async (...args) => {
                            await sessions.launchTab(...args);
                            const launch = args[3];
                            if (launch.type === 'command') {
                              history.record(launch.command);
                            }
                          }}
                          onOpenSpace={sessions.openWorkspace}
                          onStartServer={sessions.startServer}
                          onOpenSshShell={sessions.openSshShell}
                        />
                      ) : (
                        <ConnectRequiredScreen
                          destination={t('nav.herd')}
                          onPickHost={() => navigation.selectTab('hosts')}
                        />
                      )}
                    </AgentStatusAnimationProvider>
                  </View>
                ) : null}

                {navigation.mountedTabs.has('terminal') &&
                  !activeSession &&
                  navigation.state.tab === 'terminal' && (
                    <ConnectRequiredScreen
                      destination={t('nav.terminal')}
                      onPickHost={() => navigation.selectTab('hosts')}
                    />
                  )}

                {navigation.mountedTabs.has('more') ? (
                  <View
                    importantForAccessibility={
                      navigation.state.tab === 'more'
                        ? 'auto'
                        : 'no-hide-descendants'
                    }
                    pointerEvents={
                      navigation.state.tab === 'more' ? 'auto' : 'none'
                    }
                    style={
                      navigation.state.tab === 'more'
                        ? styles.tabScreen
                        : styles.hiddenTab
                    }
                  >
                    <MoreScreen
                      alertsEnabled={alertsEnabled}
                      agentAlertLevel={agentAlertLevel}
                      backgroundMonitoringAvailable={
                        alertsEnabled && sessions.state.sessions.length > 0
                      }
                      persistentAlertDurationSeconds={
                        persistentAlertDurationSeconds
                      }
                      ttsEnabled={ttsEnabled}
                      biometricForKeys={biometricForKeys}
                      biometricOnResume={biometricOnResume}
                      globalKeyCount={hosts.globalSshKeys.length}
                      knownHostCount={
                        hosts.knownHostsState.status === 'loaded'
                          ? hosts.knownHosts.length
                          : null
                      }
                      appearance={appearance}
                      fullscreenApp={fullscreenApp}
                      appBackgroundImageUri={
                        storedPreferences.appBackgroundImageUri
                      }
                      appBackgroundDimming={
                        storedPreferences.appBackgroundDimming
                      }
                      appGlassEnabled={storedPreferences.appGlassEnabled}
                      accessTier={accessTier}
                      entitlements={displayedEntitlements}
                      developerOptionsEnabled={developerOptionsEnabled}
                      developerMembershipState={
                        storedPreferences.developerMembershipState
                      }
                      membershipSimulationEnabled={
                        developerMembershipState !== null
                      }
                      language={language}
                      keepScreenOn={keepScreenOn}
                      reopenTerminalOnLaunch={reopenTerminalOnLaunch}
                      agentCommand={agentCommand}
                      terminalHistory={history.entries}
                      terminalPreferences={storedPreferences.terminal}
                      onAlertsChange={value =>
                        preferences.setPreference('alertsEnabled', value)
                      }
                      onAgentAlertLevelChange={value =>
                        preferences.setPreference('agentAlertLevel', value)
                      }
                      onStartBackgroundMonitoring={async () => {
                        try {
                          await startBackgroundMonitoring(
                            sessions.state.sessions.length,
                          );
                        } catch (error) {
                          hosts.setError(
                            t('app.backgroundUnavailable', {
                              error: String(error),
                            }),
                          );
                        }
                      }}
                      onPersistentAlertDurationChange={value =>
                        preferences.setPreference(
                          'persistentAlertDurationSeconds',
                          value,
                        )
                      }
                      onTestAgentNotification={() => {
                        alertAgent(
                          {
                            terminal_id: 'whip-alert-test',
                            agent: 'Whip',
                            agent_status: 'done',
                            workspace_id: 'whip-alert-test',
                            tab_id: 'whip-alert-test',
                            pane_id: 'whip-alert-test',
                            focused: false,
                            revision: 0,
                          },
                          false,
                          {
                            hostId: 'whip-alert-test',
                            paneId: 'whip-alert-test',
                          },
                          t('settings.testAgentNotificationTab'),
                          Platform.OS === 'android'
                            ? agentAlertLevel
                            : 'persistent',
                          persistentAlertDurationSeconds * 1_000,
                        ).catch(error => hosts.setError(String(error)));
                      }}
                      onTtsChange={value =>
                        preferences.setPreference('ttsEnabled', value)
                      }
                      onBiometricForKeysChange={value => {
                        ignoreExpectedCancellation(
                          security.updateBiometricForKeys(value),
                        );
                      }}
                      onBiometricOnResumeChange={value => {
                        ignoreExpectedCancellation(
                          security.updateBiometricOnResume(value),
                        );
                      }}
                      onManageGlobalKeychain={() => {
                        ignoreExpectedCancellation(hosts.openGlobalKeychain());
                      }}
                      onManageKnownHosts={hosts.openKnownHosts}
                      onOpenLicenses={navigation.openLicenses}
                      onAppearanceChange={value =>
                        preferences.setPreference('appearance', value)
                      }
                      onFullscreenAppChange={value =>
                        preferences.setPreference('fullscreenApp', value)
                      }
                      onAppBackgroundImageChange={value =>
                        preferences.setPreference(
                          'appBackgroundImageUri',
                          value,
                        )
                      }
                      onAppBackgroundDimmingChange={value =>
                        preferences.setPreference('appBackgroundDimming', value)
                      }
                      onAppGlassEnabledChange={value =>
                        preferences.setPreference('appGlassEnabled', value)
                      }
                      onDeveloperOptionsEnabledChange={value => {
                        preferences.setPreference(
                          'developerOptionsEnabled',
                          value,
                        );
                        if (!value) {
                          preferences.setTerminalPreferences(current =>
                            current.visualHints
                              ? { ...current, visualHints: false }
                              : current,
                          );
                        }
                      }}
                      onDeveloperMembershipStateChange={value =>
                        preferences.setPreference(
                          'developerMembershipState',
                          value,
                        )
                      }
                      onLanguageChange={value =>
                        preferences.setPreference('language', value)
                      }
                      onKeepScreenOnChange={value =>
                        preferences.setPreference('keepScreenOn', value)
                      }
                      onReopenTerminalOnLaunchChange={value =>
                        preferences.setPreference(
                          'reopenTerminalOnLaunch',
                          value,
                        )
                      }
                      onAgentCommandChange={value =>
                        preferences.setPreference('agentCommand', value)
                      }
                      onDeleteTerminalHistory={history.remove}
                      onTerminalPreferencesChange={
                        preferences.setTerminalPreferences
                      }
                    />
                  </View>
                ) : null}
              </View>

              {navigation.mountedTabs.has('terminal') &&
                activeSession &&
                sessions.activeClient && (
                  <AgentStatusAnimationProvider enabled={terminalVisible}>
                    <LiveSessionView
                      session={activeSession}
                      client={sessions.activeClient}
                      visible={terminalVisible}
                      ttsEnabled={ttsEnabled}
                      latencyMs={visibleLiveHostLatency(
                        activeSession.status,
                        activeTelemetry?.latencyMs ?? null,
                      )}
                      latencyWarningActive={
                        activeSession.status === 'ready' &&
                        Boolean(activeTelemetry?.latencyWarning.active)
                      }
                      terminalState={terminals.get(activeSession.id)}
                      terminalTargets={sessions.terminalTargets}
                      appBackgroundImageUri={appBackgroundImageUri}
                      appBackgroundDimming={appBackgroundDimming}
                      terminalPreferences={terminalPreferences}
                      terminalControlUsage={terminalControlUsage}
                      terminalHistory={history.entries}
                      onOpenFiles={remoteFiles.open}
                      getTerminalComposerDraft={terminals.getComposerDraft}
                      onTerminalComposerDraftChange={
                        terminals.updateComposerDraft
                      }
                      onTerminalControlUse={
                        preferences.recordTerminalControlUse
                      }
                      onTerminalHistoryEntry={history.record}
                      onTerminalOpenLinksInAppChange={openLinksInApp =>
                        preferences.setTerminalPreferences(current =>
                          current.openLinksInApp === openLinksInApp
                            ? current
                            : { ...current, openLinksInApp },
                        )
                      }
                      onInteraction={(sessionId, tabId) => {
                        reportBackgroundFailure(
                          dismissAgentAlertsForTab(sessionId, tabId),
                          'tab-alert-dismiss',
                        );
                      }}
                      onExit={() =>
                        sessions.exitTerminalToHerd(activeSession.id)
                      }
                      onRefresh={sessions.refresh}
                      onOpenPane={(sessionId, pane) => {
                        sessions.select(sessionId, 'terminal');
                        navigation.selectPane(pane.pane_id);
                      }}
                      onActivateTerminal={sessions.activatePaneTerminal}
                      onCloseTerminal={sessions.closeTerminal}
                      onTerminalStatus={terminals.updateStatus}
                      onTerminalFontSizeChange={terminals.updateFontSize}
                    />
                  </AgentStatusAnimationProvider>
                )}
              {navigation.mountedTabs.has('terminal') && terminalRecovery && (
                <HostSessionRecoveryScreen
                  busy={terminalRecovery.busy}
                  error={terminalRecovery.error}
                  host={hostDisplayName(terminalRecovery.session.host)}
                  onBack={() =>
                    sessions.exitTerminalToHerd(terminalRecovery.session.id)
                  }
                  onReconnect={() => {
                    sessions
                      .connectSavedHost(terminalRecovery.session.host)
                      .catch(error => hosts.setError(String(error)));
                  }}
                />
              )}
            </NavigationBlurTarget>

            {!immersiveTerminal && !overlaysVisible && (
              <BottomNavigation
                activeTab={navigation.state.tab}
                blurTarget={navigationBlurTargetRef}
                onSelect={navigation.selectTab}
              />
            )}

            <AppOverlays
              effectivePreferences={effectivePreferences}
              hosts={hosts}
              sessions={sessions}
              navigation={navigation}
              remoteFiles={remoteFiles}
              security={security}
            />
          </View>
        </GlassProvider>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  navigationBlurTarget: { flex: 1 },
  tabScreen: { flex: 1 },
  navigationForeground: { flex: 1, zIndex: 1 },
  hiddenTab: { position: 'absolute', inset: 0, opacity: 0 },
});
