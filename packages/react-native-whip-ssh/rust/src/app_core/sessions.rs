use std::sync::Arc;

use parking_lot::Mutex;

use super::terminal_rail::{TerminalRail, TerminalRailView};
use crate::host_runtime::{HostConnectionState, HostRuntime};
use crate::host_state::{HostFreshness, HostStateSnapshot};

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AppConnectionStatus {
    Connecting,
    Connected,
    Ready,
    Reconnecting,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct SessionSelection {
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AppSessionView {
    pub id: String,
    pub host_id: String,
    pub connection_status: AppConnectionStatus,
    pub connection_error: Option<String>,
    pub reconnect_attempt: u32,
    pub selection: SessionSelection,
    pub host_state: Option<HostStateSnapshot>,
    pub terminal_rail: TerminalRailView,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AppCoreView {
    pub revision: u64,
    pub sessions: Vec<AppSessionView>,
    pub active_session_id: Option<String>,
}

pub(super) struct AppSession {
    pub(super) id: String,
    pub(super) host_id: String,
    runtime: Option<Arc<HostRuntime>>,
    cached_host_state: Option<HostStateSnapshot>,
    placeholder_status: AppConnectionStatus,
    placeholder_error: Option<String>,
    placeholder_reconnect_attempt: u32,
    selection: SessionSelection,
    observed_host_revision: u64,
    terminal_rail: TerminalRail,
}

impl AppSession {
    fn host_state(&self) -> Option<HostStateSnapshot> {
        let live = self.runtime.as_ref().map(|runtime| runtime.host_state());
        self.host_state_with_cache(live)
    }

    fn host_state_with_cache(&self, live: Option<HostStateSnapshot>) -> Option<HostStateSnapshot> {
        if live.as_ref().is_some_and(|state| state.snapshot.is_some()) {
            live
        } else {
            self.cached_host_state.clone().or(live)
        }
    }

    pub(super) fn view(&self) -> AppSessionView {
        let live_host_state = self.runtime.as_ref().map(|runtime| runtime.host_state());
        let ready = live_host_state.as_ref().is_some_and(|state| {
            matches!(
                state.freshness,
                HostFreshness::Fresh | HostFreshness::Unavailable
            )
        });
        let host_state = self.host_state_with_cache(live_host_state);
        let (connection_status, connection_error, reconnect_attempt) =
            self.runtime.as_ref().map_or_else(
                || {
                    (
                        self.placeholder_status,
                        self.placeholder_error.clone(),
                        self.placeholder_reconnect_attempt,
                    )
                },
                |runtime| {
                    let status = runtime.status();
                    let connection_status = match status.state {
                        HostConnectionState::Disconnected | HostConnectionState::Disconnecting => {
                            AppConnectionStatus::Disconnected
                        }
                        HostConnectionState::Connecting => AppConnectionStatus::Connecting,
                        HostConnectionState::Connected => {
                            if ready {
                                AppConnectionStatus::Ready
                            } else {
                                AppConnectionStatus::Connected
                            }
                        }
                        HostConnectionState::Reconnecting => AppConnectionStatus::Reconnecting,
                        HostConnectionState::Failed => AppConnectionStatus::Error,
                    };
                    (connection_status, status.error, status.reconnect_attempt)
                },
            );
        AppSessionView {
            id: self.id.clone(),
            host_id: self.host_id.clone(),
            connection_status,
            connection_error,
            reconnect_attempt,
            selection: self.selection.clone(),
            host_state,
            terminal_rail: self.terminal_rail.view(),
        }
    }

    fn reconcile_selection(&mut self) -> bool {
        let Some(runtime) = &self.runtime else {
            return false;
        };
        let host_state = runtime.host_state();
        self.reconcile_host_state(&host_state)
    }

    fn reconcile_host_state(&mut self, host_state: &HostStateSnapshot) -> bool {
        if host_state.revision <= self.observed_host_revision {
            return false;
        }
        self.observed_host_revision = host_state.revision;
        let Some(snapshot) = host_state.snapshot.as_ref() else {
            return true;
        };
        self.cached_host_state = None;
        self.terminal_rail.reconcile(snapshot);
        if !valid_selection(snapshot, &self.selection) {
            let selection = server_focus_selection(snapshot);
            if self.selection != selection {
                self.selection = selection;
            }
        }
        // HostState is part of every app/Herd projection. A newer host revision
        // invalidates it even when selection and terminal titles did not change.
        true
    }
}

#[derive(Default)]
pub(super) struct AppCoreState {
    pub(super) revision: u64,
    pub(super) sessions: Vec<AppSession>,
    active_session_id: Option<String>,
}

impl AppCoreState {
    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    pub(super) fn reconcile_selections(&mut self) {
        let mut changed = false;
        for session in &mut self.sessions {
            // Reconcile every host; Iterator::any would skip later hosts once
            // the first changed host returned true.
            changed |= session.reconcile_selection();
        }
        if changed {
            self.bump_revision();
        }
    }

    fn view(&mut self) -> AppCoreView {
        self.reconcile_selections();
        AppCoreView {
            revision: self.revision,
            sessions: self.sessions.iter().map(AppSession::view).collect(),
            active_session_id: self.active_session_id.clone(),
        }
    }
}

/// Application/session state. Herdr truth remains owned by each referenced `HostRuntime`.
#[derive(uniffi::Object)]
pub struct AppCore {
    state: Mutex<AppCoreState>,
}

#[uniffi::export]
impl AppCore {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(AppCoreState::default()),
        })
    }

    pub fn view(&self) -> AppCoreView {
        self.state.lock().view()
    }

    pub fn herd_view(
        &self,
        metadata: Vec<super::HerdSessionMetadata>,
        requested_host_id: Option<String>,
        requested_workspace_id: Option<String>,
    ) -> super::HerdView {
        super::herd::project(
            &mut self.state.lock(),
            metadata,
            requested_host_id,
            requested_workspace_id,
        )
    }

    pub fn open_session(&self, session_id: String, host_id: String, activate: bool) -> AppCoreView {
        let mut state = self.state.lock();
        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        {
            session.host_id = host_id;
            session.placeholder_status = AppConnectionStatus::Connecting;
            session.placeholder_error = None;
            session.placeholder_reconnect_attempt = 0;
        } else {
            state.sessions.push(AppSession {
                id: session_id.clone(),
                host_id,
                runtime: None,
                cached_host_state: None,
                placeholder_status: AppConnectionStatus::Connecting,
                placeholder_error: None,
                placeholder_reconnect_attempt: 0,
                selection: SessionSelection::default(),
                observed_host_revision: 0,
                terminal_rail: TerminalRail::default(),
            });
        }
        if activate {
            state.active_session_id = Some(session_id);
        }
        state.bump_revision();
        state.view()
    }

    pub fn attach_runtime(&self, session_id: String, runtime: Arc<HostRuntime>) -> AppCoreView {
        let mut state = self.state.lock();
        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        {
            session.runtime = Some(runtime);
            session.observed_host_revision = 0;
            state.bump_revision();
        }
        state.view()
    }

    /// Cache metadata is only a stale fallback; a runtime snapshot always wins.
    pub fn restore_cached_host(&self, session_id: String, cache_blob: String) -> AppCoreView {
        let mut state = self.state.lock();
        let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return state.view();
        };
        if session
            .host_state()
            .is_some_and(|state| state.snapshot.is_some())
        {
            return state.view();
        }
        let Some(cached) = super::offline::decode(&cache_blob) else {
            return state.view();
        };
        if let Some(snapshot) = &cached.snapshot {
            session.selection = server_focus_selection(snapshot);
            session.terminal_rail.seed_cached(snapshot);
        }
        session.cached_host_state = Some(cached);
        state.bump_revision();
        state.view()
    }

    pub fn detach_runtime(&self, session_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        {
            session.runtime = None;
            session.observed_host_revision = 0;
            state.bump_revision();
        }
        state.view()
    }

    pub fn set_placeholder_connection(
        &self,
        session_id: String,
        status: AppConnectionStatus,
        error: Option<String>,
        reconnect_attempt: Option<u32>,
    ) -> AppCoreView {
        let mut state = self.state.lock();
        if let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        {
            session.placeholder_status = status;
            session.placeholder_error = error;
            if let Some(reconnect_attempt) = reconnect_attempt {
                session.placeholder_reconnect_attempt = reconnect_attempt;
            } else if matches!(
                status,
                AppConnectionStatus::Connected | AppConnectionStatus::Ready
            ) {
                session.placeholder_reconnect_attempt = 0;
            }
            state.bump_revision();
        }
        state.view()
    }

    pub fn select_session(&self, session_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        if state.active_session_id.as_deref() != Some(session_id.as_str())
            && state
                .sessions
                .iter()
                .any(|session| session.id == session_id)
        {
            state.active_session_id = Some(session_id);
            state.bump_revision();
        }
        state.view()
    }

    pub fn select_host(&self, host_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        if let Some(session_id) = state
            .sessions
            .iter()
            .rev()
            .find(|session| session.host_id == host_id)
            .map(|session| session.id.clone())
            && state.active_session_id.as_deref() != Some(session_id.as_str())
        {
            state.active_session_id = Some(session_id);
            state.bump_revision();
        }
        state.view()
    }

    pub fn close_session(&self, session_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        let Some(index) = state
            .sessions
            .iter()
            .position(|session| session.id == session_id)
        else {
            return state.view();
        };
        state.sessions.remove(index);
        if state.active_session_id.as_deref() == Some(session_id.as_str()) {
            state.active_session_id = state.sessions.last().map(|session| session.id.clone());
        }
        state.bump_revision();
        state.view()
    }

    pub fn select_workspace_view(&self, session_id: String, workspace_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return state.view();
        };
        let Some(snapshot) = session.host_state().and_then(|state| state.snapshot) else {
            return state.view();
        };
        let Some(workspace) = snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
        else {
            return state.view();
        };
        let pane = preferred_workspace_pane(&snapshot, &workspace_id);
        let selection = SessionSelection {
            workspace_id: Some(workspace_id),
            tab_id: pane
                .map(|pane| pane.tab_id.clone())
                .or_else(|| Some(workspace.active_tab_id.clone()).filter(|id| !id.is_empty())),
            pane_id: pane.map(|pane| pane.pane_id.clone()),
        };
        if session.selection != selection {
            session.selection = selection;
            state.bump_revision();
        }
        state.view()
    }

    pub fn restore_terminals(
        &self,
        session_id: String,
        resume_blob: Option<String>,
    ) -> AppCoreView {
        let mut state = self.state.lock();
        let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return state.view();
        };
        let snapshot = session.host_state().and_then(|state| state.snapshot);
        let current_active = session.terminal_rail.view().active_terminal_id;
        if let Some(snapshot) = snapshot {
            session
                .terminal_rail
                .restore_blob(resume_blob.as_deref(), &snapshot);
            if let Some(pane) = current_active.and_then(|active| {
                snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.terminal_id == active)
            }) {
                session.terminal_rail.open_pane(pane);
            }
            if session.cached_host_state.is_some() {
                session.terminal_rail.mark_cached();
            }
        } else {
            session.terminal_rail.defer_restore(resume_blob.as_deref());
        }
        state.bump_revision();
        state.view()
    }

    pub fn open_pane_terminal(&self, session_id: String, pane_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        let Some(session) = state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
        else {
            return state.view();
        };
        let pane = session
            .host_state()
            .and_then(|state| state.snapshot)
            .and_then(|snapshot| {
                snapshot
                    .panes
                    .into_iter()
                    .find(|pane| pane.pane_id == pane_id)
            });
        if let Some(pane) = pane {
            let selection = SessionSelection {
                workspace_id: Some(pane.workspace_id.clone()),
                tab_id: Some(pane.tab_id.clone()),
                pane_id: Some(pane.pane_id.clone()),
            };
            let changed = session.terminal_rail.open_pane(&pane) || session.selection != selection;
            session.selection = selection;
            if session.cached_host_state.is_some() {
                session.terminal_rail.mark_cached();
            }
            if changed {
                state.bump_revision();
            }
        }
        state.view()
    }

    pub fn open_ssh_shell(&self, session_id: String, title: String) -> AppCoreView {
        let mut state = self.state.lock();
        if state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .is_some_and(|session| session.terminal_rail.open_ssh_shell(title))
        {
            state.bump_revision();
        }
        state.view()
    }

    pub fn close_terminal(&self, session_id: String, terminal_id: String) -> AppCoreView {
        let mut state = self.state.lock();
        if state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .is_some_and(|session| session.terminal_rail.close(&terminal_id))
        {
            state.bump_revision();
        }
        state.view()
    }

    pub fn update_terminal_lifecycle(
        &self,
        session_id: String,
        terminal_id: String,
        terminal_state: crate::host_runtime::HostTerminalState,
        retrying: bool,
        error: Option<String>,
        reconnect_attempt: u32,
    ) -> AppCoreView {
        let mut state = self.state.lock();
        if state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .is_some_and(|session| {
                session.terminal_rail.update_lifecycle(
                    &terminal_id,
                    terminal_state,
                    retrying,
                    error,
                    reconnect_attempt,
                )
            })
        {
            state.bump_revision();
        }
        state.view()
    }
}

