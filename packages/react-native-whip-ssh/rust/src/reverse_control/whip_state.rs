//! Local application observations shared by Phone Use and global voice.
use serde::Deserialize;
use serde_json::{Value, json};

use super::browser::model::{BrowserError, ErrorCode};
use crate::herdr_api::{HerdrAgentInfo, HerdrAgentStatus};
use crate::host_runtime::HostConnectionState;
use crate::host_state::{HostFreshness, HostStateSnapshot};

pub(super) const AGENTS_LIST: &str = "agents.list";
pub(super) const AGENTS_SUMMARY: &str = "agents.summary";
const WORKSPACES_LIST: &str = "workspaces.list";
const TABS_LIST: &str = "tabs.list";
const PANES_LIST: &str = "panes.list";
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;
const PAGE_BYTES: usize = 24 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Agents,
    Summary,
    Workspaces,
    Tabs,
    Panes,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    host_id: Option<String>,
    workspace_id: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

impl Args {
    fn includes_host(&self, host_id: &str) -> bool {
        self.host_id.as_deref().is_none_or(|id| id == host_id)
    }

    fn includes_workspace(&self, workspace_id: &str) -> bool {
        self.workspace_id
            .as_deref()
            .is_none_or(|id| id == workspace_id)
    }
}

const fn default_limit() -> usize {
    DEFAULT_LIMIT
}

pub(super) struct Query {
    kind: Kind,
    args: Args,
}

impl Query {
    pub(super) fn recognizes(name: &str) -> bool {
        matches!(
            name,
            AGENTS_LIST | AGENTS_SUMMARY | WORKSPACES_LIST | TABS_LIST | PANES_LIST
        )
    }

    pub(super) fn parse(name: &str, args: &Value) -> Result<Self, BrowserError> {
        let kind = match name {
            AGENTS_LIST => Kind::Agents,
            AGENTS_SUMMARY => Kind::Summary,
            WORKSPACES_LIST => Kind::Workspaces,
            TABS_LIST => Kind::Tabs,
            PANES_LIST => Kind::Panes,
            _ => {
                return Err(BrowserError::new(
                    ErrorCode::UnknownAction,
                    "Unknown Whip state tool",
                ));
            }
        };
        if kind == Kind::Summary
            && args.as_object().is_some_and(|args| {
                args.keys()
                    .any(|key| !matches!(key.as_str(), "host_id" | "workspace_id"))
            })
        {
            return Err(BrowserError::invalid(
                "Summary accepts only optional host_id and workspace_id filters",
            ));
        }
        let mut args: Args = serde_json::from_value(args.clone())
            .map_err(|_| BrowserError::invalid("Invalid Whip state arguments"))?;
        // Voice providers may fill optional string fields with empty strings.
        for id in [&mut args.host_id, &mut args.workspace_id] {
            if id.as_ref().is_some_and(String::is_empty) {
                *id = None;
            }
        }
        if !(1..=MAX_LIMIT).contains(&args.limit) {
            return Err(BrowserError::invalid("limit must be 1..50"));
        }
        if let Some(id) = &args.host_id {
            super::application::identifier(id)?;
        }
        if let Some(id) = &args.workspace_id {
            super::application::identifier(id)?;
            if args.host_id.is_none() {
                return Err(BrowserError::invalid("workspace_id requires host_id"));
            }
        }
        Ok(Self { kind, args })
    }

    /// No SSH requests, connection attempts, UI navigation or implicit refresh.
    pub(super) fn read(self) -> Result<Value, BrowserError> {
        let context = super::hosts::voice_context()?;
        if self
            .args
            .host_id
            .as_ref()
            .is_some_and(|id| !context.hosts.iter().any(|host| &host.id == id))
        {
            return Err(BrowserError::new(ErrorCode::NotFound, "Unknown saved host"));
        }
        let mut observations = Vec::new();
        for host in context
            .hosts
            .iter()
            .filter(|host| self.args.includes_host(&host.id))
        {
            let runtime = crate::host_runtime::get_host_runtime(host.id.clone());
            let state = runtime.as_ref().map(|runtime| runtime.tool_state());
            let core_backend = runtime.is_some_and(|runtime| runtime.core_backend());
            observations.push(Observation::new(&host.id, &host.name, state, core_backend));
        }
        Ok(self.project(observations))
    }

