import type {
  WhipAgentInfo,
  WhipAgentSessionInfo,
  WhipAgentStatus,
  WhipHostSnapshot,
  WhipPaneInfo,
  WhipPaneLayoutPane,
  WhipPaneLayoutRect,
  WhipPaneLayoutSnapshot,
  WhipPaneLayoutSplit,
  WhipPaneScrollInfo,
  WhipTabInfo,
  WhipWorkspaceInfo,
} from 'react-native-whip-ssh';

export type AuthMode = 'password' | 'key';
export type AgentStatus = WhipAgentStatus;

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  jumpHostId?: string;
  forwardAgent?: boolean;
  authMode: AuthMode;
  herdrCommand: string;
  herdrSocketPath?: string;
  sessionName: string;
  agentInstructions?: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export interface ConnectionProfile extends HostProfile {
  secret: string;
  passphrase: string;
}

export interface GlobalSshKey {
  id: string;
  name: string;
  fingerprint: string;
  keyType: string;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalSshKeyMaterial extends GlobalSshKey {
  secret: string;
  passphrase: string;
}

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export type AgentInfo = WhipAgentInfo;
export type WorkspaceInfo = WhipWorkspaceInfo;
export type TabInfo = WhipTabInfo;
export type PaneInfo = WhipPaneInfo;
export type AgentSessionInfo = WhipAgentSessionInfo;
export type PaneScrollInfo = WhipPaneScrollInfo;
export type PaneLayoutRect = WhipPaneLayoutRect;
export type PaneLayoutPane = WhipPaneLayoutPane;
export type PaneLayoutSplit = WhipPaneLayoutSplit;
export type PaneLayoutSnapshot = WhipPaneLayoutSnapshot;

export interface ServerInfo {
  running: boolean;
  version?: string;
  protocol?: number;
  compatible?: boolean;
  socket?: string;
}

export interface HerdrSnapshot
  extends Pick<
    WhipHostSnapshot,
    'agents' | 'workspaces' | 'tabs' | 'panes' | 'layouts'
  > {
  server: ServerInfo;
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
}

export type AppTab = 'hosts' | 'herd' | 'terminal' | 'more';
