//! Core delegation groups over projected live terminal identities.
//! This never edits the desktop document or changes terminal navigation targets.
use super::{attention::PINNED_LABEL, projection::PARENT_LABEL};
use crate::control::{HerdrAgentInfo, HerdrAgentStatus};
use std::collections::{BTreeMap, BTreeSet};

pub const VIRTUAL_LAYOUT_LABEL: &str = "hc.virtual-layout";
const MAX_DEPTH: u32 = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub parent: Option<String>,
    pub ancestors: Vec<String>,
    pub depth: u32,
    pub descendants: u32,
    pub status: HerdrAgentStatus,
    pub pinned: bool,
    pub workspace: String,
    pub delegated: bool,
}
#[derive(Clone, Debug, Default)]
pub struct Forest {
    pub nodes: BTreeMap<String, Node>,
    pub order: Vec<String>,
}
fn label<'a>(agent: &'a HerdrAgentInfo, key: &str) -> Option<&'a str> {
    agent
        .state_labels
        .as_ref()?
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}
fn qualify(parent: &str, child: &str) -> String {
    if parent.contains('/') {
        parent.into()
    } else {
        child.rsplit_once('/').map_or_else(
            || parent.into(),
            |(machine, _)| format!("{machine}/{parent}"),
        )
    }
}

pub fn project(agents: &[HerdrAgentInfo]) -> Forest {
    let mut records = BTreeMap::new();
    let mut indexes = BTreeMap::new();
    for (index, agent) in agents.iter().enumerate() {
        records.entry(agent.terminal_id.clone()).or_insert(agent);
        indexes.entry(agent.terminal_id.clone()).or_insert(index);
    }
    let mut parents: BTreeMap<_, _> = records
        .iter()
        .map(|(address, agent)| {
            let parent = label(agent, PARENT_LABEL)
                .map(|parent| qualify(parent, address))
                .filter(|parent| parent != address && records.contains_key(parent));
            (address.clone(), parent)
        })
        .collect();
    // A functional graph has at most one cycle along each path. Cut one stable
    // edge per cycle, then retain every terminal as an independently reachable row.
    let mut visited = BTreeSet::new();
    for address in records.keys() {
        if visited.contains(address) {
            continue;
        }
        let mut path = Vec::new();
        let mut positions = BTreeMap::new();
        let mut cursor = Some(address.clone());
        while let Some(current) = cursor {
            if let Some(at) = positions.get(&current) {
                if let Some(root) = path[*at..].iter().min().cloned() {
                    parents.insert(root, None);
                }
                break;
            }
            if visited.contains(&current) {
                break;
            }
            positions.insert(current.clone(), path.len());
            path.push(current.clone());
            cursor = parents.get(&current).cloned().flatten();
        }
        visited.extend(path);
    }
    let children = child_map(&parents);
    let mut pending = children.get(&None).cloned().unwrap_or_default();
    pending.reverse();
    let mut forest = Forest::default();
    while let Some(address) = pending.pop() {
        let agent = records[&address];
        let parent = parents[&address]
            .as_ref()
            .and_then(|parent| forest.nodes.get(parent).map(|node| (parent.clone(), node)))
            .filter(|(_, node)| node.depth < MAX_DEPTH);
        let ancestors = parent.as_ref().map_or_else(Vec::new, |(id, node)| {
            let mut ancestors = node.ancestors.clone();
            ancestors.push(id.clone());
            ancestors
        });
        let workspace = if label(agent, VIRTUAL_LAYOUT_LABEL).is_some() {
            parent.as_ref().map_or_else(
                || agent.workspace_id.clone(),
                |(_, node)| node.workspace.clone(),
            )
        } else {
            agent.workspace_id.clone()
        };
        let node = Node {
            parent: parent.map(|(id, _)| id),
            depth: u32::try_from(ancestors.len()).unwrap_or(MAX_DEPTH),
            ancestors,
            descendants: 0,
            status: agent.agent_status,
            pinned: label(agent, PINNED_LABEL).is_some(),
            workspace,
            delegated: label(agent, PARENT_LABEL).is_some(),
        };
        parents.insert(address.clone(), node.parent.clone());
        forest.nodes.insert(address.clone(), node);
        forest.order.push(address.clone());
        if let Some(children) = children.get(&Some(address)) {
            pending.extend(children.iter().rev().cloned());
        }
    }
    for address in forest.order.iter().rev() {
        let node = forest.nodes[address].clone();
        if let Some(parent) = node.parent.and_then(|parent| forest.nodes.get_mut(&parent)) {
            parent.descendants = parent.descendants.saturating_add(node.descendants + 1);
            if node.status.priority() < parent.status.priority() {
                parent.status = node.status;
            }
            parent.pinned |= node.pinned;
        }
    }
    let mut children = child_map(&parents);
    for siblings in children.values_mut() {
        siblings.sort_by_key(|address| {
            let node = &forest.nodes[address];
            (!node.pinned, node.status.priority(), indexes[address])
        });
    }
    forest.order.clear();
    pending = children.get(&None).cloned().unwrap_or_default();
    pending.reverse();
    while let Some(address) = pending.pop() {
        forest.order.push(address.clone());
        if let Some(children) = children.get(&Some(address)) {
            pending.extend(children.iter().rev().cloned());
        }
    }
    forest
}
fn child_map(parents: &BTreeMap<String, Option<String>>) -> BTreeMap<Option<String>, Vec<String>> {
    let mut children: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for (address, parent) in parents {
        children
            .entry(parent.clone())
            .or_default()
            .push(address.clone());
    }
    children
}
