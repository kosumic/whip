//! Authoritative connected-host Herdr domain state.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::herdr_api::{
    HerdrAgentInfo, HerdrAgentStatus, HerdrControlRequest, HerdrControlResult, HerdrPaneInfo,
    HerdrPaneLayoutSnapshot, HerdrSessionSnapshot, HerdrTabInfo, HerdrWorkspaceInfo,
};
use crate::herdr_events::HerdrEvent;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostSyncStatus {
    Idle,
    Syncing,
    Synced,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostFreshness {
    Loading,
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostServerFocus {
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HostStateSnapshot {
    pub revision: u64,
    pub connection_generation: u64,
    pub sync_generation: u64,
    pub sync_status: HostSyncStatus,
    pub freshness: HostFreshness,
    pub error: Option<String>,
    pub last_synced_at_ms: Option<u64>,
    pub last_event_at_ms: Option<u64>,
    pub needs_resync: bool,
    pub focus: HostServerFocus,
    pub snapshot: Option<HerdrSessionSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentStatusTransition {
    pub pane_id: String,
    pub previous: Option<HerdrAgentStatus>,
    pub current: Option<HerdrAgentStatus>,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SnapshotToken {
    pub connection_generation: u64,
    pub sync_generation: u64,
}

#[derive(Clone, Debug)]
struct ActiveSync {
    token: SnapshotToken,
    buffered_events: Vec<HerdrEvent>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ApplyResult {
    Applied,
    IgnoredStale,
    NeedsResync(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ControlProjection {
    Unchanged,
    Applied,
    AppliedNeedsResync(String),
}

#[derive(Debug)]
pub(crate) struct HostState {
    revision: u64,
    connection_generation: u64,
    sync_generation: u64,
    sync_status: HostSyncStatus,
    freshness: HostFreshness,
    error: Option<String>,
    last_synced_at_ms: Option<u64>,
    last_event_at_ms: Option<u64>,
    needs_resync: bool,
    resync_running: bool,
    snapshot: Option<HerdrSessionSnapshot>,
    active_sync: Option<ActiveSync>,
    locally_closed_pane_ids: HashSet<String>,
    agent_statuses: HashMap<String, HerdrAgentStatus>,
    pending_agent_transitions: Vec<AgentStatusTransition>,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            revision: 0,
            connection_generation: 0,
            sync_generation: 0,
            sync_status: HostSyncStatus::Idle,
            freshness: HostFreshness::Loading,
            error: None,
            last_synced_at_ms: None,
            last_event_at_ms: None,
            needs_resync: false,
            resync_running: false,
            snapshot: None,
            active_sync: None,
            locally_closed_pane_ids: HashSet::new(),
            agent_statuses: HashMap::new(),
            pending_agent_transitions: Vec::new(),
        }
    }
}

impl HostState {
    pub(crate) fn projection(&self) -> HostStateSnapshot {
        let focus = self.snapshot.as_ref().map_or(
            HostServerFocus {
                workspace_id: None,
                tab_id: None,
                pane_id: None,
            },
            |snapshot| HostServerFocus {
                workspace_id: snapshot.focused_workspace_id.clone(),
                tab_id: snapshot.focused_tab_id.clone(),
                pane_id: snapshot.focused_pane_id.clone(),
            },
        );
        HostStateSnapshot {
            revision: self.revision,
            connection_generation: self.connection_generation,
            sync_generation: self.sync_generation,
            sync_status: self.sync_status,
            freshness: self.freshness,
            error: self.error.clone(),
            last_synced_at_ms: self.last_synced_at_ms,
            last_event_at_ms: self.last_event_at_ms,
            needs_resync: self.needs_resync,
            focus,
            snapshot: self.snapshot.clone(),
        }
    }

    pub(crate) fn terminal_id_for_pane(&self, pane_id: &str) -> Option<String> {
        self.snapshot
            .as_ref()?
            .panes
            .iter()
            .find(|pane| pane.pane_id == pane_id)
            .map(|pane| pane.terminal_id.clone())
    }

    pub(crate) fn connection_installed(&mut self, generation: u64) {
        self.connection_generation = generation;
        self.active_sync = None;
        self.resync_running = false;
        self.needs_resync = true;
        self.error = None;
        self.freshness = if self.snapshot.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Loading
        };
        self.bump_revision();
    }

    pub(crate) fn mark_reconnecting(&mut self, reason: String) {
        self.active_sync = None;
        self.resync_running = false;
        self.needs_resync = true;
        self.error = Some(reason);
        self.freshness = if self.snapshot.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Unavailable
        };
        self.bump_revision();
    }

    pub(crate) fn mark_disconnected(&mut self) {
        self.active_sync = None;
        self.resync_running = false;
        self.needs_resync = false;
        self.sync_status = HostSyncStatus::Idle;
        self.freshness = HostFreshness::Unavailable;
        self.bump_revision();
    }

    pub(crate) fn begin_sync(&mut self, connection_generation: u64) -> SnapshotToken {
        self.sync_generation = self.sync_generation.saturating_add(1);
        let token = SnapshotToken {
            connection_generation,
            sync_generation: self.sync_generation,
        };
        self.active_sync = Some(ActiveSync {
            token,
            buffered_events: Vec::new(),
        });
        self.sync_status = HostSyncStatus::Syncing;
        self.error = None;
        self.freshness = if self.snapshot.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Loading
        };
        self.bump_revision();
        token
    }

    pub(crate) fn complete_sync(
        &mut self,
        token: SnapshotToken,
        mut snapshot: HerdrSessionSnapshot,
        now_ms: u64,
    ) -> ApplyResult {
        let Some(active) = self.active_sync.take() else {
            return ApplyResult::IgnoredStale;
        };
        if active.token != token || token.connection_generation != self.connection_generation {
            self.active_sync = Some(active);
            return ApplyResult::IgnoredStale;
        }
        if let Err(reason) = validate_snapshot(&snapshot) {
            return self.fail_sync(token, reason);
        }
        normalize_snapshot(&mut snapshot);
        let mut replay_error = None;
        for event in active.buffered_events {
            if let HerdrEvent::PaneClosed { pane_id, .. } = &event {
                self.locally_closed_pane_ids.remove(pane_id);
            } else if event_references_closed_pane(&event, &self.locally_closed_pane_ids) {
                continue;
            }
            if let Err(reason) = apply_event_transactional(&mut snapshot, &event) {
                replay_error.get_or_insert(reason);
            }
        }
        self.locally_closed_pane_ids.clear();
        self.snapshot = Some(snapshot);
        self.sync_status = HostSyncStatus::Synced;
        self.last_synced_at_ms = Some(now_ms);
        self.error.clone_from(&replay_error);
        self.needs_resync = replay_error.is_some();
        self.resync_running = false;
        self.freshness = if replay_error.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Fresh
        };
        self.bump_revision();
        replay_error.map_or(ApplyResult::Applied, ApplyResult::NeedsResync)
    }

    pub(crate) fn fail_sync(&mut self, token: SnapshotToken, reason: String) -> ApplyResult {
        if token.connection_generation != self.connection_generation
            || token.sync_generation != self.sync_generation
        {
            return ApplyResult::IgnoredStale;
        }
        if self
            .active_sync
            .as_ref()
            .is_some_and(|active| active.token != token)
        {
            return ApplyResult::IgnoredStale;
        }
        self.active_sync = None;
        self.sync_status = HostSyncStatus::Error;
        self.error = Some(reason.clone());
        self.needs_resync = true;
        self.resync_running = false;
        self.freshness = if self.snapshot.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Unavailable
        };
        self.bump_revision();
        ApplyResult::NeedsResync(reason)
    }

    pub(crate) fn apply_event(
        &mut self,
        connection_generation: u64,
        event: HerdrEvent,
        now_ms: u64,
    ) -> ApplyResult {
        if connection_generation != self.connection_generation {
            return ApplyResult::IgnoredStale;
        }
        if let HerdrEvent::PaneClosed { pane_id, .. } = &event {
            self.locally_closed_pane_ids.remove(pane_id);
        } else if event_references_closed_pane(&event, &self.locally_closed_pane_ids) {
            return ApplyResult::IgnoredStale;
        }
        if let HerdrEvent::PaneOutputChanged { pane_id, .. } = &event {
            let pane_exists = self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.panes.iter().any(|pane| pane.pane_id == *pane_id));
            if pane_exists {
                // Output bytes and activity travel over the terminal/transcript streams. This
                // notification must not mutate or emit the full HostState projection.
                return ApplyResult::Applied;
            }
            self.last_event_at_ms = Some(now_ms);
            let reason = format!("pane output references unknown pane {pane_id}");
            self.needs_resync = true;
            self.error = Some(reason.clone());
            self.freshness = if self.snapshot.is_some() {
                HostFreshness::Stale
            } else {
                HostFreshness::Unavailable
            };
            self.bump_revision();
            return ApplyResult::NeedsResync(reason);
        }
        if let Some(active) = self.active_sync.as_mut() {
            active.buffered_events.push(event.clone());
        }
        self.last_event_at_ms = Some(now_ms);
        let result = match self.snapshot.as_mut() {
            Some(snapshot) => match apply_event_transactional(snapshot, &event) {
                Ok(()) => ApplyResult::Applied,
                Err(reason) => ApplyResult::NeedsResync(reason),
            },
            None => ApplyResult::NeedsResync(
                "Herdr event arrived before the initial host snapshot".to_owned(),
            ),
        };
        match &result {
            ApplyResult::Applied => {
                if self.sync_status != HostSyncStatus::Syncing {
                    self.freshness = HostFreshness::Fresh;
                }
            }
            ApplyResult::NeedsResync(reason) => {
                self.needs_resync = true;
                self.error = Some(reason.clone());
                self.freshness = if self.snapshot.is_some() {
                    HostFreshness::Stale
                } else {
                    HostFreshness::Unavailable
                };
            }
            ApplyResult::IgnoredStale => {}
        }
        self.bump_revision();
        result
    }

    pub(crate) fn apply_control_result(
        &mut self,
        connection_generation: u64,
        request: &HerdrControlRequest,
        result: &HerdrControlResult,
    ) -> ApplyResult {
        if connection_generation != self.connection_generation {
            return ApplyResult::IgnoredStale;
        }
        let Some(snapshot) = self.snapshot.as_mut() else {
            return ApplyResult::NeedsResync("control result arrived before host state".to_owned());
        };
        let locally_closed_pane_id = match (request, result) {
            (HerdrControlRequest::PaneClose { pane_id }, HerdrControlResult::Ok)
                if snapshot.panes.iter().any(|pane| pane.pane_id == *pane_id) =>
            {
                Some(pane_id.clone())
            }
            _ => None,
        };
        let mut candidate = snapshot.clone();
        let applied =
            apply_control_to_snapshot(&mut candidate, request, result).and_then(|projection| {
                if !matches!(projection, ControlProjection::Unchanged) {
                    validate_snapshot(&candidate)?;
                }
                Ok(projection)
            });
        match applied {
            Ok(ControlProjection::Applied) => {
                normalize_snapshot(&mut candidate);
                *snapshot = candidate;
                if let Some(pane_id) = locally_closed_pane_id {
                    self.locally_closed_pane_ids.insert(pane_id);
                }
                self.bump_revision();
                ApplyResult::Applied
            }
            Ok(ControlProjection::AppliedNeedsResync(reason)) => {
                normalize_snapshot(&mut candidate);
                *snapshot = candidate;
                self.needs_resync = true;
                self.error = Some(reason.clone());
                self.freshness = HostFreshness::Stale;
                self.bump_revision();
                ApplyResult::NeedsResync(reason)
            }
            Ok(ControlProjection::Unchanged) => ApplyResult::Applied,
            Err(reason) => {
                self.needs_resync = true;
                self.error = Some(reason.clone());
                self.freshness = HostFreshness::Stale;
                self.bump_revision();
                ApplyResult::NeedsResync(reason)
            }
        }
    }

    pub(crate) fn mark_needs_resync(&mut self, reason: String) {
        self.needs_resync = true;
        self.error = Some(reason);
        self.freshness = if self.snapshot.is_some() {
            HostFreshness::Stale
        } else {
            HostFreshness::Unavailable
        };
        self.bump_revision();
    }

    pub(crate) fn request_resync(&mut self, reason: String) -> bool {
        self.mark_needs_resync(reason);
        if self.resync_running {
            return false;
        }
        self.resync_running = true;
        true
    }

    pub(crate) fn take_resync_request(&mut self) -> bool {
        if !self.needs_resync || self.sync_status == HostSyncStatus::Syncing {
            self.resync_running = false;
            return false;
        }
        self.needs_resync = false;
        true
    }

    pub(crate) fn pane_ids(&self) -> Vec<String> {
        let mut ids = self
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .panes
                    .iter()
                    .map(|pane| pane.pane_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }

    pub(crate) fn take_agent_status_transitions(&mut self) -> Vec<AgentStatusTransition> {
        std::mem::take(&mut self.pending_agent_transitions)
    }

    #[cfg(test)]
    pub(crate) fn resync_running(&self) -> bool {
        self.resync_running
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.capture_agent_status_transitions();
    }

    fn capture_agent_status_transitions(&mut self) {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        let mut current = snapshot
            .panes
            .iter()
            .map(|pane| (pane.pane_id.clone(), pane.agent_status))
            .collect::<HashMap<_, _>>();
        for agent in &snapshot.agents {
            current.insert(agent.pane_id.clone(), agent.agent_status);
        }
        let mut pane_ids = self
            .agent_statuses
            .keys()
            .chain(current.keys())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        pane_ids.sort_unstable();
        for pane_id in pane_ids {
            let previous = self.agent_statuses.get(&pane_id).copied();
            let next = current.get(&pane_id).copied();
            if previous.is_some() && previous != next {
                if let Some(index) = self
                    .pending_agent_transitions
                    .iter()
                    .position(|transition| transition.pane_id == pane_id)
                {
                    self.pending_agent_transitions[index].current = next;
                    self.pending_agent_transitions[index].revision = self.revision;
                    if self.pending_agent_transitions[index].previous == next {
                        self.pending_agent_transitions.remove(index);
                    }
                } else {
                    self.pending_agent_transitions.push(AgentStatusTransition {
                        pane_id,
                        previous,
                        current: next,
                        revision: self.revision,
                    });
                }
            }
        }
        self.agent_statuses = current;
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

fn validate_snapshot(snapshot: &HerdrSessionSnapshot) -> Result<(), String> {
    let workspace_ids = snapshot
        .workspaces
        .iter()
        .map(|workspace| workspace.workspace_id.as_str())
        .collect::<HashSet<_>>();
    let tabs = snapshot
        .tabs
        .iter()
        .map(|tab| (tab.tab_id.as_str(), tab.workspace_id.as_str()))
        .collect::<HashMap<_, _>>();
    let panes = snapshot
        .panes
        .iter()
        .map(|pane| (pane.pane_id.as_str(), pane.tab_id.as_str()))
        .collect::<HashSet<_>>();
    for tab in &snapshot.tabs {
        if !workspace_ids.contains(tab.workspace_id.as_str()) {
            return Err(format!(
                "tab {} references missing workspace {}",
                tab.tab_id, tab.workspace_id
            ));
        }
    }
    for pane in &snapshot.panes {
        let Some(workspace_id) = tabs.get(pane.tab_id.as_str()) else {
            return Err(format!(
                "pane {} references missing tab {}",
                pane.pane_id, pane.tab_id
            ));
        };
        if *workspace_id != pane.workspace_id {
            return Err(format!(
                "pane {} has inconsistent workspace {} for tab {}",
                pane.pane_id, pane.workspace_id, pane.tab_id
            ));
        }
    }
    for layout in &snapshot.layouts {
        if tabs.get(layout.tab_id.as_str()) != Some(&layout.workspace_id.as_str()) {
            return Err(format!(
                "layout for tab {} references an inconsistent parent",
                layout.tab_id
            ));
        }
        for pane in &layout.panes {
            if !panes.contains(&(pane.pane_id.as_str(), layout.tab_id.as_str())) {
                return Err(format!(
                    "layout for tab {} references unknown pane {}",
                    layout.tab_id, pane.pane_id
                ));
            }
        }
    }
    Ok(())
}

fn status_priority(status: HerdrAgentStatus) -> u8 {
    match status {
        HerdrAgentStatus::Blocked => 5,
        HerdrAgentStatus::Done => 4,
        HerdrAgentStatus::Working => 3,
        HerdrAgentStatus::Idle => 2,
        HerdrAgentStatus::Unknown => 1,
    }
}

fn normalize_snapshot(snapshot: &mut HerdrSessionSnapshot) {
    for agent in &mut snapshot.agents {
        let Some(pane) = snapshot
            .panes
            .iter_mut()
            .find(|pane| pane.pane_id == agent.pane_id)
        else {
            continue;
        };

        // Agent rows are a projection of the current pane lifecycle. Full pane
        // updates/control responses can change status without a separate
        // PaneAgentStatusChanged event; never retain an older agent-row status.
        agent.agent_status = pane.agent_status;

        // Pane state is the authoritative session identity once Herdr has
        // reported one. Agent rows are an auxiliary projection and may omit
        // the session during otherwise fresh status/control responses.
        if let Some(session) = &pane.agent_session {
            agent.agent_session = Some(session.clone());
        } else if let Some(session) = &agent.agent_session {
            pane.agent_session = Some(session.clone());
        }
    }

    let mut panes_by_tab = HashMap::<&str, (usize, HerdrAgentStatus)>::new();
    let mut panes_by_workspace = HashMap::<&str, usize>::new();
    for pane in &snapshot.panes {
        let (count, status) = panes_by_tab
            .entry(pane.tab_id.as_str())
            .or_insert((0, HerdrAgentStatus::Unknown));
        *count += 1;
        if status_priority(pane.agent_status) > status_priority(*status) {
            *status = pane.agent_status;
        }
        *panes_by_workspace
            .entry(pane.workspace_id.as_str())
            .or_default() += 1;
    }
    for tab in &mut snapshot.tabs {
        let (pane_count, agent_status) = panes_by_tab
            .get(tab.tab_id.as_str())
            .copied()
            .unwrap_or((0, HerdrAgentStatus::Unknown));
        tab.pane_count = count_as_f64(pane_count);
        tab.agent_status = agent_status;
    }

    let mut tabs_by_workspace = HashMap::<&str, (usize, HerdrAgentStatus)>::new();
    for tab in &snapshot.tabs {
        let (count, status) = tabs_by_workspace
            .entry(tab.workspace_id.as_str())
            .or_insert((0, HerdrAgentStatus::Unknown));
        *count += 1;
        if status_priority(tab.agent_status) > status_priority(*status) {
            *status = tab.agent_status;
        }
    }
    for workspace in &mut snapshot.workspaces {
        let (tab_count, agent_status) = tabs_by_workspace
            .get(workspace.workspace_id.as_str())
            .copied()
            .unwrap_or((0, HerdrAgentStatus::Unknown));
        workspace.tab_count = count_as_f64(tab_count);
        workspace.pane_count = count_as_f64(
            panes_by_workspace
                .get(workspace.workspace_id.as_str())
                .copied()
                .unwrap_or_default(),
        );
        workspace.agent_status = agent_status;
    }
    repair_focus(snapshot);
}

#[allow(
    clippy::cast_precision_loss,
    reason = "pane and tab counts are bounded far below f64's exact integer range"
)]
fn count_as_f64(value: usize) -> f64 {
    value as f64
}

fn repair_focus(snapshot: &mut HerdrSessionSnapshot) {
    let workspace_id = snapshot
        .focused_workspace_id
        .as_ref()
        .filter(|id| {
            snapshot
                .workspaces
                .iter()
                .any(|item| &item.workspace_id == *id)
        })
        .cloned()
        .or_else(|| {
            snapshot
                .workspaces
                .iter()
                .find(|item| item.focused)
                .or_else(|| snapshot.workspaces.first())
                .map(|item| item.workspace_id.clone())
        });
    let tab_id = workspace_id.as_ref().and_then(|workspace_id| {
        snapshot
            .focused_tab_id
            .as_ref()
            .filter(|id| {
                snapshot
                    .tabs
                    .iter()
                    .any(|item| &item.tab_id == *id && &item.workspace_id == workspace_id)
            })
            .cloned()
            .or_else(|| {
                let workspace = snapshot
                    .workspaces
                    .iter()
                    .find(|item| &item.workspace_id == workspace_id)?;
                snapshot
                    .tabs
                    .iter()
                    .find(|item| {
                        item.workspace_id == *workspace_id && item.tab_id == workspace.active_tab_id
                    })
                    .or_else(|| {
                        snapshot
                            .tabs
                            .iter()
                            .find(|item| item.workspace_id == *workspace_id && item.focused)
                    })
                    .or_else(|| {
                        snapshot
                            .tabs
                            .iter()
                            .find(|item| item.workspace_id == *workspace_id)
                    })
                    .map(|item| item.tab_id.clone())
            })
    });
    let pane_id = tab_id.as_ref().and_then(|tab_id| {
        snapshot
            .focused_pane_id
            .as_ref()
            .filter(|id| {
                snapshot
                    .panes
                    .iter()
                    .any(|item| &item.pane_id == *id && &item.tab_id == tab_id)
            })
            .cloned()
            .or_else(|| {
                snapshot
                    .panes
                    .iter()
                    .find(|item| item.tab_id == *tab_id && item.focused)
                    .or_else(|| snapshot.panes.iter().find(|item| item.tab_id == *tab_id))
                    .map(|item| item.pane_id.clone())
            })
    });
    snapshot.focused_workspace_id.clone_from(&workspace_id);
    snapshot.focused_tab_id.clone_from(&tab_id);
    snapshot.focused_pane_id.clone_from(&pane_id);
    for workspace in &mut snapshot.workspaces {
        workspace.focused = Some(&workspace.workspace_id) == workspace_id.as_ref();
        if workspace.focused
            && let Some(tab_id) = &tab_id
        {
            workspace.active_tab_id.clone_from(tab_id);
        }
    }
    for tab in &mut snapshot.tabs {
        tab.focused = Some(&tab.tab_id) == tab_id.as_ref();
    }
    for pane in &mut snapshot.panes {
        pane.focused = Some(&pane.pane_id) == pane_id.as_ref();
    }
}

fn focus_workspace(snapshot: &mut HerdrSessionSnapshot, workspace_id: &str) -> Result<(), String> {
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.workspace_id == workspace_id)
    {
        return Err(format!("focus references unknown workspace {workspace_id}"));
    }
    snapshot.focused_workspace_id = Some(workspace_id.to_owned());
    snapshot.focused_tab_id = None;
    snapshot.focused_pane_id = None;
    repair_focus(snapshot);
    Ok(())
}

