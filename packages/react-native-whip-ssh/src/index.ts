import {
  AppConnectionStatus,
  AppCore as RustAppCore,
  ChatSpeechQueue as RustChatSpeechQueue,
  AgentDiagnosticSeverity,
  AgentMessageRole,
  AgentNoticeLevel,
  AgentIntegrationStatus,
  AgentToolStatus,
  AgentTranscriptKind,
  AgentChatOpenResult_Tags,
  AgentChatStartResult_Tags,
  AgentChatUnavailableReason,
  AgentTranscriptDelta_Tags,
  AgentTranscriptPart_Tags,
  AgentTranscriptStatus,
  AgentTurnStatus,
  HerdrControlRequest,
  HerdrControlResult_Tags,
  HerdrAgentSessionKind,
  HerdrAgentKind,
  HerdrAgentStatus,
  HerdrSplitDirection,
  HerdrTabLaunch,
  HerdrTabLaunchResult_Tags,
  HerdrTabLaunchStage,
  HerdrTerminalNotificationKind,
  HerdrTerminalControlEvent_Tags,
  HostConnectionState,
  HostAuthMode,
  HostProfileStore as RustHostProfileStore,
  KnownHostStore as RustKnownHostStore,
  HostFreshness,
  HostTerminalResizeOutcome,
  HostTerminalState,
  GitDiffKind,
  GitDiffRowKind,
  generateSshKeyPair as generateSshKeyPairRust,
  getSshKeyDetails as getSshKeyDetailsRust,
  PreviewKind,
  PreviewState,
  RemoteFileKind,
  SshErrorCode as NativeSshErrorCode,
  TransferState,
  TerminalKind,
  TerminalUiState,
  HostRuntimeEvent_Tags,
  HostSyncStatus,
  HostSshCredential,
  RuntimeDiagnosticOperation as NativeRuntimeDiagnosticOperation,
  RuntimeDiagnosticOutcome as NativeRuntimeDiagnosticOutcome,
  createHostRuntime as createHostRuntimeRust,
  pairHost as pairHostRust,
  setAgentTranscriptEventSink,
  setHerdrTerminalEventSink,
  setHostRuntimeEventSink,
  setTrustedHostKeys as setTrustedHostKeysRust,
  setKnownHosts as setKnownHostsRust,
  type HerdrControlResult,
  type HerdrAgentInfo,
  type HerdrAgentSessionInfo,
  type HerdrPaneInfo,
  type HerdrPaneLayoutRect,
  type HerdrPaneLayoutSnapshot,
  type HerdrPaneScrollInfo,
  type HerdrSessionSnapshot,
  type HerdrTabInfo,
  type HerdrTerminalControlEvent,
  type HerdrTerminalEventSink,
  type HerdrWorkspaceInfo,
  type HerdrWorkspaceWorktreeInfo,
  type HostRuntimeEvent,
  type HostRuntimeLike,
  type HostTerminalGeometry,
  type SshGeneratedKeyPair,
  type SshKeyDetails,
  type HostStateSnapshot,
  type HerdSessionMetadata as NativeHerdSessionMetadata,
  type HerdView as NativeHerdView,
  type HostProfileRecord as NativeHostProfileRecord,
  type HostProfileStoreLike,
  type HostProfileStoreView as NativeHostProfileStoreView,
  type HostKeyChallenge as NativeHostKeyChallenge,
  type KnownHostMutation as NativeKnownHostMutation,
  type KnownHostRecord as NativeKnownHostRecord,
  type KnownHostStoreLike,
  type KnownHostStoreView as NativeKnownHostStoreView,
  type HostLatencyMeasurement as NativeHostLatencyMeasurement,
  type RuntimeDiagnostic as NativeRuntimeDiagnostic,
  type GitDiff as NativeGitDiff,
  type GitStatusEntry as NativeGitStatusEntry,
  type PreviewInfo as NativePreviewInfo,
  type RemoteDirectoryListing as NativeRemoteDirectoryListing,
  type TransferProgress as NativeTransferProgress,
  type TransferResult as NativeTransferResult,
  type PairHostResult as NativePairHostResult,
  type AgentTranscriptEvent,
  type AgentChatBinding,
  type AgentTranscriptDelta,
  type AgentTranscriptMessage,
  type AgentTranscriptState,
  type AgentTranscriptTurn,
  type AppCoreLike,
  type AppCoreView as NativeAppCoreView,
} from './generated-entry';

export interface HerdrBridgeEvent {
  type:
    | 'terminal'
    | 'closed'
    | 'graphics'
    | 'notify'
    | 'clipboard'
    | 'title'
    | 'reload_sound_config'
    | 'mouse_capture'
    | 'kitty_keyboard_report_all'
    | 'prefix_input_source'
    | 'terminal_bell'
    | 'ignored';
  terminalId?: string;
  seq?: number;
  width?: number;
  height?: number;
  full?: boolean;
  bytes?: string | ArrayBuffer | ArrayBufferView;
  final?: boolean;
  text?: string;
  body?: string;
  flag?: boolean;
  kind?: number;
  count?: number;
  inboundTraceCookie?: number | null;
}

type BridgeEvent = HerdrBridgeEvent & { terminalId: string };
type BridgeHandler = (event: BridgeEvent) => void;
type WhipTerminalInboundTrace = {
  jsReceived: () => number | null;
  decodeComplete: (cookie: number | null) => void;
};

const bridgeHandlers = new Map<string, Map<string, BridgeHandler>>();
const runtimeHandlers = new Map<
  string,
  (event: RuntimeLifecycleEvent) => void
>();
const agentTranscriptHandlers = new Map<
  string,
  Map<string, (event: AgentTranscriptEvent) => boolean>
>();
const agentTranscriptRetentionVersions = new Map<string, number>();
const runtimeSshShellHandlers = new Map<
  string,
  Map<string, RuntimeSshShellHandler>
>();

function transcriptRoutingKey(
  runtimeId: string,
  runtimeIncarnation: number,
): string {
  return `${runtimeId}\n${runtimeIncarnation}`;
}

function runtimeConnectionState(
  state: HostConnectionState,
): RuntimeConnectionState {
  switch (state) {
    case HostConnectionState.Disconnected:
      return 'disconnected';
    case HostConnectionState.Connecting:
      return 'connecting';
    case HostConnectionState.Connected:
      return 'connected';
    case HostConnectionState.Reconnecting:
      return 'reconnecting';
    case HostConnectionState.Disconnecting:
      return 'disconnecting';
    case HostConnectionState.Failed:
      return 'failed';
  }
  throw new Error(`Unknown native host connection state: ${state}`);
}

function runtimeTerminalState(state: HostTerminalState): RuntimeTerminalState {
  switch (state) {
    case HostTerminalState.Opening:
      return 'opening';
    case HostTerminalState.Attached:
      return 'attached';
    case HostTerminalState.Restoring:
      return 'restoring';
    case HostTerminalState.Closed:
      return 'closed';
    case HostTerminalState.Failed:
      return 'failed';
  }
  throw new Error(`Unknown native terminal state: ${state}`);
}

function runtimeTerminalGeometry(
  value: HostTerminalGeometry,
): RuntimeTerminalGeometry {
  return {
    columns: value.columns,
    rows: value.rows,
    cellWidthPx: value.cellWidthPx,
    cellHeightPx: value.cellHeightPx,
  };
}

function runtimeTerminalResizeOutcome(
  value: HostTerminalResizeOutcome,
): RuntimeTerminalResizeOutcome {
  switch (value) {
    case HostTerminalResizeOutcome.Deferred:
      return 'deferred';
    case HostTerminalResizeOutcome.Deduplicated:
      return 'deduplicated';
    case HostTerminalResizeOutcome.Dispatched:
      return 'dispatched';
  }
}

export type NativeAgentFileDiff = {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
};

export type NativeAgentToolDiagnostic = {
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
};

export type NativeAgentToolState = {
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, string | number | boolean>;
  output?: string;
  error?: string;
  title?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  files: NativeAgentFileDiff[];
  diagnostics: NativeAgentToolDiagnostic[];
  loaded: string[];
};

export type NativeAgentTranscriptPart =
  | { type: 'text'; id: string; text: string; timestamp?: number }
  | { type: 'reasoning'; id: string; text: string; timestamp?: number }
  | { type: 'plan'; id: string; text: string; timestamp?: number }
  | {
      type: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
      timestamp?: number;
    }
  | {
      type: 'tool';
      id: string;
      callId: string;
      tool: string;
      timestamp?: number;
      state: NativeAgentToolState;
    };

export type NativeAgentTranscriptState = {
  sessionId: string;
  agent: 'codex' | 'opencode';
  revision: number;
  status: 'loading' | 'live' | 'stale' | 'unavailable' | 'error' | 'closed';
  info?: {
    id: string;
    title?: string;
    directory?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    parentId?: string;
    createdAt?: number;
    completedAt?: number;
    error?: string;
    parts: NativeAgentTranscriptPart[];
    diffs: NativeAgentFileDiff[];
  }>;
  turns: Array<{
    id: string;
    userMessageId?: string;
    assistantMessageIds: string[];
    status: 'idle' | 'working' | 'interrupted' | 'error';
    startedAt?: number;
    completedAt?: number;
    diffs: NativeAgentFileDiff[];
  }>;
  error?: string;
};

export type NativeAgentTranscriptMessage =
  NativeAgentTranscriptState['messages'][number];
export type NativeAgentTranscriptTurn =
  NativeAgentTranscriptState['turns'][number];
export type NativeAgentTranscriptInfo = NonNullable<
  NativeAgentTranscriptState['info']
>;

export type NativeAgentTranscriptDelta =
  | { type: 'reset'; state: NativeAgentTranscriptState }
  | { type: 'info-changed'; info?: NativeAgentTranscriptInfo }
  | {
      type: 'message-upserted';
      index: number;
      message: NativeAgentTranscriptMessage;
    }
  | { type: 'message-removed'; index: number; messageId: string }
  | { type: 'messages-truncated'; length: number }
  | { type: 'turn-upserted'; index: number; turn: NativeAgentTranscriptTurn }
  | { type: 'turns-truncated'; length: number }
  | {
      type: 'status-changed';
      status: NativeAgentTranscriptState['status'];
      error?: string;
    };

export type NativeAgentTranscriptUpdate = {
  runtimeIncarnation: number;
  key: string;
  revision: number;
  deltas: NativeAgentTranscriptDelta[];
  cacheWrite?: {
    namespace: string;
    key: string;
    blob: ArrayBuffer;
    confirmationToken: string;
  };
};

export type NativeAgentTranscriptRetention = {
  namespace: string;
  runtimeIncarnation: number;
  revision: number;
  retainedKeys: string[];
};

export type NativeAgentChatBinding = {
  runtimeIncarnation: number;
  bindingToken: string;
  bindingGeneration: number;
  terminalId: string;
  paneId: string;
  agent: 'codex' | 'opencode';
  sessionId: string;
  transcriptKey: string;
  state: NativeAgentTranscriptState;
};

export type NativeAgentChatOpenResult =
  | { type: 'bound'; binding: NativeAgentChatBinding }
  | {
      type: 'no-chat';
      terminalId: string;
      reason:
        | 'host-state-unavailable'
        | 'terminal-not-found'
        | 'unsupported-pane';
    };

export type NativeAgentChatStartResult =
  | { type: 'started'; state: NativeAgentTranscriptState }
  | { type: 'stale-binding' };

export type RuntimeSshConfig = {
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  secret: string;
  passphrase?: string;
  forwardAgent?: boolean;
};

export type RuntimeConfig = {
  runtimeId: string;
  ssh: RuntimeSshConfig;
  jumpHosts: RuntimeSshConfig[];
  sessionName: string;
  herdrCommand: string;
  socketPath?: string;
  cachedSocketPath?: string;
};

export type RuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

export type RuntimeAgentKind = 'claude' | 'codex' | 'opencode';

export type RuntimeTabLaunch =
  | { type: 'shell' }
  | { type: 'agent'; kind: RuntimeAgentKind; args?: string[] }
  | { type: 'command'; command: string };

export type RuntimeAgentIntegrationStatus =
  | 'not-installed'
  | 'current'
  | 'outdated'
  | 'needs-repair'
  | 'unknown';

export type RuntimeTabLaunchFailure = Error & {
  code: 'TAB_CREATION_FAILED' | 'TAB_LAUNCH_FAILED' | 'INVALID_TAB_LAUNCH';
  created?: RuntimeTabCreationResult;
  launchType?: 'agent' | 'command';
  nativeFailure?: unknown;
};
export type RuntimeTerminalState =
  | 'opening'
  | 'attached'
  | 'restoring'
  | 'closed'
  | 'failed';

export type RuntimeAgentStatusTransition = {
  paneId: string;
  previous?: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  current?: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  revision: number;
};

