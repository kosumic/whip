//! Direct, weak subscriptions to canonical Rust transcript commits. No UI owner.
use super::{State, VoiceChat, VoiceChatTranscriptTurn, normalize_prompt};
use crate::realtime_voice::observer::Window;
use crate::{
    AgentMessageRole, AgentTranscriptKind, AgentTranscriptPart, AgentTranscriptStatus,
    AgentTurnOutcome, AgentTurnStatus,
};
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::{LazyLock, Weak};

static CALLS: LazyLock<Mutex<Vec<Weak<VoiceChat>>>> = LazyLock::new(Mutex::default);

pub(super) fn register(call: &Arc<VoiceChat>) {
    let mut calls = CALLS.lock();
    calls.retain(|call| call.strong_count() > 0);
    calls.push(Arc::downgrade(call));
}

pub(super) fn unregister(call: &VoiceChat) {
    CALLS
        .lock()
        .retain(|entry| !std::ptr::eq(entry.as_ptr(), call));
}

pub(crate) fn tracking() -> bool {
    CALLS.lock().iter().any(|call| call.strong_count() > 0)
}

/// Initial acquisition and same-session recovery retain their native owner even
/// when a call has no mounted Chat View or presentation subscription.
pub(crate) fn retains_transcript(
    host: &str,
    binding: &crate::agent_sessions::AgentBindingIdentity,
) -> bool {
    CALLS.lock().iter().filter_map(Weak::upgrade).any(|call| {
        let state = call.state.lock();
        state.call.view().phase != voice_call_local::Phase::Closed
            && state.connection.as_ref().is_some_and(|connection| {
                connection.runtime_id == host
                    && connection.incarnation == binding.runtime_incarnation
                    && connection.terminal_id == binding.terminal_id.as_str()
                    && connection.pane_id == binding.pane_id.as_str()
                    && connection.agent == binding.agent
            })
            && state.source.as_ref().is_none_or(|source| {
                source.session == binding.session_id.as_str()
                    && source.key == binding.transcript_key.as_str()
            })
    })
}

pub(crate) fn accept(
    host: &str,
    incarnation: u64,
    key: &str,
    epoch: u64,
    status: AgentTranscriptStatus,
    view: &Window<'_>,
) {
    let calls: Vec<_> = CALLS.lock().iter().filter_map(Weak::upgrade).collect();
    for call in calls {
        let mut state = call.state.lock();
        let Some(source) = state.source.as_ref() else {
            continue;
        };
        if source.runtime_id != host || source.incarnation != incarnation || source.key != key {
            continue;
        }
        call.accept_window(&mut state, epoch, status, view);
        drop(state);
    }
}

#[derive(Clone)]
pub(crate) struct Source {
    pub runtime_id: String,
    pub incarnation: u64,
    pub key: String,
    pub session: String,
    pub binding: String,
    pub agent: AgentTranscriptKind,
    pub epoch: u64,
    pub revision: Option<u64>,
    pub seen_revision: Option<u64>,
    pub live: bool,
}

impl VoiceChat {
    pub(crate) fn accept_window(
        &self,
        state: &mut State,
        epoch: u64,
        status: AgentTranscriptStatus,
        view: &Window<'_>,
    ) {
        let now = self.now();
        let Some(source) = state.source.as_mut() else {
            return;
        };
        if epoch < source.epoch
            || (epoch == source.epoch
                && source
                    .seen_revision
                    .is_some_and(|revision| view.revision < revision))
        {
            return;
        }
        let initial = source.revision.is_none();
        let changed = source.epoch != epoch
            || source.revision != Some(view.revision)
            || !source.live
            || state.refresh_transcript;
        source.epoch = epoch;
        source.seen_revision = Some(view.revision);
        source.live = status == AgentTranscriptStatus::Live;
        let agent = source.agent;
        match status {
            AgentTranscriptStatus::Live => state.coordinator.binding(true, now),
            AgentTranscriptStatus::Loading | AgentTranscriptStatus::Stale => {
                state.coordinator.binding(false, now);
                return;
            }
            AgentTranscriptStatus::Unavailable if initial => {
                state.coordinator.binding(false, now);
                return;
            }
            _ => {
                state.coordinator.fail(
                    "The agent transcript is unavailable. Reopen voice chat after reconnecting.",
                );
                return;
            }
        }
        if !changed && !initial {
            return;
        }
        state.refresh_transcript = false;
        if let Some(source) = &mut state.source {
            source.epoch = epoch;
            source.revision = Some(view.revision);
        }
        // Initial live history must be installed before any voice dispatch.
        // A turn with a missing user record remains eligible until it arrives.
        let turns = project(view, state);
        if initial && state.submission_marker.is_none() {
            state.baseline = turns.iter().map(|turn| turn.id.clone()).collect();
            state.baseline_anchor = turns.last().map(|turn| turn.id.clone());
        }
        if let Err(error) = self.accept_turns(state, agent, false, turns) {
            state.audio_error = Some(error.to_string());
        }
    }
}

