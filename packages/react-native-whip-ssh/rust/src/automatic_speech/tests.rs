use super::*;
use crate::{AgentQuestion, AgentQuestionOption, AgentToolState, AgentToolStatus};

fn message(id: &str, text: &str, completed: bool) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: id.into(),
        role: AgentMessageRole::Assistant,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: completed.then_some(1),
        error: None,
        parts: vec![AgentTranscriptPart::Text {
            id: "prose".into(),
            text: text.into(),
            timestamp_ms: None,
        }],
        diffs: Vec::new(),
        details: None,
    }
}

fn coordinator(agent: AgentTranscriptKind) -> Coordinator {
    let mut coordinator = Coordinator {
        enabled: true,
        ..Coordinator::default()
    };
    coordinator.sources.insert(
        "one".into(),
        Source {
            runtime_id: "runtime".into(),
            authority: None,
            pending_baseline: false,
            epoch: 1,
            revision: 0,
            agent,
            status: AgentTranscriptStatus::Live,
            host_id: "host".into(),
            pane_id: "pane".into(),
            tab_name: "Debug".into(),
            bindings: HashMap::new(),
        },
    );
    coordinator.accept(
        "one",
        1,
        1,
        AgentTranscriptStatus::Live,
        [&message("history", "Old response.", true)].into_iter(),
        true,
        0,
    );
    coordinator
}

fn update(coordinator: &mut Coordinator, revision: u64, message: &AgentTranscriptMessage) {
    let reset = coordinator.needs_baseline("one", 1, AgentTranscriptStatus::Live);
    coordinator.accept(
        "one",
        1,
        revision,
        AgentTranscriptStatus::Live,
        [message].into_iter(),
        reset,
        revision,
    );
}

fn take(coordinator: &mut Coordinator) -> Value {
    coordinator.command(Command::Take, 10)
}
fn id(value: &Value) -> u64 {
    value["id"]
        .as_u64()
        .unwrap_or_else(|| panic!("missing native request: {value}"))
}

#[test]
fn authoritative_deltas_speak_for_every_provider_without_js_messages_or_drain() {
    for agent in [
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::OpenCode,
        AgentTranscriptKind::Pi,
    ] {
        let mut coordinator = coordinator(agent);
        assert!(take(&mut coordinator).is_null());
        update(&mut coordinator, 2, &message("new", "New reply.", true));
        let speech = take(&mut coordinator);
        assert_eq!(speech["text"], "Debug tab: New reply.");
        assert_eq!(speech["hostId"], "host");
        assert_eq!(speech["paneId"], "pane");
        assert!(take(&mut coordinator).is_null());
        assert_eq!(
            coordinator.command(Command::Completed { id: id(&speech) }, 11),
            true
        );
        update(&mut coordinator, 3, &message("new", "New reply.", true));
        assert!(take(&mut coordinator).is_null());
    }
}

#[test]
fn recorded_async_question_is_spoken_once_across_live_and_completed_items() {
    let fixture = include_bytes!(
        "../../../../../crates/agent-transcript-core/tests/fixtures/codex/async-question.jsonl"
    );
    let lines = fixture
        .split_inclusive(|byte| *byte == b'\n')
        .collect::<Vec<_>>();
    for speak_while_running in [false, true] {
        let mut core = crate::CodexSessionCore::new("thread-fruit");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        let mut coordinator = coordinator(AgentTranscriptKind::Codex);
        core.ingest(binding.source_generation, &lines[..4].concat())
            .unwrap();
        coordinator.accept(
            "one",
            1,
            2,
            AgentTranscriptStatus::Live,
            core.state().messages.iter(),
            true,
            0,
        );
        assert!(take(&mut coordinator).is_null());

        for (index, line) in lines[4..7].iter().enumerate() {
            core.ingest(binding.source_generation, line).unwrap();
            coordinator.accept(
                "one",
                1,
                index as u64 + 3,
                AgentTranscriptStatus::Live,
                core.state().messages.iter(),
                false,
                0,
            );
            if index == 0 && speak_while_running || index == 1 && !speak_while_running {
                let speech = take(&mut coordinator);
                assert_eq!(
                    speech["text"],
                    "Debug tab: Orange or apple? Orange or Apple."
                );
                coordinator.command(Command::Completed { id: id(&speech) }, 0);
            }
        }
        assert!(take(&mut coordinator).is_null());

        // A separate call may legitimately ask the same question again.
        for (index, line) in lines[4..7].iter().enumerate() {
            let next_call = String::from_utf8_lossy(line).replace("call-fruit", "call-next");
            core.ingest(binding.source_generation, next_call.as_bytes())
                .unwrap();
            coordinator.accept(
                "one",
                1,
                index as u64 + 6,
                AgentTranscriptStatus::Live,
                core.state().messages.iter(),
                false,
                0,
            );
        }
        let speech = take(&mut coordinator);
        assert_eq!(speech["text"], "Orange or apple? Orange or Apple.");
        coordinator.command(Command::Completed { id: id(&speech) }, 0);
        assert!(take(&mut coordinator).is_null());
    }
}

