use super::*;

fn config() -> Config {
    Config {
        owner: "composer".into(),
        draft: "draft".into(),
        android: true,
        api: 36,
        provider: Provider::Default,
        local_only: false,
        managed_call: false,
        during_playback: false,
        native_ingress: false,
    }
}
fn begin(state: &mut State, config: Config) {
    let cloud = config.cloud();
    assert!(state.apply(Command::Begin { config }, 0));
    ack(
        state,
        "load",
        Outcome::Loaded {
            available: true,
            local_supported: true,
            ingress_supported: true,
        },
        0,
    );
    ack(state, "readContext", Outcome::Context { recent: vec![] }, 0);
    if !cloud {
        ack(
            state,
            "requestPermission",
            Outcome::Permission { granted: true },
            0,
        );
    }
    ack(state, "suspendPlayback", Outcome::Done, 0);
}
fn action_name(effect: &Effect) -> String {
    serde_json::to_value(effect).unwrap()["action"]
        .as_str()
        .unwrap()
        .into()
}
fn ack(state: &mut State, action: &str, outcome: Outcome, now: u64) {
    let e = state
        .pending
        .values()
        .find(|e| action_name(e) == action)
        .unwrap()
        .clone();
    assert!(state.apply(
        Command::Ack {
            id: e.id,
            generation: e.generation,
            epoch: e.epoch,
            outcome
        },
        now
    ));
}
fn event(state: &mut State, event: Event, now: u64) {
    let s = state.session.as_ref().unwrap();
    assert!(state.apply(
        Command::Event {
            generation: s.generation.clone(),
            epoch: s.epoch.to_string(),
            event
        },
        now
    ));
}
fn idle(state: &mut State, now: u64) {
    ack(state, "checkIdle", Outcome::Idle { inactive: true }, now);
    state.advance(now + RESTART_MS);
    ack(
        state,
        "checkIdle",
        Outcome::Idle { inactive: true },
        now + RESTART_MS,
    );
    state.advance(now + RESTART_MS);
}
fn appended(state: &mut State) -> Vec<String> {
    state
        .take_effects()
        .into_iter()
        .filter_map(|e| match e.action {
            Action::PublishDraftAppend { text } => Some(text),
            _ => None,
        })
        .collect()
}
fn listening(state: &mut State) {
    begin(state, config());
    event(state, Event::Start, 0);
}
fn stop(state: &mut State) {
    state.apply(
        Command::Stop {
            owner: "composer".into(),
        },
        0,
    );
}

