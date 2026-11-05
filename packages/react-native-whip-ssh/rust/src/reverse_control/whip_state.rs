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
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
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
            && args
                .as_object()
                .is_some_and(|args| args.keys().any(|key| key != "host_id"))
        {
            return Err(BrowserError::invalid(
                "Summary accepts only an optional host_id",
            ));
        }
        let args: Args = serde_json::from_value(args.clone())
            .map_err(|_| BrowserError::invalid("Invalid Whip state arguments"))?;
        if !(1..=MAX_LIMIT).contains(&args.limit) {
            return Err(BrowserError::invalid("limit must be 1..50"));
        }
        if let Some(id) = &args.host_id {
            super::application::identifier(id)?;
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
            .filter(|host| self.args.host_id.as_ref().is_none_or(|id| id == &host.id))
        {
            let state = crate::host_runtime::get_host_runtime(host.id.clone())
                .map(|runtime| runtime.tool_state());
            observations.push(Observation::new(&host.id, &host.name, state));
        }
        Ok(self.project(observations))
    }

    fn project(&self, observations: Vec<Observation>) -> Value {
        let mut counts = counts();
        let mut hosts = Vec::new();
        let mut items = Vec::new();
        let mut complete = true;
        for host in observations {
            complete &= host.current;
            if host.current {
                add_counts(&mut counts, &host.agents);
            }
            if self.kind != Kind::Summary {
                let rows: Vec<Value> = match self.kind {
                    Kind::Agents => host.agents.iter().map(|agent| json!({
                        "pane_id":agent.pane_id,"terminal_id":agent.terminal_id,
                        "workspace_id":agent.workspace_id,"tab_id":agent.tab_id,
                        "name":agent.name,"kind":agent.agent,"status":agent.agent_status,
                        "title":agent.title,"cwd":agent.cwd,"interactive_ready":agent.interactive_ready,
                    })).collect(),
                    Kind::Workspaces => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.workspaces.iter().map(|row| json!({"workspace_id":row.workspace_id,"label":row.label,"focused":row.focused})).collect()),
                    Kind::Tabs => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.tabs.iter().map(|row| json!({"tab_id":row.tab_id,"workspace_id":row.workspace_id,"label":row.label,"focused":row.focused})).collect()),
                    Kind::Panes => host.state.as_ref().and_then(|state| state.snapshot.as_ref()).map_or_else(Vec::new, |snapshot| snapshot.panes.iter().map(|row| json!({"pane_id":row.pane_id,"terminal_id":row.terminal_id,"workspace_id":row.workspace_id,"tab_id":row.tab_id,"label":row.label,"cwd":row.cwd,"agent":row.agent,"status":row.agent_status,"focused":row.focused})).collect()),
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
        let mut result = json!({"source":"whip","complete":complete,"counts":counts,"hosts":hosts});
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
}

impl Observation {
    fn new(
        id: &str,
        name: &str,
        observed: Option<(HostConnectionState, HostStateSnapshot, Vec<HerdrAgentInfo>)>,
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
        let mut observed_counts = counts();
        add_counts(&mut observed_counts, &agents);
        let metadata = json!({
            "host_id":id,"name":name,"connected":connection == HostConnectionState::Connected,
            "current":current,"freshness":state.as_ref().map_or("unavailable", |state| match state.freshness {
                HostFreshness::Fresh => "fresh", HostFreshness::Stale => "stale", HostFreshness::Loading => "loading", HostFreshness::Unavailable => "unavailable",
            }),
            "revision":state.as_ref().map(|state|state.revision),
            "last_synced_at_ms":state.as_ref().and_then(|state|state.last_synced_at_ms),
            "last_event_at_ms":state.as_ref().and_then(|state|state.last_event_at_ms),
            "observed_counts":observed_counts,
        });
        Self {
            id: id.into(),
            current,
            metadata,
            agents,
            state,
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
        let mut properties = json!({"host_id":{"type":"string","maxLength":256,"description":"Optional saved host ID. Omit to include all saved hosts."}});
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
        Ok(Observation::new(id, id, Some((connection, state, agents))))
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
            Observation::new("missing", "missing", None),
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
            (AGENTS_LIST, json!({"host_id":""})),
        ] {
            assert!(
                Query::parse(name, &args).is_err(),
                "Accepted {name}: {args}"
            );
        }
    }
}