#[test]
fn disabled_readers_do_not_consume_prose_and_stale_baseline_jobs_cannot_reenable_them() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    coordinator.command(Command::Enable { enabled: false }, 1);
    coordinator.accept(
        "one",
        1,
        2,
        AgentTranscriptStatus::Live,
        std::iter::once_with(|| panic!("disabled readers must not inspect message payloads")),
        false,
        2,
    );
    assert!(!coordinator.queue.has_source("one"));
    coordinator.command(Command::Enable { enabled: true }, 3);
    let stale = coordinator.baseline_generation;
    coordinator.command(Command::Enable { enabled: false }, 4);
    coordinator.command(Command::Enable { enabled: true }, 5);
    let history = [
        message("history", "Old response.", true),
        message("muted", "Muted reply.", true),
    ];
    let view = crate::AgentTranscriptView {
        revision: 2,
        messages: &history,
        turns: &[],
        provider_turns: false,
    };
    assert!(!coordinator.restore_baseline(stale, "one", 1, AgentTranscriptStatus::Live, view, 5));
    assert!(take(&mut coordinator).is_null());
    assert!(coordinator.restore_baseline(
        coordinator.baseline_generation,
        "one",
        1,
        AgentTranscriptStatus::Live,
        view,
        6
    ));
    update(
        &mut coordinator,
        3,
        &message("muted", "Edited muted reply.", true),
    );
    assert!(take(&mut coordinator).is_null());
    update(&mut coordinator, 4, &message("fresh", "Fresh reply.", true));
    assert_eq!(take(&mut coordinator)["text"], "Debug tab: Fresh reply.");
}

#[test]
fn opted_in_reader_finishes_current_and_new_updates_while_locked() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    coordinator.command(Command::ReadWhileLocked { enabled: true }, 1);
    update(&mut coordinator, 2, &message("first", "First reply.", true));
    let current = take(&mut coordinator);
    coordinator.command(Command::Lock { locked: true }, 3);
    assert_eq!(
        coordinator.command(Command::Valid { id: id(&current) }, 3),
        true
    );
    update(
        &mut coordinator,
        3,
        &message("locked", "Reply while locked.", true),
    );
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&current) }, 4),
        true
    );
    let locked = take(&mut coordinator);
    assert_eq!(locked["text"], "Reply while locked.");
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&locked) }, 5),
        true
    );
    coordinator.command(Command::Lock { locked: false }, 6);
    update(
        &mut coordinator,
        4,
        &message("locked", "Reply while locked.", true),
    );
    assert!(take(&mut coordinator).is_null());
}

#[test]
fn opting_in_while_locked_does_not_replay_suppressed_updates_and_opt_out_stops_playback() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    coordinator.command(Command::Lock { locked: true }, 1);
    update(&mut coordinator, 2, &message("muted", "Stay silent.", true));
    coordinator.command(Command::ReadWhileLocked { enabled: true }, 2);
    assert!(take(&mut coordinator).is_null());
    update(
        &mut coordinator,
        3,
        &message("fresh", "Fresh locked reply.", true),
    );
    let current = take(&mut coordinator);
    assert_eq!(current["text"], "Debug tab: Fresh locked reply.");
    update(
        &mut coordinator,
        4,
        &message("waiting", "Discard waiting reply.", true),
    );
    coordinator.command(Command::ReadWhileLocked { enabled: false }, 4);
    assert_eq!(
        coordinator.command(Command::Valid { id: id(&current) }, 4),
        false
    );
    assert!(take(&mut coordinator).is_null());
    coordinator.command(Command::Lock { locked: false }, 5);
    assert!(take(&mut coordinator).is_null());
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&current) }, 6),
        false
    );
}