fn focus_tab(snapshot: &mut HerdrSessionSnapshot, tab_id: &str) -> Result<(), String> {
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.tab_id == tab_id)
        .ok_or_else(|| format!("focus references unknown tab {tab_id}"))?;
    snapshot.focused_workspace_id = Some(tab.workspace_id.clone());
    snapshot.focused_tab_id = Some(tab_id.to_owned());
    snapshot.focused_pane_id = None;
    repair_focus(snapshot);
    Ok(())
}

fn focus_pane(snapshot: &mut HerdrSessionSnapshot, pane_id: &str) -> Result<(), String> {
    let pane = snapshot
        .panes
        .iter()
        .find(|pane| pane.pane_id == pane_id)
        .ok_or_else(|| format!("focus references unknown pane {pane_id}"))?;
    snapshot.focused_workspace_id = Some(pane.workspace_id.clone());
    snapshot.focused_tab_id = Some(pane.tab_id.clone());
    snapshot.focused_pane_id = Some(pane_id.to_owned());
    repair_focus(snapshot);
    Ok(())
}

fn upsert_workspace(snapshot: &mut HerdrSessionSnapshot, workspace: HerdrWorkspaceInfo) {
    if let Some(current) = snapshot
        .workspaces
        .iter_mut()
        .find(|item| item.workspace_id == workspace.workspace_id)
    {
        *current = workspace;
    } else {
        snapshot.workspaces.push(workspace);
    }
}

