//! OpenCode 2 projected-message API adapter. API polling includes unfinished
//! messages, unlike `session export`, which only includes settled messages.

use std::collections::HashSet;

use super::*;

#[derive(Deserialize)]
pub(crate) struct OpenCodeV2Page {
    pub data: Vec<Value>,
    pub cursor: OpenCodeV2PageCursor,
}

#[derive(Deserialize)]
pub(crate) struct OpenCodeV2PageCursor {
    pub next: Option<String>,
}

pub(crate) struct OpenCodeV2Snapshot {
    pub info: Value,
    pub messages: Vec<Value>,
}

impl OpenCodeSessionCore {
    pub(crate) fn apply_v2_snapshot(
        &mut self,
        snapshot: OpenCodeV2Snapshot,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let info = snapshot
            .info
            .as_object()
            .ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
        if nonempty(info.get("id")) != Some(self.session_id.as_str()) {
            return Err(OpenCodeTranscriptError::InvalidSnapshot);
        }
        let mut info = info.clone();
        if let Some(directory) = info
            .get("location")
            .and_then(|location| location.get("directory"))
        {
            info.insert("directory".into(), directory.clone());
        }
        let info = open_code_session_info(&info);
        let mut ids = HashSet::new();
        let mut messages = Vec::new();
        // Validate the complete response before changing either history or cursor.
        for value in &snapshot.messages {
            let id = nonempty(value.get("id")).ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
            if !ids.insert(id) {
                return Err(OpenCodeTranscriptError::InvalidSnapshot);
            }
            if let Some(message) = message(value)? {
                messages.push(message);
            }
        }
        self.set_protocol(OpenCodeProtocol::V2);
        let cursor = self.cursor.unwrap_or_default();
        let incoming: HashSet<_> = messages.iter().map(|message| message.id.as_str()).collect();
        let retained: Vec<_> = self
            .messages
            .iter()
            .filter(|message| incoming.contains(message.id.as_str()))
            .collect();
        // Normal polling only appends messages. Fork/import/reordering requires
        // an authoritative reset because message-upsert cannot move a row.
        let reordered = retained
            .iter()
            .zip(&messages)
            .any(|(old, new)| old.id != new.id);
        if reordered {
            self.info = Some(info);
            self.messages = messages;
            self.turns = project_turns(&self.messages);
            self.rebuild_indexes();
            self.bump_revision();
            self.cursor = Some(cursor.saturating_add(1));
            return Ok(Some(AgentTranscriptUpdate::reset(self.state())));
        }
        let mut plan = vec![OpenCodeMutation::Info(info)];
        plan.extend(
            self.messages
                .iter()
                .rev()
                .filter(|message| !incoming.contains(message.id.as_str()))
                .map(|message| OpenCodeMutation::RemoveMessage(message.id.clone())),
        );
        plan.extend(messages.into_iter().map(OpenCodeMutation::ReplaceMessage));
        let deltas = self.apply_open_code_plan(plan);
        let changed = !deltas.is_empty();
        self.cursor = Some(if changed {
            cursor.saturating_add(1)
        } else {
            cursor
        });
        if changed {
            self.bump_revision();
        }
        Ok(changed.then_some(AgentTranscriptUpdate {
            revision: self.revision,
            deltas,
        }))
    }
}

fn message(value: &Value) -> Result<Option<AgentTranscriptMessage>, OpenCodeTranscriptError> {
    let id = nonempty(value.get("id")).ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
    let kind = nonempty(value.get("type")).ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
    let time = value.get("time");
    let created = timestamp_ms(time.and_then(|time| time.get("created")));
    let completed = timestamp_ms(time.and_then(|time| time.get("completed")));
    let mut result = AgentTranscriptMessage {
        id: id.to_owned(),
        role: AgentMessageRole::Assistant,
        parent_id: None,
        created_at_ms: created,
        completed_at_ms: completed,
        error: value.get("error").and_then(|value| detail(Some(value))),
        parts: Vec::new(),
        diffs: Vec::new(),
    };
    match kind {
        "user" => {
            result.role = AgentMessageRole::User;
            result.parts.push(AgentTranscriptPart::Text {
                id: format!("{id}:text"),
                text: required_text(value, "text")?.to_owned(),
                timestamp_ms: created,
            });
        }
        "assistant" => {
            let content = value
                .get("content")
                .and_then(Value::as_array)
                .ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
            for (ordinal, part) in content.iter().enumerate() {
                if let Some(part) = content_part(id, ordinal, part)? {
                    result.parts.push(part);
                }
            }
        }
        "shell" => {
            let status = required_text(value, "status")?;
            let exit = value.get("exit").and_then(Value::as_i64);
            let failed =
                matches!(status, "timeout" | "killed") || exit.is_some_and(|exit| exit != 0);
            let part = serde_json::json!({
                "id": format!("{id}:shell"), "type": "tool", "tool": "bash",
                "callID": value.get("shellID"),
                "state": {
                    "status": if status == "running" { "running" } else if failed { "error" } else { "completed" },
                    "input": { "command": required_text(value, "command")? },
                    "output": value.get("output").and_then(|output| output.get("output")),
                    "metadata": { "exitCode": exit },
                    "time": { "start": created, "end": completed }
                }
            });
            if let Some(part) = part.as_object().and_then(open_code_part) {
                result.parts.push(part);
            }
        }
        // These are model context and timeline controls, not chat replies.
        _ => return Ok(None),
    }
    Ok(Some(result))
}

fn required_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, OpenCodeTranscriptError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(OpenCodeTranscriptError::InvalidSnapshot)
}

fn content_part(
    message_id: &str,
    ordinal: usize,
    value: &Value,
) -> Result<Option<AgentTranscriptPart>, OpenCodeTranscriptError> {
    let kind = required_text(value, "type")?;
    // Text/reasoning have no IDs in v2; their content ordinal is stable as a
    // response grows. Tool IDs remain the provider's call ID.
    let id = format!("{message_id}:content:{ordinal}");
    let mut part = serde_json::json!({ "id": id, "type": kind });
    match kind {
        "text" | "reasoning" => {
            part["text"] = Value::String(required_text(value, "text")?.to_owned());
            part["time"] = serde_json::json!({ "start": value.get("time").and_then(|time| time.get("created")) });
        }
        "tool" => {
            part["callID"] = Value::String(required_text(value, "id")?.to_owned());
            part["tool"] = Value::String(required_text(value, "name")?.to_owned());
            let mut state = value
                .get("state")
                .and_then(Value::as_object)
                .cloned()
                .ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
            if nonempty(state.get("status")) == Some("streaming") {
                state.insert("status".into(), Value::String("pending".into()));
            }
            if let Some(content) = state.get("content").and_then(Value::as_array) {
                let output = content
                    .iter()
                    .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                        Some("text") => item.get("text").and_then(Value::as_str),
                        Some("file") => item.get("uri").and_then(Value::as_str),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                state.insert("output".into(), Value::String(output));
            }
            let time = value.get("time");
            state.insert(
                "time".into(),
                serde_json::json!({
                    "start": time.and_then(|time| time.get("ran").or_else(|| time.get("created"))),
                    "end": time.and_then(|time| time.get("completed"))
                }),
            );
            part["state"] = Value::Object(state);
        }
        _ => return Ok(None),
    }
    Ok(part.as_object().and_then(open_code_part))
}
