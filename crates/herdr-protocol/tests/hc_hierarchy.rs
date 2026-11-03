#![allow(
    clippy::unwrap_used,
    reason = "behavioral graph fixtures fail immediately on malformed input or unexpected projection"
)]
use herdr_protocol::{
    control::{HerdrAgentInfo, HerdrAgentStatus as Status},
    hc::{
        hierarchy::{self, VIRTUAL_LAYOUT_LABEL},
        projection::PARENT_LABEL,
    },
};
use std::collections::{BTreeSet, HashMap};

fn agent(
    address: &str,
    parent: Option<&str>,
    workspace: &str,
    detached: bool,
    status: Status,
) -> HerdrAgentInfo {
    let mut labels = HashMap::new();
    if let Some(parent) = parent {
        labels.insert(PARENT_LABEL.into(), parent.into());
    }
    if detached {
        labels.insert(VIRTUAL_LAYOUT_LABEL.into(), "1".into());
    }
    HerdrAgentInfo {
        pane_id: format!("pane-{address}"),
        terminal_id: address.into(),
        workspace_id: workspace.into(),
        tab_id: format!("tab-{address}"),
        focused: false,
        agent_status: status,
        revision: 1.0,
        cwd: None,
        foreground_cwd: None,
        agent: Some("codex".into()),
        name: None,
        title: None,
        terminal_title: None,
        terminal_title_stripped: None,
        display_agent: None,
        interactive_ready: None,
        launch_pending: None,
        screen_detection_skipped: None,
        state_change_seq: None,
        state_labels: Some(labels),
        tokens: None,
        agent_session: None,
    }
}

#[test]
fn recursive_children_inherit_group_location_without_changing_their_targets_or_own_status() {
    let agents = vec![
        agent("t1", None, "repo", false, Status::Idle),
        agent("t2", Some("t1"), "terminals", true, Status::Done),
        agent("t3", Some("t2"), "terminals", true, Status::Blocked),
    ];
    let forest = hierarchy::project(&agents);
    assert_eq!(forest.order, ["t1", "t2", "t3"]);
    assert_eq!(forest.nodes["t1"].descendants, 2);
    assert_eq!(forest.nodes["t1"].status, Status::Blocked);
    assert_eq!(forest.nodes["t3"].ancestors, ["t1", "t2"]);
    assert_eq!(forest.nodes["t3"].depth, 2);
    assert_eq!(forest.nodes["t3"].workspace, "repo");
    assert_eq!(agents[0].agent_status, Status::Idle);
    assert_eq!(agents[2].workspace_id, "terminals");
    assert_eq!(agents[2].pane_id, "pane-t3");
    assert_eq!(agents[2].terminal_id, "t3");
}

#[test]
fn existing_panes_keep_their_workspace_and_duplicate_views_do_not_duplicate_tasks() {
    let parent = agent("t1", None, "repo", false, Status::Working);
    let child = agent("t2", Some("t1"), "other-repo", false, Status::Unknown);
    let forest = hierarchy::project(&[parent, child.clone(), child]);
    assert_eq!(forest.order, ["t1", "t2"]);
    assert_eq!(forest.nodes["t2"].workspace, "other-repo");
    assert_eq!(forest.nodes["t2"].status, Status::Unknown);
    assert_eq!(forest.nodes["t1"].status, Status::Working);
    let orphan = hierarchy::project(&[agent("t2", Some("t1"), "other-repo", false, Status::Done)]);
    assert_eq!(orphan.order, ["t2"]);
    assert!(orphan.nodes["t2"].parent.is_none());
    assert!(orphan.nodes["t2"].delegated);
}