    fn project(&self, observations: Vec<Observation>) -> Value {
        let mut current_counts = counts();
        let mut hosts = Vec::new();
        let mut items = Vec::new();
        let mut complete = true;
        for mut host in observations
            .into_iter()
            .filter(|host| self.args.includes_host(&host.id))
        {
            if self.args.workspace_id.is_some() {
                let hierarchy = host
                    .core_backend
                    .then(|| herdr_protocol::hc::hierarchy::project(&host.agents));
                host.agents.retain(|agent| {
                    self.args
                        .includes_workspace(crate::app_core::grouping_workspace(
                            hierarchy.as_ref(),
                            agent,
                        ))
                });
            }
            let mut observed_counts = counts();
            add_counts(&mut observed_counts, &host.agents);
            host.metadata["observed_counts"] = observed_counts;
            complete &= host.current;
            if host.current {
                add_counts(&mut current_counts, &host.agents);
            }
            if self.kind != Kind::Summary {
                let rows: Vec<Value> = match self.kind {
                    Kind::Agents => host.agents.iter().map(|agent| json!({
                        "pane_id":agent.pane_id,"terminal_id":agent.terminal_id,
                        "workspace_id":agent.workspace_id,"tab_id":agent.tab_id,
                        "name":agent.name,"kind":agent.agent,"status":agent.agent_status,
                        "title":agent.title,"cwd":agent.cwd,"interactive_ready":agent.interactive_ready,
                    })).collect(),
                    Kind::Workspaces => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.workspaces.iter().filter(|row| self.args.includes_workspace(&row.workspace_id)).map(|row| json!({"workspace_id":row.workspace_id,"label":row.label,"focused":row.focused})).collect()),
                    Kind::Tabs => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.tabs.iter().filter(|row| self.args.includes_workspace(&row.workspace_id)).map(|row| json!({"tab_id":row.tab_id,"workspace_id":row.workspace_id,"label":row.label,"focused":row.focused})).collect()),
                    Kind::Panes => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.panes.iter().filter(|row| self.args.includes_workspace(&row.workspace_id)).map(|row| json!({"pane_id":row.pane_id,"terminal_id":row.terminal_id,"workspace_id":row.workspace_id,"tab_id":row.tab_id,"label":row.label,"cwd":row.cwd,"agent":row.agent,"status":row.agent_status,"focused":row.focused})).collect()),
                    Kind::Summary => Vec::new(),
                };
                for mut row in rows {
                    row["host_id"] = json!(host.id);
                    row["current"] = json!(host.current);
                    items.push(row);
                }
            }
            hosts.push(host.metadata);
        }
        let mut result =
            json!({"source":"whip","complete":complete,"counts":current_counts,"hosts":hosts});
        if self.kind != Kind::Summary {
            let total = items.len();
            // Keep discovery usable within both voice and MCP result bounds.
            let mut bytes = result.to_string().len();
            let mut page = Vec::new();
            for row in items
                .into_iter()
                .skip(self.args.offset)
                .take(self.args.limit)
            {
                bytes += row.to_string().len();
                if bytes > PAGE_BYTES && !page.is_empty() {
                    break;
                }
                page.push(row);
            }
            let end = self.args.offset.saturating_add(page.len());
            result["items"] = json!(page);
            result["total"] = json!(total);
            result["next_offset"] = if end < total { json!(end) } else { Value::Null };
        }
        result
    }
}

struct Observation {
    id: String,
    current: bool,
    metadata: Value,
    agents: Vec<HerdrAgentInfo>,
    state: Option<HostStateSnapshot>,
    core_backend: bool,
}

