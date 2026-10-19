//! Projection of current persisted Codex rollout records into Whip's neutral
//! transcript model. Only rollouts whose SessionMeta selects paginated history
//! enter this reducer; legacy streams continue through the legacy adapter.

use std::collections::HashMap;

use serde_json::Value;

use super::rollout_wire::{
    CommandExecution, Compacted, DynamicToolCall, Event, FileChange, FileChangeItem, ItemEvent,
    McpToolCall, ResponseItem, RolloutRecord, TurnAborted, TurnComplete, TurnItem, TurnStarted,
    decode_turn_item, interactive_response_notice, question_reply_text,
};
use crate::agent_transcript::{
    AgentField, AgentFileDiff, AgentMessageRole, AgentNoticeLevel, AgentScalarValue,
    AgentTokenUsage, AgentToolState, AgentToolStatus, AgentTranscriptDetails,
    AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptTurn, AgentTurnOutcome,
    AgentTurnStatus, CodexUsageTracker, canonical_tool_name, injected_user_context,
    question_tool_input, questions_from_input, tool_duration, tool_input, tool_input_json,
    transcript_questions, user_prompt_parts,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum ItemPhase {
    Started,
    Completed,
}

impl ItemPhase {
    fn tool_status(self, status: &str) -> AgentToolStatus {
        match self {
            Self::Started => AgentToolStatus::Running,
            Self::Completed => tool_status(status),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ProtocolDriftCounters {
    unsupported_rollout_types: u64,
    unsupported_event_types: u64,
    unsupported_turn_item_types: u64,
    unsupported_response_item_types: u64,
    last_unsupported_rollout_type: Option<String>,
    last_unsupported_event_type: Option<String>,
    last_unsupported_turn_item_type: Option<String>,
    last_unsupported_response_item_type: Option<String>,
}

#[derive(Clone, Debug)]
struct RawToolActivity {
    turn_id: String,
    part_id: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CodexRolloutReducer {
    model: Option<String>,
    provider: Option<String>,
    usage_tracker: CodexUsageTracker,
    messages: Vec<AgentTranscriptMessage>,
    message_indexes: HashMap<String, usize>,
    message_turns: HashMap<String, String>,
    turns: Vec<AgentTranscriptTurn>,
    turn_indexes: HashMap<String, usize>,
    active_turn_id: Option<String>,
    context_turn_id: Option<String>,
    raw_tool_activity: HashMap<String, RawToolActivity>,
    drift: ProtocolDriftCounters,
    dirty_messages: Vec<usize>,
    dirty_turns: Vec<usize>,
    messages_truncated_to: Option<usize>,
    turns_truncated_to: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CodexProjectionChanges {
    pub(crate) message_indexes: Vec<usize>,
    pub(crate) turn_indexes: Vec<usize>,
    pub(crate) messages_truncated_to: Option<usize>,
    pub(crate) turns_truncated_to: Option<usize>,
}

impl CodexRolloutReducer {
    pub(crate) fn resume_provider(&mut self, provider: Option<String>) {
        self.provider = provider;
    }

    pub(crate) fn messages(&self) -> &[AgentTranscriptMessage] {
        &self.messages
    }

    pub(crate) fn turns(&self) -> &[AgentTranscriptTurn] {
        &self.turns
    }

    pub(crate) fn accept(
        &mut self,
        record: &RolloutRecord,
        at: Option<u64>,
        sequence: u64,
    ) -> CodexProjectionChanges {
        match record {
            RolloutRecord::Event(event) => self.accept_event(event, at, sequence),
            RolloutRecord::TurnContext(context) => {
                if let Some(turn_id) = context.turn_id.as_ref().filter(|id| !id.is_empty()) {
                    self.context_turn_id = Some(turn_id.clone());
                }
                self.model.clone_from(&context.model);
                if let Some(turn_id) = context
                    .turn_id
                    .as_ref()
                    .or(self.active_turn_id.as_ref())
                    .cloned()
                {
                    let index = self.ensure_turn(&turn_id);
                    let details = self.turns[index]
                        .details
                        .get_or_insert_with(AgentTranscriptDetails::default);
                    details.model.clone_from(&self.model);
                    details.provider.clone_from(&self.provider);
                }
            }
            RolloutRecord::SessionMeta(meta) => self.provider.clone_from(&meta.model_provider),
            RolloutRecord::Compacted(compacted) => self.accept_compacted(compacted, at, sequence),
            RolloutRecord::Unknown { kind, value } => {
                self.drift.unsupported_rollout_types =
                    self.drift.unsupported_rollout_types.saturating_add(1);
                self.drift.last_unsupported_rollout_type = Some(kind.clone());
                let _ = value;
            }
            RolloutRecord::ResponseItem(item) => match item {
                ResponseItem::Known { value } => self.accept_raw_tool_activity(value, at),
                ResponseItem::Unknown { kind, value } => {
                    self.drift.unsupported_response_item_types =
                        self.drift.unsupported_response_item_types.saturating_add(1);
                    self.drift.last_unsupported_response_item_type = Some(kind.clone());
                    let _ = value;
                }
            },
            RolloutRecord::AppServerLike(_) | RolloutRecord::KnownIrrelevant => {}
        }
        self.take_changes()
    }

    fn take_changes(&mut self) -> CodexProjectionChanges {
        self.dirty_messages.sort_unstable();
        self.dirty_messages.dedup();
        self.dirty_turns.sort_unstable();
        self.dirty_turns.dedup();
        CodexProjectionChanges {
            message_indexes: std::mem::take(&mut self.dirty_messages),
            turn_indexes: std::mem::take(&mut self.dirty_turns),
            messages_truncated_to: self.messages_truncated_to.take(),
            turns_truncated_to: self.turns_truncated_to.take(),
        }
    }

    /// Raw calls supply live activity when Codex omits ItemStarted. Their IDs
    /// describe the outer call, not commands nested inside an exec script.
    /// Remove these temporary parts on output; ItemCompleted owns history.
    fn accept_raw_tool_activity(&mut self, value: &Value, at: Option<u64>) {
        let Some(call_id) = value["call_id"].as_str().filter(|id| !id.trim().is_empty()) else {
            return;
        };
        let kind = value["type"].as_str().unwrap_or_default();
        match kind {
            "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
                self.remove_raw_tool_activity(call_id);
                return;
            }
            "function_call" | "custom_tool_call" | "tool_search_call" => {}
            _ => return,
        }
        let Some(turn_id) = self.active_turn_id.clone() else {
            return;
        };
        let Some(name) = value["name"]
            .as_str()
            .or_else(|| value["execution"].as_str())
            .filter(|name| !name.trim().is_empty())
        else {
            return;
        };
        // A native lifecycle item with this exact ID already supplies activity.
        if self
            .assistant_part_message_index(&turn_id, call_id)
            .is_some()
        {
            return;
        }
        let raw = value.get("arguments").or_else(|| value.get("input"));
        // `exec` contains JavaScript and may invoke several unrelated tools.
        // Keep its recorded name rather than translating it into a shell call.
        let tool = if name == "exec" {
            name.to_owned()
        } else {
            canonical_tool_name(name)
        };
        let raw_part_id = format!("raw-tool:{call_id}");
        self.put_tool(
            &turn_id,
            raw_part_id.clone(),
            tool.clone(),
            AgentToolStatus::Running,
            tool_input(&tool, raw),
            None,
            None,
            None,
            Vec::new(),
            at,
            None,
        );
        // Keep original arguments available in the expandable row without
        // attempting to parse nested tool identities from executable code.
        if let Some(index) = self.assistant_part_message_index(&turn_id, &raw_part_id)
            && let Some(AgentTranscriptPart::Tool {
                call_id: projected_call_id,
                state,
                ..
            }) = self.messages[index]
                .parts
                .iter_mut()
                .find(|part| part_id(part) == raw_part_id)
        {
            call_id.clone_into(projected_call_id);
            state.input_json = tool_input_json(raw);
        }
        self.raw_tool_activity.insert(
            call_id.to_owned(),
            RawToolActivity {
                turn_id,
                part_id: raw_part_id,
            },
        );
    }

    fn remove_raw_tool_activity(&mut self, call_id: &str) {
        let Some(activity) = self.raw_tool_activity.remove(call_id) else {
            return;
        };
        if let Some(index) = self.assistant_part_message_index(&activity.turn_id, &activity.part_id)
        {
            self.messages[index]
                .parts
                .retain(|part| part_id(part) != activity.part_id);
            self.dirty_messages.push(index);
            self.ensure_turn(&activity.turn_id);
        }
    }

    fn clear_raw_tool_activity(&mut self, turn_id: &str) {
        let calls = self
            .raw_tool_activity
            .iter()
            .filter(|(_, activity)| activity.turn_id == turn_id)
            .map(|(call_id, _)| call_id.clone())
            .collect::<Vec<_>>();
        for call_id in calls {
            self.remove_raw_tool_activity(&call_id);
        }
    }

    fn accept_event(&mut self, event: &Event, at: Option<u64>, sequence: u64) {
        match event {
            Event::ItemStarted(item) => self.accept_item(item, ItemPhase::Started, at),
            Event::ItemCompleted(item) => self.accept_item(item, ItemPhase::Completed, at),
            Event::TurnStarted(started) => self.accept_turn_started(started, at),
            Event::TurnComplete(completed) => self.accept_turn_complete(completed, at),
            Event::TurnAborted(aborted) => self.accept_turn_aborted(aborted, at),
            Event::ThreadRolledBack(rollback) => self.rollback(rollback.num_turns),
            Event::Unknown { kind, value } => {
                self.drift.unsupported_event_types =
                    self.drift.unsupported_event_types.saturating_add(1);
                self.drift.last_unsupported_event_type = Some(kind.clone());
                let _ = value;
            }
            Event::Legacy(payload) => {
                if payload["type"] == "token_count" {
                    let usage = self.usage_tracker.accept(payload);
                    let turn_id = self
                        .active_turn_id
                        .clone()
                        .or_else(|| self.context_turn_id.clone())
                        .or_else(|| self.turns.last().map(|turn| turn.id.clone()));
                    if let (Some(usage), Some(turn_id)) = (usage, turn_id) {
                        let index = self.ensure_turn(&turn_id);
                        self.turns[index]
                            .details
                            .get_or_insert_with(AgentTranscriptDetails::default)
                            .usage
                            .get_or_insert_with(AgentTokenUsage::default)
                            .add(&usage);
                    }
                    return;
                }
                if let Some((text, questions)) =
                    payload.as_object().and_then(interactive_response_notice)
                    && let Some(turn_id) = payload
                        .get("turn_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .or_else(|| self.active_turn_id.clone())
                {
                    // This is a historical attention hint, not lifecycle state.
                    // Async questions can remain unanswered while work continues.
                    self.put_assistant_part(
                        &turn_id,
                        AgentTranscriptPart::Notice {
                            id: format!("notice:{sequence}"),
                            level: AgentNoticeLevel::Info,
                            text,
                            timestamp_ms: at,
                            questions,
                        },
                        at,
                        at,
                    );
                }
            }
            Event::KnownIrrelevant => {}
        }
    }

    fn accept_turn_started(&mut self, started: &TurnStarted, at: Option<u64>) {
        let turn_id = started.turn_id.clone();
        if let Some(previous) = self.active_turn_id.clone().filter(|id| id != &turn_id) {
            self.clear_raw_tool_activity(&previous);
        }
        let index = self.ensure_turn(&turn_id);
        let turn = &mut self.turns[index];
        turn.status = AgentTurnStatus::Working;
        turn.started_at_ms = seconds_to_millis(started.started_at)
            .or(at)
            .or(turn.started_at_ms);
        self.active_turn_id = Some(turn_id);
    }

    fn accept_turn_complete(&mut self, completed: &TurnComplete, at: Option<u64>) {
        self.clear_raw_tool_activity(&completed.turn_id);
        let index = self.ensure_turn(&completed.turn_id);
        let turn = &mut self.turns[index];
        turn.started_at_ms = seconds_to_millis(completed.started_at).or(turn.started_at_ms);
        turn.completed_at_ms = seconds_to_millis(completed.completed_at).or(at);
        if let Some(error) = &completed.error {
            turn.status = AgentTurnStatus::Error;
            turn.details
                .get_or_insert_with(AgentTranscriptDetails::default)
                .outcome = Some(AgentTurnOutcome::Failed);
            self.set_turn_error(&completed.turn_id, error.message.clone());
        } else if turn.status != AgentTurnStatus::Interrupted {
            turn.status = AgentTurnStatus::Idle;
            turn.details
                .get_or_insert_with(AgentTranscriptDetails::default)
                .outcome = Some(AgentTurnOutcome::Completed);
        }
        if self.active_turn_id.as_deref() == Some(&completed.turn_id) {
            self.active_turn_id = None;
        }
    }

    fn accept_turn_aborted(&mut self, aborted: &TurnAborted, at: Option<u64>) {
        let turn_id = aborted
            .turn_id
            .clone()
            .or_else(|| self.active_turn_id.clone());
        let Some(turn_id) = turn_id else {
            return;
        };
        self.clear_raw_tool_activity(&turn_id);
        let index = self.ensure_turn(&turn_id);
        let turn = &mut self.turns[index];
        turn.status = AgentTurnStatus::Interrupted;
        turn.details
            .get_or_insert_with(AgentTranscriptDetails::default)
            .outcome = Some(AgentTurnOutcome::Interrupted);
        turn.started_at_ms = seconds_to_millis(aborted.started_at).or(turn.started_at_ms);
        turn.completed_at_ms = seconds_to_millis(aborted.completed_at).or(at);
        if self.active_turn_id.as_deref() == Some(&turn_id) {
            self.active_turn_id = None;
        }
    }

    fn accept_item(&mut self, event: &ItemEvent, phase: ItemPhase, at: Option<u64>) {
        let item = decode_turn_item(event.item.clone());
        if phase == ItemPhase::Started
            && (event.thread_id.trim().is_empty()
                || event.turn_id.trim().is_empty()
                || !supported_tool_start(&item))
        {
            return;
        }
        let started_at = nonzero_millis(event.started_at_ms)
            .or_else(|| (phase == ItemPhase::Started).then_some(at).flatten());
        let completed_at = (phase == ItemPhase::Completed)
            .then(|| nonzero_millis(Some(event.completed_at_ms)))
            .flatten();
        let turn_index = self.ensure_turn(&event.turn_id);
        {
            let turn = &mut self.turns[turn_index];
            turn.started_at_ms = turn.started_at_ms.or(started_at);
            if turn.status == AgentTurnStatus::Idle
                && self.active_turn_id.as_deref() == Some(&turn.id)
            {
                turn.status = AgentTurnStatus::Working;
            }
        }
        match item {
            TurnItem::UserMessage(item) => {
                let text = item
                    .content
                    .iter()
                    .filter_map(|content| match content.kind.as_str() {
                        "text" => content.text.clone(),
                        "local_image" | "local_audio" => content.path.clone(),
                        "skill" | "mention" => content.name.clone(),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = question_reply_text(&text).unwrap_or(text);
                if !text.trim().is_empty() && !injected_user_context(&text) {
                    let id = item.id;
                    self.put_message(
                        &event.turn_id,
                        AgentTranscriptMessage {
                            details: None,
                            id: id.clone(),
                            role: AgentMessageRole::User,
                            parent_id: None,
                            created_at_ms: started_at.or(completed_at),
                            completed_at_ms: completed_at,
                            error: None,
                            parts: user_prompt_parts(&id, text.trim(), completed_at.or(started_at)),
                            diffs: Vec::new(),
                        },
                    );
                    let turn = &mut self.turns[turn_index];
                    if turn.user_message_id.is_none() {
                        turn.user_message_id = Some(id);
                    }
                }
            }
            TurnItem::AgentMessage(item) => {
                // Codex persists async question tool calls as AgentMessage items.
                // The Markdown content mirrors the structured questions; render
                // the question tool once, using the call ID retained by the item.
                if item.delivery.as_deref() == Some("async")
                    && !transcript_questions(Some(&item.questions)).is_empty()
                {
                    self.put_tool(
                        &event.turn_id,
                        item.id,
                        "request_user_input_async".to_owned(),
                        AgentToolStatus::Completed,
                        vec![string_field("questions", item.questions.to_string())],
                        None,
                        None,
                        None,
                        Vec::new(),
                        started_at,
                        completed_at,
                    );
                    return;
                }
                let _phase = item.phase.as_deref();
                let text = item
                    .content
                    .iter()
                    .filter(|content| content.kind == "Text")
                    .filter_map(|content| content.text.clone())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    self.put_assistant_part(
                        &event.turn_id,
                        AgentTranscriptPart::Text {
                            id: item.id,
                            text: text.trim().to_owned(),
                            timestamp_ms: completed_at.or(started_at),
                        },
                        started_at.or(completed_at),
                        completed_at,
                    );
                }
            }
            TurnItem::Plan(item) => {
                if !item.text.trim().is_empty() {
                    self.put_assistant_part(
                        &event.turn_id,
                        AgentTranscriptPart::Plan {
                            id: item.id,
                            text: item.text,
                            timestamp_ms: completed_at.or(started_at),
                        },
                        started_at.or(completed_at),
                        completed_at,
                    );
                }
            }
            TurnItem::Reasoning(item) => {
                // Raw reasoning is deliberately not part of Whip's projection.
                let _has_raw_content = !item.raw_content.is_empty();
                let text = item.summary_text.join("\n");
                if !text.trim().is_empty() {
                    self.put_assistant_part(
                        &event.turn_id,
                        AgentTranscriptPart::Reasoning {
                            id: item.id,
                            text,
                            timestamp_ms: completed_at.or(started_at),
                        },
                        started_at.or(completed_at),
                        completed_at,
                    );
                }
            }
            TurnItem::CommandExecution(item) => {
                self.accept_command(&event.turn_id, item, started_at, completed_at, phase);
            }
            TurnItem::FileChange(item) => {
                self.accept_file_change(&event.turn_id, item, started_at, completed_at, phase);
            }
            TurnItem::McpToolCall(item) => {
                self.accept_mcp_tool(&event.turn_id, item, started_at, completed_at, phase);
            }
            TurnItem::DynamicToolCall(item) => {
                self.accept_dynamic_tool(&event.turn_id, item, started_at, completed_at, phase);
            }
            TurnItem::WebSearch(item) => {
                let mut input = value_fields(&item.action);
                put_string_field(&mut input, "query", item.query);
                self.put_tool(
                    &event.turn_id,
                    item.id,
                    "websearch".to_owned(),
                    phase.tool_status("completed"),
                    input,
                    item.results.as_ref().and_then(json_detail),
                    None,
                    None,
                    Vec::new(),
                    started_at,
                    completed_at,
                );
            }
            TurnItem::ImageGeneration(item) => {
                let mut input = Vec::new();
                if let Some(prompt) = item.revised_prompt {
                    input.push(string_field("prompt", prompt));
                }
                if let Some(path) = item.saved_path.as_ref().and_then(value_text) {
                    input.push(string_field("saved_path", path));
                }
                let status = phase.tool_status(&item.status);
                self.put_tool(
                    &event.turn_id,
                    item.id,
                    "image_generation".to_owned(),
                    status,
                    input,
                    (!item.result.is_empty()).then_some(item.result),
                    (status == AgentToolStatus::Error)
                        .then(|| format!("Image generation {}", item.status)),
                    None,
                    Vec::new(),
                    started_at,
                    completed_at,
                );
            }
            TurnItem::ContextCompaction(item) => {
                self.put_assistant_part(
                    &event.turn_id,
                    AgentTranscriptPart::Notice {
                        id: item.id,
                        level: AgentNoticeLevel::Info,
                        text: "Context compacted".to_owned(),
                        timestamp_ms: completed_at.or(started_at),
                        questions: Vec::new(),
                    },
                    started_at.or(completed_at),
                    completed_at,
                );
            }
            TurnItem::Unknown { kind, value } => {
                self.drift.unsupported_turn_item_types =
                    self.drift.unsupported_turn_item_types.saturating_add(1);
                self.drift.last_unsupported_turn_item_type = Some(kind);
                let _ = value;
            }
            TurnItem::KnownIrrelevant => {}
        }
        self.update_tool_details(event);
    }

    fn update_tool_details(&mut self, event: &ItemEvent) {
        let input_json = tool_input_json(
            event
                .item
                .get("arguments")
                .or_else(|| event.item.get("input"))
                .or_else(|| event.item.get("action"))
                .or_else(|| event.item.get("changes")),
        );
        let duration_ms = tool_duration(&event.item);
        if let Some(id) = event.item.get("id").and_then(Value::as_str)
            && let Some(index) = self.assistant_part_message_index(&event.turn_id, id)
            && let Some(AgentTranscriptPart::Tool { state, .. }) = self.messages[index]
                .parts
                .iter_mut()
                .find(|part| part_id(part) == id)
        {
            if input_json.is_some() {
                state.input_json = input_json;
            }
            state.duration_ms = duration_ms.or(state.duration_ms);
            self.dirty_messages.push(index);
        }
    }

    fn accept_command(
        &mut self,
        turn_id: &str,
        item: CommandExecution,
        started_at: Option<u64>,
        completed_at: Option<u64>,
        phase: ItemPhase,
    ) {
        let mut input = vec![string_field("command", item.command.join(" "))];
        if let Some(cwd) = value_text(&item.cwd) {
            input.push(string_field("cwd", cwd));
        }
        if let Some(process_id) = item.process_id {
            input.push(string_field("process_id", process_id));
        }
        let output = item
            .aggregated_output
            .or_else(|| joined_output(item.stdout.as_deref(), item.stderr.as_deref()));
        let status = phase.tool_status(&item.status);
        let error = (status == AgentToolStatus::Error).then(|| {
            item.exit_code
                .map(|code| format!("Exited with code {code}"))
                .unwrap_or_else(|| format!("Command {}", item.status))
        });
        self.put_tool(
            turn_id,
            item.id,
            "shell".to_owned(),
            status,
            input,
            output,
            error,
            item.exit_code,
            Vec::new(),
            started_at,
            completed_at,
        );
    }

    fn accept_file_change(
        &mut self,
        turn_id: &str,
        item: FileChangeItem,
        started_at: Option<u64>,
        completed_at: Option<u64>,
        phase: ItemPhase,
    ) {
        let files = item
            .changes
            .into_iter()
            .map(|(file, change)| match change {
                FileChange::Add { content } => {
                    AgentFileDiff::normalized(file, None, None, Some(content), None, None)
                }
                FileChange::Delete { content } => {
                    AgentFileDiff::normalized(file, None, Some(content), None, None, None)
                }
                FileChange::Update {
                    unified_diff,
                    move_path,
                } => AgentFileDiff::normalized(
                    move_path.unwrap_or(file),
                    Some(unified_diff),
                    None,
                    None,
                    None,
                    None,
                ),
            })
            .collect::<Vec<_>>();
        let status_text = item.status.as_deref().unwrap_or("completed");
        let status = phase.tool_status(status_text);
        let output = joined_output(item.stdout.as_deref(), item.stderr.as_deref());
        self.put_tool(
            turn_id,
            item.id,
            "patch".to_owned(),
            status,
            Vec::new(),
            output.clone(),
            (status == AgentToolStatus::Error)
                .then(|| output.unwrap_or_else(|| format!("Patch {status_text}"))),
            None,
            files,
            started_at,
            completed_at,
        );
    }

    fn accept_mcp_tool(
        &mut self,
        turn_id: &str,
        item: McpToolCall,
        started_at: Option<u64>,
        completed_at: Option<u64>,
        phase: ItemPhase,
    ) {
        let status = phase.tool_status(&item.status);
        self.put_tool(
            turn_id,
            item.id,
            format!("{} · {}", item.server, item.tool),
            status,
            value_fields(&item.arguments),
            item.result.as_ref().and_then(json_detail),
            item.error.map(|error| error.message),
            None,
            Vec::new(),
            started_at,
            completed_at,
        );
    }

    fn accept_dynamic_tool(
        &mut self,
        turn_id: &str,
        item: DynamicToolCall,
        started_at: Option<u64>,
        completed_at: Option<u64>,
        phase: ItemPhase,
    ) {
        let status = if phase == ItemPhase::Completed && item.success == Some(false) {
            AgentToolStatus::Error
        } else {
            phase.tool_status(&item.status)
        };
        let name = item
            .namespace
            .map(|namespace| format!("{namespace} · {}", item.tool))
            .unwrap_or(item.tool);
        let output = item.content_items.as_deref().and_then(dynamic_output);
        self.put_tool(
            turn_id,
            item.id,
            name,
            status,
            value_fields(&item.arguments),
            output,
            item.error,
            None,
            Vec::new(),
            started_at,
            completed_at,
        );
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the reducer accepts the complete normalized Codex tool event as typed fields"
    )]
    fn put_tool(
        &mut self,
        turn_id: &str,
        id: String,
        tool: String,
        status: AgentToolStatus,
        input: Vec<AgentField>,
        output: Option<String>,
        error: Option<String>,
        exit_code: Option<i64>,
        files: Vec<AgentFileDiff>,
        started_at: Option<u64>,
        completed_at: Option<u64>,
    ) {
        self.remove_raw_tool_activity(&id);
        let previous = self
            .assistant_part_message_index(turn_id, &id)
            .and_then(|index| {
                self.messages[index]
                    .parts
                    .iter()
                    .find(|part| part_id(part) == id)
            })
            .and_then(|part| match part {
                AgentTranscriptPart::Tool { state, .. } => Some(state),
                _ => None,
            });
        // Replayed starts must not reopen an already completed tool.
        if matches!(status, AgentToolStatus::Pending | AgentToolStatus::Running)
            && previous.is_some_and(|state| {
                matches!(
                    state.status,
                    AgentToolStatus::Completed | AgentToolStatus::Error
                )
            })
        {
            return;
        }
        let started_at = started_at.or_else(|| previous.and_then(|state| state.started_at_ms));
        let input_json = previous.and_then(|state| state.input_json.clone());
        let duration_ms = completed_at
            .zip(started_at)
            .and_then(|(end, start)| end.checked_sub(start));
        let terminal = matches!(status, AgentToolStatus::Completed | AgentToolStatus::Error);
        let input = question_tool_input(&tool, input);
        let message_index = self.put_assistant_part(
            turn_id,
            AgentTranscriptPart::Tool {
                id: id.clone(),
                call_id: id,
                tool,
                timestamp_ms: started_at.or(completed_at),
                state: AgentToolState {
                    duration_ms,
                    input_json,
                    status,
                    questions: questions_from_input(&input),
                    input,
                    output,
                    error,
                    title: None,
                    started_at_ms: started_at,
                    completed_at_ms: terminal.then_some(completed_at).flatten(),
                    exit_code,
                    files: files.clone(),
                    diagnostics: Vec::new(),
                    loaded: Vec::new(),
                },
            },
            started_at.or(completed_at),
            terminal.then_some(completed_at).flatten(),
        );
        if !files.is_empty() {
            self.merge_turn_diffs(turn_id, message_index, &files);
        }
    }

    fn accept_compacted(&mut self, compacted: &Compacted, at: Option<u64>, sequence: u64) {
        // The persisted message is model context, not assistant-authored UI text.
        let _has_private_summary = !compacted.message.is_empty();
        let turn_id = self
            .active_turn_id
            .clone()
            .or_else(|| self.context_turn_id.clone());
        let Some(turn_id) = turn_id else {
            return;
        };
        self.put_assistant_part(
            &turn_id,
            AgentTranscriptPart::Notice {
                id: format!("compacted:{sequence}"),
                level: AgentNoticeLevel::Info,
                text: "Context compacted".to_owned(),
                timestamp_ms: at,
                questions: Vec::new(),
            },
            at,
            at,
        );
    }

    fn ensure_turn(&mut self, turn_id: &str) -> usize {
        if let Some(index) = self.turn_indexes.get(turn_id).copied() {
            self.dirty_turns.push(index);
            return index;
        }
        let index = self.turns.len();
        self.turns.push(AgentTranscriptTurn {
            details: None,
            id: turn_id.to_owned(),
            user_message_id: None,
            assistant_message_ids: Vec::new(),
            message_ids: Vec::new(),
            status: AgentTurnStatus::Idle,
            started_at_ms: None,
            completed_at_ms: None,
            diffs: Vec::new(),
        });
        self.turn_indexes.insert(turn_id.to_owned(), index);
        self.dirty_turns.push(index);
        index
    }

    fn put_message(&mut self, turn_id: &str, message: AgentTranscriptMessage) {
        if let Some(index) = self.message_indexes.get(&message.id).copied() {
            self.messages[index] = message;
            self.dirty_messages.push(index);
            return;
        }
        self.message_turns
            .insert(message.id.clone(), turn_id.to_owned());
        let turn_index = self.ensure_turn(turn_id);
        self.turns[turn_index].message_ids.push(message.id.clone());
        self.message_indexes
            .insert(message.id.clone(), self.messages.len());
        self.messages.push(message);
        self.dirty_messages.push(self.messages.len() - 1);
    }

    fn assistant_part_message_index(&self, turn_id: &str, id: &str) -> Option<usize> {
        let turn = self.turns.get(*self.turn_indexes.get(turn_id)?)?;
        turn.assistant_message_ids
            .iter()
            .filter_map(|message_id| self.message_indexes.get(message_id).copied())
            .find(|index| {
                self.messages[*index]
                    .parts
                    .iter()
                    .any(|part| part_id(part) == id)
            })
    }

    fn current_assistant_message_id(&self, turn_index: usize) -> String {
        let turn = &self.turns[turn_index];
        let last = turn
            .message_ids
            .last()
            .and_then(|id| self.message_indexes.get(id))
            .map(|index| &self.messages[*index]);
        match last {
            Some(message) if message.role == AgentMessageRole::Assistant => message.id.clone(),
            Some(message) if !turn.assistant_message_ids.is_empty() => {
                format!("assistant:{}:{}", turn.id, message.id)
            }
            _ => format!("assistant:{}", turn.id),
        }
    }

    fn put_assistant_part(
        &mut self,
        turn_id: &str,
        part: AgentTranscriptPart,
        created_at: Option<u64>,
        completed_at: Option<u64>,
    ) -> usize {
        let turn_index = self.ensure_turn(turn_id);
        // Completions still update their original tool/message even when a
        // follow-up prompt has started a new assistant segment in this turn.
        let message_id = self
            .assistant_part_message_index(turn_id, part_id(&part))
            .map(|index| self.messages[index].id.clone())
            .unwrap_or_else(|| self.current_assistant_message_id(turn_index));
        if !self.message_indexes.contains_key(&message_id) {
            let parent_id = self.turns[turn_index]
                .message_ids
                .iter()
                .rev()
                .filter_map(|id| {
                    self.message_indexes
                        .get(id)
                        .map(|index| &self.messages[*index])
                })
                .find(|message| message.role == AgentMessageRole::User)
                .map(|message| message.id.clone());
            self.put_message(
                turn_id,
                AgentTranscriptMessage {
                    details: Some(AgentTranscriptDetails {
                        model: self.model.clone(),
                        provider: self.provider.clone(),
                        ..Default::default()
                    }),
                    id: message_id.clone(),
                    role: AgentMessageRole::Assistant,
                    parent_id,
                    created_at_ms: created_at,
                    completed_at_ms: completed_at,
                    error: None,
                    parts: Vec::new(),
                    diffs: Vec::new(),
                },
            );
            self.turns[turn_index]
                .assistant_message_ids
                .push(message_id.clone());
        }
        let index = self.message_indexes[&message_id];
        let message = &mut self.messages[index];
        message.created_at_ms = message.created_at_ms.or(created_at);
        message.completed_at_ms = completed_at.or(message.completed_at_ms);
        let incoming_part_id = part_id(&part);
        if let Some(index) = message
            .parts
            .iter()
            .position(|current| part_id(current) == incoming_part_id)
        {
            message.parts[index] = part;
        } else {
            message.parts.push(part);
        }
        self.dirty_messages.push(index);
        index
    }

    fn merge_turn_diffs(&mut self, turn_id: &str, message_index: usize, files: &[AgentFileDiff]) {
        let turn_index = self.ensure_turn(turn_id);
        merge_diffs(&mut self.turns[turn_index].diffs, files);
        merge_diffs(&mut self.messages[message_index].diffs, files);
        self.dirty_messages.push(message_index);
    }

    fn set_turn_error(&mut self, turn_id: &str, error: String) {
        if let Some(index) = self
            .turn_indexes
            .get(turn_id)
            .and_then(|index| self.turns[*index].assistant_message_ids.last())
            .and_then(|id| self.message_indexes.get(id))
            .copied()
        {
            self.messages[index].error = Some(error);
            self.dirty_messages.push(index);
        }
    }

    fn rollback(&mut self, num_turns: u32) {
        let count = usize::try_from(num_turns).unwrap_or(usize::MAX);
        let keep = self.turns.len().saturating_sub(count);
        let removed = self.turns[keep..]
            .iter()
            .map(|turn| turn.id.clone())
            .collect::<Vec<_>>();
        self.turns.truncate(keep);
        self.turns_truncated_to = Some(keep);
        self.turn_indexes = self
            .turns
            .iter()
            .enumerate()
            .map(|(index, turn)| (turn.id.clone(), index))
            .collect();
        self.messages.retain(|message| {
            self.message_turns
                .get(&message.id)
                .is_none_or(|turn_id| !removed.contains(turn_id))
        });
        self.messages_truncated_to = Some(self.messages.len());
        self.message_indexes = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.clone(), index))
            .collect();
        self.message_turns
            .retain(|_, turn_id| !removed.contains(turn_id));
        self.raw_tool_activity
            .retain(|_, activity| !removed.contains(&activity.turn_id));
        if self
            .active_turn_id
            .as_ref()
            .is_some_and(|turn_id| removed.contains(turn_id))
        {
            self.active_turn_id = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn unsupported_counts(&self) -> (u64, u64, u64, u64) {
        (
            self.drift.unsupported_rollout_types,
            self.drift.unsupported_event_types,
            self.drift.unsupported_turn_item_types,
            self.drift.unsupported_response_item_types,
        )
    }
}

fn seconds_to_millis(value: Option<i64>) -> Option<u64> {
    value?.checked_mul(1_000)?.try_into().ok()
}

fn nonzero_millis(value: Option<i64>) -> Option<u64> {
    let value = value?;
    (value > 0).then(|| value.try_into().ok()).flatten()
}

fn string_field(key: &str, value: String) -> AgentField {
    AgentField {
        key: key.to_owned(),
        value: AgentScalarValue::String { value },
    }
}

fn put_string_field(fields: &mut Vec<AgentField>, key: &str, value: String) {
    if let Some(field) = fields.iter_mut().find(|field| field.key == key) {
        field.value = AgentScalarValue::String { value };
    } else {
        fields.push(string_field(key, value));
    }
}

fn value_fields(value: &Value) -> Vec<AgentField> {
    let Some(object) = value.as_object() else {
        return value_text(value)
            .map(|value| vec![string_field("value", value)])
            .unwrap_or_default();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            let value = match value {
                Value::Array(_) | Value::Object(_) => AgentScalarValue::String {
                    value: serde_json::to_string(value).ok()?,
                },
                _ => AgentScalarValue::from_json_primitive(value)?,
            };
            Some(AgentField {
                key: key.clone(),
                value,
            })
        })
        .collect()
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        value => serde_json::to_string(value).ok(),
    }
}

fn json_detail(value: &impl serde::Serialize) -> Option<String> {
    serde_json::to_string_pretty(value).ok()
}

fn dynamic_output(items: &[Value]) -> Option<String> {
    let output = items
        .iter()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("imageUrl"))
                .or_else(|| item.get("audioUrl"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!output.is_empty()).then_some(output)
}

fn joined_output(stdout: Option<&str>, stderr: Option<&str>) -> Option<String> {
    let output = [stdout, stderr]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!output.is_empty()).then_some(output)
}

fn tool_status(value: &str) -> AgentToolStatus {
    match value {
        "in_progress" | "inProgress" | "running" => AgentToolStatus::Running,
        "completed" | "success" => AgentToolStatus::Completed,
        "failed" | "declined" | "error" | "incomplete" => AgentToolStatus::Error,
        _ => AgentToolStatus::Pending,
    }
}

fn part_id(part: &AgentTranscriptPart) -> &str {
    match part {
        AgentTranscriptPart::Text { id, .. }
        | AgentTranscriptPart::Image { id, .. }
        | AgentTranscriptPart::Reasoning { id, .. }
        | AgentTranscriptPart::Tool { id, .. }
        | AgentTranscriptPart::Plan { id, .. }
        | AgentTranscriptPart::Notice { id, .. } => id,
    }
}

fn merge_diffs(target: &mut Vec<AgentFileDiff>, files: &[AgentFileDiff]) {
    for file in files {
        if let Some(existing) = target.iter_mut().find(|current| current.file == file.file) {
            *existing = file.clone();
        } else {
            target.push(file.clone());
        }
    }
}

fn supported_tool_start(item: &TurnItem) -> bool {
    let id = match item {
        TurnItem::CommandExecution(item) => &item.id,
        TurnItem::FileChange(item) => &item.id,
        TurnItem::McpToolCall(item)
            if !item.server.trim().is_empty() && !item.tool.trim().is_empty() =>
        {
            &item.id
        }
        TurnItem::DynamicToolCall(item) if !item.tool.trim().is_empty() => &item.id,
        TurnItem::WebSearch(item) => &item.id,
        TurnItem::ImageGeneration(item) => &item.id,
        _ => return false,
    };
    !id.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_fields_convert_primitives_and_serialize_nested_json() {
        let input = serde_json::json!({
            "text": "hello",
            "empty": "",
            "integer": -42,
            "fraction": 1.5,
            "enabled": true,
            "disabled": false,
            "array": [1, "two"],
            "object": {"nested": true},
            "null": null,
        });
        let fields = value_fields(&input);
        let expected = [
            (
                "text",
                AgentScalarValue::String {
                    value: "hello".to_owned(),
                },
            ),
            (
                "empty",
                AgentScalarValue::String {
                    value: String::new(),
                },
            ),
            ("integer", AgentScalarValue::Number { value: -42.0 }),
            ("fraction", AgentScalarValue::Number { value: 1.5 }),
            ("enabled", AgentScalarValue::Boolean { value: true }),
            ("disabled", AgentScalarValue::Boolean { value: false }),
            (
                "array",
                AgentScalarValue::String {
                    value: r#"[1,"two"]"#.to_owned(),
                },
            ),
            (
                "object",
                AgentScalarValue::String {
                    value: r#"{"nested":true}"#.to_owned(),
                },
            ),
        ];
        assert_eq!(fields.len(), expected.len());
        for (key, value) in expected {
            assert!(fields.contains(&AgentField {
                key: key.to_owned(),
                value
            }));
        }
    }

    #[test]
    fn value_fields_keep_non_object_payloads_as_text() {
        for (input, expected) in [
            (serde_json::json!("hello"), "hello"),
            (serde_json::json!(""), ""),
            (serde_json::json!(42), "42"),
            (serde_json::json!(1.5), "1.5"),
            (serde_json::json!(true), "true"),
            (serde_json::json!(false), "false"),
            (serde_json::json!([1, "two"]), r#"[1,"two"]"#),
        ] {
            assert_eq!(
                value_fields(&input),
                vec![string_field("value", expected.to_owned())]
            );
        }
        assert!(value_fields(&Value::Null).is_empty());
    }
}
