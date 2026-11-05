use super::*;
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn event(kind: &str, fields: Value) -> Result<ServerEvent, Box<dyn std::error::Error>> {
    let mut value = json!({"type":kind,"event_id":"event","response_id":"response","item_id":"reply","output_index":0,"content_index":0});
    value
        .as_object_mut()
        .ok_or("event object")?
        .extend(fields.as_object().ok_or("fields object")?.clone());
    let event: ServerEvent = serde_json::from_value(value)?;
    if matches!(event, ServerEvent::Unknown(_)) {
        return Err("invalid event fixture".into());
    }
    Ok(event)
}

fn delta(text: &str) -> Result<ServerEvent, Box<dyn std::error::Error>> {
    event(
        "response.output_audio_transcript.delta",
        json!({"delta":text}),
    )
}

#[test]
fn long_streaming_reply_learns_rate_before_the_turn_finishes() -> TestResult {
    let mut transcript = Transcript::default();
    let ignored = HashSet::new();
    let full = "aaaa ".repeat(110);
    let mut available = 0;
    let mut previous = 0;
    for step in 1..=200 {
        let played = step * super::super::RATE / 10;
        transcript.audio("reply", 0, played + super::super::RATE / 5);
        let next = (step * 5 / 2 + 10).min(full.len());
        transcript.observe(&delta(&full[available..next])?, &ignored);
        available = next;
        // Text and audio arrival alone must never advance the highlight.
        assert_eq!(transcript.snapshot()[0].spoken_utf16, previous);
        transcript.played("reply", 0, played);
        let message = &transcript.snapshot()[0];
        assert!(message.active);
        assert!(message.spoken_utf16 >= previous);
        if step >= 80 {
            assert!(message.spoken_utf16.abs_diff(step * 5 / 2) <= 6);
        }
        previous = message.spoken_utf16;
    }
    Ok(())
}

#[test]
fn captions_follow_playback_not_arrival_and_preserve_previous_turns() -> TestResult {
    let mut output = super::super::Output::default();
    output
        .transcript
        .observe(&delta("Hello world")?, &HashSet::new());
    output.append("reply".into(), 0, vec![0; super::super::RATE * 4])?;
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, 0);
    let mut pcm = vec![0; super::super::RATE * 2];
    output.read(&mut pcm);
    output.acknowledge(output.epoch, super::super::RATE / 4);
    let streaming = output.transcript.snapshot()[0].spoken_utf16;
    assert!(streaming > 0);
    output.transcript.observe(
        &event("response.output_audio.done", json!({}))?,
        &HashSet::new(),
    );
    output.transcript.observe(
        &event(
            "response.output_audio_transcript.done",
            json!({"transcript":"Hello world"}),
        )?,
        &HashSet::new(),
    );
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, streaming);
    assert!(output.transcript.snapshot()[0].active);
    output.acknowledge(output.epoch, super::super::RATE * 2);
    assert!(!output.transcript.snapshot()[0].active);
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, 11);
    output.append("next".into(), 0, vec![0; 100])?;
    output.transcript.observe(
        &event(
            "response.output_audio_transcript.delta",
            json!({"item_id":"next","delta":"New reply"}),
        )?,
        &HashSet::new(),
    );
    let messages = output.transcript.snapshot();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].text, "Hello world");
    assert_eq!(messages[1].spoken_utf16, 0);
    Ok(())
}

#[test]
fn interrupted_audio_freezes_cursor_and_ignores_stale_playback() -> TestResult {
    let mut output = super::super::Output::default();
    output.append("reply".into(), 0, vec![0; super::super::RATE * 4])?;
    output
        .transcript
        .observe(&delta("Hello world")?, &HashSet::new());
    output.transcript.observe(
        &event("response.output_audio.done", json!({}))?,
        &HashSet::new(),
    );
    output.transcript.observe(
        &event(
            "response.output_audio_transcript.done",
            json!({"transcript":"Hello world"}),
        )?,
        &HashSet::new(),
    );
    output.read(&mut vec![0; super::super::RATE * 2]);
    let old_epoch = output.epoch;
    output.acknowledge(old_epoch, super::super::RATE / 4);
    let before = output.transcript.snapshot()[0].spoken_utf16;
    let truncation = output.interrupt().ok_or("missing truncation")?;
    assert_eq!(serde_json::to_value(truncation)?["audio_end_ms"], 250);
    let frozen = output.transcript.snapshot()[0].spoken_utf16;
    assert!(frozen >= before);
    output.acknowledge(old_epoch, super::super::RATE * 2);
    let messages = output.transcript.snapshot();
    assert_eq!(messages[0].spoken_utf16, frozen);
    assert!(!messages[0].active);
    let ignored = HashSet::from(["response".into()]);
    output.transcript.observe(&delta(" ignored")?, &ignored);
    assert_eq!(output.transcript.snapshot()[0].text, "Hello world");
    Ok(())
}

