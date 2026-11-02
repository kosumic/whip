//! Compact Herd projection over authoritative runtime snapshots.

use herdr_protocol::hc::hierarchy;
use std::collections::{HashMap, HashSet};

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
    pub core_backend: bool,
    pub pinned_terminals: Vec<String>,
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
    pub core_pinned: Option<bool>,
    pub core_hierarchy: Option<CoreAgentHierarchy>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct CoreAgentHierarchy {
    pub parent_terminal_id: Option<String>,
    pub ancestors: Vec<String>,
    pub depth: u32,
    pub descendant_count: u32,
    pub group_status: HerdrAgentStatus,
    pub delegated: bool,
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
    let agent_orders = state
        .sessions
        .iter()
        .filter_map(|session| {
            session
                .agent_order()
                .map(|order| (session.id.clone(), order))
        })
        .collect::<HashMap<_, _>>();
    // Server orders are host-local. Mixed views keep the existing host ranking,
    // with attention sorting inside groups that have no server projection.
    let follow_server_order = !agent_orders.is_empty();
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
            let core_backend = session.core_backend();
            let pinned_terminals =
                snapshot
                    .filter(|_| core_backend)
                    .map_or_else(Vec::new, |snapshot| {
                        snapshot
                            .panes
                            .iter()
                            .filter(|pane| {
                                pane.state_labels.as_ref().is_some_and(|labels| {
                                    labels
                                        .get(herdr_protocol::hc::attention::PINNED_LABEL)
                                        .is_some_and(|value| !value.is_empty())
                                })
                            })
                            .map(|pane| pane.terminal_id.clone())
                            .collect::<Vec<_>>()
                    });
            let meta = metadata.get(&session.id);
            let mut agents = snapshot.map_or_else(Vec::new, |snapshot| {
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
            if let Some(order) = agent_orders.get(&session.id) {
                let mut by_pane = agents
                    .into_iter()
                    .map(|agent| (agent.pane_id.clone(), agent))
                    .collect::<HashMap<_, _>>();
                agents = order
                    .iter()
                    .filter_map(|pane_id| by_pane.remove(pane_id))
                    .collect();
            } else if follow_server_order {
                agents.sort_by(compare_agent_priority);
            }
            if core_backend {
                agents.sort_by(|left, right| {
                    pinned_terminals
                        .contains(&right.terminal_id)
                        .cmp(&pinned_terminals.contains(&left.terminal_id))
                        .then_with(|| compare_agent_priority(left, right))
                });
            }
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
                core_backend,
                pinned_terminals,
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
        follow_server_order,
    )
}

fn project_hosts(
    revision: u64,
    hosts: Vec<HerdHostView>,
    requested_host_id: Option<String>,
    requested_workspace_id: Option<String>,
    follow_server_order: bool,
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
            let hierarchy = host.core_backend.then(|| hierarchy::project(&host.agents));
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
                        .is_none_or(|id| grouping_workspace(hierarchy.as_ref(), agent) == id)
                })
                .map(|agent| {
                    let grouping_workspace = grouping_workspace(hierarchy.as_ref(), agent);
                    let workspace_label = workspaces
                        .get(grouping_workspace)
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
                        core_hierarchy: None,
                        core_pinned: host
                            .core_backend
                            .then(|| host.pinned_terminals.contains(&agent.terminal_id)),
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
    if !follow_server_order {
        agents.sort_by(|left, right| compare_agent_priority(&left.agent, &right.agent));
    }
    // A terminal can be drawn in several desktop panes. Herd lists it once;
    // legacy hosts keep their existing pane-oriented rows.
    let mut seen = HashSet::new();
    agents.retain(|row| {
        row.core_pinned.is_none()
            || seen.insert((row.host_id.clone(), row.agent.terminal_id.clone()))
    });
    // Core task groups occupy only their own host's slots in mixed queues.
    for host in hosts.iter().filter(|host| host.core_backend) {
        let positions = agents
            .iter()
            .enumerate()
            .filter(|(_, agent)| agent.host_id == host.id)
            .map(|(at, _)| at)
            .collect::<Vec<_>>();
        let mut by_terminal = positions
            .iter()
            .map(|at| (agents[*at].agent.terminal_id.clone(), agents[*at].clone()))
            .collect::<HashMap<_, _>>();
        let all = hierarchy::project(&host.agents);
        let visible = hierarchy::project(
            &positions
                .iter()
                .map(|at| agents[*at].agent.clone())
                .collect::<Vec<_>>(),
        );
        for (at, terminal) in positions.into_iter().zip(&visible.order) {
            if let (Some(mut row), Some(node)) =
                (by_terminal.remove(terminal), visible.nodes.get(terminal))
            {
                let group = all.nodes.get(terminal).unwrap_or(node);
                row.core_hierarchy = Some(CoreAgentHierarchy {
                    parent_terminal_id: node.parent.clone(),
                    ancestors: node.ancestors.clone(),
                    depth: node.depth,
                    descendant_count: group.descendants,
                    group_status: group.status,
                    delegated: node.delegated,
                });
                agents[at] = row;
            }
        }
    }
    HerdView {
        revision,
        selected_host_id,
        selected_workspace_id,
        hosts,
        agents,
    }
}

fn grouping_workspace<'a>(
    hierarchy: Option<&'a hierarchy::Forest>,
    agent: &'a HerdrAgentInfo,
) -> &'a str {
    hierarchy
        .and_then(|forest| forest.nodes.get(&agent.terminal_id))
        .map_or(&agent.workspace_id, |node| &node.workspace)
}

