//! Semantic Herdr workspace actions and workspace-opening orchestration.

use std::future::Future;

use super::*;
use crate::herdr_api::{HerdrControlError, HerdrControlRequest, HerdrControlResult};
use crate::herdr_selection::preferred_workspace_pane;

pub(super) async fn focus_and_refresh_workspace<F, R>(
    workspace_id: String,
    focus: impl FnOnce(HerdrControlRequest) -> F,
    refresh: impl FnOnce() -> R,
) -> Result<Option<HerdrPaneInfo>, HerdrControlError>
where
    F: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
    R: Future<Output = HostStateSnapshot>,
{
    focus(HerdrControlRequest::WorkspaceFocus {
        workspace_id: workspace_id.clone(),
    })
    .await?;
    let state = refresh().await;
    if state.sync_status == HostSyncStatus::Error {
        return Ok(None);
    }
    Ok(state
        .snapshot
        .as_ref()
        .and_then(|snapshot| preferred_workspace_pane(snapshot, &workspace_id))
        .cloned())
}

#[uniffi::export]
impl HostRuntime {
    pub async fn rename_workspace(
        &self,
        workspace_id: String,
        name: String,
    ) -> Result<(), HerdrControlError> {
        self.control_request(HerdrControlRequest::WorkspaceRename {
            workspace_id,
            label: name,
        })
        .await?;
        Ok(())
    }

    pub async fn close_workspace(&self, workspace_id: String) -> Result<(), HerdrControlError> {
        self.control_request(HerdrControlRequest::WorkspaceClose { workspace_id })
            .await?;
        Ok(())
    }

    pub async fn close_tab(&self, tab_id: String) -> Result<(), HerdrControlError> {
        self.control_request(HerdrControlRequest::TabClose { tab_id })
            .await?;
        Ok(())
    }

    /// Open known panes immediately, including while reconnecting. An empty
    /// workspace needs an explicit focus and authoritative refresh first.
    pub async fn open_workspace(
        &self,
        workspace_id: String,
    ) -> Result<Option<HerdrPaneInfo>, HerdrControlError> {
        let (projection, connected) = {
            let state = self.inner.state.lock();
            let projection = state.host_state.projection();
            let connected = state.connection == HostConnectionState::Connected;
            drop(state);
            (projection, connected)
        };
        let pane = projection
            .snapshot
            .as_ref()
            .and_then(|snapshot| preferred_workspace_pane(snapshot, &workspace_id))
            .cloned();
        let ready = connected
            && matches!(
                projection.freshness,
                HostFreshness::Fresh | HostFreshness::Unavailable
            );
        let runtime = crate::runtime().map_err(HerdrControlError::TransportDisconnected)?;
        if let Some(pane) = pane {
            if ready {
                let inner = self.inner.clone();
                let pane_id = pane.pane_id.clone();
                runtime.spawn(async move {
                    // Control requests own transport recovery; background focus
                    // must not delay opening the local terminal view.
                    let _ =
                        control_request_inner(inner, HerdrControlRequest::PaneFocus { pane_id })
                            .await;
                });
            }
            return Ok(Some(pane));
        }

        let inner = self.inner.clone();
        runtime
            .spawn(async move {
                let focus_inner = inner.clone();
                focus_and_refresh_workspace(
                    workspace_id,
                    |request| control_request_inner(focus_inner, request),
                    || refresh_host_state_inner(inner),
                )
                .await
            })
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("workspace open task failed: {error}"))
            })?
    }
}
