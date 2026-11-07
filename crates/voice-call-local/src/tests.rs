#![allow(
    clippy::unwrap_used,
    reason = "Unexpected policy errors must fail tests"
)]
use super::*;

fn call() -> Call {
    let mut call = Call::default();
    call.prepared(false);
    call
}

fn submit(call: &mut Call, text: &str) -> UserTurn {
    let input = call.view().input_id;
    call.recognition(input, text.into());
    call.finish();
    call.recognition_ended(input).unwrap().unwrap()
}

// Deterministic VAD confidence exercises policy independently of Earshot's
// acoustic model. PCM admission and real Earshot detection are tested separately.
fn confidence(call: &mut Call, probability: f32, frames: usize) {
    for _ in 0..frames {
        call.input.samples += 256;
        call.input.probability(probability, call.sensitivity);
    }
}

#[test]
fn synthetic_silence_and_empty_stt_never_dispatch() {
    let mut call = call();
    let input = call.view().input_id;
    for _ in 0..300 {
        assert!(!call.audio(input, &[0.0; 2048]));
    }
    assert_eq!(call.view().phase, Phase::Listening);
    assert!(!call.should_probe());
    call.recognition(input, "  ".into());
    call.finish();
    assert!(call.recognition_ended(input).unwrap().is_none());
    assert_ne!(call.view().input_id, input);
    assert!(call.take_prompt().is_none());
}

#[test]
fn pcm_admission_is_fenced_by_input_and_mute() {
    let mut call = call();
    let input = call.view().input_id;
    call.audio(input, &[0.25; 256]);
    assert_eq!(call.view().level, 0.25);
    call.set_muted(true);
    call.audio(input, &[1.0; 256]);
    assert_eq!(call.view().phase, Phase::Muted);
    assert_eq!(call.view().level, 0.0);
    call.set_muted(false);
    call.audio(input, &[1.0; 256]);
    assert_eq!(call.view().level, 0.0);
    call.audio(call.view().input_id, &[0.5; 256]);
    assert_eq!(call.view().level, 0.5);
}

#[test]
fn onset_and_eight_hundred_ms_silence_define_one_utterance() {
    let mut call = call();
    let input = call.view().input_id;
    confidence(&mut call, 0.95, 4);
    confidence(&mut call, 0.0, 49);
    call.audio(input, &[]);
    assert_eq!(call.view().phase, Phase::Listening);
    assert_eq!(call.silence_ms(), 784);
    confidence(&mut call, 0.0, 1);
    call.audio(input, &[]);
    assert_eq!(call.silence_ms(), 800);
    assert_eq!(call.view().phase, Phase::Finishing);
    call.recognition(input, "An utterance".into());
    assert!(call.recognition_ended(input).unwrap().is_some());
    assert_eq!(call.take_prompt().as_deref(), Some("An utterance"));
    assert!(call.recognition_ended(input).unwrap().is_none());
    assert!(call.take_prompt().is_none());
}

#[test]
fn maximum_utterance_forces_a_boundary_even_without_silence() {
    let mut call = call();
    confidence(&mut call, 0.95, 4 + 16_000 * 60 / 256);
    call.audio(call.view().input_id, &[]);
    assert_eq!(call.view().phase, Phase::Finishing);
}

#[test]
fn final_stt_before_a_boundary_cannot_dispatch_and_late_stt_cannot_resubmit() {
    let mut call = call();
    let input = call.view().input_id;
    call.recognition(input, "unfinished".into());
    assert!(call.recognition_ended(input).is_err());
    assert!(call.take_prompt().is_none());
    let turn = submit(&mut call, "  Finished  ");
    assert_eq!(turn.text, "Finished");
    assert_eq!(turn.input_id, input);
    call.recognition(input, "late final".into());
    assert!(call.recognition_ended(input).unwrap().is_none());
    assert_eq!(call.take_prompt().as_deref(), Some("Finished"));
    assert!(call.take_prompt().is_none());
}

