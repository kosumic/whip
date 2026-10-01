//! Typed Herdr control API requests, responses, and shared domain validation.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use crate::herdr_connection::{HerdrConnection, HerdrConnectionError, HerdrRequestReplay};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

const CONTROL_TIMEOUT_MS: u64 = 15_000;
const MAX_CONTROL_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentKind {
    Claude,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

impl HerdrAgentKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTabLaunch {
    Shell,
    Agent {
        kind: HerdrAgentKind,
        args: Vec<String>,
    },
    Command {
        command: String,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum HerdrTabLaunchResult {
    Created {
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
    },
    LaunchFailed {
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
        stage: HerdrTabLaunchStage,
        failure: HerdrControlFailure,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrIntegrationInstallResult {
    pub kind: HerdrAgentKind,
    pub messages: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrIntegrationState {
    NotInstalled,
    Current,
    Outdated,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrIntegrationInfo {
    pub target: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub state: HerdrIntegrationState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrControlFailureKind {
    TransportDisconnected,
    MalformedResponse,
    ProtocolError,
    UnsupportedResponse,
    InvalidField,
    RequestCancelled,
    RequestTimeout,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrControlFailure {
    pub kind: HerdrControlFailureKind,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTabLaunchStage {
    AgentStart,
    CommandInput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrAgentSessionKind {
    Id,
    Path,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrSplitDirection {
    Right,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneReadSource {
    Visible,
    Recent,
    RecentUnwrapped,
    Detection,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneReadFormat {
    Text,
    Ansi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum HerdrPaneZoomReason {
    SinglePane,
    AlreadyZoomed,
    AlreadyUnzoomed,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrAgentSessionInfo {
    pub source: String,
    pub agent: String,
    pub kind: HerdrAgentSessionKind,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrPaneScrollInfo {
    pub offset_from_bottom: f64,
    pub max_offset_from_bottom: f64,
    pub viewport_rows: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrWorkspaceWorktreeInfo {
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
    pub checkout_path: String,
    pub is_linked_worktree: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrTabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: f64,
    pub label: String,
    pub focused: bool,
    pub pane_count: f64,
    pub agent_status: HerdrAgentStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrPaneLayoutRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrPaneLayoutPane {
    pub pane_id: String,
    pub focused: bool,
    pub rect: HerdrPaneLayoutRect,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrPaneLayoutSplit {
    pub id: String,
    pub direction: HerdrSplitDirection,
    pub ratio: f64,
    pub rect: HerdrPaneLayoutRect,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct HerdrPaneLayoutSnapshot {
    pub workspace_id: String,
    pub tab_id: String,
    pub zoomed: bool,
    pub area: HerdrPaneLayoutRect,
    pub focused_pane_id: String,
    pub panes: Vec<HerdrPaneLayoutPane>,
    pub splits: Vec<HerdrPaneLayoutSplit>,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
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

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
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

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
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

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrControlError {
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    MalformedResponse(String),
    #[error("Herdr API error {0}: {1}")]
    ProtocolError(String, String),
    #[error("{0}")]
    UnsupportedResponse(String),
    #[error("{0}")]
    InvalidField(String),
    #[error("{0}")]
    RequestCancelled(String),
    #[error("{0}")]
    RequestTimeout(String),
}

impl From<HerdrControlError> for HerdrControlFailure {
    fn from(error: HerdrControlError) -> Self {
        let (kind, code) = match &error {
            HerdrControlError::TransportDisconnected(_) => {
                (HerdrControlFailureKind::TransportDisconnected, None)
            }
            HerdrControlError::MalformedResponse(_) => {
                (HerdrControlFailureKind::MalformedResponse, None)
            }
            HerdrControlError::ProtocolError(code, _) => {
                (HerdrControlFailureKind::ProtocolError, Some(code.clone()))
            }
            HerdrControlError::UnsupportedResponse(_) => {
                (HerdrControlFailureKind::UnsupportedResponse, None)
            }
            HerdrControlError::InvalidField(_) => (HerdrControlFailureKind::InvalidField, None),
            HerdrControlError::RequestCancelled(_) => {
                (HerdrControlFailureKind::RequestCancelled, None)
            }
            HerdrControlError::RequestTimeout(_) => (HerdrControlFailureKind::RequestTimeout, None),
        };
        Self {
            kind,
            code,
            message: error.to_string(),
        }
    }
}

#[derive(Serialize)]
struct WireRequest<'a, P: Serialize> {
    id: &'a str,
    method: &'a str,
    params: P,
}

#[derive(Serialize)]
struct EmptyParams {}

#[derive(Serialize)]
struct WorkspaceCreateParams<'a> {
    label: Option<&'a str>,
    cwd: Option<&'a str>,
    focus: bool,
}

#[derive(Serialize)]
struct WorkspaceTarget<'a> {
    workspace_id: &'a str,
}
#[derive(Serialize)]
struct WorkspaceRenameParams<'a> {
    workspace_id: &'a str,
    label: &'a str,
}
#[derive(Serialize)]
struct TabCreateParams<'a> {
    workspace_id: &'a str,
    label: Option<&'a str>,
    focus: bool,
}
#[derive(Serialize)]
struct TabTarget<'a> {
    tab_id: &'a str,
}
#[derive(Serialize)]
struct TabRenameParams<'a> {
    tab_id: &'a str,
    label: &'a str,
}
#[derive(Serialize)]
struct PaneTarget<'a> {
    pane_id: &'a str,
}
#[derive(Serialize)]
struct PaneRenameParams<'a> {
    pane_id: &'a str,
    label: Option<&'a str>,
}
#[derive(Serialize)]
struct PaneSplitParams<'a> {
    target_pane_id: &'a str,
    direction: HerdrSplitDirection,
    focus: bool,
}
#[derive(Serialize)]
struct PaneZoomParams<'a> {
    pane_id: &'a str,
    mode: &'a str,
}
#[derive(Serialize)]
struct PaneReadParams<'a> {
    pane_id: &'a str,
    source: HerdrPaneReadSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<u32>,
    format: HerdrPaneReadFormat,
    strip_ansi: bool,
}
#[derive(Serialize)]
struct PaneSendInputParams<'a> {
    pane_id: &'a str,
    text: &'a str,
    keys: &'a [String],
}
#[derive(Serialize)]
struct PaneSendTextParams<'a> {
    pane_id: &'a str,
    text: &'a str,
}
#[derive(Serialize)]
struct PaneSendKeysParams<'a> {
    pane_id: &'a str,
    keys: &'a [String],
}
#[derive(Serialize)]
struct AgentStartParams<'a> {
    name: &'a str,
    kind: HerdrAgentKind,
    pane_id: &'a str,
    #[serde(skip_serializing_if = "slice_is_empty")]
    args: &'a [String],
}

fn slice_is_empty<T>(value: &&[T]) -> bool {
    value.is_empty()
}
#[derive(Serialize)]
struct AgentPromptParams<'a> {
    target: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct AgentTarget<'a> {
    target: &'a str,
}

#[derive(Serialize)]
struct IntegrationInstallParams {
    target: HerdrAgentKind,
}

impl HerdrControlRequest {
    fn method(&self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::SessionSnapshot => "session.snapshot",
            Self::WorkspaceCreate { .. } => "workspace.create",
            Self::WorkspaceFocus { .. } => "workspace.focus",
            Self::WorkspaceRename { .. } => "workspace.rename",
            Self::WorkspaceClose { .. } => "workspace.close",
            Self::TabCreate { .. } => "tab.create",
            Self::TabFocus { .. } => "tab.focus",
            Self::TabRename { .. } => "tab.rename",
            Self::TabClose { .. } => "tab.close",
            Self::PaneRead { .. } | Self::PaneReadVisible { .. } => "pane.read",
            Self::PaneGet { .. } => "pane.get",
            Self::PaneFocus { .. } => "pane.focus",
            Self::PaneRename { .. } => "pane.rename",
            Self::PaneSplit { .. } => "pane.split",
            Self::PaneZoom { .. } => "pane.zoom",
            Self::PaneClose { .. } => "pane.close",
            Self::PaneSendInput { .. } => "pane.send_input",
            Self::PaneSendText { .. } => "pane.send_text",
            Self::PaneSendKeys { .. } => "pane.send_keys",
            Self::AgentStart { .. } => "agent.start",
            Self::AgentFocus { .. } => "agent.focus",
            Self::AgentPrompt { .. } => "agent.prompt",
            Self::IntegrationInstall { .. } => "integration.install",
            Self::IntegrationList => "integration.list",
        }
    }

    fn encode(&self, id: &str) -> Result<Vec<u8>, HerdrControlError> {
        fn line<P: Serialize>(request: WireRequest<'_, P>) -> Result<Vec<u8>, HerdrControlError> {
            let mut bytes = serde_json::to_vec(&request).map_err(|error| {
                HerdrControlError::InvalidField(format!(
                    "failed to serialize Herdr request: {error}"
                ))
            })?;
            bytes.push(b'\n');
            Ok(bytes)
        }
        let method = self.method();
        match self {
            Self::Ping | Self::SessionSnapshot | Self::IntegrationList => line(WireRequest {
                id,
                method,
                params: EmptyParams {},
            }),
            Self::WorkspaceCreate { label, cwd } => line(WireRequest {
                id,
                method,
                params: WorkspaceCreateParams {
                    label: label.as_deref(),
                    cwd: cwd.as_deref(),
                    focus: true,
                },
            }),
            Self::WorkspaceFocus { workspace_id } | Self::WorkspaceClose { workspace_id } => {
                line(WireRequest {
                    id,
                    method,
                    params: WorkspaceTarget { workspace_id },
                })
            }
            Self::WorkspaceRename {
                workspace_id,
                label,
            } => line(WireRequest {
                id,
                method,
                params: WorkspaceRenameParams {
                    workspace_id,
                    label,
                },
            }),
            Self::TabCreate {
                workspace_id,
                label,
            } => line(WireRequest {
                id,
                method,
                params: TabCreateParams {
                    workspace_id,
                    label: label.as_deref(),
                    focus: true,
                },
            }),
            Self::TabFocus { tab_id } | Self::TabClose { tab_id } => line(WireRequest {
                id,
                method,
                params: TabTarget { tab_id },
            }),
            Self::TabRename { tab_id, label } => line(WireRequest {
                id,
                method,
                params: TabRenameParams { tab_id, label },
            }),
            Self::PaneRead { pane_id, lines } => line(WireRequest {
                id,
                method,
                params: PaneReadParams {
                    pane_id,
                    source: HerdrPaneReadSource::Recent,
                    lines: Some(*lines),
                    format: HerdrPaneReadFormat::Ansi,
                    strip_ansi: false,
                },
            }),
            Self::PaneReadVisible { pane_id } => line(WireRequest {
                id,
                method,
                params: PaneReadParams {
                    pane_id,
                    source: HerdrPaneReadSource::Visible,
                    // An omitted limit reads the full viewport; zero reads no rows.
                    lines: None,
                    format: HerdrPaneReadFormat::Text,
                    strip_ansi: true,
                },
            }),
            Self::PaneGet { pane_id }
            | Self::PaneFocus { pane_id }
            | Self::PaneClose { pane_id } => line(WireRequest {
                id,
                method,
                params: PaneTarget { pane_id },
            }),
            Self::PaneRename { pane_id, label } => line(WireRequest {
                id,
                method,
                params: PaneRenameParams {
                    pane_id,
                    label: label.as_deref(),
                },
            }),
            Self::PaneSplit { pane_id, direction } => line(WireRequest {
                id,
                method,
                params: PaneSplitParams {
                    target_pane_id: pane_id,
                    direction: *direction,
                    focus: true,
                },
            }),
            Self::PaneZoom { pane_id } => line(WireRequest {
                id,
                method,
                params: PaneZoomParams {
                    pane_id,
                    mode: "toggle",
                },
            }),
            Self::PaneSendInput {
                pane_id,
                text,
                keys,
            } => line(WireRequest {
                id,
                method,
                params: PaneSendInputParams {
                    pane_id,
                    text,
                    keys,
                },
            }),
            Self::PaneSendText { pane_id, text } => line(WireRequest {
                id,
                method,
                params: PaneSendTextParams { pane_id, text },
            }),
            Self::PaneSendKeys { pane_id, keys } => line(WireRequest {
                id,
                method,
                params: PaneSendKeysParams { pane_id, keys },
            }),
            Self::AgentStart {
                name,
                kind,
                pane_id,
                args,
            } => line(WireRequest {
                id,
                method,
                params: AgentStartParams {
                    name,
                    kind: *kind,
                    pane_id,
                    args,
                },
            }),
            Self::AgentFocus { target } => line(WireRequest {
                id,
                method,
                params: AgentTarget { target },
            }),
            Self::AgentPrompt { target, text } => line(WireRequest {
                id,
                method,
                params: AgentPromptParams { target, text },
            }),
            Self::IntegrationInstall { kind } => line(WireRequest {
                id,
                method,
                params: IntegrationInstallParams { target: *kind },
            }),
        }
    }

    fn expected_result(&self) -> HerdrControlResultKind {
        match self {
            Self::Ping => HerdrControlResultKind::Pong,
            Self::SessionSnapshot => HerdrControlResultKind::SessionSnapshot,
            Self::WorkspaceCreate { .. } => HerdrControlResultKind::WorkspaceCreated,
            Self::WorkspaceFocus { .. } | Self::WorkspaceRename { .. } => {
                HerdrControlResultKind::WorkspaceInfo
            }
            Self::WorkspaceClose { .. }
            | Self::TabClose { .. }
            | Self::PaneClose { .. }
            | Self::PaneSendInput { .. }
            | Self::PaneSendText { .. }
            | Self::PaneSendKeys { .. } => HerdrControlResultKind::Ok,
            Self::TabCreate { .. } => HerdrControlResultKind::TabCreated,
            Self::TabFocus { .. } | Self::TabRename { .. } => HerdrControlResultKind::TabInfo,
            Self::PaneRead { .. } | Self::PaneReadVisible { .. } => {
                HerdrControlResultKind::PaneRead
            }
            Self::PaneGet { .. }
            | Self::PaneFocus { .. }
            | Self::PaneRename { .. }
            | Self::PaneSplit { .. } => HerdrControlResultKind::PaneInfo,
            Self::PaneZoom { .. } => HerdrControlResultKind::PaneZoom,
            Self::AgentStart { .. } => HerdrControlResultKind::AgentStarted,
            Self::AgentFocus { .. } => HerdrControlResultKind::AgentInfo,
            Self::AgentPrompt { .. } => HerdrControlResultKind::AgentPrompted,
            Self::IntegrationInstall { .. } => HerdrControlResultKind::IntegrationInstall,
            Self::IntegrationList => HerdrControlResultKind::IntegrationList,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HerdrControlResultKind {
    Pong,
    SessionSnapshot,
    WorkspaceCreated,
    WorkspaceInfo,
    TabCreated,
    TabInfo,
    PaneInfo,
    PaneRead,
    AgentStarted,
    AgentInfo,
    AgentPrompted,
    IntegrationInstall,
    IntegrationList,
    PaneZoom,
    Ok,
}

impl HerdrControlResultKind {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Pong => "pong",
            Self::SessionSnapshot => "session_snapshot",
            Self::WorkspaceCreated => "workspace_created",
            Self::WorkspaceInfo => "workspace_info",
            Self::TabCreated => "tab_created",
            Self::TabInfo => "tab_info",
            Self::PaneInfo => "pane_info",
            Self::PaneRead => "pane_read",
            Self::AgentStarted => "agent_started",
            Self::AgentInfo => "agent_info",
            Self::AgentPrompted => "agent_prompted",
            Self::IntegrationInstall => "integration_install",
            Self::IntegrationList => "integration_list",
            Self::PaneZoom => "pane_zoom",
            Self::Ok => "ok",
        }
    }
}

static CONTROL_SEQUENCES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn control_sequences() -> &'static Mutex<HashMap<String, u64>> {
    CONTROL_SEQUENCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id(client_key: &str) -> String {
    let sequence = {
        let mut sequences = control_sequences().lock();
        let sequence = sequences.entry(client_key.to_owned()).or_default();
        *sequence += 1;
        let sequence = *sequence;
        drop(sequences);
        sequence
    };
    format!("android_{sequence}")
}

fn transport_error(error: HerdrConnectionError) -> HerdrControlError {
    let timed_out = error.is_timeout();
    let message = error.to_string();
    if timed_out {
        HerdrControlError::RequestTimeout(message)
    } else {
        HerdrControlError::TransportDisconnected(message)
    }
}

pub(crate) async fn request_on_runtime(
    connection: Arc<HerdrConnection>,
    request: HerdrControlRequest,
    replay: HerdrRequestReplay,
) -> Result<HerdrControlResult, HerdrControlError> {
    let request_id = next_request_id(connection.client_key());
    let bytes = request.encode(&request_id)?;
    let response = connection
        .request(
            &bytes,
            b'\n',
            CONTROL_TIMEOUT_MS,
            MAX_CONTROL_RESPONSE_BYTES,
            replay,
        )
        .await
        .map_err(transport_error)?;
    parse_response(&request, &response)
}

#[uniffi::export]
pub async fn herdr_control_request(
    client_key: String,
    socket_path: String,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let runtime = crate::runtime().map_err(HerdrControlError::TransportDisconnected)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
    runtime
        .spawn(request_on_runtime(
            connection,
            request,
            HerdrRequestReplay::Never,
        ))
        .await
        .map_err(|error| {
            HerdrControlError::RequestCancelled(format!(
                "Herdr control runtime task failed: {error}"
            ))
        })?
}

fn parse_response(
    request: &HerdrControlRequest,
    bytes: &[u8],
) -> Result<HerdrControlResult, HerdrControlError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        HerdrControlError::MalformedResponse("Herdr API returned invalid JSON".to_owned())
    })?;
    let message =
        object(&value, "Herdr API response").map_err(HerdrControlError::MalformedResponse)?;
    if let Some(error) = message.get("error") {
        let error =
            object(error, "Herdr API error").map_err(HerdrControlError::MalformedResponse)?;
        let code = required_string(error, "code", "error.code")
            .map_err(HerdrControlError::MalformedResponse)?;
        let message = required_string(error, "message", "error.message")
            .map_err(HerdrControlError::MalformedResponse)?;
        return Err(HerdrControlError::ProtocolError(code, message));
    }
    let result = message.get("result").ok_or_else(|| {
        HerdrControlError::MalformedResponse(
            "Herdr API response did not include a result".to_owned(),
        )
    })?;
    let result = object(result, "result").map_err(HerdrControlError::InvalidField)?;
    let raw_kind =
        required_string(result, "type", "result.type").map_err(HerdrControlError::InvalidField)?;
    let kind =
        parse_wire_str::<HerdrControlResultKind>(&raw_kind, "result.type").map_err(|_| {
            HerdrControlError::UnsupportedResponse(format!(
                "Herdr API returned unsupported response type {raw_kind}"
            ))
        })?;
    let expected = request.expected_result();
    if kind != expected {
        return Err(HerdrControlError::UnsupportedResponse(format!(
            "Herdr API returned {raw_kind} for {}, expected {}",
            request.method(),
            expected.wire_name(),
        )));
    }
    decode_result(kind, result).map_err(HerdrControlError::InvalidField)
}

fn decode_result(
    kind: HerdrControlResultKind,
    result: &Map<String, Value>,
) -> Result<HerdrControlResult, String> {
    match kind {
        HerdrControlResultKind::Pong => Ok(HerdrControlResult::Pong {
            version: required_string(result, "version", "result.version")?,
            protocol: required_u32(result, "protocol", "result.protocol")?,
        }),
        HerdrControlResultKind::SessionSnapshot => Ok(HerdrControlResult::SessionSnapshot {
            snapshot: session_snapshot(required(result, "snapshot", "result.snapshot")?)?,
        }),
        HerdrControlResultKind::WorkspaceCreated => Ok(HerdrControlResult::WorkspaceCreated {
            workspace: workspace(
                required(result, "workspace", "result.workspace")?,
                "workspace",
            )?,
            tab: tab(required(result, "tab", "result.tab")?, "tab")?,
            root_pane: pane(
                required(result, "root_pane", "result.root_pane")?,
                "root_pane",
            )?,
        }),
        HerdrControlResultKind::WorkspaceInfo => Ok(HerdrControlResult::WorkspaceInfo {
            workspace: workspace(
                required(result, "workspace", "result.workspace")?,
                "workspace",
            )?,
        }),
        HerdrControlResultKind::TabCreated => Ok(HerdrControlResult::TabCreated {
            tab: tab(required(result, "tab", "result.tab")?, "tab")?,
            root_pane: pane(
                required(result, "root_pane", "result.root_pane")?,
                "root_pane",
            )?,
        }),
        HerdrControlResultKind::TabInfo => Ok(HerdrControlResult::TabInfo {
            tab: tab(required(result, "tab", "result.tab")?, "tab")?,
        }),
        HerdrControlResultKind::PaneInfo => Ok(HerdrControlResult::PaneInfo {
            pane: pane(required(result, "pane", "result.pane")?, "pane")?,
        }),
        HerdrControlResultKind::PaneRead => {
            let read = object(required(result, "read", "result.read")?, "read")?;
            Ok(HerdrControlResult::PaneRead {
                read: HerdrPaneReadResult {
                    pane_id: non_empty_string_value(
                        required(read, "pane_id", "read.pane_id")?,
                        "read.pane_id",
                    )?,
                    workspace_id: non_empty_string_value(
                        required(read, "workspace_id", "read.workspace_id")?,
                        "read.workspace_id",
                    )?,
                    tab_id: non_empty_string_value(
                        required(read, "tab_id", "read.tab_id")?,
                        "read.tab_id",
                    )?,
                    source: enum_value(required(read, "source", "read.source")?, "read.source")?,
                    format: enum_value(required(read, "format", "read.format")?, "read.format")?,
                    text: string_value(required(read, "text", "read.text")?, "read.text")?,
                    revision: non_negative_number(
                        required(read, "revision", "read.revision")?,
                        "read.revision",
                    )?,
                    truncated: bool_value(
                        required(read, "truncated", "read.truncated")?,
                        "read.truncated",
                    )?,
                },
            })
        }
        HerdrControlResultKind::AgentStarted => Ok(HerdrControlResult::AgentStarted {
            agent: agent(required(result, "agent", "result.agent")?, "agent")?,
            argv: string_array(required(result, "argv", "result.argv")?, "argv")?,
        }),
        HerdrControlResultKind::AgentInfo => Ok(HerdrControlResult::AgentInfo {
            agent: agent(required(result, "agent", "result.agent")?, "agent")?,
        }),
        HerdrControlResultKind::AgentPrompted => Ok(HerdrControlResult::AgentPrompted {
            agent: agent(required(result, "agent", "result.agent")?, "agent")?,
        }),
        HerdrControlResultKind::IntegrationInstall => {
            let details = object(
                required(result, "details", "result.details")?,
                "result.details",
            )?;
            Ok(HerdrControlResult::IntegrationInstalled {
                install: HerdrIntegrationInstallResult {
                    kind: enum_value(
                        required(result, "target", "result.target")?,
                        "result.target",
                    )?,
                    messages: string_array(
                        required(details, "messages", "result.details.messages")?,
                        "result.details.messages",
                    )?,
                },
            })
        }
        HerdrControlResultKind::IntegrationList => {
            let integrations = required(result, "integrations", "result.integrations")?
                .as_array()
                .ok_or_else(|| "result.integrations must be an array".to_owned())?
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let path = format!("result.integrations[{index}]");
                    let entry = object(value, &path)?;
                    Ok(HerdrIntegrationInfo {
                        target: required_string(entry, "target", &format!("{path}.target"))?,
                        label: required_string(entry, "label", &format!("{path}.label"))?,
                        command: required_string(entry, "command", &format!("{path}.command"))?,
                        available: bool_value(
                            required(entry, "available", &format!("{path}.available"))?,
                            &format!("{path}.available"),
                        )?,
                        state: enum_value(
                            required(entry, "state", &format!("{path}.state"))?,
                            &format!("{path}.state"),
                        )?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(HerdrControlResult::IntegrationList { integrations })
        }
        HerdrControlResultKind::PaneZoom => Ok(HerdrControlResult::PaneZoom {
            zoom: pane_zoom(required(result, "zoom", "result.zoom")?)?,
        }),
        HerdrControlResultKind::Ok => Ok(HerdrControlResult::Ok),
    }
}

fn pane_zoom(value: &Value) -> Result<HerdrPaneZoomResult, String> {
    let item = object(value, "zoom")?;
    Ok(HerdrPaneZoomResult {
        changed: bool_value(required(item, "changed", "zoom.changed")?, "zoom.changed")?,
        zoom_changed: bool_value(
            required(item, "zoom_changed", "zoom.zoom_changed")?,
            "zoom.zoom_changed",
        )?,
        focus_changed: bool_value(
            required(item, "focus_changed", "zoom.focus_changed")?,
            "zoom.focus_changed",
        )?,
        reason: item
            .get("reason")
            .map(|value| enum_value(value, "zoom.reason"))
            .transpose()?,
        pane_id: non_empty_string_value(
            required(item, "pane_id", "zoom.pane_id")?,
            "zoom.pane_id",
        )?,
        focused_pane_id: non_empty_string_value(
            required(item, "focused_pane_id", "zoom.focused_pane_id")?,
            "zoom.focused_pane_id",
        )?,
        zoomed: bool_value(required(item, "zoomed", "zoom.zoomed")?, "zoom.zoomed")?,
        layout: pane_layout(required(item, "layout", "zoom.layout")?, "zoom.layout")?,
    })
}

pub(crate) fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}

pub(crate) fn required<'a>(
    item: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Value, String> {
    item.get(key).ok_or_else(|| format!("{label} is required"))
}

pub(crate) fn string_value(value: &Value, label: &str) -> Result<String, String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{label} must be a string"))
}

pub(crate) fn non_empty_string_value(value: &Value, label: &str) -> Result<String, String> {
    let value = string_value(value, label)?;
    if value.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(value)
    }
}

pub(crate) fn bool_value(value: &Value, label: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{label} must be a boolean"))
}

pub(crate) fn finite_number(value: &Value, label: &str) -> Result<f64, String> {
    let value = value
        .as_f64()
        .ok_or_else(|| format!("{label} must be a finite number"))?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{label} must be a finite number"))
    }
}