#[test]
fn cancellation_during_permission_fences_late_grant_and_replacement() {
    let mut state = State::default();
    state.apply(Command::Begin { config: config() }, 0);
    ack(
        &mut state,
        "load",
        Outcome::Loaded {
            available: true,
            local_supported: true,
            ingress_supported: true,
        },
        0,
    );
    let grant = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::RequestPermission { .. }))
        .unwrap()
        .clone();
    state.apply(
        Command::Cancel {
            owner: "composer".into(),
        },
        1,
    );
    begin(
        &mut state,
        Config {
            owner: "replacement".into(),
            ..config()
        },
    );
    assert!(!state.apply(
        Command::Ack {
            id: grant.id,
            generation: grant.generation,
            epoch: grant.epoch,
            outcome: Outcome::Permission { granted: true }
        },
        2
    ));
    assert_eq!(state.view().owner.as_deref(), Some("replacement"));
    assert!(appended(&mut state).is_empty());
}
#[test]
fn stop_keeps_the_last_hypothesis_once_and_cancel_drops_it() {
    for cancel in [false, true] {
        let mut state = State::default();
        listening(&mut state);
        event(
            &mut state,
            Event::Result {
                text: "confirmed".into(),
                is_final: true,
            },
            0,
        );
        event(
            &mut state,
            Event::Result {
                text: "last hypothesis".into(),
                is_final: false,
            },
            0,
        );
        stop(&mut state);
        if cancel {
            state.apply(
                Command::Cancel {
                    owner: "composer".into(),
                },
                0,
            );
        }
        event(&mut state, Event::End, 1);
        idle(&mut state, 1);
        assert_eq!(
            appended(&mut state),
            if cancel {
                vec!["confirmed"]
            } else {
                vec!["confirmed", "last hypothesis"]
            }
        );
        assert!(state.session.is_none());
    }
}
#[test]
fn final_correction_during_stop_consumes_partial_without_duplicate() {
    let mut state = State::default();
    listening(&mut state);
    event(
        &mut state,
        Event::Result {
            text: "uncorrected".into(),
            is_final: false,
        },
        0,
    );
    stop(&mut state);
    event(
        &mut state,
        Event::Result {
            text: "corrected".into(),
            is_final: true,
        },
        1,
    );
    event(&mut state, Event::End, 2);
    idle(&mut state, 2);
    assert_eq!(appended(&mut state), ["corrected"]);
}
#[test]
fn android_fallback_waits_for_end_and_native_idle_then_downgrades_once() {
    for error in ["client", "audio-capture", "no-speech", "speech-timeout"] {
        let mut state = State::default();
        listening(&mut state);
        event(
            &mut state,
            Event::Error {
                error: error.into(),
                message: None,
            },
            0,
        );
        assert!(state.continuous_failed);
        assert_eq!(state.session.as_ref().unwrap().stage, Stage::Closing);
        event(&mut state, Event::End, 1);
        let old_epoch = state.session.as_ref().unwrap().epoch;
        idle(&mut state, 1);
        assert_eq!(state.session.as_ref().unwrap().epoch, old_epoch + 1);
        assert!(!state.session.as_ref().unwrap().continuous);
        event(&mut state, Event::Start, 252);
        event(
            &mut state,
            Event::Error {
                error: "audio-capture".into(),
                message: None,
            },
            253,
        );
        event(&mut state, Event::End, 254);
        idle(&mut state, 254);
        assert!(state.session.is_none());
        let effects = state.take_effects();
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e.action, Action::StartRecognition { .. }))
                .count(),
            2
        );
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e.action, Action::ReportError { .. }))
                .count(),
            1
        );
    }
}
#[test]
fn local_only_never_downgrades_and_managed_call_retains_reservation() {
    let mut state = State::default();
    assert!(state.apply(
        Command::Reserve {
            owner: "composer".into()
        },
        0
    ));
    begin(
        &mut state,
        Config {
            local_only: true,
            managed_call: true,
            ..config()
        },
    );
    event(&mut state, Event::Start, 0);
    state.apply(Command::Background, 1);
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Listening);
    stop(&mut state);
    event(
        &mut state,
        Event::Result {
            text: "local turn".into(),
            is_final: true,
        },
        1,
    );
    event(
        &mut state,
        Event::Error {
            error: "client".into(),
            message: None,
        },
        1,
    );
    event(&mut state, Event::End, 2);
    idle(&mut state, 2);
    assert_eq!(appended(&mut state), ["local turn"]);
    assert!(state.view().active);
    assert!(!state.apply(
        Command::Begin {
            config: Config {
                owner: "other".into(),
                ..config()
            }
        },
        500
    ));
    assert!(state.apply(
        Command::ReleaseReservation {
            owner: "composer".into()
        },
        500
    ));
    assert!(!state.view().active);
    assert!(!state.continuous_failed);
}
#[test]
fn missing_end_checks_idle_and_never_steals_a_live_recognizer() {
    let mut state = State::default();
    listening(&mut state);
    stop(&mut state);
    state.advance(OPERATION_MS);
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Closing);
    state.advance(OPERATION_MS * 2);
    let mut now = OPERATION_MS * 2;
    for _ in 0..IDLE_CHECKS {
        ack(
            &mut state,
            "checkIdle",
            Outcome::Idle { inactive: false },
            now,
        );
        now += RESTART_MS;
        state.advance(now);
    }
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Quarantined);
    assert!(state.deadline().is_none());
    assert!(!state.apply(Command::Begin { config: config() }, now));
    // A real terminal event can recover the quarantined microphone.
    event(&mut state, Event::End, now);
    idle(&mut state, now);
    assert!(state.session.is_none());
}
#[test]
fn missing_end_recovers_when_native_confirms_idle() {
    let mut state = State::default();
    listening(&mut state);
    state.apply(
        Command::Cancel {
            owner: "composer".into(),
        },
        0,
    );
    state.advance(OPERATION_MS);
    idle(&mut state, OPERATION_MS);
    assert!(state.session.is_none());
}
#[test]
fn startup_timeout_fallback_is_bounded_and_late_start_cannot_cancel_stop_timeout() {
    let mut state = State::default();
    begin(&mut state, config());
    state.advance(OPERATION_MS);
    event(&mut state, Event::End, OPERATION_MS);
    idle(&mut state, OPERATION_MS);
    state.advance(OPERATION_MS * 2 + RESTART_MS);
    assert!(state.session.as_ref().unwrap().cancelled);
    event(&mut state, Event::End, OPERATION_MS * 2 + RESTART_MS);
    idle(&mut state, OPERATION_MS * 2 + RESTART_MS);
    assert!(state.session.is_none());
    listening(&mut state);
    stop(&mut state);
    event(&mut state, Event::Start, 1);
    state.advance(OPERATION_MS);
    assert!(state.session.as_ref().unwrap().cancelled);
}
#[test]
fn duplicate_end_and_results_in_the_gap_cannot_duplicate_text_or_restart() {
    let mut state = State::default();
    listening(&mut state);
    event(&mut state, Event::End, 0);
    event(&mut state, Event::End, 0);
    event(
        &mut state,
        Event::Result {
            text: "late".into(),
            is_final: true,
        },
        0,
    );
    idle(&mut state, 0);
    // Events arriving before the replacement's start observation are discarded.
    event(
        &mut state,
        Event::Result {
            text: "late".into(),
            is_final: true,
        },
        RESTART_MS,
    );
    assert!(appended(&mut state).is_empty());
    assert_eq!(state.session.as_ref().unwrap().epoch, 2);
}
#[test]
fn empty_cycles_back_off_but_listening_silence_has_no_timeout() {
    let mut state = State::default();
    listening(&mut state);
    state.advance(60_000);
    assert!(state.deadline().is_none());
    let mut now = 60_000;
    for _ in 0..10 {
        event(
            &mut state,
            Event::Error {
                error: "no-speech".into(),
                message: None,
            },
            now,
        );
        event(&mut state, Event::End, now);
        idle(&mut state, now);
        now += MAX_RESTART_MS;
        state.advance(now);
        assert!(state.session.as_ref().unwrap().restart_delay <= MAX_RESTART_MS);
        event(&mut state, Event::Start, now);
    }
    assert!(!state.session.as_ref().unwrap().error_reported);
}
#[test]
fn context_deadline_unblocks_start_and_stale_context_ack_is_ignored() {
    let mut state = State::default();
    state.apply(Command::Begin { config: config() }, 0);
    let context = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::ReadContext))
        .unwrap()
        .clone();
    ack(
        &mut state,
        "load",
        Outcome::Loaded {
            available: true,
            local_supported: true,
            ingress_supported: true,
        },
        0,
    );
    ack(
        &mut state,
        "requestPermission",
        Outcome::Permission { granted: true },
        0,
    );
    state.advance(CONTEXT_MS);
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Playback);
    assert!(!state.apply(
        Command::Ack {
            id: context.id,
            generation: context.generation,
            epoch: context.epoch,
            outcome: Outcome::Context { recent: vec![] }
        },
        CONTEXT_MS
    ));
}
#[test]
fn background_and_stale_cloud_transcription_cannot_append_to_replacement() {
    let mut state = State::default();
    begin(
        &mut state,
        Config {
            provider: Provider::Openai,
            ..config()
        },
    );
    ack(
        &mut state,
        "startCloud",
        Outcome::CloudStarted { granted: true },
        0,
    );
    stop(&mut state);
    let finish = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::FinishCloud { .. }))
        .unwrap()
        .clone();
    state.apply(Command::Background, 0);
    ack(&mut state, "cancelCloud", Outcome::Done, 0);
    listening(&mut state);
    assert!(!state.apply(
        Command::Ack {
            id: finish.id,
            generation: finish.generation,
            epoch: finish.epoch,
            outcome: Outcome::Transcript {
                text: "late upload".into()
            }
        },
        0
    ));
    assert!(appended(&mut state).is_empty());
}
#[test]
fn acknowledgements_require_matching_id_generation_epoch_and_outcome() {
    let mut state = State::default();
    begin(&mut state, config());
    let start = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::StartRecognition { .. }))
        .unwrap()
        .clone();
    assert!(!state.apply(
        Command::Ack {
            id: start.id.clone(),
            generation: start.generation.clone(),
            epoch: "wrong".into(),
            outcome: Outcome::Done
        },
        0
    ));
    assert!(!state.apply(
        Command::Ack {
            id: start.id,
            generation: start.generation,
            epoch: start.epoch,
            outcome: Outcome::Permission { granted: true }
        },
        0
    ));
    ack(&mut state, "startRecognition", Outcome::Done, 0);
}