#[test]
fn mute_discards_unconfirmed_turns_and_unchanged_notifications_preserve_input() {
    let mut call = call();
    let input = call.view().input_id;
    call.recognition(input, "do not send".into());
    call.finish();
    call.set_muted(false);
    assert_eq!(call.view().input_id, input);
    assert_eq!(call.view().phase, Phase::Finishing);
    call.set_muted(true);
    let muted_input = call.view().input_id;
    call.set_muted(true);
    assert_eq!(call.view().input_id, muted_input);
    call.recognition(input, "late final".into());
    assert!(call.recognition_ended(input).unwrap().is_none());
    assert!(call.take_prompt().is_none());
    assert_eq!(call.view().text, "");
    call.set_muted(false);
    assert_eq!(call.view().phase, Phase::Listening);
}

#[test]
fn sensitivity_survives_new_turns_and_mute() {
    let mut call = call();
    call.set_vad_sensitivity(75);
    call.finish();
    call.recognition_ended(call.view().input_id).unwrap();
    call.set_muted(true);
    call.set_muted(false);
    confidence(&mut call, 0.5, 4);
    confidence(&mut call, 0.0, 50);
    call.audio(call.view().input_id, &[]);
    assert_eq!(call.view().phase, Phase::Finishing);
}

#[test]
fn recognized_barge_in_preserves_first_words_and_fences_the_old_assistant() {
    for speaking in [false, true] {
        let mut call = call();
        let old = submit(&mut call, "Hello");
        call.take_prompt();
        if speaking {
            call.assistant_progress(old.generation, false, true);
        }
        let input = call.view().input_id;
        confidence(&mut call, 0.95, 16);
        assert!(!call.audio(input, &[])); // VAD alone never interrupts
        assert!(call.recognition(input, "Actually stop".into()));
        assert_eq!(call.view().phase, Phase::Listening);
        assert_eq!(call.view().input_id, input);
        assert_eq!(call.view().text, "Actually stop");
        call.assistant_progress(old.generation, true, true);
        call.playback_ended(old.generation, false);
        assert_eq!(call.view().phase, Phase::Listening);
        call.finish();
        let next = call.recognition_ended(input).unwrap().unwrap();
        assert_ne!(next.generation, old.generation);
        assert_eq!(call.take_prompt().as_deref(), Some("Actually stop"));
    }
}

#[test]
fn recognition_before_audio_can_confirm_barge_in_and_old_noise_expires() {
    let mut call = call();
    submit(&mut call, "Hello");
    let input = call.view().input_id;
    assert!(!call.recognition(input, "Stop".into()));
    confidence(&mut call, 0.95, 16);
    assert!(call.audio(input, &[]));
    assert_eq!(call.view().text, "Stop");

    submit(&mut call, "Again");
    let input = call.view().input_id;
    confidence(&mut call, 0.95, 16);
    confidence(&mut call, 0.0, 126);
    assert!(!call.recognition(input, "noise".into()));
    assert_eq!(call.view().phase, Phase::Waiting);
}

#[test]
fn mute_during_a_reply_disables_barge_in_without_cancelling_generation() {
    let mut call = call();
    let turn = submit(&mut call, "Hello");
    call.assistant_progress(turn.generation, false, true);
    call.set_muted(true);
    let input = call.view().input_id;
    confidence(&mut call, 0.95, 16);
    assert!(!call.recognition(input, "stop".into()));
    assert_eq!(call.view().phase, Phase::Speaking);
    call.assistant_progress(turn.generation, true, false);
    call.playback_ended(turn.generation, false);
    assert_eq!(call.view().phase, Phase::Muted);
}

#[test]
fn generation_completion_and_playback_drain_are_separate_gates() {
    let mut call = call();
    let turn = submit(&mut call, "Hello");
    call.assistant_progress(turn.generation, false, true);
    let input = call.view().input_id;
    call.playback_ended(turn.generation, false); // gap between text segments
    assert!(!call.speech_finished(false));
    assert_eq!(call.view().phase, Phase::Speaking);
    call.assistant_progress(turn.generation, true, true);
    call.playback_ended(turn.generation, true); // queued/in-flight speech remains
    assert!(!call.speech_finished(true));
    assert_eq!(call.view().phase, Phase::Speaking);
    assert!(call.speech_finished(false));
    call.recognition(input, "next first words".into());
    call.playback_ended(turn.generation, false);
    assert_eq!(call.view().phase, Phase::Listening);
    assert_eq!(call.view().input_id, input);
    assert_eq!(call.view().text, "next first words");
}