impl Observation {
    fn new(
        id: &str,
        name: &str,
        observed: Option<(HostConnectionState, HostStateSnapshot, Vec<HerdrAgentInfo>)>,
        core_backend: bool,
    ) -> Self {
        let (connection, state, agents) = match observed {
            Some((connection, state, agents)) => (connection, Some(state), agents),
            None => (HostConnectionState::Disconnected, None, Vec::new()),
        };
        let current = connection == HostConnectionState::Connected
            && state.as_ref().is_some_and(|state| {
                state.freshness == HostFreshness::Fresh
                    && !state.needs_resync
                    && state.snapshot.is_some()
            });
        let metadata = json!({
            "host_id":id,"name":name,"connected":connection == HostConnectionState::Connected,
            "current":current,"freshness":state.as_ref().map_or("unavailable", |state| match state.freshness {
                HostFreshness::Fresh => "fresh", HostFreshness::Stale => "stale", HostFreshness::Loading => "loading", HostFreshness::Unavailable => "unavailable",
            }),
            "revision":state.as_ref().map(|state|state.revision),
            "last_synced_at_ms":state.as_ref().and_then(|state|state.last_synced_at_ms),
            "last_event_at_ms":state.as_ref().and_then(|state|state.last_event_at_ms),
        });
        Self {
            id: id.into(),
            current,
            metadata,
            agents,
            state,
            core_backend,
        }
    }
}

fn counts() -> Value {
    json!({"total":0,"working":0,"blocked":0,"idle":0,"done":0,"unknown":0})
}
fn add_counts(counts: &mut Value, agents: &[HerdrAgentInfo]) {
    for agent in agents {
        let status = match agent.agent_status {
            HerdrAgentStatus::Working => "working",
            HerdrAgentStatus::Blocked => "blocked",
            HerdrAgentStatus::Idle => "idle",
            HerdrAgentStatus::Done => "done",
            HerdrAgentStatus::Unknown => "unknown",
        };
        for field in ["total", status] {
            counts[field] = json!(counts[field].as_u64().unwrap_or_default() + 1);
        }
    }
}

