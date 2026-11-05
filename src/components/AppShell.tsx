import { useEffect, useMemo, useRef, useState } from 'react';
import { BlurTargetView } from 'expo-blur';
import { Platform, StyleSheet, View, type ViewInstance } from 'react-native';
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
import type { WhipEntitlementsController } from '../billing/useWhipEntitlements';
import { resolveHerdProjectionRequest, type HerdHostQueue } from '../herdQueue';
import { aggregateAgentStatus } from '../lib/agentStatusAggregate';
import { chatAgentForPane } from '../lib/agentChatSession';
import { PRIORITY_CHAT_VIEWPORT_CAPACITY } from '../lib/chatViewportState';
import { terminalRendererKey, type TerminalRenderTarget } from '../lib/terminalRenderer';
import { shouldEnableAppGlass } from '../lib/appGlass';
import { hostDisplayName } from '../lib/hostProfiles';
import { hostRuntimeSummary } from '../lib/hostRuntimeSummary';
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
import { BrowserSurface } from '../browser/BrowserSurface';
import { connectedBrowserRuntimes } from '../browser/registry';
import {
  StableStatusBar,
  TerminalKeepAwake,
  TerminalVolumeKeyBinding,
} from './AppPlatformBindings';
import { BottomNavigation } from './BottomNavigation';
import { ConnectRequiredScreen } from './ConnectRequiredScreen';
import { GlassProvider } from './GlassSurface';
import { VoiceVadSensitivityContext } from '../lib/voiceVadSensitivity';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { voiceSessionManager } from '../services/voiceSessionManager';
import { GlobalCallContext } from '../lib/globalCallContext';
import { GlobalVoiceCall, type GlobalVoiceCallHandle } from './GlobalVoiceCall';
import { HerdScreen } from './HerdScreen';
import { HostsScreen } from './HostsScreen';
import { LiveSessionView } from './LiveSessionView';
import { MoreScreen } from './MoreScreen';
import { ScreenUpdates } from './ScreenUpdates';

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
  const { isDark } = useTheme();
  const navigationBlurTargetRef = useRef<ViewInstance | null>(null);
  const globalCallRef = useRef<GlobalVoiceCallHandle>(null);
  const [openAiConfigRequest, setOpenAiConfigRequest] = useState(0);
  const storedPreferences = preferences.value;
  const capabilities = entitlements.capabilities;
  const effectivePreferences = useMemo(
    () => effectiveDevicePreferences(storedPreferences, capabilities),
    [capabilities, storedPreferences],
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
  const retainedPriorityTargets = useRef<TerminalRenderTarget[]>([]);
  const priorityChatTargets = useMemo(() => {
    const targets: TerminalRenderTarget[] = [];
    // Rust owns the unfiltered, device-wide Herd attention order.
    for (const item of sessions.herdView([]).agents) {
      const client = sessions.getClient(item.hostId);
      const native = client?.activeNative;
      if (!client || !native) continue;
      const host = native.hostState();
      const pane = host.snapshot?.panes.find(candidate => candidate.terminal_id === item.agent.terminal_id);
      const agent = chatAgentForPane(pane);
      const identity = pane?.agent_session;
      if (!pane || !agent || !identity?.value.trim() ||
        (identity.kind !== 'id' && !(agent === 'pi' && identity.kind === 'path'))) continue;
      const key = terminalRendererKey(item.hostId, pane.terminal_id);
      if (targets.some(target => target.key === key)) continue;
      targets.push({
        key,
        hostSessionId: item.hostId, client, agentStatus: pane.agent_status,
        session: {
          terminalId: pane.terminal_id, paneId: pane.pane_id, title: '',
          kind: 'herdr', status: 'connected', reconnectAttempt: 0,
        },
      });
      if (targets.length === PRIORITY_CHAT_VIEWPORT_CAPACITY) break;
    }
    // Unrelated controller updates must not restart viewport pins/subscriptions.
    const previous = retainedPriorityTargets.current;
    if (previous.length === targets.length && previous.every((target, index) => {
      const next = targets[index];
      return target.key === next.key && target.client === next.client &&
        target.agentStatus === next.agentStatus && target.session.paneId === next.session.paneId;
    })) return previous;
    retainedPriorityTargets.current = targets;
    return targets;
  }, [sessions]);
  // Mount the shared viewport owner while Herd is open, even before selecting a host.
  const viewportSession = activeSession ?? sessions.presentationSessions.find(
    session => session.id === priorityChatTargets[0]?.hostSessionId,
  );
  useEffect(() => {
    if (sessions.restoreComplete) void voiceSessionManager.retainAgentHosts(sessions.presentationSessions.map(session => session.id));
  }, [sessions.restoreComplete, sessions.presentationSessions]);
  // The runtime owns local transcripts even when its SSH transport is offline.
  const liveClient = sessions.activeClient?.activeNative
    ? sessions.activeClient
    : null;
  const activeTelemetry = activeSession
    ? telemetry.get(activeSession.id)
    : null;
  const terminalVisible =
    navigation.state.tab === 'terminal' && !hosts.editorProfile;
  const immersiveTerminal = terminalVisible && Boolean(activeSession);
  const activeTerminalVisible = Boolean(
    immersiveTerminal &&
      activeSession &&
      terminals.get(activeSession.id, sessions.state).activeTerminalId,
  );
  const fullscreenVisible = immersiveTerminal
    ? activeTerminalVisible && terminalPreferences.fullscreen
    : fullscreenApp;

  const openGlobalKeychain = () => {
    ignoreExpectedCancellation(hosts.openGlobalKeychain());
  };

  const openAgentFiles = (sessionId: string, paneId: string) => {
    const pane = sessions.presentationSessions
      .find(session => session.id === sessionId)
      ?.snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) remoteFiles.open(sessionId, pane.terminal_id);
  };

  const renderHerd = () => {
    const herdProjectionRequest = resolveHerdProjectionRequest(
      sessions.presentationSessions.map(session => session.id),
      navigation.herdHostFilterId,
      navigation.herdWorkspaceFilterIds,
    );
    const scopedSession = sessions.presentationSessions.find(
      session => session.id === herdProjectionRequest.hostId,
    );
    const offline = Boolean(scopedSession && scopedSession.connectionStatus !== 'ready');
    const herdProjection = sessions.herdView(
      sessions.presentationSessions.map(session => ({
        sessionId: session.id,
        hostLabel: hostDisplayName(session.host),
        address: session.host.host,
      })),
      herdProjectionRequest.hostId ?? undefined,
      herdProjectionRequest.workspaceId ?? undefined,
    );
    const herdHostsById = new Map(herdProjection.hosts.map(host => [host.id, host]));
    const railSessions: LiveSessionRailItem[] = sessions.presentationSessions.map(session => {
      const herdHost = herdHostsById.get(session.id);
      return {
        hostId: session.id,
        label: hostDisplayName(session.host),
        status: session.connectionStatus,
        // Herd defaults to idle without agents; the rail still summarizes
        // workspaces in that case and defaults to unknown without workspaces.
        agentStatus: herdHost && herdHost.agents.length > 0
          ? herdHost.agentStatus
          : aggregateAgentStatus(
            session.snapshot.workspaces.map(workspace => workspace.agent_status),
            'unknown',
          ),
        terminalCount: terminals.get(session.id, sessions.state).sessions.length,
      };
    });
    const herdQueues: HerdHostQueue[] = herdProjection.hosts.map(host => ({
      ...host,
      herdrEnabled: sessions.presentationSessions.find(session => session.id === host.id)?.host.herdrEnabled !== false,
    }));

    return (
      <HerdScreen
        queues={herdQueues}
        agents={herdProjection.agents.map(item => ({
          ...item,
          terminalStatus: terminals.get(item.hostId, sessions.state).sessions.find(
            terminal => terminal.terminalId === item.agent.terminal_id,
          )?.status,
        }))}
        sessions={railSessions}
        selectedHostId={herdProjection.selectedHostId ?? null}
        workspaceFilterId={herdProjection.selectedWorkspaceId ?? null}
        offline={offline}
        agentCommand={agentCommand}
        commandHistory={history.entries}
        onSelectHost={sessionId => {
          navigation.selectHerdHost(sessionId);
          if (!sessionId) return;
          const selected = sessions.presentationSessions.find(session => session.id === sessionId);
          if (selected && selected.connectionStatus !== 'ready' && !sessions.getClient(sessionId)) {
            reportBackgroundFailure(
              sessions.connectSavedHost(selected.host),
              'herd-host-connect',
            );
          } else {
            sessions.select(sessionId, 'herd');
          }
        }}
        onWorkspaceFilterChange={navigation.setHerdWorkspaceFilter}
        onCloseHost={sessions.close}
        onNewHost={() => navigation.selectTab('hosts')}
        onSelectWorkspace={sessions.selectWorkspace}
        onFocusWorkspace={sessions.focusWorkspace}
        onCreateWorkspace={sessions.createWorkspace}
        onRenameWorkspace={sessions.renameWorkspace}
        onCloseWorkspace={sessions.closeWorkspace}
        onCloseTab={sessions.closeTab}
        onSetAgentReverseControl={sessions.setAgentReverseControl}
        onRestartAgent={sessions.restartAgent}
        onCopyAgent={sessions.copyAgent}
        onRefresh={async () => {
          if (offline && scopedSession) {
            await sessions.connectSavedHost(scopedSession.host);
            return;
          }
          const ids = herdProjectionRequest.hostId
            ? [herdProjectionRequest.hostId]
            : sessions.presentationSessions.map(session => session.id);
          await Promise.all(ids.map(sessions.refresh));
        }}
        onOpenTerminal={sessions.openAgentTerminal}
        onSetAgentPinned={async (hostId, terminalId, pinned) => {
          await sessions.getClient(hostId)?.native.setAgentPinned(terminalId, pinned);
        }}
        onMarkAgentUnread={async (hostId, terminalId) => {
          await sessions.getClient(hostId)?.native.markAgentUnread(terminalId);
        }}
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
        onCheckHerdr={sessions.checkHerdr}
        onInstallHerdr={sessions.installHerdr}
        onOpenHerdrInstallation={sessions.openHerdrInstallation}
        herdrInstallations={sessions.herdrInstallations}
        onOpenSshShell={sessions.openSshShell}
      />
    );
  };

  const overlaysVisible =
    hosts.editorProfile !== null ||
    hosts.newHostOpen ||
    hosts.unlockedGlobalKeys !== null ||
    hosts.knownHostsOpen ||
    navigation.licensesOpen;

  return (
    <VoiceConversationSettingsContext value={{ settings: storedPreferences.voiceConversation, onChange: value => preferences.setPreference('voiceConversation', value) }}>
    <GlobalCallContext value={() => globalCallRef.current?.open()}>
    <VoiceVadSensitivityContext value={storedPreferences.vadSensitivity}>
      <StableStatusBar
        hidden={fullscreenVisible}
        isDark={isDark}
      />
      <SafeAreaView
        className="flex-1 bg-background"
        // Android's display-cutout inset remains even with the status bar hidden.
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
            {/* Android only captures this target while a surface requests blur. */}
            <BlurTargetView
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
                      <ScreenUpdates active={navigation.state.tab === 'hosts'}>
                        {() => (
                          <HostsScreen
                            hosts={hosts.hosts}
                            activeHostId={activeSession?.hostId || null}
                            connectedHostIds={sessions.presentationSessions
                              .filter(session =>
                                isLiveHostSshConnected(session.connectionStatus),
                              )
                              .map(session => session.hostId)}
                            latencyMsByHostId={Object.fromEntries(
                              sessions.presentationSessions.map(session => [
                                session.hostId,
                                visibleLiveHostLatency(
                                  session.connectionStatus,
                                  telemetry.get(session.id).latencyMs,
                                ),
                              ]),
                            )}
                            runtimeByHostId={Object.fromEntries(
                              sessions.presentationSessions.map(session => [
                                session.hostId,
                                hostRuntimeSummary(session.snapshot),
                              ]),
                            )}
                            connectingHostIds={[
                              ...sessions.presentationSessions
                                .filter(
                                  session => session.connectionStatus === 'connecting',
                                )
                                .map(session => session.hostId),
                              ...sessions.connectingHostIds,
                            ]}
                            error={hosts.error}
                            credentialRecovery={hosts.credentialRecovery}
                            credentialRecoveryBusy={
                              hosts.credentialRecoveryBusy
                            }
                            onAdd={hosts.openNewHost}
                            onConnect={host => {
                              sessions
                                .connectSavedHost(host)
                                .catch(error => hosts.setError(String(error)));
                            }}
                            onDelete={hosts.confirmDelete}
                            onDisconnect={host =>
                              sessions.closeHostById(host.id)
                            }
                            onEdit={hosts.openEditor}
                            onManageGlobalKeychain={openGlobalKeychain}
                            onUnlockCredentials={hosts.unlockCredentialRecovery}
                          />
                        )}
                      </ScreenUpdates>
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
                      <ScreenUpdates active={navigation.state.tab === 'herd'}>
                        {renderHerd}
                      </ScreenUpdates>
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
                    <ScreenUpdates active={navigation.state.tab === 'more'}>
                      {() => (
                        <MoreScreen
                          openAiConfigRequest={openAiConfigRequest}
                          alertsEnabled={alertsEnabled}
                          agentAlertLevel={agentAlertLevel}
                          backgroundMonitoringAvailable={
                            alertsEnabled && sessions.presentationSessions.length > 0
                          }
                          persistentAlertDurationSeconds={
                            persistentAlertDurationSeconds
                          }
                          ttsEnabled={ttsEnabled}
                          vadSensitivity={storedPreferences.vadSensitivity}
                          onVadSensitivityChange={value => preferences.setPreference('vadSensitivity', value)}
                          biometricForKeys={biometricForKeys}
                          biometricOnResume={biometricOnResume}
                          globalKeyCount={hosts.globalSshKeys.length}
                          knownHostCount={
                            hosts.knownHostsState.status === 'loaded'
                              ? hosts.knownHosts.length
                              : null
                          }
                          appearance={appearance}
                          appFontSizePercent={storedPreferences.appFontSizePercent}
                          fullscreenApp={fullscreenApp}
                          appBackgroundImageUri={
                            storedPreferences.appBackgroundImageUri
                          }
                          appBackgroundDimming={
                            storedPreferences.appBackgroundDimming
                          }
                          appGlassEnabled={storedPreferences.appGlassEnabled}
                          entitlements={entitlements}
                          developerOptionsEnabled={developerOptionsEnabled}
                          developerMembershipState={
                            storedPreferences.developerMembershipState
                          }
                          membershipEnabled={entitlements.billingEnabled}
                          language={language}
                          keepScreenOn={keepScreenOn}
                          reopenTerminalOnLaunch={reopenTerminalOnLaunch}
                          agentCommand={agentCommand}
                          reverseControlInstructions={storedPreferences.reverseControlInstructions}
                          onReverseControlInstructionsChange={value =>
                            preferences.setPreference('reverseControlInstructions', value)
                          }
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
                                sessions.presentationSessions.length,
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
                          onManageGlobalKeychain={openGlobalKeychain}
                          onManageKnownHosts={hosts.openKnownHosts}
                          onOpenLicenses={navigation.openLicenses}
                          onAppearanceChange={value =>
                            preferences.setPreference('appearance', value)
                          }
                          onAppFontSizePercentChange={value =>
                            preferences.setPreference('appFontSizePercent', value)
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
                            preferences.setPreference(
                              'appBackgroundDimming',
                              value,
                            )
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
                      )}
                    </ScreenUpdates>
                  </View>
                ) : null}
              </View>

              {(navigation.mountedTabs.has('terminal') || priorityChatTargets.length > 0) &&
                viewportSession && (
                  <AgentStatusAnimationProvider enabled={terminalVisible}>
                    <LiveSessionView
                      session={viewportSession}
                      client={activeSession ? liveClient : sessions.getClient(viewportSession.id) ?? null}
                      visible={terminalVisible && Boolean(activeSession)}
                      attentionVisible={terminalVisible && !overlaysVisible}
                      ttsEnabled={ttsEnabled}
                      latencyMs={visibleLiveHostLatency(
                        viewportSession.connectionStatus,
                        activeTelemetry?.latencyMs ?? null,
                      )}
                      latencyWarningActive={
                        viewportSession.connectionStatus === 'ready' &&
                        Boolean(activeTelemetry?.latencyWarning.active)
                      }
                      terminalState={terminals.get(viewportSession.id, sessions.state)}
                      terminalTargets={sessions.terminalTargets}
                      priorityChatTargets={priorityChatTargets}
                      appBackgroundImageUri={appBackgroundImageUri}
                      appBackgroundDimming={appBackgroundDimming}
                      terminalPreferences={terminalPreferences}
                      terminalControlUsage={terminalControlUsage}
                      terminalHistory={history.entries}
                      onOpenFiles={remoteFiles.open}
                      composerDraftRequest={remoteFiles.draftRequest?.hostSessionId === viewportSession.id ? remoteFiles.draftRequest : undefined}
                      onComposerDraftConsumed={remoteFiles.consumeDraft}
                      composerStore={terminals.composerStore}
                      onTerminalControlUse={
                        preferences.recordTerminalControlUse
                      }
                      onTerminalHistoryEntry={history.record}
                      onInteraction={(sessionId, tabId) => {
                        reportBackgroundFailure(
                          dismissAgentAlertsForTab(sessionId, tabId),
                          'tab-alert-dismiss',
                        );
                      }}
                      onExit={() =>
                        sessions.exitTerminalToHerd(viewportSession.id)
                      }
                      onRefresh={async sessionId => {
                        if (viewportSession.connectionStatus === 'ready') await sessions.refresh(sessionId);
                        else await sessions.connectSavedHost(viewportSession.host);
                      }}
                      onOpenPane={(sessionId, pane) => {
                        sessions.select(sessionId, 'terminal');
                        sessions.activatePaneTerminal(sessionId, pane);
                        navigation.selectPane(pane.pane_id);
                      }}
                      onActivateTerminal={sessions.activatePaneTerminal}
                      onOpenSshShell={sessions.openSshShell}
                      onSelectSshShell={terminals.selectSshShell}
                      onRenameSshShell={terminals.renameSshShell}
                      onCloseTerminal={(sessionId, terminalId) => {
                        if (viewportSession.connectionStatus === 'ready') sessions.closeTerminal(sessionId, terminalId);
                      }}
                      onTerminalStatus={terminals.updateStatus}
                      onTerminalFontSizeChange={terminals.updateFontSize}
                      onTerminalChatSelect={terminals.selectChat}
                    />
                  </AgentStatusAnimationProvider>
                )}
            </BlurTargetView>

            {!immersiveTerminal && !overlaysVisible && (
              <BottomNavigation
                activeTab={navigation.state.tab}
                blurTarget={navigationBlurTargetRef}
                onSelect={navigation.selectTab}
              />
            )}

            <BrowserSurface runtimes={connectedBrowserRuntimes(
              sessions.presentationSessions,
              id => sessions.getClient(id)?.native,
            )} />
            <AppOverlays
              effectivePreferences={effectivePreferences}
              hosts={hosts}
              sessions={sessions}
              navigation={navigation}
              remoteFiles={remoteFiles}
              security={security}
            />
            <GlobalVoiceCall ref={globalCallRef} navigation={navigation} sessions={sessions} locked={security.locked} visible={!overlaysVisible}
              onConfigureOpenAi={() => {
                navigation.selectTab('more');
                setOpenAiConfigRequest(request => request + 1);
              }} />
          </View>
        </GlassProvider>
      </SafeAreaView>
    </VoiceVadSensitivityContext>
    </GlobalCallContext>
    </VoiceConversationSettingsContext>
  );
}

const styles = StyleSheet.create({
  navigationBlurTarget: { flex: 1 },
  tabScreen: { flex: 1 },
  navigationForeground: { flex: 1, zIndex: 1 },
  hiddenTab: { position: 'absolute', inset: 0, opacity: 0 },
});