#[test]
fn skip_waits_for_generation_and_replacement_fences_old_progress_and_drain() {
    let mut call = call();
    let old = submit(&mut call, "Hello");
    call.assistant_progress(old.generation, false, true);
    call.skip_response();
    assert_eq!(call.view().phase, Phase::Waiting);
    call.assistant_progress(old.generation, false, false);
    assert_eq!(call.view().phase, Phase::Waiting);
    let new = call.submit_text("Replacement").unwrap().unwrap();
    assert!(call.take_prompt().is_none()); // host already dispatched typed text
    call.assistant_progress(old.generation, true, true);
    call.playback_ended(old.generation, false);
    assert_eq!(call.view().phase, Phase::Waiting);
    assert!(!call.view().response_completed);
    call.assistant_progress(new.generation, false, true);
    call.skip_response();
    call.assistant_progress(new.generation, true, false);
    assert_eq!(call.view().phase, Phase::Listening);
}

#[test]
fn silent_completed_assistant_and_skipping_completed_speech_release_input() {
    let mut call = call();
    let turn = submit(&mut call, "Hello");
    call.assistant_progress(turn.generation, true, false);
    assert_eq!(call.view().phase, Phase::Listening);
    let turn = submit(&mut call, "Again");
    call.assistant_progress(turn.generation, true, true);
    call.skip_response();
    assert_eq!(call.view().phase, Phase::Listening);
}

#[test]
fn preparation_replaces_input_and_close_is_terminal_for_late_events() {
    let mut call = call();
    let input = call.view().input_id;
    call.begin_preparation();
    call.recognition(input, "stale".into());
    assert_eq!(call.view().text, "");
    call.use_vad();
    let turn = submit(&mut call, "Hello");
    call.close();
    let closed_input = call.view().input_id;
    call.close();
    call.listen();
    call.prepared(true);
    call.begin_preparation();
    call.use_vad();
    call.finish();
    call.skip_response();
    call.assistant_progress(turn.generation, true, true);
    call.playback_ended(turn.generation, false);
    assert!(call.submit_text("late").unwrap().is_none());
    assert_eq!(call.view().phase, Phase::Closed);
    assert_eq!(call.view().input_id, closed_input);
    assert!(call.take_prompt().is_none());
}

#[cfg(feature = "smart-turn")]
#[test]
fn optional_probe_rejects_resumed_speech_mute_and_replacement() {
    let mut call = call();
    call.prepared(true);
    let input = call.view().input_id;
    confidence(&mut call, 0.95, 4);
    confidence(&mut call, 0.0, 16);
    let probe = call.begin_probe(input).unwrap();
    confidence(&mut call, 0.4, 1);
    call.complete_probe(&probe, 0.99);
    assert_eq!(call.view().phase, Phase::Listening);
    confidence(&mut call, 0.0, 32);
    let probe = call.begin_probe(input).unwrap();
    call.set_muted(true);
    call.set_muted(false);
    call.complete_probe(&probe, 0.99);
    assert_eq!(call.view().phase, Phase::Listening);
    confidence(&mut call, 0.95, 4);
    confidence(&mut call, 0.0, 16);
    let probe = call.begin_probe(call.view().input_id).unwrap();
    call.complete_probe(&probe, 0.99);
    assert_eq!(call.view().phase, Phase::Finishing);
}

#[cfg(feature = "smart-turn")]
#[test]
fn optional_probe_uses_a_bounded_pcm_window_and_sensitivity_fences_its_verdict() {
    let mut call = call();
    call.prepared(true);
    let input = call.view().input_id;
    call.audio(input, &vec![0.0; SMART_TURN_AUDIO_SAMPLES + 256]);
    confidence(&mut call, 0.95, 4);
    confidence(&mut call, 0.0, 16);
    let probe = call.begin_probe(input).unwrap();
    assert_eq!(probe.audio.len(), SMART_TURN_AUDIO_SAMPLES);
    call.set_vad_sensitivity(75);
    call.complete_probe(&probe, 0.99);
    assert_eq!(call.view().phase, Phase::Listening);
    confidence(&mut call, 0.0, 32);
    let probe = call.begin_probe(input).unwrap();
    call.close();
    call.complete_probe(&probe, 0.99);
    assert_eq!(call.view().phase, Phase::Closed);
}
