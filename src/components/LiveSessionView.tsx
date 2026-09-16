import { useCallback } from 'react';

import type {
  TerminalControlId,
  TerminalControlUsage,
} from '../lib/terminalControls';
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import type { LiveHostSession } from '../liveHostSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import type { HerdrClient } from '../services/HerdrClient';
import type {
  TerminalSessionsState,
  TerminalSessionStatus,
} from '../terminalSessions';
import type { PaneInfo } from '../types';
import { SessionScreen } from './SessionScreen';

interface Props {
  session: LiveHostSession;
  client: HerdrClient;
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
  getTerminalComposerDraft: (sessionId: string, terminalId: string) => string;
  onTerminalComposerDraftChange: (
    sessionId: string,
    terminalId: string,
    value: string,
  ) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onTerminalHistoryEntry: (entry: string) => void;
  onTerminalOpenLinksInAppChange: (value: boolean) => void;
  onInteraction: (sessionId: string, tabId: string) => void;
  onExit: () => void;
  onRefresh: (sessionId: string) => Promise<void>;
  onOpenPane: (sessionId: string, pane: PaneInfo) => void;
  onActivateTerminal: (sessionId: string, pane: PaneInfo) => void;
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
  getTerminalComposerDraft,
  onTerminalComposerDraftChange,
  onTerminalControlUse,
  onTerminalHistoryEntry,
  onTerminalOpenLinksInAppChange,
  onInteraction,
  onExit,
  onRefresh,
  onOpenPane,
  onActivateTerminal,
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
  const openFiles = useCallback(
    (terminalId: string, target?: TranscriptFileLinkTarget) =>
      onOpenFiles(sessionId, terminalId, target),
    [onOpenFiles, sessionId],
  );
  const getComposerDraft = useCallback(
    (terminalId: string) => getTerminalComposerDraft(sessionId, terminalId),
    [getTerminalComposerDraft, sessionId],
  );
  const updateComposerDraft = useCallback(
    (terminalId: string, value: string) =>
      onTerminalComposerDraftChange(sessionId, terminalId, value),
    [onTerminalComposerDraftChange, sessionId],
  );

  return (
    <SessionScreen
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
      onCloseTerminal={closeTerminal}
      onTerminalStatus={onTerminalStatus}
      onTerminalFontSizeChange={onTerminalFontSizeChange}
      terminalPreferences={terminalPreferences}
      terminalControlUsage={terminalControlUsage}
      terminalHistory={terminalHistory}
      onOpenFiles={openFiles}
      getComposerDraft={getComposerDraft}
      onComposerDraftChange={updateComposerDraft}
      onTerminalControlUse={onTerminalControlUse}
      onTerminalHistoryEntry={onTerminalHistoryEntry}
      onTerminalOpenLinksInAppChange={onTerminalOpenLinksInAppChange}
      onInteraction={tabId => onInteraction(sessionId, tabId)}
      onExit={onExit}
    />
  );
}
