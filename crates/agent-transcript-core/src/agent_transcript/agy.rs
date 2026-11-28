//! Antigravity CLI persists conversation steps in JSONL. Compaction can replay
//! or reorder steps, so the last record for each step index owns its contents.
mod tools;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::content::{MAX_BLOCKS, bounded, input_fields, string};
use super::file_session::{JsonlSessionCore, JsonlTranscriptAdapter};
use super::metadata::tool_input_json;
use super::model::{
    AgentCacheError, AgentMessageRole, AgentNoticeLevel, AgentTokenUsage, AgentToolState,
    AgentToolStatus, AgentTranscriptDetails, AgentTranscriptInfo, AgentTranscriptKind,
    AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptState, AgentTranscriptStatus,
    AgentTurnOutcome, AgentTurnStatus,
};
use super::projection::{project_turns, questions_from_input, timestamp_ms, user_prompt_parts};

pub type AgySessionCore = JsonlSessionCore<AgyTranscriptAdapter>;

/// Each sibling log has its own unfinished line and may repeat a step.
#[derive(Default, Debug)]
pub struct AgyLog {
    framer: super::jsonl::TranscriptJsonlFramer,
    steps: BTreeMap<u64, Option<Step>>,
}

impl AgyLog {
    pub fn ingest(&mut self, bytes: &[u8]) -> Result<(), super::jsonl::TranscriptParseError> {
        for line in self.framer.push(bytes)? {
            if let Ok(value) = line.parsed
                && let Some(index) = value["step_index"].as_u64()
            {
                self.steps.insert(index, parse_step(&value, index));
            }
        }
        Ok(())
    }
}