pub(crate) fn non_negative_number(value: &Value, label: &str) -> Result<f64, String> {
    let value = finite_number(value, label)?;
    if value < 0.0 {
        Err(format!("{label} must be non-negative"))
    } else {
        Ok(value)
    }
}

pub(crate) fn required_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, String> {
    string_value(required(item, key, label)?, label)
}

fn required_u32(item: &Map<String, Value>, key: &str, label: &str) -> Result<u32, String> {
    let value = required(item, key, label)?
        .as_u64()
        .ok_or_else(|| format!("{label} must be an unsigned integer"))?;
    u32::try_from(value).map_err(|_| format!("{label} exceeds u32"))
}

pub(crate) fn optional_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, String> {
    item.get(key)
        .map(|value| string_value(value, label))
        .transpose()
}

fn optional_bool(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<bool>, String> {
    item.get(key)
        .map(|value| bool_value(value, label))
        .transpose()
}

fn optional_number(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<f64>, String> {
    item.get(key)
        .map(|value| non_negative_number(value, label))
        .transpose()
}

pub(crate) fn string_map(value: &Value, label: &str) -> Result<HashMap<String, String>, String> {
    object(value, label)?
        .iter()
        .map(|(key, value)| {
            string_value(value, &format!("{label}.{key}")).map(|value| (key.clone(), value))
        })
        .collect()
}

fn optional_string_map(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<HashMap<String, String>>, String> {
    item.get(key)
        .map(|value| string_map(value, label))
        .transpose()
}

pub(crate) fn string_array(value: &Value, label: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| string_value(value, &format!("{label}[{index}]")))
        .collect()
}

fn parse_wire_str<T: DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_value(Value::String(value.to_owned()))
        .map_err(|_| format!("{label} is invalid"))
}

fn enum_value<T: DeserializeOwned>(value: &Value, label: &str) -> Result<T, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{label} must be a string"))?;
    parse_wire_str(value, label)
}

