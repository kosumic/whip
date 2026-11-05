use agent_transcript_core::*;
use serde_json::json;
pub(super) fn message(id: &str, role: &str, parts: serde_json::Value) -> AgentTranscriptMessage {
    serde_json::from_value(json!({ "id": id, "role": role, "parts": parts, "diffs": [] })).unwrap()
}

pub(super) fn text(id: &str, value: &str) -> serde_json::Value {
    json!({ "Text": { "id": id, "text": value, "timestamp_ms": null } })
}

pub fn fixture(count: usize) -> AgentTranscriptState {
    let mut state = AgentTranscriptState::empty("session".into(), AgentTranscriptKind::Codex);
    for index in 0..count {
        let id = format!("m{index}");
        state
            .messages
            .push(message(&id, "Assistant", json!([text("text", "Hello")])));
        state.turns.push(AgentTranscriptTurn {
            id: format!("t{index}"),
            user_message_id: None,
            assistant_message_ids: vec![id],
            message_ids: vec![],
            status: AgentTurnStatus::Idle,
            started_at_ms: None,
            completed_at_ms: None,
            diffs: vec![],
            details: None,
        });
    }
    state
}