export type RuntimeLifecycleEvent =
  | {
      type: 'connection-state';
      state: RuntimeConnectionState;
      generation: number;
      reconnectAttempt: number;
      error?: string;
    }
  | {
      type: 'reconnect-scheduled';
      attempt: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'reconnected'; generation: number; restoredTerminals: number }
  | {
      type: 'terminal-state';
      terminalId: string;
      state: RuntimeTerminalState;
      reconnectAttempt: number;
      retrying: boolean;
      error?: string;
    }
  | {
      type: 'host-state';
      state: RuntimeHostState;
      agentStatusTransitions: RuntimeAgentStatusTransition[];
      transcriptRetention?: NativeAgentTranscriptRetention;
    }
  | { type: 'latency-measured'; measurement: RuntimeHostLatencyMeasurement }
  | { type: 'event-stream-closed'; reason: string }
  | { type: 'event-stream-restored'; generation: number }
  | { type: 'transfer-progress'; progress: RuntimeTransferProgress }
  | {
      type: 'preview-state';
      previewId: string;
      state: RuntimePreviewState;
      error?: string;
    }
  | { type: 'diagnostic'; diagnostic: RuntimeDiagnostic }
  | { type: 'fatal-error'; message: string };

export type RuntimeDiagnosticOperation =
  | 'ssh-connect'
  | 'ssh-reconnect'
  | 'ssh-reconnect-fast'
  | 'ssh-reconnect-persistent'
  | 'host-latency-probe'
  | 'herdr-request'
  | 'herdr-recovery'
  | 'terminal-attach'
  | 'terminal-recovery'
  | 'ssh-shell-recovery'
  | 'event-stream-recovery';

export type RuntimeDiagnostic = {
  operation: RuntimeDiagnosticOperation;
  durationMs: number;
  transportDurationMs?: number;
  outcome: 'started' | 'succeeded' | 'failed';
  terminalId?: string;
  error?: string;
};

export type RuntimeHostLatencyMeasurement = {
  sshRttMs: number;
  totalMs: number;
  runtimeOverheadMs: number;
};

export type RuntimeTransferState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type RuntimePreviewState = 'running' | 'disconnected' | 'stopped';
export type RuntimeRemoteFileKind = 'file' | 'directory' | 'symlink' | 'other';

export type RuntimeTransferProgress = {
  transferId: string;
  bytesTransferred: number;
  totalBytes?: number;
  state: RuntimeTransferState;
};

export type RuntimeTransferResult = {
  transferId: string;
  localPath?: string;
  remotePath?: string;
};

export type RuntimeTransfer = {
  id: string;
  result: Promise<RuntimeTransferResult>;
};

export type RuntimeRemoteFileEntry = {
  name: string;
  path: string;
  kind: RuntimeRemoteFileKind;
  size?: number;
  modifiedAt?: number;
  permissions?: number;
};

export type RuntimeRemoteDirectoryListing = {
  path: string;
  entries: RuntimeRemoteFileEntry[];
};

export type RuntimeGitRepository = { root: string; hasHead: boolean };
export type RuntimeGitStatusEntry = {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath: string | null;
  absolutePath: string;
};
export type RuntimeGitDiffRowKind =
  | 'header'
  | 'hunk'
  | 'context'
  | 'addition'
  | 'deletion'
  | 'meta';
export type RuntimeGitDiff = {
  kind: 'text' | 'binary' | 'empty';
  rows: Array<{
    key: string;
    kind: RuntimeGitDiffRowKind;
    content: string;
    marker: string;
    oldLine: number | null;
    newLine: number | null;
  }>;
  truncated: boolean;
};

export type RuntimePreviewInfo = {
  id: string;
  kind: 'web-forward' | 'html' | 'remote-file';
  state: RuntimePreviewState;
  url: string;
  displayUrl?: string;
};

export type RuntimeSshShellHandler = {
  data: (bytes: ArrayBuffer) => void;
  closed?: (reason: string) => void;
};

export type RuntimeTerminalGeometry = {
  columns: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
};

export type RuntimeTerminalResizeOutcome =
  | 'deferred'
  | 'deduplicated'
  | 'dispatched';

/** Stable app-facing DTOs projected from Rust's normalized Herdr domain model. */
export type WhipAgentStatus =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'unknown';

export type WhipAgentSessionInfo = {
  source: string;
  agent: string;
  kind: 'id' | 'path';
  value: string;
};

export type WhipPaneScrollInfo = {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
};

export type WhipWorkspaceWorktreeInfo = {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
};

export type WhipWorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: WhipAgentStatus;
  tokens?: Record<string, string>;
  worktree?: WhipWorkspaceWorktreeInfo;
};

export type WhipTabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: WhipAgentStatus;
};

export type WhipPaneInfo = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  display_agent?: string;
  agent_status: WhipAgentStatus;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  agent_session?: WhipAgentSessionInfo;
  scroll?: WhipPaneScrollInfo;
  revision: number;
};

export type WhipAgentInfo = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: WhipAgentStatus;
  revision: number;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  name?: string;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  display_agent?: string;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  screen_detection_skipped?: boolean;
  state_change_seq?: number;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  agent_session?: WhipAgentSessionInfo;
};

export type WhipPaneLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WhipPaneLayoutPane = {
  pane_id: string;
  focused: boolean;
  rect: WhipPaneLayoutRect;
};

export type WhipPaneLayoutSplit = {
  id: string;
  direction: 'right' | 'down';
  ratio: number;
  rect: WhipPaneLayoutRect;
};

export type WhipPaneLayoutSnapshot = {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: WhipPaneLayoutRect;
  focused_pane_id: string;
  panes: WhipPaneLayoutPane[];
  splits: WhipPaneLayoutSplit[];
};

export type WhipHostSnapshot = {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  agents: WhipAgentInfo[];
  workspaces: WhipWorkspaceInfo[];
  tabs: WhipTabInfo[];
  panes: WhipPaneInfo[];
  layouts: WhipPaneLayoutSnapshot[];
};

export type RuntimeHerdrRequest =
  | { method: 'ping' | 'session.snapshot'; params: Record<string, never> }
  | {
      method: 'workspace.create';
      params: { label: string | null; cwd: string | null; focus?: boolean };
    }
  | {
      method: 'workspace.focus' | 'workspace.close';
      params: { workspace_id: string };
    }
  | {
      method: 'workspace.rename';
      params: { workspace_id: string; label: string };
    }
  | {
      method: 'tab.create';
      params: { workspace_id: string; label: string | null; focus?: boolean };
    }
  | { method: 'tab.focus' | 'tab.close'; params: { tab_id: string } }
  | { method: 'tab.rename'; params: { tab_id: string; label: string } }
  | {
      method: 'pane.read';
      params: {
        pane_id: string;
        lines: number;
        source?: string;
        format?: string;
        strip_ansi?: boolean;
      };
    }
  | { method: 'pane.focus' | 'pane.close'; params: { pane_id: string } }
  | { method: 'pane.rename'; params: { pane_id: string; label: string | null } }
  | {
      method: 'pane.split';
      params: {
        target_pane_id: string;
        direction: 'right' | 'down';
        focus?: boolean;
      };
    }
  | { method: 'pane.zoom'; params: { pane_id: string; mode?: 'toggle' } }
  | {
      method: 'pane.send_input';
      params: { pane_id: string; text: string; keys: string[] };
    }
  | { method: 'pane.send_text'; params: { pane_id: string; text: string } }
  | { method: 'pane.send_keys'; params: { pane_id: string; keys: string[] } }
  | { method: 'agent.focus'; params: { target: string } }
  | { method: 'agent.prompt'; params: { target: string; text: string } };

export type RuntimeWorkspaceCreationResult = {
  type: 'workspace_created';
  workspace: WhipWorkspaceInfo;
  tab: WhipTabInfo;
  root_pane: WhipPaneInfo;
};

export type RuntimeTabCreationResult = {
  type: 'tab_created';
  tab: WhipTabInfo;
  root_pane: WhipPaneInfo;
};

export type RuntimeHerdrResult =
  | { type: 'pong'; version: string; protocol: number }
  | { type: 'session_snapshot'; snapshot: WhipHostSnapshot }
  | RuntimeWorkspaceCreationResult
  | { type: 'workspace_info'; workspace: WhipWorkspaceInfo }
  | RuntimeTabCreationResult
  | { type: 'tab_info'; tab: WhipTabInfo }
  | { type: 'pane_info'; pane: WhipPaneInfo }
  | { type: 'pane_read'; read: { text: string } }
  | { type: 'agent_started'; agent: WhipAgentInfo; argv: string[] }
  | { type: 'agent_info'; agent: WhipAgentInfo }
  | { type: 'agent_prompted'; agent: WhipAgentInfo }
  | {
      type: 'integration_install';
      target: RuntimeAgentKind;
      details: { messages: string[] };
    }
  | { type: 'pane_zoom' }
  | { type: 'ok' };

export type RuntimeHostState = {
  revision: number;
  connectionGeneration: number;
  syncGeneration: number;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  freshness: 'loading' | 'fresh' | 'stale' | 'unavailable';
  error?: string;
  lastSyncedAtMs?: number;
  lastEventAtMs?: number;
  needsResync: boolean;
  focus: { workspaceId?: string; tabId?: string; paneId?: string };
  snapshot?: WhipHostSnapshot;
};

export type AppSessionProjection = {
  id: string;
  hostId: string;
  connectionStatus:
    | 'connecting'
    | 'connected'
    | 'ready'
    | 'reconnecting'
    | 'disconnected'
    | 'error';
  connectionError?: string;
  reconnectAttempt: number;
  selection: {
    workspaceId?: string;
    tabId?: string;
    paneId?: string;
  };
  hostState?: RuntimeHostState;
  terminalRail: AppTerminalRailProjection;
};

export type AppTerminalEntryProjection = {
  terminalId: string;
  paneId: string;
  title: string;
  kind: 'herdr' | 'ssh';
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  reconnectAttempt: number;
};

export type AppTerminalRailProjection = {
  terminals: AppTerminalEntryProjection[];
  activeTerminalId?: string;
};

export type AppCoreProjection = {
  revision: number;
  sessions: AppSessionProjection[];
  activeSessionId?: string;
};

export type HerdSessionMetadata = NativeHerdSessionMetadata;

export type HerdHostProjection = {
  id: string;
  label: string;
  address: string;
  connected: boolean;
  running: boolean;
  refreshing: boolean;
  agentStatus: WhipAgentStatus;
  agents: WhipAgentInfo[];
  workspaces: WhipWorkspaceInfo[];
  tabs: WhipTabInfo[];
};

export type HerdAgentProjection = {
  hostId: string;
  hostLabel: string;
  agent: WhipAgentInfo;
  workspaceLabel: string;
  tabLabel: string;
  primaryLabel: string;
};

export type HerdProjection = {
  revision: number;
  selectedHostId?: string;
  selectedWorkspaceId?: string;
  hosts: HerdHostProjection[];
  agents: HerdAgentProjection[];
};

function herdProjection(value: NativeHerdView): HerdProjection {
  return {
    revision: Number(value.revision),
    selectedHostId: value.selectedHostId,
    selectedWorkspaceId: value.selectedWorkspaceId,
    hosts: value.hosts.map(host => ({
      id: host.id,
      label: host.label,
      address: host.address,
      connected: host.connected,
      running: host.running,
      refreshing: host.refreshing,
      agentStatus: agentStatus(host.agentStatus),
      agents: host.agents.map(agent),
      workspaces: host.workspaces.map(workspace),
      tabs: host.tabs.map(tab),
    })),
    agents: value.agents.map(item => ({
      hostId: item.hostId,
      hostLabel: item.hostLabel,
      agent: agent(item.agent),
      workspaceLabel: item.workspaceLabel,
      tabLabel: item.tabLabel,
      primaryLabel: item.primaryLabel,
    })),
  };
}

export type NativeHostProfile = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  jumpHostId?: string;
  forwardAgent: boolean;
  authMode: 'password' | 'key';
  herdrCommand: string;
  herdrSocketPath: string;
  sessionName: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
};

export type HostProfileStoreProjection = {
  revision: number;
  hosts: NativeHostProfile[];
  persistedValue: string;
};

function nativeHostProfile(value: NativeHostProfileRecord): NativeHostProfile {
  return {
    ...value,
    authMode: value.authMode === HostAuthMode.Key ? 'key' : 'password',
  };
}

function rustHostProfile(value: NativeHostProfile): NativeHostProfileRecord {
  return {
    ...value,
    authMode:
      value.authMode === 'key' ? HostAuthMode.Key : HostAuthMode.Password,
  };
}

