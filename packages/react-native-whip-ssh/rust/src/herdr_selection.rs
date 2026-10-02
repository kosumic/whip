//! Shared workspace, tab, and pane selection from authoritative snapshots.

pub(crate) fn preferred_workspace_pane<'a>(
    snapshot: &'a crate::herdr_api::HerdrSessionSnapshot,
    workspace_id: &str,
) -> Option<&'a crate::herdr_api::HerdrPaneInfo> {
    let workspace = snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == workspace_id)?;
    let tab = preferred_tab(snapshot, workspace)?;
    preferred_pane(snapshot, tab)
}

pub(crate) fn preferred_tab<'a>(
    snapshot: &'a crate::herdr_api::HerdrSessionSnapshot,
    workspace: &crate::herdr_api::HerdrWorkspaceInfo,
) -> Option<&'a crate::herdr_api::HerdrTabInfo> {
    snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == workspace.workspace_id)
        .find(|tab| tab.tab_id == workspace.active_tab_id)
        .or_else(|| {
            snapshot
                .tabs
                .iter()
                .filter(|tab| tab.workspace_id == workspace.workspace_id)
                .find(|tab| tab.focused)
        })
        .or_else(|| {
            snapshot
                .tabs
                .iter()
                .find(|tab| tab.workspace_id == workspace.workspace_id)
        })
}

pub(crate) fn preferred_pane<'a>(
    snapshot: &'a crate::herdr_api::HerdrSessionSnapshot,
    tab: &crate::herdr_api::HerdrTabInfo,
) -> Option<&'a crate::herdr_api::HerdrPaneInfo> {
    snapshot
        .panes
        .iter()
        .filter(|pane| pane.tab_id == tab.tab_id)
        .find(|pane| pane.focused)
        .or_else(|| snapshot.panes.iter().find(|pane| pane.tab_id == tab.tab_id))
}