fn project(view: &Window<'_>, state: &State) -> Vec<VoiceChatTranscriptTurn> {
    if !view.turns.is_empty() {
        return view
            .turns
            .iter()
            .rev()
            .take(64)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|turn| {
                let messages: Vec<_> = view
                    .messages
                    .iter()
                    .copied()
                    .filter(|m| {
                        turn.user_message_id.as_ref() == Some(&m.id)
                            || turn.assistant_message_ids.contains(&m.id)
                            || turn.message_ids.contains(&m.id)
                    })
                    .collect();
                make_turn(
                    turn.id.clone(),
                    &messages,
                    turn.status == AgentTurnStatus::Idle
                        && turn.details.as_ref().and_then(|d| d.outcome)
                            == Some(AgentTurnOutcome::Completed),
                    matches!(
                        turn.status,
                        AgentTurnStatus::Error | AgentTurnStatus::Interrupted
                    ),
                    Some(state),
                )
            })
            .collect();
    }
    // Claude/legacy providers may have no materialized provider turns. Keep a
    // stable user-message identity and group only its following assistant prose.
    let mut turns = Vec::new();
    let mut current = Vec::new();
    for message in &view.messages {
        if message.role == AgentMessageRole::User && !current.is_empty() {
            turns.push(make_turn_from_messages(&current, state));
            current.clear();
        }
        if message.role == AgentMessageRole::User || !current.is_empty() {
            current.push(*message);
        }
    }
    if !current.is_empty() {
        turns.push(make_turn_from_messages(&current, state));
    }
    turns
}

fn make_turn_from_messages(
    messages: &[&crate::AgentTranscriptMessage],
    state: &State,
) -> VoiceChatTranscriptTurn {
    let outcome = messages
        .iter()
        .rev()
        .find_map(|m| m.details.as_ref().and_then(|d| d.outcome));
    make_turn(
        messages[0].id.clone(),
        messages,
        outcome == Some(AgentTurnOutcome::Completed),
        matches!(
            outcome,
            Some(AgentTurnOutcome::Failed | AgentTurnOutcome::Interrupted)
        ),
        Some(state),
    )
}

