//! Functional access to Whip's saved hosts and existing Herdr transports.
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::ReverseControl;
use super::browser::model::{BrowserError, ErrorCode, MAX_INPUT, MAX_REQUEST, MAX_TEXT_RESULT};
use crate::herdr_api::{HerdrControlError, HerdrControlRequest, HerdrTabLaunchResult};
use crate::host_profiles::{HostProfileRecord, MAX_AGENT_INSTRUCTIONS};

const LIST: &str = "hosts.list";
const INSTRUCTIONS: &str = "hosts.instructions";
const SAVE: &str = "hosts.save";
const DELETE: &str = "hosts.delete";
const CONNECT: &str = "hosts.connect";
const DISCONNECT: &str = "hosts.disconnect";
const SNAPSHOT: &str = "herdr.snapshot";
const REQUEST: &str = "herdr.request";
const START_SERVER: &str = "herdr.start_server";
const RESTART_AGENT: &str = "herdr.restart_agent";
const COPY_AGENT: &str = "herdr.copy_agent";

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
struct RequestArgs {
    host_id: Option<String>,
    request: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentArgs {
    host_id: Option<String>,
    terminal_id: String,
    label: Option<String>,
}

pub(super) enum Action {
    Host {
        name: String,
        arguments: Value,
    },
    Herdr {
        host_id: Option<String>,
        operation: HerdrOperation,
    },
}

pub(super) enum HerdrOperation {
    Request(HerdrControlRequest),
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

fn identifier(value: &str) -> Result<(), BrowserError> {
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
            SNAPSHOT | START_SERVER => {
                let args: HostArgs = decode(arguments)?;
                return Ok(Self::Herdr {
                    host_id: args.host_id,
                    operation: if name == SNAPSHOT {
                        HerdrOperation::Request(HerdrControlRequest::SessionSnapshot)
                    } else {
                        HerdrOperation::StartServer
                    },
                });
            }
            REQUEST => {
                let args: RequestArgs = decode(arguments)?;
                let request = super::herdr::Request::parse(args.request).map_err(control_error)?;
                return Ok(Self::Herdr {
                    host_id: args.host_id,
                    operation: HerdrOperation::AgentRequest(request),
                });
            }
            RESTART_AGENT | COPY_AGENT => {
                let args: AgentArgs = decode(arguments)?;
                identifier(&args.terminal_id)?;
                if name == RESTART_AGENT && args.label.is_some() {
                    return Err(BrowserError::invalid("Restart does not accept a label"));
                }
                return Ok(Self::Herdr {
                    host_id: args.host_id,
                    operation: if name == RESTART_AGENT {
                        HerdrOperation::RestartAgent(args.terminal_id)
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
        Ok(Self::Host {
            name: name.to_owned(),
            arguments,
        })
    }

    pub(super) async fn run(
        self,
        owner: Arc<ReverseControl>,
        session: String,
        parent: String,
        caller_host: String,
    ) -> Result<Value, BrowserError> {
        match self {
            Self::Host {
                name,
                mut arguments,
            } => {
                if name == INSTRUCTIONS && arguments["host_id"].is_null() {
                    arguments["host_id"] = json!(caller_host);
                }
                let value = owner
                    .begin_wire_step(&session, &parent, &name, arguments)?
                    .receive()
                    .await?;
                host_result(&name, value)
            }
            Self::Herdr { host_id, operation } => {
                let host_id = host_id.unwrap_or(caller_host);
                let runtime =
                    crate::host_runtime::get_host_runtime(host_id.clone()).ok_or_else(|| {
                        BrowserError::new(
                            ErrorCode::NotFound,
                            "Connect this saved host with hosts.connect first",
                        )
                    })?;
                let value = match operation {
                    HerdrOperation::AgentRequest(request) => runtime
                        .request_from_reverse_agent(request)
                        .await
                        .map_err(control_error)?,
                    HerdrOperation::Request(request) => {
                        json!(
                            runtime
                                .control_from_reverse_agent(request)
                                .await
                                .map_err(control_error)?
                        )
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
                result("herdr", json!({"host_id":host_id,"result":value}))
            }
        }
    }
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
            json!({"source":"herdr","outcome_unknown":true,"guidance":"Input may have been delivered. Inspect agent.get, agent.read or herdr.snapshot before retrying a mutation."})
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
            "Response exceeds the tool limit; use a smaller pane read",
        ));
    }
    let content = json!({"kind":kind,"value":value});
    Ok(
        json!({"isError":false,"structuredContent":content,"content":[{"type":"text","text":content.to_string()}]}),
    )
}

#[derive(Deserialize, serde::Serialize)]
struct Connection {
    host_id: String,
    status: String,
}

fn host_result(name: &str, value: Value) -> Result<Value, BrowserError> {
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
                        fields.remove("agentInstructions");
                        fields.insert("has_agent_instructions".into(), json!(has_instructions));
                    }
                    host
                })
                .collect();
            json!({"hosts":hosts,"connections":reply.connections})
        }
        INSTRUCTIONS => {
            #[derive(Deserialize, serde::Serialize)]
            struct Reply {
                host_id: String,
                global: String,
                host: String,
            }
            let reply: Reply = decode_reply(value)?;
            if reply.global.len() > MAX_AGENT_INSTRUCTIONS
                || reply.host.len() > MAX_AGENT_INSTRUCTIONS
            {
                return Err(BrowserError::new(
                    ErrorCode::InvalidResult,
                    "AGENTS.md exceeds the instruction limit",
                ));
            }
            json!(reply)
        }
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
    json!({"host_id":{"type":"string","maxLength":256,"description":"Saved host id from hosts.list. Herdr and instruction tools default to this agent's host."}})
}