#[test]
fn early_sentences_are_not_timed_against_the_first_small_audio_packet() -> TestResult {
    let text = "First sentence arrives early. Second sentence is still queued. Third sentence has not been spoken.";
    let mut output = super::super::Output::default();
    let ignored = HashSet::new();
    output.transcript.observe(&delta(text)?, &ignored);
    output.append("reply".into(), 0, vec![0; super::super::RATE / 5])?;
    output.read(&mut vec![0; super::super::RATE / 10]);
    output.acknowledge(output.epoch, super::super::RATE / 10);
    // Only 100ms was heard. The old estimator marked all three sentences spoken.
    assert!(output.transcript.snapshot()[0].spoken_utf16 <= 2);
    assert!(output.transcript.snapshot()[0].active);
    output.append(
        "reply".into(),
        0,
        vec![0; super::super::RATE * 16 - super::super::RATE / 5],
    )?;
    output.read(&mut vec![0; super::super::RATE]);
    output.acknowledge(output.epoch, super::super::RATE / 2);
    let streaming = output.transcript.snapshot()[0].spoken_utf16;
    assert!(streaming > 0 && streaming <= 8);
    output
        .transcript
        .observe(&event("response.output_audio.done", json!({}))?, &ignored);
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, streaming);
    output.transcript.observe(
        &event(
            "response.output_audio_transcript.done",
            json!({"transcript":text}),
        )?,
        &ignored,
    );
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, streaming);
    assert!(output.transcript.snapshot()[0].active);
    Ok(())
}

#[test]
fn caption_timing_is_independent_of_text_audio_packet_interleaving() -> TestResult {
    let ignored = HashSet::new();
    let mut early_text = Transcript::default();
    let mut interleaved = Transcript::default();
    let text = "Same words. Same audio duration. Same playback position.";
    early_text.observe(&delta(text)?, &ignored);
    early_text.audio("reply", 0, super::super::RATE / 10);
    early_text.audio("reply", 0, super::super::RATE * 4);
    interleaved.audio("reply", 0, super::super::RATE);
    interleaved.observe(&delta("Same words. ")?, &ignored);
    interleaved.audio("reply", 0, super::super::RATE * 3);
    interleaved.observe(
        &delta("Same audio duration. Same playback position.")?,
        &ignored,
    );
    interleaved.audio("reply", 0, super::super::RATE * 4);
    for transcript in [&mut early_text, &mut interleaved] {
        transcript.observe(
            &event(
                "response.output_audio_transcript.done",
                json!({"transcript":text}),
            )?,
            &ignored,
        );
        transcript.played("reply", 0, super::super::RATE / 4);
        let streaming = transcript.snapshot()[0].spoken_utf16;
        assert!(streaming > 0 && streaming <= 4);
        transcript.observe(&event("response.output_audio.done", json!({}))?, &ignored);
        assert_eq!(transcript.snapshot()[0].spoken_utf16, streaming);
    }
    for played in [
        super::super::RATE / 2,
        super::super::RATE,
        super::super::RATE * 2,
        super::super::RATE * 4,
    ] {
        early_text.played("reply", 0, played);
        interleaved.played("reply", 0, played);
        assert_eq!(
            early_text.snapshot()[0].spoken_utf16,
            interleaved.snapshot()[0].spoken_utf16
        );
    }
    assert_eq!(early_text.snapshot()[0].spoken_utf16, text.len());
    assert!(!early_text.snapshot()[0].active);
    Ok(())
}

#[test]
fn delayed_bilingual_input_keeps_original_conversation_order() -> TestResult {
    let mut transcript = Transcript::default();
    let ignored = HashSet::new();
    transcript.observe(
        &event(
            "input_audio_buffer.speech_started",
            json!({"item_id":"question","audio_start_ms":0}),
        )?,
        &ignored,
    );
    transcript.observe(&delta("Answer")?, &ignored);
    transcript.observe(
        &event(
            "conversation.item.input_audio_transcription.delta",
            json!({"item_id":"question","delta":"Hello 你好"}),
        )?,
        &ignored,
    );
    transcript.observe(&event("conversation.item.input_audio_transcription.completed", json!({"item_id":"question","transcript":"Hello 你好!","usage":{"type":"tokens","total_tokens":0,"input_tokens":0,"output_tokens":0,"input_token_details":{"text_tokens":0,"audio_tokens":0}}}))?, &ignored);
    let messages = transcript.snapshot();
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].text, "Hello 你好!");
    assert_eq!(messages[1].text, "Answer");
    Ok(())
}