function hostProfileStoreProjection(
  value: NativeHostProfileStoreView,
): HostProfileStoreProjection {
  return {
    revision: Number(value.revision),
    hosts: value.hosts.map(nativeHostProfile),
    persistedValue: value.persistedValue,
  };
}

export type KnownHostRecord = NativeKnownHostRecord;

export type KnownHostStoreView = {
  revision: number;
  hosts: KnownHostRecord[];
  persistedValue: string;
};

export type KnownHostMutation = {
  token: bigint;
  changed: boolean;
  view: KnownHostStoreView;
};

function knownHostStoreView(
  value: NativeKnownHostStoreView,
): KnownHostStoreView {
  return {
    revision: Number(value.revision),
    hosts: value.hosts,
    persistedValue: value.persistedValue,
  };
}

function knownHostMutation(value: NativeKnownHostMutation): KnownHostMutation {
  return {
    token: value.token,
    changed: value.changed,
    view: knownHostStoreView(value.view),
  };
}

function runtimeSshConfig(value: RuntimeSshConfig) {
  return {
    host: value.host,
    port: value.port,
    username: value.username,
    credential:
      value.authMode === 'password'
        ? HostSshCredential.Password.new({ password: value.secret })
        : HostSshCredential.Key.new({
            privateKey: value.secret,
            passphrase: value.passphrase,
          }),
    forwardAgent: Boolean(value.forwardAgent),
  };
}

function terminalInboundTrace(): WhipTerminalInboundTrace | undefined {
  return (
    globalThis as typeof globalThis & {
      __whipTerminalInboundTrace?: WhipTerminalInboundTrace;
    }
  ).__whipTerminalInboundTrace;
}

function bridgeHandler(
  clientKey: string,
  terminalId: string,
): BridgeHandler | undefined {
  return bridgeHandlers.get(clientKey)?.get(terminalId);
}

function setBridgeHandler(
  clientKey: string,
  terminalId: string,
  handler: BridgeHandler,
): void {
  let handlers = bridgeHandlers.get(clientKey);
  if (!handlers) {
    handlers = new Map();
    bridgeHandlers.set(clientKey, handlers);
  }
  handlers.set(terminalId, handler);
}

function removeBridgeHandler(
  clientKey: string,
  terminalId: string,
  expected?: BridgeHandler,
): void {
  const handlers = bridgeHandlers.get(clientKey);
  if (expected && handlers?.get(terminalId) !== expected) return;
  handlers?.delete(terminalId);
  if (handlers?.size === 0) bridgeHandlers.delete(clientKey);
}

function nativeErrorParts(error: unknown): { tag?: string; inner: unknown[] } {
  if (!isRecord(error)) return { inner: [] };
  return {
    tag: optionalString(error.tag),
    inner: isUnknownArray(error.inner) ? error.inner : [],
  };
}

function bridgeError(error: unknown): Error {
  const nativeError = nativeErrorParts(error);
  const message =
    typeof nativeError.inner[0] === 'string'
      ? nativeError.inner[0]
      : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrBridgeError';
  if (nativeError.tag) Object.assign(result, { code: nativeError.tag });
  return result;
}

function controlError(error: unknown): Error {
  const nativeError = nativeErrorParts(error);
  const protocolError = nativeError.tag === 'ProtocolError';
  const message =
    protocolError && typeof nativeError.inner[1] === 'string'
      ? nativeError.inner[1]
      : typeof nativeError.inner[0] === 'string'
      ? nativeError.inner[0]
      : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'HerdrControlError';
  const code =
    protocolError && typeof nativeError.inner?.[0] === 'string'
      ? nativeError.inner[0]
      : nativeError.tag;
  if (code) Object.assign(result, { code });
  return result;
}

const SSH_ERROR_CODES: Readonly<Partial<Record<number, string>>> = {
  [NativeSshErrorCode.AuthenticationFailed]: 'AUTHENTICATION_FAILED',
  [NativeSshErrorCode.HostKeyUnknown]: 'HOST_KEY_UNKNOWN',
  [NativeSshErrorCode.HostKeyChanged]: 'HOST_KEY_CHANGED',
  [NativeSshErrorCode.UnsupportedHostCertificate]:
    'UNSUPPORTED_HOST_CERTIFICATE',
  [NativeSshErrorCode.ConnectionRefused]: 'CONNECTION_REFUSED',
  [NativeSshErrorCode.ConnectionTimeout]: 'CONNECTION_TIMEOUT',
  [NativeSshErrorCode.HostUnreachable]: 'HOST_UNREACHABLE',
  [NativeSshErrorCode.ChannelUnavailable]: 'CHANNEL_UNAVAILABLE',
  [NativeSshErrorCode.SessionClosed]: 'SESSION_CLOSED',
  [NativeSshErrorCode.InvalidPrivateKey]: 'INVALID_PRIVATE_KEY',
  [NativeSshErrorCode.SftpFailure]: 'SFTP_FAILURE',
  [NativeSshErrorCode.InvalidRequest]: 'INVALID_REQUEST',
  [NativeSshErrorCode.Unknown]: 'UNKNOWN',
};

class HostRuntimeBridgeError extends Error {
  nativeTag?: string;
  code?: string;
  details?: unknown;
  expected?: string;
  received?: number;

