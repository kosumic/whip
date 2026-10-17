import { useCallback } from 'react';
import type { ComposerDraftRequest } from '../lib/composerDraftRequest';
import type { TerminalComposerStore } from '../lib/terminalComposerStore';

import type {
  TerminalControlId,
  TerminalControlUsage,
} from '../lib/terminalControls';
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import type { SessionPresentation } from '../liveHostSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import type { HerdrClient } from '../services/HerdrClient';
import type {
  TerminalSessionsState,
  TerminalSessionStatus,
} from '../terminalSessions';
import type { PaneInfo } from '../types';
import { SessionScreen } from './SessionScreen';

interface Props {
  composerDraftRequest?: ComposerDraftRequest;
  onComposerDraftConsumed?: (id: number) => void;
  session: SessionPresentation;
  client: HerdrClient | null;
  visible: boolean;
  ttsEnabled: boolean;
  latencyMs: number | null;
  latencyWarningActive: boolean;
  terminalState: TerminalSessionsState;
  terminalTargets: readonly TerminalRenderTarget[];
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  terminalHistory: readonly string[];
  onOpenFiles: (
    sessionId: string,
    terminalId: string,
    target?: TranscriptFileLinkTarget,
  ) => void;
  composerStore: TerminalComposerStore;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onTerminalHistoryEntry: (entry: string) => void;
  onInteraction: (sessionId: string, tabId: string) => void;
  onExit: () => void;
  onRefresh: (sessionId: string) => Promise<void>;
  onOpenPane: (sessionId: string, pane: PaneInfo) => void;
  onActivateTerminal: (sessionId: string, pane: PaneInfo) => void;
  onOpenSshShell: (sessionId: string, title?: string) => void;
  onSelectSshShell: (sessionId: string, terminalId: string) => void;
  onRenameSshShell: (sessionId: string, terminalId: string, title: string) => void;
  onCloseTerminal: (sessionId: string, terminalId: string) => void;
  onTerminalStatus: (
    sessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
  onTerminalFontSizeChange: (
    sessionId: string,
    terminalId: string,
    fontSize: number,
  ) => void;
}

/** Adapts one application-level live host into SessionScreen's local contract. */
export function LiveSessionView({
  composerDraftRequest,
  onComposerDraftConsumed,
  session,
  client,
  visible,
  ttsEnabled,
  latencyMs,
  latencyWarningActive,
  terminalState,
  terminalTargets,
  appBackgroundImageUri,
  appBackgroundDimming,
  terminalPreferences,
  terminalControlUsage,
  terminalHistory,
  onOpenFiles,
  composerStore,
  onTerminalControlUse,
  onTerminalHistoryEntry,
  onInteraction,
  onExit,
  onRefresh,
  onOpenPane,
  onActivateTerminal,
  onOpenSshShell,
  onSelectSshShell,
  onRenameSshShell,
  onCloseTerminal,
  onTerminalStatus,
  onTerminalFontSizeChange,
}: Props) {
  const sessionId = session.id;
  const refresh = useCallback(
    () => onRefresh(sessionId),
    [onRefresh, sessionId],
  );
  const openPane = useCallback(
    (pane: PaneInfo) => onOpenPane(sessionId, pane),
    [onOpenPane, sessionId],
  );
  const activateTerminal = useCallback(
    (pane: PaneInfo) => onActivateTerminal(sessionId, pane),
    [onActivateTerminal, sessionId],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => onCloseTerminal(sessionId, terminalId),
    [onCloseTerminal, sessionId],
  );
  const openSshShell = useCallback(
    (title?: string) => onOpenSshShell(sessionId, title),
    [onOpenSshShell, sessionId],
  );
  const selectSshShell = useCallback(
    (terminalId: string) => onSelectSshShell(sessionId, terminalId),
    [onSelectSshShell, sessionId],
  );
  const renameSshShell = useCallback(
    (terminalId: string, title: string) => onRenameSshShell(sessionId, terminalId, title),
    [onRenameSshShell, sessionId],
  );
  const openFiles = useCallback(
    (terminalId: string, target?: TranscriptFileLinkTarget) =>
      onOpenFiles(sessionId, terminalId, target),
    [onOpenFiles, sessionId],
  );
  return (
    <SessionScreen
      composerDraftRequest={composerDraftRequest}
      onComposerDraftConsumed={onComposerDraftConsumed}
      hostId={session.hostId}
      hostSessionId={sessionId}
      visible={visible}
      ttsEnabled={ttsEnabled}
      snapshot={session.snapshot}
      client={client}
      terminalState={terminalState}
      terminalTargets={terminalTargets}
      appBackgroundImageUri={appBackgroundImageUri}
      appBackgroundDimming={appBackgroundDimming}
      latencyMs={latencyMs}
      latencyWarningActive={latencyWarningActive}
      onRefresh={refresh}
      onOpenPane={openPane}
      onActivateTerminal={activateTerminal}
      onOpenSshShell={openSshShell}
      onSelectSshShell={selectSshShell}
      onRenameSshShell={renameSshShell}
      onCloseTerminal={closeTerminal}
      onTerminalStatus={onTerminalStatus}
      onTerminalFontSizeChange={onTerminalFontSizeChange}
      terminalPreferences={terminalPreferences}
      terminalControlUsage={terminalControlUsage}
      terminalHistory={terminalHistory}
      onOpenFiles={openFiles}
      composerStore={composerStore}
      onTerminalControlUse={onTerminalControlUse}
      onTerminalHistoryEntry={onTerminalHistoryEntry}
      onInteraction={tabId => onInteraction(sessionId, tabId)}
      onExit={onExit}
    />
  );
}
