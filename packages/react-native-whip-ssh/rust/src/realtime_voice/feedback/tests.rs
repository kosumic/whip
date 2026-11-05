use super::*;
use crate::agent_transcript::{AgentTranscriptMessage, AgentTranscriptPart};

fn message(id: &str, role: AgentMessageRole, text: &str) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: id.into(),
        role,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: None,
        error: None,
        diffs: vec![],
        details: None,
        parts: vec![AgentTranscriptPart::Text {
            id: id.into(),
            text: text.into(),
            timestamp_ms: None,
        }],
    }
}
fn snapshot(revision: u64, messages: &[AgentTranscriptMessage]) -> Snapshot {
    Snapshot::from_view(AgentTranscriptView {
        revision,
        messages,
        turns: &[],
        provider_turns: false,
    })
}
fn handoff(snapshot: Option<Snapshot>, already_spoke: bool, now: Instant) -> Handoff {
    Handoff::new(
        "call".into(),
        "response".into(),
        snapshot,
        already_spoke,
        now,
    )
}

#[test]
fn pending_delegation_gets_one_acknowledgement_and_only_real_progress() {
    let now = Instant::now();
    let mut handoff = handoff(Some(snapshot(1, &[])), false, now);
    assert_eq!(handoff.notice(now), Some(Notice::Acknowledgement));
    assert_eq!(handoff.notice(now + PROGRESS_INTERVAL), None);
    let messages = [message(
        "progress",
        AgentMessageRole::Assistant,
        "Checking the current spot quote.",
    )];
    assert_eq!(
        handoff.observe(snapshot(2, &messages)),
        ["Checking the current spot quote."]
    );
    assert_eq!(handoff.notice(now + Duration::from_secs(1)), None);
    assert_eq!(
        handoff.notice(now + PROGRESS_INTERVAL),
        Some(Notice::Progress)
    );
    assert_eq!(handoff.notice(now + PROGRESS_INTERVAL * 2), None);
    assert!(handoff.observe(snapshot(3, &messages)).is_empty());
}

#[test]
fn model_acknowledgement_prevents_duplicate_speech() {
    let now = Instant::now();
    let mut handoff = handoff(None, false, now);
    handoff.audio("other-response", now);
    handoff.audio("response", now);
    assert_eq!(handoff.notice(now), None);
    let mut already_spoke = Handoff::new("other-call".into(), "response".into(), None, true, now);
    assert_eq!(already_spoke.notice(now), None);
}

#[test]
fn forwards_new_answer_text_and_streamed_deltas_without_replaying_history() {
    let now = Instant::now();
    let old = message("old", AgentMessageRole::Assistant, "An old answer.");
    let mut handoff = handoff(Some(snapshot(1, std::slice::from_ref(&old))), true, now);
    let progress = message("new", AgentMessageRole::Assistant, "Checking");
    assert_eq!(
        handoff.observe(snapshot(2, &[old.clone(), progress])),
        ["Checking"]
    );
    let progress = message("new", AgentMessageRole::Assistant, "Checking live prices.");
    let older = message(
        "older",
        AgentMessageRole::Assistant,
        "Loaded from backscroll.",
    );
    assert_eq!(
        handoff.observe(snapshot(3, &[older, old, progress])),
        ["live prices."]
    );
    assert_eq!(handoff.revision(), Some(3));
}

#[test]
fn excludes_user_reasoning_tools_and_non_text_parts() -> Result<(), serde_json::Error> {
    let mut assistant = message("assistant", AgentMessageRole::Assistant, "Public progress.");
    assistant.parts.push(AgentTranscriptPart::Reasoning {
        id: "private".into(),
        text: "Hidden reasoning".into(),
        timestamp_ms: None,
    });
    assistant.parts.push(AgentTranscriptPart::Image {
        id: "image".into(),
        source: "private data".into(),
        timestamp_ms: None,
    });
    assistant.parts.push(AgentTranscriptPart::Plan {
        id: "plan".into(),
        text: "Internal plan".into(),
        timestamp_ms: None,
    });
    assistant.parts.push(AgentTranscriptPart::Tool {
        id: "tool".into(),
        call_id: "call".into(),
        tool: "shell".into(),
        timestamp_ms: None,
        state: serde_json::from_value(
            serde_json::json!({"status":"Running", "input":[], "output":"Private tool payload"}),
        )?,
    });
    let mut handoff = handoff(Some(snapshot(1, &[])), true, Instant::now());
    let observed = snapshot(
        2,
        &[
            message("user", AgentMessageRole::User, "Do not forward user text"),
            assistant,
        ],
    );
    assert_eq!(observed.events.len(), 1);
    assert_eq!(
        observed.events[0]
            .event
            .as_ref()
            .and_then(|event| event.output.as_deref()),
        Some("Private tool payload")
    );
    let updates = handoff.observe(observed);
    assert_eq!(updates, ["Public progress."]);
    Ok(())
}

#[test]
fn unavailable_initial_history_and_replaced_windows_are_rebaselined() {
    let now = Instant::now();
    let mut handoff = handoff(None, true, now);
    assert!(
        handoff
            .observe(snapshot(
                1,
                &[message(
                    "history",
                    AgentMessageRole::Assistant,
                    "An old answer."
                )]
            ))
            .is_empty()
    );
    assert!(
        handoff
            .observe(snapshot(
                2,
                &[message(
                    "reloaded",
                    AgentMessageRole::Assistant,
                    "Another old answer."
                )]
            ))
            .is_empty()
    );
    assert_eq!(
        handoff.observe(snapshot(
            3,
            &[
                message(
                    "reloaded",
                    AgentMessageRole::Assistant,
                    "Another old answer."
                ),
                message("fresh", AgentMessageRole::Assistant, "Fresh result.")
            ]
        )),
        ["Fresh result."]
    );
}

#[test]
fn unicode_text_batches_and_total_handoff_output_are_bounded() {
    let mut handoff = handoff(Some(snapshot(0, &[])), true, Instant::now());
    let mut messages = Vec::new();
    let mut total = 0;
    for revision in 1..30 {
        messages.push(message(
            &format!("message-{revision}"),
            AgentMessageRole::Assistant,
            &"語".repeat(MAX_MESSAGE_BYTES),
        ));
        let updates = handoff.observe(snapshot(revision, &messages));
        let bytes: usize = updates.iter().map(String::len).sum();
        assert!(bytes <= MAX_BATCH_BYTES);
        assert!(
            updates
                .iter()
                .all(|text| text.len() <= MAX_MESSAGE_BYTES && text.chars().all(|ch| ch == '語'))
        );
        total += bytes;
    }
    assert!(total <= MAX_HANDOFF_BYTES);
    assert!(total > 0);
    assert!(snapshot(31, &messages).messages.len() <= MAX_MESSAGES);
}
