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

/// The durable log position and the complete API order, including hidden rows.
/// A rollback can target a hidden row, so projected chat IDs alone are unsafe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OpenCodeV2History {
    pub sequence: u64,
    pub message_ids: Vec<String>,
}

pub(crate) struct OpenCodeV2ReadState {
    pub history: OpenCodeV2History,
    pub pending_assistants: Vec<String>,
    pub shells: HashMap<String, String>,
}

pub(crate) enum OpenCodeV2Sync {
    Full {
        snapshot: OpenCodeV2Snapshot,
        sequence: Option<u64>,
    },
    Changes {
        info: Value,
        history: OpenCodeV2History,
        messages: Vec<Value>,
    },
}

impl OpenCodeSessionCore {
    pub(crate) fn v2_sequence(&self) -> Option<u64> {
        self.v2_history.as_ref().map(|history| history.sequence)
    }

    pub(crate) fn v2_read_state(&self) -> Option<OpenCodeV2ReadState> {
        Some(OpenCodeV2ReadState {
            history: self.v2_history.clone()?,
            pending_assistants: self
                .messages
                .iter()
                .filter(|message| {
                    message.role == AgentMessageRole::Assistant && message.completed_at_ms.is_none()
                })
                .map(|message| message.id.clone())
                .collect(),
            shells: self
                .messages
                .iter()
                .flat_map(|message| {
                    message.parts.iter().filter_map(move |part| match part {
                        AgentTranscriptPart::Tool { id, call_id, .. }
                            if id == &format!("{}:shell", message.id) =>
                        {
                            Some((call_id.clone(), message.id.clone()))
                        }
                        _ => None,
                    })
                })
                .collect(),
        })
    }

    pub(crate) fn apply_v2_sync(
        &mut self,
        sync: OpenCodeV2Sync,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let (info, messages, history) = match sync {
            OpenCodeV2Sync::Full { snapshot, sequence } => {
                let history = sequence
                    .map(|sequence| {
                        Ok::<_, OpenCodeTranscriptError>(OpenCodeV2History {
                            sequence,
                            message_ids: snapshot
                                .messages
                                .iter()
                                .map(|value| {
                                    nonempty(value.get("id"))
                                        .map(str::to_owned)
                                        .ok_or(OpenCodeTranscriptError::InvalidSnapshot)
                                })
                                .collect::<Result<_, _>>()?,
                        })
                    })
                    .transpose()?;
                let messages = Self::project_v2_messages(&snapshot.messages)?;
                (snapshot.info, messages, history)
            }
            OpenCodeV2Sync::Changes {
                info,
                history,
                messages,
            } => {
                let old_history = self
                    .v2_history
                    .as_ref()
                    .filter(|old| history.sequence >= old.sequence)
                    .ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
                let ids: HashSet<_> = history.message_ids.iter().map(String::as_str).collect();
                if ids.len() != history.message_ids.len() || ids.contains("") {
                    return Err(OpenCodeTranscriptError::InvalidSnapshot);
                }
                // Validate all replacements, including hidden rows, before mutation.
                let replacements: HashMap<_, _> = Self::project_v2_messages(&messages)?
                    .into_iter()
                    .map(|message| (message.id.clone(), message))
                    .collect();
                let replaced: HashSet<_> = messages
                    .iter()
                    .filter_map(|value| nonempty(value.get("id")))
                    .collect();
                if replaced.iter().any(|id| !ids.contains(id)) {
                    return Err(OpenCodeTranscriptError::InvalidSnapshot);
                }
                let old_ids: HashSet<_> = old_history.message_ids.iter().collect();
                let mut projected = Vec::new();
                for id in &history.message_ids {
                    if let Some(message) = replacements.get(id) {
                        projected.push(message.clone());
                    } else if replaced.contains(id.as_str()) {
                        // A changed row can become hidden.
                    } else if let Some(index) = self.message_indexes.get(id) {
                        projected.push(self.messages[*index].clone());
                    } else if !old_ids.contains(id) {
                        return Err(OpenCodeTranscriptError::InvalidSnapshot);
                    }
                }
                (info, projected, Some(history))
            }
        };
        let cursor = self.cursor;
        let history_changed = self.v2_history != history;
        let update = self.apply_v2_projected(info, messages)?;
        self.v2_history = history;
        // Checkpoints must advance for log-only changes as well as visible ones.
        if history_changed && self.cursor == cursor {
            self.cursor = Some(cursor.unwrap_or_default().saturating_add(1));
        }
        Ok(update)
    }

    #[cfg(test)]
    pub(crate) fn apply_v2_snapshot(
        &mut self,
        snapshot: OpenCodeV2Snapshot,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        self.apply_v2_sync(OpenCodeV2Sync::Full {
            snapshot,
            sequence: None,
        })
    }

    fn project_v2_messages(
        values: &[Value],
    ) -> Result<Vec<AgentTranscriptMessage>, OpenCodeTranscriptError> {
        let mut ids = HashSet::new();
        let mut messages = Vec::new();
        for value in values {
            let id = nonempty(value.get("id")).ok_or(OpenCodeTranscriptError::InvalidSnapshot)?;
            if !ids.insert(id) {
                return Err(OpenCodeTranscriptError::InvalidSnapshot);
            }
            if let Some(message) = message(value)? {
                messages.push(message);
            }
        }
        Ok(messages)
    }

    fn apply_v2_projected(
        &mut self,
        info: Value,
        messages: Vec<AgentTranscriptMessage>,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let info = info
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
        details: provider_details(value, false),
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
        "idle" => {
            let outcome = match value.get("outcome").and_then(Value::as_str) {
                Some("succeeded") => AgentTurnOutcome::Completed,
                Some("interrupted") => AgentTurnOutcome::Interrupted,
                Some("failed") => AgentTurnOutcome::Failed,
                _ => return Ok(None),
            };
            result.completed_at_ms = created;
            result.details = Some(AgentTranscriptDetails {
                outcome: Some(outcome),
                ..Default::default()
            });
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