fn make_turn(
    id: String,
    messages: &[&crate::AgentTranscriptMessage],
    completed: bool,
    failed: bool,
    follow: Option<&State>,
) -> VoiceChatTranscriptTurn {
    // Steering can reuse a provider turn. Earlier assistants in that turn are
    // history, even when a fresh submission marker identifies its latest user.
    let messages = messages
        .iter()
        .rposition(|m| m.role == AgentMessageRole::User)
        .map_or(messages, |index| &messages[index..]);
    let user_text = messages
        .iter()
        .filter(|m| m.role == AgentMessageRole::User)
        .flat_map(|m| &m.parts)
        .filter_map(|p| {
            if let AgentTranscriptPart::Text { text, .. } = p {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    // Baselines need identities, not cloned speech/tool projections of every
    // historic turn. Materialize only the tracked turn or a plausible candidate.
    if follow.is_some_and(|state| {
        let active = matches!(
            state.call.view().phase,
            voice_call_local::Phase::Waiting | voice_call_local::Phase::Speaking
        );
        let tracked = state.turn_id.as_ref() == Some(&id);
        let candidate = state.submission_marker.as_ref().map_or_else(
            || {
                !state.baseline.contains(&id)
                    && normalize_prompt(&user_text) == normalize_prompt(&state.expected)
            },
            |marker| user_text.contains(marker),
        );
        !active || (!tracked && !candidate)
    }) {
        return VoiceChatTranscriptTurn {
            id,
            user_text,
            completed,
            failed,
            messages: Vec::new(),
            tools_json: "[]".into(),
        };
    }
    let speech = messages
        .iter()
        .filter(|m| m.role == AgentMessageRole::Assistant)
        .map(|m| crate::chat_speech::bounded_transcript_message(m))
        .collect();
    let tools: Vec<_> = messages
        .iter()
        .flat_map(|message| &message.parts)
        .filter_map(tool_event)
        .take(64)
        .collect();
    VoiceChatTranscriptTurn {
        id,
        user_text,
        completed,
        failed,
        messages: speech,
        tools_json: serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
    }
}

fn tool_event(part: &AgentTranscriptPart) -> Option<serde_json::Value> {
    let AgentTranscriptPart::Tool {
        id,
        call_id,
        tool,
        state,
        ..
    } = part
    else {
        return None;
    };
    let status = match state.status {
        crate::AgentToolStatus::Pending => "pending",
        crate::AgentToolStatus::Running => "running",
        crate::AgentToolStatus::Completed => "completed",
        crate::AgentToolStatus::Error => "failed",
    };
    let input = state.input_json.as_deref().map_or_else(
        || serde_json::to_string(&state.input).unwrap_or_default(),
        |input| crate::chat_speech::text_prefix(input, 1024).to_owned(),
    );
    Some(serde_json::json!({
        "id": if call_id.is_empty() { id } else { call_id },
        "kind": "tool", "name": tool, "status": status,
        "input": crate::chat_speech::text_prefix(&input, 1024),
        "output": state.error.as_ref().or(state.output.as_ref()).map(|text| crate::chat_speech::text_prefix(text, 1024)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_chat::{VoiceChatPhase, coordinator};
    use crate::{AgentTranscriptMessage, AgentTranscriptView};
    use voice_call_local::Phase;
    use voice_call_local::coordinator::{Effect, SpeechKind};

    fn message(
        id: &str,
        role: AgentMessageRole,
        text: &str,
        completed: bool,
    ) -> AgentTranscriptMessage {
        AgentTranscriptMessage {
            id: id.into(),
            role,
            parent_id: None,
            created_at_ms: None,
            completed_at_ms: completed.then_some(1),
            error: None,
            diffs: vec![],
            details: completed.then_some(crate::AgentTranscriptDetails {
                outcome: Some(AgentTurnOutcome::Completed),
                ..Default::default()
            }),
            parts: vec![AgentTranscriptPart::Text {
                id: "text".into(),
                text: text.into(),
                timestamp_ms: None,
            }],
        }
    }

    fn fixture() -> Arc<VoiceChat> {
        let call = VoiceChat::new(String::new());
        let mut state = call.state.lock();
        state.listen();
        state.source = Some(Source {
            runtime_id: "host".into(),
            incarnation: 1,
            key: "key".into(),
            session: "session".into(),
            binding: "binding".into(),
            agent: AgentTranscriptKind::Claude,
            epoch: 0,
            revision: None,
            seen_revision: None,
            live: false,
        });
        state.connection = Some(coordinator::Connection {
            runtime_id: "host".into(),
            incarnation: 1,
            terminal_id: "terminal".into(),
            pane_id: "pane".into(),
            queue: crate::TerminalSubmissionQueue::new(),
            target_key: "target".into(),
            agent: AgentTranscriptKind::Claude,
        });
        drop(state);
        call
    }

    fn feed(
        call: &VoiceChat,
        epoch: u64,
        revision: u64,
        status: AgentTranscriptStatus,
        messages: &[AgentTranscriptMessage],
    ) {
        let view = Window::from(AgentTranscriptView {
            revision,
            messages,
            turns: &[],
            provider_turns: false,
        });
        call.accept_window(&mut call.state.lock(), epoch, status, &view);
    }

    fn submit(call: &VoiceChat, text: &str, marker: Option<&str>) {
        let id = call.view().input_id;
        call.recognition(id, text.into());
        call.finish();
        call.recognition_ended(id).unwrap();
        let mut state = call.state.lock();
        state.call.take_prompt();
        state.submission_marker = marker.map(str::to_owned);
        let generation = state.coordinator.generation();
        state.coordinator.dispatched(generation, call.now());
    }

    #[test]
    fn native_history_baseline_normalization_and_playback_drain_need_no_js_transcript() {
        let call = fixture();
        let mut messages = vec![
            message("old-user", AgentMessageRole::User, "Hello agent", false),
            message("old-answer", AgentMessageRole::Assistant, "History.", true),
        ];
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &messages);
        submit(&call, "Hello\nagent", None);
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        assert!(call.state.lock().coordinator.take_effects().is_empty());
        messages.push(message(
            "user",
            AgentMessageRole::User,
            " Hello   agent ",
            false,
        ));
        messages.push(message(
            "answer",
            AgentMessageRole::Assistant,
            "The real answer.",
            true,
        ));
        feed(&call, 1, 3, AgentTranscriptStatus::Live, &messages);
        let mut state = call.state.lock();
        let effects = state.coordinator.take_effects();
        let Effect::Start(lease) = effects[0] else {
            panic!("reply lease");
        };
        assert_eq!(lease.kind, SpeechKind::Reply);
        assert_eq!(state.call.view().phase, Phase::Speaking);
        state.coordinator.started(lease, 0);
        let effects = state.coordinator.take_effects();
        let Effect::Speak(_, chunk, ref speech) = effects[0] else {
            panic!("reply");
        };
        assert_eq!(speech.text, "The real answer.");
        assert_eq!(speech.message_id, "answer");
        state.coordinator.played(lease, chunk, 1);
        drop(state);
        call.flush_effects();
        assert_eq!(call.view().phase, VoiceChatPhase::Listening);
    }

    #[test]
    fn source_epochs_fence_old_deltas_and_recovery_does_not_rebaseline_the_pending_reply() {
        let call = fixture();
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &[]);
        submit(&call, "Hello", Some("[marker]"));
        let messages = vec![
            message(
                "user",
                AgentMessageRole::User,
                "wrapper\n[marker]\nHello",
                false,
            ),
            message(
                "answer",
                AgentMessageRole::Assistant,
                "Recovered answer.",
                true,
            ),
        ];
        feed(&call, 2, 4, AgentTranscriptStatus::Stale, &messages);
        assert!(call.state.lock().coordinator.take_effects().is_empty());
        feed(&call, 2, 4, AgentTranscriptStatus::Live, &messages);
        let mut state = call.state.lock();
        let Effect::Start(lease) = state.coordinator.take_effects()[0] else {
            panic!("reply");
        };
        state.coordinator.started(lease, 0);
        let effects = state.coordinator.take_effects();
        assert!(
            matches!(&effects[0], Effect::Speak(_, _, speech) if speech.text == "Recovered answer.")
        );
        drop(state);
        feed(&call, 1, 100, AgentTranscriptStatus::Live, &messages);
        feed(&call, 2, 3, AgentTranscriptStatus::Live, &messages);
        feed(&call, 2, 4, AgentTranscriptStatus::Live, &messages);
        assert!(call.state.lock().coordinator.take_effects().is_empty());
    }

    #[test]
    fn unrelated_sources_and_restored_history_never_supply_the_reply() {
        let call = fixture();
        register(&call);
        let history = vec![message(
            "anchor",
            AgentMessageRole::User,
            "Last historic prompt",
            false,
        )];
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &history);
        submit(&call, "Repeat", None);
        let messages = vec![
            message("historic-user", AgentMessageRole::User, "Repeat", false),
            message(
                "historic-answer",
                AgentMessageRole::Assistant,
                "Historic answer.",
                true,
            ),
            history[0].clone(),
        ];
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        assert!(call.state.lock().coordinator.take_effects().is_empty());
        accept(
            "other-host",
            1,
            "key",
            1,
            AgentTranscriptStatus::Live,
            &Window::from(AgentTranscriptView {
                revision: 3,
                messages: &messages,
                turns: &[],
                provider_turns: false,
            }),
        );
        assert!(call.state.lock().coordinator.take_effects().is_empty());
        assert!(call.state.lock().turn_id.is_none());
    }

    #[test]
    fn typed_input_cannot_match_before_dispatch_and_ack_rechecks_an_already_received_reply() {
        let call = fixture();
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &[]);
        let connection = call.state.lock().connection.clone().unwrap();
        connection
            .queue
            .clone()
            .enqueue(connection.target_key, "Typed".into(), vec![])
            .unwrap();
        call.submit_text("Typed".into()).unwrap();
        let messages = vec![
            message("user", AgentMessageRole::User, "Typed", false),
            message("answer", AgentMessageRole::Assistant, "Typed reply.", true),
        ];
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        assert!(call.state.lock().turn_id.is_none());
        assert!(call.state.lock().coordinator.take_effects().is_empty());
        *call.state.lock().receipt.as_ref().unwrap().status.lock() =
            crate::TerminalSubmissionStatus::Accepted;
        call.tick_coordinator();
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        assert_eq!(call.state.lock().turn_id.as_deref(), Some("user"));
        assert_eq!(
            call.state.lock().coordinator.stage,
            voice_call_local::coordinator::Stage::ReplyPlaying
        );
    }

    #[test]
    fn provider_turn_id_reconciliation_keeps_the_marker_and_does_not_replay_spoken_prose() {
        let call = fixture();
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &[]);
        submit(&call, "Hello", Some("[marker]"));
        let messages = vec![
            message(
                "temporary-user",
                AgentMessageRole::User,
                "[marker] Hello",
                false,
            ),
            message(
                "answer",
                AgentMessageRole::Assistant,
                "First sentence. ",
                false,
            ),
        ];
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        let lease = call.state.lock().coordinator.lease().unwrap();
        call.state.lock().coordinator.started(lease, 0);
        call.state.lock().coordinator.take_effects();
        let mut reconciled = messages;
        reconciled[0].id = "canonical-user".into();
        reconciled[1].parts = vec![AgentTranscriptPart::Text {
            id: "text".into(),
            text: "First sentence. Second sentence.".into(),
            timestamp_ms: None,
        }];
        reconciled[1].details = Some(crate::AgentTranscriptDetails {
            outcome: Some(AgentTurnOutcome::Completed),
            ..Default::default()
        });
        reconciled[1].completed_at_ms = Some(1);
        feed(&call, 1, 3, AgentTranscriptStatus::Live, &reconciled);
        let mut state = call.state.lock();
        assert_eq!(state.turn_id.as_deref(), Some("canonical-user"));
        let effects = state.coordinator.take_effects();
        drop(state);
        assert!(
            matches!(effects.as_slice(), [Effect::Speak(_, _, speech)] if speech.text == "Second sentence.")
        );
    }

    #[test]
    fn first_prompt_can_create_a_missing_transcript_and_its_first_snapshot_delivers_the_reply() {
        let call = fixture();
        let connection = call.state.lock().connection.clone().unwrap();
        connection
            .queue
            .clone()
            .update_targets(vec![crate::TerminalSubmissionTarget {
                key: connection.target_key.clone(),
                runtime_id: connection.runtime_id,
                runtime_incarnation: 1,
                terminal_id: connection.terminal_id,
                pane_id: connection.pane_id,
                ssh: false,
                online: true,
            }]);
        feed(&call, 1, 0, AgentTranscriptStatus::Unavailable, &[]);
        let input = call.view().input_id;
        call.recognition(input, "First prompt".into());
        call.finish();
        call.recognition_ended(input).unwrap();
        call.tick_coordinator();
        let queued = connection.queue.view(connection.target_key);
        assert_eq!(queued.len(), 1);
        let messages = vec![
            message(
                "first-user",
                AgentMessageRole::User,
                &queued[0].paste_events[0],
                false,
            ),
            message(
                "first-answer",
                AgentMessageRole::Assistant,
                "The first reply.",
                true,
            ),
        ];
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &messages);
        assert!(call.view().audio_error.is_none());
        assert_eq!(call.state.lock().turn_id.as_deref(), Some("first-user"));
        assert_eq!(
            call.state.lock().coordinator.stage,
            voice_call_local::coordinator::Stage::ReplyPlaying
        );
    }

    #[test]
    fn native_word_callbacks_cannot_modify_echo_state_after_their_lease_is_revoked() {
        let call = fixture();
        feed(&call, 1, 1, AgentTranscriptStatus::Live, &[]);
        submit(&call, "Hello", Some("[marker]"));
        let messages = vec![
            message("user", AgentMessageRole::User, "[marker] Hello", false),
            message("answer", AgentMessageRole::Assistant, "The answer.", true),
        ];
        feed(&call, 1, 2, AgentTranscriptStatus::Live, &messages);
        let effects: serde_json::Value = serde_json::from_str(&call.take_effects()).unwrap();
        let token = effects[0]["token"].as_str().unwrap().to_owned();
        call.playback_event(token.clone(), "The answer.".into(), true);
        call.recognition(call.view().input_id, "The answer.".into());
        assert!(call.view().text.is_empty());
        call.skip_response();
        call.playback_event(token, "Actual new words".into(), true);
        call.recognition(call.view().input_id, "Actual new words".into());
        assert_eq!(call.view().text, "Actual new words");
    }

    #[test]
    fn matched_provider_turn_cannot_speak_prose_before_its_latest_user() {
        let messages = [
            message("old-user", AgentMessageRole::User, "Old", false),
            message(
                "old-answer",
                AgentMessageRole::Assistant,
                "Old answer.",
                true,
            ),
            message(
                "new-user",
                AgentMessageRole::User,
                "[new-marker]\nNew",
                false,
            ),
            message(
                "new-answer",
                AgentMessageRole::Assistant,
                "New answer.",
                true,
            ),
        ];
        let refs = messages.iter().collect::<Vec<_>>();
        let turn = make_turn("same-provider-turn".into(), &refs, true, false, None);
        assert_eq!(turn.user_text, "[new-marker]\nNew");
        assert_eq!(turn.messages.len(), 1);
        assert_eq!(turn.messages[0].id, "new-answer");
    }
}