pub(crate) fn agent_status(value: &Value, label: &str) -> Result<HerdrAgentStatus, String> {
    enum_value(value, label)
}

fn agent_session(value: &Value, label: &str) -> Result<HerdrAgentSessionInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrAgentSessionInfo {
        source: non_empty_string_value(
            required(item, "source", &format!("{label}.source"))?,
            &format!("{label}.source"),
        )?,
        agent: non_empty_string_value(
            required(item, "agent", &format!("{label}.agent"))?,
            &format!("{label}.agent"),
        )?,
        kind: enum_value(
            required(item, "kind", &format!("{label}.kind"))?,
            &format!("{label}.kind"),
        )
        .map_err(|_| format!("{label}.kind must be id or path"))?,
        value: string_value(
            required(item, "value", &format!("{label}.value"))?,
            &format!("{label}.value"),
        )?,
    })
}

pub(crate) fn pane_scroll(value: &Value, label: &str) -> Result<HerdrPaneScrollInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneScrollInfo {
        offset_from_bottom: non_negative_number(
            required(
                item,
                "offset_from_bottom",
                &format!("{label}.offset_from_bottom"),
            )?,
            &format!("{label}.offset_from_bottom"),
        )?,
        max_offset_from_bottom: non_negative_number(
            required(
                item,
                "max_offset_from_bottom",
                &format!("{label}.max_offset_from_bottom"),
            )?,
            &format!("{label}.max_offset_from_bottom"),
        )?,
        viewport_rows: non_negative_number(
            required(item, "viewport_rows", &format!("{label}.viewport_rows"))?,
            &format!("{label}.viewport_rows"),
        )?,
    })
}

