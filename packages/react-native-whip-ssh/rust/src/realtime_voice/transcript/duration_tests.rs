use super::{Transcript, assistant_id};
use crate::realtime_voice::RATE;
use oai_rt_rs::ServerEvent;
use serde_json::json;
use std::collections::HashSet;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn delta(text: &str) -> Result<ServerEvent, serde_json::Error> {
    serde_json::from_value(
        json!({"type":"response.output_audio_transcript.delta","event_id":"delta",
        "response_id":"response","item_id":"reply","output_index":0,"content_index":0,"delta":text}),
    )
}

fn completion(text: &str, tokens: u32) -> serde_json::Value {
    json!({"type":"response.done","event_id":"done","response":{
        "id":"response","object":"realtime.response","status":"completed",
        "output":[{"type":"message","id":"reply","role":"assistant","content":[{"type":"audio","transcript":text}]}],
        "usage":{"total_tokens":tokens,"input_tokens":0,"output_tokens":tokens,
            "output_token_details":{"audio_tokens":tokens,"text_tokens":0}}
    }})
}

#[test]
fn early_complete_transcript_uses_generated_duration_before_playback_finishes() -> TestResult {
    let full = "aaaa ".repeat(100);
    let ignored = HashSet::new();
    let mut transcript = Transcript::default();
    transcript.observe(&delta(&full)?, &ignored);
    transcript.audio("reply", 0, RATE / 5);
    transcript.observe(&serde_json::from_value(completion(&full, 400))?, &ignored);
    assert_eq!(transcript.snapshot()[0].spoken_utf16, 0);
    let mut previous = 0;
    for step in 1..=200 {
        let played = step * RATE / 10;
        transcript.audio("reply", 0, (played + RATE / 5).min(RATE * 20));
        assert_eq!(transcript.snapshot()[0].spoken_utf16, previous);
        transcript.played("reply", 0, played);
        let message = &transcript.snapshot()[0];
        assert!(message.spoken_utf16 >= previous);
        assert!(message.spoken_utf16.abs_diff(step * 5 / 2) <= 6);
        previous = message.spoken_utf16;
    }
    transcript.finish_audio("reply", 0);
    assert_eq!(transcript.snapshot()[0].spoken_utf16, full.len());
    assert!(!transcript.snapshot()[0].active);
    Ok(())
}

#[test]
fn corrected_duration_waits_for_playback_and_does_not_jump_or_move_backwards() -> TestResult {
    let text = "aaaa ".repeat(100);
    let ignored = HashSet::new();
    let mut transcript = Transcript::default();
    transcript.observe(&delta(&text)?, &ignored);
    transcript.audio("reply", 0, RATE * 6);
    transcript.played("reply", 0, RATE * 5);
    let before = transcript.snapshot()[0].spoken_utf16;
    transcript.observe(&serde_json::from_value(completion(&text, 400))?, &ignored);
    assert_eq!(transcript.snapshot()[0].spoken_utf16, before);
    transcript.played("reply", 0, RATE * 5 + RATE / 50);
    let after = transcript.snapshot()[0].spoken_utf16;
    assert!(after >= before && after <= before + 1);
    transcript.finish_audio("reply", 0);
    assert!(transcript.snapshot()[0].spoken_utf16 >= after);
    Ok(())
}

#[test]
fn token_limited_audio_uses_the_duration_of_the_output_that_was_generated() -> TestResult {
    let text = "aaaa ".repeat(100);
    let mut transcript = Transcript::default();
    transcript.observe(&delta(&text)?, &HashSet::new());
    transcript.audio("reply", 0, RATE * 10);
    let mut done = completion(&text, 400);
    done["response"]["status"] = json!("incomplete");
    done["response"]["status_details"] = json!({"reason":"max_output_tokens"});
    transcript.observe(&serde_json::from_value(done)?, &HashSet::new());
    transcript.played("reply", 0, RATE * 5);
    assert!(transcript.snapshot()[0].spoken_utf16.abs_diff(125) <= 6);
    Ok(())
}

#[test]
fn ambiguous_missing_or_cancelled_duration_cannot_retime_another_turn() -> TestResult {
    let text = "aaaa ".repeat(100);
    let mut missing = completion(&text, 400);
    missing["response"]["usage"] = serde_json::Value::Null;
    let mut ambiguous = completion(&text, 400);
    let second = ambiguous["response"]["output"][0].clone();
    ambiguous["response"]["output"]
        .as_array_mut()
        .ok_or("output array")?
        .push(second);
    let mut cancelled = completion(&text, 400);
    cancelled["response"]["status"] = json!("cancelled");
    for value in [missing, ambiguous, cancelled] {
        let mut transcript = Transcript::default();
        transcript.observe(&delta(&text)?, &HashSet::new());
        transcript.audio("reply", 0, RATE * 2);
        transcript.observe(&serde_json::from_value(value)?, &HashSet::new());
        transcript.played("reply", 0, RATE);
        assert!(transcript.snapshot()[0].spoken_utf16 <= 14);
        assert_eq!(transcript.snapshot()[0].id, assistant_id("reply", 0));
    }
    let mut stopped = Transcript::default();
    stopped.observe(&delta(&text)?, &HashSet::new());
    stopped.audio("reply", 0, RATE * 2);
    stopped.stop();
    stopped.observe(
        &serde_json::from_value(completion("stale text", 400))?,
        &HashSet::new(),
    );
    assert_eq!(stopped.snapshot()[0].text, text);
    assert!(!stopped.snapshot()[0].active);
    Ok(())
}
