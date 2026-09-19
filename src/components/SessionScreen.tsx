import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useChatViewportRetention } from '../hooks/useChatViewportRetention';
import { ScreenUpdates } from './ScreenUpdates';
import {
  ChevronLeft,
  Globe2,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview';
import {
  orderByAgentStatusPriority,
  tabAgentStateChangeSequence,
} from '@/src/herdQueue';
import {
  terminalControlBarInset,
  terminalSessionChromeHeight,
} from '@/src/lib/floatingChrome';
import { runWithInFlightGuard } from '@/src/lib/inFlightSubmission';
import { cn } from '@/src/lib/utils';
import {
  activateCreatedTabLocally,
  includePendingCreatedSelection,
  reconcilePendingCreatedSelection,
  serverFocusMatchesPendingPane,
  shouldFollowServerTerminalFocus,
  type CreatedTabFocusResult,
} from '@/src/lib/terminalFocus';
import { terminalWebLinkTarget } from '@/src/lib/terminalLinks';
import {
  resolveTranscriptFilePath,
  type TranscriptFileLinkTarget,
} from '@/src/lib/transcriptLinks';
import type { TerminalRenderTarget } from '@/src/lib/terminalRenderer';
import { TerminalResidencyEndReason, type TerminalResidencyEnd } from '../lib/terminalResidency';
import {
  resolveTerminalVolumeKeyAction,
  type TerminalVolumeKey,
} from '@/src/lib/volumeKeys';
import type {
  TerminalControlId,
  TerminalControlUsage,
} from '../lib/terminalControls';
import {
  activePaneForTerminal,
  agentChatControlState,
  chatAgentForPane,
  chatAgentDisplayName,
} from '../lib/agentChatSession';
import {
  AgentChatPresentationPhase,
  chatPresentationLoading,
  chatPresentationMountsViewport,
  chatPresentationRequested,
  chatPresentationVisible,
  closeChatPresentation,
  dormantChatPresentation,
  requestChatPresentation,
  revealPreparedChat,
  updateChatTranscriptReadiness,
  type AgentChatPresentation,
} from '../lib/agentChatPresentation';
import {
  reconcileAgentChatViews,
  chatBindingLost,
  confirmedChatExit,
  type AgentChatViewState,
} from '../lib/agentChatReconciliation';
import { useAgentChatOpen } from '../hooks/useAgentChatOpen';
import { useFocusedChatSpeech } from '../hooks/useFocusedChatSpeech';
import type { AgentChatState } from '../agentChat';
import type { HerdrClient } from '../services/HerdrClient';
import {
  agentTranscriptReadiness,
  agentTranscriptService,
  type AgentChatProjection,
} from '../services/NativeTranscriptService';
import {
  agentChatDiagnosticToken,
  recordAgentChatDiagnostic,
} from '../services/agentChatDiagnostics';
import { terminalTabSelectionStarted } from '../services/performanceTrace';
import {
  bestEffortCleanup,
  reportBackgroundFailure,
} from '../services/backgroundOperations';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { addTerminalVolumeKeyListener } from '../services/volumeKeys';
import {
  sessionTabGlassStyle,
  sessionTabStatusColor,
  statusColor,
  useTheme,
} from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { AgentIdentityWarningSheet } from './AgentIdentityWarningSheet';
import { AppAlertPopup, type AppAlertContent } from './AppAlertPopup';
import { AppBackground } from './AppBackground';
import {
  AttachmentPasteSheet,
  type PastedAttachment,
} from './AttachmentPasteSheet';
import { AgentIntegrationInstallSheet } from './AgentIntegrationInstallSheet';
import {
  ResourceEditorField,
  ResourceEditorSheet,
} from './ResourceEditorSheet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Text } from './ui/text';
import { TerminalBackground, TerminalScreen } from './TerminalScreen';
import { AgentChatView } from './AgentChatView';
import { useAppGlassEnabled } from './GlassSurface';

interface Props {
  hostSessionId: string;
  visible: boolean;
  ttsEnabled: boolean;
  snapshot: HerdrSnapshot;
  client: HerdrClient;
  terminalState: TerminalSessionsState;
  terminalTargets: readonly TerminalRenderTarget[];
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  latencyMs: number | null;
  latencyWarningActive: boolean;
  onRefresh: () => Promise<void>;
  onOpenPane: (pane: PaneInfo) => void;
  onActivateTerminal: (pane: PaneInfo) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalStatus: (
    hostSessionId: string,
    terminalId: string,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
  onTerminalFontSizeChange: (
    hostSessionId: string,
    terminalId: string,
    fontSize: number,
  ) => void;
  terminalPreferences: TerminalPreferences;
  terminalControlUsage: TerminalControlUsage;
  terminalHistory: readonly string[];
  onOpenFiles: (terminalId: string, target?: TranscriptFileLinkTarget) => void;
  getComposerDraft: (terminalId: string) => string;
  onComposerDraftChange: (terminalId: string, value: string) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onTerminalHistoryEntry: (entry: string) => void;
  onTerminalOpenLinksInAppChange: (value: boolean) => void;
  onInteraction: (tabId: string) => void;
  onExit: () => void;
}

type EditorMode = 'tab' | 'rename-tab' | 'rename-pane';
type PendingFocus = {
  previousId: string | null;
};

interface BrowserWebViewHandle {
  goBack: () => void;
}

const BROWSER_WEBVIEW_STYLE = { flex: 1 } as const;

export function SessionScreen({
  hostSessionId,
  visible,
  ttsEnabled,
  snapshot,
  client,
  terminalState,
  terminalTargets,
  appBackgroundImageUri,
  appBackgroundDimming,
  latencyMs,
  latencyWarningActive,
  onRefresh,
  onActivateTerminal,
  onCloseTerminal,
  onTerminalStatus,
  onTerminalFontSizeChange,
  terminalPreferences,
  terminalControlUsage,
  terminalHistory,
  onOpenFiles,
  getComposerDraft,
  onComposerDraftChange,
  onTerminalControlUse,
  onTerminalHistoryEntry,
  onTerminalOpenLinksInAppChange,
  onInteraction,
  onExit,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const appGlassEnabled = useAppGlassEnabled();
  const safeAreaInsets = useSafeAreaInsets();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  const focusedWorkspace =
    snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const [workspaceId, setWorkspaceId] = useState(
    focusedWorkspace?.workspace_id || '',
  );
  const [tabId, setTabId] = useState(focusedWorkspace?.active_tab_id || '');
  const [pendingCreatedSelection, setPendingCreatedSelection] =
    useState<CreatedTabFocusResult | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [terminalSessionChromeVisible, setTerminalSessionChromeVisible] =
    useState(true);
  const [appAlert, setAppAlert] = useState<AppAlertContent | null>(null);
  const [linkScanRequest, setLinkScanRequest] = useState(0);
  const [linksOpen, setLinksOpen] = useState(false);
  const [terminalLinks, setTerminalLinks] = useState<string[]>([]);
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserDisplayUrl, setBrowserDisplayUrl] = useState('');
  const [browserCanGoBack, setBrowserCanGoBack] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentTerminalId, setAttachmentTerminalId] = useState<
    string | null
  >(null);
  const [chatViews, setChatViews] = useState(
    () => new Map<string, AgentChatViewState>(),
  );
  const [appActive, setAppActive] = useState(() => AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  const [pasteRequest, setPasteRequest] = useState<{
    id: number;
    terminalId: string;
    text: string;
    previewUri: string | null;
    dispose: () => void;
  } | null>(null);
  const browserWebView = useRef<BrowserWebViewHandle | null>(null);
  const tunnelPreviewRef = useRef<string | null>(null);
  const browserRequestRef = useRef(0);
  const pendingPaneFocus = useRef<string | null>(null);
  const lastActivePaneId = useRef<string | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const chatViewsRef = useRef(chatViews);
  // Eviction drops hydrated resources, but keeps Chat-mode intent during restore.
  // This holds only transcript identities, never a second residency/capacity policy.
  const [chatRestoreIntents, setChatRestoreIntents] = useState(new Map<string, string>());
  const chatRestoreIntentsRef = useRef(chatRestoreIntents);
  chatRestoreIntentsRef.current = chatRestoreIntents;
  const activeTerminalIdRef = useRef(terminalState.activeTerminalId);
  const chatPresentationGenerationRef = useRef(0);
  const lastActiveChatDiagnosticRef = useRef('');
  const reportedChatFailureGenerationsRef = useRef(new Set<number>());
  const mutationInFlight = useRef(false);

  const nextChatPresentationGeneration = useCallback(() => {
    chatPresentationGenerationRef.current += 1;
    return chatPresentationGenerationRef.current;
  }, []);

  const requestedChatPresentation = useCallback(
    (state: AgentChatState) =>
      requestChatPresentation(
        dormantChatPresentation(),
        agentTranscriptReadiness(state),
        nextChatPresentationGeneration(),
      ),
    [nextChatPresentationGeneration],
  );

  activeTerminalIdRef.current = terminalState.activeTerminalId;

  const showAppAlert = useCallback((title: string, error: unknown) => {
    setAppAlert({ title, message: String(error) });
  }, []);

  const showHerdrError = useCallback(
    (error: unknown) => {
      showAppAlert(t('herd.commandFailed'), error);
    },
    [showAppAlert, t],
  );

  const workspace =
    snapshot.workspaces.find(item => item.workspace_id === workspaceId) ||
    focusedWorkspace;
  const selectableResources = includePendingCreatedSelection(
    snapshot,
    pendingCreatedSelection,
  );
  const tabs = orderByAgentStatusPriority(
    selectableResources.tabs.filter(
      item => item.workspace_id === workspace?.workspace_id,
    ),
    item => item.agent_status,
    item => tabAgentStateChangeSequence(item, snapshot.agents),
  );
  const selectedTab =
    tabs.find(item => item.tab_id === tabId) ||
    tabs.find(item => item.focused) ||
    tabs[0];
  const editorTitle =
    editorMode === 'rename-tab'
      ? t('session.renameTab')
      : editorMode === 'rename-pane'
      ? t('session.renamePane')
      : t('session.newTab');
  const editorContext =
    editorMode === 'rename-pane'
      ? selectedTab?.label || selectedTab?.tab_id
      : workspace?.label || workspace?.workspace_id;
  const panes = selectableResources.panes.filter(
    item => item.tab_id === selectedTab?.tab_id,
  );
  const sessionChromeInset = terminalSessionChromeHeight(panes.length);
  const serverWorkspace =
    snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const serverTab =
    snapshot.tabs.find(
      item =>
        item.workspace_id === serverWorkspace?.workspace_id &&
        item.tab_id === serverWorkspace.active_tab_id,
    ) ||
    snapshot.tabs.find(
      item =>
        item.workspace_id === serverWorkspace?.workspace_id && item.focused,
    );
  const serverPane =
    snapshot.panes.find(
      item => item.tab_id === serverTab?.tab_id && item.focused,
    ) || snapshot.panes.find(item => item.tab_id === serverTab?.tab_id);
  const serverWorkspaceId = serverWorkspace?.workspace_id || '';
  const serverTabId = serverTab?.tab_id || '';
  const serverPaneId = serverPane?.pane_id || '';
  const pendingCreatedPaneId =
    pendingCreatedSelection?.tab.workspace_id === workspaceId &&
    pendingCreatedSelection.tab.tab_id === tabId
      ? pendingCreatedSelection.root_pane.pane_id
      : null;
  const selectedPane =
    panes.find(item => item.terminal_id === terminalState.activeTerminalId) ||
    panes.find(item => item.focused) ||
    panes[0];
  const activeTerminalSession = terminalState.sessions.find(
    session => session.terminalId === terminalState.activeTerminalId,
  );
  const activePane = activePaneForTerminal(
    selectableResources.panes,
    terminalState.sessions,
    terminalState.activeTerminalId,
  );
  const activeTarget =
    terminalTargets.find(
      target =>
        target.hostSessionId === hostSessionId &&
        target.session.terminalId === activeTerminalSession?.terminalId,
    ) || null;
  const activeChatView = activeTarget
    ? chatViews.get(activeTarget.key) || null
    : null;
  const chatOpen = useAgentChatOpen({
    hostSessionId,
    terminalId: terminalState.activeTerminalId,
    pane: activePane,
    visible,
    client,
    onRefresh,
    onBound: projection => {
      const presentation = requestedChatPresentation(projection.state);
      if (!activeTarget) return;
      setChatViews(current => new Map(current).set(activeTarget.key, {
        binding: projection.binding, presentation, state: projection.state,
      }));
    },
  });
  const cancelChatOpen = chatOpen.cancel;
  const pendingChatOpenTerminalId = chatOpen.pendingTerminalId;
  const visibleAppAlert = appAlert || (chatOpen.notice?.type === 'error' ? chatOpen.notice : null);
  const restoringChat = Boolean(activeTarget && chatRestoreIntents.has(activeTarget.key));
  const chatControlLoading =
    (restoringChat &&
      !chatPresentationVisible(activeChatView?.presentation)) ||
    chatPresentationLoading(activeChatView?.presentation) ||
    pendingChatOpenTerminalId === activeTerminalSession?.terminalId;
  const activeChatControl = agentChatControlState(
    activePane,
    busy,
    chatControlLoading,
  );
  const followServerFocus = shouldFollowServerTerminalFocus(
    visible,
    activePane?.pane_id || null,
  );
  const chatVisible = chatPresentationVisible(activeChatView?.presentation) || restoringChat;
  const onChatSpeechError = useCallback((error: unknown) => {
    setAppAlert({ title: 'Could not read chat aloud', message: String(error) });
  }, []);
  useFocusedChatSpeech(
    visible && activeChatView && chatPresentationVisible(activeChatView.presentation) && activePane
      ? {
          agent: activeChatView.binding.agent,
          bindingToken: activeChatView.binding.bindingToken,
          hostId: hostSessionId,
          paneId: activePane.pane_id,
          label: chatAgentDisplayName(activeChatView.binding.agent),
        }
      : null,
    ttsEnabled,
    onChatSpeechError,
  );
  const chatViewportMounted = Boolean(
    activeChatView &&
      chatPresentationMountsViewport(activeChatView.presentation) &&
      agentTranscriptReadiness(activeChatView.state) === 'usable',
  );
  const chatViewportCandidates = [...chatViews.entries()]
    .filter(
      ([, view]) =>
        chatPresentationMountsViewport(view.presentation) &&
        agentTranscriptReadiness(view.state) === 'usable',
    )
    .map(([key, view]) => ({
      key,
      view,
      identity: JSON.stringify([
        key,
        view.binding.bindingToken,
        view.presentation.generation,
      ]),
    }));
  const activeChatKey =
    visible &&
    appActive &&
    activeTarget &&
    activeChatView &&
    chatPresentationRequested(activeChatView.presentation)
      ? activeTarget.key
      : null;
  const activeViewportIdentity =
    chatViewportCandidates.find(item => item.key === activeChatKey)?.identity ??
    null;
  const viewportRetention = useChatViewportRetention(
    chatViewportCandidates.map(item => item.identity),
    activeViewportIdentity,
  );
  const mountedChatViews = chatViewportCandidates.filter(item =>
    viewportRetention.retained.has(item.identity),
  );
  const chatSubscriptionIdentity = [...chatViews.entries()]
    .map(([key, view]) =>
      [key, view.binding.bindingToken, view.presentation.generation].join(':'),
    )
    .sort()
    .join('|');
  chatViewsRef.current = chatViews;

  useEffect(() => {
    if (!activeTerminalSession) return;
    const details = {
      agent: activeChatView?.binding.agent ?? activeChatControl?.agent,
      bindingToken: activeChatView
        ? agentChatDiagnosticToken(activeChatView.binding.bindingToken)
        : null,
      paneId: activePane?.pane_id,
      pendingOpen:
        pendingChatOpenTerminalId === activeTerminalSession.terminalId,
      phase: activeChatView?.presentation.phase ?? null,
      state: activeChatView?.state.status ?? null,
      stateRevision: activeChatView?.state.revision,
      terminalId: activeTerminalSession.terminalId,
      viewportMounted: chatViewportMounted,
      visible: chatVisible,
    };
    const fingerprint = JSON.stringify(details);
    if (lastActiveChatDiagnosticRef.current === fingerprint) return;
    lastActiveChatDiagnosticRef.current = fingerprint;
    recordAgentChatDiagnostic('active-presentation-projected', details);
  }, [
    activeChatControl?.agent,
    activeChatView,
    activePane?.pane_id,
    activeTerminalSession,
    chatViewportMounted,
    chatVisible,
    pendingChatOpenTerminalId,
  ]);
  const registerInteraction = (
    target: TerminalRenderTarget | null = activeTarget,
  ) => {
    if (!target || target.session.kind === 'ssh') return;
    const pane = selectableResources.panes.find(
      item => item.pane_id === target.session.paneId,
    );
    const interactionTabId = pane?.tab_id || selectedTab?.tab_id;
    if (interactionTabId) onInteraction(interactionTabId);
  };

  const closeActiveTunnel = () => {
    const previewId = tunnelPreviewRef.current;
    tunnelPreviewRef.current = null;
    if (previewId !== null) {
      bestEffortCleanup(
        client.native.stopPreview(previewId),
        'web-tunnel-close',
      );
    }
  };

  const scanTerminalLinks = () => {
    browserRequestRef.current += 1;
    setLinksOpen(true);
    setBrowserUrl(null);
    setTerminalLinks([]);
    setLinksError(null);
    setLinksBusy(true);
    closeActiveTunnel();
    setLinkScanRequest(value => value + 1);
  };

  const dismissLinks = () => {
    browserRequestRef.current += 1;
    setLinksOpen(false);
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    closeActiveTunnel();
  };

  const leaveBrowser = () => {
    browserRequestRef.current += 1;
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    setBrowserLoading(false);
    closeActiveTunnel();
  };

  const openTerminalLink = async (value: string) => {
    const request = ++browserRequestRef.current;
    setLinksBusy(true);
    setLinksError(null);
    try {
      closeActiveTunnel();
      const target = terminalWebLinkTarget(value);
      if (!terminalPreferences.openLinksInApp) {
        await Linking.openURL(target.url);
        return;
      }
      const tunnel = target.requiresSshTunnel
        ? await client.native.startWebPreview(target.url)
        : null;
      if (request !== browserRequestRef.current) {
        if (tunnel) {
          bestEffortCleanup(
            client.native.stopPreview(tunnel.id),
            'stale-web-tunnel-close',
          );
        }
        return;
      }
      if (tunnel) tunnelPreviewRef.current = tunnel.id;
      setBrowserDisplayUrl(target.url);
      setBrowserUrl(tunnel?.url || target.url);
      setBrowserCanGoBack(false);
      setBrowserLoading(true);
    } catch (reason) {
      if (request === browserRequestRef.current) setLinksError(String(reason));
    } finally {
      if (request === browserRequestRef.current) setLinksBusy(false);
    }
  };

  useEffect(
    () => () => {
      browserRequestRef.current += 1;
      const previewId = tunnelPreviewRef.current;
      tunnelPreviewRef.current = null;
      if (previewId !== null) {
        bestEffortCleanup(
          client.native.stopPreview(previewId),
          'web-tunnel-unmount',
        );
      }
    },
    [client],
  );

  useEffect(() => {
    pendingPaneFocus.current = null;
    lastActivePaneId.current = null;
    pendingFocus.current = null;
    setPendingCreatedSelection(null);
    browserRequestRef.current += 1;
    setEditorMode(null);
    setEditingPaneId(null);
    setAppAlert(null);
    setLinksOpen(false);
    setBrowserUrl(null);
    setBrowserCanGoBack(false);
    setBrowserLoading(false);
    setAttachmentsOpen(false);
    setPasteRequest(null);
    reportedChatFailureGenerationsRef.current.clear();
  }, [hostSessionId]);

  useEffect(() => {
    setPendingCreatedSelection(current =>
      reconcilePendingCreatedSelection(current, snapshot),
    );
  }, [snapshot]);

  const updateChatRestoreIntent = useCallback((key: string, transcriptKey?: string) => {
    const current = chatRestoreIntentsRef.current;
    if (current.get(key) === transcriptKey) return;
    const next = new Map(current);
    if (transcriptKey) next.set(key, transcriptKey);
    else next.delete(key);
    chatRestoreIntentsRef.current = next;
    setChatRestoreIntents(next);
  }, []);

  const onTerminalResidencyEnd: TerminalResidencyEnd = useCallback((target, reason) => {
    const terminalId = target.session.terminalId;
    const key = target.key;
    const view = chatViewsRef.current.get(key);
    if (reason === TerminalResidencyEndReason.Closed) updateChatRestoreIntent(key);
    if (!view) return;
    if (reason === TerminalResidencyEndReason.Evicted && chatPresentationRequested(view.presentation)) {
      updateChatRestoreIntent(key, view.binding.transcriptKey);
    }
    const next = new Map(chatViewsRef.current);
    next.delete(key);
    chatViewsRef.current = next;
    setChatViews(next);
    agentTranscriptService.closeTerminal(target.hostSessionId, terminalId, target.client.native);
  }, [updateChatRestoreIntent]);

  useEffect(() => {
    const activeId = visible ? activeTarget?.key : null;
    const targets = new Map(terminalTargets.map(target => [target.key, target]));
    const next = new Map(chatViewsRef.current);
    let changed = false;
    for (const key of chatRestoreIntentsRef.current.keys()) {
      const target = targets.get(key);
      if (!target || confirmedChatExit(target.client.native.hostState(), target.session.terminalId) ||
        next.get(key)?.presentation.phase === AgentChatPresentationPhase.Failed ||
        chatPresentationVisible(next.get(key)?.presentation)) {
        updateChatRestoreIntent(key);
      }
    }
    if (activeTarget && activeId && !next.has(activeId) && chatRestoreIntentsRef.current.has(activeId)) {
      const transcriptKey = chatRestoreIntentsRef.current.get(activeId);
      try {
        const projection = agentTranscriptService.activate(hostSessionId, activeTarget.session.terminalId, client.native);
        if (projection.type === 'bound') {
          if (projection.binding.transcriptKey === transcriptKey) {
            next.set(activeId, {
              binding: projection.binding,
              presentation: requestedChatPresentation(projection.state),
              state: projection.state,
            });
            changed = true;
          } else {
            updateChatRestoreIntent(activeId);
            agentTranscriptService.closeTerminal(hostSessionId, activeTarget.session.terminalId, client.native);
          }
        } else if (projection.reason !== 'host-state-unavailable') {
          updateChatRestoreIntent(activeId);
        }
      } catch (error) {
        // A reconnect can replace the native runtime between snapshots. Keep
        // the selection pending for the next host update, without its history.
        const failure = error instanceof Error ? error : new Error(String(error));
        reportBackgroundFailure(Promise.reject(failure), 'agent-chat-resume');
      }
    }
    if (changed) {
      chatViewsRef.current = next;
      setChatViews(next);
    }
  }, [visible, terminalState.activeTerminalId, terminalState.sessions, snapshot.panes,
    client, hostSessionId, requestedChatPresentation, updateChatRestoreIntent, activeTarget, terminalTargets, chatViews]);

  useEffect(() => {
    const targets = new Map(terminalTargets.map(target => [target.key, target]));
    const liveTerminalKeys = new Set(targets.keys());
    const projections = new Map<string, AgentChatProjection>();
    const reboundPresentations = new Map<string, AgentChatPresentation>();
    const exitedTerminalKeys = new Set<string>();
    for (const [key, view] of chatViewsRef.current) {
      const target = targets.get(key);
      if (!target) continue; // The residency callback owns cleanup of removed targets.
      const { client: targetClient, hostSessionId: targetHost, session } = target;
      let projection: AgentChatProjection;
      try {
        projection = agentTranscriptService.reconcile(
          targetHost, session.terminalId, targetClient.native,
        );
      } catch (error) {
        // Runtime replacement can race a snapshot/foreground notification.
        // Wait for the next authoritative projection; never fail Terminal.
        recordAgentChatDiagnostic('reconcile-unavailable', { error: String(error) });
        continue;
      }
      projections.set(key, projection);
      if (confirmedChatExit(targetClient.native.hostState(), session.terminalId)) {
        exitedTerminalKeys.add(key);
      }
      if (
        projection.type === 'bound' &&
        projection.binding.bindingToken !== view.binding.bindingToken &&
        chatPresentationRequested(view.presentation)
      ) {
        reboundPresentations.set(key, requestedChatPresentation(projection.state));
      }
    }
    // Terminal selection/rendering has already committed. Only the selected
    // resident Herdr target may establish a speculative binding; cache and
    // remote work continue independently inside the transcript service.
    const preloadTarget = visible && appActive && activeTarget &&
      activeTarget.session.kind !== 'ssh' && chatAgentForPane(activePane) &&
      !chatRestoreIntentsRef.current.has(activeTarget.key)
      ? activeTarget : null;
    const existing = preloadTarget && chatViewsRef.current.get(preloadTarget.key);
    const preload = preloadTarget &&
      projections.get(preloadTarget.key)?.type !== 'bound' &&
      (!existing || existing.presentation.phase === AgentChatPresentationPhase.Dormant ||
        existing.presentation.phase === AgentChatPresentationPhase.Warm)
      ? agentTranscriptService.preload(
          preloadTarget.hostSessionId, preloadTarget.session.terminalId, preloadTarget.client.native,
        )
      : null;
    setChatViews(current => {
      const next = reconcileAgentChatViews(
        current,
        liveTerminalKeys,
        projections,
        reboundPresentations,
        exitedTerminalKeys,
      );
      if (preloadTarget && preload?.type === 'bound') {
        return new Map(next).set(preloadTarget.key, {
          binding: preload.binding,
          state: preload.state,
          presentation: dormantChatPresentation(),
        });
      }
      return next;
    });
  }, [
    // Native state may change while JS is paused without a new pane snapshot.
    appActive,
    visible,
    activeTarget,
    activePane,
    client,
    hostSessionId,
    snapshot.panes,
    terminalState.sessions,
    terminalTargets,
    requestedChatPresentation,
  ]);

  useLayoutEffect(() => {
    const subscriptions = [...chatViewsRef.current.entries()].flatMap(
      ([key, view]) => {
        // The transcript service keeps receiving/caching updates for every
        // binding. Only the requested foreground viewport needs React updates.
        if (key !== activeChatKey) return [];
        const terminalId = view.binding.terminalId;
        const target = terminalTargets.find(item => item.key === key);
        if (!target) return [];
        return [
          agentTranscriptService.subscribe(view.binding.bindingToken, state => {
            const resetGeneration = nextChatPresentationGeneration();
            setChatViews(current => {
              const active = current.get(key);
              if (
                active?.binding.bindingToken !== view.binding.bindingToken ||
                active.state === state
              )
                return current;
              if (state === null) {
                if (confirmedChatExit(target.client.native.hostState(), terminalId)) {
                  const next = new Map(current);
                  next.delete(key);
                  return next;
                }
                return new Map(current).set(key, chatBindingLost(active, false));
              }
              const readiness = agentTranscriptReadiness(state);
              const nextPresentation = updateChatTranscriptReadiness(
                active.presentation,
                readiness,
                resetGeneration,
              );
              recordAgentChatDiagnostic('transcript-update-projected', {
                bindingToken: agentChatDiagnosticToken(
                  view.binding.bindingToken,
                ),
                fromPhase: active.presentation.phase,
                readiness,
                state: state.status,
                stateRevision: state.revision,
                terminalId,
                toPhase: nextPresentation.phase,
              });
              const next = new Map(current);
              next.set(key, {
                ...active,
                presentation: nextPresentation,
                state,
              });
              return next;
            });
          }),
        ];
      },
    );
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [
    activeChatKey,
    chatSubscriptionIdentity,
    nextChatPresentationGeneration,
    terminalTargets,
  ]);

  useEffect(() => {
    if (
      !visible || activeChatView?.presentation.phase !== AgentChatPresentationPhase.Failed
    )
      return;
    const generation = activeChatView.presentation.generation;
    if (reportedChatFailureGenerationsRef.current.has(generation)) return;
    reportedChatFailureGenerationsRef.current.add(generation);
    showAppAlert(
      `${
        chatAgentDisplayName(activeChatView.binding.agent)
      } history unavailable`,
      activeChatView.state.error ||
        'The transcript could not be loaded for this session.',
    );
  }, [
    activeTerminalSession?.terminalId,
    activeChatView,
    showAppAlert,
    visible,
  ]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending) {
      const previousStillPresent =
        snapshot.tabs.some(item => item.tab_id === pending.previousId) ||
        pendingCreatedSelection?.tab.tab_id === pending.previousId;
      const focusedServerWorkspace =
        snapshot.workspaces.find(item => item.focused) || workspace;
      const serverTabs = snapshot.tabs.filter(
        item => item.workspace_id === focusedServerWorkspace?.workspace_id,
      );
      const nextTab =
        serverTabs.find(item => item.focused) ||
        serverTabs.find(
          item => item.tab_id === focusedServerWorkspace?.active_tab_id,
        ) ||
        serverTabs[0];
      if (previousStillPresent) return;
      if (focusedServerWorkspace)
        setWorkspaceId(focusedServerWorkspace.workspace_id);
      setTabId(nextTab?.tab_id || '');
      pendingFocus.current = null;
      return;
    }
    if (workspace && workspace.workspace_id !== workspaceId)
      setWorkspaceId(workspace.workspace_id);
    if (selectedTab && selectedTab.tab_id !== tabId)
      setTabId(selectedTab.tab_id);
  }, [
    pendingCreatedSelection,
    selectedTab,
    snapshot.tabs,
    snapshot.workspaces,
    tabId,
    workspace,
    workspaceId,
  ]);

  // Follow server focus while hidden or before a usable local selection exists.
  // Once visible, keep the selected terminal stable while startup focus events settle.
  useEffect(() => {
    if (!followServerFocus || !serverWorkspaceId) return;
    if (!serverTabId) {
      if (pendingCreatedPaneId) return;
      pendingPaneFocus.current = null;
      setWorkspaceId(serverWorkspaceId);
      setTabId('');
      return;
    }
    if (
      !serverFocusMatchesPendingPane(
        serverPaneId,
        pendingCreatedPaneId || pendingPaneFocus.current,
      )
    )
      return;
    setWorkspaceId(serverWorkspaceId);
    setTabId(serverTabId);
  }, [
    followServerFocus,
    pendingCreatedPaneId,
    serverPaneId,
    serverTabId,
    serverWorkspaceId,
  ]);

  // Preserve an explicit terminal choice until Herdr confirms the same pane.
  useEffect(() => {
    if (!visible) {
      pendingPaneFocus.current = null;
      lastActivePaneId.current = null;
      return;
    }
    const activeSession = terminalState.sessions.find(
      item => item.terminalId === terminalState.activeTerminalId,
    );
    const activeSessionPane = snapshot.panes.find(
      item => item.pane_id === activeSession?.paneId,
    );
    if (
      !activeSessionPane ||
      activeSessionPane.pane_id === lastActivePaneId.current
    )
      return;
    lastActivePaneId.current = activeSessionPane.pane_id;
    pendingPaneFocus.current = activeSessionPane.pane_id;
    setWorkspaceId(activeSessionPane.workspace_id);
    setTabId(activeSessionPane.tab_id);
  }, [
    snapshot.panes,
    terminalState.activeTerminalId,
    terminalState.sessions,
    visible,
  ]);

  const activateServerPane = useEffectEvent((paneId: string) => {
    const pane = snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) onActivateTerminal(pane);
  });

  // Keep a hidden or uninitialized terminal aligned with the server-focused pane.
  useEffect(() => {
    if (!followServerFocus || !serverPaneId) return;
    if (
      !serverFocusMatchesPendingPane(
        serverPaneId,
        pendingCreatedPaneId || pendingPaneFocus.current,
      )
    )
      return;
    pendingPaneFocus.current = null;
    activateServerPane(serverPaneId);
  }, [followServerFocus, pendingCreatedPaneId, serverPaneId]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      return await runWithInFlightGuard(mutationInFlight, async () => {
        setBusy(true);
        try {
          await action();
        } finally {
          setBusy(false);
        }
      });
    } catch (error) {
      showHerdrError(error);
      return false;
    }
  };

  const chooseTab = (item: TabInfo) => {
    const nextPanes = selectableResources.panes.filter(
      pane => pane.tab_id === item.tab_id,
    );
    const nextPane = nextPanes.find(pane => pane.focused) || nextPanes[0];
    if (nextPane) terminalTabSelectionStarted(nextPane.terminal_id);
    setWorkspaceId(item.workspace_id);
    setTabId(item.tab_id);
    if (nextPane) onActivateTerminal(nextPane);
    reportBackgroundFailure(
      run(async () => {
        if (item.workspace_id !== workspace?.workspace_id) {
          await client.native.requestHerdrApi({
            method: 'workspace.focus',
            params: { workspace_id: item.workspace_id },
          });
        }
        await client.native.requestHerdrApi({
          method: 'tab.focus',
          params: { tab_id: item.tab_id },
        });
      }),
      'session-tab-focus',
    );
  };

  const tabNavigationContextRef = useRef({
    tabs,
    selectedTab,
  });
  tabNavigationContextRef.current = {
    tabs,
    selectedTab,
  };
  const chooseTabRef = useRef(chooseTab);
  chooseTabRef.current = chooseTab;

  const handleVolumeKey = useEffectEvent((key: TerminalVolumeKey) => {
    if (!visible) return;
    const configured =
      key === 'up'
        ? terminalPreferences.volumeUpAction
        : terminalPreferences.volumeDownAction;
    const action = resolveTerminalVolumeKeyAction(configured, key);
    if (action?.type !== 'terminal-tab') return;
    const context = tabNavigationContextRef.current;
    const currentIndex = context.tabs.findIndex(
      item => item.tab_id === context.selectedTab?.tab_id,
    );
    const targetTab = context.tabs[currentIndex + action.direction];
    if (targetTab) chooseTabRef.current(targetTab);
  });

  useEffect(() => {
    const subscription = addTerminalVolumeKeyListener(handleVolumeKey);
    return () => subscription.remove();
  }, []);

  const choosePane = (pane: PaneInfo) => {
    terminalTabSelectionStarted(pane.terminal_id);
    onActivateTerminal(pane);
    reportBackgroundFailure(
      run(() =>
        client.native.requestHerdrApi({
          method: 'pane.focus',
          params: { pane_id: pane.pane_id },
        }),
      ),
      'session-pane-focus',
    );
  };

  const create = async () => {
    if (mutationInFlight.current) return;
    let succeeded = true;
    if (editorMode === 'rename-tab' && selectedTab) {
      succeeded = await run(() =>
        client.native.requestHerdrApi({
          method: 'tab.rename',
          params: { tab_id: selectedTab.tab_id, label: name },
        }),
      );
    } else if (editorMode === 'rename-pane' && editingPaneId) {
      succeeded = await run(() =>
        client.native.requestHerdrApi({
          method: 'pane.rename',
          params: { pane_id: editingPaneId, label: name.trim() || null },
        }),
      );
    } else if (workspace) {
      pendingFocus.current = null;
      succeeded = await run(async () => {
        const created = await client.native.requestHerdrApi({
          method: 'tab.create',
          params: {
            workspace_id: workspace.workspace_id,
            label: name.trim() || null,
            focus: true,
          },
        });
        if (created.type !== 'tab_created') {
          throw new Error(`Unexpected tab.create result: ${created.type}`);
        }
        setPendingCreatedSelection(created);
        pendingPaneFocus.current = created.root_pane.pane_id;
        activateCreatedTabLocally(created, {
          select: (selectedWorkspaceId, createdTabId) => {
            setWorkspaceId(selectedWorkspaceId);
            setTabId(createdTabId);
          },
          terminalSelectionStarted: terminalTabSelectionStarted,
          activateTerminal: onActivateTerminal,
        });
      });
    }
    if (!succeeded) pendingFocus.current = null;
    setName('');
    setEditingPaneId(null);
    setEditorMode(null);
  };

  const openRenameTab = (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    if (item.tab_id !== selectedTab?.tab_id) chooseTab(item);
    setName(item.label);
    setEditingPaneId(null);
    setEditorMode('rename-tab');
  };

  const closeTab = async (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    // Herdr focuses a surviving tab after closing the current one.
    pendingPaneFocus.current = null;
    pendingFocus.current = { previousId: item.tab_id };
    if (
      !(await run(() =>
        client.native.requestHerdrApi({
          method: 'tab.close',
          params: { tab_id: item.tab_id },
        }),
      ))
    ) {
      pendingFocus.current = null;
    } else if (pendingCreatedSelection?.tab.tab_id === item.tab_id) {
      setPendingCreatedSelection(null);
    }
  };

  const openRenamePane = (pane: PaneInfo) => {
    if (pane.pane_id !== selectedPane?.pane_id) choosePane(pane);
    setName(pane.label || '');
    setEditingPaneId(pane.pane_id);
    setEditorMode('rename-pane');
  };

  const closePane = async (pane: PaneInfo) => {
    if (editingPaneId === pane.pane_id) {
      setEditingPaneId(null);
      setEditorMode(null);
    }
    await run(() =>
      client.native.requestHerdrApi({
        method: 'pane.close',
        params: { pane_id: pane.pane_id },
      }),
    );
  };

  const closeEditor = () => {
    setName('');
    setEditingPaneId(null);
    setEditorMode(null);
  };

  const openFileManager = () => {
    if (activeTerminalSession) onOpenFiles(activeTerminalSession.terminalId);
  };

  const openChatFile = (target: TranscriptFileLinkTarget) => {
    if (!activeTerminalSession || !activePane) return;
    const activeWorkspace = snapshot.workspaces.find(
      item => item.workspace_id === activePane.workspace_id,
    );
    const directory =
      activeChatView?.state.transcript.info?.directory ||
      activePane.foreground_cwd ||
      activePane.cwd ||
      activeWorkspace?.worktree?.checkout_path;
    onOpenFiles(activeTerminalSession.terminalId, {
      ...target,
      path: resolveTranscriptFilePath(target.path, directory || undefined),
    });
  };

  const openAttachments = () => {
    if (activeTerminalSession?.status !== 'connected') return;
    setAttachmentTerminalId(activeTerminalSession.terminalId);
    setAttachmentsOpen(true);
  };

  const closeActiveChat = useCallback(() => {
    const terminalId = activeTerminalSession?.terminalId;
    if (!terminalId) return;
    cancelChatOpen();
    if (!activeTarget) return;
    updateChatRestoreIntent(activeTarget.key);
    setChatViews(current => {
      const view = current.get(activeTarget.key);
      if (!view) return current;
      return new Map(current).set(activeTarget.key, {
        ...view, presentation: closeChatPresentation(view.presentation),
      });
    });
  }, [activeTerminalSession?.terminalId, activeTarget, cancelChatOpen, updateChatRestoreIntent]);

  const openAgentChat = () => {
    if (activeChatView && chatPresentationRequested(activeChatView.presentation)) return;
    if (activeTarget && activeChatView) {
      try {
        const projection = agentTranscriptService.reconcile(
          activeTarget.hostSessionId, activeTarget.session.terminalId, activeTarget.client.native,
        );
        if (projection.type === 'bound' && agentTranscriptReadiness(projection.state) !== 'failed') {
          const generation = nextChatPresentationGeneration();
          const presentation = requestChatPresentation(
            projection.binding.bindingToken === activeChatView.binding.bindingToken
              ? updateChatTranscriptReadiness(
                  activeChatView.presentation,
                  agentTranscriptReadiness(projection.state),
                  generation,
                )
              : dormantChatPresentation(),
            agentTranscriptReadiness(projection.state),
            generation,
          );
          setChatViews(current => new Map(current).set(activeTarget.key, {
            binding: projection.binding, state: projection.state, presentation,
          }));
          return;
        }
      } catch (error) {
        recordAgentChatDiagnostic('warm-binding-unavailable', { error: String(error) });
      }
    }
    return chatOpen.open();
  };

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      style={
        !visible && terminalPreferences.fullscreen && safeAreaInsets.top > 0
          ? { bottom: -safeAreaInsets.top }
          : undefined
      }
      className={cn(
        'flex-1 bg-terminal-canvas',
        !visible && 'absolute inset-0',
      )}
    >
      <TerminalBackground preferences={terminalPreferences} />
      <View
        className="absolute inset-x-0 z-30"
        style={{ bottom: terminalControlBarInset(safeAreaInsets.bottom) }}
      >
        <View
          accessibilityElementsHidden={!terminalSessionChromeVisible}
          importantForAccessibility={
            terminalSessionChromeVisible ? 'auto' : 'no-hide-descendants'
          }
          pointerEvents={terminalSessionChromeVisible ? 'auto' : 'none'}
          className="h-[55px] flex-row border-b border-border bg-transparent"
          style={terminalSessionChromeVisible ? undefined : { display: 'none' }}
        >
          <Button
            accessibilityLabel={t('session.backToHerd')}
            className={cn(
              'h-[55px] items-center justify-center rounded-none px-0 py-0',
              Platform.OS === 'ios' ? 'w-14' : 'w-[42px]',
            )}
            size="content"
            variant="ghost"
            onPress={hapticPress(onExit)}
          >
            <ChevronLeft
              size={Platform.OS === 'ios' ? 23 : 21}
              color={colors.text}
            />
          </Button>
          {workspace ? (
            <>
              <ScrollView
                className="min-w-0 flex-1"
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="items-center px-1.5 gap-[5px]"
              >
                {tabs.map(item => {
                  const active = item.tab_id === selectedTab?.tab_id;
                  const itemPanes = selectableResources.panes.filter(
                    pane => pane.tab_id === item.tab_id,
                  );
                  const itemSession = terminalState.sessions.find(session =>
                    itemPanes.some(
                      pane => pane.terminal_id === session.terminalId,
                    ),
                  );
                  const label = item.label || item.tab_id;
                  return (
                    <View
                      key={item.tab_id}
                      className={cn(
                        'h-11 max-w-[170px] flex-row items-center overflow-hidden rounded-full border',
                        isIpad && 'max-w-[230px]',
                      )}
                      style={sessionTabGlassStyle(active, colors)}
                    >
                      <Button
                        accessibilityLabel={t('session.openTab', {
                          tab: label,
                        })}
                        className={cn(
                          'h-11 min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1 active:bg-transparent active:opacity-70 dark:active:bg-transparent',
                          isIpad && 'px-3',
                        )}
                        variant="ghost"
                        onPress={hapticPress(() => chooseTab(item))}
                        onLongPress={hapticPress(() => openRenameTab(item))}
                      >
                        <AnimatedAgentStatusGlyph
                          status={item.agent_status}
                          color={sessionTabStatusColor(
                            item.agent_status,
                            itemSession?.status,
                            colors,
                          )}
                          size={isIpad ? 16 : 12}
                        />
                        <Text
                          numberOfLines={1}
                          className={cn(
                            'max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground',
                            isIpad && 'max-w-[140px] text-[14px] leading-5',
                            active && 'text-primary-foreground',
                          )}
                        >
                          {label}
                        </Text>
                        {item.pane_count > 1 && (
                          <Text
                            className={cn(
                              'font-mono text-[8px] text-muted-foreground',
                              isIpad && 'text-[11px]',
                              active && 'text-primary-foreground',
                            )}
                          >
                            {item.pane_count}
                          </Text>
                        )}
                      </Button>
                      <Button
                        accessibilityLabel={t('session.closeTab', {
                          tab: label,
                        })}
                        className="size-11 rounded-none px-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent"
                        variant="ghost"
                        onPress={hapticPress(() => closeTab(item))}
                      >
                        <X
                          size={isIpad ? 18 : 14}
                          color={
                            active ? colors.onPrimary : colors.textSecondary
                          }
                        />
                      </Button>
                    </View>
                  );
                })}
              </ScrollView>
              <Button
                accessibilityLabel={t('session.newTab')}
                className={cn(
                  'h-[55px] items-center justify-center rounded-none px-0 py-0',
                  Platform.OS === 'ios' ? 'w-14' : 'w-11',
                )}
                disabled={busy}
                size="content"
                variant="ghost"
                onPress={hapticPress(() => setEditorMode('tab'))}
              >
                <Plus
                  size={Platform.OS === 'ios' ? 23 : 16}
                  color={colors.text}
                />
              </Button>
            </>
          ) : activeTerminalSession?.kind === 'ssh' ? (
            <>
              <Text className="flex-1 self-center px-2 font-mono text-[11px] font-semibold text-foreground">
                {t('terminal.sshShell')}
              </Text>
              <Button
                accessibilityLabel={t('terminal.closeSession')}
                className="h-[55px] w-11 rounded-none px-0"
                variant="ghost"
                onPress={hapticPress(() =>
                  onCloseTerminal(activeTerminalSession.terminalId),
                )}
              >
                <X size={17} color={colors.text} />
              </Button>
            </>
          ) : null}
        </View>

        <ResourceEditorSheet
          busy={busy}
          context={editorContext}
          icon={SquareTerminal}
          onClose={closeEditor}
          onSave={create}
          title={editorTitle}
          visible={editorMode !== null}
        >
          <ResourceEditorField
            label={
              editorMode === 'rename-pane' ? t('pane.label') : t('herd.tabName')
            }
          >
            <Input
              accessibilityLabel={
                editorMode === 'rename-pane'
                  ? t('pane.label')
                  : t('herd.tabName')
              }
              autoFocus
              autoCorrect={false}
              editable={!busy}
              returnKeyType="done"
              selectTextOnFocus={editorMode?.startsWith('rename')}
              value={name}
              onChangeText={setName}
              onSubmitEditing={() => {
                reportBackgroundFailure(create(), 'session-resource-create');
              }}
              placeholder={
                editorMode === 'tab'
                  ? t('herd.tabNamePlaceholder')
                  : t('herd.labelOptional')
              }
              placeholderTextColor={colors.textTertiary}
            />
          </ResourceEditorField>
        </ResourceEditorSheet>

        {terminalSessionChromeVisible && selectedTab && panes.length > 1 && (
          <View className="h-11 flex-row border-b border-border bg-transparent">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="items-center px-1.5 gap-[5px]"
            >
              {panes.map(pane => {
                const active = pane.terminal_id === selectedPane?.terminal_id;
                const label =
                  pane.label || pane.display_agent || pane.agent || 'shell';
                return (
                  <View
                    key={pane.pane_id}
                    className="h-11 max-w-[174px] flex-row items-center overflow-hidden rounded-full border"
                    style={sessionTabGlassStyle(active, colors)}
                  >
                    <Button
                      accessibilityLabel={t('session.openPane', {
                        pane: label,
                      })}
                      className="h-11 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2 py-0"
                      variant="ghost"
                      onPress={hapticPress(() => choosePane(pane))}
                      onLongPress={hapticPress(() => openRenamePane(pane))}
                    >
                      <View
                        className="size-[5px] rounded-full"
                        style={{
                          backgroundColor: statusColor(
                            pane.agent_status,
                            colors,
                          ),
                        }}
                      />
                      <Text
                        numberOfLines={1}
                        className={cn(
                          'max-w-[112px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground',
                          active && 'text-primary-foreground',
                        )}
                      >
                        {label}
                      </Text>
                    </Button>
                    <Button
                      accessibilityLabel={t('session.closePane', {
                        pane: label,
                      })}
                      className="size-11 rounded-none px-0"
                      disabled={busy}
                      variant="ghost"
                      onPress={hapticPress(() => closePane(pane))}
                    >
                      <X
                        size={13}
                        color={active ? colors.onPrimary : colors.textSecondary}
                      />
                    </Button>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}
      </View>

      <View
        className="relative flex-1 overflow-hidden bg-transparent"
        onTouchStart={() => registerInteraction()}
      >
        <View pointerEvents="box-none" className="absolute inset-0">
          <TerminalScreen
            onResidencyEnd={onTerminalResidencyEnd}
            activeTarget={activeTarget}
            targets={terminalTargets}
            compact
            sessionChromeInset={sessionChromeInset}
            onSessionChromeVisibilityChange={setTerminalSessionChromeVisible}
            latencyMs={latencyMs}
            latencyWarningActive={latencyWarningActive}
            visible={visible && Boolean(activeTarget)}
            preferences={terminalPreferences}
            controlUsage={terminalControlUsage}
            historyEntries={terminalHistory}
            getComposerDraft={getComposerDraft}
            onComposerDraftChange={onComposerDraftChange}
            linkScanRequest={linkScanRequest}
            pasteRequest={
              pasteRequest &&
              pasteRequest.terminalId === activeTerminalSession?.terminalId
                ? {
                    id: pasteRequest.id,
                    text: pasteRequest.text,
                    previewUri: pasteRequest.previewUri,
                    dispose: pasteRequest.dispose,
                  }
                : undefined
            }
            onRequestAttachment={openAttachments}
            onRequestFiles={openFileManager}
            onRequestLinks={scanTerminalLinks}
            chatControl={
              activeChatControl
                ? {
                    accessibilityLabel: activeChatControl.loading
                      ? chatOpen.installing
                        ? `Installing ${chatAgentDisplayName(activeChatControl.agent)} integration`
                        : `Preparing ${
                            chatAgentDisplayName(activeChatControl.agent)
                          } Chat`
                      : chatVisible
                      ? 'Open Terminal view'
                      : `Open ${
                          chatAgentDisplayName(activeChatControl.agent)
                        } Chat view`,
                    active: chatVisible,
                    disabled: activeChatControl.disabled,
                    loading: activeChatControl.loading,
                    onPress: hapticPress(
                      chatVisible ? closeActiveChat : openAgentChat,
                    ),
                  }
                : undefined
            }
            chatViewEnabled={chatVisible}
            renderViewportOverlay={
              mountedChatViews.length
                ? (insets, latestButtonBottom) =>
                    mountedChatViews.map(
                      ({ key, view: chatView, identity }) => {
                        const selected = key === activeTarget?.key;
                        const active = key === activeChatKey;
                        const shown =
                          active &&
                          chatPresentationVisible(chatView.presentation);
                        const terminalId = chatView.binding.terminalId;
                        return (
                          <ScreenUpdates key={identity} active={active}>
                            {() => (
                              <View
                                key={key}
                                className="absolute inset-0"
                                style={{ opacity: shown ? 1 : 0 }}
                                pointerEvents={shown ? 'auto' : 'none'}
                                accessibilityElementsHidden={!shown}
                                importantForAccessibility={
                                  shown ? 'auto' : 'no-hide-descendants'
                                }
                              >
                                <AgentChatView
                                  key={[
                                    chatView.binding.bindingToken,
                                    chatView.presentation.generation,
                                  ].join(':')}
                                  state={chatView.state}
                                  active={active}
                                  savedViewport={viewportRetention.snapshots.get(
                                    identity,
                                  )}
                                  onSaveViewport={state =>
                                    viewportRetention.snapshots.set(
                                      identity,
                                      state,
                                    )
                                  }
                                  agent={chatView.binding.agent}
                                  agentStatus={
                                    selected && activePane
                                      ? activePane.agent_status
                                      : 'idle'
                                  }
                                  contentInsets={insets}
                                  latestButtonBottom={latestButtonBottom}
                                  onOpenFile={openChatFile}
                                  onInitialViewportReady={() => {
                                    const generation =
                                      chatView.presentation.generation;
                                    recordAgentChatDiagnostic(
                                      'initial-viewport-callback-received',
                                      {
                                        activeTerminalId:
                                          activeTerminalIdRef.current,
                                        bindingToken: agentChatDiagnosticToken(
                                          chatView.binding.bindingToken,
                                        ),
                                        generation,
                                        terminalId,
                                      },
                                    );
                                    setChatViews(current => {
                                      const view = current.get(key);
                                      if (
                                        view?.binding.bindingToken !==
                                          chatView.binding.bindingToken ||
                                        agentTranscriptReadiness(view.state) !==
                                          'usable'
                                      ) {
                                        recordAgentChatDiagnostic(
                                          'initial-viewport-callback-rejected',
                                          {
                                            reason:
                                              'binding-or-readiness-changed',
                                            terminalId,
                                          },
                                        );
                                        return current;
                                      }
                                      const presentation = revealPreparedChat(
                                        view.presentation,
                                        generation,
                                      );
                                      if (presentation === view.presentation)
                                        return current;
                                      recordAgentChatDiagnostic(
                                        'chat-open-visible',
                                        {
                                          bindingToken:
                                            agentChatDiagnosticToken(
                                              view.binding.bindingToken,
                                            ),
                                          generation,
                                          terminalId,
                                        },
                                      );
                                      const next = new Map(current);
                                      next.set(key, { ...view, presentation });
                                      return next;
                                    });
                                  }}
                                />
                              </View>
                            )}
                          </ScreenUpdates>
                        );
                      },
                    )
                : undefined
            }
            viewportOverlayBackground={
              chatVisible && appGlassEnabled ? (
                <AppBackground
                  uri={appBackgroundImageUri}
                  dimming={appBackgroundDimming}
                />
              ) : undefined
            }
            onOpenLink={link => {
              if (terminalPreferences.openLinksInApp) setLinksOpen(true);
              reportBackgroundFailure(
                openTerminalLink(link),
                'terminal-link-open',
              );
            }}
            onLinksScanned={links => {
              setTerminalLinks(links);
              setLinksBusy(false);
            }}
            onControlUse={onTerminalControlUse}
            onHistoryEntry={onTerminalHistoryEntry}
            onInteraction={registerInteraction}
            onFontSizeChange={(target, fontSize) => {
              onTerminalFontSizeChange(
                target.hostSessionId,
                target.session.terminalId,
                fontSize,
              );
            }}
            onClose={() => {
              if (activeTerminalSession)
                onCloseTerminal(activeTerminalSession.terminalId);
            }}
            onStatus={(target, status, error, reconnectAttempt) => {
              onTerminalStatus(
                target.hostSessionId,
                target.session.terminalId,
                status,
                error,
                reconnectAttempt,
              );
            }}
          />
        </View>
        {!activeTarget && !snapshot.server.running && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-black text-terminal-text">
              {t('session.serverUnavailable')}
            </Text>
            <Text className="mt-2 text-center text-terminal-muted">
              {t('session.serverUnavailableCopy')}
            </Text>
            <Button
              className="mt-5 rounded-full px-5"
              variant="secondary"
              onPress={hapticPress(onExit)}
            >
              <Text>{t('session.backToHerd')}</Text>
            </Button>
          </View>
        )}
        {!activeTarget && snapshot.server.running && !selectedTab && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-black text-terminal-text">
              {workspace
                ? t('session.emptyWorkspace')
                : t('session.noWorkspaces')}
            </Text>
            <Text className="mt-2 text-center text-terminal-muted">
              {workspace
                ? t('session.createTab')
                : t('session.createWorkspace')}
            </Text>
          </View>
        )}
        {!activeTarget &&
          snapshot.server.running &&
          selectedTab &&
          panes.length === 0 && (
            <View className="flex-1 items-center justify-center p-[30px]">
              <Text className="font-black text-terminal-text">
                {t('session.emptyTab')}
              </Text>
              <Text className="mt-2 text-center text-terminal-muted">
                {t('session.emptyTabCopy')}
              </Text>
            </View>
          )}
        <AttachmentPasteSheet
          client={client}
          visible={attachmentsOpen}
          onClose={() => setAttachmentsOpen(false)}
          onPaste={(attachment: PastedAttachment) => {
            if (!attachmentTerminalId) {
              attachment.dispose();
              return;
            }
            setPasteRequest(current => ({
              id: (current?.id || 0) + 1,
              terminalId: attachmentTerminalId,
              text: attachment.remotePath,
              previewUri: attachment.previewUri,
              dispose: attachment.dispose,
            }));
          }}
        />
        <AgentIntegrationInstallSheet
          integration={chatOpen.notice?.type === 'integration' ? chatOpen.notice.integration : null}
          onCancel={chatOpen.dismissNotice}
          onInstall={chatOpen.install}
        />
        <AgentIdentityWarningSheet
          warning={chatOpen.notice?.type === 'identity' ? chatOpen.notice : null}
          onClose={chatOpen.dismissNotice}
        />
        <Modal
          animationType="slide"
          onRequestClose={browserUrl ? leaveBrowser : dismissLinks}
          statusBarTranslucent
          visible={linksOpen}
        >
          <View
            className="flex-1 bg-background"
            style={{
              paddingTop: safeAreaInsets.top,
              paddingBottom: safeAreaInsets.bottom,
            }}
          >
            {browserUrl ? (
              <>
                <View className="h-12 flex-row items-center border-b border-border bg-background">
                  <Button
                    accessibilityLabel={t('terminal.browserBack')}
                    className="h-12 w-12 rounded-none px-0"
                    variant="ghost"
                    onPress={() =>
                      browserCanGoBack
                        ? browserWebView.current?.goBack()
                        : leaveBrowser()
                    }
                  >
                    <ChevronLeft size={21} color={colors.text} />
                  </Button>
                  <View className="min-w-0 flex-1 px-1">
                    <Text
                      numberOfLines={1}
                      className="text-[11px] font-semibold text-foreground"
                    >
                      {terminalWebLinkTarget(browserDisplayUrl).hostname}
                    </Text>
                    <Text
                      numberOfLines={1}
                      className="font-mono text-[8px] text-muted-foreground"
                    >
                      {browserDisplayUrl}
                    </Text>
                  </View>
                  <Button
                    accessibilityLabel={t('terminal.closeBrowser')}
                    className="h-12 w-12 rounded-none px-0"
                    variant="ghost"
                    onPress={dismissLinks}
                  >
                    <X size={19} color={colors.text} />
                  </Button>
                </View>
                <View className="relative flex-1 bg-white">
                  <WebView
                    ref={value => {
                      browserWebView.current = value;
                    }}
                    source={{ uri: browserUrl }}
                    javaScriptEnabled
                    onLoadStart={() => setBrowserLoading(true)}
                    onLoadEnd={() => setBrowserLoading(false)}
                    onNavigationStateChange={state =>
                      setBrowserCanGoBack(state.canGoBack)
                    }
                    style={BROWSER_WEBVIEW_STYLE}
                  />
                  {browserLoading && (
                    <View
                      pointerEvents="none"
                      className="absolute inset-x-0 top-0 items-center py-2"
                    >
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  )}
                </View>
              </>
            ) : (
              <>
                <View className="h-14 flex-row items-center border-b border-border px-4">
                  <View className="min-w-0 flex-1">
                    <Text className="text-[17px] font-bold text-foreground">
                      {t('terminal.linksTitle')}
                    </Text>
                    <Text className="text-[8px] uppercase tracking-[1px] text-muted-foreground">
                      {t('terminal.linksLatestFirst')}
                    </Text>
                  </View>
                  <Button
                    accessibilityLabel={t('terminal.closeLinks')}
                    className="size-11 rounded-full px-0"
                    variant="ghost"
                    onPress={dismissLinks}
                  >
                    <X size={19} color={colors.text} />
                  </Button>
                </View>
                <View className="min-h-[66px] flex-row items-center border-b border-border px-4 py-3">
                  <View className="min-w-0 flex-1 pr-4">
                    <Text className="text-[14px] font-semibold text-foreground">
                      {t('terminal.openLinksInApp')}
                    </Text>
                    <Text className="mt-0.5 text-[10px] leading-[14px] text-muted-foreground">
                      {t('terminal.openLinksInAppCopy')}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={t('terminal.openLinksInApp')}
                    checked={terminalPreferences.openLinksInApp}
                    onCheckedChange={onTerminalOpenLinksInAppChange}
                  />
                </View>
                {linksBusy ? (
                  <View className="flex-1 items-center justify-center gap-3 p-8">
                    <ActivityIndicator color={colors.primary} />
                    <Text className="text-[12px] text-muted-foreground">
                      {t('terminal.scanningLinks')}
                    </Text>
                  </View>
                ) : linksError ? (
                  <View className="flex-1 items-center justify-center p-8">
                    <Text className="text-center text-[13px] font-semibold text-destructive">
                      {t('terminal.linkOpenFailed')}
                    </Text>
                    <Text className="mt-2 text-center text-[9px] text-muted-foreground">
                      {linksError}
                    </Text>
                  </View>
                ) : terminalLinks.length ? (
                  <ScrollView
                    className="flex-1"
                    contentContainerClassName="px-4 py-2"
                  >
                    {terminalLinks.map((link, index) => {
                      const target = terminalWebLinkTarget(link);
                      return (
                        <Button
                          key={`${link}-${index}`}
                          className="h-auto min-h-[66px] flex-row justify-start gap-3 rounded-none border-b border-border px-0 py-3"
                          variant="ghost"
                          onPress={() => openTerminalLink(link)}
                        >
                          <View className="size-9 items-center justify-center rounded-full bg-muted">
                            <Globe2 size={17} color={colors.text} />
                          </View>
                          <View className="min-w-0 flex-1 items-start">
                            <View className="flex-row items-center gap-2">
                              <Text
                                numberOfLines={1}
                                className="max-w-[220px] text-[12px] font-bold text-foreground"
                              >
                                {target.hostname}
                              </Text>
                              {target.requiresSshTunnel && (
                                <Text className="rounded-full bg-primary px-2 py-0.5 font-mono text-[7px] font-black text-primary-foreground">
                                  {t('terminal.sshTunnel')}
                                </Text>
                              )}
                            </View>
                            <Text
                              numberOfLines={2}
                              className="mt-1 text-left font-mono text-[9px] leading-[13px] text-muted-foreground"
                            >
                              {link}
                            </Text>
                          </View>
                        </Button>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <View className="flex-1 items-center justify-center p-8">
                    <Globe2 size={28} color={colors.textSecondary} />
                    <Text className="mt-3 text-[14px] font-semibold text-foreground">
                      {t('terminal.noLinks')}
                    </Text>
                    <Text className="mt-1 text-center text-[11px] text-muted-foreground">
                      {t('terminal.noLinksCopy')}
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>
        </Modal>
      </View>
      <AppAlertPopup
        message={visibleAppAlert?.message}
        title={visibleAppAlert?.title || ''}
        visible={visibleAppAlert !== null}
        onClose={() => { setAppAlert(null); chatOpen.dismissNotice(); }}
      />
    </View>
  );
}