fn upsert_tab(snapshot: &mut HerdrSessionSnapshot, tab: HerdrTabInfo) -> Result<(), String> {
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.workspace_id == tab.workspace_id)
    {
        return Err(format!(
            "tab {} references unknown workspace {}",
            tab.tab_id, tab.workspace_id
        ));
    }
    if let Some(current) = snapshot
        .tabs
        .iter_mut()
        .find(|item| item.tab_id == tab.tab_id)
    {
        *current = tab;
    } else {
        snapshot.tabs.push(tab);
    }
    Ok(())
}

fn upsert_pane(snapshot: &mut HerdrSessionSnapshot, pane: HerdrPaneInfo) -> Result<(), String> {
    let Some(tab) = snapshot.tabs.iter().find(|tab| tab.tab_id == pane.tab_id) else {
        return Err(format!(
            "pane {} references unknown tab {}",
            pane.pane_id, pane.tab_id
        ));
    };
    if tab.workspace_id != pane.workspace_id {
        return Err(format!("pane {} has inconsistent parent", pane.pane_id));
    }
    if let Some(current) = snapshot
        .panes
        .iter_mut()
        .find(|item| item.pane_id == pane.pane_id)
    {
        *current = pane;
    } else {
        snapshot.panes.push(pane);
    }
    Ok(())
}

fn upsert_layout(
    snapshot: &mut HerdrSessionSnapshot,
    layout: HerdrPaneLayoutSnapshot,
) -> Result<(), String> {
    if !snapshot
        .tabs
        .iter()
        .any(|tab| tab.tab_id == layout.tab_id && tab.workspace_id == layout.workspace_id)
    {
        return Err(format!(
            "layout references unknown tab {} in workspace {}",
            layout.tab_id, layout.workspace_id
        ));
    }
    if layout.panes.iter().any(|layout_pane| {
        !snapshot
            .panes
            .iter()
            .any(|pane| pane.pane_id == layout_pane.pane_id && pane.tab_id == layout.tab_id)
    }) {
        return Err(format!(
            "layout for tab {} references an unknown pane",
            layout.tab_id
        ));
    }
    if let Some(current) = snapshot
        .layouts
        .iter_mut()
        .find(|item| item.tab_id == layout.tab_id)
    {
        *current = layout;
    } else {
        snapshot.layouts.push(layout);
    }
    Ok(())
}

fn remove_workspace(snapshot: &mut HerdrSessionSnapshot, workspace_id: &str) {
    let tab_ids = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == workspace_id)
        .map(|tab| tab.tab_id.clone())
        .collect::<HashSet<_>>();
    snapshot
        .workspaces
        .retain(|workspace| workspace.workspace_id != workspace_id);
    snapshot.tabs.retain(|tab| tab.workspace_id != workspace_id);
    snapshot
        .panes
        .retain(|pane| pane.workspace_id != workspace_id);
    snapshot
        .agents
        .retain(|agent| agent.workspace_id != workspace_id);
    snapshot
        .layouts
        .retain(|layout| !tab_ids.contains(&layout.tab_id));
    repair_focus(snapshot);
}

fn remove_tab(snapshot: &mut HerdrSessionSnapshot, tab_id: &str) {
    snapshot.tabs.retain(|tab| tab.tab_id != tab_id);
    snapshot.panes.retain(|pane| pane.tab_id != tab_id);
    snapshot.agents.retain(|agent| agent.tab_id != tab_id);
    snapshot.layouts.retain(|layout| layout.tab_id != tab_id);
    repair_focus(snapshot);
}

fn remove_pane(snapshot: &mut HerdrSessionSnapshot, pane_id: &str) {
    snapshot.panes.retain(|pane| pane.pane_id != pane_id);
    snapshot.agents.retain(|agent| agent.pane_id != pane_id);
    for layout in &mut snapshot.layouts {
        layout.panes.retain(|pane| pane.pane_id != pane_id);
        if layout.focused_pane_id == pane_id {
            layout.focused_pane_id = layout
                .panes
                .first()
                .map(|pane| pane.pane_id.clone())
                .unwrap_or_default();
        }
    }
    repair_focus(snapshot);
}

fn update_agent_status(
    snapshot: &mut HerdrSessionSnapshot,
    pane_id: &str,
    agent_status: HerdrAgentStatus,
    agent: Option<&String>,
    title: Option<&String>,
    display_agent: Option<&String>,
    state_labels: Option<&HashMap<String, String>>,
) -> Result<(), String> {
    let pane = snapshot
        .panes
        .iter_mut()
        .find(|pane| pane.pane_id == pane_id)
        .ok_or_else(|| format!("agent status references unknown pane {pane_id}"))?;
    pane.agent_status = agent_status;
    if let Some(value) = agent {
        pane.agent = Some(value.clone());
    }
    if let Some(value) = title {
        pane.title = Some(value.clone());
    }
    if let Some(value) = display_agent {
        pane.display_agent = Some(value.clone());
    }
    if let Some(value) = state_labels {
        pane.state_labels = Some(value.clone());
    }
    if let Some(current) = snapshot
        .agents
        .iter_mut()
        .find(|current| current.pane_id == pane_id)
    {
        current.agent_status = agent_status;
        if let Some(value) = agent {
            current.agent = Some(value.clone());
        }
        if let Some(value) = title {
            current.title = Some(value.clone());
        }
        if let Some(value) = display_agent {
            current.display_agent = Some(value.clone());
        }
        if let Some(value) = state_labels {
            current.state_labels = Some(value.clone());
        }
    }
    Ok(())
}

