//! Canonical Rust types, shared with Whip's remote FFI declarations.
#[doc(hidden)]
#[macro_export]
macro_rules! herdr_event_type_schema {
    ($apply:ident) => {
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq)]
// UniFFI data-carrying variants keep the JS boundary exhaustive. Boxing the
// records would add allocations to every event without reducing FFI payloads.
#[allow(
    clippy::large_enum_variant,
    reason = "boxing UniFFI event payloads would add allocations without reducing FFI payload size"
)]
pub enum HerdrEvent {
    WorkspaceCreated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceMetadataUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceClosed {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
    },
    WorkspaceRenamed {
        workspace_id: String,
        label: String,
    },
    WorkspaceMoved {
        workspace_id: String,
        insert_index: f64,
        workspaces: Vec<HerdrWorkspaceInfo>,
    },
    WorkspaceReordered {
        workspace_ids: Vec<String>,
        workspaces: Vec<HerdrWorkspaceInfo>,
        before_workspace_id: Option<String>,
    },
    WorkspaceFocused {
        workspace_id: String,
    },
    WorktreeCreated {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
    },
    WorktreeOpened {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
        already_open: bool,
    },
    WorktreeRemoved {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
        worktree: HerdrWorktreeInfo,
        forced: bool,
    },
    TabCreated {
        tab: HerdrTabInfo,
    },
    TabClosed {
        workspace_id: String,
        tab_id: String,
    },
    TabFocused {
        workspace_id: String,
        tab_id: String,
    },
    TabRenamed {
        workspace_id: String,
        tab_id: String,
        label: String,
    },
    TabMoved {
        workspace_id: String,
        tab_id: String,
        insert_index: f64,
        tabs: Vec<HerdrTabInfo>,
    },
    PaneCreated {
        pane: HerdrPaneInfo,
    },
    PaneUpdated {
        pane: HerdrPaneInfo,
    },
    PaneClosed {
        workspace_id: String,
        pane_id: String,
    },
    PaneFocused {
        workspace_id: String,
        pane_id: String,
    },
    PaneExited {
        workspace_id: String,
        pane_id: String,
    },
    PaneMoved {
        previous_pane_id: String,
        previous_workspace_id: String,
        previous_tab_id: String,
        pane: HerdrPaneInfo,
        created_workspace: Option<HerdrWorkspaceInfo>,
        created_tab: Option<HerdrTabInfo>,
        closed_workspace_id: Option<String>,
        closed_tab_id: Option<String>,
    },
    PaneOutputChanged {
        workspace_id: String,
        pane_id: String,
        revision: f64,
    },
    PaneScrollChanged {
        workspace_id: String,
        pane_id: String,
        scroll: HerdrPaneScrollInfo,
    },
    PaneAgentDetected {
        workspace_id: String,
        pane_id: String,
        agent: Option<String>,
        released: bool,
        final_status: Option<HerdrAgentStatus>,
    },
    PaneAgentStatusChanged {
        workspace_id: String,
        pane_id: String,
        agent_status: HerdrAgentStatus,
        agent: Option<String>,
        title: Option<String>,
        display_agent: Option<String>,
        state_labels: Option<HashMap<String, String>>,
    },
    LayoutUpdated {
        layout: HerdrPaneLayoutSnapshot,
    },
    ProtocolUnknown {
        raw_event: String,
    },
    ProtocolInvalid {
        raw_event: String,
        reason: String,
    },
}

        );
    };
}
