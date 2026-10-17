//! Agent-oriented Herdr requests, independent of the native UI contract.
use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::herdr_api::{HerdrControlError, HerdrControlRequest};

pub(crate) const MAX_TIMEOUT_MS: u64 = 300_000;
const DEFAULT_WAIT_MS: u64 = 120_000;
const START_TIMEOUT_MS: u64 = 30_000;
const REQUEST_TIMEOUT_MS: u64 = 15_000;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
// These richer lifecycle semantics are verified against the protocol-22 server.
const LIFECYCLE_PROTOCOL: u32 = 22;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Working,
    Blocked,
    Idle,
    Done,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Visible,
    Recent,
    #[default]
    RecentUnwrapped,
    Detection,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    #[default]
    Text,
    Ansi,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Wait {
    #[serde(default)]
    until: Vec<Status>,
    timeout_ms: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    focus: Option<bool>,
    cwd: Option<String>,
    source: Option<Source>,
    format: Option<Format>,
    strip_ansi: Option<bool>,
    timeout_ms: Option<u64>,
    wait: Option<Wait>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Lifecycle {
    #[serde(rename = "agent_get")]
    Get { target: String },
    #[serde(rename = "agent_read")]
    Read {
        target: String,
        #[serde(default)]
        source: Source,
        lines: Option<u32>,
        #[serde(default)]
        format: Format,
        strip_ansi: Option<bool>,
    },
    #[serde(rename = "agent_wait")]
    Wait {
        target: String,
        #[serde(default)]
        until: Vec<Status>,
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "agent_send_keys")]
    SendKeys { target: String, keys: Vec<String> },
}

pub(crate) struct Request {
    pub(crate) base: Option<HerdrControlRequest>,
    method: String,
    params: Value,
    expected: String,
    minimum_protocol: u32,
    timeout_ms: u64,
}

#[derive(Clone)]
pub(crate) struct Call {
    pub(crate) method: String,
    pub(crate) params: Value,
    pub(crate) timeout_ms: u64,
    expected: String,
}

fn invalid(message: impl Into<String>) -> HerdrControlError {
    HerdrControlError::InvalidField(message.into())
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, HerdrControlError> {
    serde_json::from_value(value).map_err(|error| invalid(error.to_string()))
}

fn timeout(value: Option<u64>, default: u64, minimum: u64) -> Result<u64, HerdrControlError> {
    let value = value.unwrap_or(default);
    if !(minimum..=MAX_TIMEOUT_MS).contains(&value) {
        return Err(invalid(format!(
            "timeout_ms must be {minimum}..{MAX_TIMEOUT_MS}"
        )));
    }
    Ok(value)
}

fn lines(value: u32) -> Result<(), HerdrControlError> {
    if !(1..=16_000).contains(&value) {
        return Err(invalid("lines must be 1..16000"));
    }
    Ok(())
}

fn target(value: &str) -> Result<(), HerdrControlError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(invalid("Use a live agent name or pane ID from this host"));
    }
    Ok(())
}