#[test]
fn stop_or_cancel_during_recovery_cannot_start_another_cycle() {
    for cancel in [false, true] {
        let mut state = State::default();
        listening(&mut state);
        event(
            &mut state,
            Event::Result {
                text: "pending".into(),
                is_final: false,
            },
            0,
        );
        event(&mut state, Event::End, 0);
        let command = if cancel {
            Command::Cancel {
                owner: "composer".into(),
            }
        } else {
            Command::Stop {
                owner: "composer".into(),
            }
        };
        state.apply(command, 0);
        idle(&mut state, 0);
        state.advance(60_000);
        let effects = state.take_effects();
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e.action, Action::StartRecognition { .. }))
                .count(),
            1
        );
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e.action, Action::PublishDraftAppend { .. }))
                .count(),
            usize::from(!cancel)
        );
        assert!(state.session.is_none());
    }
}

#[test]
fn local_call_playback_exemption_requires_a_retained_reservation() {
    for reserved in [false, true] {
        let mut state = State::default();
        if reserved {
            assert!(state.apply(
                Command::Reserve {
                    owner: "composer".into()
                },
                0
            ));
        }
        state.apply(
            Command::Begin {
                config: Config {
                    local_only: true,
                    managed_call: true,
                    during_playback: true,
                    ..config()
                },
            },
            0,
        );
        ack(
            &mut state,
            "load",
            Outcome::Loaded {
                available: true,
                local_supported: true,
                ingress_supported: true,
            },
            0,
        );
        ack(
            &mut state,
            "readContext",
            Outcome::Context { recent: vec![] },
            0,
        );
        let effects = state.take_effects();
        assert!(effects.iter().any(
            |e| matches!(e.action, Action::RequestPermission { existing } if existing == reserved)
        ));
        ack(
            &mut state,
            "requestPermission",
            Outcome::Permission { granted: true },
            0,
        );
        let effects = state.take_effects();
        assert_eq!(
            effects
                .iter()
                .any(|e| matches!(e.action, Action::SuspendPlayback)),
            !reserved
        );
        if reserved {
            assert!(effects.iter().any(|e| matches!(
                e.action,
                Action::StartRecognition {
                    on_device: true,
                    monitoring: true,
                    ..
                }
            )));
        }
    }
}