fn optional_decoded<T>(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
    decode: impl FnOnce(&Value, &str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    item.get(key).map(|value| decode(value, label)).transpose()
}

pub(crate) fn workspace(value: &Value, label: &str) -> Result<HerdrWorkspaceInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorkspaceInfo {
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        number: non_negative_number(
            required(item, "number", &format!("{label}.number"))?,
            &format!("{label}.number"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        pane_count: non_negative_number(
            required(item, "pane_count", &format!("{label}.pane_count"))?,
            &format!("{label}.pane_count"),
        )?,
        tab_count: non_negative_number(
            required(item, "tab_count", &format!("{label}.tab_count"))?,
            &format!("{label}.tab_count"),
        )?,
        active_tab_id: required_string(item, "active_tab_id", &format!("{label}.active_tab_id"))?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        worktree: optional_decoded(
            item,
            "worktree",
            &format!("{label}.worktree"),
            workspace_worktree,
        )?,
    })
}

fn workspace_worktree(value: &Value, label: &str) -> Result<HerdrWorkspaceWorktreeInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorkspaceWorktreeInfo {
        repo_key: non_empty_string_value(
            required(item, "repo_key", &format!("{label}.repo_key"))?,
            &format!("{label}.repo_key"),
        )?,
        repo_name: non_empty_string_value(
            required(item, "repo_name", &format!("{label}.repo_name"))?,
            &format!("{label}.repo_name"),
        )?,
        repo_root: non_empty_string_value(
            required(item, "repo_root", &format!("{label}.repo_root"))?,
            &format!("{label}.repo_root"),
        )?,
        checkout_path: non_empty_string_value(
            required(item, "checkout_path", &format!("{label}.checkout_path"))?,
            &format!("{label}.checkout_path"),
        )?,
        is_linked_worktree: bool_value(
            required(
                item,
                "is_linked_worktree",
                &format!("{label}.is_linked_worktree"),
            )?,
            &format!("{label}.is_linked_worktree"),
        )?,
    })
}

