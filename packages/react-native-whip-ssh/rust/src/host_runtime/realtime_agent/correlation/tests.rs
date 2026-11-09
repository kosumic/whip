use super::*;
use crate::agent_transcript::AgentTranscriptDetails;

fn message(id: &str, role: AgentMessageRole, text: String) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: id.into(),
        role,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: None,
        error: None,
        parts: vec![AgentTranscriptPart::Text {
            id: "text".into(),
            text,
            timestamp_ms: None,
        }],
        diffs: vec![],
        details: None,
    }
}
fn turn(
    id: &str,
    user: &str,
    assistant: &str,
    outcome: Option<AgentTurnOutcome>,
) -> AgentTranscriptTurn {
    AgentTranscriptTurn {
        id: id.into(),
        user_message_id: Some(user.into()),
        assistant_message_ids: vec![assistant.into()],
        message_ids: vec![user.into(), assistant.into()],
        status: match outcome {
            Some(AgentTurnOutcome::Completed) => AgentTurnStatus::Idle,
            Some(AgentTurnOutcome::Interrupted) => AgentTurnStatus::Interrupted,
            Some(AgentTurnOutcome::Failed) => AgentTurnStatus::Error,
            None => AgentTurnStatus::Working,
        },
        started_at_ms: None,
        completed_at_ms: None,
        diffs: vec![],
        details: Some(AgentTranscriptDetails {
            outcome,
            ..AgentTranscriptDetails::default()
        }),
    }
}
fn view<'a>(
    revision: u64,
    messages: &'a [AgentTranscriptMessage],
    turns: &'a [AgentTranscriptTurn],
) -> AgentTranscriptView<'a> {
    AgentTranscriptView {
        revision,
        messages,
        turns,
        provider_turns: true,
    }
}

#[test]
fn independent_tasks_and_out_of_order_completion_require_the_exact_submission_nonce_and_turn() {
    let mut first = Tracker::new(Some(view(1, &[], &[])), false);
    let mut second = Tracker::new(Some(view(1, &[], &[])), false);
    let messages = vec![
        message("u1", AgentMessageRole::User, first.text("first request")),
        message("a1", AgentMessageRole::Assistant, "First progress.".into()),
        message("u2", AgentMessageRole::User, second.text("second request")),
        message("a2", AgentMessageRole::Assistant, "Second answer.".into()),
        message(
            "outside",
            AgentMessageRole::Assistant,
            "Unrelated answer.".into(),
        ),
    ];
    let mut turns = vec![
        turn("t1", "u1", "a1", None),
        turn("t2", "u2", "a2", Some(AgentTurnOutcome::Completed)),
    ];
    let first_pending = first.observe(view(2, &messages, &turns));
    assert!(first_pending.accepted);
    assert!(first_pending.outcome.is_none());
    assert_eq!(
        first_pending.assistant_output.as_deref(),
        Some("First progress.")
    );
    let second_done = second.observe(view(2, &messages, &turns));
    assert_eq!(second_done.turn_id.as_deref(), Some("t2"));
    assert_eq!(second_done.outcome, Some(AgentTurnOutcome::Completed));
    turns[0] = turn("t1", "u1", "a1", Some(AgentTurnOutcome::Failed));
    assert_eq!(
        first.observe(view(3, &messages, &turns)).outcome,
        Some(AgentTurnOutcome::Failed)
    );
    assert_eq!(
        second.observe(view(3, &messages, &turns)).outcome,
        Some(AgentTurnOutcome::Completed)
    );
}

#[test]
fn blocked_or_idle_status_and_inferred_grouping_never_establish_completion() {
    for status in [
        AgentTurnStatus::Working,
        AgentTurnStatus::Interrupted,
        AgentTurnStatus::Idle,
    ] {
        let mut tracker = Tracker::new(Some(view(1, &[], &[])), false);
        let messages = [message(
            "user",
            AgentMessageRole::User,
            tracker.text("request"),
        )];
        let mut turns = [turn("turn", "user", "answer", None)];
        turns[0].status = status;
        let observed = tracker.observe(view(2, &messages, &turns));
        assert!(observed.accepted);
        assert!(observed.outcome.is_none());
        let result = observed.result("started", crate::herdr_api::HerdrAgentStatus::Blocked);
        assert_eq!(result["completion"], "unknown");
        let mut inferred = view(3, &messages, &turns);
        inferred.provider_turns = false;
        assert!(tracker.observe(inferred).outcome.is_none());
    }
}

#[test]
fn steering_remains_bound_to_the_running_provider_turn_and_rejects_a_retargeted_receipt() {
    let base = [turn("running", "old-user", "old-answer", None)];
    let mut tracker = Tracker::new(Some(view(1, &[], &base)), true);
    let messages = [message(
        "steer",
        AgentMessageRole::User,
        tracker.text("correct the task"),
    )];
    let wrong = [turn(
        "replacement",
        "steer",
        "new-answer",
        Some(AgentTurnOutcome::Completed),
    )];
    let observed = tracker.observe(view(2, &messages, &wrong));
    assert!(observed.lost);
    assert!(observed.outcome.is_none());
    assert!(observed.assistant_output.is_none());
}

#[test]
fn duplicate_nonce_changed_membership_and_revision_rollback_fail_closed() {
    for mutation in 0..3 {
        let mut tracker = Tracker::new(Some(view(1, &[], &[])), false);
        let user_text = tracker.text("request");
        let mut messages = vec![message("u", AgentMessageRole::User, user_text.clone())];
        let mut turns = vec![turn("t", "u", "a", None)];
        assert!(tracker.observe(view(2, &messages, &turns)).accepted);
        let revision = match mutation {
            0 => {
                messages.push(message("copy", AgentMessageRole::User, user_text));
                3
            }
            1 => {
                turns[0] = turn("different", "u", "a", Some(AgentTurnOutcome::Completed));
                3
            }
            _ => 1,
        };
        let observed = tracker.observe(view(revision, &messages, &turns));
        assert!(observed.lost);
        assert!(observed.outcome.is_none());
        assert!(tracker.observe(view(4, &messages, &turns)).lost);
    }
}

#[test]
fn missing_initial_history_and_multiple_running_turns_cannot_be_guessed_after_submission() {
    let mut missing = Tracker::new(None, false);
    let messages = [message(
        "u",
        AgentMessageRole::User,
        missing.text("request"),
    )];
    let turns = [turn("t", "u", "a", Some(AgentTurnOutcome::Completed))];
    let result = missing.observe(view(1, &messages, &turns));
    assert!(result.lost);
    assert!(result.outcome.is_none());
    let ambiguous = [turn("one", "u1", "a1", None), turn("two", "u2", "a2", None)];
    let mut steering = Tracker::new(Some(view(1, &[], &ambiguous)), true);
    assert!(steering.observe(view(2, &messages, &ambiguous)).lost);
}