#[test]
fn context_hints_and_cloud_provider_selection_share_existing_content_core() {
    let mut state = State::default();
    state.apply(
        Command::Begin {
            config: Config {
                provider: Provider::Openai,
                local_only: true,
                ..config()
            },
        },
        0,
    );
    ack(
        &mut state,
        "load",
        Outcome::Loaded {
            available: true,
            local_supported: true,
            ingress_supported: true,
        },
        0,
    );
    ack(
        &mut state,
        "readContext",
        Outcome::Context {
            recent: vec!["terminal".into()],
        },
        0,
    );
    ack(
        &mut state,
        "requestPermission",
        Outcome::Permission { granted: true },
        0,
    );
    ack(&mut state, "suspendPlayback", Outcome::Done, 0);
    let effects = state.take_effects();
    assert!(
        !effects
            .iter()
            .any(|e| matches!(e.action, Action::StartCloud))
    );
    assert!(effects.iter().any(|e| matches!(&e.action, Action::StartRecognition { on_device: true, context, .. } if context == &["draft", "terminal"])));
}

#[test]
fn stopped_local_client_and_empty_errors_preserve_partial_without_reporting_failure() {
    for error in ["client", "no-speech", "speech-timeout", "network"] {
        let mut state = State::default();
        begin(
            &mut state,
            Config {
                local_only: true,
                ..config()
            },
        );
        event(&mut state, Event::Start, 0);
        event(
            &mut state,
            Event::Result {
                text: "last turn".into(),
                is_final: false,
            },
            0,
        );
        stop(&mut state);
        event(
            &mut state,
            Event::Error {
                error: error.into(),
                message: Some("provider error".into()),
            },
            0,
        );
        event(&mut state, Event::End, 0);
        idle(&mut state, 0);
        let effects = state.take_effects();
        assert!(effects.iter().any(
            |e| matches!(&e.action, Action::PublishDraftAppend { text } if text == "last turn")
        ));
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e.action, Action::ReportError { .. }))
                .count(),
            usize::from(error == "network")
        );
    }
}