impl Request {
    pub(crate) fn parse(mut value: Value) -> Result<Self, HerdrControlError> {
        let action = value["action"]
            .as_str()
            .ok_or_else(|| invalid("request.action is required"))?
            .to_owned();
        if matches!(
            action.as_str(),
            "agent_get" | "agent_read" | "agent_wait" | "agent_send_keys"
        ) {
            return Self::lifecycle(decode(value)?);
        }
        let fields = value
            .as_object_mut()
            .ok_or_else(|| invalid("Expected a request object"))?;
        let extras: &[&str] = match action.as_str() {
            "workspace_create" | "tab_create" | "pane_split" => &["focus", "cwd"],
            "pane_read" | "pane_read_visible" => &["source", "format", "strip_ansi"],
            "agent_start" => &["timeout_ms"],
            "agent_prompt" => &["wait"],
            _ => &[],
        };
        let mut options = json!({});
        for key in extras {
            if let Some(value) = fields.remove(*key) {
                options[key] = value;
            }
        }
        // Workspace cwd already belongs to the native UI's request variant.
        if action == "workspace_create" {
            fields.insert("cwd".into(), options["cwd"].clone());
        }
        if action == "pane_read" {
            fields.entry("lines").or_insert(json!(120));
        }
        let options: Options = decode(options)?;
        let base: HerdrControlRequest = decode(value)?;
        let wire: Value = serde_json::from_slice(&base.encode("reverse-control")?)
            .map_err(|error| invalid(error.to_string()))?;
        let mut params = wire["params"].clone();
        let mut minimum_protocol = 17;
        let mut timeout_ms = REQUEST_TIMEOUT_MS;
        if matches!(
            action.as_str(),
            "workspace_create" | "tab_create" | "pane_split"
        ) {
            let cwd = options
                .cwd
                .filter(|cwd| !cwd.is_empty() && !cwd.chars().any(char::is_control))
                .ok_or_else(|| {
                    invalid("Creation requires an explicit nonempty cwd on the target host")
                })?;
            params["cwd"] = json!(cwd);
            params["focus"] = json!(options.focus.unwrap_or(false));
            if action != "workspace_create" {
                minimum_protocol = LIFECYCLE_PROTOCOL;
            }
        }
        if matches!(action.as_str(), "pane_read" | "pane_read_visible") {
            let source = options.source.unwrap_or(if action == "pane_read_visible" {
                Source::Visible
            } else {
                Source::RecentUnwrapped
            });
            let format = options.format.unwrap_or_default();
            params["source"] = json!(source);
            params["format"] = json!(format);
            params["strip_ansi"] =
                json!(options.strip_ansi.unwrap_or(matches!(format, Format::Text)));
            if let HerdrControlRequest::PaneRead { lines: count, .. } = &base {
                lines(*count)?;
            }
        }
        if let HerdrControlRequest::AgentStart { name, .. } = &base {
            if name.len() > 32
                || !name.bytes().next().is_some_and(|c| c.is_ascii_lowercase())
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
            {
                return Err(invalid("Agent names must match [a-z][a-z0-9_-]{0,31}"));
            }
            timeout_ms = timeout(options.timeout_ms, START_TIMEOUT_MS, 3001)?;
            params["timeout_ms"] = json!(timeout_ms);
            minimum_protocol = LIFECYCLE_PROTOCOL;
        }
        if let HerdrControlRequest::AgentPrompt { target: name, .. }
        | HerdrControlRequest::AgentFocus { target: name } = &base
        {
            target(name)?;
        }
        if let Some(wait) = options.wait {
            timeout_ms = timeout(wait.timeout_ms, DEFAULT_WAIT_MS, 1)?;
            if wait.until.len() > 5 {
                return Err(invalid("At most five wait statuses"));
            }
            params["wait"] = json!({"until":wait.until,"timeout_ms":timeout_ms});
            minimum_protocol = LIFECYCLE_PROTOCOL;
        }
        let expected = base.result_type().into();
        Ok(Self {
            base: Some(base),
            method: wire["method"].as_str().unwrap_or_default().into(),
            params,
            expected,
            minimum_protocol,
            timeout_ms,
        })
    }

    fn lifecycle(request: Lifecycle) -> Result<Self, HerdrControlError> {
        let (method, params, expected, timeout_ms) = match request {
            Lifecycle::Get { target: name } => {
                target(&name)?;
                (
                    "agent.get",
                    json!({"target":name}),
                    "agent_info",
                    REQUEST_TIMEOUT_MS,
                )
            }
            Lifecycle::Read {
                target: name,
                source,
                lines: count,
                format,
                strip_ansi,
            } => {
                target(&name)?;
                let count = count.unwrap_or(120);
                lines(count)?;
                (
                    "agent.read",
                    json!({"target":name,"source":source,"lines":count,"format":format,"strip_ansi":strip_ansi.unwrap_or(matches!(format, Format::Text))}),
                    "pane_read",
                    REQUEST_TIMEOUT_MS,
                )
            }
            Lifecycle::Wait {
                target: name,
                until,
                timeout_ms,
            } => {
                target(&name)?;
                if until.len() > 5 {
                    return Err(invalid("At most five wait statuses"));
                }
                let duration = timeout(timeout_ms, DEFAULT_WAIT_MS, 1)?;
                (
                    "agent.wait",
                    json!({"target":name,"until":until,"timeout_ms":duration}),
                    "agent_info",
                    duration,
                )
            }
            Lifecycle::SendKeys { target: name, keys } => {
                target(&name)?;
                if keys.is_empty() {
                    return Err(invalid("keys cannot be empty"));
                }
                (
                    "agent.send_keys",
                    json!({"target":name,"keys":keys}),
                    "ok",
                    REQUEST_TIMEOUT_MS,
                )
            }
        };
        Ok(Self {
            base: None,
            method: method.into(),
            params,
            expected: expected.into(),
            minimum_protocol: LIFECYCLE_PROTOCOL,
            timeout_ms,
        })
    }