impl AgySessionCore {
    /// Publish both verified logs in one revision. The full log wins collisions.
    pub fn publish_logs(
        &mut self,
        compact: &AgyLog,
        full: &AgyLog,
        settled: bool,
    ) -> Option<super::model::AgentTranscriptUpdate> {
        let mut adapter = AgyTranscriptAdapter::new(self.adapter.session_id.clone());
        adapter.settled = settled;
        for (index, step) in compact
            .steps
            .iter()
            .filter(|(i, _)| !full.steps.contains_key(i))
            .chain(&full.steps)
        {
            if let Some(step) = step {
                adapter.steps.insert(*index, step.clone());
            }
        }
        self.publish_snapshot(adapter)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum Step {
    Message(Box<AgentTranscriptMessage>),
    TaskFinished {
        task: String,
        output: String,
        cancelled: bool,
        at: Option<u64>,
    },
    TasksStopped {
        at: Option<u64>,
    },
    ToolResult {
        tool: String,
        #[serde(default)]
        started_at: Option<u64>,
        output: Option<String>,
        error: Option<String>,
        at: Option<u64>,
        status: AgentToolStatus,
    },
}

fn task_report(content: &str, at: Option<u64>) -> Option<Step> {
    let envelope = content.split_once("[Message] ")?.1;
    let (header, report) = envelope.split_once(" content=")?;
    let sender = header
        .split_ascii_whitespace()
        .find_map(|s| s.strip_prefix("sender="))?;
    if sender == "system" && report.starts_with("[Notice] All your subagents and background tasks have been stopped due to server restart") {
        return Some(Step::TasksStopped { at });
    }
    let (task, result) = report.strip_prefix("Task id \"")?.split_once("\" ")?;
    if task != sender {
        return None;
    }
    let (cancelled, output) = result
        .strip_prefix("finished with result:")
        .map(|s| (false, s))
        .or_else(|| {
            result
                .strip_prefix("was canceled with result:")
                .map(|s| (true, s))
        })?;
    let output = output
        .trim()
        .strip_suffix("</SYSTEM_MESSAGE>")
        .unwrap_or(output)
        .trim();
    Some(Step::TaskFinished {
        task: bounded(task),
        output: bounded(output),
        at,
        cancelled,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgyTranscriptAdapter {
    session_id: String,
    steps: BTreeMap<u64, Step>,
    #[serde(default)]
    settled: bool,
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
    let decoded = args
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let args = decoded.as_ref().or(args);
    let input = args.map(input_fields).unwrap_or_default();
    let questions = questions_from_input(&input);
    AgentTranscriptPart::Tool {
        call_id: id.clone(),
        id,
        tool,
        timestamp_ms: at,
        state: AgentToolState {
            status: AgentToolStatus::Running,
            input,
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
            questions,
            viewed_images: vec![],
        },
    }
}

fn missing_result(part: &mut AgentTranscriptPart) {
    if let AgentTranscriptPart::Tool {
        id,
        tool,
        state,
        timestamp_ms,
        ..
    } = part
    {
        *part = AgentTranscriptPart::Notice {
            id: id.clone(),
            level: AgentNoticeLevel::Info,
            text: format!("{tool}: no result recorded"),
            summary: state.input_json.take(),
            questions: std::mem::take(&mut state.questions),
            timestamp_ms: *timestamp_ms,
        };
    }
}

fn finish_background(
    part: &mut AgentTranscriptPart,
    output: &str,
    cancelled: bool,
    at: Option<u64>,
) {
    if let AgentTranscriptPart::Tool { state, .. } = part {
        state.output = Some(output.to_owned());
        state.error = cancelled.then(|| output.to_owned());
        state.status = if cancelled {
            AgentToolStatus::Error
        } else {
            AgentToolStatus::Completed
        };
        state.completed_at_ms = at;
        state.duration_ms = state
            .started_at_ms
            .zip(at)
            .map(|(start, end)| end.saturating_sub(start));
    }
}

fn usage(record: &Value) -> Option<AgentTokenUsage> {
    let cache_read = record["cache_read_tokens"].as_u64();
    let input = record["input_tokens"]
        .as_u64()
        .map(|n| n.saturating_add(cache_read.unwrap_or(0)));
    let output = record["output_tokens"].as_u64();
    let usage = AgentTokenUsage {
        input,
        output,
        cache_read,
        total: input.zip(output).map(|(a, b)| a.saturating_add(b)),
        ..Default::default()
    };
    (usage != AgentTokenUsage::default()).then_some(usage)
}

fn parse_step(record: &Value, index: u64) -> Option<Step> {
    let id = format!("agy:{index}");
    let at = timestamp_ms(record.get("created_at"));
    let kind = record["type"].as_str()?;
    let mut parts = Vec::new();
    let mut details = None;
    let mut error = None;
    let role = match kind {
        "USER_INPUT" if record["source"] == "SYSTEM_SDK" => {
            parts.push(AgentTranscriptPart::Notice {
                id: format!("{id}:hook"),
                level: AgentNoticeLevel::Info,
                text: "Hook message".into(),
                summary: user_request(record["content"].as_str()?),
                timestamp_ms: at,
                questions: Vec::new(),
            });
            AgentMessageRole::Assistant
        }
        "USER_INPUT" => {
            let text = user_request(record["content"].as_str()?)?;
            parts = user_prompt_parts(&id, &text, at);
            AgentMessageRole::User
        }
        "SYSTEM_MESSAGE" => return task_report(record["content"].as_str()?, at),
        "PLANNER_RESPONSE" if record["source"] == "MODEL" || record.get("source").is_none() => {
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
            details = Some(AgentTranscriptDetails {
                model: string(record, "model"),
                outcome: (record["status"] == "DONE"
                    && record["tool_calls"].as_array().is_none_or(Vec::is_empty)
                    && string(record, "content").is_some())
                .then_some(AgentTurnOutcome::Completed),
                usage: usage(record),
                ..Default::default()
            });
            if parts.is_empty() {
                return None;
            }
            AgentMessageRole::Assistant
        }
        "CHECKPOINT" => {
            let mut message =
                AgentTranscriptMessage::context_compaction(&id, string(record, "content"), at);
            message.details = usage(record).map(|usage| AgentTranscriptDetails {
                usage: Some(usage),
                ..Default::default()
            });
            return Some(Step::Message(Box::new(message)));
        }
        "CANCELLED" | "CANCELED" | "ERROR_MESSAGE" => {
            let interrupted = matches!(kind, "CANCELLED" | "CANCELED")
                || record["error"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("The stream was interrupted."))
                || matches!(record["status"].as_str(), Some("CANCELED" | "CANCELLED"));
            details = Some(AgentTranscriptDetails {
                outcome: Some(if interrupted {
                    AgentTurnOutcome::Interrupted
                } else {
                    AgentTurnOutcome::Failed
                }),
                ..Default::default()
            });
            let text = string(record, "error")
                .or_else(|| string(record, "content"))
                .or_else(|| interrupted.then(|| "Interrupted".into()))?;
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
                _ if string(record, "error").is_some() => AgentToolStatus::Error,
                Some("ERROR" | "CANCELED" | "CANCELLED") => AgentToolStatus::Error,
                Some("RUNNING") => AgentToolStatus::Running,
                Some("DONE") => AgentToolStatus::Completed,
                _ => AgentToolStatus::Pending,
            };
            return Some(Step::ToolResult {
                tool: kind.to_ascii_lowercase(),
                started_at: at,
                status,
                error: (status == AgentToolStatus::Error).then(|| {
                    string(record, "error")
                        .or_else(|| output.clone())
                        .unwrap_or_else(|| "Tool failed".into())
                }),
                at: output.as_deref().and_then(|s| {
                    let line = s.lines().nth(1)?.strip_prefix("Completed At: ")?;
                    chrono::DateTime::parse_from_rfc3339(line.trim())
                        .ok()?
                        .timestamp_millis()
                        .try_into()
                        .ok()
                }),
                output,
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
    const CACHE_VERSION: u32 = 2;

    fn supports_cache(version: u32) -> bool {
        matches!(version, 1 | 2)
    }

    fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            steps: BTreeMap::new(),
            settled: false,
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
                _ => None,
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
        let mut pending = BTreeMap::<u64, (usize, usize)>::new();
        let mut background = BTreeMap::<&str, (usize, usize)>::new();
        let mut parent = None;
        for (index, step) in &self.steps {
            match step {
                Step::TaskFinished {
                    task,
                    output,
                    cancelled,
                    at,
                } => {
                    if let Some((mi, pi)) = background.remove(task.as_str()) {
                        finish_background(&mut messages[mi].parts[pi], output, *cancelled, *at);
                    }
                }
                Step::TasksStopped { at } => {
                    for (_, (mi, pi)) in std::mem::take(&mut background) {
                        finish_background(
                            &mut messages[mi].parts[pi],
                            "Stopped by server restart",
                            true,
                            *at,
                        );
                    }
                }
                Step::Message(message) => {
                    let mut message = message.as_ref().clone();
                    for (_, (mi, pi)) in std::mem::take(&mut pending) {
                        missing_result(&mut messages[mi].parts[pi]);
                    }
                    if message.role == AgentMessageRole::User {
                        parent = Some(message.id.clone());
                    } else {
                        message.parent_id.clone_from(&parent);
                    }
                    for (part_index, part) in message.parts.iter().enumerate() {
                        if let AgentTranscriptPart::Tool { id, .. } = part
                            && let Some(slot) =
                                id.rsplit(':').next().and_then(|s| s.parse::<u64>().ok())
                            && let Some(result_index) =
                                index.checked_add(1).and_then(|n| n.checked_add(slot))
                        {
                            pending.insert(result_index, (messages.len(), part_index));
                        }
                    }
                    messages.push(message);
                }
                Step::ToolResult {
                    tool,
                    started_at,
                    output,
                    error,
                    at,
                    status,
                } => {
                    let (mi, pi) = if let Some(position) = pending.remove(index) {
                        position
                    } else {
                        if tool == "generic" && output.is_none() && error.is_none() {
                            continue;
                        }
                        let id = format!("agy:{index}");
                        let part = tool_call(format!("{id}:tool"), tool.clone(), None, *started_at);
                        messages.push(AgentTranscriptMessage {
                            id,
                            role: AgentMessageRole::Assistant,
                            parent_id: parent.clone(),
                            created_at_ms: *started_at,
                            completed_at_ms: *at,
                            error: None,
                            parts: vec![part],
                            diffs: vec![],
                            details: None,
                        });
                        (messages.len() - 1, 0)
                    };
                    let message = &mut messages[mi];
                    if let AgentTranscriptPart::Tool {
                        state, tool, id, ..
                    } = &mut message.parts[pi]
                    {
                        state.output.clone_from(output);
                        state.error.clone_from(error);
                        state.status = *status;
                        state.started_at_ms = started_at.or(state.started_at_ms);
                        if *status == AgentToolStatus::Running
                            && let Some(task) = output.as_deref().and_then(|s| {
                                s.lines().find_map(|line| {
                                    line.trim().strip_prefix(
                                        "Tool is running as a background task with task id: ",
                                    )
                                })
                            })
                        {
                            background.insert(task.trim(), (mi, pi));
                        }
                        state.completed_at_ms =
                            matches!(status, AgentToolStatus::Completed | AgentToolStatus::Error)
                                .then_some(*at)
                                .flatten();
                        state.duration_ms = state
                            .started_at_ms
                            .zip(state.completed_at_ms)
                            .map(|(start, end)| end.saturating_sub(start));
                        if *status == AgentToolStatus::Completed {
                            let plan = tools::project_success(tool, state, id);
                            message.diffs.extend(state.files.iter().cloned());
                            if let Some(plan) = plan {
                                message.parts.push(plan);
                            }
                        }
                    }
                }
            }
        }
        if self.settled {
            for (_, (mi, pi)) in pending {
                missing_result(&mut messages[mi].parts[pi]);
            }
        }
        let mut turns = project_turns(&messages);
        if let Some(turn) = turns.last_mut()
            && turn.assistant_message_ids.is_empty()
            && !self.settled
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
