//! Compact Herd projection over authoritative runtime snapshots.

use std::collections::HashMap;

use crate::herdr_api::{HerdrAgentInfo, HerdrAgentStatus, HerdrTabInfo, HerdrWorkspaceInfo};
use crate::host_runtime::AgentControlView;
use crate::host_state::HostSyncStatus;

use super::sessions::{AppConnectionStatus, AppCoreState};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdSessionMetadata {
    pub session_id: String,
    pub host_label: String,
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdHostView {
    pub id: String,
    pub label: String,
    pub address: String,
    pub connected: bool,
    pub running: bool,
    pub refreshing: bool,
    pub agent_status: HerdrAgentStatus,
    pub agents: Vec<HerdrAgentInfo>,
    pub workspaces: Vec<HerdrWorkspaceInfo>,
    pub tabs: Vec<HerdrTabInfo>,
    pub agent_controls: Vec<AgentControlView>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdAgentView {
    pub host_id: String,
    pub host_label: String,
    pub agent: HerdrAgentInfo,
    pub workspace_label: String,
    pub tab_label: String,
    pub primary_label: String,
    pub control: Option<AgentControlView>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdView {
    pub revision: u64,
    pub selected_host_id: Option<String>,
    pub selected_workspace_id: Option<String>,
    pub hosts: Vec<HerdHostView>,
    pub agents: Vec<HerdAgentView>,
}

pub(super) fn project(
    state: &mut AppCoreState,
    metadata: Vec<HerdSessionMetadata>,
    requested_host_id: Option<String>,
    requested_workspace_id: Option<String>,
) -> HerdView {
    state.reconcile_selections();
    let metadata = metadata
        .into_iter()
        .map(|entry| (entry.session_id.clone(), entry))
        .collect::<HashMap<_, _>>();
    let mut hosts = state
        .sessions
        .iter()
        .map(|session| {
            let session_view = session.view();
            let host_state = session_view.host_state.as_ref();
            let snapshot = host_state.and_then(|state| state.snapshot.as_ref());
            let meta = metadata.get(&session.id);
            let agents = snapshot.map_or_else(Vec::new, |snapshot| {
                snapshot
                    .agents
                    .iter()
                    .map(|agent| {
                        let mut agent = agent.clone();
                        // Agent-row flags can lag behind pane-focus events.
                        agent.focused =
                            snapshot.focused_pane_id.as_deref() == Some(agent.pane_id.as_str());
                        agent
                    })
                    .collect::<Vec<_>>()
            });
            HerdHostView {
                id: session.id.clone(),
                label: meta
                    .map(|value| value.host_label.clone())
                    .unwrap_or_else(|| session.host_id.clone()),
                address: meta.map(|value| value.address.clone()).unwrap_or_default(),
                connected: matches!(
                    session_view.connection_status,
                    AppConnectionStatus::Connected | AppConnectionStatus::Ready
                ),
                running: snapshot.is_some(),
                refreshing: host_state
                    .is_some_and(|state| state.sync_status == HostSyncStatus::Syncing),
                agent_status: aggregate_status(agents.iter().map(|agent| agent.agent_status)),
                agents,
                workspaces: snapshot.map_or_else(Vec::new, |value| value.workspaces.clone()),
                tabs: snapshot.map_or_else(Vec::new, |value| value.tabs.clone()),
                agent_controls: session_view.agent_controls,
            }
        })
        .collect::<Vec<_>>();
    hosts.sort_by(|left, right| {
        right.connected.cmp(&left.connected).then(
            left.agent_status
                .priority()
                .cmp(&right.agent_status.priority()),
        )
    });

    project_hosts(
        state.revision,
        hosts,
        requested_host_id,
        requested_workspace_id,
    )
}

fn project_hosts(
    revision: u64,
    hosts: Vec<HerdHostView>,
    requested_host_id: Option<String>,
    requested_workspace_id: Option<String>,
) -> HerdView {
    let selected_host_id = if hosts.len() == 1 {
        Some(hosts[0].id.clone())
    } else {
        requested_host_id.filter(|id| hosts.iter().any(|host| &host.id == id))
    };
    let selected_host = selected_host_id
        .as_ref()
        .and_then(|id| hosts.iter().find(|host| &host.id == id));
    let selected_workspace_id = selected_host.and_then(|host| {
        if host.workspaces.len() == 1 {
            Some(host.workspaces[0].workspace_id.clone())
        } else {
            requested_workspace_id
                .as_ref()
                .filter(|id| {
                    host.workspaces
                        .iter()
                        .any(|workspace| &workspace.workspace_id == *id)
                })
                .cloned()
        }
    });
    let scoped_hosts =
        selected_host.map_or_else(|| hosts.iter().collect::<Vec<_>>(), |host| vec![host]);
    let mut agents = scoped_hosts
        .into_iter()
        .flat_map(|host| {
            let tabs = host
                .tabs
                .iter()
                .map(|tab| (tab.tab_id.as_str(), tab))
                .collect::<HashMap<_, _>>();
            let workspaces = host
                .workspaces
                .iter()
                .map(|workspace| (workspace.workspace_id.as_str(), workspace))
                .collect::<HashMap<_, _>>();
            let tab_counts = host.tabs.iter().fold(HashMap::new(), |mut counts, tab| {
                *counts.entry(tab.workspace_id.as_str()).or_insert(0_u32) += 1;
                counts
            });
            host.agents
                .iter()
                .filter(|agent| {
                    selected_workspace_id
                        .as_ref()
                        .is_none_or(|id| &agent.workspace_id == id)
                })
                .map(|agent| {
                    let workspace_label = workspaces
                        .get(agent.workspace_id.as_str())
                        .map(|workspace| workspace.label.trim())
                        .filter(|label| !label.is_empty())
                        .unwrap_or(&agent.workspace_id)
                        .to_owned();
                    let tab_label = tabs
                        .get(agent.tab_id.as_str())
                        .map(|tab| tab.label.trim())
                        .filter(|label| !label.is_empty())
                        .unwrap_or(&agent.tab_id)
                        .to_owned();
                    let primary_label = if tab_counts
                        .get(agent.workspace_id.as_str())
                        .copied()
                        .unwrap_or_default()
                        > 1
                    {
                        format!("{workspace_label} · {tab_label}")
                    } else {
                        workspace_label.clone()
                    };
                    HerdAgentView {
                        control: host
                            .agent_controls
                            .iter()
                            .find(|control| control.terminal_id == agent.terminal_id)
                            .cloned(),
                        host_id: host.id.clone(),
                        host_label: host.label.clone(),
                        agent: agent.clone(),
                        workspace_label,
                        tab_label,
                        primary_label,
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        left.agent
            .agent_status
            .priority()
            .cmp(&right.agent.agent_status.priority())
            .then_with(|| {
                right
                    .agent
                    .state_change_seq
                    .partial_cmp(&left.agent.state_change_seq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    HerdView {
        revision,
        selected_host_id,
        selected_workspace_id,
        hosts,
        agents,
    }
}

fn aggregate_status(statuses: impl Iterator<Item = HerdrAgentStatus>) -> HerdrAgentStatus {
    statuses
        .min_by_key(|status| status.priority())
        .unwrap_or(HerdrAgentStatus::Idle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str) -> HerdrWorkspaceInfo {
        HerdrWorkspaceInfo {
            workspace_id: id.to_owned(),
            number: 1.0,
            label: id.to_owned(),
            focused: false,
            pane_count: 1.0,
            tab_count: 1.0,
            active_tab_id: format!("{id}-tab"),
            agent_status: HerdrAgentStatus::Idle,
            tokens: None,
            worktree: None,
        }
    }

    fn tab(workspace_id: &str) -> HerdrTabInfo {
        HerdrTabInfo {
            tab_id: format!("{workspace_id}-tab"),
            workspace_id: workspace_id.to_owned(),
            number: 1.0,
            label: format!("{workspace_id} tab"),
            focused: false,
            pane_count: 1.0,
            agent_status: HerdrAgentStatus::Idle,
        }
    }

    fn agent(workspace_id: &str) -> HerdrAgentInfo {
        HerdrAgentInfo {
            pane_id: format!("{workspace_id}-pane"),
            terminal_id: format!("{workspace_id}-terminal"),
            workspace_id: workspace_id.to_owned(),
            tab_id: format!("{workspace_id}-tab"),
            focused: false,
            agent_status: HerdrAgentStatus::Idle,
            revision: 1.0,
            cwd: None,
            foreground_cwd: None,
            agent: Some("codex".to_owned()),
            name: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            interactive_ready: None,
            launch_pending: None,
            screen_detection_skipped: None,
            state_change_seq: None,
            state_labels: None,
            tokens: None,
            agent_session: None,
        }
    }

    fn host(id: &str, workspace_ids: &[&str]) -> HerdHostView {
        HerdHostView {
            id: id.to_owned(),
            label: id.to_owned(),
            address: format!("{id}.example.test"),
            connected: true,
            running: true,
            refreshing: false,
            agent_status: HerdrAgentStatus::Idle,
            agents: workspace_ids.iter().map(|id| agent(id)).collect(),
            workspaces: workspace_ids.iter().map(|id| workspace(id)).collect(),
            tabs: workspace_ids.iter().map(|id| tab(id)).collect(),
            agent_controls: Vec::new(),
        }
    }

    fn projected_agent_workspaces(view: &HerdView) -> Vec<&str> {
        view.agents
            .iter()
            .map(|agent| agent.agent.workspace_id.as_str())
            .collect()
    }

    #[test]
    fn single_host_workspace_request_selects_and_filters() {
        let view = project_hosts(
            7,
            vec![host("host-1", &["space-a", "space-b"])],
            Some("host-1".to_owned()),
            Some("space-b".to_owned()),
        );

        assert_eq!(view.selected_host_id.as_deref(), Some("host-1"));
        assert_eq!(view.selected_workspace_id.as_deref(), Some("space-b"));
        assert_eq!(projected_agent_workspaces(&view), ["space-b"]);
    }

    #[test]
    fn single_workspace_is_auto_selected_without_a_workspace_request() {
        let view = project_hosts(7, vec![host("host-1", &["only-space"])], None, None);

        assert_eq!(view.selected_host_id.as_deref(), Some("host-1"));
        assert_eq!(view.selected_workspace_id.as_deref(), Some("only-space"));
        assert_eq!(projected_agent_workspaces(&view), ["only-space"]);
    }

    #[test]
    fn workspace_request_is_validated_against_the_selected_host() {
        let view = project_hosts(
            7,
            vec![
                host("host-1", &["space-a", "space-b"]),
                host("host-2", &["space-c", "space-d"]),
            ],
            Some("host-2".to_owned()),
            Some("space-b".to_owned()),
        );

        assert_eq!(view.selected_host_id.as_deref(), Some("host-2"));
        assert_eq!(view.selected_workspace_id, None);
        assert_eq!(projected_agent_workspaces(&view), ["space-c", "space-d"]);
    }

    #[test]
    fn no_workspace_request_projects_all_agents_for_the_selected_host() {
        let view = project_hosts(
            7,
            vec![host("host-1", &["space-a", "space-b"])],
            Some("host-1".to_owned()),
            None,
        );

        assert_eq!(view.selected_workspace_id, None);
        assert_eq!(projected_agent_workspaces(&view), ["space-a", "space-b"]);
    }

    #[test]
    fn status_order_is_blocked_done_working_idle_unknown() {
        let mut statuses = [
            HerdrAgentStatus::Idle,
            HerdrAgentStatus::Unknown,
            HerdrAgentStatus::Working,
            HerdrAgentStatus::Blocked,
            HerdrAgentStatus::Done,
        ];
        statuses.sort_by_key(|status| status.priority());
        assert_eq!(
            statuses,
            [
                HerdrAgentStatus::Blocked,
                HerdrAgentStatus::Done,
                HerdrAgentStatus::Working,
                HerdrAgentStatus::Idle,
                HerdrAgentStatus::Unknown,
            ]
        );
    }

    #[test]
    fn empty_herd_status_defaults_to_idle_but_unknown_agents_stay_unknown() {
        assert_eq!(aggregate_status(std::iter::empty()), HerdrAgentStatus::Idle);
        assert_eq!(
            aggregate_status(std::iter::once(HerdrAgentStatus::Unknown)),
            HerdrAgentStatus::Unknown
        );
    }
}