fn valid_selection(
    snapshot: &crate::herdr_api::HerdrSessionSnapshot,
    selection: &SessionSelection,
) -> bool {
    let Some(workspace_id) = selection.workspace_id.as_deref() else {
        return snapshot.workspaces.is_empty();
    };
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.workspace_id == workspace_id)
    {
        return false;
    }
    let Some(tab_id) = selection.tab_id.as_deref() else {
        return !snapshot
            .tabs
            .iter()
            .any(|tab| tab.workspace_id == workspace_id);
    };
    if !snapshot
        .tabs
        .iter()
        .any(|tab| tab.tab_id == tab_id && tab.workspace_id == workspace_id)
    {
        return false;
    }
    let Some(pane_id) = selection.pane_id.as_deref() else {
        return !snapshot.panes.iter().any(|pane| pane.tab_id == tab_id);
    };
    snapshot
        .panes
        .iter()
        .any(|pane| pane.pane_id == pane_id && pane.tab_id == tab_id)
}

fn server_focus_selection(snapshot: &crate::herdr_api::HerdrSessionSnapshot) -> SessionSelection {
    let workspace = snapshot
        .focused_workspace_id
        .as_deref()
        .and_then(|id| {
            snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == id)
        })
        .or_else(|| {
            snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.focused)
        })
        .or_else(|| snapshot.workspaces.first());
    let Some(workspace) = workspace else {
        return SessionSelection::default();
    };
    let tab = snapshot
        .focused_tab_id
        .as_deref()
        .and_then(|id| {
            snapshot
                .tabs
                .iter()
                .find(|tab| tab.tab_id == id && tab.workspace_id == workspace.workspace_id)
        })
        .or_else(|| preferred_tab(snapshot, workspace));
    let Some(tab) = tab else {
        return SessionSelection {
            workspace_id: Some(workspace.workspace_id.clone()),
            tab_id: None,
            pane_id: None,
        };
    };
    let pane = snapshot
        .focused_pane_id
        .as_deref()
        .and_then(|id| {
            snapshot
                .panes
                .iter()
                .find(|pane| pane.pane_id == id && pane.tab_id == tab.tab_id)
        })
        .or_else(|| preferred_pane(snapshot, tab));
    SessionSelection {
        workspace_id: Some(workspace.workspace_id.clone()),
        tab_id: Some(tab.tab_id.clone()),
        pane_id: pane.map(|pane| pane.pane_id.clone()),
    }
}