pub(crate) fn worktree(value: &Value, label: &str) -> Result<HerdrWorktreeInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorktreeInfo {
        branch: optional_string(item, "branch", &format!("{label}.branch"))?,
        is_bare: bool_value(
            required(item, "is_bare", &format!("{label}.is_bare"))?,
            &format!("{label}.is_bare"),
        )?,
        is_detached: bool_value(
            required(item, "is_detached", &format!("{label}.is_detached"))?,
            &format!("{label}.is_detached"),
        )?,
        is_linked_worktree: bool_value(
            required(
                item,
                "is_linked_worktree",
                &format!("{label}.is_linked_worktree"),
            )?,
            &format!("{label}.is_linked_worktree"),
        )?,
        is_prunable: bool_value(
            required(item, "is_prunable", &format!("{label}.is_prunable"))?,
            &format!("{label}.is_prunable"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        open_workspace_id: optional_string(
            item,
            "open_workspace_id",
            &format!("{label}.open_workspace_id"),
        )?,
        path: non_empty_string_value(
            required(item, "path", &format!("{label}.path"))?,
            &format!("{label}.path"),
        )?,
    })
}

pub(crate) fn tab(value: &Value, label: &str) -> Result<HerdrTabInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrTabInfo {
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        number: non_negative_number(
            required(item, "number", &format!("{label}.number"))?,
            &format!("{label}.number"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        pane_count: non_negative_number(
            required(item, "pane_count", &format!("{label}.pane_count"))?,
            &format!("{label}.pane_count"),
        )?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
    })
}

pub(crate) fn pane(value: &Value, label: &str) -> Result<HerdrPaneInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneInfo {
        pane_id: non_empty_string_value(
            required(item, "pane_id", &format!("{label}.pane_id"))?,
            &format!("{label}.pane_id"),
        )?,
        terminal_id: non_empty_string_value(
            required(item, "terminal_id", &format!("{label}.terminal_id"))?,
            &format!("{label}.terminal_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        cwd: optional_string(item, "cwd", &format!("{label}.cwd"))?,
        foreground_cwd: optional_string(
            item,
            "foreground_cwd",
            &format!("{label}.foreground_cwd"),
        )?,
        label: optional_string(item, "label", &format!("{label}.label"))?,
        agent: optional_string(item, "agent", &format!("{label}.agent"))?,
        title: optional_string(item, "title", &format!("{label}.title"))?,
        terminal_title: optional_string(
            item,
            "terminal_title",
            &format!("{label}.terminal_title"),
        )?,
        terminal_title_stripped: optional_string(
            item,
            "terminal_title_stripped",
            &format!("{label}.terminal_title_stripped"),
        )?,
        display_agent: optional_string(item, "display_agent", &format!("{label}.display_agent"))?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        state_labels: optional_string_map(item, "state_labels", &format!("{label}.state_labels"))?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        agent_session: optional_decoded(
            item,
            "agent_session",
            &format!("{label}.agent_session"),
            agent_session,
        )?,
        scroll: optional_decoded(item, "scroll", &format!("{label}.scroll"), pane_scroll)?,
        revision: non_negative_number(
            required(item, "revision", &format!("{label}.revision"))?,
            &format!("{label}.revision"),
        )?,
    })
}

fn agent(value: &Value, label: &str) -> Result<HerdrAgentInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrAgentInfo {
        pane_id: non_empty_string_value(
            required(item, "pane_id", &format!("{label}.pane_id"))?,
            &format!("{label}.pane_id"),
        )?,
        terminal_id: non_empty_string_value(
            required(item, "terminal_id", &format!("{label}.terminal_id"))?,
            &format!("{label}.terminal_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        revision: non_negative_number(
            required(item, "revision", &format!("{label}.revision"))?,
            &format!("{label}.revision"),
        )?,
        cwd: optional_string(item, "cwd", &format!("{label}.cwd"))?,
        foreground_cwd: optional_string(
            item,
            "foreground_cwd",
            &format!("{label}.foreground_cwd"),
        )?,
        agent: optional_string(item, "agent", &format!("{label}.agent"))?,
        name: optional_string(item, "name", &format!("{label}.name"))?,
        title: optional_string(item, "title", &format!("{label}.title"))?,
        terminal_title: optional_string(
            item,
            "terminal_title",
            &format!("{label}.terminal_title"),
        )?,
        terminal_title_stripped: optional_string(
            item,
            "terminal_title_stripped",
            &format!("{label}.terminal_title_stripped"),
        )?,
        display_agent: optional_string(item, "display_agent", &format!("{label}.display_agent"))?,
        interactive_ready: optional_bool(
            item,
            "interactive_ready",
            &format!("{label}.interactive_ready"),
        )?,
        launch_pending: optional_bool(item, "launch_pending", &format!("{label}.launch_pending"))?,
        screen_detection_skipped: optional_bool(
            item,
            "screen_detection_skipped",
            &format!("{label}.screen_detection_skipped"),
        )?,
        state_change_seq: optional_number(
            item,
            "state_change_seq",
            &format!("{label}.state_change_seq"),
        )?,
        state_labels: optional_string_map(item, "state_labels", &format!("{label}.state_labels"))?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        agent_session: optional_decoded(
            item,
            "agent_session",
            &format!("{label}.agent_session"),
            agent_session,
        )?,
    })
}