  constructor(message: string) {
    super(message);
    this.name = 'HostRuntimeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function hostKeyErrorCode(tag: string | undefined): string | undefined {
  switch (tag) {
    case undefined:
      return undefined;
    case 'HostKeyUnknown':
      return 'HOST_KEY_UNKNOWN';
    case 'HostKeyChanged':
      return 'HOST_KEY_CHANGED';
    case 'UnsupportedHostCertificate':
      return 'UNSUPPORTED_HOST_CERTIFICATE';
    default:
      return undefined;
  }
}

function hostRuntimeMessage(
  error: unknown,
  inner: unknown,
  hostKeyCode: string | undefined,
  expected: string | undefined,
  received: number | undefined,
  lastReadinessError: string | undefined,
  sshFailureMessage: string | undefined,
): string {
  if (hostKeyCode === 'HOST_KEY_UNKNOWN') return 'unknown SSH host key';
  if (hostKeyCode === 'HOST_KEY_CHANGED') return 'SSH host key changed';
  if (hostKeyCode === 'UNSUPPORTED_HOST_CERTIFICATE') {
    return 'SSH host certificates are not supported';
  }
  if (expected !== undefined && received !== undefined) {
    return `Herdr protocol mismatch: Whip supports ${expected}, server reports ${received}`;
  }
  if (lastReadinessError)
    return `Herdr did not become ready: ${lastReadinessError}`;
  if (sshFailureMessage) return sshFailureMessage;
  if (Array.isArray(inner) && typeof inner[0] === 'string') return inner[0];
  return error instanceof Error ? error.message : String(error);
}

function hostRuntimeError(error: unknown): HostRuntimeBridgeError {
  const nativeError = isRecord(error) ? error : {};
  const tag = optionalString(nativeError.tag);
  const inner = nativeError.inner;
  const hostKeyCode = hostKeyErrorCode(tag);
  const structuredInner = isRecord(inner) ? inner : undefined;
  const expected =
    tag === 'HerdrProtocolMismatch' &&
    typeof structuredInner?.expected === 'string'
      ? structuredInner.expected
      : undefined;
  const received =
    tag === 'HerdrProtocolMismatch' &&
    typeof structuredInner?.received === 'number'
      ? structuredInner.received
      : undefined;
  const lastReadinessError =
    tag === 'HerdrReadinessTimeout' &&
    typeof structuredInner?.lastError === 'string'
      ? structuredInner.lastError
      : undefined;
  const sshFailureMessage =
    tag === 'SshConnectionFailure' &&
    typeof structuredInner?.message === 'string'
      ? structuredInner.message
      : undefined;
  const sshFailureCode =
    tag === 'SshConnectionFailure' && typeof structuredInner?.code === 'number'
      ? SSH_ERROR_CODES[structuredInner.code]
      : undefined;
  const details =
    (hostKeyCode === 'HOST_KEY_UNKNOWN' ||
      hostKeyCode === 'HOST_KEY_CHANGED') &&
    isUnknownArray(inner)
      ? inner[0]
      : undefined;
  const message = hostRuntimeMessage(
    error,
    inner,
    hostKeyCode,
    expected,
    received,
    lastReadinessError,
    sshFailureMessage,
  );
  const result = new HostRuntimeBridgeError(message);
  if (tag) result.nativeTag = tag;
  if (sshFailureCode) {
    result.code = sshFailureCode;
  } else if (tag === 'AuthenticationFailure') {
    result.code = 'AUTHENTICATION_FAILED';
  } else if (hostKeyCode) {
    result.code = hostKeyCode;
    if (details) result.details = details;
  } else if (tag === 'HerdrUnavailable') {
    result.code = 'HERDR_UNAVAILABLE';
  } else if (tag === 'TransferCancelled') {
    result.code = 'TRANSFER_CANCELLED';
  } else if (tag === 'HerdrProtocolMismatch') {
    result.code = 'HERDR_PROTOCOL_MISMATCH';
    result.expected = expected;
    result.received = received;
  } else if (tag === 'HerdrReadinessTimeout') {
    result.code = 'HERDR_READINESS_TIMEOUT';
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function runtimeAgentKind(kind: RuntimeAgentKind): HerdrAgentKind {
  switch (kind) {
    case 'claude':
      return HerdrAgentKind.Claude;
    case 'codex':
      return HerdrAgentKind.Codex;
    case 'opencode':
      return HerdrAgentKind.OpenCode;
  }
}

function nativeNumber(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function nativeRequiredNumber(value: number | bigint): number {
  return typeof value === 'number' ? value : Number(value);
}

function nativeAgentStatus(
  value: AgentTranscriptStatus,
): NativeAgentTranscriptState['status'] {
  switch (value) {
    case AgentTranscriptStatus.Loading:
      return 'loading';
    case AgentTranscriptStatus.Live:
      return 'live';
    case AgentTranscriptStatus.Stale:
      return 'stale';
    case AgentTranscriptStatus.Unavailable:
      return 'unavailable';
    case AgentTranscriptStatus.Error:
      return 'error';
    case AgentTranscriptStatus.Closed:
      return 'closed';
  }
}

function nativeToolStatus(
  value: AgentToolStatus,
): 'pending' | 'running' | 'completed' | 'error' {
  switch (value) {
    case AgentToolStatus.Pending:
      return 'pending';
    case AgentToolStatus.Running:
      return 'running';
    case AgentToolStatus.Completed:
      return 'completed';
    case AgentToolStatus.Error:
      return 'error';
  }
}

function nativeDiagnosticSeverity(
  value: AgentDiagnosticSeverity,
): NativeAgentToolDiagnostic['severity'] {
  switch (value) {
    case AgentDiagnosticSeverity.Error:
      return 'error';
    case AgentDiagnosticSeverity.Warning:
      return 'warning';
    case AgentDiagnosticSeverity.Info:
      return 'info';
    case AgentDiagnosticSeverity.Hint:
      return 'hint';
  }
}

function nativeAgentPart(
  part: AgentTranscriptState['messages'][number]['parts'][number],
): NativeAgentTranscriptPart {
  switch (part.tag) {
    case AgentTranscriptPart_Tags.Text: {
      const inner = part.inner as {
        id: string;
        text: string;
        timestampMs?: bigint;
      };
      return {
        type: 'text',
        id: inner.id,
        text: inner.text,
        timestamp: nativeNumber(inner.timestampMs),
      };
    }
    case AgentTranscriptPart_Tags.Reasoning: {
      const inner = part.inner as {
        id: string;
        text: string;
        timestampMs?: bigint;
      };
      return {
        type: 'reasoning',
        id: inner.id,
        text: inner.text,
        timestamp: nativeNumber(inner.timestampMs),
      };
    }
    case AgentTranscriptPart_Tags.Plan: {
      const inner = part.inner as {
        id: string;
        text: string;
        timestampMs?: bigint;
      };
      return {
        type: 'plan',
        id: inner.id,
        text: inner.text,
        timestamp: nativeNumber(inner.timestampMs),
      };
    }
    case AgentTranscriptPart_Tags.Notice: {
      const inner = part.inner as {
        id: string;
        level: AgentNoticeLevel;
        text: string;
        timestampMs?: bigint;
      };
      return {
        type: 'notice',
        id: inner.id,
        text: inner.text,
        timestamp: nativeNumber(inner.timestampMs),
        level:
          inner.level === AgentNoticeLevel.Warning
            ? 'warning'
            : inner.level === AgentNoticeLevel.Error
            ? 'error'
            : 'info',
      };
    }
    case AgentTranscriptPart_Tags.Tool: {
      const inner = part.inner;
      const input: Record<string, string | number | boolean> = {};
      for (const field of inner.state.input)
        input[field.key] = field.value.inner.value;
      return {
        type: 'tool',
        id: inner.id,
        callId: inner.callId,
        tool: inner.tool,
        timestamp: nativeNumber(inner.timestampMs),
        state: {
          status: nativeToolStatus(inner.state.status),
          input,
          output: inner.state.output,
          error: inner.state.error,
          title: inner.state.title,
          startedAt: nativeNumber(inner.state.startedAtMs),
          completedAt: nativeNumber(inner.state.completedAtMs),
          exitCode:
            inner.state.exitCode === undefined
              ? undefined
              : Number(inner.state.exitCode),
          files: inner.state.files.map(file => ({ ...file })),
          diagnostics: inner.state.diagnostics.map(diagnostic => ({
            file: diagnostic.file,
            line: diagnostic.line,
            column: diagnostic.column,
            message: diagnostic.message,
            severity: nativeDiagnosticSeverity(diagnostic.severity),
          })),
          loaded: [...inner.state.loaded],
        },
      };
    }
  }
}

function nativeAgentInfo(
  value: NonNullable<AgentTranscriptState['info']>,
): NativeAgentTranscriptInfo {
  return {
    id: value.id,
    title: value.title,
    directory: value.directory,
    createdAt: nativeNumber(value.createdAtMs),
    updatedAt: nativeNumber(value.updatedAtMs),
  };
}

function nativeAgentMessage(
  message: AgentTranscriptMessage,
): NativeAgentTranscriptMessage {
  return {
    id: message.id,
    role: message.role === AgentMessageRole.Assistant ? 'assistant' : 'user',
    parentId: message.parentId,
    createdAt: nativeNumber(message.createdAtMs),
    completedAt: nativeNumber(message.completedAtMs),
    error: message.error,
    parts: message.parts.map(nativeAgentPart),
    diffs: message.diffs.map(file => ({ ...file })),
  };
}

function nativeAgentTurn(turn: AgentTranscriptTurn): NativeAgentTranscriptTurn {
  return {
    id: turn.id,
    userMessageId: turn.userMessageId,
    assistantMessageIds: [...turn.assistantMessageIds],
    status:
      turn.status === AgentTurnStatus.Working
        ? 'working'
        : turn.status === AgentTurnStatus.Interrupted
        ? 'interrupted'
        : turn.status === AgentTurnStatus.Error
        ? 'error'
        : 'idle',
    startedAt: nativeNumber(turn.startedAtMs),
    completedAt: nativeNumber(turn.completedAtMs),
    diffs: turn.diffs.map(file => ({ ...file })),
  };
}

function nativeAgentTranscript(
  value: AgentTranscriptState,
): NativeAgentTranscriptState {
  return {
    sessionId: value.sessionId,
    agent: value.agent === AgentTranscriptKind.OpenCode ? 'opencode' : 'codex',
    revision: Number(value.revision),
    status: nativeAgentStatus(value.status),
    info: value.info ? nativeAgentInfo(value.info) : undefined,
    messages: value.messages.map(nativeAgentMessage),
    turns: value.turns.map(nativeAgentTurn),
    error: value.error,
  };
}

function nativeAgentChatBinding(
  value: AgentChatBinding,
): NativeAgentChatBinding {
  return {
    runtimeIncarnation: Number(value.runtimeIncarnation),
    bindingToken: value.bindingToken,
    bindingGeneration: Number(value.bindingGeneration),
    terminalId: value.terminalId,
    paneId: value.paneId,
    agent: value.agent === AgentTranscriptKind.OpenCode ? 'opencode' : 'codex',
    sessionId: value.sessionId,
    transcriptKey: value.transcriptKey,
    state: nativeAgentTranscript(value.state),
  };
}

function nativeAgentChatUnavailableReason(
  value: AgentChatUnavailableReason,
): Extract<NativeAgentChatOpenResult, { type: 'no-chat' }>['reason'] {
  switch (value) {
    case AgentChatUnavailableReason.HostStateUnavailable:
      return 'host-state-unavailable';
    case AgentChatUnavailableReason.TerminalNotFound:
      return 'terminal-not-found';
    case AgentChatUnavailableReason.UnsupportedPane:
      return 'unsupported-pane';
  }
  throw new Error(`Unknown native agent Chat unavailable reason: ${value}`);
}

function nativeAgentDelta(
  delta: AgentTranscriptDelta,
): NativeAgentTranscriptDelta {
  switch (delta.tag) {
    case AgentTranscriptDelta_Tags.Reset:
      return { type: 'reset', state: nativeAgentTranscript(delta.inner.state) };
    case AgentTranscriptDelta_Tags.InfoChanged:
      return {
        type: 'info-changed',
        info: delta.inner.info ? nativeAgentInfo(delta.inner.info) : undefined,
      };
    case AgentTranscriptDelta_Tags.MessageUpserted:
      return {
        type: 'message-upserted',
        index: delta.inner.index,
        message: nativeAgentMessage(delta.inner.message),
      };
    case AgentTranscriptDelta_Tags.MessageRemoved:
      return {
        type: 'message-removed',
        index: delta.inner.index,
        messageId: delta.inner.messageId,
      };
    case AgentTranscriptDelta_Tags.MessagesTruncated:
      return { type: 'messages-truncated', length: delta.inner.length };
    case AgentTranscriptDelta_Tags.TurnUpserted:
      return {
        type: 'turn-upserted',
        index: delta.inner.index,
        turn: nativeAgentTurn(delta.inner.turn),
      };
    case AgentTranscriptDelta_Tags.TurnsTruncated:
      return { type: 'turns-truncated', length: delta.inner.length };
    case AgentTranscriptDelta_Tags.StatusChanged:
      return {
        type: 'status-changed',
        status: nativeAgentStatus(delta.inner.status),
        error: delta.inner.error,
      };
  }
}

function nativeAgentUpdate(
  event: AgentTranscriptEvent,
): NativeAgentTranscriptUpdate {
  return {
    runtimeIncarnation: Number(event.runtimeIncarnation),
    key: event.key,
    revision: Number(event.update.revision),
    deltas: event.update.deltas.map(nativeAgentDelta),
    cacheWrite: event.cacheWrite
      ? {
          namespace: event.cacheWrite.namespace,
          key: event.cacheWrite.key,
          blob: event.cacheWrite.blob,
          confirmationToken: event.cacheWrite.confirmationToken,
        }
      : undefined,
  };
}

function splitDirection(value: unknown): HerdrSplitDirection {
  if (value === 'right') return HerdrSplitDirection.Right;
  if (value === 'down') return HerdrSplitDirection.Down;
  throw new Error('pane split direction must be right or down');
}

function splitDirectionString(value: HerdrSplitDirection): 'right' | 'down' {
  return value === HerdrSplitDirection.Down ? 'down' : 'right';
}

function agentStatus(
  value: HerdrAgentStatus,
): 'idle' | 'working' | 'blocked' | 'done' | 'unknown' {
  switch (value) {
    case HerdrAgentStatus.Idle:
      return 'idle';
    case HerdrAgentStatus.Working:
      return 'working';
    case HerdrAgentStatus.Blocked:
      return 'blocked';
    case HerdrAgentStatus.Done:
      return 'done';
    case HerdrAgentStatus.Unknown:
      return 'unknown';
  }
}

function agentSessionKind(value: HerdrAgentSessionKind): 'id' | 'path' {
  return value === HerdrAgentSessionKind.Path ? 'path' : 'id';
}

function terminalNotificationKind(
  value: HerdrTerminalNotificationKind,
): 0 | 1 | 2 {
  switch (value) {
    case HerdrTerminalNotificationKind.Sound:
      return 0;
    case HerdrTerminalNotificationKind.Toast:
      return 1;
    case HerdrTerminalNotificationKind.SystemToast:
      return 2;
  }
}

function controlRequest(request: RuntimeHerdrRequest): HerdrControlRequest {
  const params: Record<string, unknown> = { ...request.params };
  const text = (key: string): string => {
    const value = params[key];
    return typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
      ? String(value)
      : '';
  };
  switch (request.method) {
    case 'ping':
      return HerdrControlRequest.Ping.new();
    case 'session.snapshot':
      return HerdrControlRequest.SessionSnapshot.new();
    case 'workspace.create':
      return HerdrControlRequest.WorkspaceCreate.new({
        label: optionalString(params.label),
        cwd: optionalString(params.cwd),
      });
    case 'workspace.focus':
      return HerdrControlRequest.WorkspaceFocus.new({
        workspaceId: text('workspace_id'),
      });
    case 'workspace.rename':
      return HerdrControlRequest.WorkspaceRename.new({
        workspaceId: text('workspace_id'),
        label: text('label'),
      });
    case 'workspace.close':
      return HerdrControlRequest.WorkspaceClose.new({
        workspaceId: text('workspace_id'),
      });
    case 'tab.create':
      return HerdrControlRequest.TabCreate.new({
        workspaceId: text('workspace_id'),
        label: optionalString(params.label),
      });
    case 'tab.focus':
      return HerdrControlRequest.TabFocus.new({ tabId: text('tab_id') });
    case 'tab.rename':
      return HerdrControlRequest.TabRename.new({
        tabId: text('tab_id'),
        label: text('label'),
      });
    case 'tab.close':
      return HerdrControlRequest.TabClose.new({ tabId: text('tab_id') });
    case 'pane.read':
      return HerdrControlRequest.PaneRead.new({
        paneId: text('pane_id'),
        lines: Number(params.lines),
      });
    case 'pane.focus':
      return HerdrControlRequest.PaneFocus.new({ paneId: text('pane_id') });
    case 'pane.rename':
      return HerdrControlRequest.PaneRename.new({
        paneId: text('pane_id'),
        label: optionalString(params.label),
      });
    case 'pane.split':
      return HerdrControlRequest.PaneSplit.new({
        paneId: text('target_pane_id'),
        direction: splitDirection(params.direction),
      });
    case 'pane.zoom':
      return HerdrControlRequest.PaneZoom.new({ paneId: text('pane_id') });
    case 'pane.close':
      return HerdrControlRequest.PaneClose.new({ paneId: text('pane_id') });
    case 'pane.send_input':
      return HerdrControlRequest.PaneSendInput.new({
        paneId: text('pane_id'),
        text: text('text'),
        keys: stringArray(params.keys),
      });
    case 'pane.send_text':
      return HerdrControlRequest.PaneSendText.new({
        paneId: text('pane_id'),
        text: text('text'),
      });
    case 'pane.send_keys':
      return HerdrControlRequest.PaneSendKeys.new({
        paneId: text('pane_id'),
        keys: stringArray(params.keys),
      });
    case 'agent.focus':
      return HerdrControlRequest.AgentFocus.new({ target: text('target') });
    case 'agent.prompt':
      return HerdrControlRequest.AgentPrompt.new({
        target: text('target'),
        text: text('text'),
      });
    default:
      throw new Error('Unsupported Herdr API method');
  }
}

function stringRecord(
  value: Map<string, string> | undefined,
): Record<string, string> | undefined {
  return value ? Object.fromEntries(value) : undefined;
}

function agentSession(
  value: HerdrAgentSessionInfo | undefined,
): WhipAgentSessionInfo | undefined {
  return (
    value && {
      source: value.source,
      agent: value.agent,
      kind: agentSessionKind(value.kind),
      value: value.value,
    }
  );
}

function paneScroll(
  value: HerdrPaneScrollInfo | undefined,
): WhipPaneScrollInfo | undefined {
  return (
    value && {
      offset_from_bottom: value.offsetFromBottom,
      max_offset_from_bottom: value.maxOffsetFromBottom,
      viewport_rows: value.viewportRows,
    }
  );
}

function workspaceWorktree(
  value: HerdrWorkspaceWorktreeInfo | undefined,
): WhipWorkspaceWorktreeInfo | undefined {
  return (
    value && {
      repo_key: value.repoKey,
      repo_name: value.repoName,
      repo_root: value.repoRoot,
      checkout_path: value.checkoutPath,
      is_linked_worktree: value.isLinkedWorktree,
    }
  );
}

function workspace(value: HerdrWorkspaceInfo): WhipWorkspaceInfo {
  return {
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    tab_count: value.tabCount,
    active_tab_id: value.activeTabId,
    agent_status: agentStatus(value.agentStatus),
    tokens: stringRecord(value.tokens),
    worktree: workspaceWorktree(value.worktree),
  };
}

function tab(value: HerdrTabInfo): WhipTabInfo {
  return {
    tab_id: value.tabId,
    workspace_id: value.workspaceId,
    number: value.number,
    label: value.label,
    focused: value.focused,
    pane_count: value.paneCount,
    agent_status: agentStatus(value.agentStatus),
  };
}

function pane(value: HerdrPaneInfo): WhipPaneInfo {
  return {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
    cwd: value.cwd,
    foreground_cwd: value.foregroundCwd,
    label: value.label,
    agent: value.agent,
    title: value.title,
    terminal_title: value.terminalTitle,
    terminal_title_stripped: value.terminalTitleStripped,
    display_agent: value.displayAgent,
    state_labels: stringRecord(value.stateLabels),
    tokens: stringRecord(value.tokens),
    agent_session: agentSession(value.agentSession),
    scroll: paneScroll(value.scroll),
  };
}

function agent(value: HerdrAgentInfo): WhipAgentInfo {
  return {
    pane_id: value.paneId,
    terminal_id: value.terminalId,
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    focused: value.focused,
    agent_status: agentStatus(value.agentStatus),
    revision: value.revision,
    cwd: value.cwd,
    foreground_cwd: value.foregroundCwd,
    agent: value.agent,
    name: value.name,
    title: value.title,
    terminal_title: value.terminalTitle,
    terminal_title_stripped: value.terminalTitleStripped,
    display_agent: value.displayAgent,
    interactive_ready: value.interactiveReady,
    launch_pending: value.launchPending,
    screen_detection_skipped: value.screenDetectionSkipped,
    state_change_seq: value.stateChangeSeq,
    state_labels: stringRecord(value.stateLabels),
    tokens: stringRecord(value.tokens),
    agent_session: agentSession(value.agentSession),
  };
}

function rect(value: HerdrPaneLayoutRect): WhipPaneLayoutRect {
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function layout(value: HerdrPaneLayoutSnapshot): WhipPaneLayoutSnapshot {
  return {
    workspace_id: value.workspaceId,
    tab_id: value.tabId,
    zoomed: value.zoomed,
    area: rect(value.area),
    focused_pane_id: value.focusedPaneId,
    panes: value.panes.map(item => ({
      pane_id: item.paneId,
      focused: item.focused,
      rect: rect(item.rect),
    })),
    splits: value.splits.map(item => ({
      id: item.id,
      direction: splitDirectionString(item.direction),
      ratio: item.ratio,
      rect: rect(item.rect),
    })),
  };
}

function snapshot(value: HerdrSessionSnapshot): WhipHostSnapshot {
  return {
    version: value.version,
    protocol: value.protocol,
    focused_workspace_id: value.focusedWorkspaceId,
    focused_tab_id: value.focusedTabId,
    focused_pane_id: value.focusedPaneId,
    agents: value.agents.map(agent),
    workspaces: value.workspaces.map(workspace),
    tabs: value.tabs.map(tab),
    panes: value.panes.map(pane),
    layouts: value.layouts.map(layout),
  };
}

function hostSyncStatus(value: HostSyncStatus): RuntimeHostState['syncStatus'] {
  switch (value) {
    case HostSyncStatus.Idle:
      return 'idle';
    case HostSyncStatus.Syncing:
      return 'syncing';
    case HostSyncStatus.Synced:
      return 'synced';
    case HostSyncStatus.Error:
      return 'error';
  }
}

function runtimeTransferState(value: TransferState): RuntimeTransferState {
  switch (value) {
    case TransferState.Pending:
      return 'pending';
    case TransferState.Running:
      return 'running';
    case TransferState.Completed:
      return 'completed';
    case TransferState.Failed:
      return 'failed';
    case TransferState.Cancelled:
      return 'cancelled';
  }
}

function runtimePreviewState(value: PreviewState): RuntimePreviewState {
  switch (value) {
    case PreviewState.Running:
      return 'running';
    case PreviewState.Disconnected:
      return 'disconnected';
    case PreviewState.Stopped:
      return 'stopped';
  }
}

function runtimeTransferProgress(
  value: NativeTransferProgress,
): RuntimeTransferProgress {
  return {
    transferId: value.transferId,
    bytesTransferred: Number(value.bytesTransferred),
    totalBytes:
      value.totalBytes === undefined ? undefined : Number(value.totalBytes),
    state: runtimeTransferState(value.state),
  };
}

function runtimeRemoteFileKind(value: RemoteFileKind): RuntimeRemoteFileKind {
  switch (value) {
    case RemoteFileKind.File:
      return 'file';
    case RemoteFileKind.Directory:
      return 'directory';
    case RemoteFileKind.Symlink:
      return 'symlink';
    case RemoteFileKind.Other:
      return 'other';
  }
}

function runtimeDirectory(
  value: NativeRemoteDirectoryListing,
): RuntimeRemoteDirectoryListing {
  return {
    path: value.path,
    entries: value.entries.map(runtimeRemoteEntry),
  };
}

function runtimeRemoteEntry(
  entry: NativeRemoteDirectoryListing['entries'][number],
): RuntimeRemoteFileEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: runtimeRemoteFileKind(entry.kind),
    size: entry.size === undefined ? undefined : Number(entry.size),
    modifiedAt:
      entry.modifiedAt === undefined ? undefined : Number(entry.modifiedAt),
    permissions: entry.permissions,
  };
}

function runtimeGitStatus(value: NativeGitStatusEntry): RuntimeGitStatusEntry {
  return {
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    path: value.path,
    originalPath: value.originalPath ?? null,
    absolutePath: value.absolutePath,
  };
}

function nativeGitStatus(value: RuntimeGitStatusEntry): NativeGitStatusEntry {
  return {
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    path: value.path,
    originalPath: value.originalPath ?? undefined,
    absolutePath: value.absolutePath,
  };
}

function runtimeGitDiff(value: NativeGitDiff): RuntimeGitDiff {
  const kind =
    value.kind === GitDiffKind.Binary
      ? 'binary'
      : value.kind === GitDiffKind.Empty
      ? 'empty'
      : 'text';
  const rowKind = (rowKindValue: GitDiffRowKind): RuntimeGitDiffRowKind => {
    switch (rowKindValue) {
      case GitDiffRowKind.Header:
        return 'header';
      case GitDiffRowKind.Hunk:
        return 'hunk';
      case GitDiffRowKind.Context:
        return 'context';
      case GitDiffRowKind.Addition:
        return 'addition';
      case GitDiffRowKind.Deletion:
        return 'deletion';
      case GitDiffRowKind.Meta:
        return 'meta';
    }
  };
  return {
    kind,
    rows: value.rows.map(row => ({
      key: row.key,
      kind: rowKind(row.kind),
      content: row.content,
      marker: row.marker,
      oldLine: row.oldLine ?? null,
      newLine: row.newLine ?? null,
    })),
    truncated: value.truncated,
  };
}

function runtimePreview(value: NativePreviewInfo): RuntimePreviewInfo {
  return {
    id: value.previewId,
    kind:
      value.kind === PreviewKind.Html
        ? 'html'
        : value.kind === PreviewKind.RemoteFile
        ? 'remote-file'
        : 'web-forward',
    state: runtimePreviewState(value.state),
    url: value.localUrl,
    displayUrl: value.displayUrl,
  };
}

function runtimeDiagnosticOperation(
  value: NativeRuntimeDiagnosticOperation,
): RuntimeDiagnosticOperation {
  switch (value) {
    case NativeRuntimeDiagnosticOperation.SshConnect:
      return 'ssh-connect';
    case NativeRuntimeDiagnosticOperation.SshReconnect:
      return 'ssh-reconnect';
    case NativeRuntimeDiagnosticOperation.SshReconnectFast:
      return 'ssh-reconnect-fast';
    case NativeRuntimeDiagnosticOperation.SshReconnectPersistent:
      return 'ssh-reconnect-persistent';
    case NativeRuntimeDiagnosticOperation.HostLatencyProbe:
      return 'host-latency-probe';
    case NativeRuntimeDiagnosticOperation.HerdrRequest:
      return 'herdr-request';
    case NativeRuntimeDiagnosticOperation.HerdrRecovery:
      return 'herdr-recovery';
    case NativeRuntimeDiagnosticOperation.TerminalAttach:
      return 'terminal-attach';
    case NativeRuntimeDiagnosticOperation.TerminalRecovery:
      return 'terminal-recovery';
    case NativeRuntimeDiagnosticOperation.SshShellRecovery:
      return 'ssh-shell-recovery';
    case NativeRuntimeDiagnosticOperation.EventStreamRecovery:
      return 'event-stream-recovery';
  }
}

function runtimeDiagnostic(value: NativeRuntimeDiagnostic): RuntimeDiagnostic {
  return {
    operation: runtimeDiagnosticOperation(value.operation),
    durationMs: value.durationMs,
    transportDurationMs: value.transportDurationMs,
    outcome:
      value.outcome === NativeRuntimeDiagnosticOutcome.Started
        ? 'started'
        : value.outcome === NativeRuntimeDiagnosticOutcome.Succeeded
        ? 'succeeded'
        : 'failed',
    terminalId: value.terminalId,
    error: value.error,
  };
}

function runtimeHostLatency(
  value: NativeHostLatencyMeasurement,
): RuntimeHostLatencyMeasurement {
  return {
    sshRttMs: value.sshRttMs,
    totalMs: value.totalMs,
    runtimeOverheadMs: value.runtimeOverheadMs,
  };
}

function hostFreshness(value: HostFreshness): RuntimeHostState['freshness'] {
  switch (value) {
    case HostFreshness.Loading:
      return 'loading';
    case HostFreshness.Fresh:
      return 'fresh';
    case HostFreshness.Stale:
      return 'stale';
    case HostFreshness.Unavailable:
      return 'unavailable';
  }
}

function runtimeHostState(value: HostStateSnapshot): RuntimeHostState {
  return {
    revision: Number(value.revision),
    connectionGeneration: Number(value.connectionGeneration),
    syncGeneration: Number(value.syncGeneration),
    syncStatus: hostSyncStatus(value.syncStatus),
    freshness: hostFreshness(value.freshness),
    error: value.error,
    lastSyncedAtMs:
      value.lastSyncedAtMs === undefined
        ? undefined
        : Number(value.lastSyncedAtMs),
    lastEventAtMs:
      value.lastEventAtMs === undefined
        ? undefined
        : Number(value.lastEventAtMs),
    needsResync: value.needsResync,
    focus: {
      workspaceId: value.focus.workspaceId,
      tabId: value.focus.tabId,
      paneId: value.focus.paneId,
    },
    snapshot: value.snapshot ? snapshot(value.snapshot) : undefined,
  };
}

function appConnectionStatus(
  value: AppConnectionStatus,
): AppSessionProjection['connectionStatus'] {
  switch (value) {
    case AppConnectionStatus.Connecting:
      return 'connecting';
    case AppConnectionStatus.Connected:
      return 'connected';
    case AppConnectionStatus.Ready:
      return 'ready';
    case AppConnectionStatus.Reconnecting:
      return 'reconnecting';
    case AppConnectionStatus.Disconnected:
      return 'disconnected';
    case AppConnectionStatus.Error:
      return 'error';
  }
}

function nativeAppConnectionStatus(
  value: AppSessionProjection['connectionStatus'],
): AppConnectionStatus {
  switch (value) {
    case 'connecting':
      return AppConnectionStatus.Connecting;
    case 'connected':
      return AppConnectionStatus.Connected;
    case 'ready':
      return AppConnectionStatus.Ready;
    case 'reconnecting':
      return AppConnectionStatus.Reconnecting;
    case 'disconnected':
      return AppConnectionStatus.Disconnected;
    case 'error':
      return AppConnectionStatus.Error;
  }
}

function appCoreProjection(value: NativeAppCoreView): AppCoreProjection {
  return {
    revision: Number(value.revision),
    sessions: value.sessions.map(session => ({
      id: session.id,
      hostId: session.hostId,
      connectionStatus: appConnectionStatus(session.connectionStatus),
      connectionError: session.connectionError,
      reconnectAttempt: session.reconnectAttempt,
      selection: {
        workspaceId: session.selection.workspaceId,
        tabId: session.selection.tabId,
        paneId: session.selection.paneId,
      },
      hostState: session.hostState
        ? runtimeHostState(session.hostState)
        : undefined,
      terminalRail: {
        terminals: session.terminalRail.terminals.map(terminal => ({
          terminalId: terminal.terminalId,
          paneId: terminal.paneId,
          title: terminal.title,
          kind: terminal.kind === TerminalKind.Ssh ? 'ssh' : 'herdr',
          status:
            terminal.state === TerminalUiState.Connecting
              ? 'connecting'
              : terminal.state === TerminalUiState.Connected
              ? 'connected'
              : terminal.state === TerminalUiState.Error
              ? 'error'
              : 'disconnected',
          error: terminal.error,
          reconnectAttempt: terminal.reconnectAttempt,
        })),
        activeTerminalId: session.terminalRail.activeTerminalId,
      },
    })),
    activeSessionId: value.activeSessionId,
  };
}

function apiResult(value: HerdrControlResult): RuntimeHerdrResult {
  switch (value.tag) {
    case HerdrControlResult_Tags.Pong:
      return {
        type: 'pong',
        version: value.inner.version,
        protocol: value.inner.protocol,
      };
    case HerdrControlResult_Tags.SessionSnapshot:
      return {
        type: 'session_snapshot',
        snapshot: snapshot(value.inner.snapshot),
      };
    case HerdrControlResult_Tags.WorkspaceCreated:
      return {
        type: 'workspace_created',
        workspace: workspace(value.inner.workspace),
        tab: tab(value.inner.tab),
        root_pane: pane(value.inner.rootPane),
      };
    case HerdrControlResult_Tags.WorkspaceInfo:
      return {
        type: 'workspace_info',
        workspace: workspace(value.inner.workspace),
      };
    case HerdrControlResult_Tags.TabCreated:
      return {
        type: 'tab_created',
        tab: tab(value.inner.tab),
        root_pane: pane(value.inner.rootPane),
      };
    case HerdrControlResult_Tags.TabInfo:
      return { type: 'tab_info', tab: tab(value.inner.tab) };
    case HerdrControlResult_Tags.PaneInfo:
      return { type: 'pane_info', pane: pane(value.inner.pane) };
    case HerdrControlResult_Tags.PaneRead:
      return { type: 'pane_read', read: { text: value.inner.read.text } };
    case HerdrControlResult_Tags.AgentStarted:
      return {
        type: 'agent_started',
        agent: agent(value.inner.agent),
        argv: value.inner.argv,
      };
    case HerdrControlResult_Tags.AgentInfo:
      return { type: 'agent_info', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.AgentPrompted:
      return { type: 'agent_prompted', agent: agent(value.inner.agent) };
    case HerdrControlResult_Tags.IntegrationInstalled:
      return {
        type: 'integration_install',
        target:
          value.inner.install.kind === HerdrAgentKind.Claude
            ? 'claude'
            : value.inner.install.kind === HerdrAgentKind.Codex
            ? 'codex'
            : 'opencode',
        details: { messages: [...value.inner.install.messages] },
      };
    case HerdrControlResult_Tags.PaneZoom:
      return { type: 'pane_zoom' };
    case HerdrControlResult_Tags.Ok:
      return { type: 'ok' };
  }
}

function controlEvent(
  terminalId: string,
  event: HerdrTerminalControlEvent,
): BridgeEvent {
  switch (event.tag) {
    case HerdrTerminalControlEvent_Tags.Closed:
      return { type: 'closed', terminalId, text: event.inner.reason };
    case HerdrTerminalControlEvent_Tags.Notify:
      return {
        type: 'notify',
        terminalId,
        text: event.inner.text,
        body: event.inner.body,
        kind: terminalNotificationKind(event.inner.kind),
      };
    case HerdrTerminalControlEvent_Tags.Clipboard:
      return { type: 'clipboard', terminalId, text: event.inner.text };
    case HerdrTerminalControlEvent_Tags.Title:
      return { type: 'title', terminalId, text: event.inner.title };
    case HerdrTerminalControlEvent_Tags.ReloadSoundConfig:
      return { type: 'reload_sound_config', terminalId };
    case HerdrTerminalControlEvent_Tags.MouseCapture:
      return { type: 'mouse_capture', terminalId, flag: event.inner.enabled };
    case HerdrTerminalControlEvent_Tags.KittyKeyboardReportAll:
      return {
        type: 'kitty_keyboard_report_all',
        terminalId,
        flag: event.inner.enabled,
      };
    case HerdrTerminalControlEvent_Tags.PrefixInputSource:
      return {
        type: 'prefix_input_source',
        terminalId,
        flag: event.inner.enabled,
      };
    case HerdrTerminalControlEvent_Tags.TerminalBell:
      return { type: 'terminal_bell', terminalId, count: event.inner.count };
    case HerdrTerminalControlEvent_Tags.Ignored:
      return { type: 'ignored', terminalId };
  }
}

const herdrTerminalEventSink: HerdrTerminalEventSink = {
  terminalFrame(
    clientKey,
    terminalId,
    sequence,
    width,
    height,
    full,
    base64Bytes,
  ): void {
    const handler = bridgeHandler(clientKey, terminalId);
    if (!handler) return;
    const inboundTraceCookie = terminalInboundTrace()?.jsReceived() ?? null;
    terminalInboundTrace()?.decodeComplete(inboundTraceCookie);
    handler({
      type: 'terminal',
      terminalId,
      seq: Number(sequence),
      width,
      height,
      full,
      bytes: base64Bytes,
      final: true,
      inboundTraceCookie,
    });
  },
  graphicsFrame(clientKey, terminalId, bytes): void {
    bridgeHandler(
      clientKey,
      terminalId,
    )?.({
      type: 'graphics',
      terminalId,
      bytes,
    });
  },
  control(clientKey, terminalId, event): void {
    const handler = bridgeHandler(clientKey, terminalId);
    handler?.(controlEvent(terminalId, event));
    if (event.tag === HerdrTerminalControlEvent_Tags.Closed)
      removeBridgeHandler(clientKey, terminalId);
  },
};

const hostRuntimeEventSink = {
  event(event: HostRuntimeEvent): void {
    const { tag, inner } = event;
    if (tag === HostRuntimeEvent_Tags.SshShellData) {
      runtimeSshShellHandlers
        .get(inner.runtimeId)
        ?.get(inner.terminalId)
        ?.data(inner.bytes);
      return;
    }
    if (tag === HostRuntimeEvent_Tags.SshShellClosed) {
      const handlers = runtimeSshShellHandlers.get(inner.runtimeId);
      const shell = handlers?.get(inner.terminalId);
      handlers?.delete(inner.terminalId);
      if (handlers?.size === 0) runtimeSshShellHandlers.delete(inner.runtimeId);
      shell?.closed?.(inner.reason);
      return;
    }
    const handler = runtimeHandlers.get(inner.runtimeId);
    if (!handler) return;
    switch (tag) {
      case HostRuntimeEvent_Tags.ConnectionStateChanged:
        handler({
          type: 'connection-state',
          state: runtimeConnectionState(inner.status.state),
          generation: Number(inner.status.generation),
          reconnectAttempt: nativeRequiredNumber(inner.status.reconnectAttempt),
          error: inner.status.error,
        });
        break;
      case HostRuntimeEvent_Tags.ReconnectScheduled:
        handler({
          type: 'reconnect-scheduled',
          attempt: inner.attempt,
          delayMs: Number(inner.delayMs),
          reason: inner.reason,
        });
        break;
      case HostRuntimeEvent_Tags.Reconnected:
        handler({
          type: 'reconnected',
          generation: Number(inner.generation),
          restoredTerminals: inner.restoredTerminals,
        });
        break;
      case HostRuntimeEvent_Tags.TerminalStateChanged:
        handler({
          type: 'terminal-state',
          terminalId: inner.terminalId,
          state: runtimeTerminalState(inner.state),
          reconnectAttempt: nativeRequiredNumber(inner.reconnectAttempt),
          retrying: inner.retrying,
          error: inner.error,
        });
        break;
      case HostRuntimeEvent_Tags.HostStateChanged: {
        const retention = inner.transcriptRetention;
        if (retention) {
          const route = transcriptRoutingKey(
            inner.runtimeId, Number(retention.runtimeIncarnation),
          );
          const revision = Number(retention.revision);
          if (revision > (agentTranscriptRetentionVersions.get(route) ?? -1)) {
            agentTranscriptRetentionVersions.set(route, revision);
            const handlers = agentTranscriptHandlers.get(route);
            const retained = new Set(retention.retainedKeys);
            for (const key of handlers?.keys() ?? []) {
              if (!retained.has(key)) handlers?.delete(key);
            }
          }
        }
        handler({
          type: 'host-state',
          state: runtimeHostState(inner.state),
          transcriptRetention: retention ? {
            namespace: retention.namespace,
            runtimeIncarnation: Number(retention.runtimeIncarnation),
            revision: Number(retention.revision),
            retainedKeys: retention.retainedKeys,
          } : undefined,
          agentStatusTransitions: inner.agentStatusTransitions.map(
            transition => ({
              paneId: transition.paneId,
              previous:
                transition.previous === undefined
                  ? undefined
                  : agentStatus(transition.previous),
              current:
                transition.current === undefined
                  ? undefined
                  : agentStatus(transition.current),
              revision: Number(transition.revision),
            }),
          ),
        });
        break;
      }
      case HostRuntimeEvent_Tags.LatencyMeasured:
        handler({
          type: 'latency-measured',
          measurement: runtimeHostLatency(inner.measurement),
        });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionClosed:
        handler({ type: 'event-stream-closed', reason: inner.reason });
        break;
      case HostRuntimeEvent_Tags.EventSubscriptionRestored:
        handler({
          type: 'event-stream-restored',
          generation: Number(inner.generation),
        });
        break;
      case HostRuntimeEvent_Tags.TransferProgressChanged:
        handler({
          type: 'transfer-progress',
          progress: runtimeTransferProgress(inner.progress),
        });
        break;
      case HostRuntimeEvent_Tags.PreviewStateChanged:
        handler({
          type: 'preview-state',
          previewId: inner.previewId,
          state: runtimePreviewState(inner.state),
          error: inner.error,
        });
        break;
      case HostRuntimeEvent_Tags.Diagnostic:
        handler({
          type: 'diagnostic',
          diagnostic: runtimeDiagnostic(inner.diagnostic),
        });
        break;
      case HostRuntimeEvent_Tags.FatalError:
        handler({ type: 'fatal-error', message: inner.message });
        break;
    }
  },
};

const agentTranscriptEventSink = {
  event(event: AgentTranscriptEvent): void {
    const handlers = agentTranscriptHandlers.get(
      transcriptRoutingKey(event.runtimeId, Number(event.runtimeIncarnation)),
    );
    const handler = handlers?.get(event.key);
    const accepted = handler?.(event);
    const closed = event.update.deltas.some(
      delta =>
        delta.tag === AgentTranscriptDelta_Tags.StatusChanged &&
        delta.inner.status === AgentTranscriptStatus.Closed,
    );
    if (accepted && closed && handlers?.get(event.key) === handler) handlers?.delete(event.key);
  },
};

setHerdrTerminalEventSink(herdrTerminalEventSink);
setHostRuntimeEventSink(hostRuntimeEventSink);
setAgentTranscriptEventSink(agentTranscriptEventSink);

export class NativeHostRuntime {
  readonly runtimeId: string;
  readonly runtimeIncarnation: number;
  private readonly transcriptRoute: string;
  private readonly agentChatRoutes = new Map<
    string,
    { bindingToken: string; transcriptKey: string }
  >();

  constructor(
    private readonly runtime: HostRuntimeLike,
    lifecycleHandler?: (event: RuntimeLifecycleEvent) => void,
  ) {
    this.runtimeId = runtime.runtimeId();
    this.runtimeIncarnation =
      typeof runtime.runtimeIncarnation === 'function'
        ? Number(runtime.runtimeIncarnation())
        : 0;
    this.transcriptRoute = transcriptRoutingKey(
      this.runtimeId,
      this.runtimeIncarnation,
    );
    if (lifecycleHandler) runtimeHandlers.set(this.runtimeId, lifecycleHandler);
  }

  async connect(): Promise<void> {
    try {
      await this.runtime.connect();
    } catch (error) {
      const normalized = hostRuntimeError(error);
      console.error('[WhipSsh] host runtime connect failed', {
        runtimeId: this.runtimeId,
        tag: normalized.nativeTag || 'Unknown',
        message: normalized.message,
      });
      throw normalized;
    }
  }

  setMonitoringState(
    appActive: boolean,
    hostsVisible: boolean,
    accessLocked: boolean,
  ): void {
    this.runtime.setMonitoringState(appActive, hostsVisible, accessLocked);
  }

  async createTabWithLaunch(
    workspaceId: string,
    label: string,
    launch: RuntimeTabLaunch,
  ): Promise<RuntimeTabCreationResult> {
    const nativeLaunch =
      launch.type === 'shell'
        ? HerdrTabLaunch.Shell.new()
        : launch.type === 'agent'
        ? HerdrTabLaunch.Agent.new({
            kind: runtimeAgentKind(launch.kind),
            args: launch.args || [],
          })
        : HerdrTabLaunch.Command.new({ command: launch.command });
    const outcome = await this.runtime.createTabWithLaunch(
      workspaceId,
      label,
      nativeLaunch,
    );
    const projected: RuntimeTabCreationResult = {
      type: 'tab_created',
      tab: tab(outcome.inner.tab),
      root_pane: pane(outcome.inner.rootPane),
    };
    if (outcome.tag === HerdrTabLaunchResult_Tags.LaunchFailed) {
      const normalized = new Error(
        outcome.inner.failure.message,
      ) as RuntimeTabLaunchFailure;
      normalized.name = 'RuntimeTabLaunchError';
      normalized.code = 'TAB_LAUNCH_FAILED';
      normalized.created = projected;
      normalized.launchType =
        outcome.inner.stage === HerdrTabLaunchStage.AgentStart
          ? 'agent'
          : 'command';
      normalized.nativeFailure = outcome.inner.failure;
      throw normalized;
    }
    return projected;
  }

  submitPastes(paneId: string, parts: string[]): Promise<void> {
    return this.runtime.submitPastes(paneId, parts);
  }

  async startHerdrServer(): Promise<void> {
    try {
      await this.runtime.startHerdrServer();
    } catch (error) {
      throw hostRuntimeError(error);
    }
  }

  async agentIntegrationStatus(
    kind: RuntimeAgentKind,
  ): Promise<RuntimeAgentIntegrationStatus> {
    const status = await this.runtime.agentIntegrationStatus(
      runtimeAgentKind(kind),
    );
    switch (status) {
      case AgentIntegrationStatus.Unknown:
        return 'unknown';
      case AgentIntegrationStatus.NotInstalled:
        return 'not-installed';
      case AgentIntegrationStatus.Current:
        return 'current';
      case AgentIntegrationStatus.Outdated:
        return 'outdated';
      case AgentIntegrationStatus.NeedsRepair:
        return 'needs-repair';
    }
  }

  async installAgentIntegration(kind: RuntimeAgentKind): Promise<{
    kind: RuntimeAgentKind;
    messages: string[];
  }> {
    const installed = await this.runtime.installAgentIntegration(
      runtimeAgentKind(kind),
    );
    return { kind, messages: [...installed.messages] };
  }

  async disconnect(): Promise<void> {
    runtimeHandlers.delete(this.runtimeId);
    agentTranscriptHandlers.delete(this.transcriptRoute);
    agentTranscriptRetentionVersions.delete(this.transcriptRoute);
    runtimeSshShellHandlers.delete(this.runtimeId);
    bridgeHandlers.delete(this.runtimeId);
    this.agentChatRoutes.clear();
    await this.runtime.disconnect();
  }

  recover(immediate: boolean, reason: string): Promise<void> {
    return this.runtime.recover(immediate, reason);
  }

  status() {
    return this.runtime.status();
  }

  hostState(): RuntimeHostState {
    return runtimeHostState(this.runtime.hostState());
  }

  /** Bind this runtime to Rust-owned application state without exposing its raw handle. */
  attachToAppCore(core: AppCoreLike, sessionId: string): NativeAppCoreView {
    return core.attachRuntime(sessionId, this.runtime);
  }

  async refreshState(): Promise<RuntimeHostState> {
    return runtimeHostState(await this.runtime.refreshState());
  }

  openAgentChat(
    terminalId: string,
    handler?: (event: NativeAgentTranscriptUpdate) => void,
  ): NativeAgentChatOpenResult {
    const result = this.runtime.openAgentChat(terminalId);
    if (result.tag === AgentChatOpenResult_Tags.NoChat) {
      this.forgetAgentChatRoute(terminalId);
      return {
        type: 'no-chat',
        terminalId: result.inner.terminalId,
        reason: nativeAgentChatUnavailableReason(result.inner.reason),
      };
    }
    const binding = nativeAgentChatBinding(result.inner.binding);
    this.routeAgentChat(terminalId, binding, handler);
    return { type: 'bound', binding };
  }

  currentAgentChat(
    terminalId: string,
    handler?: (event: NativeAgentTranscriptUpdate) => void,
  ): NativeAgentChatBinding | undefined {
    const current = this.runtime.currentAgentChat(terminalId);
    if (!current) {
      this.forgetAgentChatRoute(terminalId);
      return undefined;
    }
    const binding = nativeAgentChatBinding(current);
    this.routeAgentChat(terminalId, binding, handler);
    return binding;
  }

  private routeAgentChat(
    terminalId: string,
    binding: NativeAgentChatBinding,
    handler?: (event: NativeAgentTranscriptUpdate) => void,
  ): void {
    this.forgetAgentChatRoute(terminalId, binding.transcriptKey);
    this.agentChatRoutes.set(terminalId, {
      bindingToken: binding.bindingToken,
      transcriptKey: binding.transcriptKey,
    });
    if (handler) {
      let handlers = agentTranscriptHandlers.get(this.transcriptRoute);
      if (!handlers) {
        handlers = new Map();
        agentTranscriptHandlers.set(this.transcriptRoute, handlers);
      }
      handlers.set(binding.transcriptKey, event => {
        if (!this.runtime.acceptsAgentTranscriptEvent(event.key, event.operationEpoch)) return false;
        handler(nativeAgentUpdate(event));
        return true;
      });
    }
  }

  startAgentChat(
    bindingToken: string,
    cacheBlob?: ArrayBuffer,
  ): NativeAgentChatStartResult {
    const result = this.runtime.startAgentChat(bindingToken, cacheBlob);
    if (result.tag === AgentChatStartResult_Tags.StaleBinding) {
      return { type: 'stale-binding' };
    }
    return {
      type: 'started',
      state: nativeAgentTranscript(result.inner.state),
    };
  }

  agentTranscript(key: string): NativeAgentTranscriptState {
    return nativeAgentTranscript(this.runtime.agentTranscript(key));
  }

  detachAgentChat(terminalId: string): {
    namespace: string;
    key: string;
    blob: ArrayBuffer;
  } | undefined {
    // Unroute callbacks before native detach. Native may synchronously close a
    // resource, but an intentional release is not a transcript failure.
    this.forgetAgentChatRoute(terminalId);
    return this.runtime.detachAgentChat(terminalId);
  }

  private forgetAgentChatRoute(
    terminalId: string,
    replacementKey?: string,
  ): void {
    const previous = this.agentChatRoutes.get(terminalId);
    this.agentChatRoutes.delete(terminalId);
    if (!previous || previous.transcriptKey === replacementKey) return;
    const shared = [...this.agentChatRoutes.values()].some(
      route => route.transcriptKey === previous.transcriptKey,
    );
    if (!shared) {
      agentTranscriptHandlers
        .get(this.transcriptRoute)
        ?.delete(previous.transcriptKey);
    }
  }

  confirmAgentTranscriptCache(confirmationToken: string): boolean {
    return this.runtime.confirmAgentTranscriptCache(confirmationToken);
  }

  resolvedSocketPath(): string | undefined {
    return this.runtime.resolvedSocketPath();
  }

  resolveHerdrSocketPath(): Promise<string> {
    return this.runtime.resolveControlSocket();
  }

  async requestHerdrApi(
    request: RuntimeHerdrRequest,
  ): Promise<RuntimeHerdrResult> {
    try {
      return apiResult(
        await this.runtime.controlRequest(controlRequest(request)),
      );
    } catch (error) {
      throw controlError(error);
    }
  }

  async startHerdrBridge(
    terminalId: string,
    takeover: boolean,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    handler: BridgeHandler,
  ): Promise<void> {
    setBridgeHandler(this.runtimeId, terminalId, handler);
    try {
      await this.runtime.openTerminal(
        terminalId,
        takeover,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      removeBridgeHandler(this.runtimeId, terminalId, handler);
      throw bridgeError(error);
    }
  }

  detachHerdrBridge(terminalId: string): void {
    removeBridgeHandler(this.runtimeId, terminalId);
  }

  herdrBridgeInput(terminalId: string, text: string): Promise<void> {
    try {
      this.runtime.terminalInput(terminalId, text);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(bridgeError(error));
    }
  }

  herdrBridgeResize(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    forceDispatch = false,
  ): Promise<RuntimeTerminalResizeOutcome> {
    try {
      return Promise.resolve(
        runtimeTerminalResizeOutcome(
          this.runtime.resizeTerminal(
            terminalId,
            columns,
            rows,
            cellWidthPx,
            cellHeightPx,
            forceDispatch,
          ),
        ),
      );
    } catch (error) {
      return Promise.reject(bridgeError(error));
    }
  }

  herdrBridgeGeometry(terminalId: string): RuntimeTerminalGeometry | undefined {
    const geometry = this.runtime.terminalGeometry(terminalId);
    return geometry ? runtimeTerminalGeometry(geometry) : undefined;
  }

  herdrBridgeProtocolState(terminalId: string): {
    kittyKeyboardReportAll: boolean;
  } {
    return {
      kittyKeyboardReportAll:
        this.runtime.terminalKittyKeyboardReportAll(terminalId),
    };
  }

  herdrBridgeScroll(
    terminalId: string,
    up: boolean,
    lines: number,
    column?: number,
    row?: number,
    modifiers = 0,
  ): Promise<void> {
    try {
      this.runtime.scrollTerminal(
        terminalId,
        up,
        lines,
        column,
        row,
        modifiers,
      );
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(bridgeError(error));
    }
  }

  closeHerdrBridge(terminalId: string): void {
    removeBridgeHandler(this.runtimeId, terminalId);
    this.runtime.closeTerminal(terminalId);
  }

  closeAllHerdrBridges(): void {
    bridgeHandlers.delete(this.runtimeId);
    this.runtime.closeAllTerminals();
  }

  hasHerdrBridge(terminalId: string): boolean {
    return this.runtime.hasTerminal(terminalId);
  }

  isHerdrBridgeOpening(terminalId: string): boolean {
    return this.runtime.isTerminalOpening(terminalId);
  }

  async openSshShell(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    handler: RuntimeSshShellHandler,
  ): Promise<void> {
    let handlers = runtimeSshShellHandlers.get(this.runtimeId);
    if (!handlers) {
      handlers = new Map();
      runtimeSshShellHandlers.set(this.runtimeId, handlers);
    }
    handlers.set(terminalId, handler);
    try {
      await this.runtime.openSshShell(
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
      );
    } catch (error) {
      if (handlers.get(terminalId) === handler) handlers.delete(terminalId);
      if (handlers.size === 0) runtimeSshShellHandlers.delete(this.runtimeId);
      throw error;
    }
  }

  sshShellInput(terminalId: string, bytes: ArrayBuffer): void {
    this.runtime.sshShellInput(terminalId, bytes);
  }

  resizeSshShell(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
    forceDispatch = false,
  ): RuntimeTerminalResizeOutcome {
    return runtimeTerminalResizeOutcome(
      this.runtime.resizeSshShell(
        terminalId,
        columns,
        rows,
        cellWidthPx,
        cellHeightPx,
        forceDispatch,
      ),
    );
  }

  closeSshShell(terminalId: string): void {
    runtimeSshShellHandlers.get(this.runtimeId)?.delete(terminalId);
    this.runtime.closeSshShell(terminalId);
  }

  hasSshShell(terminalId: string): boolean {
    return this.runtime.hasSshShell(terminalId);
  }

  sshShellGeometry(terminalId: string): RuntimeTerminalGeometry | undefined {
    const geometry = this.runtime.sshShellGeometry(terminalId);
    return geometry ? runtimeTerminalGeometry(geometry) : undefined;
  }

  execute(command: string): Promise<string> {
    return this.runtime.execute(command);
  }

  remoteHome(): Promise<string> {
    return this.runtime.remoteHome();
  }

  async measureHostLatency(): Promise<RuntimeHostLatencyMeasurement> {
    return runtimeHostLatency(await this.runtime.measureHostLatency());
  }

  async listDirectory(path?: string): Promise<RuntimeRemoteDirectoryListing> {
    return runtimeDirectory(await this.runtime.listDirectory(path));
  }

  async statRemotePath(path: string): Promise<RuntimeRemoteFileEntry> {
    return runtimeRemoteEntry(await this.runtime.statRemotePath(path));
  }

  readRemoteText(path: string, maxBytes?: number): Promise<string> {
    return this.runtime.readRemoteText(
      path,
      maxBytes === undefined ? undefined : BigInt(maxBytes),
    );
  }

  createRemoteDirectory(path: string): Promise<void> {
    return this.runtime.createRemoteDirectory(path);
  }

  renameRemotePath(from: string, to: string): Promise<void> {
    return this.runtime.renameRemotePath(from, to);
  }

  removeRemotePath(path: string, directory: boolean): Promise<void> {
    return this.runtime.removeRemotePath(path, directory);
  }

  private transfer(id: string): RuntimeTransfer {
    return {
      id,
      result: this.runtime
        .awaitTransfer(id)
        .then((result: NativeTransferResult) => ({
          transferId: result.transferId,
          localPath: result.localPath,
          remotePath: result.remotePath,
        }))
        .catch(error => {
          throw hostRuntimeError(error);
        }),
    };
  }

  startUpload(localPath: string, remoteDirectory: string): RuntimeTransfer {
    return this.transfer(this.runtime.startUpload(localPath, remoteDirectory));
  }

  startAttachmentUpload(localPath: string): RuntimeTransfer {
    return this.transfer(this.runtime.startAttachmentUpload(localPath));
  }

  startDownload(remotePath: string, localDirectory: string): RuntimeTransfer {
    return this.transfer(
      this.runtime.startDownload(remotePath, localDirectory),
    );
  }

  transferProgress(transferId: string): RuntimeTransferProgress | undefined {
    const progress = this.runtime.transferProgress(transferId);
    return progress && runtimeTransferProgress(progress);
  }

  cancelTransfer(transferId: string): boolean {
    return this.runtime.cancelTransfer(transferId);
  }

  async discoverGitRepository(
    path: string,
  ): Promise<RuntimeGitRepository | null> {
    return (await this.runtime.discoverGitRepository(path)) ?? null;
  }

  async gitStatus(root: string): Promise<RuntimeGitStatusEntry[]> {
    return (await this.runtime.gitStatus(root)).map(runtimeGitStatus);
  }

  async gitDiff(
    repository: RuntimeGitRepository,
    status: RuntimeGitStatusEntry,
  ): Promise<RuntimeGitDiff> {
    return runtimeGitDiff(
      await this.runtime.gitDiff(repository, nativeGitStatus(status)),
    );
  }

  async startWebPreview(remoteUrl: string): Promise<RuntimePreviewInfo> {
    return runtimePreview(await this.runtime.startWebPreview(remoteUrl));
  }

  async startHtmlPreview(remotePath: string): Promise<RuntimePreviewInfo> {
    return runtimePreview(await this.runtime.startHtmlPreview(remotePath));
  }

  async startRemoteFilePreview(
    remotePath: string,
  ): Promise<RuntimePreviewInfo> {
    return runtimePreview(
      await this.runtime.startRemoteFilePreview(remotePath),
    );
  }

  stopPreview(previewId: string): Promise<void> {
    return this.runtime.stopPreview(previewId);
  }
}

/** Rust-owned application/session state with a React-friendly typed projection. */
export class NativeAppCore {
  private readonly core: AppCoreLike = new RustAppCore();

  view(): AppCoreProjection {
    return appCoreProjection(this.core.view());
  }

  herdView(
    metadata: HerdSessionMetadata[],
    requestedHostId?: string,
    requestedWorkspaceId?: string,
  ): HerdProjection {
    return herdProjection(
      this.core.herdView(metadata, requestedHostId, requestedWorkspaceId),
    );
  }

  openSession(
    sessionId: string,
    hostId: string,
    activate = true,
  ): AppCoreProjection {
    return appCoreProjection(
      this.core.openSession(sessionId, hostId, activate),
    );
  }

  attachRuntime(
    sessionId: string,
    runtime: NativeHostRuntime,
  ): AppCoreProjection {
    return appCoreProjection(runtime.attachToAppCore(this.core, sessionId));
  }

  detachRuntime(sessionId: string): AppCoreProjection {
    return appCoreProjection(this.core.detachRuntime(sessionId));
  }

  setPlaceholderConnection(
    sessionId: string,
    status: AppSessionProjection['connectionStatus'],
    error?: string,
    reconnectAttempt?: number,
  ): AppCoreProjection {
    return appCoreProjection(
      this.core.setPlaceholderConnection(
        sessionId,
        nativeAppConnectionStatus(status),
        error,
        reconnectAttempt,
      ),
    );
  }

  selectSession(sessionId: string): AppCoreProjection {
    return appCoreProjection(this.core.selectSession(sessionId));
  }

  selectHost(hostId: string): AppCoreProjection {
    return appCoreProjection(this.core.selectHost(hostId));
  }

  closeSession(sessionId: string): AppCoreProjection {
    return appCoreProjection(this.core.closeSession(sessionId));
  }

  selectWorkspaceView(
    sessionId: string,
    workspaceId: string,
  ): AppCoreProjection {
    return appCoreProjection(
      this.core.selectWorkspaceView(sessionId, workspaceId),
    );
  }

  restoreTerminals(
    sessionId: string,
    terminalIds: string[],
    activeTerminalId?: string,
  ): AppCoreProjection {
    return appCoreProjection(
      this.core.restoreTerminals(sessionId, terminalIds, activeTerminalId),
    );
  }

  openPaneTerminal(sessionId: string, paneId: string): AppCoreProjection {
    return appCoreProjection(this.core.openPaneTerminal(sessionId, paneId));
  }

  openSshShell(sessionId: string, title: string): AppCoreProjection {
    return appCoreProjection(this.core.openSshShell(sessionId, title));
  }

  closeTerminal(sessionId: string, terminalId: string): AppCoreProjection {
    return appCoreProjection(this.core.closeTerminal(sessionId, terminalId));
  }

  updateTerminalLifecycle(
    sessionId: string,
    terminalId: string,
    state: RuntimeTerminalState,
    retrying: boolean,
    error?: string,
    reconnectAttempt = 0,
  ): AppCoreProjection {
    const nativeState =
      state === 'opening'
        ? HostTerminalState.Opening
        : state === 'attached'
        ? HostTerminalState.Attached
        : state === 'restoring'
        ? HostTerminalState.Restoring
        : state === 'failed'
        ? HostTerminalState.Failed
        : HostTerminalState.Closed;
    return appCoreProjection(
      this.core.updateTerminalLifecycle(
        sessionId,
        terminalId,
        nativeState,
        retrying,
        error,
        reconnectAttempt,
      ),
    );
  }
}

/** Rust owns history baselines, completion deduplication, formatting and order. */
export class NativeChatSpeechQueue {
  private readonly queue = new RustChatSpeechQueue();

  update(kind: 'codex' | 'opencode', live: boolean, messages: readonly NativeAgentTranscriptMessage[]): void {
    this.queue.update(kind === 'codex' ? AgentTranscriptKind.Codex : AgentTranscriptKind.OpenCode, live, messages.map(message => ({
      id: message.id,
      assistant: message.role === 'assistant',
      completed: message.completedAt !== undefined,
      prose: message.parts.flatMap(part => part.type === 'text' ? [{ id: part.id, text: part.text }] : []),
    })));
  }

  next(): string | undefined {
    return this.queue.next();
  }

  dispose(): void {
    this.queue.uniffiDestroy();
  }
}

/** Canonical Rust known-host domain store; JS only persists prepared values. */
export class NativeKnownHostStore {
  private readonly store: KnownHostStoreLike = new RustKnownHostStore();

  hydrate(persisted?: string): KnownHostStoreView {
    return knownHostStoreView(this.store.hydrate(persisted));
  }

  view(): KnownHostStoreView {
    return knownHostStoreView(this.store.view());
  }

  prepareAdd(
    challenge: NativeHostKeyChallenge,
    id: string,
    createdAt: string,
  ): KnownHostMutation {
    return knownHostMutation(this.store.prepareAdd(challenge, id, createdAt));
  }

  prepareRemove(id: string): KnownHostMutation {
    return knownHostMutation(this.store.prepareRemove(id));
  }

  commit(token: bigint): KnownHostStoreView {
    return knownHostStoreView(this.store.commit(token));
  }

  rollback(token: bigint): KnownHostStoreView {
    return knownHostStoreView(this.store.rollback(token));
  }
}

/** Canonical Rust host metadata and jump-host graph; secrets never enter it. */
export class NativeHostProfileStore {
  private readonly store: HostProfileStoreLike = new RustHostProfileStore();

  hydrate(persisted?: string): HostProfileStoreProjection {
    return hostProfileStoreProjection(this.store.hydrate(persisted));
  }

  view(): HostProfileStoreProjection {
    return hostProfileStoreProjection(this.store.view());
  }

  normalizeProfile(
    profile: NativeHostProfile,
    previousCreatedAt: string | undefined,
    now: string,
  ): NativeHostProfile {
    return nativeHostProfile(
      this.store.normalizeProfile(
        rustHostProfile(profile),
        previousCreatedAt,
        now,
      ),
    );
  }

  upsert(profile: NativeHostProfile, now: string): HostProfileStoreProjection {
    return hostProfileStoreProjection(
      this.store.upsert(rustHostProfile(profile), now),
    );
  }

  markDisconnected(id: string, now: string): HostProfileStoreProjection {
    return hostProfileStoreProjection(this.store.markDisconnected(id, now));
  }

  remove(id: string, now: string): HostProfileStoreProjection {
    return hostProfileStoreProjection(this.store.remove(id, now));
  }

  resolveJumpChain(
    profileId: string,
    jumpHostId?: string,
  ): NativeHostProfile[] {
    return this.store
      .resolveJumpChain(profileId, jumpHostId)
      .map(nativeHostProfile);
  }

  jumpCandidates(profileId: string): NativeHostProfile[] {
    return this.store.jumpCandidates(profileId).map(nativeHostProfile);
  }

  migrateLegacy(persisted: string, now: string): NativeHostProfile | undefined {
    const profile = this.store.migrateLegacy(persisted, now);
    return profile && nativeHostProfile(profile);
  }
}

export type HostRuntimeConnection = NativeHostRuntime;
export type {
  RuntimeLifecycleEvent as HostRuntimeLifecycleEvent,
  RuntimeHostState as HostRuntimeState,
};
export type GeneratedKeyPair = SshGeneratedKeyPair;
export type KeyDetails = SshKeyDetails;

const SSH_ERROR_TAG_CODES: Readonly<Record<string, string>> = {
  AuthenticationFailed: 'AUTHENTICATION_FAILED',
  HostKeyUnknown: 'HOST_KEY_UNKNOWN',
  HostKeyChanged: 'HOST_KEY_CHANGED',
  UnsupportedHostCertificate: 'UNSUPPORTED_HOST_CERTIFICATE',
  ConnectionRefused: 'CONNECTION_REFUSED',
  ConnectionTimeout: 'CONNECTION_TIMEOUT',
  HostUnreachable: 'HOST_UNREACHABLE',
  ChannelUnavailable: 'CHANNEL_UNAVAILABLE',
  SessionClosed: 'SESSION_CLOSED',
  InvalidPrivateKey: 'INVALID_PRIVATE_KEY',
  SftpFailure: 'SFTP_FAILURE',
  InvalidRequest: 'INVALID_REQUEST',
  Unknown: 'UNKNOWN',
};

function sshError(error: unknown): Error {
  const native = nativeErrorParts(error);
  const details =
    native.tag === 'HostKeyUnknown' || native.tag === 'HostKeyChanged'
      ? native.inner[0]
      : undefined;
  const message =
    native.tag === 'HostKeyUnknown'
      ? 'unknown SSH host key'
      : native.tag === 'HostKeyChanged'
      ? 'SSH host key changed'
      : native.tag === 'UnsupportedHostCertificate'
      ? 'SSH host certificates are not supported'
      : typeof native.inner[0] === 'string'
      ? native.inner[0]
      : error instanceof Error
      ? error.message
      : String(error);
  const result = new Error(message);
  result.name = 'SshError';
  if (native.tag)
    Object.assign(result, {
      code: SSH_ERROR_TAG_CODES[native.tag] || 'UNKNOWN',
    });
  if (details !== undefined) Object.assign(result, { details });
  return result;
}

export function setKnownHosts(contents: string): void {
  setKnownHostsRust(contents);
}

export function setTrustedHostKeys(
  entries: Array<{
    host: string;
    port: number;
    keyType: string;
    publicKey: string;
  }>,
): void {
  setTrustedHostKeysRust(entries);
}

export function getKeyDetails(
  privateKey: string,
  passphrase?: string,
): KeyDetails {
  try {
    return getSshKeyDetailsRust(privateKey, passphrase);
  } catch (error) {
    throw sshError(error);
  }
}

export function generateKeyPair(
  type = 'ed25519',
  passphrase = '',
  keySize = 256,
  comment = 'whip-ssh',
): GeneratedKeyPair {
  try {
    return generateSshKeyPairRust(type, passphrase, keySize, comment);
  } catch (error) {
    throw sshError(error);
  }
}

export function createHostRuntime(
  config: RuntimeConfig,
  handler?: (event: RuntimeLifecycleEvent) => void,
): NativeHostRuntime {
  const runtime = createHostRuntimeRust({
    runtimeId: config.runtimeId,
    ssh: runtimeSshConfig(config.ssh),
    jumpHosts: config.jumpHosts.map(runtimeSshConfig),
    sessionName: config.sessionName,
    herdrCommand: config.herdrCommand,
    socketPath: config.socketPath,
    cachedSocketPath: config.cachedSocketPath,
  });
  return new NativeHostRuntime(runtime, handler);
}

export function pairHost(
  code: string,
  publicKey: string,
  deviceName: string,
): Promise<NativePairHostResult> {
  return pairHostRust(code, publicKey, deviceName);
}