    pub(crate) async fn run<F, Fut>(
        &self,
        protocol: u32,
        mut send: F,
    ) -> Result<Value, HerdrControlError>
    where
        F: FnMut(Call) -> Fut,
        Fut: Future<Output = Result<Value, HerdrControlError>>,
    {
        if protocol < self.minimum_protocol {
            return Err(HerdrControlError::ProtocolError(
                "unsupported_feature".into(),
                format!(
                    "{} requires Herdr protocol {} (host negotiated {protocol}); inspect server status without stopping it",
                    self.method, self.minimum_protocol
                ),
            ));
        }
        let deadline = Instant::now() + Duration::from_millis(self.timeout_ms);
        let pinned_terminal =
            if let Some(HerdrControlRequest::AgentStart { pane_id, .. }) = &self.base {
                let pane = Call {
                    method: "pane.get".into(),
                    params: json!({"pane_id":pane_id}),
                    expected: "pane_info".into(),
                    timeout_ms: REQUEST_TIMEOUT_MS.min(self.timeout_ms),
                }
                .send(&mut send)
                .await?;
                Some(
                    pane["pane"]["terminal_id"]
                        .as_str()
                        .ok_or_else(|| invalid("pane.get omitted terminal_id"))?
                        .to_owned(),
                )
            } else {
                None
            };
        let call = Call {
            method: self.method.clone(),
            params: self.params.clone(),
            expected: self.expected.clone(),
            timeout_ms: self.timeout_ms.saturating_add(1000),
        };
        // Mutations are sent exactly once. A timeout can mean input was delivered.
        let mut result = call.send(&mut send).await?;
        if let Some(HerdrControlRequest::AgentStart { name, pane_id, .. }) = &self.base {
            let terminal = result["agent"]["terminal_id"]
                .as_str()
                .ok_or_else(|| invalid("agent.start omitted terminal_id"))?
                .to_owned();
            if pinned_terminal.as_deref() != Some(&terminal) {
                return Err(HerdrControlError::ProtocolError(
                    "agent_name_lost".into(),
                    "Pane occupant changed before launch admission; inspect state before retrying"
                        .into(),
                ));
            }
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(HerdrControlError::RequestTimeout("Agent launch was submitted; inspect agent.get and agent.read before retrying".into()));
                }
                let call = Call {
                    method: "agent.get".into(),
                    params: json!({"target":name}),
                    expected: "agent_info".into(),
                    timeout_ms: REQUEST_TIMEOUT_MS
                        .min(u64::try_from(remaining.as_millis()).unwrap_or(MAX_TIMEOUT_MS)),
                };
                let current = match call.send(&mut send).await {
                    Err(HerdrControlError::ProtocolError(code, _)) if code == "agent_not_found" => {
                        Call {
                            params: json!({"target":pane_id}),
                            ..call
                        }
                        .send(&mut send)
                        .await?
                    }
                    other => other?,
                };
                if startup_ready(
                    &current["agent"],
                    &terminal,
                    name,
                    self.params["kind"].as_str().unwrap_or_default(),
                )? {
                    result["agent"] = current["agent"].clone();
                    result["ready"] = json!(true);
                    break;
                }
                tokio::time::sleep(POLL_INTERVAL.min(remaining)).await;
            }
        }
        if self.method == "agent.prompt" {
            result["completion"] = json!(if self.params["wait"].is_object() {
                "lifecycle_wait_satisfied"
            } else {
                "submitted"
            });
        }
        Ok(result)
    }

    pub(crate) fn changes_state(&self) -> bool {
        !matches!(
            self.method.as_str(),
            "ping"
                | "session.snapshot"
                | "pane.get"
                | "pane.read"
                | "agent.get"
                | "agent.read"
                | "agent.wait"
                | "integration.list"
        )
    }
}

impl Call {
    async fn send<F, Fut>(&self, send: &mut F) -> Result<Value, HerdrControlError>
    where
        F: FnMut(Self) -> Fut,
        Fut: Future<Output = Result<Value, HerdrControlError>>,
    {
        let result = send(self.clone()).await?;
        if result["type"].as_str() != Some(&self.expected) {
            return Err(HerdrControlError::UnsupportedResponse(format!(
                "Unexpected response to {}: expected {}",
                self.method, self.expected
            )));
        }
        Ok(result)
    }
}

fn startup_ready(
    agent: &Value,
    terminal: &str,
    name: &str,
    kind: &str,
) -> Result<bool, HerdrControlError> {
    let failure =
        |code: &str, message: &str| HerdrControlError::ProtocolError(code.into(), message.into());
    if agent["terminal_id"].as_str() != Some(terminal) || agent["name"].as_str() != Some(name) {
        return Err(failure(
            "agent_name_lost",
            "Agent name or pane occupant changed during startup; inspect the host snapshot",
        ));
    }
    if agent["agent"].as_str().is_some_and(|actual| actual != kind) {
        return Err(failure(
            "agent_kind_mismatch",
            "A different agent kind appeared during startup",
        ));
    }
    match agent["agent_status"].as_str() {
        Some("blocked") => Err(failure(
            "agent_not_ready",
            "Agent is blocked during startup; read its UI before sending input",
        )),
        Some("unknown") if kind == "codex" => Ok(agent["interactive_ready"] == true),
        Some("idle" | "done") if agent["interactive_ready"] == true => Ok(true),
        Some("idle" | "done") if agent["launch_pending"] != true => Err(failure(
            "agent_start_failed",
            "Agent exited before becoming interactive",
        )),
        _ => Ok(false),
    }
}

#[cfg(test)]
#[path = "herdr_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "herdr_integration.rs"]
mod integration;
