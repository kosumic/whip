//! Pure projection of core terminals and opaque desktop documents into the
//! existing Herdr domain model. Private view choices are supplied by the caller.
use super::{
    Error, GENERATION,
    documents::{APP_DOCUMENT, Documents},
    events::{DocumentKey, Snapshot, reported_status},
    generated::Terminal,
};
use crate::control::{
    HerdrAgentInfo, HerdrAgentSessionInfo, HerdrAgentSessionKind, HerdrAgentStatus, HerdrPaneInfo,
    HerdrPaneLayoutPane, HerdrPaneLayoutRect, HerdrPaneLayoutSnapshot, HerdrSessionSnapshot,
    HerdrTabInfo, HerdrWorkspaceInfo,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write;

pub const PARENT_LABEL: &str = "hc.parent";
pub const FALLBACK_SPACE: &str = "whip-terminals";
const MAX_LAYOUT_NODES: usize = 8192;
const MAX_LAYOUT_DEPTH: usize = 64;

#[derive(Clone, Debug, Default)]
pub struct View {
    pub workspace: Option<String>,
    pub tab: Option<String>,
    pub pane: Option<String>,
    pub zoomed: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpaceLocation {
    pub key: DocumentKey,
    pub space: String,
    pub virtual_space: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabLocation {
    pub space: SpaceLocation,
    pub tab: String,
    pub virtual_tab: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneLocation {
    pub tab: TabLocation,
    pub node: String,
    pub terminal: String,
}

#[derive(Clone, Debug)]
pub struct Projection {
    pub snapshot: HerdrSessionSnapshot,
    pub spaces: BTreeMap<String, SpaceLocation>,
    pub tabs: BTreeMap<String, TabLocation>,
    pub panes: BTreeMap<String, PaneLocation>,
    pub warnings: Vec<String>,
}

pub(crate) fn id(kind: &str, parts: &[&str]) -> String {
    let mut value = format!("hc:{kind}:");
    for part in parts {
        let _ = write!(value, "{}:{part}", part.len());
    }
    value
}
pub(crate) fn machine(key: &DocumentKey) -> &str {
    key.machine.as_deref().unwrap_or("")
}
pub(crate) fn space_id(location: &SpaceLocation) -> String {
    id("w", &[machine(&location.key), &location.space])
}
pub(crate) fn tab_id(location: &TabLocation) -> String {
    id(
        "t",
        &[
            machine(&location.space.key),
            &location.space.space,
            &location.tab,
        ],
    )
}
pub(crate) fn pane_id(location: &PaneLocation) -> String {
    id(
        "p",
        &[
            machine(&location.tab.space.key),
            &location.tab.space.space,
            &location.tab.tab,
            &location.node,
        ],
    )
}
pub(crate) fn terminal_node(address: &str) -> String {
    format!("terminal:{address}")
}

pub fn project(
    version: &str,
    state: &Snapshot,
    documents: &Documents,
    view: &View,
) -> Result<Projection, Error> {
    let mut builder = Builder {
        projection: Projection {
            snapshot: HerdrSessionSnapshot {
                version: version.into(),
                protocol: GENERATION,
                focused_workspace_id: None,
                focused_tab_id: None,
                focused_pane_id: None,
                agents: Vec::new(),
                workspaces: Vec::new(),
                tabs: Vec::new(),
                panes: Vec::new(),
                layouts: Vec::new(),
            },
            spaces: BTreeMap::new(),
            tabs: BTreeMap::new(),
            panes: BTreeMap::new(),
            warnings: Vec::new(),
        },
        state,
        view,
        used: BTreeSet::new(),
        nodes: 0,
        titles: BTreeMap::new(),
    };
    for (key, document) in documents
        .values()
        .filter(|(key, _)| key.name == APP_DOCUMENT)
    {
        if document.value.is_null() {
            continue;
        }
        let Some(spaces) = document.value.get("spaces").and_then(Value::as_array) else {
            builder
                .projection
                .warnings
                .push(format!("{} desktop layout is not understood", machine(key)));
            continue;
        };
        for (index, space) in spaces.iter().enumerate() {
            let raw_id = space
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map_or_else(|| format!("@space-{index}"), str::to_owned);
            let location = SpaceLocation {
                key: key.clone(),
                space: raw_id,
                virtual_space: false,
            };
            builder.add_space(
                location.clone(),
                space.get("name").and_then(Value::as_str).unwrap_or("Space"),
            );
            if let Some(tabs) = space.get("tabs").and_then(Value::as_array) {
                for (tab_index, tab) in tabs.iter().enumerate() {
                    let raw_tab = tab
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map_or_else(|| format!("@tab-{tab_index}"), str::to_owned);
                    let location = TabLocation {
                        space: location.clone(),
                        tab: raw_tab,
                        virtual_tab: false,
                    };
                    let mut entries = Vec::new();
                    if let Some(root) = tab.get("root") {
                        builder.walk(root, &location, unit_rect(), 0, &mut entries)?;
                    }
                    builder.add_tab(
                        location,
                        tab.get("name").and_then(Value::as_str).unwrap_or("Tab"),
                        entries,
                    );
                }
            }
        }
    }
    for terminal in state.terminals().iter().filter(|t| t.state == "live") {
        if builder.used.contains(&terminal.address) {
            continue;
        }
        let remote = terminal
            .address
            .rsplit_once('/')
            .map(|(prefix, _)| prefix.to_owned());
        let key = DocumentKey {
            machine: remote,
            name: APP_DOCUMENT.into(),
        };
        let space = SpaceLocation {
            key,
            space: FALLBACK_SPACE.into(),
            virtual_space: true,
        };
        builder.add_space(
            space.clone(),
            if space.key.machine.is_some() {
                "Remote terminals"
            } else {
                "Terminals"
            },
        );
        let location = TabLocation {
            space,
            tab: terminal_node(&terminal.address),
            virtual_tab: true,
        };
        let entry = PaneLocation {
            tab: location.clone(),
            node: terminal_node(&terminal.address),
            terminal: terminal.address.clone(),
        };
        builder.add_tab(
            location,
            terminal.name.as_deref().unwrap_or(&terminal.address),
            vec![(entry, unit_rect())],
        );
    }
    builder.finish();
    Ok(builder.projection)
}

fn unit_rect() -> HerdrPaneLayoutRect {
    HerdrPaneLayoutRect {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    }
}
struct Builder<'a> {
    projection: Projection,
    state: &'a Snapshot,
    view: &'a View,
    used: BTreeSet<String>,
    nodes: usize,
    titles: BTreeMap<String, String>,
}

impl Builder<'_> {
    fn add_space(&mut self, location: SpaceLocation, label: &str) {
        let key = space_id(&location);
        if self.projection.spaces.contains_key(&key) {
            return;
        }
        self.projection
            .snapshot
            .workspaces
            .push(HerdrWorkspaceInfo {
                workspace_id: key.clone(),
                number: count(self.projection.snapshot.workspaces.len()) + 1.0,
                label: label.into(),
                focused: false,
                pane_count: 0.0,
                tab_count: 0.0,
                active_tab_id: String::new(),
                agent_status: HerdrAgentStatus::Unknown,
                tokens: None,
                worktree: None,
            });
        self.projection.spaces.insert(key, location);
    }

    fn walk(
        &mut self,
        node: &Value,
        tab: &TabLocation,
        rect: HerdrPaneLayoutRect,
        depth: usize,
        entries: &mut Vec<(PaneLocation, HerdrPaneLayoutRect)>,
    ) -> Result<(), Error> {
        self.nodes += 1;
        if self.nodes > MAX_LAYOUT_NODES || depth > MAX_LAYOUT_DEPTH {
            return Err(Error::Limit("desktop layout tree"));
        }
        let raw_id = node
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map_or_else(|| format!("@node-{}", self.nodes), str::to_owned);
        if let Some(address) = node.pointer("/content/terminal").and_then(Value::as_str) {
            let address = qualify(address, tab.space.key.machine.as_deref());
            if self
                .state
                .terminal(&address)
                .is_some_and(|t| t.state == "live")
            {
                let pane = PaneLocation {
                    tab: tab.clone(),
                    node: raw_id,
                    terminal: address,
                };
                if let Some(title) = node.get("title").and_then(Value::as_str) {
                    self.titles.insert(pane_id(&pane), title.into());
                }
                entries.push((pane, rect.clone()));
            }
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            let row = node.get("type").and_then(Value::as_str) == Some("row");
            let stack = node.get("type").and_then(Value::as_str) == Some("stack");
            let weights: Vec<f64> = children
                .iter()
                .map(|child| {
                    child
                        .pointer("/size/weight")
                        .or_else(|| child.pointer("/size/px"))
                        .and_then(Value::as_f64)
                        .filter(|v| v.is_finite() && *v > 0.0)
                        .unwrap_or(1.0)
                })
                .collect();
            let total = weights.iter().sum::<f64>();
            let mut offset = 0.0;
            for (child, weight) in children.iter().zip(weights) {
                let mut child_rect = rect.clone();
                if !stack {
                    if row {
                        child_rect.x += offset * rect.width;
                        child_rect.width = rect.width * weight / total;
                    } else {
                        child_rect.y += offset * rect.height;
                        child_rect.height = rect.height * weight / total;
                    }
                }
                self.walk(child, tab, child_rect, depth + 1, entries)?;
                offset += weight / total;
            }
        }
        if let Some(floating) = node.get("floating").and_then(Value::as_array) {
            for child in floating {
                self.walk(child, tab, rect.clone(), depth + 1, entries)?;
            }
        }
        Ok(())
    }

    fn add_tab(
        &mut self,
        location: TabLocation,
        label: &str,
        entries: Vec<(PaneLocation, HerdrPaneLayoutRect)>,
    ) {
        let key = tab_id(&location);
        if self.projection.tabs.contains_key(&key) {
            return;
        }
        let workspace = space_id(&location.space);
        let number = count(
            self.projection
                .snapshot
                .tabs
                .iter()
                .filter(|t| t.workspace_id == workspace)
                .count(),
        ) + 1.0;
        let mut layout = HerdrPaneLayoutSnapshot {
            workspace_id: workspace.clone(),
            tab_id: key.clone(),
            zoomed: false,
            area: unit_rect(),
            focused_pane_id: String::new(),
            panes: Vec::new(),
            splits: Vec::new(),
        };
        for (pane, rect) in entries {
            let Some(terminal) = self.state.terminal(&pane.terminal) else {
                continue;
            };
            let pane_key = pane_id(&pane);
            if self.projection.panes.contains_key(&pane_key) {
                continue;
            }
            let focused = self.view.pane.as_deref() == Some(&pane_key);
            if layout.focused_pane_id.is_empty() || focused {
                layout.focused_pane_id.clone_from(&pane_key);
            }
            layout.zoomed |= self.view.zoomed.contains(&pane_key);
            layout.panes.push(HerdrPaneLayoutPane {
                pane_id: pane_key.clone(),
                focused,
                rect,
            });
            let mut info = project_pane(
                terminal,
                &pane_key,
                &workspace,
                &key,
                focused,
                self.state.seq(),
            );
            if let Some(title) = self.titles.get(&pane_key) {
                info.label = Some(title.clone());
            }
            self.projection
                .snapshot
                .agents
                .push(project_agent(&info, terminal));
            self.projection.snapshot.panes.push(info);
            self.used.insert(terminal.address.clone());
            self.projection.panes.insert(pane_key, pane);
        }
        let status = self
            .projection
            .snapshot
            .panes
            .iter()
            .filter(|p| p.tab_id == key)
            .map(|p| p.agent_status)
            .min_by_key(|s| s.priority())
            .unwrap_or(HerdrAgentStatus::Unknown);
        self.projection.snapshot.tabs.push(HerdrTabInfo {
            tab_id: key.clone(),
            workspace_id: workspace,
            number,
            label: label.into(),
            label_is_custom: Some(true),
            focused: self.view.tab.as_deref() == Some(&key),
            pane_count: count(layout.panes.len()),
            agent_status: status,
        });
        if !layout.panes.is_empty() {
            self.projection.snapshot.layouts.push(layout);
        }
        self.projection.tabs.insert(key, location);
    }

    fn finish(&mut self) {
        for workspace in &mut self.projection.snapshot.workspaces {
            let tabs: Vec<_> = self
                .projection
                .snapshot
                .tabs
                .iter()
                .filter(|t| t.workspace_id == workspace.workspace_id)
                .collect();
            workspace.tab_count = count(tabs.len());
            workspace.pane_count = tabs.iter().map(|t| t.pane_count).sum();
            workspace.agent_status = tabs
                .iter()
                .map(|t| t.agent_status)
                .min_by_key(|s| s.priority())
                .unwrap_or(HerdrAgentStatus::Unknown);
            workspace.active_tab_id = tabs
                .iter()
                .find(|t| t.focused)
                .or_else(|| tabs.first())
                .map(|t| t.tab_id.clone())
                .unwrap_or_default();
            workspace.focused = self.view.workspace.as_deref() == Some(&workspace.workspace_id);
        }
        self.projection.snapshot.focused_workspace_id = self
            .view
            .workspace
            .clone()
            .filter(|id| self.projection.spaces.contains_key(id));
        self.projection.snapshot.focused_tab_id = self
            .view
            .tab
            .clone()
            .filter(|id| self.projection.tabs.contains_key(id));
        self.projection.snapshot.focused_pane_id = self
            .view
            .pane
            .clone()
            .filter(|id| self.projection.panes.contains_key(id));
    }
}

fn qualify(address: &str, machine: Option<&str>) -> String {
    machine.map_or_else(|| address.into(), |m| format!("{m}/{address}"))
}
fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(str::to_owned)
}
pub fn agent_kind(app: &str) -> Option<&'static str> {
    match app {
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        "pi" => Some("pi"),
        _ => None,
    }
}
fn agent_status(terminal: &Terminal) -> HerdrAgentStatus {
    match reported_status(terminal).map(|s| s.state.as_str()) {
        Some("blocked" | "error") => HerdrAgentStatus::Blocked,
        Some("done") => HerdrAgentStatus::Done,
        Some("working") => HerdrAgentStatus::Working,
        Some("idle") => HerdrAgentStatus::Idle,
        _ => HerdrAgentStatus::Unknown,
    }
}
fn transcript(terminal: &Terminal) -> Option<HerdrAgentSessionInfo> {
    let agent = agent_kind(terminal.labels.get("whip.transcript.agent")?)?;
    let value = terminal.labels.get("whip.transcript.value")?.clone();
    if value.is_empty() {
        return None;
    }
    let kind = match terminal.labels.get("whip.transcript.kind")?.as_str() {
        "id" => HerdrAgentSessionKind::Id,
        "path" if value.starts_with('/') => HerdrAgentSessionKind::Path,
        _ => return None,
    };
    Some(HerdrAgentSessionInfo {
        source: "hc-label".into(),
        agent: agent.into(),
        kind,
        value,
    })
}