fn upsert_agent(
    snapshot: &mut HerdrSessionSnapshot,
    mut agent: HerdrAgentInfo,
) -> Result<(), String> {
    if !snapshot
        .panes
        .iter()
        .any(|pane| pane.pane_id == agent.pane_id)
    {
        return Err(format!("agent references unknown pane {}", agent.pane_id));
    }
    update_agent_status(
        snapshot,
        &agent.pane_id,
        agent.agent_status,
        agent.agent.as_ref(),
        agent.title.as_ref(),
        agent.display_agent.as_ref(),
        agent.state_labels.as_ref(),
    )?;
    let pane = snapshot
        .panes
        .iter_mut()
        .find(|pane| pane.pane_id == agent.pane_id)
        .ok_or_else(|| format!("agent references unknown pane {}", agent.pane_id))?;
    if let Some(session) = &agent.agent_session {
        pane.agent_session = Some(session.clone());
    } else if let Some(session) = &pane.agent_session {
        agent.agent_session = Some(session.clone());
    }
    if let Some(current) = snapshot
        .agents
        .iter_mut()
        .find(|item| item.pane_id == agent.pane_id)
    {
        *current = agent;
    } else {
        snapshot.agents.push(agent);
    }
    Ok(())
}

fn event_references_closed_pane(event: &HerdrEvent, closed_pane_ids: &HashSet<String>) -> bool {
    let is_closed = |pane_id: &str| closed_pane_ids.contains(pane_id);
    match event {
        HerdrEvent::PaneCreated { pane } | HerdrEvent::PaneUpdated { pane } => {
            is_closed(&pane.pane_id)
        }
        HerdrEvent::PaneFocused { pane_id, .. }
        | HerdrEvent::PaneExited { pane_id, .. }
        | HerdrEvent::PaneOutputChanged { pane_id, .. }
        | HerdrEvent::PaneAgentDetected { pane_id, .. }
        | HerdrEvent::PaneAgentStatusChanged { pane_id, .. } => is_closed(pane_id),
        HerdrEvent::PaneMoved {
            previous_pane_id,
            pane,
            ..
        } => is_closed(previous_pane_id) || is_closed(&pane.pane_id),
        HerdrEvent::LayoutUpdated { layout } => {
            layout.panes.iter().any(|pane| is_closed(&pane.pane_id))
        }
        HerdrEvent::WorkspaceCreated { .. }
        | HerdrEvent::WorkspaceUpdated { .. }
        | HerdrEvent::WorkspaceMetadataUpdated { .. }
        | HerdrEvent::WorkspaceRenamed { .. }
        | HerdrEvent::WorkspaceMoved { .. }
        | HerdrEvent::WorkspaceReordered { .. }
        | HerdrEvent::WorkspaceClosed { .. }
        | HerdrEvent::WorkspaceFocused { .. }
        | HerdrEvent::WorktreeCreated { .. }
        | HerdrEvent::WorktreeOpened { .. }
        | HerdrEvent::WorktreeRemoved { .. }
        | HerdrEvent::TabCreated { .. }
        | HerdrEvent::TabClosed { .. }
        | HerdrEvent::TabFocused { .. }
        | HerdrEvent::TabRenamed { .. }
        | HerdrEvent::TabMoved { .. }
        | HerdrEvent::PaneClosed { .. }
        | HerdrEvent::ProtocolUnknown { .. }
        | HerdrEvent::ProtocolInvalid { .. } => false,
    }
}

fn apply_event_to_snapshot(
    snapshot: &mut HerdrSessionSnapshot,
    event: &HerdrEvent,
) -> Result<(), String> {
    match event {
        HerdrEvent::WorkspaceCreated { workspace }
        | HerdrEvent::WorkspaceUpdated { workspace }
        | HerdrEvent::WorkspaceMetadataUpdated { workspace }
        | HerdrEvent::WorktreeCreated { workspace, .. }
        | HerdrEvent::WorktreeOpened { workspace, .. } => {
            upsert_workspace(snapshot, workspace.clone());
        }
        HerdrEvent::WorkspaceClosed { workspace_id, .. } => {
            remove_workspace(snapshot, workspace_id);
        }
        HerdrEvent::WorkspaceRenamed {
            workspace_id,
            label,
        } => {
            let workspace = snapshot
                .workspaces
                .iter_mut()
                .find(|item| item.workspace_id == *workspace_id)
                .ok_or_else(|| format!("rename references unknown workspace {workspace_id}"))?;
            workspace.label.clone_from(label);
        }
        HerdrEvent::WorkspaceMoved { workspaces, .. }
        | HerdrEvent::WorkspaceReordered { workspaces, .. } => {
            let known = snapshot
                .workspaces
                .iter()
                .map(|item| item.workspace_id.as_str())
                .collect::<HashSet<_>>();
            if workspaces
                .iter()
                .any(|item| !known.contains(item.workspace_id.as_str()))
            {
                return Err("workspace ordering references unknown workspace".to_owned());
            }
            let order = workspaces
                .iter()
                .enumerate()
                .map(|(index, item)| (item.workspace_id.as_str(), index))
                .collect::<HashMap<_, _>>();
            for workspace in workspaces {
                upsert_workspace(snapshot, workspace.clone());
            }
            snapshot.workspaces.sort_by_key(|item| {
                order
                    .get(item.workspace_id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX)
            });
        }
        HerdrEvent::WorkspaceFocused { workspace_id } => focus_workspace(snapshot, workspace_id)?,
        HerdrEvent::WorktreeRemoved {
            workspace_id,
            workspace,
            ..
        } => {
            if let Some(workspace) = workspace {
                upsert_workspace(snapshot, workspace.clone());
            } else if !snapshot
                .workspaces
                .iter()
                .any(|item| item.workspace_id == *workspace_id)
            {
                return Err(format!(
                    "worktree removal references unknown workspace {workspace_id}"
                ));
            }
        }
        HerdrEvent::TabCreated { tab } => upsert_tab(snapshot, tab.clone())?,
        HerdrEvent::TabClosed { tab_id, .. } => remove_tab(snapshot, tab_id),
        HerdrEvent::TabFocused { tab_id, .. } => focus_tab(snapshot, tab_id)?,
        HerdrEvent::TabRenamed { tab_id, label, .. } => {
            let tab = snapshot
                .tabs
                .iter_mut()
                .find(|item| item.tab_id == *tab_id)
                .ok_or_else(|| format!("rename references unknown tab {tab_id}"))?;
            tab.label.clone_from(label);
        }
        HerdrEvent::TabMoved {
            workspace_id, tabs, ..
        } => {
            if !snapshot
                .workspaces
                .iter()
                .any(|workspace| workspace.workspace_id == *workspace_id)
            {
                return Err(format!(
                    "tab move references unknown workspace {workspace_id}"
                ));
            }
            snapshot
                .tabs
                .retain(|tab| tab.workspace_id != *workspace_id);
            for tab in tabs {
                upsert_tab(snapshot, tab.clone())?;
            }
        }
        HerdrEvent::PaneCreated { pane } | HerdrEvent::PaneUpdated { pane } => {
            upsert_pane(snapshot, pane.clone())?;
        }
        HerdrEvent::PaneClosed { pane_id, .. } => remove_pane(snapshot, pane_id),
        HerdrEvent::PaneFocused { pane_id, .. } => focus_pane(snapshot, pane_id)?,
        HerdrEvent::PaneExited { pane_id, .. } => {
            if !snapshot.panes.iter().any(|pane| pane.pane_id == *pane_id) {
                return Err(format!("pane exit references unknown pane {pane_id}"));
            }
            return Err(format!(
                "pane {pane_id} exited; a snapshot resync is required"
            ));
        }
        HerdrEvent::PaneMoved {
            previous_pane_id,
            pane,
            created_workspace,
            created_tab,
            closed_workspace_id,
            closed_tab_id,
            ..
        } => {
            if let Some(workspace) = created_workspace {
                upsert_workspace(snapshot, workspace.clone());
            }
            if let Some(tab) = created_tab {
                upsert_tab(snapshot, tab.clone())?;
            }
            if previous_pane_id != &pane.pane_id {
                remove_pane(snapshot, previous_pane_id);
            }
            upsert_pane(snapshot, pane.clone())?;
            if let Some(tab_id) = closed_tab_id {
                remove_tab(snapshot, tab_id);
            }
            if let Some(workspace_id) = closed_workspace_id {
                remove_workspace(snapshot, workspace_id);
            }
        }
        HerdrEvent::PaneOutputChanged { pane_id, .. } => {
            if !snapshot.panes.iter().any(|pane| pane.pane_id == *pane_id) {
                return Err(format!("pane output references unknown pane {pane_id}"));
            }
        }
        HerdrEvent::PaneAgentDetected {
            pane_id,
            agent,
            final_status,
            ..
        } => {
            let pane = snapshot
                .panes
                .iter_mut()
                .find(|pane| pane.pane_id == *pane_id)
                .ok_or_else(|| format!("agent detection references unknown pane {pane_id}"))?;
            if let Some(agent) = agent {
                pane.agent = Some(agent.clone());
            }
            if let Some(status) = final_status {
                pane.agent_status = *status;
            }
            return Err(format!(
                "agent detection for pane {pane_id} requires a snapshot resync"
            ));
        }
        HerdrEvent::PaneAgentStatusChanged {
            pane_id,
            agent_status,
            agent,
            title,
            display_agent,
            state_labels,
            ..
        } => update_agent_status(
            snapshot,
            pane_id,
            *agent_status,
            agent.as_ref(),
            title.as_ref(),
            display_agent.as_ref(),
            state_labels.as_ref(),
        )?,
        HerdrEvent::LayoutUpdated { layout } => upsert_layout(snapshot, layout.clone())?,
        HerdrEvent::ProtocolUnknown { raw_event } => {
            return Err(format!("unknown Herdr event {raw_event} requires a resync"));
        }
        HerdrEvent::ProtocolInvalid { raw_event, reason } => {
            return Err(format!("malformed Herdr event {raw_event}: {reason}"));
        }
    }
    Ok(())
}

fn apply_event_transactional(
    snapshot: &mut HerdrSessionSnapshot,
    event: &HerdrEvent,
) -> Result<(), String> {
    let mut candidate = snapshot.clone();
    apply_event_to_snapshot(&mut candidate, event)?;
    validate_snapshot(&candidate)?;
    normalize_snapshot(&mut candidate);
    *snapshot = candidate;
    Ok(())
}

