use super::*;
use crate::agent_transcript::AgentTranscriptMessage;
fn message(role: AgentMessageRole, text: &str) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: "test".into(),
        role,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: None,
        error: None,
        diffs: vec![],
        details: None,
        parts: vec![AgentTranscriptPart::Text {
            id: "text".into(),
            text: text.into(),
            timestamp_ms: None,
        }],
    }
}
fn build(messages: &[AgentTranscriptMessage]) -> String {
    from_view(AgentTranscriptView {
        revision: 1,
        messages,
        turns: &[],
        provider_turns: false,
    })
}
#[test]
fn current_thread_preserves_recent_questions_answers_and_omits_private_parts() {
    let user = message(AgentMessageRole::User, "What were we changing?");
    let mut answer = message(
        AgentMessageRole::Assistant,
        "Porting WebRTC and fixing the orb.",
    );
    answer.parts.push(AgentTranscriptPart::Reasoning {
        id: "private".into(),
        text: "hidden reasoning".into(),
        timestamp_ms: None,
    });
    let context = build(&[user, answer]);
    assert!(context.contains("What were we changing?"));
    assert!(context.contains("Porting WebRTC and fixing the orb."));
    assert!(!context.contains("hidden reasoning"));
    assert!(context.contains("User:") && context.contains("Assistant:"));
}
#[test]
fn history_is_bounded_and_newest_turn_takes_priority() {
    let mut messages = Vec::new();
    for index in 0..100 {
        messages.push(message(
            AgentMessageRole::User,
            &format!("Question {index} {}", "你好".repeat(1000)),
        ));
        messages.push(message(
            AgentMessageRole::Assistant,
            &format!("Answer {index}"),
        ));
    }
    let context = build(&messages);
    assert!(context.len() <= SECTION_BYTES);
    assert!(context.contains("Question 99"));
    assert!(context.contains("Answer 99"));
    assert!(!context.contains("Question 0 "));
    assert!(context.ends_with(FOOTER));
}
#[test]
fn empty_or_assistant_only_context_does_not_invent_a_user_turn() {
    assert!(build(&[]).is_empty());
    assert!(build(&[message(AgentMessageRole::Assistant, "orphan")]).is_empty());
}

#[test]
fn explicit_history_is_ordered_bounded_and_keeps_questions_historical() {
    let messages = [
        message(AgentMessageRole::User, "Last user request."),
        message(
            AgentMessageRole::Assistant,
            "**Public** response.\n```sh\nprivate_code\n```",
        ),
    ];
    let view = AgentTranscriptView {
        revision: 7,
        messages: &messages,
        turns: &[],
        provider_turns: true,
    };
    let result = read(view, crate::AgentTranscriptKind::Codex, 12);
    assert_eq!(result["messages"][0]["role"], "user");
    assert_eq!(result["messages"][0]["text"], "Last user request.");
    assert_eq!(result["messages"][1]["text"], "Public response.");
    assert_eq!(result["question_state"], "historical_only");
    assert_eq!(result["revision"], 7);
    let truncated = read(view, crate::AgentTranscriptKind::Codex, 1);
    assert_eq!(truncated["messages"].as_array().map(Vec::len), Some(1));
    assert_eq!(truncated["truncated"], true);
}
