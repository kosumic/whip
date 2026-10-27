//! Pi's persisted session tree, projected into neutral chat messages.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::content::{MAX_BLOCKS, bounded, input_fields, result_text, string};
use super::file_session::{JsonlSessionCore, JsonlTranscriptAdapter};
use super::metadata::tool_input_json;
use super::model::{
    AgentCacheError, AgentFileDiff, AgentMessageRole, AgentNoticeLevel, AgentTokenUsage,
    AgentToolState, AgentToolStatus, AgentTranscriptDetails, AgentTranscriptInfo,
    AgentTranscriptKind, AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptState,
    AgentTranscriptStatus, AgentTurnOutcome, AgentTurnStatus,
};
use super::projection::{
    canonical_tool_input, normalize_user_images, project_turns, questions_from_input, timestamp_ms,
};

pub type PiSessionCore = JsonlSessionCore<PiTranscriptAdapter>;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ToolResult {
    call_id: String,
    output: Option<String>,
    failed: bool,
    timestamp: Option<u64>,
    diff: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PiNode {
    id: String,
    parent: Option<String>,
    order: u64,
    message: Option<AgentTranscriptMessage>,
    result: Option<ToolResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PiTranscriptAdapter {
    session_id: String,
    nodes: Vec<PiNode>,
    info: AgentTranscriptInfo,
    header_matches: bool,
    #[serde(skip)]
    indexes: HashMap<String, usize>,
}

fn tool_part(id: String, block: &Value, at: Option<u64>) -> Option<AgentTranscriptPart> {
    let call_id = string(block, "id")?;
    let tool = string(block, "name")?;
    let input = canonical_tool_input(&tool, input_fields(&block["arguments"]));
    Some(AgentTranscriptPart::Tool {
        id,
        call_id,
        tool,
        timestamp_ms: at,
        state: AgentToolState {
            status: AgentToolStatus::Running,
            input_json: tool_input_json(block.get("arguments")),
            questions: questions_from_input(&input),
            input,
            output: None,
            error: None,
            title: string(&block["arguments"], "description"),
            started_at_ms: at,
            completed_at_ms: None,
            duration_ms: None,
            exit_code: None,
            files: Vec::new(),
            diagnostics: Vec::new(),
            loaded: Vec::new(),
        },
    })
}

fn details(message: &Value) -> AgentTranscriptDetails {
    let usage = message.get("usage").map(|usage| {
        let read = usage["cacheRead"].as_u64();
        let write = usage["cacheWrite"].as_u64();
        AgentTokenUsage {
            input: usage["input"].as_u64().map(|input| {
                input
                    .saturating_add(read.unwrap_or(0))
                    .saturating_add(write.unwrap_or(0))
            }),
            output: usage["output"].as_u64(),
            reasoning: usage["reasoning"].as_u64(),
            cache_read: read,
            cache_write: write,
            total: usage["totalTokens"].as_u64(),
        }
    });
    AgentTranscriptDetails {
        model: string(message, "model"),
        provider: string(message, "provider"),
        usage,
        usage_id: string(message, "responseId"),
        outcome: match message["stopReason"].as_str() {
            Some("stop" | "length") => Some(AgentTurnOutcome::Completed),
            Some("aborted") => Some(AgentTurnOutcome::Interrupted),
            Some("error") => Some(AgentTurnOutcome::Failed),
            _ => None,
        },
    }
}

fn project_message(record: &Value, id: &str) -> Option<AgentTranscriptMessage> {
    let message = &record["message"];
    let role = match message["role"].as_str()? {
        "user" => AgentMessageRole::User,
        "assistant" => AgentMessageRole::Assistant,
        _ => return None,
    };
    let at =
        timestamp_ms(message.get("timestamp")).or_else(|| timestamp_ms(record.get("timestamp")));
    let mut parts = Vec::new();
    match &message["content"] {
        Value::String(text) if !text.trim().is_empty() => parts.push(AgentTranscriptPart::Text {
            id: format!("{id}:text"),
            text: bounded(text),
            timestamp_ms: at,
        }),
        Value::Array(blocks) => {
            for (index, block) in blocks.iter().take(MAX_BLOCKS).enumerate() {
                let id = format!("{id}:{index}");
                let part = match block["type"].as_str() {
                    Some("text") => string(block, "text").map(|text| AgentTranscriptPart::Text {
                        id,
                        text,
                        timestamp_ms: at,
                    }),
                    Some("thinking")
                        if role == AgentMessageRole::Assistant && block["redacted"] != true =>
                    {
                        string(block, "thinking").map(|text| AgentTranscriptPart::Reasoning {
                            id,
                            text,
                            timestamp_ms: at,
                        })
                    }
                    Some("toolCall") if role == AgentMessageRole::Assistant => {
                        tool_part(id, block, at)
                    }
                    Some("image") if role == AgentMessageRole::User => block["mimeType"]
                        .as_str()
                        .zip(block["data"].as_str())
                        .filter(|(mime, data)| mime.starts_with("image/") && !data.is_empty())
                        .map(|(mime, data)| AgentTranscriptPart::Image {
                            id,
                            source: format!("data:{mime};base64,{data}"),
                            timestamp_ms: at,
                        }),
                    _ => None,
                };
                parts.extend(part);
            }
        }
        _ => {}
    }
    let details = (role == AgentMessageRole::Assistant).then(|| details(message));
    let outcome = details.as_ref().and_then(|details| details.outcome);
    let error = (outcome == Some(AgentTurnOutcome::Failed))
        .then(|| string(message, "errorMessage").unwrap_or_else(|| "Pi request failed".into()));
    if matches!(
        outcome,
        Some(AgentTurnOutcome::Failed | AgentTurnOutcome::Interrupted)
    ) {
        parts.push(AgentTranscriptPart::Notice {
            id: format!("{id}:notice"),
            level: if error.is_some() {
                AgentNoticeLevel::Error
            } else {
                AgentNoticeLevel::Warning
            },
            text: error
                .clone()
                .unwrap_or_else(|| "Request interrupted".into()),
            timestamp_ms: at,
            questions: Vec::new(),
        });
    }
    if parts.is_empty()
        && details
            .as_ref()
            .is_none_or(|details| details.usage.is_none())
    {
        return None;
    }
    let mut message = AgentTranscriptMessage {
        id: id.to_owned(),
        role,
        parent_id: None,
        created_at_ms: at,
        completed_at_ms: (role == AgentMessageRole::Assistant)
            .then_some(at)
            .flatten(),
        error,
        parts,
        diffs: Vec::new(),
        details,
    };
    normalize_user_images(&mut message);
    Some(message)
}

impl JsonlTranscriptAdapter for PiTranscriptAdapter {
    const AGENT: AgentTranscriptKind = AgentTranscriptKind::Pi;
    const CACHE_VERSION: u32 = 1;

    fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        Self {
            info: AgentTranscriptInfo {
                id: session_id.clone(),
                title: None,
                directory: None,
                created_at_ms: None,
                updated_at_ms: None,
            },
            session_id,
            nodes: Vec::new(),
            indexes: HashMap::new(),
            header_matches: false,
        }
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn accept(&mut self, record: &Value, order: u64) {
        if record["type"] == "session" {
            // Herdr reports either the session ID or its authoritative absolute
            // path. A path also supports Pi's --session-dir and SDK locations.
            self.header_matches = record["id"].as_str().is_some_and(|id| {
                !id.is_empty() && (self.session_id.starts_with('/') || id == self.session_id)
            });
            if self.header_matches {
                self.info.directory = string(record, "cwd");
                self.info.created_at_ms = timestamp_ms(record.get("timestamp"));
            }
            return;
        }
        if !self.header_matches {
            return;
        }
        let Some(id) = string(record, "id") else {
            return;
        };
        if record["type"] == "session_info" {
            self.info.title = record["name"]
                .as_str()
                .and_then(super::title::session_title);
        }
        let message = (record["type"] == "message")
            .then(|| project_message(record, &id))
            .flatten();
        let raw = &record["message"];
        let result = (record["type"] == "message" && raw["role"] == "toolResult")
            .then(|| {
                string(raw, "toolCallId").map(|call_id| ToolResult {
                    call_id,
                    output: result_text(&raw["content"]),
                    failed: raw["isError"] == true,
                    timestamp: timestamp_ms(raw.get("timestamp"))
                        .or_else(|| timestamp_ms(record.get("timestamp"))),
                    diff: string(&raw["details"], "patch").or_else(|| {
                        string(&raw["details"], "diff")
                            .filter(|diff| diff.starts_with("@@ ") || diff.starts_with("--- "))
                    }),
                })
            })
            .flatten();
        let node = PiNode {
            id: id.clone(),
            parent: string(record, "parentId"),
            order,
            message,
            result,
        };
        if let Some(index) = self.indexes.get(&id).copied() {
            self.nodes[index] = node;
        } else {
            self.indexes.insert(id, self.nodes.len());
            self.nodes.push(node);
        }
        self.info.updated_at_ms = timestamp_ms(record.get("timestamp"));
    }

    fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        // Pi resumes from the last persisted entry. Metadata nodes participate
        // in ancestry even when they have no visible message.
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = self.nodes.iter().max_by_key(|node| node.order);
        while let Some(node) = current {
            if !seen.insert(&node.id) {
                break;
            }
            chain.push(node);
            current = node
                .parent
                .as_ref()
                .and_then(|id| self.indexes.get(id))
                .map(|index| &self.nodes[*index]);
        }
        chain.reverse();
        let mut messages = Vec::<AgentTranscriptMessage>::new();
        let mut tools = HashMap::<String, (usize, usize)>::new();
        let mut parent = None;
        for node in chain {
            if let Some(message) = &node.message {
                let mut message = message.clone();
                if message.role == AgentMessageRole::User {
                    parent = Some(message.id.clone());
                } else {
                    message.parent_id.clone_from(&parent);
                }
                for (index, part) in message.parts.iter().enumerate() {
                    if let AgentTranscriptPart::Tool { call_id, .. } = part {
                        tools.insert(call_id.clone(), (messages.len(), index));
                    }
                }
                messages.push(message);
            }
            if let Some(result) = &node.result
                && let Some(&(mi, pi)) = tools.get(&result.call_id)
                && let AgentTranscriptPart::Tool { state, .. } = &mut messages[mi].parts[pi]
            {
                state.status = if result.failed {
                    AgentToolStatus::Error
                } else {
                    AgentToolStatus::Completed
                };
                state.output.clone_from(&result.output);
                state.error = result.failed.then(|| {
                    result
                        .output
                        .clone()
                        .unwrap_or_else(|| "Tool failed".into())
                });
                state.completed_at_ms = result.timestamp;
                state.duration_ms = state
                    .started_at_ms
                    .zip(result.timestamp)
                    .map(|(start, end)| end.saturating_sub(start));
                if let Some(diff) = &result.diff
                    && let Some(path) = state.input.iter().find(|field| field.key == "path")
                    && let super::model::AgentScalarValue::String { value } = &path.value
                {
                    state.files = vec![AgentFileDiff::normalized(
                        value.clone(),
                        Some(diff.clone()),
                        None,
                        None,
                        None,
                        None,
                    )];
                }
            }
        }
        let mut turns = project_turns(&messages);
        if let Some(turn) = turns.last_mut()
            && turn.assistant_message_ids.is_empty()
        {
            turn.status = AgentTurnStatus::Working;
        }
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: Self::AGENT,
            revision,
            status,
            error,
            info: Some(self.info.clone()),
            messages,
            turns,
        }
    }

    fn restore(&mut self, offset: u64) -> Result<(), AgentCacheError> {
        for (index, node) in self.nodes.iter_mut().enumerate() {
            if node.order > offset || self.indexes.insert(node.id.clone(), index).is_some() {
                return Err(AgentCacheError::Malformed(
                    "invalid Pi node offsets/IDs".into(),
                ));
            }
            if let Some(message) = &mut node.message {
                normalize_user_images(message);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