#[test]
fn pause_lock_disable_and_native_stop_suppress_existing_content_on_resume() {
    for control in ["pause", "lock", "disable", "stop"] {
        let mut coordinator = coordinator(AgentTranscriptKind::Codex);
        update(&mut coordinator, 2, &message("first", "First reply.", true));
        let current = take(&mut coordinator);
        let command = match control {
            "pause" => Command::Pause { paused: true },
            "lock" => Command::Lock { locked: true },
            "disable" => Command::Enable { enabled: false },
            _ => Command::Ended {
                id: id(&current),
                reason: EndReason::Stopped,
                failed: false,
            },
        };
        coordinator.command(command, 3);
        update(&mut coordinator, 3, &message("muted", "Stay silent.", true));
        assert!(take(&mut coordinator).is_null());
        // A React remount cannot undo explicit native Stop.
        coordinator.command(Command::Enable { enabled: true }, 4);
        if control == "stop" {
            assert!(take(&mut coordinator).is_null());
            coordinator.command(Command::Enable { enabled: false }, 4);
            coordinator.command(Command::Enable { enabled: true }, 4);
        }
        coordinator.command(Command::Pause { paused: false }, 4);
        coordinator.command(Command::Lock { locked: false }, 4);
        update(&mut coordinator, 4, &message("muted", "Stay silent.", true));
        assert!(take(&mut coordinator).is_null());
        update(&mut coordinator, 5, &message("fresh", "Fresh reply.", true));
        assert_eq!(take(&mut coordinator)["text"], "Debug tab: Fresh reply.");
        assert_eq!(
            coordinator.command(Command::Completed { id: id(&current) }, 6),
            false
        );
    }
}

#[test]
fn late_completion_and_old_epoch_cannot_finish_or_replace_new_audio() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    update(&mut coordinator, 2, &message("first", "Old reply.", true));
    let old = take(&mut coordinator);
    coordinator.accept(
        "one",
        2,
        3,
        AgentTranscriptStatus::Live,
        [&message("first", "Replacement history.", true)].into_iter(),
        true,
        3,
    );
    coordinator.accept(
        "one",
        2,
        4,
        AgentTranscriptStatus::Live,
        [&message("new", "Replacement reply.", true)].into_iter(),
        false,
        4,
    );
    let current = take(&mut coordinator);
    assert_eq!(current["text"], "Debug tab: Replacement reply.");
    assert_ne!(id(&old), id(&current));
    coordinator.accept(
        "one",
        1,
        100,
        AgentTranscriptStatus::Live,
        [&message("stale", "Never speak.", true)].into_iter(),
        false,
        5,
    );
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&old) }, 5),
        false
    );
    assert!(take(&mut coordinator).is_null());
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&current) }, 6),
        true
    );
    assert!(take(&mut coordinator).is_null());
}

#[test]
fn replacement_and_reconnect_baseline_all_history_before_accepting_later_edits() {
    for (epoch, previous_status) in [
        (2, AgentTranscriptStatus::Live),
        (1, AgentTranscriptStatus::Stale),
    ] {
        let mut coordinator = coordinator(AgentTranscriptKind::Codex);
        coordinator.sources.get_mut("one").unwrap().status = previous_status;
        let history = [
            message("historical-a", "Old first response.", true),
            message("historical-b", "Old second response.", true),
            message("live", "Catch-up.", false),
        ];
        // The transcript integration supplies a complete borrowed baseline at
        // generation/live boundaries, and changed messages at ordinary revisions.
        let baseline = coordinator.needs_baseline("one", epoch, AgentTranscriptStatus::Live);
        let messages = if baseline {
            history.as_slice()
        } else {
            &history[2..]
        };
        coordinator.accept(
            "one",
            epoch,
            2,
            AgentTranscriptStatus::Live,
            messages.iter(),
            baseline,
            2,
        );
        coordinator.accept(
            "one",
            epoch,
            3,
            AgentTranscriptStatus::Live,
            [&message(
                "historical-b",
                "Edited historical response.",
                true,
            )]
            .into_iter(),
            false,
            3,
        );
        assert!(take(&mut coordinator).is_null());
        coordinator.accept(
            "one",
            epoch,
            4,
            AgentTranscriptStatus::Live,
            [&message("fresh", "Fresh reply.", true)].into_iter(),
            false,
            4,
        );
        assert_eq!(take(&mut coordinator)["text"], "Debug tab: Fresh reply.");
    }
}

#[test]
fn closing_cancels_speech_and_reopening_preserves_attribution_without_replay() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    update(
        &mut coordinator,
        2,
        &message("reply", "Current reply.", true),
    );
    let old = take(&mut coordinator);
    coordinator.accept(
        "one",
        1,
        3,
        AgentTranscriptStatus::Closed,
        [].into_iter(),
        false,
        3,
    );
    assert_eq!(
        coordinator.command(Command::Valid { id: id(&old) }, 3),
        false
    );
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&old) }, 3),
        false
    );
    let reset = coordinator.needs_baseline("one", 2, AgentTranscriptStatus::Live);
    coordinator.accept(
        "one",
        2,
        4,
        AgentTranscriptStatus::Live,
        [&message("reply", "Current reply.", true)].into_iter(),
        reset,
        4,
    );
    assert!(take(&mut coordinator).is_null());
    coordinator.accept(
        "one",
        2,
        5,
        AgentTranscriptStatus::Live,
        [&message("fresh", "Fresh reply.", true)].into_iter(),
        false,
        5,
    );
    let next = take(&mut coordinator);
    assert_eq!(next["text"], "Debug tab: Fresh reply.");
    assert_eq!(next["hostId"], "host");
    assert_eq!(next["paneId"], "pane");
}

