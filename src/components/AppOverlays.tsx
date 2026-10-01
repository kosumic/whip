import { View } from 'react-native';

import type { DevicePreferences } from '../services/devicePreferences';
import type { HostManagementController } from '../hooks/useHostManagement';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { RemoteFilesController } from '../hooks/useRemoteFilesController';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import type { useApplicationSecurity } from '../hooks/useApplicationSecurity';
import {
  ignoreExpectedCancellation,
  reportBackgroundFailure,
} from '../services/backgroundOperations';
import { AppAccessLock } from './AppAccessLock';
import { AppBackground } from './AppBackground';
import { ConnectionScreen } from './ConnectionScreen';
import { DeleteHostConfirmationPopup } from './DeleteHostConfirmationPopup';
import { FullScreenOverlay } from './FullScreenOverlay';
import { GlobalKeychainScreen } from './GlobalKeychainScreen';
import { KnownHostsScreen } from './KnownHostsScreen';
import { LicensesScreen } from './LicensesScreen';
import { NewHostScreen } from './NewHostScreen';
import { PairingSuccessPopup } from './PairingSuccessPopup';
import { PaneDetail } from './PaneDetail';
import { RemoteFileManager } from './RemoteFileManager';
import { TrustHostSheet } from './TrustHostSheet';

interface AppOverlaysProps {
  effectivePreferences: DevicePreferences;
  hosts: HostManagementController;
  sessions: SessionRuntimeController;
  navigation: AppNavigationController;
  remoteFiles: RemoteFilesController;
  security: ReturnType<typeof useApplicationSecurity>;
}

/** App-wide modal flows. Domain state remains owned by the supplied controllers. */
export function AppOverlays({
  effectivePreferences,
  hosts,
  sessions,
  navigation,
  remoteFiles,
  security,
}: AppOverlaysProps) {
  const { appBackgroundImageUri, appBackgroundDimming, biometricForKeys } =
    effectivePreferences;
  const activeSession = sessions.activeSession;
  const reviewSession = sessions.presentationSessions.find(session => session.id === remoteFiles.request?.hostSessionId);
  const reviewPane = reviewSession?.snapshot.panes.find(pane => pane.terminal_id === remoteFiles.request?.terminalId);
  const reviewAgentWorking = reviewSession?.snapshot.agents.some(agent => agent.pane_id === reviewPane?.pane_id && agent.agent_status === 'working') ?? false;
  const selectedPane =
    navigation.selectedPaneId && activeSession?.connectionStatus === 'ready'
      ? activeSession.snapshot.panes.find(
          pane => pane.pane_id === navigation.selectedPaneId,
        ) ?? null
      : null;

  return (
    <>
      {hosts.newHostOpen && (
        <View className="absolute inset-0 z-40 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <NewHostScreen
            onCancel={hosts.closeNewHost}
            onManual={hosts.openManualHost}
            onLoadGlobalKeys={hosts.unlockGlobalKeychain}
            onPaired={hosts.savePairedHost}
          />
        </View>
      )}

      {hosts.editorProfile && (
        <View className="absolute inset-0 z-40 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <ConnectionScreen
            key={hosts.editorProfile.id}
            initialProfile={hosts.editorProfile}
            hosts={hosts.hosts}
            connecting={sessions.connectingHostIds.has(hosts.editorProfile.id)}
            error={hosts.error}
            onCancel={hosts.closeEditor}
            onSave={hosts.saveHost}
            onConnect={sessions.connect}
            onDelete={
              hosts.hosts.some(host => host.id === hosts.editorProfile?.id)
                ? () => hosts.confirmDelete(hosts.editorProfile!)
                : undefined
            }
            onAuthenticatePrivateKey={
              biometricForKeys ? security.verifyBiometric : undefined
            }
            onLoadGlobalKeys={hosts.unlockGlobalKeychain}
          />
        </View>
      )}

      {hosts.unlockedGlobalKeys !== null && (
        <View className="absolute inset-0 z-50 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <GlobalKeychainScreen
            initialKeys={hosts.unlockedGlobalKeys}
            onChanged={hosts.updateGlobalKeys}
            onClose={hosts.closeGlobalKeychain}
          />
        </View>
      )}

      {hosts.knownHostsOpen && (
        <FullScreenOverlay>
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <KnownHostsScreen
            state={hosts.knownHostsState}
            onClose={hosts.closeKnownHosts}
            onDelete={hosts.forgetKnownHost}
            onRetry={hosts.retryKnownHosts}
          />
        </FullScreenOverlay>
      )}

      {navigation.licensesOpen && (
        <FullScreenOverlay>
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <LicensesScreen onClose={navigation.closeLicenses} />
        </FullScreenOverlay>
      )}

      {sessions.activeClient && (
        <PaneDetail
          pane={selectedPane}
          client={sessions.activeClient}
          onClose={() => navigation.selectPane(null)}
          onOpenTerminal={pane => {
            if (activeSession)
              sessions.openPaneTerminal(activeSession.id, pane);
          }}
        />
      )}

      {remoteFiles.request && remoteFiles.client && (
        <RemoteFileManager
          key={remoteFiles.request.id}
          client={remoteFiles.client}
          hostId={remoteFiles.request.hostSessionId}
          agentWorking={reviewAgentWorking}
          initialPath={remoteFiles.request.initialPath}
          initialFilePath={remoteFiles.request.initialFilePath}
          initialLine={remoteFiles.request.initialLine}
          onAskAgent={text => remoteFiles.askAgent(remoteFiles.request!.id, text)}
          visible
          onPathChange={path =>
            remoteFiles.rememberPath(remoteFiles.request!.id, path)
          }
          onClose={() => remoteFiles.close(remoteFiles.request?.id)}
        />
      )}

      <TrustHostSheet
        challenge={hosts.unknownHostChallenge}
        onCancel={() => hosts.resolveUnknownHost(false)}
        onTrust={() => hosts.resolveUnknownHost(true)}
      />
      <DeleteHostConfirmationPopup
        busy={hosts.deleteHostBusy}
        host={hosts.deleteHostTarget}
        onCancel={hosts.cancelDelete}
        onDelete={() => {
          reportBackgroundFailure(hosts.deleteConfirmed(), 'host-delete');
        }}
      />
      <PairingSuccessPopup
        result={hosts.pairingSuccess}
        onClose={hosts.closePairingSuccess}
      />
      <AppAccessLock
        authenticating={security.authenticating}
        visible={security.locked}
        onRetry={() => {
          ignoreExpectedCancellation(security.authenticateLockedApp());
        }}
      />
    </>
  );
}
