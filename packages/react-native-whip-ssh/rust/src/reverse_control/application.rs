//! Functional access to Whip's saved hosts and existing Herdr transports.
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::ReverseControl;
use super::browser::model::{BrowserError, ErrorCode, MAX_INPUT, MAX_REQUEST, MAX_TEXT_RESULT};
use crate::herdr_api::{HerdrControlError, HerdrTabLaunchResult};
use crate::host_profiles::{HostProfileRecord, MAX_AGENT_INSTRUCTIONS};

pub(super) const LIST: &str = "hosts.list";
pub(super) const INSTRUCTIONS: &str = "hosts.instructions";
pub(super) const SAVE: &str = "hosts.save";
pub(super) const DELETE: &str = "hosts.delete";
pub(super) const CONNECT: &str = "hosts.connect";
pub(super) const DISCONNECT: &str = "hosts.disconnect";
const START_SERVER: &str = "hosts.start_service";
const RESTART_AGENT: &str = "agents.restart";
const COPY_AGENT: &str = "agents.copy";
const STOP_AGENT: &str = "agents.stop";
const REFRESH: &str = "hosts.refresh";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostArgs {
    host_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveArgs {
    host_id: Option<String>,
    profile: Map<String, Value>,
    credential_from_host_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentArgs {
    host_id: Option<String>,
    terminal_id: String,
    label: Option<String>,
}

pub(super) enum Action {
    Host(super::hosts::HostAction),
    Local(super::whip_state::Query),
    Herdr {
        host_id: Option<String>,
        operation: HerdrOperation,
    },
}

#[derive(Deserialize, serde::Serialize)]
struct AgentInstructions {
    host_id: String,
    global: String,
    host: String,
}

impl AgentInstructions {
    fn decode(value: Value) -> Result<Self, BrowserError> {
        let instructions: Self = decode_reply(value)?;
        identifier(&instructions.host_id)?;
        if instructions.global.len() > MAX_AGENT_INSTRUCTIONS
            || instructions.host.len() > MAX_AGENT_INSTRUCTIONS
        {
            return Err(BrowserError::new(
                ErrorCode::InvalidResult,
                "AGENTS.md exceeds the instruction limit",
            ));
        }
        Ok(instructions)
    }
}

pub(super) fn global_instruction_text(global: &str) -> String {
    if global.trim().is_empty() {
        String::new()
    } else {
        format!(
            "# AGENTS.md instructions from Whip (global)\n\n<INSTRUCTIONS>\n{global}\n</INSTRUCTIONS>"
        )
    }
}

pub(super) enum HerdrOperation {
    Refresh,
    StopAgent(String),
    AgentRequest(super::herdr::Request),
    StartServer,
    RestartAgent(String),
    CopyAgent {
        terminal_id: String,
        label: Option<String>,
    },
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, BrowserError> {
    serde_json::from_value(value)
        .map_err(|_| BrowserError::invalid("Invalid host or Herdr arguments"))
}

pub(super) fn identifier(value: &str) -> Result<(), BrowserError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(BrowserError::invalid(
            "Invalid host, terminal or pane identifier",
        ));
    }
    Ok(())
}

fn bounded(value: &Value) -> Result<(), BrowserError> {
    match value {
        Value::String(text) if text.len() > MAX_INPUT || text.contains('\0') => {
            return Err(BrowserError::invalid(
                "Text exceeds the tool limit or contains NUL",
            ));
        }
        Value::Array(items) => {
            if items.len() > 128 {
                return Err(BrowserError::invalid("Too many arguments"));
            }
            for item in items {
                bounded(item)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if key.ends_with("_id")
                    && let Some(value) = value.as_str()
                {
                    identifier(value)?;
                }
                bounded(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl Action {
    pub(super) fn is_instructions(&self) -> bool {
        matches!(self, Self::Host(action) if action.is_instructions())
    }

    pub(super) fn parse(name: &str, arguments: &Value) -> Result<Self, BrowserError> {
        let mut arguments = if arguments.is_null() {
            json!({})
        } else {
            arguments.clone()
        };
        if !arguments.is_object() || arguments.to_string().len() > MAX_REQUEST {
            return Err(BrowserError::invalid(
                "Expected bounded host or Herdr arguments",
            ));
        }
        bounded(&arguments)?;
        if super::whip_state::Query::recognizes(name) {
            return Ok(Self::Local(super::whip_state::Query::parse(
                name, &arguments,
            )?));
        }
        if let Some(tool) = REMOTE_TOOLS.iter().find(|tool| tool.name == name) {
            let fields = arguments
                .as_object_mut()
                .ok_or_else(|| BrowserError::invalid("Expected arguments"))?;
            let host_id = fields
                .remove("host_id")
                .map(serde_json::from_value::<String>)
                .transpose()
                .map_err(|_| BrowserError::invalid("Invalid host_id"))?;
            if fields.contains_key("action") || fields.contains_key("request") {
                return Err(BrowserError::invalid(
                    "Use the named Whip operation's arguments",
                ));
            }
            fields.insert("action".into(), json!(tool.action));
            let request = super::herdr::Request::parse(arguments).map_err(control_error)?;
            return Ok(Self::Herdr {
                host_id,
                operation: HerdrOperation::AgentRequest(request),
            });
        }
        match name {
            LIST => {
                let _: Empty = decode(arguments.clone())?;
            }
            SAVE => {
                let args: SaveArgs = decode(arguments.clone())?;
                for (key, value) in &args.profile {
                    let valid = match key.as_str() {
                        "name" | "herdrCommand" | "herdrSocketPath" | "sessionName" => {
                            value.as_str().is_some_and(|text| {
                                text.len() <= 4096 && !text.chars().any(char::is_control)
                            })
                        }
                        "host" | "username" => value.as_str().is_some_and(|text| {
                            !text.trim().is_empty()
                                && text.len() <= 4096
                                && !text.chars().any(char::is_control)
                        }),
                        "port" => value
                            .as_str()
                            .is_some_and(|port| port.parse::<u16>().is_ok_and(|port| port > 0)),
                        "jumpHostId" => {
                            value.is_null()
                                || value.as_str().is_some_and(|id| identifier(id).is_ok())
                        }
                        "forwardAgent" => value.is_boolean(),
                        "authMode" => matches!(value.as_str(), Some("key" | "password")),
                        _ => false,
                    };
                    if !valid {
                        return Err(BrowserError::invalid(
                            "Invalid or unsupported host profile field",
                        ));
                    }
                }
                if let Some(source) = args.credential_from_host_id {
                    identifier(&source)?;
                }
                if let Some(id) = args.host_id {
                    identifier(&id)?;
                } else {
                    if !args.profile.contains_key("host") || !args.profile.contains_key("username")
                    {
                        return Err(BrowserError::invalid("New hosts require host and username"));
                    }
                    arguments["host_id"] = json!(format!(
                        "host-{}",
                        super::random_token().map_err(|_| BrowserError::new(
                            ErrorCode::DeviceUnavailable,
                            "Could not generate host id"
                        ))?
                    ));
                }
            }
            INSTRUCTIONS | DELETE | CONNECT | DISCONNECT => {
                let args: HostArgs = decode(arguments.clone())?;
                if name != INSTRUCTIONS && args.host_id.is_none() {
                    return Err(BrowserError::invalid("host_id is required"));
                }
            }
            START_SERVER | REFRESH => {
                let args: HostArgs = decode(arguments)?;
                return Ok(Self::Herdr {
                    host_id: args.host_id,
                    operation: if name == REFRESH {
                        HerdrOperation::Refresh
                    } else {
                        HerdrOperation::StartServer
                    },
                });
            }
            RESTART_AGENT | COPY_AGENT | STOP_AGENT => {
                let args: AgentArgs = decode(arguments)?;
                identifier(&args.terminal_id)?;
                if name != COPY_AGENT && args.label.is_some() {
                    return Err(BrowserError::invalid("Only copy accepts a label"));
                }
                return Ok(Self::Herdr {
                    host_id: args.host_id,
                    operation: if name == RESTART_AGENT {
                        HerdrOperation::RestartAgent(args.terminal_id)
                    } else if name == STOP_AGENT {
                        HerdrOperation::StopAgent(args.terminal_id)
                    } else {
                        HerdrOperation::CopyAgent {
                            terminal_id: args.terminal_id,
                            label: args.label,
                        }
                    },
                });
            }
            _ => {
                return Err(BrowserError::new(
                    ErrorCode::UnknownAction,
                    "Unknown host or Herdr tool",
                ));
            }
        }
        Ok(Self::Host(super::hosts::HostAction::from_validated(
            name, &arguments,
        )?))
    }

    pub(super) async fn run(
        self,
        owner: Arc<ReverseControl>,
        session: String,
        parent: String,
        caller_host: String,
    ) -> Result<Value, BrowserError> {
        match self {
            Self::Local(query) => result("whip", query.read()?),
            Self::Host(action) => action.run(owner, &session, &parent, &caller_host).await,
            Self::Herdr { host_id, operation } => {
                let host_id = host_id.unwrap_or(caller_host);
                run_herdr(host_id, operation).await
            }
        }
    }
}

/// Shared validated execution, independent of the MCP transport.
pub(super) async fn run_herdr(
    host_id: String,
    operation: HerdrOperation,
) -> Result<Value, BrowserError> {
    let runtime = crate::host_runtime::get_host_runtime(host_id.clone()).ok_or_else(|| {
        BrowserError::new(
            ErrorCode::NotFound,
            "Connect this saved host with hosts.connect first",
        )
    })?;
    let mut value = match operation {
        HerdrOperation::AgentRequest(request) => runtime
            .request_from_reverse_agent(request)
            .await
            .map_err(control_error)?,
        HerdrOperation::Refresh => {
            let state = runtime.refresh_state().await.map_err(|_| {
                BrowserError::new(ErrorCode::HostDisconnected, "Could not refresh this host")
            })?;
            if state.freshness != crate::host_state::HostFreshness::Fresh || state.needs_resync {
                return Err(BrowserError::new(
                    ErrorCode::DeviceUnavailable,
                    "Host refresh did not produce current state",
                ));
            }
            json!({"refreshed":true,"revision":state.revision})
        }
        HerdrOperation::StopAgent(terminal_id) => {
            runtime
                .stop_from_reverse_agent(terminal_id)
                .await
                .map_err(control_error)?;
            json!({"stopped":true})
        }
        HerdrOperation::StartServer => {
            runtime
                .start_herdr_from_reverse_agent()
                .await
                .map_err(|_| {
                    BrowserError::new(
                        ErrorCode::DeviceUnavailable,
                        "Could not start Herdr; check the host connection",
                    )
                })?;
            json!({"started":true})
        }
        HerdrOperation::RestartAgent(terminal_id) => {
            runtime
                .restart_from_reverse_agent(terminal_id)
                .await
                .map_err(control_error)?;
            json!({"restarted":true})
        }
        HerdrOperation::CopyAgent { terminal_id, label } => {
            match runtime
                .copy_from_reverse_agent(terminal_id, label)
                .await
                .map_err(control_error)?
            {
                HerdrTabLaunchResult::Created { tab, root_pane } => {
                    json!({"tab":tab,"root_pane":root_pane})
                }
                HerdrTabLaunchResult::LaunchFailed { .. } => {
                    return Err(BrowserError::new(
                        ErrorCode::DeviceUnavailable,
                        "Tab created but the agent failed to start; inspect the host snapshot",
                    ));
                }
            }
        }
    };
    if let Some(fields) = value.as_object_mut() {
        fields.remove("type");
    }
    result("whip", json!({"host_id":host_id,"result":value}))
}

fn control_error(error: HerdrControlError) -> BrowserError {
    let code = match &error {
        HerdrControlError::InvalidField(_) => ErrorCode::InvalidArgument,
        HerdrControlError::RequestTimeout(_) => ErrorCode::Timeout,
        HerdrControlError::RequestCancelled(_) => ErrorCode::Cancelled,
        HerdrControlError::ProtocolError(code, _) if code == "unsupported_feature" => {
            ErrorCode::UnsupportedFeature
        }
        HerdrControlError::ProtocolError(_, _) => ErrorCode::HerdrError,
        HerdrControlError::TransportDisconnected(_) => ErrorCode::HostDisconnected,
        _ => ErrorCode::InvalidResult,
    };
    let details = match &error {
        HerdrControlError::ProtocolError(code, _) => {
            let mut details = json!({"source":"herdr","herdr_code":code});
            if matches!(code.as_str(), "timeout" | "agent_prompt_stalled") {
                details["outcome_unknown"] = json!(true);
            }
            details
        }
        HerdrControlError::TransportDisconnected(_)
        | HerdrControlError::RequestTimeout(_)
        | HerdrControlError::RequestCancelled(_) => {
            json!({"source":"herdr","outcome_unknown":true,"guidance":"Input may have been delivered. Inspect agents.inspect and agents.read before retrying a mutation."})
        }
        _ => Value::Null,
    };
    BrowserError {
        code,
        message: error.to_string(),
        details,
    }
}

fn result(kind: &str, value: Value) -> Result<Value, BrowserError> {
    // JSON escaping can expand the two individually bounded AGENTS.md documents.
    let limit = if kind == INSTRUCTIONS {
        MAX_TEXT_RESULT * 4
    } else {
        MAX_TEXT_RESULT
    };
    if value.to_string().len() > limit {
        return Err(BrowserError::new(
            ErrorCode::ResultTooLarge,
            "Response exceeds the tool limit; use a host filter, smaller page or shorter read",
        ));
    }
    let content = json!({"kind":kind,"value":value});
    Ok(
        json!({"isError":false,"structuredContent":content,"content":[{"type":"text","text":content.to_string()}]}),
    )
}

impl ReverseControl {
    /// Fetch the documents while the MCP client builds its initial context;
    /// the model must not have to discover a tool to learn its instructions.
    pub(super) async fn instruction_text(
        self: &Arc<Self>,
        session: &str,
        rpc_id: Value,
    ) -> Result<String, Value> {
        let receiver = self.start_action(
            session,
            rpc_id,
            &json!({"params":{"name":INSTRUCTIONS,"arguments":{}}}),
        )?;
        let mut result = receiver.await.map_err(|_| {
            BrowserError::new(
                ErrorCode::SessionClosed,
                "Whip instruction loading cancelled",
            )
            .mcp()
        })?;
        if result["isError"] != false {
            return Err(result);
        }
        let instructions = AgentInstructions::decode(result["structuredContent"]["value"].take())
            .map_err(|error| error.mcp())?;
        let matches_host = self
            .sessions
            .lock()
            .get(session)
            .is_some_and(|session| session.info.runtime_id == instructions.host_id);
        if !matches_host {
            return Err(BrowserError::new(
                ErrorCode::InvalidResult,
                "Whip instructions do not belong to this session's host",
            )
            .mcp());
        }
        Ok(global_instruction_text(&instructions.global))
    }
}

#[derive(Deserialize, serde::Serialize)]
struct Connection {
    host_id: String,
    status: String,
}

pub(super) fn host_result(name: &str, value: Value) -> Result<Value, BrowserError> {
    // Re-encode only typed metadata. Credentials and unexpected adapter fields
    // must never be reflected to a remote agent.
    let value = match name {
        LIST => {
            #[derive(Deserialize)]
            struct Reply {
                hosts: Vec<HostProfileRecord>,
                connections: Vec<Connection>,
            }
            let reply: Reply = decode_reply(value)?;
            let hosts: Vec<_> = reply
                .hosts
                .into_iter()
                .map(|host| {
                    let has_instructions = !host.agent_instructions.is_empty();
                    let mut host = json!(host);
                    if let Some(fields) = host.as_object_mut() {
                        fields.insert("has_agent_instructions".into(), json!(has_instructions));
                    }
                    host
                })
                .collect();
            json!({"hosts":hosts,"connections":reply.connections})
        }
        INSTRUCTIONS => json!(AgentInstructions::decode(value)?),
        SAVE => {
            #[derive(Deserialize)]
            struct Reply {
                host: HostProfileRecord,
            }
            let reply: Reply = decode_reply(value)?;
            json!({"host":reply.host})
        }
        CONNECT => json!(decode_reply::<Connection>(value)?),
        DELETE | DISCONNECT => {
            #[derive(Deserialize, serde::Serialize)]
            struct Reply {
                host_id: String,
                completed: bool,
            }
            json!(decode_reply::<Reply>(value)?)
        }
        _ => {
            return Err(BrowserError::new(
                ErrorCode::UnknownAction,
                "Unknown host tool",
            ));
        }
    };
    result(name, value)
}

fn decode_reply<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, BrowserError> {
    serde_json::from_value(value)
        .map_err(|_| BrowserError::new(ErrorCode::InvalidResult, "Invalid host adapter response"))
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn string() -> Value {
    json!({"type":"string","maxLength":MAX_INPUT})
}
fn host_schema() -> Value {
    json!({"host_id":{"type":"string","maxLength":256,"description":"Saved host id from hosts.list. Controls and instruction tools default to this agent's host."}})
}

struct RemoteTool {
    name: &'static str,
    action: &'static str,
    description: &'static str,
    fields: &'static [&'static str],
    optional: &'static [&'static str],
    read_only: bool,
}

const REMOTE_TOOLS: &[RemoteTool] = &[
    RemoteTool {
        name: "workspaces.create",
        action: "workspace_create",
        description: "Create a workspace in an explicit cwd; preserves focus by default.",
        fields: &["cwd"],
        optional: &["label", "focus"],
        read_only: false,
    },
    RemoteTool {
        name: "workspaces.focus",
        action: "workspace_focus",
        description: "Focus an explicit workspace.",
        fields: &["workspace_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "workspaces.close",
        action: "workspace_close",
        description: "Close a workspace and its panes. Only close when requested or when you created it.",
        fields: &["workspace_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "workspaces.rename",
        action: "workspace_rename",
        description: "Rename a workspace.",
        fields: &["workspace_id", "label"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "tabs.create",
        action: "tab_create",
        description: "Create a tab in an explicit workspace and cwd; preserves focus by default.",
        fields: &["workspace_id", "cwd"],
        optional: &["label", "focus"],
        read_only: false,
    },
    RemoteTool {
        name: "tabs.focus",
        action: "tab_focus",
        description: "Focus an explicit tab.",
        fields: &["tab_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "tabs.close",
        action: "tab_close",
        description: "Close a tab and its panes. Only close when requested or when you created it.",
        fields: &["tab_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "tabs.rename",
        action: "tab_rename",
        description: "Rename a tab.",
        fields: &["tab_id", "label"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.read",
        action: "pane_read",
        description: "Read pane output; defaults to 120 lines of recent_unwrapped plain text.",
        fields: &["pane_id"],
        optional: &["lines", "source", "format", "strip_ansi"],
        read_only: true,
    },
    RemoteTool {
        name: "panes.read_visible",
        action: "pane_read_visible",
        description: "Read the visible pane viewport.",
        fields: &["pane_id"],
        optional: &["source", "format", "strip_ansi"],
        read_only: true,
    },
    RemoteTool {
        name: "panes.inspect",
        action: "pane_get",
        description: "Inspect one pane live.",
        fields: &["pane_id"],
        optional: &[],
        read_only: true,
    },
    RemoteTool {
        name: "panes.focus",
        action: "pane_focus",
        description: "Focus an explicit pane.",
        fields: &["pane_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.close",
        action: "pane_close",
        description: "Close a pane. Only close when requested or when you created it.",
        fields: &["pane_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.rename",
        action: "pane_rename",
        description: "Rename a pane.",
        fields: &["pane_id"],
        optional: &["label"],
        read_only: false,
    },
    RemoteTool {
        name: "panes.split",
        action: "pane_split",
        description: "Split an explicit pane right or down in an explicit cwd; preserves focus by default.",
        fields: &["pane_id", "direction", "cwd"],
        optional: &["focus"],
        read_only: false,
    },
    RemoteTool {
        name: "panes.zoom",
        action: "pane_zoom",
        description: "Toggle pane zoom.",
        fields: &["pane_id"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.send_input",
        action: "pane_send_input",
        description: "Send text and logical keys to a shell or ordinary program. For recognized agents use agents.prompt.",
        fields: &["pane_id", "text", "keys"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.send_text",
        action: "pane_send_text",
        description: "Send literal text to a shell or ordinary program without submitting it.",
        fields: &["pane_id", "text"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "panes.send_keys",
        action: "pane_send_keys",
        description: "Send logical keys to a shell or ordinary program.",
        fields: &["pane_id", "keys"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "agents.start",
        action: "agent_start",
        description: "Start a named agent in an available interactive shell. Waits for readiness, default 30 seconds. Does not grant Phone Use automatically.",
        fields: &["name", "kind", "pane_id", "args"],
        optional: &["timeout_ms"],
        read_only: false,
    },
    RemoteTool {
        name: "agents.focus",
        action: "agent_focus",
        description: "Focus an agent by its unique name or pane ID.",
        fields: &["target"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "agents.inspect",
        action: "agent_get",
        description: "Inspect one agent live by its unique name or pane ID.",
        fields: &["target"],
        optional: &[],
        read_only: true,
    },
    RemoteTool {
        name: "agents.read",
        action: "agent_read",
        description: "Read agent output; defaults to 120 lines of recent_unwrapped plain text.",
        fields: &["target"],
        optional: &["source", "lines", "format", "strip_ansi"],
        read_only: true,
    },
    RemoteTool {
        name: "agents.wait",
        action: "agent_wait",
        description: "Wait for agent lifecycle status without submitting input. Default 120 seconds, maximum 300 seconds.",
        fields: &["target"],
        optional: &["until", "timeout_ms"],
        read_only: true,
    },
    RemoteTool {
        name: "agents.send_keys",
        action: "agent_send_keys",
        description: "Send logical keys to the chosen agent. Inspect approval or blocked dialogs before acting.",
        fields: &["target", "keys"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "agents.prompt",
        action: "agent_prompt",
        description: "Submit a prompt to the chosen agent once. Without wait acknowledges submission; wait:{} waits for activity and settled lifecycle status, default 120 seconds. Never retry an uncertain outcome.",
        fields: &["target", "text"],
        optional: &["wait"],
        read_only: false,
    },
    RemoteTool {
        name: "hosts.integration_install",
        action: "integration_install",
        description: "Install the integration for the requested agent kind on a connected host.",
        fields: &["kind"],
        optional: &[],
        read_only: false,
    },
    RemoteTool {
        name: "hosts.integration_list",
        action: "integration_list",
        description: "Inspect available agent integrations on a connected host.",
        fields: &[],
        optional: &[],
        read_only: true,
    },
];

pub(super) fn is_tool_namespace(name: &str) -> bool {
    ["hosts.", "agents.", "workspaces.", "tabs.", "panes."]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

pub(super) fn tools() -> Vec<Value> {
    let mut operations = super::whip_state::tools();
    for tool in REMOTE_TOOLS {
        let mut properties = host_schema();
        for field in tool.fields.iter().chain(tool.optional) {
            properties[field] = match *field {
                "lines" => json!({"type":"integer","minimum":1,"maximum":16000}),
                "keys" | "args" => json!({"type":"array","items":string(),"maxItems":128}),
                "kind" => json!({"type":"string","enum":["claude","codex","opencode"]}),
                "direction" => json!({"type":"string","enum":["right","down"]}),
                "focus" | "strip_ansi" => json!({"type":"boolean"}),
                "source" => {
                    json!({"type":"string","enum":["visible","recent","recent_unwrapped","detection"]})
                }
                "format" => json!({"type":"string","enum":["text","ansi"]}),
                "timeout_ms" => {
                    json!({"type":"integer","minimum":if tool.action == "agent_start" {3001} else {1},"maximum":super::herdr::MAX_TIMEOUT_MS})
                }
                "until" => statuses_schema(),
                "wait" => object(
                    json!({"until":statuses_schema(),"timeout_ms":{"type":"integer","minimum":1,"maximum":super::herdr::MAX_TIMEOUT_MS}}),
                    &[],
                ),
                _ => string(),
            };
        }
        operations.push(json!({"name":tool.name,"description":tool.description,"inputSchema":object(properties,tool.fields),"annotations":{"readOnlyHint":tool.read_only,"destructiveHint":!tool.read_only,"openWorldHint":true}}));
    }
    let mut profile = json!({});
    for field in [
        "name",
        "host",
        "port",
        "username",
        "herdrCommand",
        "herdrSocketPath",
        "sessionName",
    ] {
        profile[field] = string();
    }
    profile["jumpHostId"] = json!({"type":["string","null"],"maxLength":256});
    profile["forwardAgent"] = json!({"type":"boolean"});
    profile["authMode"] = json!({"type":"string","enum":["password","key"]});
    operations.extend([
        (LIST, "List Whip's saved hosts, connection status and each host's AGENTS.md in agentInstructions. Read the target host's instructions before connecting or operating on it. No credentials are returned.", json!({}), vec![], true),
        (INSTRUCTIONS, "Read the user's global AGENTS.md and this host's optional AGENTS.md, stored in Whip. Read global first, then host instructions before connecting or operating on a host. Empty strings mean none configured. Available for disconnected hosts.", host_schema(), vec![], true),
        (SAVE, "Create or update saved host metadata with a partial profile. Omit host_id to create; new hosts require host and username. Existing credentials and user AGENTS.md are preserved. Optionally copy a saved credential locally using credential_from_host_id. No secrets accepted or returned. Editing a connected profile takes effect on its next connection.", { let mut p = host_schema(); p["profile"] = object(profile, &[]); p["credential_from_host_id"] = string(); p }, vec!["profile"], false),
        (DELETE, "Disconnect a saved host and delete its profile, local credentials and host caches. Deleting this agent's host ends its MCP session.", host_schema(), vec!["host_id"], false),
        (CONNECT, "Connect a saved host using Whip's stored credentials, jump hosts, biometric protection and host-key checks. Whip may prompt locally. Read its AGENTS.md from hosts.list first. Does not navigate the UI.", host_schema(), vec!["host_id"], false),
        (DISCONNECT, "Disconnect a host's Whip SSH session. Disconnecting this agent's host ends its MCP session.", host_schema(), vec!["host_id"], false),
        (REFRESH, "Explicitly refresh this connected host in Whip. Agent counts and discovery use agents.summary/list locally.", host_schema(), vec![], false),
        (STOP_AGENT, "Stop an existing agent through Whip lifecycle controls, preserving its pane and conversation data. May interrupt work. Stopping yourself ends this MCP session.", { let mut p = host_schema(); p["terminal_id"] = string(); p }, vec!["terminal_id"], false),
        (START_SERVER, "Start Herdr using the saved host's configured command over its existing SSH connection.", host_schema(), vec![], false),
        (RESTART_AGENT, "Restart an existing agent using Whip's conversation-preserving restart. May interrupt its current task. Restarting yourself ends this MCP session.", { let mut p = host_schema(); p["terminal_id"] = string(); p }, vec!["terminal_id"], false),
        (COPY_AGENT, "Copy an agent into a background tab in its current directory with its saved launch options and Phone Use preference, starting a fresh conversation and preserving user focus.", { let mut p = host_schema(); p["terminal_id"] = string(); p["label"] = string(); p }, vec!["terminal_id"], false),
    ].into_iter().map(|(name, description, properties, required, read_only)| json!({"name":name,"description":description,"inputSchema":object(properties,&required),"annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"openWorldHint":true}})));
    operations
}

fn statuses_schema() -> Value {
    json!({"type":"array","items":{"type":"string","enum":["working","blocked","idle","done","unknown"]},"maxItems":5})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr_api::HerdrControlRequest;

    #[test]
    fn catalog_exposes_named_whip_operations_and_rejects_raw_transport_calls()
    -> Result<(), Box<dyn std::error::Error>> {
        let tools = tools();
        for name in [
            "agents.summary",
            "agents.list",
            "agents.inspect",
            "agents.prompt",
            "agents.stop",
            "workspaces.list",
            "tabs.create",
            "panes.read",
            "hosts.refresh",
        ] {
            assert!(
                tools.iter().any(|tool| tool["name"] == name),
                "Missing {name}"
            );
        }
        assert!(tools.iter().all(|tool| {
            !tool["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("herdr."))
        }));
        for (name, args) in [
            ("herdr.snapshot", json!({})),
            (
                "herdr.request",
                json!({"request":{"action":"session_snapshot"}}),
            ),
            ("herdr.start_server", json!({})),
            ("herdr.restart_agent", json!({"terminal_id":"terminal-1"})),
            (
                "agents.prompt",
                json!({"target":"worker","text":"work","action":"session_snapshot"}),
            ),
            (
                "agents.inspect",
                json!({"request":{"action":"session_snapshot"}}),
            ),
        ] {
            assert!(
                Action::parse(name, &args).is_err(),
                "Accepted {name}: {args}"
            );
        }
        // The named tool still enforces creation semantics before any transport use.
        assert!(Action::parse("tabs.create", &json!({"workspace_id":"w"})).is_err());
        let Action::Herdr {
            operation: HerdrOperation::AgentRequest(request),
            ..
        } = Action::parse(
            "agents.prompt",
            &json!({"target":"worker","text":"work","wait":{}}),
        )?
        else {
            return Err("Missing agent prompt".into());
        };
        assert_eq!(
            request.base,
            Some(HerdrControlRequest::AgentPrompt {
                target: "worker".into(),
                text: "work".into()
            })
        );
        Ok(())
    }

    #[test]
    fn host_edits_reject_credentials_instructions_and_invalid_targets() {
        for (name, args) in [
            (SAVE, json!({"profile":{"secret":"private"}})),
            (
                SAVE,
                json!({"profile":{"agentInstructions":"replace user rules"}}),
            ),
            (SAVE, json!({"host_id":"", "profile":{}})),
            (SAVE, json!({"profile":{"port":"0"}})),
            (CONNECT, json!({})),
            (DISCONNECT, json!({"host_id":"x\n"})),
            ("panes.read", json!({"pane_id":"pane-1","lines":0})),
            (
                "agents.prompt",
                json!({"target":"agent-1","text":"ok","secret":"no"}),
            ),
        ] {
            assert!(Action::parse(name, &args).is_err(), "{name}: {args}");
        }
    }

    #[test]
    fn host_creation_and_herdr_input_keep_typed_arguments() -> Result<(), Box<dyn std::error::Error>>
    {
        let Action::Host(crate::reverse_control::hosts::HostAction::Save {
            host_id, patch, ..
        }) = Action::parse(
            SAVE,
            &json!({"profile":{"host":"mini","username":"kosumi"}}),
        )?
        else {
            return Err("missing host action".into());
        };
        assert!(host_id.starts_with("host-"));
        assert_eq!(patch.host.as_deref(), Some("mini"));
        assert_eq!(patch.username.as_deref(), Some("kosumi"));
        let literal = "printf '%s' \"quotes; $(do-not-run)\"\n";
        let Action::Herdr {
            host_id,
            operation: HerdrOperation::AgentRequest(request),
        } = Action::parse(
            "panes.send_text",
            &json!({"host_id":"mini","pane_id":"pane-1","text":literal}),
        )?
        else {
            return Err("missing Herdr request".into());
        };
        assert_eq!(host_id.as_deref(), Some("mini"));
        assert_eq!(
            request.base,
            Some(HerdrControlRequest::PaneSendText {
                pane_id: "pane-1".into(),
                text: literal.into()
            })
        );
        Ok(())
    }

    #[test]
    fn host_results_strip_secrets_and_return_both_instruction_scopes()
    -> Result<(), Box<dyn std::error::Error>> {
        let host = json!({"id":"mini","name":"Mini","host":"mini.local","port":"22","username":"kosumi","authMode":"key","herdrCommand":"herdr","sessionName":"","createdAt":"today","updatedAt":"today","agentInstructions":"# Mini\nUse system Xcode.\n","secret":"private key","passphrase":"private"});
        let mut workstation = host.clone();
        workstation["id"] = json!("workstation");
        workstation["agentInstructions"] = json!("# Workstation\nUse nix develop.\n");
        let result = host_result(
            LIST,
            json!({"hosts":[host,workstation],"connections":[],"secret":"private"}),
        )?;
        let value = &result["structuredContent"]["value"];
        assert_eq!(value["hosts"][0]["has_agent_instructions"], true);
        assert_eq!(
            value["hosts"][0]["agentInstructions"],
            "# Mini\nUse system Xcode.\n"
        );
        assert_eq!(value["hosts"][1]["id"], "workstation");
        assert_eq!(
            value["hosts"][1]["agentInstructions"],
            "# Workstation\nUse nix develop.\n"
        );
        assert!(!result.to_string().contains("private"));
        let global = "# Global\nAsk before deleting data.\n";
        let host = "# Mini\nUse system Xcode.\n";
        let instructions = host_result(
            INSTRUCTIONS,
            json!({"host_id":"mini","global":global,"host":host,"credential":"private"}),
        )?;
        assert_eq!(
            instructions["structuredContent"]["value"],
            json!({"host_id":"mini","global":global,"host":host})
        );
        Ok(())
    }

    #[test]
    fn herdr_errors_preserve_codes_and_ambiguous_outcomes() {
        for code in [
            "agent_blocked",
            "agent_not_ready",
            "agent_prompt_stalled",
            "agent_not_found",
            "timeout",
        ] {
            let result = control_error(HerdrControlError::ProtocolError(
                code.into(),
                "Inspect the agent".into(),
            ))
            .mcp();
            assert_eq!(result["structuredContent"]["error"]["code"], "herdr_error");
            assert_eq!(
                result["structuredContent"]["error"]["details"]["herdr_code"],
                code
            );
        }
        let disconnected = control_error(HerdrControlError::TransportDisconnected(
            "Lost connection".into(),
        ))
        .mcp();
        assert_eq!(
            disconnected["structuredContent"]["error"]["code"],
            "host_disconnected"
        );
        assert_eq!(
            disconnected["structuredContent"]["error"]["details"]["outcome_unknown"],
            true
        );
    }
}