pub(super) fn tools() -> Vec<Value> {
    [
        (AGENTS_SUMMARY, "Count agents by status from Whip's local state across saved hosts. counts includes only current hosts; complete=false means some hosts are stale or unavailable. working counts agents actively working; total includes idle, blocked and done agents. Never connects or refreshes."),
        (AGENTS_LIST, "List agents and explicit host/pane/terminal IDs from Whip's local state. Use for agent discovery; current=false rows are cached observations. No remote snapshot or automatic connection."),
        (WORKSPACES_LIST, "List workspace IDs and labels from Whip's local state."),
        (TABS_LIST, "List tab and workspace IDs from Whip's local state."),
        (PANES_LIST, "List pane, terminal, tab and workspace IDs from Whip's local state."),
    ].into_iter().map(|(name, description)| {
        let mut properties = json!({"host_id":{"type":"string","maxLength":256,"description":"Optional saved host ID. Omit or use an empty string to include all saved hosts."}});
        properties["workspace_id"] = json!({"type":"string","maxLength":256,"description":"Optional space ID from workspaces.list. A nonempty workspace_id requires a nonempty host_id. Omit or use an empty string for all spaces. Filters rows and agent counts before pagination; unattached Core delegated agents follow their parent's space as in Herd."});
        if name != AGENTS_SUMMARY {
            properties["offset"] = json!({"type":"integer","minimum":0});
            properties["limit"] = json!({"type":"integer","minimum":1,"maximum":MAX_LIMIT,"default":DEFAULT_LIMIT});
        }
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":[],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}})
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_state::{HostState, HostSyncStatus};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn observed(
        id: &str,
        connection: HostConnectionState,
        freshness: HostFreshness,
    ) -> Result<Observation, Box<dyn std::error::Error>> {
        let snapshot = crate::herdr_api::session_snapshot(&json!({
            "version":"test","protocol":22,
            "workspaces":[],"tabs":[],"panes":[],"layouts":[],
            "agents":[
                {"pane_id":"pane-working","terminal_id":"terminal-1","workspace_id":"w","tab_id":"t","focused":false,"agent_status":"working","revision":1,"name":"worker","agent":"codex"},
                {"pane_id":"pane-idle","terminal_id":"terminal-2","workspace_id":"w","tab_id":"t","focused":false,"agent_status":"idle","revision":1,"name":"reviewer","agent":"claude"}
            ]
        }))?;
        let agents = crate::app_core::project_agents(&snapshot, None);
        let mut state = HostState::default().projection();
        state.snapshot = Some(snapshot);
        state.freshness = freshness;
        state.sync_status = HostSyncStatus::Synced;
        state.needs_resync = false;
        Ok(Observation::new(
            id,
            id,
            Some((connection, state, agents)),
            false,
        ))
    }

    #[test]
    fn counts_exclude_stale_disconnected_and_missing_hosts() -> TestResult {
        let query = Query::parse(AGENTS_SUMMARY, &json!({}))?;
        let value = query.project(vec![
            observed("live", HostConnectionState::Connected, HostFreshness::Fresh)?,
            observed(
                "stale",
                HostConnectionState::Connected,
                HostFreshness::Stale,
            )?,
            observed(
                "offline",
                HostConnectionState::Disconnected,
                HostFreshness::Fresh,
            )?,
            Observation::new("missing", "missing", None, false),
        ]);
        assert_eq!(value["complete"], false);
        assert_eq!(
            value["counts"],
            json!({"total":2,"working":1,"idle":1,"blocked":0,"done":0,"unknown":0})
        );
        assert_eq!(value["hosts"][1]["observed_counts"]["total"], 2);
        assert_eq!(value["hosts"][1]["current"], false);
        assert_eq!(value["hosts"][2]["current"], false);
        assert_eq!(value["hosts"][3]["freshness"], "unavailable");
        assert!(value.get("items").is_none());
        let current = query.project(vec![observed(
            "live",
            HostConnectionState::Connected,
            HostFreshness::Fresh,
        )?]);
        assert_eq!(current["complete"], true);
        Ok(())
    }

    #[test]
    fn discovery_paginates_explicit_ids_and_marks_cached_rows() -> TestResult {
        let query = Query::parse(AGENTS_LIST, &json!({"offset":1,"limit":1}))?;
        let value = query.project(vec![observed(
            "cached",
            HostConnectionState::Disconnected,
            HostFreshness::Stale,
        )?]);
        assert_eq!(value["total"], 2);
        assert_eq!(value["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["items"][0]["host_id"], "cached");
        assert_eq!(value["items"][0]["pane_id"], "pane-idle");
        assert_eq!(value["items"][0]["terminal_id"], "terminal-2");
        assert_eq!(value["items"][0]["current"], false);
        assert_eq!(value["counts"]["total"], 0);
        assert_eq!(value["next_offset"], Value::Null);
        let page = Query::parse(AGENTS_LIST, &json!({"limit":1}))?.project(vec![observed(
            "live",
            HostConnectionState::Connected,
            HostFreshness::Fresh,
        )?]);
        assert_eq!(page["next_offset"], 1);
        assert_eq!(page["counts"]["total"], 2);
        Ok(())
    }

    fn multi_space_host(id: &str) -> Result<Observation, Box<dyn std::error::Error>> {
        let mut host = observed(id, HostConnectionState::Connected, HostFreshness::Fresh)?;
        let mut other = host.agents[0].clone();
        other.pane_id = "pane-other".into();
        other.terminal_id = "terminal-other".into();
        other.workspace_id = "other".into();
        other.tab_id = "tab-other".into();
        other.agent_status = HerdrAgentStatus::Blocked;
        host.agents.insert(0, other);
        let mut snapshot = serde_json::to_value(
            host.state
                .as_ref()
                .and_then(|state| state.snapshot.as_ref())
                .ok_or("Missing snapshot")?,
        )?;
        snapshot["workspaces"] = json!([
            {"workspace_id":"other","number":1,"label":"Other","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"tab-other","agent_status":"blocked"},
            {"workspace_id":"w","number":2,"label":"Selected","focused":true,"pane_count":2,"tab_count":1,"active_tab_id":"t","agent_status":"working"}
        ]);
        snapshot["tabs"] = json!([
            {"tab_id":"tab-other","workspace_id":"other","number":1,"label":"Other","focused":false,"pane_count":1,"agent_status":"blocked"},
            {"tab_id":"t","workspace_id":"w","number":2,"label":"Selected","focused":true,"pane_count":2,"agent_status":"working"}
        ]);
        snapshot["panes"] = json!(
            host.agents
                .iter()
                .map(|agent| json!({
                    "pane_id":agent.pane_id,"terminal_id":agent.terminal_id,
                    "workspace_id":agent.workspace_id,"tab_id":agent.tab_id,
                    "focused":false,"agent_status":agent.agent_status,"revision":1
                }))
                .collect::<Vec<_>>()
        );
        host.state.as_mut().ok_or("Missing state")?.snapshot =
            Some(crate::herdr_api::session_snapshot(&snapshot)?);
        Ok(host)
    }

    #[test]
    fn space_scope_filters_rows_and_counts_before_pagination_on_the_selected_host() -> TestResult {
        for name in [AGENTS_LIST, WORKSPACES_LIST, TABS_LIST, PANES_LIST] {
            let query = Query::parse(
                name,
                &json!({"host_id":"live","workspace_id":"w","limit":1}),
            )?;
            let value = query.project(vec![
                multi_space_host("live")?,
                // IDs are host-local; the other host's matching space must not leak.
                observed(
                    "other-host",
                    HostConnectionState::Disconnected,
                    HostFreshness::Stale,
                )?,
            ]);
            assert_eq!(value["complete"], true);
            assert_eq!(value["hosts"].as_array().map(Vec::len), Some(1));
            assert_eq!(
                value["counts"],
                json!({"total":2,"working":1,"blocked":0,"idle":1,"done":0,"unknown":0})
            );
            assert_eq!(value["hosts"][0]["observed_counts"], value["counts"]);
            assert_eq!(value["items"].as_array().map(Vec::len), Some(1));
            assert_eq!(value["items"][0]["workspace_id"], "w");
            assert_eq!(value["items"][0]["host_id"], "live");
            let paginated = matches!(name, AGENTS_LIST | PANES_LIST);
            assert_eq!(value["total"], if paginated { 2 } else { 1 });
            assert_eq!(
                value["next_offset"],
                if paginated { json!(1) } else { Value::Null }
            );
            if paginated {
                let next = Query::parse(
                    name,
                    &json!({"host_id":"live","workspace_id":"w","offset":1,"limit":1}),
                )?
                .project(vec![multi_space_host("live")?]);
                assert_eq!(next["items"][0]["pane_id"], "pane-idle");
                assert_eq!(next["next_offset"], Value::Null);
                assert_eq!(next["counts"], value["counts"]);
            }
        }
        Ok(())
    }

    #[test]
    fn space_summaries_preserve_freshness_and_all_space_defaults() -> TestResult {
        for current in [true, false] {
            let mut host = multi_space_host("live")?;
            host.current = current;
            let summary = Query::parse(
                AGENTS_SUMMARY,
                &json!({"host_id":"live","workspace_id":"w"}),
            )?
            .project(vec![host]);
            assert_eq!(summary["complete"], current);
            assert_eq!(summary["counts"]["total"], if current { 2 } else { 0 });
            assert_eq!(summary["counts"]["blocked"], 0);
            assert_eq!(summary["hosts"][0]["observed_counts"]["total"], 2);
            assert!(summary.get("items").is_none());
        }
        for args in [json!({}), json!({"host_id":"live"})] {
            let value =
                Query::parse(AGENTS_SUMMARY, &args)?.project(vec![multi_space_host("live")?]);
            assert_eq!(value["counts"]["total"], 3);
            assert_eq!(value["counts"]["blocked"], 1);
        }
        let empty = Query::parse(
            AGENTS_LIST,
            &json!({"host_id":"live","workspace_id":"empty"}),
        )?
        .project(vec![multi_space_host("live")?]);
        assert_eq!(empty["complete"], true);
        assert_eq!(empty["total"], 0);
        assert_eq!(empty["counts"]["total"], 0);
        assert_eq!(empty["hosts"][0]["observed_counts"]["total"], 0);
        assert_eq!(empty["next_offset"], Value::Null);
        assert!(empty["items"].as_array().ok_or("Missing items")?.is_empty());
        Ok(())
    }

    #[test]
    fn empty_scope_ids_from_voice_mean_all_hosts_and_spaces() -> TestResult {
        for name in [
            AGENTS_SUMMARY,
            AGENTS_LIST,
            WORKSPACES_LIST,
            TABS_LIST,
            PANES_LIST,
        ] {
            let expected = Query::parse(name, &json!({}))?.project(vec![
                multi_space_host("first")?,
                multi_space_host("second")?,
            ]);
            for args in [
                json!({"host_id":""}),
                json!({"workspace_id":""}),
                json!({"host_id":"","workspace_id":""}),
            ] {
                let actual = Query::parse(name, &args)?.project(vec![
                    multi_space_host("first")?,
                    multi_space_host("second")?,
                ]);
                assert_eq!(actual, expected);
            }
            let host_only = Query::parse(name, &json!({"host_id":"first","workspace_id":""}))?
                .project(vec![
                    multi_space_host("first")?,
                    multi_space_host("second")?,
                ]);
            assert_eq!(host_only["hosts"].as_array().map(Vec::len), Some(1));
            assert_eq!(host_only["counts"]["total"], 3);
        }
        Ok(())
    }

    #[test]
    fn space_scope_inherits_unattached_core_children_without_changing_targets() -> TestResult {
        use herdr_protocol::hc::{hierarchy::VIRTUAL_LAYOUT_LABEL, projection::PARENT_LABEL};

        for core_backend in [true, false] {
            let mut host = multi_space_host("live")?;
            host.core_backend = core_backend;
            host.agents[0].state_labels = Some(
                [
                    (PARENT_LABEL.into(), "terminal-1".into()),
                    (VIRTUAL_LAYOUT_LABEL.into(), "1".into()),
                ]
                .into(),
            );
            let value = Query::parse(AGENTS_LIST, &json!({"host_id":"live","workspace_id":"w"}))?
                .project(vec![host]);
            assert_eq!(value["total"], if core_backend { 3 } else { 2 });
            assert_eq!(value["counts"]["blocked"], u64::from(core_backend));
            if core_backend {
                assert_eq!(value["items"][0]["pane_id"], "pane-other");
                assert_eq!(value["items"][0]["workspace_id"], "other");
            }
        }
        Ok(())
    }

    #[test]
    fn state_queries_cannot_request_remote_actions_or_invalid_pages() {
        for (name, args) in [
            (AGENTS_SUMMARY, json!({"refresh":true})),
            (AGENTS_SUMMARY, json!({"limit":1})),
            (
                AGENTS_LIST,
                json!({"request":{"action":"session_snapshot"}}),
            ),
            (AGENTS_LIST, json!({"limit":0})),
            (AGENTS_LIST, json!({"limit":51})),
            (AGENTS_LIST, json!({"offset":-1})),
            (AGENTS_LIST, json!({"workspace_id":"w"})),
            (AGENTS_SUMMARY, json!({"workspace_id":"w"})),
            (AGENTS_SUMMARY, json!({"host_id":"","workspace_id":"w"})),
            (
                AGENTS_SUMMARY,
                json!({"host_id":"live","workspace_id":"bad\nspace"}),
            ),
            (
                AGENTS_LIST,
                json!({"host_id":"live","workspace_id":"w".repeat(257)}),
            ),
        ] {
            assert!(
                Query::parse(name, &args).is_err(),
                "Accepted {name}: {args}"
            );
        }
    }
}
