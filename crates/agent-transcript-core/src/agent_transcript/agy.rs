//! Antigravity CLI persists conversation steps in JSONL. Compaction can replay
//! or reorder steps, so the last record for each step index owns its contents.
use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::content::{MAX_BLOCKS, bounded, input_fields, string};
use super::file_session::{JsonlSessionCore, JsonlTranscriptAdapter};
use super::metadata::tool_input_json;
use super::model::{
    AgentCacheError, AgentMessageRole, AgentNoticeLevel, AgentTokenUsage, AgentToolState,
    AgentToolStatus, AgentTranscriptDetails, AgentTranscriptInfo, AgentTranscriptKind,
    AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptState, AgentTranscriptStatus,
    AgentTurnStatus,
};
use super::projection::{project_turns, timestamp_ms, user_prompt_parts};

pub type AgySessionCore = JsonlSessionCore<AgyTranscriptAdapter>;

#[derive(Clone, Debug, Serialize, Deserialize)]
enum Step {
    Message(Box<AgentTranscriptMessage>),
    ToolResult {
        tool: String,
        output: Option<String>,
        error: Option<String>,
        at: Option<u64>,
        status: AgentToolStatus,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgyTranscriptAdapter {
    session_id: String,
    steps: BTreeMap<u64, Step>,
}

fn user_request(content: &str) -> Option<String> {
    let body = match content.split_once("<USER_REQUEST>") {
        Some((_, request)) => request
            .split_once("</USER_REQUEST>")
            .map_or(request, |(text, _)| text),
        None => content
            .split("<ADDITIONAL_METADATA>")
            .next()?
            .split("<USER_SETTINGS_CHANGE>")
            .next()?,
    }
    .trim();
    (!body.is_empty()).then(|| bounded(body))
}

fn tool_call(
    id: String,
    tool: String,
    args: Option<&Value>,
    at: Option<u64>,
) -> AgentTranscriptPart {
    AgentTranscriptPart::Tool {
        call_id: id.clone(),
        id,
        tool,
        timestamp_ms: at,
        state: AgentToolState {
            status: AgentToolStatus::Running,
            input: args.map(input_fields).unwrap_or_default(),
            input_json: tool_input_json(args),
            started_at_ms: at,
            completed_at_ms: None,
            duration_ms: None,
            output: None,
            error: None,
            title: None,
            exit_code: None,
            files: vec![],
            diagnostics: vec![],
            loaded: vec![],
            questions: vec![],
            viewed_images: vec![],
        },
    }
}

fn parse_step(record: &Value, index: u64) -> Option<Step> {
    let id = format!("agy:{index}");
    let at = timestamp_ms(record.get("created_at"));
    let kind = record["type"].as_str()?;
    let mut parts = Vec::new();
    let mut details = None;
    let mut error = None;
    let role = match kind {
        "USER_INPUT" => {
            let text = user_request(record["content"].as_str()?)?;
            parts = user_prompt_parts(&id, &text, at);
            AgentMessageRole::User
        }
        "PLANNER_RESPONSE" if record["source"] == "MODEL" => {
            if let Some(text) = string(record, "thinking") {
                parts.push(AgentTranscriptPart::Reasoning {
                    id: format!("{id}:thinking"),
                    text,
                    timestamp_ms: at,
                });
            }
            if let Some(text) = string(record, "content") {
                parts.push(AgentTranscriptPart::Text {
                    id: format!("{id}:text"),
                    text,
                    timestamp_ms: at,
                });
            }
            if let Some(calls) = record["tool_calls"].as_array() {
                for (i, call) in calls.iter().take(MAX_BLOCKS).enumerate() {
                    if let Some(name) = string(call, "name") {
                        parts.push(tool_call(
                            format!("{id}:tool:{i}"),
                            name,
                            call.get("args"),
                            at,
                        ));
                    }
                }
            }
            let usage = AgentTokenUsage {
                input: record["input_tokens"].as_u64(),
                output: record["output_tokens"].as_u64(),
                cache_read: record["cache_read_tokens"].as_u64(),
                ..Default::default()
            };
            details = Some(AgentTranscriptDetails {
                model: string(record, "model"),
                usage: (usage != AgentTokenUsage::default()).then_some(usage),
                ..Default::default()
            });
            if parts.is_empty() {
                return None;
            }
            AgentMessageRole::Assistant
        }
        "CHECKPOINT" => {
            return Some(Step::Message(Box::new(
                AgentTranscriptMessage::context_compaction(&id, string(record, "content"), at),
            )));
        }
        "ERROR_MESSAGE" => {
            let text = string(record, "error").or_else(|| string(record, "content"))?;
            error = Some(text.clone());
            parts.push(AgentTranscriptPart::Notice {
                id: format!("{id}:error"),
                text,
                level: AgentNoticeLevel::Error,
                summary: None,
                timestamp_ms: at,
                questions: vec![],
            });
            AgentMessageRole::Assistant
        }
        "RUN_COMMAND" | "VIEW_FILE" | "LIST_DIRECTORY" | "GREP_SEARCH" | "SEARCH_WEB"
        | "CODE_ACTION" | "GENERATE_IMAGE" | "INVOKE_SUBAGENT" | "ASK_QUESTION" | "GENERIC" => {
            let output = string(record, "content");
            let status = match record["status"].as_str() {
                Some("ERROR") => AgentToolStatus::Error,
                Some("RUNNING") => AgentToolStatus::Running,
                _ => AgentToolStatus::Completed,
            };
            return Some(Step::ToolResult {
                tool: kind.to_ascii_lowercase(),
                status,
                error: (status == AgentToolStatus::Error).then(|| {
                    string(record, "error")
                        .or_else(|| output.clone())
                        .unwrap_or_else(|| "Tool failed".into())
                }),
                output,
                at,
            });
        }
        _ => return None,
    };
    Some(Step::Message(Box::new(AgentTranscriptMessage {
        id,
        role,
        parts,
        details,
        error,
        parent_id: None,
        created_at_ms: at,
        completed_at_ms: (role == AgentMessageRole::Assistant && record["status"] != "RUNNING")
            .then_some(at)
            .flatten(),
        diffs: vec![],
    })))
}

impl JsonlTranscriptAdapter for AgyTranscriptAdapter {
    const AGENT: AgentTranscriptKind = AgentTranscriptKind::Agy;
    const CACHE_VERSION: u32 = 1;

    fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            steps: BTreeMap::new(),
        }
    }
    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn recent_message_refs(&self, limit: usize) -> Vec<&AgentTranscriptMessage> {
        let mut recent: Vec<_> = self
            .steps
            .values()
            .rev()
            .filter_map(|step| match step {
                Step::Message(message) => Some(message.as_ref()),
                Step::ToolResult { .. } => None,
            })
            .take(limit)
            .collect();
        recent.reverse();
        recent
    }