fn compare_agent_priority(left: &HerdrAgentInfo, right: &HerdrAgentInfo) -> std::cmp::Ordering {
    left.agent_status
        .priority()
        .cmp(&right.agent_status.priority())
        .then_with(|| {
            right
                .state_change_seq
                .partial_cmp(&left.state_change_seq)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
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
            label_is_custom: None,
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
            core_backend: false,
            pinned_terminals: Vec::new(),
        }
    }

    fn projected_agent_workspaces(view: &HerdView) -> Vec<&str> {
        view.agents
            .iter()
            .map(|agent| agent.agent.workspace_id.as_str())
            .collect()
    }

    fn delegation_host() -> HerdHostView {
        let mut core = host("core", &["a", "b", "fallback"]);
        core.core_backend = true;
        core.agents[1].state_labels = Some(
            [(
                herdr_protocol::hc::projection::PARENT_LABEL.into(),
                "a-terminal".into(),
            )]
            .into(),
        );
        core.agents[2].agent_status = HerdrAgentStatus::Blocked;
        core.agents[2].state_labels = Some(
            [
                (
                    herdr_protocol::hc::projection::PARENT_LABEL.into(),
                    "a-terminal".into(),
                ),
                (hierarchy::VIRTUAL_LAYOUT_LABEL.into(), "1".into()),
            ]
            .into(),
        );
        core
    }

    #[test]
    fn core_workspace_filter_inherits_only_unattached_child_locations_and_keeps_targets() {
        let core = delegation_host();
        let view = project_hosts(
            1,
            vec![core.clone()],
            Some("core".into()),
            Some("a".into()),
            false,
        );
        assert_eq!(
            view.agents
                .iter()
                .map(|row| row.agent.terminal_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-terminal", "fallback-terminal"]
        );
        let parent = &view.agents[0];
        assert_eq!(parent.agent.agent_status, HerdrAgentStatus::Idle);
        assert_eq!(
            parent.core_hierarchy.as_ref().map(|node| node.group_status),
            Some(HerdrAgentStatus::Blocked)
        );
        assert_eq!(
            parent
                .core_hierarchy
                .as_ref()
                .map(|node| node.descendant_count),
            Some(2)
        );
        let child = &view.agents[1];
        assert_eq!(child.workspace_label, "a");
        assert_eq!(child.agent.pane_id, "fallback-pane");
        assert_eq!(child.agent.tab_id, "fallback-tab");
        assert_eq!(child.agent.workspace_id, "fallback");
        assert_eq!(
            child.core_hierarchy.as_ref().map(|node| node.depth),
            Some(1)
        );
        let view = project_hosts(2, vec![core], Some("core".into()), Some("b".into()), false);
        assert_eq!(view.agents.len(), 1);
        assert_eq!(view.agents[0].agent.terminal_id, "b-terminal");
        assert_eq!(
            view.agents[0]
                .core_hierarchy
                .as_ref()
                .map(|node| node.depth),
            Some(0)
        );
    }

    #[test]
    fn legacy_parent_labels_and_duplicate_panes_keep_their_flat_behavior_in_mixed_hosts() {
        let core = delegation_host();
        let mut legacy = core.clone();
        legacy.id = "legacy".into();
        legacy.core_backend = false;
        let mut duplicate = core.agents[0].clone();
        duplicate.pane_id = "another-view".into();
        legacy.agents.push(duplicate.clone());
        let mut core = core;
        core.agents.push(duplicate);
        let baseline = project_hosts(1, vec![legacy.clone()], None, None, false);
        let mixed = project_hosts(2, vec![core, legacy], None, None, false);
        assert_eq!(
            mixed
                .agents
                .iter()
                .filter(|row| row.host_id == "legacy")
                .map(|row| &row.agent)
                .collect::<Vec<_>>(),
            baseline
                .agents
                .iter()
                .map(|row| &row.agent)
                .collect::<Vec<_>>()
        );
        assert!(
            mixed
                .agents
                .iter()
                .filter(|row| row.host_id == "legacy")
                .all(|row| row.core_hierarchy.is_none())
        );
        let core = mixed
            .agents
            .iter()
            .filter(|row| row.host_id == "core")
            .collect::<Vec<_>>();
        assert_eq!(core.len(), 3);
        assert_eq!(core[0].agent.terminal_id, "a-terminal");
        assert!(core[1..].iter().all(|row| {
            row.core_hierarchy
                .as_ref()
                .is_some_and(|node| node.parent_terminal_id.as_deref() == Some("a-terminal"))
        }));
    }

    #[test]
    fn core_pins_reorder_only_core_rows_and_legacy_rows_have_no_shared_attention() {
        let mut core = host("core", &["a", "b"]);
        core.core_backend = true;
        core.pinned_terminals = vec!["b-terminal".into()];
        core.agents[1].state_labels = Some(
            [(
                herdr_protocol::hc::attention::PINNED_LABEL.into(),
                "1".into(),
            )]
            .into(),
        );
        let legacy = host("legacy", &["c", "d"]);
        let view = project_hosts(1, vec![core, legacy], None, None, false);
        assert_eq!(
            view.agents
                .iter()
                .filter(|row| row.host_id == "core")
                .map(|row| row.agent.terminal_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b-terminal", "a-terminal"]
        );
        assert!(
            view.agents
                .iter()
                .filter(|row| row.host_id == "core")
                .all(|row| row.core_pinned.is_some())
        );
        assert_eq!(
            view.agents
                .iter()
                .filter(|row| row.host_id == "legacy")
                .map(|row| row.agent.terminal_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c-terminal", "d-terminal"]
        );
        assert!(
            view.agents
                .iter()
                .filter(|row| row.host_id == "legacy")
                .all(|row| row.core_pinned.is_none())
        );
    }

    #[test]
    fn single_host_workspace_request_selects_and_filters() {
        let view = project_hosts(
            7,
            vec![host("host-1", &["space-a", "space-b"])],
            Some("host-1".to_owned()),
            Some("space-b".to_owned()),
            false,
        );

        assert_eq!(view.selected_host_id.as_deref(), Some("host-1"));
        assert_eq!(view.selected_workspace_id.as_deref(), Some("space-b"));
        assert_eq!(projected_agent_workspaces(&view), ["space-b"]);
    }

    #[test]
    fn single_workspace_is_auto_selected_without_a_workspace_request() {
        let view = project_hosts(7, vec![host("host-1", &["only-space"])], None, None, false);

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
            false,
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
            false,
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
