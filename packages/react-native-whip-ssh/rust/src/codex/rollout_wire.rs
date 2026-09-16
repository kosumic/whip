//! Tolerant wire model for the persisted Codex rollout subset Whip projects.
//!
//! Codex deliberately persists both raw response items and presentation-ready
//! turn items. Paginated history follows `item_started` / `item_completed`; the
//! raw response items drive legacy history. Session metadata selects the format.
//! Upstream currently persists completed items but omits starts and approval
//! requests. Decode those lifecycle events when supplied, without inferring
//! nested tool identities from raw exec scripts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub(crate) enum RolloutRecord {
    SessionMeta(SessionMeta),
    ResponseItem(ResponseItem),
    Event(Event),
    TurnContext(TurnContext),
    Compacted(Compacted),
    AppServerLike(Value),
    KnownIrrelevant,
    Unknown { kind: String, value: Value },
}

/// Selected once from the rollout's first SessionMeta; never from event shapes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CodexHistoryMode {
    #[default]
    Unselected,
    Legacy,
    Paginated,
    Unsupported,
}

impl CodexHistoryMode {
    fn legacy() -> Self {
        Self::Legacy
    }

    fn deserialize_wire<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("legacy") => Self::Legacy,
            Some("paginated") => Self::Paginated,
            _ => Self::Unsupported,
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct SessionMeta {
    pub id: Option<String>,
    pub cwd: Option<String>,
    #[serde(
        default = "CodexHistoryMode::legacy",
        deserialize_with = "CodexHistoryMode::deserialize_wire"
    )]
    pub history_mode: CodexHistoryMode,
}

#[derive(Clone, Debug)]
pub(crate) enum ResponseItem {
    Known { value: Value },
    Unknown { kind: String, value: Value },
}