    fn accept(&mut self, record: &Value, _order: u64) {
        if let Some(index) = record["step_index"].as_u64() {
            if let Some(step) = parse_step(record, index) {
                self.steps.insert(index, step);
            } else {
                self.steps.remove(&index);
            }
        }
    }

    fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        let mut messages: Vec<AgentTranscriptMessage> = Vec::new();
        let mut pending: VecDeque<(usize, usize)> = VecDeque::new();
        let mut parent = None;
        for (index, step) in &self.steps {
            match step {
                Step::Message(message) => {
                    let mut message = message.as_ref().clone();
                    pending.clear();
                    if message.role == AgentMessageRole::User {
                        parent = Some(message.id.clone());
                    } else {
                        message.parent_id.clone_from(&parent);
                    }
                    for (part_index, part) in message.parts.iter().enumerate() {
                        if matches!(part, AgentTranscriptPart::Tool { .. }) {
                            pending.push_back((messages.len(), part_index));
                        }
                    }
                    messages.push(message);
                }
                Step::ToolResult {
                    tool,
                    output,
                    error,
                    at,
                    status,
                } => {
                    let part = if let Some((mi, pi)) = pending.pop_front() {
                        &mut messages[mi].parts[pi]
                    } else {
                        if tool == "generic" {
                            continue;
                        }
                        let id = format!("agy:{index}");
                        let part = tool_call(format!("{id}:tool"), tool.clone(), None, *at);
                        let message = messages.push_mut(AgentTranscriptMessage {
                            id,
                            role: AgentMessageRole::Assistant,
                            parent_id: parent.clone(),
                            created_at_ms: *at,
                            completed_at_ms: *at,
                            error: None,
                            parts: vec![part],
                            diffs: vec![],
                            details: None,
                        });
                        &mut message.parts[0]
                    };
                    if let AgentTranscriptPart::Tool { state, .. } = part {
                        state.output.clone_from(output);
                        state.error.clone_from(error);
                        state.status = *status;
                        state.completed_at_ms = (*status != AgentToolStatus::Running)
                            .then_some(*at)
                            .flatten();
                        state.duration_ms = state
                            .started_at_ms
                            .zip(state.completed_at_ms)
                            .map(|(start, end)| end.saturating_sub(start));
                    }
                }
            }
        }
        let mut turns = project_turns(&messages);
        if let Some(turn) = turns.last_mut()
            && turn.assistant_message_ids.is_empty()
        {
            turn.status = AgentTurnStatus::Working;
        }
        let info = AgentTranscriptInfo {
            id: self.session_id.clone(),
            directory: None,
            title: super::title::first_prompt_title(&messages),
            created_at_ms: messages.first().and_then(|m| m.created_at_ms),
            updated_at_ms: messages.last().and_then(|m| m.created_at_ms),
        };
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: Self::AGENT,
            revision,
            status,
            error,
            info: Some(info),
            messages,
            turns,
        }
    }

    fn restore(&mut self, _offset: u64) -> Result<(), AgentCacheError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agy_replays_steps_and_restores_a_partial_transcript()
    -> Result<(), Box<dyn std::error::Error>> {
        let prefix = concat!(
            r#"{"step_index":0,"type":"USER_INPUT","created_at":"2026-10-01T09:00:00Z","content":"<USER_REQUEST>Inspect the file</USER_REQUEST><ADDITIONAL_METADATA>workspace context</ADDITIONAL_METADATA>"}"#,
            "\n",
            r#"{"step_index":1,"type":"EPHEMERAL_MESSAGE","content":"System reminder"}"#,
            "\n",
            r#"{"step_index":2,"type":"PLANNER_RESPONSE","source":"MODEL","model":"gemini","tool_calls":[{"name":"read_file","args":{"Path":"notes.txt"}}]}"#,
            "\n",
        );
        let tail = concat!(
            r#"{"step_index":4,"type":"PLANNER_RESPONSE","source":"MODEL","content":"Draft"}"#,
            "\n",
            r#"{"step_index":3,"type":"VIEW_FILE","status":"DONE","content":"File contents"}"#,
            "\n",
            r#"{"step_index":4,"type":"PLANNER_RESPONSE","source":"MODEL","content":"Finished"}"#,
            "\n",
        );
        let mut core = AgySessionCore::new("session");
        let source = core.bind_source(
            "log".into(),
            "inode".into(),
            (prefix.len() + tail.len()) as u64,
        );
        core.ingest(source.source_generation, prefix.as_bytes())?;
        core.ingest(source.source_generation, &tail.as_bytes()[..17])?;
        let cache = core.cache_blob()?;
        let mut resumed = AgySessionCore::new("session");
        resumed.restore_cache(&cache)?;
        let source = resumed.bind_source(
            "log".into(),
            "inode".into(),
            (prefix.len() + tail.len()) as u64,
        );
        assert_eq!(source.start_offset, prefix.len() as u64);
        resumed.ingest(source.source_generation, tail.as_bytes())?;
        let state = resumed.state();
        assert_eq!(state.messages.len(), 3);
        assert_eq!(state.turns.len(), 1);
        assert_eq!(state.status, AgentTranscriptStatus::Live);
        assert_eq!(state.turns[0].status, AgentTurnStatus::Idle);
        assert!(
            matches!(&state.messages[0].parts[..], [AgentTranscriptPart::Text { text, .. }] if text == "Inspect the file")
        );
        assert!(
            matches!(&state.messages[1].parts[..], [AgentTranscriptPart::Tool { tool, state, .. }]
            if tool == "read_file" && state.status == AgentToolStatus::Completed && state.output.as_deref() == Some("File contents"))
        );
        assert!(
            matches!(&state.messages[2].parts[..], [AgentTranscriptPart::Text { text, .. }] if text == "Finished")
        );
        let offline = crate::decode_cached_transcript(
            AgentTranscriptKind::Agy,
            "session",
            &resumed.cache_blob()?,
        )?;
        assert_eq!(offline.messages, state.messages);
        Ok(())
    }
}