fn preferred_workspace_pane<'a>(
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

fn preferred_tab<'a>(
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

fn preferred_pane<'a>(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, host_id: &str) -> AppSession {
        AppSession {
            id: id.to_owned(),
            host_id: host_id.to_owned(),
            runtime: None,
            cached_host_state: None,
            placeholder_status: AppConnectionStatus::Connecting,
            placeholder_error: None,
            placeholder_reconnect_attempt: 0,
            selection: SessionSelection::default(),
            observed_host_revision: 0,
            terminal_rail: TerminalRail::default(),
        }
    }

    #[test]
    fn selecting_host_uses_newest_matching_session() {
        let core = AppCore::new();
        core.open_session("first".to_owned(), "host".to_owned(), true);
        core.open_session("other".to_owned(), "other".to_owned(), true);
        core.open_session("newest".to_owned(), "host".to_owned(), false);

        let view = core.select_host("host".to_owned());

        assert_eq!(view.active_session_id.as_deref(), Some("newest"));
    }

    #[test]
    fn opening_existing_session_resets_placeholder_connection() {
        let core = AppCore::new();
        core.open_session("live".to_owned(), "old".to_owned(), true);
        core.set_placeholder_connection(
            "live".to_owned(),
            AppConnectionStatus::Error,
            Some("failed".to_owned()),
            Some(3),
        );

        let view = core.open_session("live".to_owned(), "new".to_owned(), false);

        assert_eq!(view.sessions.len(), 1);
        assert_eq!(view.sessions[0].host_id, "new");
        assert_eq!(
            view.sessions[0].connection_status,
            AppConnectionStatus::Connecting
        );
        assert_eq!(view.sessions[0].connection_error, None);
        assert_eq!(view.sessions[0].reconnect_attempt, 0);
    }

    #[test]
    fn closing_active_session_selects_last_survivor() {
        let core = AppCore::new();
        core.open_session("one".to_owned(), "one".to_owned(), true);
        core.open_session("two".to_owned(), "two".to_owned(), true);
        core.open_session("three".to_owned(), "three".to_owned(), true);

        let view = core.close_session("three".to_owned());

        assert_eq!(view.active_session_id.as_deref(), Some("two"));
        assert_eq!(
            view.sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
    }

    #[test]
    fn closing_inactive_and_missing_sessions_preserves_active_session() {
        let core = AppCore::new();
        core.open_session("one".to_owned(), "one".to_owned(), true);
        core.open_session("two".to_owned(), "two".to_owned(), true);

        let inactive_closed = core.close_session("one".to_owned());
        let missing_closed = core.close_session("missing".to_owned());

        assert_eq!(inactive_closed.active_session_id.as_deref(), Some("two"));
        assert_eq!(missing_closed.active_session_id.as_deref(), Some("two"));
        assert_eq!(missing_closed.sessions.len(), 1);
    }

    #[test]
    fn no_surviving_session_clears_active_session() {
        let core = AppCore::new();
        core.open_session("only".to_owned(), "host".to_owned(), true);

        let view = core.close_session("only".to_owned());

        assert!(view.sessions.is_empty());
        assert_eq!(view.active_session_id, None);
    }

    #[test]
    fn placeholder_connection_resets_attempt_after_ready() {
        let core = AppCore::new();
        core.open_session("live".to_owned(), "host".to_owned(), true);
        core.set_placeholder_connection(
            "live".to_owned(),
            AppConnectionStatus::Reconnecting,
            Some("lost".to_owned()),
            Some(2),
        );

        let view = core.set_placeholder_connection(
            "live".to_owned(),
            AppConnectionStatus::Ready,
            None,
            None,
        );

        assert_eq!(view.sessions[0].reconnect_attempt, 0);
    }

    #[test]
    fn default_state_has_no_sessions() {
        let mut state = AppCoreState::default();
        assert_eq!(
            state.view(),
            AppCoreView {
                revision: 0,
                sessions: Vec::new(),
                active_session_id: None,
            }
        );
    }

    #[test]
    fn app_session_fixture_is_disconnected_from_runtime_truth() {
        let value = session("one", "host");
        assert_eq!(value.view().host_state, None);
    }

    fn cached_core() -> Arc<AppCore> {
        let core = AppCore::new();
        core.open_session("live".to_owned(), "host".to_owned(), true);
        core.restore_cached_host(
            "live".to_owned(),
            super::super::offline::fixture().to_string(),
        );
        core
    }

    #[test]
    fn offline_cache_projects_through_the_same_session_and_herd_views() {
        let core = cached_core();
        let view = core.view();
        let session = &view.sessions[0];
        assert_eq!(session.connection_status, AppConnectionStatus::Connecting);
        assert_eq!(
            session.host_state.as_ref().unwrap().freshness,
            HostFreshness::Stale
        );
        assert_eq!(session.terminal_rail.terminals.len(), 2);
        assert!(
            session
                .terminal_rail
                .terminals
                .iter()
                .all(|terminal| { terminal.state == super::super::TerminalUiState::Disconnected })
        );
        let herd = core.herd_view(Vec::new(), None, None);
        assert!(!herd.hosts[0].connected);
        assert!(herd.hosts[0].running);
        assert_eq!(herd.hosts[0].tabs.len(), 1);
    }

    #[test]
    fn offline_selection_survives_resume_restore_and_live_metadata_reconciliation() {
        let core = cached_core();
        core.open_pane_terminal("live".to_owned(), "two".to_owned());
        let view = core.restore_terminals(
            "live".to_owned(),
            Some(
                r#"{"version":1,"terminalIds":["terminal-one"],"activeTerminalId":"terminal-one"}"#
                    .to_owned(),
            ),
        );
        assert_eq!(view.sessions[0].selection.pane_id.as_deref(), Some("two"));
        assert_eq!(
            view.sessions[0].terminal_rail.active_terminal_id.as_deref(),
            Some("terminal-two")
        );

        let mut state = core.state.lock();
        let session = &mut state.sessions[0];
        let mut live = session.host_state().unwrap();
        live.revision = 1;
        live.freshness = HostFreshness::Fresh;
        live.snapshot.as_mut().unwrap().panes[1].label = Some("Renamed".to_owned());
        assert!(session.reconcile_host_state(&live));
        assert!(session.cached_host_state.is_none());
        assert_eq!(session.selection.pane_id.as_deref(), Some("two"));
        assert_eq!(session.terminal_rail.view().terminals[1].title, "Renamed");
    }

    #[test]
    fn fresh_snapshot_removes_missing_cached_panes_and_validates_selection() {
        let core = cached_core();
        core.open_pane_terminal("live".to_owned(), "two".to_owned());
        let mut state = core.state.lock();
        let session = &mut state.sessions[0];
        let mut live = session.host_state().unwrap();
        live.revision = 1;
        live.snapshot.as_mut().unwrap().panes.pop();
        session.reconcile_host_state(&live);
        assert_eq!(session.selection.pane_id.as_deref(), Some("one"));
        assert_eq!(session.terminal_rail.view().terminals.len(), 1);
    }

    #[test]
    fn late_cache_loads_cannot_replace_a_hydrated_or_closed_session() {
        let core = cached_core();
        core.open_pane_terminal("live".to_owned(), "two".to_owned());
        let original = core.view();
        let mut cache = super::super::offline::fixture();
        cache["snapshot"]["panes"][1]["label"] = "Older".into();
        assert_eq!(
            core.restore_cached_host("live".to_owned(), cache.to_string()),
            original
        );
        core.close_session("live".to_owned());
        assert!(
            core.restore_cached_host("live".to_owned(), cache.to_string())
                .sessions
                .is_empty()
        );
    }

    #[test]
    fn runtime_metadata_wins_over_cache_even_when_the_live_snapshot_is_empty() {
        let core = cached_core();
        let state = core.state.lock();
        let session = &state.sessions[0];
        let mut live = session.host_state().unwrap();
        live.revision = 1;
        live.freshness = HostFreshness::Fresh;
        let snapshot = live.snapshot.as_mut().unwrap();
        snapshot.panes.clear();
        snapshot.tabs.clear();
        snapshot.workspaces.clear();
        let projected = session.host_state_with_cache(Some(live));
        assert_eq!(projected.as_ref().unwrap().freshness, HostFreshness::Fresh);
        assert!(projected.unwrap().snapshot.unwrap().panes.is_empty());
    }
}