#[test]
fn engine_failures_and_interruptions_flush_backlog_without_disabling_future_replies() {
    for (reason, failed) in [(EndReason::Stopped, true), (EndReason::Interrupted, false)] {
        let mut coordinator = coordinator(AgentTranscriptKind::Claude);
        update(
            &mut coordinator,
            2,
            &message("first", "Interrupted reply.", true),
        );
        let old = take(&mut coordinator);
        update(
            &mut coordinator,
            3,
            &message("waiting", "Discard backlog.", true),
        );
        coordinator.command(
            Command::Ended {
                id: id(&old),
                reason,
                failed,
            },
            4,
        );
        assert!(take(&mut coordinator).is_null());
        update(&mut coordinator, 4, &message("fresh", "Fresh reply.", true));
        assert_eq!(take(&mut coordinator)["text"], "Debug tab: Fresh reply.");
    }
}

#[test]
fn shake_skips_the_started_update_and_native_timer_resumes_other_work() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    update(
        &mut coordinator,
        2,
        &message("current", "Beginning.", false),
    );
    let current = take(&mut coordinator);
    update(
        &mut coordinator,
        3,
        &message("other", "Waiting update.", true),
    );
    coordinator.command(
        Command::Ended {
            id: id(&current),
            reason: EndReason::Shake,
            failed: false,
        },
        20,
    );
    update(
        &mut coordinator,
        4,
        &message("current", "Beginning. Skipped continuation.", true),
    );
    assert!(
        coordinator
            .command(Command::Take, 20 + SHAKE_PAUSE_MS - 1)
            .is_null()
    );
    let next = coordinator.command(Command::Take, 20 + SHAKE_PAUSE_MS);
    assert_eq!(next["text"], "Waiting update.");
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&current) }, 2_000),
        false
    );
    assert_eq!(
        coordinator.command(Command::Completed { id: id(&next) }, 2_000),
        true
    );
    assert!(coordinator.command(Command::Take, 2_000).is_null());
}

#[test]
fn native_metadata_commands_require_a_current_binding_and_use_its_canonical_pane() {
    let mut coordinator = coordinator(AgentTranscriptKind::Codex);
    coordinator.sources.get_mut("one").unwrap().bindings.insert(
        "terminal".into(),
        Binding {
            token: "current-binding".into(),
            pane: "current-pane".into(),
        },
    );
    for token in ["current-binding", "old-binding"] {
        let command = serde_json::from_value::<Command>(json!({"action": "bind", "bindingToken": token,
            "hostId": "display-host", "tabName": if token == "current-binding" { "Current" } else { "Stale" }})).unwrap();
        coordinator.command(command, 1);
    }
    update(&mut coordinator, 2, &message("new", "Fresh reply.", true));
    let next = take(&mut coordinator);
    assert_eq!(next["text"], "Current tab: Fresh reply.");
    assert_eq!(next["hostId"], "display-host");
    assert_eq!(next["paneId"], "current-pane");
}

#[test]
fn question_tools_speak_options_while_waiting_and_tool_internals_stay_private() {
    let mut coordinator = coordinator(AgentTranscriptKind::Claude);
    let mut response = message("question", "", false);
    response.parts = vec![AgentTranscriptPart::Tool {
        id: "ask".into(),
        call_id: "call".into(),
        tool: "AskUserQuestion".into(),
        timestamp_ms: None,
        state: AgentToolState {
            status: AgentToolStatus::Running,
            input: Vec::new(),
            input_json: None,
            output: Some("private tool output".into()),
            error: None,
            title: None,
            started_at_ms: None,
            completed_at_ms: None,
            exit_code: None,
            duration_ms: None,
            files: Vec::new(),
            diagnostics: Vec::new(),
            loaded: Vec::new(),
            questions: vec![AgentQuestion {
                header: None,
                question: "Which path?".into(),
                multiple: false,
                options: vec![
                    AgentQuestionOption {
                        label: "Left".into(),
                        description: None,
                    },
                    AgentQuestionOption {
                        label: "Right".into(),
                        description: None,
                    },
                ],
            }],
        },
    }];
    update(&mut coordinator, 2, &response);
    let speech = take(&mut coordinator);
    let text = speech["text"].as_str().unwrap_or_default();
    assert!(text.contains("Which path?"));
    assert!(text.contains("Left or Right"));
    assert!(!text.contains("private"));
}
