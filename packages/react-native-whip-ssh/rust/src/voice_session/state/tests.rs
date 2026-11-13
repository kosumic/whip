use super::*;
fn request(pane: &str, mode: Mode) -> Request {
    Request {
        scope: Scope::Agent {
            host_id: "host".into(),
            tab_id: pane.into(),
            pane_id: pane.into(),
            agent: "codex".into(),
            source: None,
        },
        mode,
        resume_call_id: None,
        available: true,
    }
}
fn start(state: &mut State, pane: &str, mode: Mode) -> String {
    let id = state.request(request(pane, mode)).id;
    assert_eq!(state.take_effects()[0].action, Action::Prepare);
    state.acknowledge(&id, Ack::Prepared);
    assert_eq!(state.take_effects()[0].action, Action::Start);
    state.acknowledge(&id, Ack::Started);
    id
}
#[test]
fn replacements_across_all_modes_revoke_before_draining() {
    for first_mode in [Mode::TurnBased, Mode::Realtime, Mode::Live] {
        for next_mode in [Mode::TurnBased, Mode::Realtime, Mode::Live] {
            let mut state = State::default();
            let first = start(&mut state, "first", first_mode.clone());
            let next = state.request(request("next", next_mode)).id;
            assert!(!state.is_current(&first));
            assert!(state.is_current(&next));
            let effects = state.take_effects();
            assert_eq!(effects.len(), 1);
            assert_eq!(effects[0].action, Action::Close);
            state.acknowledge(&first, Ack::Started);
            state.end(&first, None);
            assert!(state.take_effects().is_empty());
            state.acknowledge(&first, Ack::Closed);
            let effects = state.take_effects();
            assert_eq!(effects[0].action, Action::End);
            assert_eq!(effects[1].action, Action::Prepare);
            assert_eq!(effects[1].id, next);
        }
    }
}
#[test]
fn rapid_admission_coalesces_and_cancelled_preparation_still_closes() {
    let mut state = State::default();
    let first = state.request(request("a", Mode::Realtime)).id;
    let second = state.request(request("b", Mode::Live)).id;
    let third = state.request(request("c", Mode::TurnBased)).id;
    let effects = state.take_effects();
    assert_eq!(
        effects
            .iter()
            .filter(|effect| effect.action == Action::Prepare)
            .count(),
        1
    );
    assert_eq!(effects.last().map(|effect| &effect.id), Some(&third));
    assert_eq!(state.phase(&first), None);
    assert_eq!(state.phase(&second), None);
    state.end(&third, None);
    assert!(state.take_effects().is_empty());
    let next = state.request(request("d", Mode::Realtime)).id;
    assert!(state.take_effects().is_empty());
    state.acknowledge(&third, Ack::Prepared);
    assert_eq!(state.take_effects()[0].action, Action::Close);
    state.acknowledge(&third, Ack::Closed);
    assert_eq!(
        state.take_effects().last().map(|effect| &effect.id),
        Some(&next)
    );
}
#[test]
fn locking_gates_admission_but_preserves_reattachment_and_pending_start() {
    let mut state = State::default();
    let original = state.request(request("a", Mode::Realtime)).id;
    state.set_locked(true);
    let attached = state.request(request("a", Mode::TurnBased));
    assert!(attached.attached);
    assert_eq!(attached.id, original);
    assert_eq!(state.mode(&original), Some(&Mode::Realtime));
    assert_eq!(state.request(request("b", Mode::Live)).error, Some(LOCKED));
    assert!(state.is_current(&original));
    assert_eq!(state.take_effects()[0].action, Action::Prepare);
    state.acknowledge(&original, Ack::Prepared);
    assert_eq!(state.take_effects()[0].action, Action::Start);
    state.end(&original, None);
    state.acknowledge(&original, Ack::Closed);
    state.set_locked(false);
    assert!(
        !state
            .take_effects()
            .iter()
            .any(|effect| effect.action == Action::Prepare)
    );
}
#[test]
fn failed_shutdown_blocks_acquisition_until_explicit_retry_drains() {
    let mut state = State::default();
    let first = start(&mut state, "a", Mode::Live);
    let second = state.request(request("b", Mode::TurnBased)).id;
    state.take_effects();
    state.acknowledge(&first, Ack::CloseFailed);
    assert_eq!(state.take_effects()[0].action, Action::Error);
    assert_eq!(state.phase(&second), None);
    let next = state.request(request("retry", Mode::TurnBased)).id;
    assert_eq!(state.take_effects()[0].action, Action::Close);
    state.acknowledge(&first, Ack::Closed);
    assert_eq!(
        state.take_effects().last().map(|effect| &effect.id),
        Some(&next)
    );
}
#[test]
fn stale_failures_and_host_removal_only_end_their_owner() {
    let mut state = State::default();
    let first = start(&mut state, "a", Mode::TurnBased);
    let second = state.request(request("b", Mode::Realtime)).id;
    state.take_effects();
    state.acknowledge(&first, Ack::Closed);
    state.take_effects();
    state.acknowledge(&first, Ack::StartFailed);
    state.end(&first, Some("late".into()));
    assert!(state.is_current(&second));
    state.retain_hosts(&["host".into()]);
    assert!(state.is_current(&second));
    state.retain_hosts(&[]);
    assert!(!state.is_current(&second));
}
#[test]
fn failed_factory_releases_pending_replacement_without_starting_cancelled_call() {
    let mut state = State::default();
    let first = state.request(request("a", Mode::TurnBased)).id;
    state.take_effects();
    let second = state.request(request("b", Mode::Live)).id;
    state.acknowledge(&first, Ack::PrepareFailed);
    let effects = state.take_effects();
    assert_eq!(effects[0].action, Action::End);
    assert!(effects[0].error.is_none());
    assert_eq!(effects[1].action, Action::Prepare);
    assert_eq!(effects[1].id, second);
}
#[test]
fn scope_and_resume_identity_are_isolated() {
    let mut state = State::default();
    let mut global = request("a", Mode::Realtime);
    global.scope = Scope::Global;
    global.resume_call_id = Some("archive".into());
    let original = state.request(global.clone()).id;
    assert!(state.request(global.clone()).attached);
    global.resume_call_id = Some("different".into());
    assert_ne!(state.request(global).id, original);
    state.retain_hosts(&[]);
    assert!(state.current.is_some());
    let mut terminal = request("a", Mode::Live);
    terminal.scope = Scope::Terminal {
        host_id: "host".into(),
        runtime_id: "runtime".into(),
        incarnation: 1,
        connection_generation: 2,
        terminal_id: "terminal".into(),
        pane_id: None,
    };
    assert_eq!(state.request(terminal.clone()).error, Some(UNAVAILABLE));
    terminal.mode = Mode::Realtime;
    let id = state.request(terminal.clone()).id;
    assert!(state.request(terminal.clone()).attached);
    if let Scope::Terminal {
        connection_generation,
        ..
    } = &mut terminal.scope
    {
        *connection_generation += 1;
    }
    assert_ne!(state.request(terminal).id, id);
}
#[test]
fn adversarial_late_ack_sequences_never_start_a_retired_generation() {
    for cancel_at in 0..3 {
        for mode in [Mode::TurnBased, Mode::Realtime, Mode::Live] {
            let mut state = State::default();
            let id = state.request(request("a", mode)).id;
            if cancel_at > 0 {
                state.take_effects();
            }
            if cancel_at > 1 {
                state.acknowledge(&id, Ack::Prepared);
                state.take_effects();
            }
            state.end(&id, None);
            let next = state.request(request("b", Mode::Realtime)).id;
            for ack in [
                Ack::Started,
                Ack::Prepared,
                Ack::StartFailed,
                Ack::Closed,
                Ack::PrepareFailed,
                Ack::Started,
                Ack::Closed,
            ] {
                state.acknowledge(&id, ack);
                for effect in state.take_effects() {
                    assert!(effect.action != Action::Start || effect.id != id);
                    assert!(effect.action != Action::Prepare || effect.id == next);
                }
                assert!(state.is_current(&next));
            }
        }
    }
}