fn project_pane(
    terminal: &Terminal,
    pane: &str,
    workspace: &str,
    tab: &str,
    focused: bool,
    seq: u64,
) -> HerdrPaneInfo {
    let status = reported_status(terminal);
    let app = status.and_then(|s| s.app.as_deref());
    let agent = app.map(|app| agent_kind(app).unwrap_or(app).to_owned());
    let mut labels: HashMap<_, _> = terminal.labels.clone().into_iter().collect();
    labels.insert(
        "hc.reported".into(),
        terminal.reported.unwrap_or(false).to_string(),
    );
    if let Some(parent) = &terminal.parent {
        labels.insert(PARENT_LABEL.into(), parent.clone());
    }
    if let Some(status) = status {
        labels.insert("hc.status".into(), status.state.clone());
    }
    HerdrPaneInfo {
        pane_id: pane.into(),
        terminal_id: terminal.address.clone(),
        workspace_id: workspace.into(),
        tab_id: tab.into(),
        focused,
        cwd: Some(terminal.cwd.clone()),
        foreground_cwd: terminal.foreground.as_ref().map(|f| f.cwd.clone()),
        label: nonempty(terminal.name.as_deref()),
        agent,
        title: status
            .and_then(|s| nonempty(s.title.as_deref()).or_else(|| nonempty(s.msg.as_deref()))),
        terminal_title: nonempty(terminal.title.as_deref()),
        terminal_title_stripped: nonempty(terminal.title.as_deref()),
        display_agent: nonempty(app),
        agent_status: agent_status(terminal),
        state_labels: Some(labels),
        tokens: None,
        agent_session: transcript(terminal),
        scroll: None,
        revision: revision(seq),
    }
}

