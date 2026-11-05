use agent_transcript_core::{AgentTranscriptKind, AgentTranscriptState};
use agent_transcript_view::{AgentChatRowPatch, RowProjection, SearchState};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A caller can use any core parser/checkpoint reader to obtain this state.
    let state: AgentTranscriptState = serde_json::from_value(serde_json::json!({
        "session_id": "example", "agent": "Claude", "revision": 0,
        "status": "Live", "info": null, "error": null,
        "messages": [{"id": "message", "role": "Assistant", "parent_id": null,
            "created_at_ms": null, "completed_at_ms": null, "error": null,
            "diffs": [], "parts": [{"Text": {"id": "text",
                "text": "Hello transcript", "timestamp_ms": null}}]}],
        "turns": [{"id": "turn", "user_message_id": null,
            "assistant_message_ids": ["message"], "message_ids": [],
            "status": "Idle", "started_at_ms": null, "completed_at_ms": null,
            "diffs": []}]
    }))?;
    assert_eq!(state.agent, AgentTranscriptKind::Claude);
    let mut rows = RowProjection::default();
    rows.restore(&state);
    let mut search = SearchState::default();
    search.restore(&state);
    let results = search.search("transcript".into());
    let hit = &results.matches[0];
    let update = rows.poll(0, false, hit.reveal.clone());
    assert!(update.patches.iter().any(|patch| match patch {
        AgentChatRowPatch::Reset { rows } | AgentChatRowPatch::Splice { rows, .. } =>
            rows.iter().any(|row| row.id == hit.document_id),
    }));
    println!("Found {:?} in row {}", hit.matched, hit.document_id);
    Ok(())
}