#[derive(Clone, Debug)]
pub(crate) enum Event {
    ItemStarted(ItemEvent),
    ItemCompleted(ItemEvent),
    TurnStarted(TurnStarted),
    TurnComplete(TurnComplete),
    TurnAborted(TurnAborted),
    ThreadRolledBack(ThreadRolledBack),
    Legacy(Value),
    KnownIrrelevant,
    Unknown { kind: String, value: Value },
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ItemEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub item: Value,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TurnStarted {
    pub turn_id: String,
    #[serde(default)]
    pub started_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TurnComplete {
    pub turn_id: String,
    #[serde(default)]
    pub error: Option<TurnError>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TurnError {
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TurnAborted {
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ThreadRolledBack {
    pub num_turns: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TurnContext {
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Compacted {
    pub message: String,
}

#[derive(Clone, Debug)]
pub(crate) enum TurnItem {
    UserMessage(UserMessage),
    AgentMessage(AgentMessage),
    Plan(Plan),
    Reasoning(Reasoning),
    CommandExecution(CommandExecution),
    FileChange(FileChangeItem),
    McpToolCall(McpToolCall),
    DynamicToolCall(DynamicToolCall),
    WebSearch(WebSearch),
    ImageGeneration(ImageGeneration),
    ContextCompaction(ContextCompaction),
    KnownIrrelevant,
    Unknown { kind: String, value: Value },
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct UserMessage {
    pub id: String,
    #[serde(default)]
    pub content: Vec<UserInput>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct UserInput {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AgentMessage {
    pub id: String,
    #[serde(default)]
    pub content: Vec<AgentMessageContent>,
    #[serde(default)]
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AgentMessageContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Plan {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Reasoning {
    pub id: String,
    #[serde(default)]
    pub summary_text: Vec<String>,
    #[serde(default)]
    pub raw_content: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct CommandExecution {
    pub id: String,
    #[serde(default)]
    pub process_id: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: Value,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stderr: Option<String>,
    #[serde(default)]
    pub aggregated_output: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct FileChangeItem {
    pub id: String,
    #[serde(default)]
    pub changes: BTreeMap<String, FileChange>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stderr: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum FileChange {
    Add {
        content: String,
    },
    Delete {
        content: String,
    },
    Update {
        unified_diff: String,
        #[serde(default)]
        move_path: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolCall {
    pub id: String,
    pub server: String,
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<McpToolCallError>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct McpToolCallError {
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct DynamicToolCall {
    pub id: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub content_items: Option<Vec<Value>>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct WebSearch {
    pub id: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub action: Value,
    #[serde(default)]
    pub results: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ImageGeneration {
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub revised_prompt: Option<String>,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub saved_path: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ContextCompaction {
    pub id: String,
}

pub(crate) fn decode_rollout_record(value: &Value) -> RolloutRecord {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    match kind {
        "session_meta" => decode(payload, RolloutRecord::SessionMeta, kind, value),
        "response_item" => RolloutRecord::ResponseItem(decode_response_item(payload)),
        "event_msg" => RolloutRecord::Event(decode_event(payload)),
        "turn_context" => decode(payload, RolloutRecord::TurnContext, kind, value),
        "compacted" => decode(payload, RolloutRecord::Compacted, kind, value),
        "thread.started" | "item.completed" => RolloutRecord::AppServerLike(value.clone()),
        "inter_agent_communication"
        | "inter_agent_communication_metadata"
        | "world_state"
        | "security_risk_score"
        | "realtime_item" => RolloutRecord::KnownIrrelevant,
        _ => RolloutRecord::Unknown {
            kind: kind.to_owned(),
            value: value.clone(),
        },
    }
}

pub(crate) fn decode_turn_item(value: Value) -> TurnItem {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    macro_rules! item {
        ($ty:ty, $variant:path) => {
            serde_json::from_value::<$ty>(value.clone())
                .map($variant)
                .unwrap_or_else(|_| TurnItem::Unknown {
                    kind: kind.clone(),
                    value: value.clone(),
                })
        };
    }
    match kind.as_str() {
        "UserMessage" => item!(UserMessage, TurnItem::UserMessage),
        "AgentMessage" => item!(AgentMessage, TurnItem::AgentMessage),
        "Plan" => item!(Plan, TurnItem::Plan),
        "Reasoning" => item!(Reasoning, TurnItem::Reasoning),
        "CommandExecution" => item!(CommandExecution, TurnItem::CommandExecution),
        "FileChange" => item!(FileChangeItem, TurnItem::FileChange),
        "McpToolCall" => item!(McpToolCall, TurnItem::McpToolCall),
        "DynamicToolCall" => item!(DynamicToolCall, TurnItem::DynamicToolCall),
        "WebSearch" => item!(WebSearch, TurnItem::WebSearch),
        // Hosted search uses WebSearch; standalone search is owned by an
        // extension with the same payload (including open-page actions).
        "Extension" if value.get("kind").and_then(Value::as_str) == Some("web.search") => {
            item!(WebSearch, TurnItem::WebSearch)
        }
        "ImageGeneration" => item!(ImageGeneration, TurnItem::ImageGeneration),
        "ContextCompaction" => item!(ContextCompaction, TurnItem::ContextCompaction),
        "HookPrompt"
        | "CollabAgentToolCall"
        | "SubAgentActivity"
        | "ImageView"
        | "Extension"
        | "EnteredReviewMode"
        | "ExitedReviewMode" => TurnItem::KnownIrrelevant,
        _ => TurnItem::Unknown { kind, value },
    }
}

fn decode_event(value: Value) -> Event {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    macro_rules! event {
        ($ty:ty, $variant:path) => {
            serde_json::from_value::<$ty>(value.clone())
                .map($variant)
                .unwrap_or_else(|_| Event::Unknown {
                    kind: kind.clone(),
                    value: value.clone(),
                })
        };
    }
    match kind.as_str() {
        "item_started" => event!(ItemEvent, Event::ItemStarted),
        "item_completed" => event!(ItemEvent, Event::ItemCompleted),
        "task_started" | "turn_started" => serde_json::from_value::<TurnStarted>(value.clone())
            .map(Event::TurnStarted)
            .unwrap_or(Event::Legacy(value)),
        "task_complete" | "turn_complete" => serde_json::from_value::<TurnComplete>(value.clone())
            .map(Event::TurnComplete)
            .unwrap_or(Event::Legacy(value)),
        "turn_aborted" => event!(TurnAborted, Event::TurnAborted),
        "thread_rolled_back" => event!(ThreadRolledBack, Event::ThreadRolledBack),
        "user_message"
        | "agent_message"
        | "agent_reasoning"
        | "agent_reasoning_raw_content"
        | "exec_command_begin"
        | "exec_command_output_delta"
        | "exec_command_end"
        | "patch_apply_begin"
        | "patch_apply_updated"
        | "patch_apply_end"
        | "turn_diff"
        | "mcp_tool_call_begin"
        | "mcp_tool_call_end"
        | "web_search_begin"
        | "web_search_end"
        | "plan_update"
        | "error"
        | "warning"
        | "stream_error"
        | "deprecation_notice"
        | "exec_approval_request"
        | "request_permissions"
        | "request_user_input"
        | "elicitation_request"
        | "apply_patch_approval_request" => Event::Legacy(value),
        "token_count"
        | "thread_goal_updated"
        | "thread_settings_applied"
        | "context_compacted"
        | "thread_queue_changed"
        | "guardian_assessment"
        | "guardian_warning"
        | "realtime_conversation_started"
        | "realtime_conversation_sdp"
        | "realtime_conversation_realtime"
        | "realtime_conversation_closed"
        | "realtime_conversation_list_voices_response"
        | "safety_buffering"
        | "model_reroute"
        | "model_verification"
        | "turn_moderation_metadata"
        | "agent_reasoning_section_break"
        | "hook_started"
        | "hook_completed"
        | "raw_response_item"
        | "raw_response_completed"
        | "session_configured"
        | "environment_connected"
        | "environment_disconnected"
        | "view_image_tool_call"
        | "terminal_interaction"
        | "plan_delta"
        | "agent_message_content_delta"
        | "reasoning_content_delta"
        | "reasoning_raw_content_delta"
        | "image_generation_begin"
        | "collab_agent_spawn_begin"
        | "collab_agent_spawn_end"
        | "collab_agent_interaction_begin"
        | "collab_agent_interaction_end"
        | "collab_waiting_begin"
        | "collab_waiting_end"
        | "collab_close_begin"
        | "collab_close_end"
        | "collab_resume_begin"
        | "collab_resume_end"
        | "dynamic_tool_call_request"
        | "dynamic_tool_call_response"
        | "mcp_startup_update"
        | "mcp_startup_complete"
        | "shutdown_complete" => Event::KnownIrrelevant,
        _ => Event::Unknown { kind, value },
    }
}

fn decode_response_item(value: Value) -> ResponseItem {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if matches!(
        kind.as_str(),
        "message"
            | "agent_message"
            | "reasoning"
            | "local_shell_call"
            | "function_call"
            | "tool_search_call"
            | "function_call_output"
            | "tool_search_output"
            | "custom_tool_call"
            | "custom_tool_call_output"
            | "web_search_call"
            | "image_generation_call"
            | "compaction"
            | "compaction_summary"
            | "context_compaction"
    ) {
        ResponseItem::Known { value }
    } else {
        ResponseItem::Unknown { kind, value }
    }
}

fn decode<T>(
    payload: Value,
    variant: impl FnOnce(T) -> RolloutRecord,
    kind: &str,
    original: &Value,
) -> RolloutRecord
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(payload)
        .map(variant)
        .unwrap_or_else(|_| RolloutRecord::Unknown {
            kind: kind.to_owned(),
            value: original.clone(),
        })
}

/// Informational fallback shared by legacy and paginated history. The neutral
/// model has no blocked turn state or request-resolution lifecycle yet.
pub(crate) fn interactive_response_notice(kind: &str) -> Option<&'static str> {
    matches!(
        kind,
        "exec_approval_request"
            | "apply_patch_approval_request"
            | "request_permissions"
            | "request_user_input"
            | "elicitation_request"
    )
    .then_some("Codex is waiting for an interactive response. Open Terminal to respond.")
}