fn pane_rect(value: &Value, label: &str) -> Result<HerdrPaneLayoutRect, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneLayoutRect {
        x: finite_number(
            required(item, "x", &format!("{label}.x"))?,
            &format!("{label}.x"),
        )?,
        y: finite_number(
            required(item, "y", &format!("{label}.y"))?,
            &format!("{label}.y"),
        )?,
        width: non_negative_number(
            required(item, "width", &format!("{label}.width"))?,
            &format!("{label}.width"),
        )?,
        height: non_negative_number(
            required(item, "height", &format!("{label}.height"))?,
            &format!("{label}.height"),
        )?,
    })
}

pub(crate) fn pane_layout(value: &Value, label: &str) -> Result<HerdrPaneLayoutSnapshot, String> {
    let item = object(value, label)?;
    let panes = required(item, "panes", &format!("{label}.panes"))?
        .as_array()
        .ok_or_else(|| format!("{label}.panes must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let pane_label = format!("{label}.panes[{index}]");
            let pane = object(value, &pane_label)?;
            Ok(HerdrPaneLayoutPane {
                pane_id: non_empty_string_value(
                    required(pane, "pane_id", &format!("{pane_label}.pane_id"))?,
                    &format!("{pane_label}.pane_id"),
                )?,
                focused: bool_value(
                    required(pane, "focused", &format!("{pane_label}.focused"))?,
                    &format!("{pane_label}.focused"),
                )?,
                rect: pane_rect(
                    required(pane, "rect", &format!("{pane_label}.rect"))?,
                    &format!("{pane_label}.rect"),
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let splits = required(item, "splits", &format!("{label}.splits"))?
        .as_array()
        .ok_or_else(|| format!("{label}.splits must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let split_label = format!("{label}.splits[{index}]");
            let split = object(value, &split_label)?;
            let direction = enum_value(
                required(split, "direction", &format!("{split_label}.direction"))?,
                &format!("{split_label}.direction"),
            )
            .map_err(|_| format!("{split_label}.direction must be right or down"))?;
            Ok(HerdrPaneLayoutSplit {
                id: non_empty_string_value(
                    required(split, "id", &format!("{split_label}.id"))?,
                    &format!("{split_label}.id"),
                )?,
                direction,
                ratio: finite_number(
                    required(split, "ratio", &format!("{split_label}.ratio"))?,
                    &format!("{split_label}.ratio"),
                )?,
                rect: pane_rect(
                    required(split, "rect", &format!("{split_label}.rect"))?,
                    &format!("{split_label}.rect"),
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(HerdrPaneLayoutSnapshot {
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        zoomed: bool_value(
            required(item, "zoomed", &format!("{label}.zoomed"))?,
            &format!("{label}.zoomed"),
        )?,
        area: pane_rect(
            required(item, "area", &format!("{label}.area"))?,
            &format!("{label}.area"),
        )?,
        focused_pane_id: non_empty_string_value(
            required(item, "focused_pane_id", &format!("{label}.focused_pane_id"))?,
            &format!("{label}.focused_pane_id"),
        )?,
        panes,
        splits,
    })
}

fn decoded_array<T>(
    value: &Value,
    label: &str,
    decode: impl Fn(&Value, &str) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| decode(value, &format!("{label}[{index}]")))
        .collect()
}

pub(crate) fn session_snapshot(value: &Value) -> Result<HerdrSessionSnapshot, String> {
    let item = object(value, "snapshot")?;
    Ok(HerdrSessionSnapshot {
        version: required_string(item, "version", "snapshot.version")?,
        protocol: required_u32(item, "protocol", "snapshot.protocol")?,
        focused_workspace_id: optional_nullable_string(
            item,
            "focused_workspace_id",
            "snapshot.focused_workspace_id",
        )?,
        focused_tab_id: optional_nullable_string(
            item,
            "focused_tab_id",
            "snapshot.focused_tab_id",
        )?,
        focused_pane_id: optional_nullable_string(
            item,
            "focused_pane_id",
            "snapshot.focused_pane_id",
        )?,
        agents: decoded_array(
            required(item, "agents", "snapshot.agents")?,
            "snapshot.agents",
            agent,
        )?,
        workspaces: decoded_array(
            required(item, "workspaces", "snapshot.workspaces")?,
            "snapshot.workspaces",
            workspace,
        )?,
        tabs: decoded_array(
            required(item, "tabs", "snapshot.tabs")?,
            "snapshot.tabs",
            tab,
        )?,
        panes: decoded_array(
            required(item, "panes", "snapshot.panes")?,
            "snapshot.panes",
            pane,
        )?,
        layouts: decoded_array(
            required(item, "layouts", "snapshot.layouts")?,
            "snapshot.layouts",
            pane_layout,
        )?,
    })
}

fn optional_nullable_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, String> {
    match item.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => string_value(value, label).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;

    fn assert_wire_enum<T>(variants: &[(T, &str)])
    where
        T: Copy + std::fmt::Debug + PartialEq + Serialize + DeserializeOwned,
    {
        for (variant, wire) in variants {
            assert_eq!(
                serde_json::to_string(variant).unwrap(),
                format!("\"{wire}\"")
            );
            assert_eq!(
                serde_json::from_str::<T>(&format!("\"{wire}\"")).unwrap(),
                *variant
            );
        }
        assert!(serde_json::from_str::<T>("\"future_value\"").is_err());
    }

    fn workspace_value() -> Value {
        serde_json::json!({
            "workspace_id": "w1", "number": 1, "label": "Workspace", "focused": true,
            "pane_count": 1, "tab_count": 1, "active_tab_id": "t1", "agent_status": "idle"
        })
    }

    fn tab_value() -> Value {
        serde_json::json!({
            "tab_id": "t1", "workspace_id": "w1", "number": 1, "label": "Tab",
            "focused": true, "pane_count": 1, "agent_status": "working"
        })
    }

    fn pane_value() -> Value {
        serde_json::json!({
            "pane_id": "p1", "terminal_id": "term1", "workspace_id": "w1", "tab_id": "t1",
            "focused": true, "agent_status": "blocked", "revision": 4,
            "agent_session": {"source":"herdr:test", "agent":"future-agent", "kind":"path", "value":"/tmp/session"}
        })
    }

    fn agent_value() -> Value {
        serde_json::json!({
            "pane_id": "p1", "terminal_id": "term1", "workspace_id": "w1", "tab_id": "t1",
            "focused": true, "agent_status": "done", "revision": 5
        })
    }

    fn layout_value() -> Value {
        serde_json::json!({
            "workspace_id":"w1", "tab_id":"t1", "zoomed":false,
            "area":{"x":0,"y":0,"width":80,"height":24}, "focused_pane_id":"p1",
            "panes":[{"pane_id":"p1","focused":true,"rect":{"x":0,"y":0,"width":80,"height":24}}],
            "splits":[{"id":"s1","direction":"right","ratio":0.5,"rect":{"x":0,"y":0,"width":80,"height":24}}]
        })
    }

    #[test]
    fn closed_wire_enums_round_trip_and_reject_unknown_values() {
        assert_wire_enum(&[
            (HerdrAgentStatus::Idle, "idle"),
            (HerdrAgentStatus::Working, "working"),
            (HerdrAgentStatus::Blocked, "blocked"),
            (HerdrAgentStatus::Done, "done"),
            (HerdrAgentStatus::Unknown, "unknown"),
        ]);
        assert_wire_enum(&[
            (HerdrAgentSessionKind::Id, "id"),
            (HerdrAgentSessionKind::Path, "path"),
        ]);
        assert_wire_enum(&[
            (HerdrSplitDirection::Right, "right"),
            (HerdrSplitDirection::Down, "down"),
        ]);
        assert_wire_enum(&[
            (HerdrPaneReadSource::Visible, "visible"),
            (HerdrPaneReadSource::Recent, "recent"),
            (HerdrPaneReadSource::RecentUnwrapped, "recent_unwrapped"),
            (HerdrPaneReadSource::Detection, "detection"),
        ]);
        assert_wire_enum(&[
            (HerdrPaneReadFormat::Text, "text"),
            (HerdrPaneReadFormat::Ansi, "ansi"),
        ]);
        assert_wire_enum(&[
            (HerdrPaneZoomReason::SinglePane, "single_pane"),
            (HerdrPaneZoomReason::AlreadyZoomed, "already_zoomed"),
            (HerdrPaneZoomReason::AlreadyUnzoomed, "already_unzoomed"),
        ]);
    }

    #[test]
    fn nested_domain_decoders_retain_enum_types() {
        let pane = pane(&pane_value(), "pane").unwrap();
        assert_eq!(pane.agent_status, HerdrAgentStatus::Blocked);
        assert_eq!(
            pane.agent_session.unwrap().kind,
            HerdrAgentSessionKind::Path
        );

        let layout = pane_layout(&layout_value(), "layout").unwrap();
        assert_eq!(layout.splits[0].direction, HerdrSplitDirection::Right);

        let mut invalid_layout = layout_value();
        invalid_layout["splits"][0]["direction"] = Value::String("left".into());
        assert!(pane_layout(&invalid_layout, "layout").is_err());
        assert!(agent_status(&Value::String("busy".into()), "agent_status").is_err());
    }

    #[test]
    fn live_prompt_read_omits_line_limit_and_recent_reads_preserve_it() {
        // Herdr interprets a supplied zero as an empty, truncated read. Only
        // omitting the limit requests every row of the live question dialog.
        let visible = HerdrControlRequest::PaneReadVisible {
            pane_id: "pane-1".into(),
        };
        let wire: Value = serde_json::from_slice(&visible.encode("inline-read").unwrap()).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "id": "inline-read", "method": "pane.read",
                "params": { "pane_id": "pane-1", "source": "visible", "format": "text", "strip_ansi": true }
            })
        );
        for lines in [0, 80] {
            let recent = HerdrControlRequest::PaneRead {
                pane_id: "pane-1".into(),
                lines,
            };
            let wire: Value =
                serde_json::from_slice(&recent.encode("recent-read").unwrap()).unwrap();
            assert_eq!(
                wire["params"],
                serde_json::json!({
                    "pane_id": "pane-1", "source": "recent", "lines": lines,
                    "format": "ansi", "strip_ansi": false
                })
            );
        }
    }

    #[test]
    fn representative_requests_match_typescript_fixtures() {
        let get = HerdrControlRequest::PaneGet {
            pane_id: "p1".to_owned(),
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&get.encode("scroll").unwrap()).unwrap(),
            serde_json::json!({
                "id": "scroll", "method": "pane.get", "params": {"pane_id": "p1"}
            })
        );
        let mut value = pane_value();
        value["scroll"] = serde_json::json!({"offset_from_bottom": 3, "max_offset_from_bottom": 100, "viewport_rows": 30});
        let response = serde_json::to_vec(
            &serde_json::json!({"id": "scroll", "result": {"type": "pane_info", "pane": value}}),
        )
        .unwrap();
        let HerdrControlResult::PaneInfo { pane } = parse_response(&get, &response).unwrap() else {
            panic!("expected pane_info")
        };
        assert!((pane.scroll.unwrap().offset_from_bottom - 3.0).abs() < f64::EPSILON);
        assert_eq!(
            String::from_utf8(HerdrControlRequest::Ping.encode("android_1").unwrap()).unwrap(),
            "{\"id\":\"android_1\",\"method\":\"ping\",\"params\":{}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::WorkspaceCreate {
                    label: None,
                    cwd: Some("/tmp".into())
                }
                .encode("android_2")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_2\",\"method\":\"workspace.create\",\"params\":{\"label\":null,\"cwd\":\"/tmp\",\"focus\":true}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::PaneSendInput {
                    pane_id: "w1:p1".into(),
                    text: "hello".into(),
                    keys: vec!["enter".into()]
                }
                .encode("android_3")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_3\",\"method\":\"pane.send_input\",\"params\":{\"pane_id\":\"w1:p1\",\"text\":\"hello\",\"keys\":[\"enter\"]}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::PaneSplit {
                    pane_id: "w1:p1".into(),
                    direction: HerdrSplitDirection::Down,
                }
                .encode("android_4")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_4\",\"method\":\"pane.split\",\"params\":{\"target_pane_id\":\"w1:p1\",\"direction\":\"down\",\"focus\":true}}\n"
        );
    }

    #[test]
    fn optional_agent_args_are_omitted_when_empty() {
        let request = HerdrControlRequest::AgentStart {
            name: "codex-1".into(),
            kind: HerdrAgentKind::Codex,
            pane_id: "p1".into(),
            args: vec![],
        };
        let encoded = String::from_utf8(request.encode("android_4").unwrap()).unwrap();
        assert_eq!(
            encoded,
            "{\"id\":\"android_4\",\"method\":\"agent.start\",\"params\":{\"name\":\"codex-1\",\"kind\":\"codex\",\"pane_id\":\"p1\"}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::AgentFocus {
                    target: "codex-1".into()
                }
                .encode("android_5")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_5\",\"method\":\"agent.focus\",\"params\":{\"target\":\"codex-1\"}}\n"
        );
    }

    #[test]
    fn opencode_uses_the_existing_herdr_wire_name() {
        let launch = HerdrControlRequest::AgentStart {
            name: "opencode-1".into(),
            kind: HerdrAgentKind::OpenCode,
            pane_id: "p1".into(),
            args: vec![],
        };
        assert_eq!(
            String::from_utf8(launch.encode("android_6").unwrap()).unwrap(),
            "{\"id\":\"android_6\",\"method\":\"agent.start\",\"params\":{\"name\":\"opencode-1\",\"kind\":\"opencode\",\"pane_id\":\"p1\"}}\n"
        );

        let install = HerdrControlRequest::IntegrationInstall {
            kind: HerdrAgentKind::OpenCode,
        };
        assert_eq!(
            String::from_utf8(install.encode("android_7").unwrap()).unwrap(),
            "{\"id\":\"android_7\",\"method\":\"integration.install\",\"params\":{\"target\":\"opencode\"}}\n"
        );
        assert_eq!(
            serde_json::from_str::<HerdrAgentKind>("\"opencode\"").unwrap(),
            HerdrAgentKind::OpenCode
        );
        assert!(serde_json::from_str::<HerdrAgentKind>("\"open_code\"").is_err());
    }

    #[test]
    fn integration_list_uses_the_socket_schema_and_rejects_wrong_result_types() {
        let request = HerdrControlRequest::IntegrationList;
        assert_eq!(
            String::from_utf8(request.encode("android_8").unwrap()).unwrap(),
            "{\"id\":\"android_8\",\"method\":\"integration.list\",\"params\":{}}\n"
        );
        let response = parse_response(
            &request,
            br#"{"id":"android_8","result":{"type":"integration_list","integrations":[{"target":"codex","label":"Codex","command":"codex","available":true,"state":"current"},{"target":"opencode","label":"OpenCode","command":"opencode","available":true,"state":"outdated"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            response,
            HerdrControlResult::IntegrationList {
                integrations: vec![
                    HerdrIntegrationInfo {
                        target: "codex".to_owned(),
                        label: "Codex".to_owned(),
                        command: "codex".to_owned(),
                        available: true,
                        state: HerdrIntegrationState::Current,
                    },
                    HerdrIntegrationInfo {
                        target: "opencode".to_owned(),
                        label: "OpenCode".to_owned(),
                        command: "opencode".to_owned(),
                        available: true,
                        state: HerdrIntegrationState::Outdated,
                    },
                ],
            }
        );
        assert!(matches!(
            parse_response(&request, br#"{"id":"android_8","result":{"type":"ok"}}"#,),
            Err(HerdrControlError::UnsupportedResponse(_))
        ));
    }

    #[test]
    fn successful_and_error_responses_are_typed() {
        let pong = parse_response(
            &HerdrControlRequest::Ping,
            br#"{"id":"android_1","result":{"type":"pong","version":"1.2.3","protocol":20}}"#,
        )
        .unwrap();
        assert_eq!(
            pong,
            HerdrControlResult::Pong {
                version: "1.2.3".into(),
                protocol: 20,
            }
        );
        assert_eq!(
            parse_response(
                &HerdrControlRequest::Ping,
                br#"{"id":"android_1","error":{"code":"bad_request","message":"No session"}}"#
            ),
            Err(HerdrControlError::ProtocolError(
                "bad_request".into(),
                "No session".into()
            ))
        );
    }

    #[test]
    fn malformed_missing_and_unexpected_responses_are_rejected() {
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, b"{"),
            Err(HerdrControlError::MalformedResponse(_))
        ));
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, br#"{"id":"android_1"}"#),
            Err(HerdrControlError::MalformedResponse(_))
        ));
        assert!(matches!(
            parse_response(
                &HerdrControlRequest::Ping,
                br#"{"result":{"type":"pong","version":"x"}}"#
            ),
            Err(HerdrControlError::InvalidField(_))
        ));
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, br#"{"result":{"type":"ok"}}"#),
            Err(HerdrControlError::UnsupportedResponse(_))
        ));
    }

    #[test]
    fn every_supported_control_result_maps_to_a_data_carrying_variant() {
        let snapshot = serde_json::json!({
            "version":"1.0", "protocol":20,
            "focused_workspace_id":"w1", "focused_tab_id":"t1", "focused_pane_id":"p1",
            "agents":[agent_value()], "workspaces":[workspace_value()], "tabs":[tab_value()],
            "panes":[pane_value()], "layouts":[layout_value()]
        });
        let cases = vec![
            (
                HerdrControlResultKind::Pong,
                serde_json::json!({"version":"1.0","protocol":20}),
            ),
            (
                HerdrControlResultKind::SessionSnapshot,
                serde_json::json!({"snapshot":snapshot}),
            ),
            (
                HerdrControlResultKind::WorkspaceCreated,
                serde_json::json!({"workspace":workspace_value(),"tab":tab_value(),"root_pane":pane_value()}),
            ),
            (
                HerdrControlResultKind::WorkspaceInfo,
                serde_json::json!({"workspace":workspace_value()}),
            ),
            (
                HerdrControlResultKind::TabCreated,
                serde_json::json!({"tab":tab_value(),"root_pane":pane_value()}),
            ),
            (
                HerdrControlResultKind::TabInfo,
                serde_json::json!({"tab":tab_value()}),
            ),
            (
                HerdrControlResultKind::PaneInfo,
                serde_json::json!({"pane":pane_value()}),
            ),
            (
                HerdrControlResultKind::PaneRead,
                serde_json::json!({"read":{
                    "pane_id":"p1","workspace_id":"w1","tab_id":"t1","source":"recent_unwrapped",
                    "format":"ansi","text":"\u{001b}[31mred","revision":8,"truncated":true
                }}),
            ),
            (
                HerdrControlResultKind::AgentStarted,
                serde_json::json!({"agent":agent_value(),"argv":["codex","--resume"]}),
            ),
            (
                HerdrControlResultKind::AgentInfo,
                serde_json::json!({"agent":agent_value()}),
            ),
            (
                HerdrControlResultKind::AgentPrompted,
                serde_json::json!({"agent":agent_value()}),
            ),
            (
                HerdrControlResultKind::PaneZoom,
                serde_json::json!({"zoom":{
                    "changed":false,"zoom_changed":false,"focus_changed":false,"reason":"single_pane",
                    "pane_id":"p1","focused_pane_id":"p1","zoomed":false,"layout":layout_value()
                }}),
            ),
            (
                HerdrControlResultKind::IntegrationInstall,
                serde_json::json!({
                    "target":"codex",
                    "details":{"messages":["installed"]}
                }),
            ),
            (
                HerdrControlResultKind::IntegrationList,
                serde_json::json!({"integrations":[{
                    "target":"codex","label":"Codex","command":"codex",
                    "available":true,"state":"not_installed"
                }]}),
            ),
            (HerdrControlResultKind::Ok, serde_json::json!({})),
        ];
        for (kind, value) in cases {
            let result = decode_result(kind, value.as_object().unwrap()).unwrap();
            let decoded_kind = match result {
                HerdrControlResult::Pong { .. } => HerdrControlResultKind::Pong,
                HerdrControlResult::SessionSnapshot { .. } => {
                    HerdrControlResultKind::SessionSnapshot
                }
                HerdrControlResult::WorkspaceCreated { .. } => {
                    HerdrControlResultKind::WorkspaceCreated
                }
                HerdrControlResult::WorkspaceInfo { .. } => HerdrControlResultKind::WorkspaceInfo,
                HerdrControlResult::TabCreated { .. } => HerdrControlResultKind::TabCreated,
                HerdrControlResult::TabInfo { .. } => HerdrControlResultKind::TabInfo,
                HerdrControlResult::PaneInfo { .. } => HerdrControlResultKind::PaneInfo,
                HerdrControlResult::PaneRead { .. } => HerdrControlResultKind::PaneRead,
                HerdrControlResult::AgentStarted { .. } => HerdrControlResultKind::AgentStarted,
                HerdrControlResult::AgentInfo { .. } => HerdrControlResultKind::AgentInfo,
                HerdrControlResult::AgentPrompted { .. } => HerdrControlResultKind::AgentPrompted,
                HerdrControlResult::IntegrationInstalled { .. } => {
                    HerdrControlResultKind::IntegrationInstall
                }
                HerdrControlResult::IntegrationList { .. } => {
                    HerdrControlResultKind::IntegrationList
                }
                HerdrControlResult::PaneZoom { .. } => HerdrControlResultKind::PaneZoom,
                HerdrControlResult::Ok => HerdrControlResultKind::Ok,
            };
            assert_eq!(decoded_kind, kind);
        }

        let read = decode_result(
            HerdrControlResultKind::PaneRead,
            serde_json::json!({"read":{
                "pane_id":"p1","workspace_id":"w1","tab_id":"t1","source":"detection",
                "format":"text","text":"hello","revision":9,"truncated":false
            }})
            .as_object()
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            read,
            HerdrControlResult::PaneRead { read }
                if read.source == HerdrPaneReadSource::Detection
                    && read.format == HerdrPaneReadFormat::Text
                    && (read.revision - 9.0).abs() < f64::EPSILON
        ));
    }
}