fn apply_control_to_snapshot(
    snapshot: &mut HerdrSessionSnapshot,
    request: &HerdrControlRequest,
    result: &HerdrControlResult,
) -> Result<ControlProjection, String> {
    match result {
        HerdrControlResult::WorkspaceCreated {
            workspace,
            tab,
            root_pane,
        } => {
            upsert_workspace(snapshot, workspace.clone());
            upsert_tab(snapshot, tab.clone())?;
            upsert_pane(snapshot, root_pane.clone())?;
            focus_pane(snapshot, &root_pane.pane_id)?;
            Ok(ControlProjection::AppliedNeedsResync(
                "workspace creation result omits the root tab layout".to_owned(),
            ))
        }
        HerdrControlResult::WorkspaceInfo { workspace } => {
            upsert_workspace(snapshot, workspace.clone());
            if matches!(request, HerdrControlRequest::WorkspaceFocus { .. }) {
                focus_workspace(snapshot, &workspace.workspace_id)?;
                if snapshot.focused_tab_id.is_none() || snapshot.focused_pane_id.is_none() {
                    return Ok(ControlProjection::AppliedNeedsResync(
                        "workspace focus result omits post-focus pane topology".to_owned(),
                    ));
                }
            }
            Ok(ControlProjection::Applied)
        }
        HerdrControlResult::TabCreated { tab, root_pane } => {
            upsert_tab(snapshot, tab.clone())?;
            upsert_pane(snapshot, root_pane.clone())?;
            focus_pane(snapshot, &root_pane.pane_id)?;
            Ok(ControlProjection::AppliedNeedsResync(
                "tab creation result omits the new tab layout".to_owned(),
            ))
        }
        HerdrControlResult::TabInfo { tab } => {
            upsert_tab(snapshot, tab.clone())?;
            if matches!(request, HerdrControlRequest::TabFocus { .. }) {
                focus_tab(snapshot, &tab.tab_id)?;
                if snapshot.focused_pane_id.is_none() {
                    return Ok(ControlProjection::AppliedNeedsResync(
                        "tab focus result omits post-focus pane topology".to_owned(),
                    ));
                }
            }
            Ok(ControlProjection::Applied)
        }
        HerdrControlResult::PaneInfo { pane } => {
            upsert_pane(snapshot, pane.clone())?;
            if matches!(
                request,
                HerdrControlRequest::PaneFocus { .. } | HerdrControlRequest::PaneSplit { .. }
            ) {
                focus_pane(snapshot, &pane.pane_id)?;
            }
            if matches!(request, HerdrControlRequest::PaneSplit { .. }) {
                Ok(ControlProjection::AppliedNeedsResync(
                    "pane split result omits the updated tab layout".to_owned(),
                ))
            } else {
                Ok(ControlProjection::Applied)
            }
        }
        HerdrControlResult::AgentStarted { agent, .. }
        | HerdrControlResult::AgentInfo { agent }
        | HerdrControlResult::AgentPrompted { agent } => {
            upsert_agent(snapshot, agent.clone())?;
            if matches!(request, HerdrControlRequest::AgentFocus { .. }) {
                focus_pane(snapshot, &agent.pane_id)?;
            }
            Ok(ControlProjection::Applied)
        }
        HerdrControlResult::PaneZoom { zoom } => {
            upsert_layout(snapshot, zoom.layout.clone())?;
            if zoom.focus_changed {
                focus_pane(snapshot, &zoom.focused_pane_id)?;
            }
            Ok(ControlProjection::Applied)
        }
        HerdrControlResult::Ok => match request {
            HerdrControlRequest::WorkspaceClose { workspace_id } => {
                remove_workspace(snapshot, workspace_id);
                Ok(ControlProjection::Applied)
            }
            HerdrControlRequest::TabClose { tab_id } => {
                remove_tab(snapshot, tab_id);
                Ok(ControlProjection::Applied)
            }
            HerdrControlRequest::PaneClose { pane_id } => {
                remove_pane(snapshot, pane_id);
                Ok(ControlProjection::Applied)
            }
            _ => Ok(ControlProjection::Unchanged),
        },
        HerdrControlResult::Pong { .. }
        | HerdrControlResult::SessionSnapshot { .. }
        | HerdrControlResult::IntegrationInstalled { .. }
        | HerdrControlResult::PaneRead { .. } => Ok(ControlProjection::Unchanged),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr_api::{
        HerdrAgentKind, HerdrAgentSessionInfo, HerdrAgentSessionKind, HerdrPaneLayoutPane,
        HerdrPaneLayoutRect, HerdrWorkspaceWorktreeInfo,
    };

    fn workspace(id: &str) -> HerdrWorkspaceInfo {
        HerdrWorkspaceInfo {
            workspace_id: id.to_owned(),
            number: 1.0,
            label: id.to_owned(),
            focused: id == "w1",
            pane_count: 99.0,
            tab_count: 99.0,
            active_tab_id: format!("t{id}"),
            agent_status: HerdrAgentStatus::Idle,
            tokens: None,
            worktree: None::<HerdrWorkspaceWorktreeInfo>,
        }
    }

    fn tab(id: &str, workspace_id: &str) -> HerdrTabInfo {
        HerdrTabInfo {
            tab_id: id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            number: 1.0,
            label: id.to_owned(),
            focused: id == "t1",
            pane_count: 99.0,
            agent_status: HerdrAgentStatus::Idle,
        }
    }

    fn pane(id: &str, workspace_id: &str, tab_id: &str, status: HerdrAgentStatus) -> HerdrPaneInfo {
        HerdrPaneInfo {
            pane_id: id.to_owned(),
            terminal_id: format!("term-{id}"),
            workspace_id: workspace_id.to_owned(),
            tab_id: tab_id.to_owned(),
            focused: id == "p1",
            cwd: None,
            foreground_cwd: None,
            label: None,
            agent: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            agent_status: status,
            state_labels: None,
            tokens: None,
            agent_session: None,
            scroll: None,
            revision: 0.0,
        }
    }

    fn agent(pane_id: &str, kind: HerdrAgentKind, session_id: &str) -> HerdrAgentInfo {
        agent_in(pane_id, "w1", "t1", kind, session_id)
    }

    fn agent_in(
        pane_id: &str,
        workspace_id: &str,
        tab_id: &str,
        kind: HerdrAgentKind,
        session_id: &str,
    ) -> HerdrAgentInfo {
        HerdrAgentInfo {
            pane_id: pane_id.to_owned(),
            terminal_id: format!("term-{pane_id}"),
            workspace_id: workspace_id.to_owned(),
            tab_id: tab_id.to_owned(),
            focused: true,
            agent_status: HerdrAgentStatus::Working,
            revision: 1.0,
            cwd: None,
            foreground_cwd: None,
            agent: Some(kind.as_str().to_owned()),
            name: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            interactive_ready: Some(true),
            launch_pending: Some(false),
            screen_detection_skipped: None,
            state_change_seq: None,
            state_labels: None,
            tokens: None,
            agent_session: Some(HerdrAgentSessionInfo {
                source: "herdr:test".to_owned(),
                agent: kind.as_str().to_owned(),
                kind: HerdrAgentSessionKind::Id,
                value: session_id.to_owned(),
            }),
        }
    }

    fn layout(workspace_id: &str, tab_id: &str, pane_id: &str) -> HerdrPaneLayoutSnapshot {
        HerdrPaneLayoutSnapshot {
            workspace_id: workspace_id.to_owned(),
            tab_id: tab_id.to_owned(),
            zoomed: false,
            area: HerdrPaneLayoutRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            focused_pane_id: pane_id.to_owned(),
            panes: vec![HerdrPaneLayoutPane {
                pane_id: pane_id.to_owned(),
                focused: true,
                rect: HerdrPaneLayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
            }],
            splits: Vec::new(),
        }
    }

    fn snapshot() -> HerdrSessionSnapshot {
        HerdrSessionSnapshot {
            version: "test".to_owned(),
            protocol: 22,
            focused_workspace_id: Some("w1".to_owned()),
            focused_tab_id: Some("t1".to_owned()),
            focused_pane_id: Some("p1".to_owned()),
            agents: Vec::new(),
            workspaces: vec![workspace("w1")],
            tabs: vec![tab("t1", "w1")],
            panes: vec![pane("p1", "w1", "t1", HerdrAgentStatus::Idle)],
            layouts: Vec::new(),
        }
    }

    fn synced_state() -> HostState {
        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, snapshot(), 10),
            ApplyResult::Applied
        );
        state
    }

    fn status_event(status: HerdrAgentStatus) -> HerdrEvent {
        HerdrEvent::PaneAgentStatusChanged {
            workspace_id: "w1".to_owned(),
            pane_id: "p1".to_owned(),
            agent_status: status,
            agent: Some("codex".to_owned()),
            title: None,
            display_agent: None,
            state_labels: None,
        }
    }

    #[test]
    fn agent_status_transitions_are_typed_and_emitted_once() {
        let mut state = synced_state();
        state.apply_event(1, status_event(HerdrAgentStatus::Working), 20);
        state.take_agent_status_transitions();

        state.apply_event(1, status_event(HerdrAgentStatus::Blocked), 21);
        let blocked = state.take_agent_status_transitions();
        state.apply_event(1, status_event(HerdrAgentStatus::Blocked), 22);
        let duplicate = state.take_agent_status_transitions();
        state.apply_event(1, status_event(HerdrAgentStatus::Done), 23);
        let done = state.take_agent_status_transitions();

        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].previous, Some(HerdrAgentStatus::Working));
        assert_eq!(blocked[0].current, Some(HerdrAgentStatus::Blocked));
        assert!(duplicate.is_empty());
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].previous, Some(HerdrAgentStatus::Blocked));
        assert_eq!(done[0].current, Some(HerdrAgentStatus::Done));
    }

    #[test]
    fn newer_status_events_win_over_an_in_flight_blocked_snapshot() {
        for final_status in [
            HerdrAgentStatus::Working,
            HerdrAgentStatus::Done,
            HerdrAgentStatus::Idle,
        ] {
            let mut state = synced_state();
            let mut blocked = snapshot();
            blocked.panes[0].agent_status = HerdrAgentStatus::Blocked;
            blocked
                .agents
                .push(agent("p1", HerdrAgentKind::Codex, "thread"));
            blocked.agents[0].agent_status = HerdrAgentStatus::Blocked;
            let initial = state.begin_sync(1);
            state.complete_sync(initial, blocked.clone(), 11);
            state.take_agent_status_transitions();
            let token = state.begin_sync(1);
            state.apply_event(1, status_event(final_status), 12);
            assert_eq!(
                state.complete_sync(token, blocked, 13),
                ApplyResult::Applied
            );
            let current = state.projection().snapshot.unwrap();
            assert_eq!(current.panes[0].agent_status, final_status);
            assert_eq!(current.agents[0].agent_status, final_status);
            assert_eq!(current.tabs[0].agent_status, final_status);
            assert_eq!(current.workspaces[0].agent_status, final_status);
            assert_eq!(
                state.take_agent_status_transitions()[0].current,
                Some(final_status)
            );
        }
    }

    #[test]
    fn snapshot_agent_rows_follow_current_pane_status() {
        let mut state = synced_state();
        let mut value = snapshot();
        value.panes[0].agent_status = HerdrAgentStatus::Working;
        value
            .agents
            .push(agent("p1", HerdrAgentKind::Codex, "thread"));
        value.agents[0].agent_status = HerdrAgentStatus::Blocked;
        let token = state.begin_sync(1);
        state.complete_sync(token, value, 11);
        assert_eq!(
            state.projection().snapshot.unwrap().agents[0].agent_status,
            HerdrAgentStatus::Working
        );
    }

    #[test]
    fn snapshot_event_race_and_resync_do_not_duplicate_agent_transition() {
        let mut state = synced_state();
        state.apply_event(1, status_event(HerdrAgentStatus::Working), 20);
        state.take_agent_status_transitions();
        let token = state.begin_sync(1);
        state.apply_event(1, status_event(HerdrAgentStatus::Blocked), 21);
        state.complete_sync(token, snapshot(), 22);

        let transitions = state.take_agent_status_transitions();
        let resync = state.begin_sync(1);
        let current = state.snapshot.clone().unwrap();
        state.complete_sync(resync, current, 23);

        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].previous, Some(HerdrAgentStatus::Working));
        assert_eq!(transitions[0].current, Some(HerdrAgentStatus::Blocked));
        assert!(state.take_agent_status_transitions().is_empty());
    }

    #[test]
    fn stale_event_is_ignored_and_pane_disappearance_is_cleared_once() {
        let mut state = synced_state();
        state.apply_event(1, status_event(HerdrAgentStatus::Working), 20);
        state.take_agent_status_transitions();

        assert_eq!(
            state.apply_event(0, status_event(HerdrAgentStatus::Done), 21),
            ApplyResult::IgnoredStale
        );
        assert!(state.take_agent_status_transitions().is_empty());

        let token = state.begin_sync(1);
        let mut empty = snapshot();
        empty.focused_workspace_id = None;
        empty.focused_tab_id = None;
        empty.focused_pane_id = None;
        empty.workspaces.clear();
        empty.tabs.clear();
        empty.panes.clear();
        state.complete_sync(token, empty, 22);
        let cleared = state.take_agent_status_transitions();

        assert_eq!(cleared.len(), 1);
        assert_eq!(cleared[0].previous, Some(HerdrAgentStatus::Working));
        assert_eq!(cleared[0].current, None);
    }

    #[test]
    fn snapshot_validation_accepts_consistent_layout_references() {
        let mut value = snapshot();
        value.layouts.push(layout("w1", "t1", "p1"));

        assert_eq!(validate_snapshot(&value), Ok(()));
    }

    #[test]
    fn snapshot_validation_rejects_a_pane_with_an_unknown_tab() {
        let mut value = snapshot();
        value.panes[0].tab_id = "missing".to_owned();

        assert_eq!(
            validate_snapshot(&value),
            Err("pane p1 references missing tab missing".to_owned())
        );
    }

    #[test]
    fn snapshot_validation_rejects_a_pane_with_a_mismatched_workspace() {
        let mut value = snapshot();
        value.panes[0].workspace_id = "w2".to_owned();

        assert_eq!(
            validate_snapshot(&value),
            Err("pane p1 has inconsistent workspace w2 for tab t1".to_owned())
        );
    }

    #[test]
    fn snapshot_validation_rejects_a_layout_with_an_unknown_pane() {
        let mut value = snapshot();
        value.layouts.push(layout("w1", "t1", "missing"));

        assert_eq!(
            validate_snapshot(&value),
            Err("layout for tab t1 references unknown pane missing".to_owned())
        );
    }

    #[test]
    fn snapshot_validation_rejects_a_layout_pane_owned_by_another_tab() {
        let mut value = snapshot();
        value.tabs.push(tab("t2", "w1"));
        value
            .panes
            .push(pane("p2", "w1", "t2", HerdrAgentStatus::Idle));
        value.layouts.push(layout("w1", "t1", "p2"));

        assert_eq!(
            validate_snapshot(&value),
            Err("layout for tab t1 references unknown pane p2".to_owned())
        );
    }

    #[test]
    fn empty_successful_snapshot_is_distinct_from_failed_sync() {
        let mut state = synced_state();
        let existing_revision = state.revision;
        let failed = state.begin_sync(1);
        state.fail_sync(failed, "offline".to_owned());
        assert_eq!(state.snapshot.as_ref().unwrap().panes.len(), 1);
        assert_eq!(state.freshness, HostFreshness::Stale);
        assert!(state.revision > existing_revision);

        let token = state.begin_sync(1);
        let mut empty = snapshot();
        empty.focused_workspace_id = None;
        empty.focused_tab_id = None;
        empty.focused_pane_id = None;
        empty.workspaces.clear();
        empty.tabs.clear();
        empty.panes.clear();
        state.complete_sync(token, empty, 20);
        assert!(state.snapshot.as_ref().unwrap().workspaces.is_empty());
        assert_eq!(state.freshness, HostFreshness::Fresh);
    }

    #[test]
    fn pane_output_notification_does_not_change_the_host_projection() {
        let mut state = synced_state();
        let revision = state.revision;

        assert_eq!(
            state.apply_event(
                1,
                HerdrEvent::PaneOutputChanged {
                    workspace_id: "w1".to_owned(),
                    pane_id: "p1".to_owned(),
                    revision: 2.0,
                },
                25,
            ),
            ApplyResult::Applied
        );
        assert_eq!(state.revision, revision);
        assert_eq!(state.last_event_at_ms, None);

        assert!(matches!(
            state.apply_event(
                1,
                HerdrEvent::PaneOutputChanged {
                    workspace_id: "w1".to_owned(),
                    pane_id: "missing".to_owned(),
                    revision: 1.0,
                },
                26,
            ),
            ApplyResult::NeedsResync(_)
        ));
        assert!(state.revision > revision);
    }

    #[test]
    fn stale_sync_and_old_connection_events_are_ignored() {
        let mut state = synced_state();
        let stale = state.begin_sync(1);
        let current = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(stale, snapshot(), 20),
            ApplyResult::IgnoredStale
        );
        assert_eq!(state.sync_generation, current.sync_generation);
        assert_eq!(
            state.apply_event(
                0,
                HerdrEvent::WorkspaceFocused {
                    workspace_id: "w1".to_owned()
                },
                21
            ),
            ApplyResult::IgnoredStale
        );
    }

    #[test]
    fn events_during_sync_are_replayed_over_snapshot() {
        let mut state = synced_state();
        let token = state.begin_sync(1);
        state.apply_event(
            1,
            HerdrEvent::PaneAgentStatusChanged {
                workspace_id: "w1".to_owned(),
                pane_id: "p1".to_owned(),
                agent_status: HerdrAgentStatus::Blocked,
                agent: Some("codex".to_owned()),
                title: None,
                display_agent: None,
                state_labels: None,
            },
            30,
        );
        state.complete_sync(token, snapshot(), 31);
        let snapshot = state.snapshot.unwrap();
        assert_eq!(snapshot.panes[0].agent_status, HerdrAgentStatus::Blocked);
        assert_eq!(snapshot.tabs[0].agent_status, HerdrAgentStatus::Blocked);
        assert_eq!(
            snapshot.workspaces[0].agent_status,
            HerdrAgentStatus::Blocked
        );
    }

    #[test]
    fn mixed_agent_status_aggregation_matches_typescript_priority() {
        let mut value = snapshot();
        value
            .panes
            .push(pane("p2", "w1", "t1", HerdrAgentStatus::Done));
        value
            .panes
            .push(pane("p3", "w1", "t1", HerdrAgentStatus::Working));
        normalize_snapshot(&mut value);
        assert_eq!(value.tabs[0].agent_status, HerdrAgentStatus::Done);
        value.panes[0].agent_status = HerdrAgentStatus::Blocked;
        normalize_snapshot(&mut value);
        assert_eq!(value.tabs[0].agent_status, HerdrAgentStatus::Blocked);
        assert_eq!(value.workspaces[0].agent_status, HerdrAgentStatus::Blocked);
    }

    #[test]
    fn removing_parents_repairs_descendants_and_focus() {
        let mut state = synced_state();
        let before = state.revision;
        state.apply_event(
            1,
            HerdrEvent::TabClosed {
                workspace_id: "w1".to_owned(),
                tab_id: "t1".to_owned(),
            },
            40,
        );
        let value = state.snapshot.as_ref().unwrap();
        assert!(value.tabs.is_empty());
        assert!(value.panes.is_empty());
        assert_eq!(value.focused_tab_id, None);
        assert_eq!(value.focused_pane_id, None);
        assert!(state.revision > before);
    }

    #[test]
    fn unknown_parent_marks_state_stale_without_manufacturing_entities() {
        let mut state = synced_state();
        let result = state.apply_event(
            1,
            HerdrEvent::PaneCreated {
                pane: pane("missing", "w1", "unknown", HerdrAgentStatus::Idle),
            },
            50,
        );
        assert!(matches!(result, ApplyResult::NeedsResync(_)));
        assert_eq!(state.snapshot.as_ref().unwrap().panes.len(), 1);
        assert_eq!(state.freshness, HostFreshness::Stale);
    }

    #[test]
    fn layout_requires_known_tab_and_panes() {
        let mut state = synced_state();
        let layout = HerdrPaneLayoutSnapshot {
            workspace_id: "w1".to_owned(),
            tab_id: "t1".to_owned(),
            zoomed: false,
            area: HerdrPaneLayoutRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            focused_pane_id: "p1".to_owned(),
            panes: vec![HerdrPaneLayoutPane {
                pane_id: "missing".to_owned(),
                focused: false,
                rect: HerdrPaneLayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
            }],
            splits: Vec::new(),
        };
        assert!(matches!(
            state.apply_event(1, HerdrEvent::LayoutUpdated { layout }, 60),
            ApplyResult::NeedsResync(_)
        ));
    }

    #[test]
    fn reconnect_retains_known_state_but_marks_it_stale() {
        let mut state = synced_state();
        state.mark_reconnecting("closed".to_owned());
        assert!(state.snapshot.is_some());
        assert_eq!(state.freshness, HostFreshness::Stale);
        state.connection_installed(2);
        let token = state.begin_sync(2);
        state.complete_sync(token, snapshot(), 70);
        assert_eq!(state.freshness, HostFreshness::Fresh);
        assert_eq!(state.connection_generation, 2);
    }

    #[test]
    fn confirmed_create_result_updates_state_without_typescript_reducer() {
        let mut state = synced_state();
        let mut new_workspace = workspace("w2");
        new_workspace.active_tab_id = "t2".to_owned();
        let result = HerdrControlResult::WorkspaceCreated {
            workspace: new_workspace,
            tab: tab("t2", "w2"),
            root_pane: pane("p2", "w2", "t2", HerdrAgentStatus::Working),
        };
        assert!(matches!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::WorkspaceCreate {
                    label: None,
                    cwd: None,
                },
                &result,
            ),
            ApplyResult::NeedsResync(_)
        ));
        let value = state.snapshot.unwrap();
        assert_eq!(value.focused_workspace_id.as_deref(), Some("w2"));
        assert_eq!(value.focused_pane_id.as_deref(), Some("p2"));
    }

    #[test]
    fn confirmed_workspace_rename_updates_the_react_visible_projection() {
        let mut state = synced_state();
        let before = state.revision;
        let mut renamed = workspace("w1");
        renamed.label = "release train".to_owned();

        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::WorkspaceRename {
                    workspace_id: "w1".to_owned(),
                    label: "release train".to_owned(),
                },
                &HerdrControlResult::WorkspaceInfo { workspace: renamed },
            ),
            ApplyResult::Applied
        );

        let projection = state.projection();
        assert!(projection.revision > before);
        assert_eq!(
            projection.snapshot.unwrap().workspaces[0].label,
            "release train"
        );
    }

    #[test]
    fn confirmed_tab_close_removes_its_panes_agents_and_layout() {
        let mut state = synced_state();
        let value = state.snapshot.as_mut().unwrap();
        value.tabs.push(tab("t2", "w1"));
        value
            .panes
            .push(pane("p2", "w1", "t2", HerdrAgentStatus::Working));
        value.agents.push(agent_in(
            "p2",
            "w1",
            "t2",
            HerdrAgentKind::Codex,
            "session-2",
        ));
        value.layouts.push(layout("w1", "t2", "p2"));
        normalize_snapshot(value);

        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::TabClose {
                    tab_id: "t2".to_owned(),
                },
                &HerdrControlResult::Ok,
            ),
            ApplyResult::Applied
        );

        let value = state.snapshot.unwrap();
        assert!(value.tabs.iter().all(|tab| tab.tab_id != "t2"));
        assert!(value.panes.iter().all(|pane| pane.tab_id != "t2"));
        assert!(value.agents.iter().all(|agent| agent.tab_id != "t2"));
        assert!(value.layouts.iter().all(|layout| layout.tab_id != "t2"));
        assert!((value.workspaces[0].tab_count - 1.0).abs() < f64::EPSILON);
        assert!((value.workspaces[0].pane_count - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn confirmed_pane_close_is_complete_without_a_snapshot() {
        let mut state = synced_state();
        state
            .snapshot
            .as_mut()
            .unwrap()
            .panes
            .push(pane("p2", "w1", "t1", HerdrAgentStatus::Idle));
        normalize_snapshot(state.snapshot.as_mut().unwrap());

        assert_eq!(state.terminal_id_for_pane("p1").as_deref(), Some("term-p1"));
        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::PaneClose {
                    pane_id: "p1".to_owned(),
                },
                &HerdrControlResult::Ok,
            ),
            ApplyResult::Applied
        );

        let projection = state.projection();
        assert!(!projection.needs_resync);
        assert_eq!(projection.freshness, HostFreshness::Fresh);
        let value = projection.snapshot.unwrap();
        assert!(value.panes.iter().all(|pane| pane.pane_id != "p1"));
        assert_eq!(value.focused_pane_id.as_deref(), Some("p2"));
    }

    #[test]
    fn queued_events_for_a_locally_closed_pane_are_ignored_until_confirmation() {
        let mut state = synced_state();
        state
            .snapshot
            .as_mut()
            .unwrap()
            .panes
            .push(pane("p2", "w1", "t1", HerdrAgentStatus::Idle));
        normalize_snapshot(state.snapshot.as_mut().unwrap());
        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::PaneClose {
                    pane_id: "p1".to_owned(),
                },
                &HerdrControlResult::Ok,
            ),
            ApplyResult::Applied
        );

        assert_eq!(
            state.apply_event(
                1,
                HerdrEvent::PaneAgentStatusChanged {
                    workspace_id: "w1".to_owned(),
                    pane_id: "p1".to_owned(),
                    agent_status: HerdrAgentStatus::Working,
                    agent: Some("codex".to_owned()),
                    title: None,
                    display_agent: None,
                    state_labels: None,
                },
                11,
            ),
            ApplyResult::IgnoredStale
        );
        assert!(!state.projection().needs_resync);

        assert_eq!(
            state.apply_event(
                1,
                HerdrEvent::PaneClosed {
                    workspace_id: "w1".to_owned(),
                    pane_id: "p1".to_owned(),
                },
                12,
            ),
            ApplyResult::Applied
        );
        assert!(!state.locally_closed_pane_ids.contains("p1"));
    }

    #[test]
    fn incomplete_control_result_commits_known_topology_and_needs_resync() {
        let mut state = synced_state();
        let result = state.apply_control_result(
            1,
            &HerdrControlRequest::PaneSplit {
                pane_id: "p1".to_owned(),
                direction: crate::herdr_api::HerdrSplitDirection::Right,
            },
            &HerdrControlResult::PaneInfo {
                pane: pane("p2", "w1", "t1", HerdrAgentStatus::Idle),
            },
        );

        assert!(matches!(result, ApplyResult::NeedsResync(_)));
        assert!(
            state
                .snapshot
                .as_ref()
                .unwrap()
                .panes
                .iter()
                .any(|pane| pane.pane_id == "p2")
        );
        assert!(state.needs_resync);
        assert_eq!(state.freshness, HostFreshness::Stale);
    }

    #[test]
    fn agent_results_project_codex_and_opencode_session_identity_onto_the_pane() {
        for (kind, session_id) in [
            (
                HerdrAgentKind::Codex,
                "018f0c7e-7b4b-7f23-8a7b-123456789abc",
            ),
            (HerdrAgentKind::OpenCode, "ses_123456789"),
        ] {
            let mut state = synced_state();
            let result = HerdrControlResult::AgentStarted {
                agent: agent("p1", kind, session_id),
                argv: Vec::new(),
            };
            assert_eq!(
                state.apply_control_result(
                    1,
                    &HerdrControlRequest::AgentStart {
                        name: "test-agent".to_owned(),
                        kind,
                        pane_id: "p1".to_owned(),
                        args: Vec::new(),
                    },
                    &result,
                ),
                ApplyResult::Applied
            );
            let snapshot = state.snapshot.unwrap();
            assert_eq!(
                snapshot.panes[0]
                    .agent_session
                    .as_ref()
                    .map(|session| session.value.as_str()),
                Some(session_id)
            );
        }
    }

    #[test]
    fn full_snapshot_projects_agent_session_identity_onto_the_pane() {
        let mut incoming = snapshot();
        incoming
            .agents
            .push(agent("p1", HerdrAgentKind::OpenCode, "ses_123456789"));
        assert_eq!(incoming.panes[0].agent_session, None);

        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, incoming, 10),
            ApplyResult::Applied
        );

        let snapshot = state.snapshot.unwrap();
        assert_eq!(
            snapshot.panes[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some("ses_123456789")
        );
    }

    #[test]
    fn full_snapshot_does_not_erase_authoritative_pane_session_when_agent_row_omits_it() {
        let session_id = "11111111-1111-4111-8111-111111111111";
        let mut incoming = snapshot();
        let mut incomplete_agent = agent("p1", HerdrAgentKind::Codex, session_id);
        incoming.panes[0].agent_session = incomplete_agent.agent_session.clone();
        incomplete_agent.agent_session = None;
        incoming.agents.push(incomplete_agent);

        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, incoming, 10),
            ApplyResult::Applied
        );

        let snapshot = state.snapshot.unwrap();
        assert_eq!(
            snapshot.panes[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
        assert_eq!(
            snapshot.agents[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
    }

    #[test]
    fn incremental_agent_response_without_session_preserves_pane_identity() {
        let session_id = "11111111-1111-4111-8111-111111111111";
        let mut incoming = snapshot();
        incoming
            .agents
            .push(agent("p1", HerdrAgentKind::Codex, session_id));
        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, incoming, 10),
            ApplyResult::Applied
        );

        let mut incomplete_agent = agent("p1", HerdrAgentKind::Codex, session_id);
        incomplete_agent.agent_session = None;
        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::AgentPrompt {
                    target: "p1".to_owned(),
                    text: "status".to_owned(),
                },
                &HerdrControlResult::AgentPrompted {
                    agent: incomplete_agent,
                },
            ),
            ApplyResult::Applied
        );

        let snapshot = state.snapshot.unwrap();
        assert_eq!(
            snapshot.panes[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
        assert_eq!(
            snapshot.agents[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
    }

    #[test]
    fn agent_metadata_without_any_session_does_not_create_a_chat_identity() {
        let mut incoming = snapshot();
        let mut metadata_only = agent(
            "p1",
            HerdrAgentKind::Codex,
            "11111111-1111-4111-8111-111111111111",
        );
        metadata_only.agent_session = None;
        metadata_only.display_agent = Some("Codex".to_owned());
        incoming.agents.push(metadata_only);

        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, incoming, 10),
            ApplyResult::Applied
        );

        let snapshot = state.snapshot.unwrap();
        assert_eq!(snapshot.panes[0].agent_session, None);
        assert_eq!(snapshot.agents[0].agent_session, None);
    }

    #[test]
    fn pane_update_preserves_agent_row_session_identity() {
        let session_id = "11111111-1111-4111-8111-111111111111";
        let mut incoming = snapshot();
        incoming
            .agents
            .push(agent("p1", HerdrAgentKind::Codex, session_id));
        let mut state = HostState::default();
        state.connection_installed(1);
        let token = state.begin_sync(1);
        assert_eq!(
            state.complete_sync(token, incoming, 10),
            ApplyResult::Applied
        );
        assert!(
            state.snapshot.as_ref().unwrap().panes[0]
                .agent_session
                .is_some()
        );

        let mut updated = pane("p1", "w1", "t1", HerdrAgentStatus::Idle);
        updated.agent = Some("codex".to_owned());
        updated.display_agent = Some("Codex".to_owned());
        assert_eq!(
            state.apply_event(1, HerdrEvent::PaneUpdated { pane: updated }, 11),
            ApplyResult::Applied
        );

        let snapshot = state.snapshot.unwrap();
        assert_eq!(
            snapshot.panes[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
        assert_eq!(
            snapshot.agents[0]
                .agent_session
                .as_ref()
                .map(|session| session.value.as_str()),
            Some(session_id)
        );
        assert_eq!(snapshot.panes[0].display_agent.as_deref(), Some("Codex"));
    }

    #[test]
    fn workspace_create_update_rename_and_remove_are_deterministic() {
        let mut state = synced_state();
        let mut created = workspace("w2");
        created.active_tab_id.clear();
        state.apply_event(
            1,
            HerdrEvent::WorkspaceCreated {
                workspace: created.clone(),
            },
            80,
        );
        created.label = "renamed by update".to_owned();
        state.apply_event(1, HerdrEvent::WorkspaceUpdated { workspace: created }, 81);
        state.apply_event(
            1,
            HerdrEvent::WorkspaceRenamed {
                workspace_id: "w2".to_owned(),
                label: "final".to_owned(),
            },
            82,
        );
        assert_eq!(
            state
                .snapshot
                .as_ref()
                .unwrap()
                .workspaces
                .iter()
                .find(|item| item.workspace_id == "w2")
                .unwrap()
                .label,
            "final"
        );
        state.apply_event(
            1,
            HerdrEvent::WorkspaceClosed {
                workspace_id: "w2".to_owned(),
                workspace: None,
            },
            83,
        );
        assert_eq!(state.snapshot.as_ref().unwrap().workspaces.len(), 1);
    }

    #[test]
    fn tab_and_pane_lifecycle_recalculates_counts_and_aggregates() {
        let mut state = synced_state();
        state.apply_event(
            1,
            HerdrEvent::TabCreated {
                tab: tab("t2", "w1"),
            },
            90,
        );
        state.apply_event(
            1,
            HerdrEvent::PaneCreated {
                pane: pane("p2", "w1", "t2", HerdrAgentStatus::Working),
            },
            91,
        );
        let value = state.snapshot.as_ref().unwrap();
        assert!((value.workspaces[0].tab_count - 2.0).abs() < f64::EPSILON);
        assert!((value.workspaces[0].pane_count - 2.0).abs() < f64::EPSILON);
        assert_eq!(value.workspaces[0].agent_status, HerdrAgentStatus::Working);
        state.apply_event(
            1,
            HerdrEvent::PaneClosed {
                workspace_id: "w1".to_owned(),
                pane_id: "p2".to_owned(),
            },
            92,
        );
        assert!(
            (state.snapshot.as_ref().unwrap().workspaces[0].pane_count - 1.0).abs() < f64::EPSILON
        );
        state.apply_event(
            1,
            HerdrEvent::TabClosed {
                workspace_id: "w1".to_owned(),
                tab_id: "t2".to_owned(),
            },
            93,
        );
        assert!(
            (state.snapshot.as_ref().unwrap().workspaces[0].tab_count - 1.0).abs() < f64::EPSILON
        );
    }

    #[test]
    fn workspace_tab_and_pane_focus_events_keep_one_consistent_hierarchy() {
        let mut state = synced_state();
        let mut second_workspace = workspace("w2");
        second_workspace.active_tab_id = "t2".to_owned();
        upsert_workspace(state.snapshot.as_mut().unwrap(), second_workspace);
        upsert_tab(state.snapshot.as_mut().unwrap(), tab("t2", "w2")).unwrap();
        upsert_pane(
            state.snapshot.as_mut().unwrap(),
            pane("p2", "w2", "t2", HerdrAgentStatus::Idle),
        )
        .unwrap();
        normalize_snapshot(state.snapshot.as_mut().unwrap());

        state.apply_event(
            1,
            HerdrEvent::WorkspaceFocused {
                workspace_id: "w2".to_owned(),
            },
            100,
        );
        state.apply_event(
            1,
            HerdrEvent::TabFocused {
                workspace_id: "w2".to_owned(),
                tab_id: "t2".to_owned(),
            },
            101,
        );
        state.apply_event(
            1,
            HerdrEvent::PaneFocused {
                workspace_id: "w2".to_owned(),
                pane_id: "p2".to_owned(),
            },
            102,
        );
        let value = state.snapshot.as_ref().unwrap();
        assert_eq!(value.focused_workspace_id.as_deref(), Some("w2"));
        assert_eq!(value.focused_tab_id.as_deref(), Some("t2"));
        assert_eq!(value.focused_pane_id.as_deref(), Some("p2"));
        assert_eq!(
            value.workspaces.iter().filter(|item| item.focused).count(),
            1
        );
        assert_eq!(value.tabs.iter().filter(|item| item.focused).count(), 1);
        assert_eq!(value.panes.iter().filter(|item| item.focused).count(), 1);
    }

    #[test]
    fn layout_updates_replace_by_tab_without_duplicates() {
        let mut state = synced_state();
        let make_layout = |zoomed| HerdrPaneLayoutSnapshot {
            workspace_id: "w1".to_owned(),
            tab_id: "t1".to_owned(),
            zoomed,
            area: HerdrPaneLayoutRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            focused_pane_id: "p1".to_owned(),
            panes: vec![HerdrPaneLayoutPane {
                pane_id: "p1".to_owned(),
                focused: true,
                rect: HerdrPaneLayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
            }],
            splits: Vec::new(),
        };
        state.apply_event(
            1,
            HerdrEvent::LayoutUpdated {
                layout: make_layout(false),
            },
            110,
        );
        state.apply_event(
            1,
            HerdrEvent::LayoutUpdated {
                layout: make_layout(true),
            },
            111,
        );
        let layouts = &state.snapshot.as_ref().unwrap().layouts;
        assert_eq!(layouts.len(), 1);
        assert!(layouts[0].zoomed);
    }

    #[test]
    fn inconsistent_events_coalesce_one_resync_request() {
        let mut state = synced_state();
        let reason = "missing parent".to_owned();
        assert!(state.request_resync(reason.clone()));
        assert!(!state.request_resync(reason));
        assert!(state.take_resync_request());
        assert!(!state.take_resync_request());
    }

    #[test]
    fn deferred_resync_mark_does_not_claim_the_resync_worker() {
        let mut state = synced_state();
        state.mark_needs_resync("event stream delivery gap".to_owned());

        assert!(state.request_resync("event stream restored".to_owned()));
        assert!(state.take_resync_request());
    }

    #[test]
    fn invalid_full_snapshot_is_a_failed_read_not_destructive_empty_state() {
        let mut state = synced_state();
        let token = state.begin_sync(1);
        let mut invalid = snapshot();
        invalid.tabs[0].workspace_id = "missing".to_owned();
        assert!(matches!(
            state.complete_sync(token, invalid, 120),
            ApplyResult::NeedsResync(_)
        ));
        assert_eq!(state.snapshot.as_ref().unwrap().panes[0].pane_id, "p1");
        assert_eq!(state.freshness, HostFreshness::Stale);
    }

    #[test]
    fn confirmed_close_results_remove_descendants_without_an_event_round_trip() {
        let mut state = synced_state();
        state.snapshot.as_mut().unwrap().agents.push(agent(
            "p1",
            HerdrAgentKind::Codex,
            "session-1",
        ));
        state
            .snapshot
            .as_mut()
            .unwrap()
            .layouts
            .push(layout("w1", "t1", "p1"));
        assert_eq!(
            state.apply_control_result(
                1,
                &HerdrControlRequest::WorkspaceClose {
                    workspace_id: "w1".to_owned(),
                },
                &HerdrControlResult::Ok,
            ),
            ApplyResult::Applied
        );
        let value = state.snapshot.unwrap();
        assert!(value.workspaces.is_empty());
        assert!(value.tabs.is_empty());
        assert!(value.panes.is_empty());
        assert!(value.agents.is_empty());
        assert!(value.layouts.is_empty());
        assert_eq!(value.focused_pane_id, None);
    }

    #[test]
    fn revisions_are_monotonic_across_sync_event_failure_and_disconnect() {
        let mut state = HostState::default();
        let mut revisions = vec![state.revision];
        state.connection_installed(1);
        revisions.push(state.revision);
        let token = state.begin_sync(1);
        revisions.push(state.revision);
        state.complete_sync(token, snapshot(), 1);
        revisions.push(state.revision);
        state.apply_event(
            1,
            HerdrEvent::WorkspaceFocused {
                workspace_id: "w1".to_owned(),
            },
            2,
        );
        revisions.push(state.revision);
        let token = state.begin_sync(1);
        state.fail_sync(token, "failed".to_owned());
        revisions.push(state.revision);
        state.mark_disconnected();
        revisions.push(state.revision);
        assert!(revisions.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