#[test]
fn startup_exception_and_empty_final_each_fallback_once_after_idle() {
    for empty_final in [false, true] {
        let mut state = State::default();
        begin(&mut state, config());
        if empty_final {
            event(&mut state, Event::Start, 0);
            event(
                &mut state,
                Event::Result {
                    text: String::new(),
                    is_final: true,
                },
                0,
            );
        } else {
            ack(
                &mut state,
                "startRecognition",
                Outcome::Failed {
                    error: "failed".into(),
                    message: None,
                },
                0,
            );
        }
        assert_eq!(state.session.as_ref().unwrap().stage, Stage::Closing);
        event(&mut state, Event::End, 0);
        idle(&mut state, 0);
        assert!(!state.session.as_ref().unwrap().continuous);
        assert!(!state.session.as_ref().unwrap().error_reported);
    }
}

#[test]
fn stale_epoch_and_replayed_acknowledgement_cannot_modify_current_session() {
    let mut state = State::default();
    listening(&mut state);
    let effect = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::StartRecognition { .. }))
        .unwrap()
        .clone();
    ack(&mut state, "startRecognition", Outcome::Done, 0);
    let old_generation = state.session.as_ref().unwrap().generation.clone();
    event(&mut state, Event::End, 0);
    idle(&mut state, 0);
    assert!(!state.apply(
        Command::Ack {
            id: effect.id,
            generation: effect.generation,
            epoch: effect.epoch,
            outcome: Outcome::Done
        },
        RESTART_MS
    ));
    assert!(!state.apply(
        Command::Event {
            generation: old_generation,
            epoch: "1".into(),
            event: Event::Result {
                text: "stale".into(),
                is_final: true
            }
        },
        RESTART_MS
    ));
    assert!(appended(&mut state).is_empty());
}

#[test]
fn active_native_backend_and_late_idle_ack_are_never_treated_as_completion() {
    let mut state = State::default();
    listening(&mut state);
    event(&mut state, Event::End, 0);
    let check = state
        .pending
        .values()
        .find(|e| matches!(e.action, Action::CheckIdle))
        .unwrap()
        .clone();
    state.advance(OPERATION_MS);
    assert!(!state.apply(
        Command::Ack {
            id: check.id,
            generation: check.generation,
            epoch: check.epoch,
            outcome: Outcome::Idle { inactive: true }
        },
        OPERATION_MS
    ));
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Quiet);
    assert!(!state.apply(Command::Begin { config: config() }, OPERATION_MS));
}

#[test]
fn alternating_native_states_cannot_extend_idle_recovery_indefinitely() {
    let mut state = State::default();
    listening(&mut state);
    event(&mut state, Event::End, 0);
    let mut now = 0;
    for inactive in [false, true, false, true, false] {
        ack(&mut state, "checkIdle", Outcome::Idle { inactive }, now);
        now += RESTART_MS;
        state.advance(now);
    }
    assert_eq!(state.session.as_ref().unwrap().stage, Stage::Quarantined);
    assert!(state.session.as_ref().unwrap().cancelled);
    assert!(state.deadline().is_none());
}