#[test]
fn remote_parent_addresses_are_relative_to_the_childs_machine() {
    let agents = vec![
        agent("t1", None, "local", false, Status::Idle),
        agent("mac/t1", None, "mac", false, Status::Idle),
        agent("mac/t2", Some("t1"), "fallback", true, Status::Idle),
        agent("mac/t3", Some("mac/t2"), "fallback", true, Status::Idle),
    ];
    let forest = hierarchy::project(&agents);
    assert_eq!(forest.nodes["mac/t2"].parent.as_deref(), Some("mac/t1"));
    assert_eq!(forest.nodes["mac/t3"].ancestors, ["mac/t1", "mac/t2"]);
    assert_eq!(forest.nodes["mac/t3"].workspace, "mac");
    assert_eq!(forest.nodes["t1"].descendants, 0);
}

#[test]
fn malformed_cycles_and_deep_chains_leave_every_terminal_reachable_once() {
    let agents = vec![
        agent("a", Some("b"), "repo", true, Status::Idle),
        agent("b", Some("c"), "repo", true, Status::Idle),
        agent("c", Some("a"), "repo", true, Status::Unknown),
        agent("self", Some("self"), "repo", true, Status::Unknown),
    ];
    let forest = hierarchy::project(&agents);
    assert_eq!(
        forest.order.iter().collect::<BTreeSet<_>>().len(),
        agents.len()
    );
    assert!(forest.nodes["a"].parent.is_none());
    assert!(forest.nodes["self"].parent.is_none());
    let deep = (0..200)
        .map(|index| {
            agent(
                &format!("t{index}"),
                (index > 0).then(|| format!("t{}", index - 1)).as_deref(),
                "repo",
                true,
                Status::Unknown,
            )
        })
        .collect::<Vec<_>>();
    let forest = hierarchy::project(&deep);
    assert_eq!(
        forest.order.iter().collect::<BTreeSet<_>>().len(),
        deep.len()
    );
    assert!(
        forest
            .nodes
            .values()
            .all(|node| node.depth <= 64 && node.ancestors.len() <= 64)
    );
    assert!(
        forest
            .nodes
            .values()
            .filter(|node| node.parent.is_none())
            .count()
            > 1
    );
}

#[test]
fn attention_and_pinning_sort_groups_without_separating_their_children() {
    let mut child = agent("child", Some("parent"), "fallback", true, Status::Done);
    child
        .state_labels
        .as_mut()
        .unwrap()
        .insert("herdr.pinned".into(), "1".into());
    let agents = vec![
        agent("blocked", None, "repo", false, Status::Blocked),
        agent("parent", None, "repo", false, Status::Idle),
        child,
    ];
    let forest = hierarchy::project(&agents);
    assert_eq!(forest.order, ["parent", "child", "blocked"]);
    assert_eq!(forest.nodes["parent"].status, Status::Done);
    assert!(forest.nodes["parent"].pinned);
    for (child_status, expected) in [
        (Status::Blocked, Status::Blocked),
        (Status::Done, Status::Done),
        (Status::Working, Status::Working),
        (Status::Idle, Status::Idle),
    ] {
        let forest = hierarchy::project(&[
            agent("parent", None, "repo", false, Status::Unknown),
            agent("child", Some("parent"), "fallback", true, child_status),
        ]);
        assert_eq!(forest.nodes["parent"].status, expected);
    }
}

#[test]
fn rebuilding_after_parent_or_child_removal_clears_old_groups_and_attention() {
    let parent = agent("t1", None, "repo", false, Status::Idle);
    let child = agent("t2", Some("t1"), "fallback", true, Status::Blocked);
    assert_eq!(
        hierarchy::project(&[parent.clone(), child.clone()]).nodes["t1"].status,
        Status::Blocked
    );
    let without_child = hierarchy::project(&[parent]);
    assert_eq!(without_child.nodes["t1"].descendants, 0);
    assert_eq!(without_child.nodes["t1"].status, Status::Idle);
    let without_parent = hierarchy::project(&[child]);
    assert_eq!(without_parent.order, ["t2"]);
    assert_eq!(without_parent.nodes["t2"].workspace, "fallback");
}
