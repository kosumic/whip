//! Canonical Rust types, shared with Whip's remote FFI declarations.
#[doc(hidden)]
#[macro_export]
macro_rules! herdr_control_type_schema {
    ($apply:ident) => {
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentKind {
    Claude,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
    Pi,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HerdrIntegrationInstallResult {
    pub kind: HerdrAgentKind,
    pub messages: Vec<String>,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrIntegrationState {
    NotInstalled,
    Current,
    Outdated,
    NeedsRepair,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HerdrIntegrationInfo {
    pub target: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub state: HerdrIntegrationState,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentSessionKind {
    Id,
    Path,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrSplitDirection {
    Right,
    Down,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneReadSource {
    Visible,
    Recent,
    RecentUnwrapped,
    Detection,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneReadFormat {
    Text,
    Ansi,
}

        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneZoomReason {
    SinglePane,
    AlreadyZoomed,
    AlreadyUnzoomed,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrAgentSessionInfo {
    pub source: String,
    pub agent: String,
    pub kind: HerdrAgentSessionKind,
    pub value: String,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneScrollInfo {
    pub offset_from_bottom: f64,
    pub max_offset_from_bottom: f64,
    pub viewport_rows: f64,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrWorkspaceWorktreeInfo {
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
    pub checkout_path: String,
    pub is_linked_worktree: bool,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrWorkspaceInfo {
    pub workspace_id: String,
    pub number: f64,
    pub label: String,
    pub focused: bool,
    pub pane_count: f64,
    pub tab_count: f64,
    pub active_tab_id: String,
    pub agent_status: HerdrAgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<HerdrWorkspaceWorktreeInfo>,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq)]
pub struct HerdrWorktreeInfo {
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_linked_worktree: bool,
    pub is_prunable: bool,
    pub label: String,
    pub open_workspace_id: Option<String>,
    pub path: String,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrTabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: f64,
    pub label: String,
    /// None on older servers until an explicit create/rename establishes origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_is_custom: Option<bool>,
    pub focused: bool,
    pub pane_count: f64,
    pub agent_status: HerdrAgentStatus,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    pub agent_status: HerdrAgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<HerdrAgentSessionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<HerdrPaneScrollInfo>,
    pub revision: f64,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrAgentInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub focused: bool,
    pub agent_status: HerdrAgentStatus,
    pub revision: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_title_stripped: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_detection_skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_change_seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_labels: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<HerdrAgentSessionInfo>,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneLayoutRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneLayoutPane {
    pub pane_id: String,
    pub focused: bool,
    pub rect: HerdrPaneLayoutRect,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneLayoutSplit {
    pub id: String,
    pub direction: HerdrSplitDirection,
    pub ratio: f64,
    pub rect: HerdrPaneLayoutRect,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneLayoutSnapshot {
    pub workspace_id: String,
    pub tab_id: String,
    pub zoomed: bool,
    pub area: HerdrPaneLayoutRect,
    pub focused_pane_id: String,
    pub panes: Vec<HerdrPaneLayoutPane>,
    pub splits: Vec<HerdrPaneLayoutSplit>,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrSessionSnapshot {
    pub version: String,
    pub protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_pane_id: Option<String>,
    pub agents: Vec<HerdrAgentInfo>,
    pub workspaces: Vec<HerdrWorkspaceInfo>,
    pub tabs: Vec<HerdrTabInfo>,
    pub panes: Vec<HerdrPaneInfo>,
    pub layouts: Vec<HerdrPaneLayoutSnapshot>,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneReadResult {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub source: HerdrPaneReadSource,
    pub format: HerdrPaneReadFormat,
    pub text: String,
    pub revision: f64,
    pub truncated: bool,
}

        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HerdrPaneZoomResult {
    pub changed: bool,
    pub zoom_changed: bool,
    pub focus_changed: bool,
    pub reason: Option<HerdrPaneZoomReason>,
    pub pane_id: String,
    pub focused_pane_id: String,
    pub zoomed: bool,
    pub layout: HerdrPaneLayoutSnapshot,
}

        );
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
// UniFFI data enums cannot box associated records. Keeping the result typed is
// preferable to recreating the former string discriminator plus option bag.
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI data enums cannot box associated records without changing the typed control API"
)]
pub enum HerdrControlResult {
    Pong {
        version: String,
        protocol: u32,
    },
    SessionSnapshot {
        snapshot: HerdrSessionSnapshot,
    },
    WorkspaceCreated {
        workspace: HerdrWorkspaceInfo,
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
    },
    WorkspaceInfo {
        workspace: HerdrWorkspaceInfo,
    },
    TabCreated {
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
    },
    TabInfo {
        tab: HerdrTabInfo,
    },
    PaneInfo {
        pane: HerdrPaneInfo,
    },
    PaneRead {
        read: HerdrPaneReadResult,
    },
    AgentStarted {
        agent: HerdrAgentInfo,
        argv: Vec<String>,
    },
    AgentInfo {
        agent: HerdrAgentInfo,
    },
    AgentPrompted {
        agent: HerdrAgentInfo,
    },
    IntegrationInstalled {
        install: HerdrIntegrationInstallResult,
    },
    IntegrationList {
        integrations: Vec<HerdrIntegrationInfo>,
    },
    PaneZoom {
        zoom: HerdrPaneZoomResult,
    },
    Ok,
}

        );
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum HerdrControlRequest {
    Ping,
    SessionSnapshot,
    WorkspaceCreate {
        label: Option<String>,
        cwd: Option<String>,
    },
    WorkspaceFocus {
        workspace_id: String,
    },
    WorkspaceRename {
        workspace_id: String,
        label: String,
    },
    WorkspaceClose {
        workspace_id: String,
    },
    TabCreate {
        workspace_id: String,
        label: Option<String>,
    },
    TabFocus {
        tab_id: String,
    },
    TabRename {
        tab_id: String,
        label: String,
    },
    TabClose {
        tab_id: String,
    },
    PaneRead {
        pane_id: String,
        lines: u32,
    },
    PaneReadVisible {
        pane_id: String,
    },
    PaneGet {
        pane_id: String,
    },
    PaneFocus {
        pane_id: String,
    },
    PaneRename {
        pane_id: String,
        label: Option<String>,
    },
    PaneSplit {
        pane_id: String,
        direction: HerdrSplitDirection,
    },
    PaneZoom {
        pane_id: String,
    },
    PaneClose {
        pane_id: String,
    },
    PaneSendInput {
        pane_id: String,
        text: String,
        keys: Vec<String>,
    },
    PaneSendText {
        pane_id: String,
        text: String,
    },
    PaneSendKeys {
        pane_id: String,
        keys: Vec<String>,
    },
    AgentStart {
        name: String,
        kind: HerdrAgentKind,
        pane_id: String,
        args: Vec<String>,
    },
    AgentFocus {
        target: String,
    },
    AgentPrompt {
        target: String,
        text: String,
    },
    IntegrationInstall {
        kind: HerdrAgentKind,
    },
    IntegrationList,
}

        );
    };
}