#[test]
fn saved_captions_survive_hangup_with_final_text_and_without_playback_metadata() -> TestResult {
    let mut output = super::super::Output::default();
    let ignored = HashSet::new();
    output.transcript.observe(
        &event(
            "input_audio_buffer.speech_started",
            json!({"item_id":"question","audio_start_ms":0}),
        )?,
        &ignored,
    );
    output.transcript.observe(
        &event(
            "conversation.item.input_audio_transcription.delta",
            json!({"item_id":"question","delta":"Hello 你好"}),
        )?,
        &ignored,
    );
    output.transcript.observe(&event("conversation.item.input_audio_transcription.completed", json!({"item_id":"question","transcript":"Hello 你好!","usage":{"type":"tokens","total_tokens":0,"input_tokens":0,"output_tokens":0,"input_token_details":{"text_tokens":0,"audio_tokens":0}}}))?, &ignored);
    output.transcript.observe(
        &event(
            "response.output_audio_transcript.done",
            json!({"transcript":"Hi back 👋"}),
        )?,
        &ignored,
    );
    output.clear();
    let saved = serde_json::to_value(output.transcript.saved_captions())?;
    assert_eq!(
        saved,
        json!([
            {"id":"user:question", "role":"user", "text":"Hello 你好!"},
            {"id":"assistant:reply:0", "role":"assistant", "text":"Hi back 👋"},
        ])
    );
    Ok(())
}

#[test]
fn tool_and_delegation_rows_update_once_and_do_not_become_speech_or_handoff_context() -> TestResult
{
    let mut transcript = Transcript::default();
    let mut request = crate::voice_history::Event::new("delegation", "background_agent", "running");
    request.input = Some("Check the build".into());
    transcript.event("call", request);
    transcript.event_result("call", &json!({"completion":"submitted","accepted":true}));
    transcript.event(
        "call",
        crate::voice_history::Event::new("delegation", "background_agent", "requested"),
    );
    assert_eq!(transcript.snapshot().len(), 1);
    assert_eq!(
        transcript.snapshot()[0]
            .event
            .as_ref()
            .ok_or("missing event")?
            .status,
        "submitted"
    );
    assert_eq!(transcript.snapshot()[0].spoken_utf16, 0);
    assert!(transcript.delegation_snapshot().is_empty());
    let saved = serde_json::to_value(transcript.saved_captions())?;
    assert_eq!(saved[0]["event"]["kind"], "delegation");
    assert!(
        saved[0]["event"]["output"]
            .as_str()
            .ok_or("no result")?
            .contains("submitted")
    );
    Ok(())
}

#[test]
fn utf16_cursor_matches_javascript_and_text_after_audio_completion() -> TestResult {
    let mut transcript = Transcript::default();
    transcript.audio("reply", 0, 100);
    transcript.played("reply", 0, 100);
    transcript.observe(
        &event("response.output_audio.done", json!({}))?,
        &HashSet::new(),
    );
    transcript.observe(
        &event(
            "response.output_audio_transcript.done",
            json!({"transcript":"Hi 👋 你好"}),
        )?,
        &HashSet::new(),
    );
    let message = &transcript.snapshot()[0];
    assert_eq!(message.spoken_utf16, "Hi 👋 你好".encode_utf16().count());
    assert!(!message.active);
    Ok(())
}

#[test]
fn terminal_job_admission_is_not_reported_as_command_completion() -> TestResult {
    let mut transcript = Transcript::default();
    transcript.event(
        "job",
        crate::voice_history::Event::new("tool", "terminal_exec", "requested"),
    );
    transcript.event_result("job", &json!({"job_id":"job","completion":"running"}));
    assert_eq!(
        transcript.snapshot()[0]
            .event
            .as_ref()
            .ok_or("missing event")?
            .status,
        "running"
    );
    transcript.event_result(
        "job",
        &json!({"completion":"finished","result":{"exit_code":0}}),
    );
    assert_eq!(
        transcript.snapshot()[0]
            .event
            .as_ref()
            .ok_or("missing event")?
            .status,
        "completed"
    );
    Ok(())
}

#[test]
fn long_calls_and_messages_are_bounded() -> TestResult {
    let mut transcript = Transcript::default();
    for index in 0..100 {
        transcript.observe(&event("response.output_audio_transcript.delta", json!({"item_id":format!("{index}"),"delta":"x".repeat(super::super::MAX_TEXT * 2)}))?, &HashSet::new());
    }
    let messages = transcript.snapshot();
    assert!(messages.len() <= MAX_MESSAGES);
    assert!(
        messages
            .iter()
            .map(|message| message.text.len())
            .sum::<usize>()
            <= MAX_BYTES
    );
    assert!(
        messages
            .iter()
            .all(|message| message.text.len() <= super::super::MAX_TEXT)
    );
    Ok(())
}