pub(super) fn tools() -> Vec<Value> {
    let mut request_variants = Vec::new();
    for (action, fields, optional) in [
        ("ping", vec![], vec![]),
        ("session_snapshot", vec![], vec![]),
        ("workspace_create", vec!["cwd"], vec!["label", "focus"]),
        ("workspace_focus", vec!["workspace_id"], vec![]),
        ("workspace_close", vec!["workspace_id"], vec![]),
        ("workspace_rename", vec!["workspace_id", "label"], vec![]),
        (
            "tab_create",
            vec!["workspace_id", "cwd"],
            vec!["label", "focus"],
        ),
        ("tab_focus", vec!["tab_id"], vec![]),
        ("tab_close", vec!["tab_id"], vec![]),
        ("tab_rename", vec!["tab_id", "label"], vec![]),
        (
            "pane_read",
            vec!["pane_id"],
            vec!["lines", "source", "format", "strip_ansi"],
        ),
        (
            "pane_read_visible",
            vec!["pane_id"],
            vec!["source", "format", "strip_ansi"],
        ),
        ("pane_get", vec!["pane_id"], vec![]),
        ("pane_focus", vec!["pane_id"], vec![]),
        ("pane_close", vec!["pane_id"], vec![]),
        ("pane_rename", vec!["pane_id"], vec!["label"]),
        (
            "pane_split",
            vec!["pane_id", "direction", "cwd"],
            vec!["focus"],
        ),
        ("pane_zoom", vec!["pane_id"], vec![]),
        ("pane_send_input", vec!["pane_id", "text", "keys"], vec![]),
        ("pane_send_text", vec!["pane_id", "text"], vec![]),
        ("pane_send_keys", vec!["pane_id", "keys"], vec![]),
        (
            "agent_start",
            vec!["name", "kind", "pane_id", "args"],
            vec!["timeout_ms"],
        ),
        ("agent_focus", vec!["target"], vec![]),
        ("agent_get", vec!["target"], vec![]),
        (
            "agent_read",
            vec!["target"],
            vec!["source", "lines", "format", "strip_ansi"],
        ),
        ("agent_wait", vec!["target"], vec!["until", "timeout_ms"]),
        ("agent_send_keys", vec!["target", "keys"], vec![]),
        ("agent_prompt", vec!["target", "text"], vec!["wait"]),
        ("integration_install", vec!["kind"], vec![]),
        ("integration_list", vec![], vec![]),
    ] {
        let mut properties = json!({"action":{"const":action,"type":"string"}});
        for field in fields.iter().chain(&optional) {
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
                    json!({"type":"integer","minimum":if action == "agent_start" {3001} else {1},"maximum":super::herdr::MAX_TIMEOUT_MS})
                }
                "until" => statuses_schema(),
                "wait" => object(
                    json!({"until":statuses_schema(),"timeout_ms":{"type":"integer","minimum":1,"maximum":super::herdr::MAX_TIMEOUT_MS}}),
                    &[],
                ),
                _ => string(),
            };
        }
        let mut required = vec!["action"];
        required.extend(fields);
        request_variants.push(object(properties, &required));
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
    [
        (LIST, "List Whip's saved host metadata and connection status. No credentials or instruction contents are returned. Read hosts.instructions before using a host.", json!({}), vec![], true),
        (INSTRUCTIONS, "Read the user's global AGENTS.md and this host's optional AGENTS.md, stored in Whip. Read global first, then host instructions before connecting or operating on a host. Empty strings mean none configured. Available for disconnected hosts.", host_schema(), vec![], true),
        (SAVE, "Create or update saved host metadata with a partial profile. Omit host_id to create; new hosts require host and username. Existing credentials and user AGENTS.md are preserved. Optionally copy a saved credential locally using credential_from_host_id. No secrets accepted or returned. Editing a connected profile takes effect on its next connection.", { let mut p = host_schema(); p["profile"] = object(profile, &[]); p["credential_from_host_id"] = string(); p }, vec!["profile"], false),
        (DELETE, "Disconnect a saved host and delete its profile, local credentials and host caches. Deleting this agent's host ends its MCP session.", host_schema(), vec!["host_id"], false),
        (CONNECT, "Connect a saved host using Whip's stored credentials, jump hosts, biometric protection and host-key checks. Whip may prompt locally. Read hosts.instructions first. Does not navigate the UI.", host_schema(), vec!["host_id"], false),
        (DISCONNECT, "Disconnect a host's Whip SSH session. Disconnecting this agent's host ends its MCP session.", host_schema(), vec!["host_id"], false),
        (SNAPSHOT, "Read live Herdr workspaces, tabs, panes and agents over Whip's existing SSH connection. Read hosts.instructions first. IDs from this snapshot target herdr.request.", host_schema(), vec![], true),
        (REQUEST, "Call Herdr on a connected saved host; returns its tagged result (type). Read hosts.instructions and herdr.snapshot first. Creation requires cwd and defaults focus=false. Reads default recent_unwrapped text, 120 lines. agent_start waits for interactive readiness (default 30s); agent_prompt without wait acknowledges submission, with wait:{} uses atomic lifecycle waiting (default 120s, max 300s). agent_get/read/wait/send_keys, startup readiness, prompt waits and explicit tab/split cwd require protocol 22; unsupported hosts return unsupported_feature before input. Agent targets are names or pane IDs, never terminal IDs. New agents do not receive Reverse Control automatically. Inspect blocked or ambiguous outcomes before sending more input.", { let mut p = host_schema(); p["request"] = json!({"oneOf":request_variants}); p }, vec!["request"], false),
        (START_SERVER, "Start Herdr using the saved host's configured command over its existing SSH connection.", host_schema(), vec![], false),
        (RESTART_AGENT, "Restart an existing agent using Whip's conversation-preserving restart. May interrupt its current task. Restarting yourself ends this MCP session.", { let mut p = host_schema(); p["terminal_id"] = string(); p }, vec!["terminal_id"], false),
        (COPY_AGENT, "Copy an agent into a background tab in its current directory with its saved launch options and Reverse Control preference, starting a fresh conversation. Requires protocol 22 and preserves user focus.", { let mut p = host_schema(); p["terminal_id"] = string(); p["label"] = string(); p }, vec!["terminal_id"], false),
    ].into_iter().map(|(name, description, properties, required, read_only)| json!({"name":name,"description":description,"inputSchema":object(properties,&required),"annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"openWorldHint":true}})).collect()
}

fn statuses_schema() -> Value {
    json!({"type":"array","items":{"type":"string","enum":["working","blocked","idle","done","unknown"]},"maxItems":5})
}

#[cfg(test)]
mod tests {
    use super::*;

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
            (
                REQUEST,
                json!({"request":{"action":"pane_read","pane_id":"pane-1","lines":0}}),
            ),
            (
                REQUEST,
                json!({"request":{"action":"agent_prompt","target":"agent-1","text":"ok","secret":"no"}}),
            ),
        ] {
            assert!(Action::parse(name, &args).is_err(), "{name}: {args}");
        }
    }

    #[test]
    fn host_creation_and_herdr_input_keep_typed_arguments() -> Result<(), Box<dyn std::error::Error>>
    {
        let Action::Host { arguments, .. } = Action::parse(
            SAVE,
            &json!({"profile":{"host":"mini","username":"kosumi"}}),
        )?
        else {
            return Err("missing host action".into());
        };
        assert!(
            arguments["host_id"]
                .as_str()
                .is_some_and(|id| id.starts_with("host-"))
        );
        let literal = "printf '%s' \"quotes; $(do-not-run)\"\n";
        let Action::Herdr {
            host_id,
            operation: HerdrOperation::AgentRequest(request),
        } = Action::parse(
            REQUEST,
            &json!({"host_id":"mini","request":{"action":"pane_send_text","pane_id":"pane-1","text":literal}}),
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
        let result = host_result(
            LIST,
            json!({"hosts":[host],"connections":[],"secret":"private"}),
        )?;
        let value = &result["structuredContent"]["value"];
        assert_eq!(value["hosts"][0]["has_agent_instructions"], true);
        assert!(value["hosts"][0].get("agentInstructions").is_none());
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
