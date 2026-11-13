use voice_call_local::coordinator::{Coordinator, Delivery, Effect, Speech, Stage};

fn speech(text: &str) -> Speech {
    Speech {
        text: text.into(),
        message_id: "message".into(),
        part_id: "part".into(),
        start_utf16: 0,
    }
}

#[test]
fn first_prompt_can_wait_for_initial_binding_and_late_dispatch_cannot_admit_a_replacement() {
    let mut call = Coordinator::default();
    call.acquiring(0);
    let first = call.submit(0);
    call.tick(10_000);
    call.binding(true, 10_000);
    call.dispatched(first, 10_000);
    call.observed(10_001);
    call.reply(speech("The first response."), 10_002);
    assert_eq!(call.stage, Stage::ReplyPlaying);
    let replacement = call.submit(10_003);
    call.dispatched(first, 10_004);
    assert_eq!(call.delivery, Some(Delivery::Queued));
    call.dispatched(replacement, 10_005);
    assert_eq!(call.delivery, Some(Delivery::Dispatched));
}

#[test]
fn queued_drain_effect_is_scoped_to_the_completed_generation() {
    let mut call = Coordinator::default();
    call.binding(true, 0);
    let completed = call.submit(0);
    call.dispatched(completed, 0);
    call.observed(0);
    call.completed(0);
    let replacement = call.submit(1);
    call.observed(1);
    call.reply(speech("New answer."), 1);
    let effects = call.take_effects();
    assert!(effects.contains(&Effect::Drained(completed)));
    assert!(!effects.contains(&Effect::Drained(replacement)));
    assert_eq!(call.stage, Stage::ReplyPlaying);
}

#[test]
fn single_utterance_platform_waits_for_pcm_drain_and_stuck_startup_is_bounded() {
    let mut call = Coordinator::default();
    call.set_playback_capacity(1);
    call.binding(true, 0);
    call.submit(0);
    call.observed(0);
    call.reply(speech("First."), 0);
    call.reply(speech("Second."), 0);
    let Effect::Start(lease) = call.take_effects()[0] else {
        panic!("playback start");
    };
    call.started(lease, 1);
    let effects = call.take_effects();
    assert_eq!(effects.len(), 1);
    let Effect::Speak(_, chunk, _) = effects[0] else {
        panic!("one utterance");
    };
    call.played(lease, chunk, 2);
    assert!(
        matches!(call.take_effects().as_slice(), [Effect::Speak(_, _, text)] if text.text == "Second.")
    );
    call.cancel();
    call.submit(3);
    call.observed(3);
    call.reply(speech("Never starts."), 3);
    call.tick(60_003);
    assert_eq!(call.stage, Stage::Failed);
}