fn count(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}
#[allow(
    clippy::cast_precision_loss,
    reason = "the existing domain ABI represents revisions as f64; clamp to its exact integer range"
)]
fn revision(value: u64) -> f64 {
    value.min((1 << 53) - 1) as f64
}

fn project_agent(pane: &HerdrPaneInfo, terminal: &Terminal) -> HerdrAgentInfo {
    HerdrAgentInfo {
        pane_id: pane.pane_id.clone(),
        terminal_id: pane.terminal_id.clone(),
        workspace_id: pane.workspace_id.clone(),
        tab_id: pane.tab_id.clone(),
        focused: pane.focused,
        agent_status: pane.agent_status,
        revision: pane.revision,
        cwd: pane.cwd.clone(),
        foreground_cwd: pane.foreground_cwd.clone(),
        agent: pane.agent.clone(),
        name: terminal.name.clone(),
        title: pane.title.clone(),
        terminal_title: pane.terminal_title.clone(),
        terminal_title_stripped: pane.terminal_title_stripped.clone(),
        display_agent: pane.display_agent.clone(),
        interactive_ready: None,
        launch_pending: None,
        screen_detection_skipped: Some(true),
        state_change_seq: Some(pane.revision),
        state_labels: pane.state_labels.clone(),
        tokens: None,
        agent_session: pane.agent_session.clone(),
    }
}
