use super::*;
use serde_json::{Value, json};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
fn event(value: Value) -> TestResult<ServerEvent> {
    let event: ServerEvent = serde_json::from_value(value)?;
    if matches!(&event, ServerEvent::Unknown(_)) {
        return Err("Invalid provider-event fixture".into());
    }
    Ok(event)
}
fn confirmed(model: &str) -> TestResult<CurrentChat> {
    let mut chat = CurrentChat::default();
    chat.observe(&event(json!({"type":"session.updated","event_id":"session-event","session":{"id":"session","object":"realtime.session","expires_at":4_000_000_000_u64,"type":"realtime","model":model,"output_modalities":["audio"]}}))?);
    Ok(chat)
}
fn usage() -> Value {
    json!({"total_tokens":3500,"input_tokens":3000,"output_tokens":500,
        "input_token_details":{"text_tokens":1000,"audio_tokens":2000,"image_tokens":0,"cached_tokens":700,"cached_tokens_details":{"text_tokens":200,"audio_tokens":500,"image_tokens":0}},
        "output_token_details":{"text_tokens":100,"audio_tokens":400}})
}
fn response(kind: &str, id: &str, usage: Value) -> TestResult<ServerEvent> {
    let status = match kind {
        "response.created" => "in_progress",
        "response.cancelled" => "cancelled",
        _ => "completed",
    };
    event(
        json!({"type":kind,"event_id":"response-event","response":{"id":id,"object":"realtime.response","status":status,"output":[],"usage":usage}}),
    )
}
fn estimate(chat: &CurrentChat, expected: f64) -> TestResult {
    assert!((chat.estimated_usd().ok_or("missing estimate")? - expected).abs() < 1e-10);
    Ok(())
}

#[test]
fn charges_audio_text_and_cached_input_at_their_own_rates() -> TestResult {
    let mut chat = confirmed(super::super::MODEL)?;
    chat.observe(&response("response.done", "one", usage())?);
    // 800 text + 1500 audio uncached; 700 cached; 100 text + 400 audio output.
    estimate(&chat, 0.07868)
}

#[test]
fn combines_all_responses_and_separately_billed_transcription_without_replay() -> TestResult {
    let mut chat = confirmed(super::super::MODEL)?;
    let reply = response("response.done", "same-id", usage())?;
    chat.observe(&reply);
    chat.observe(&reply);
    chat.observe(&response("response.cancelled", "same-id", usage())?);
    estimate(&chat, 0.07868)?;
    chat.observe(&response("response.done", "second", usage())?);
    let transcript = event(
        json!({"type":"conversation.item.input_audio_transcription.completed","event_id":"caption-event","item_id":"same-id","content_index":0,"transcript":"private caption","usage":{"type":"tokens","input_tokens":200,"output_tokens":10,"total_tokens":210}}),
    )?;
    chat.observe(&transcript);
    chat.observe(&transcript);
    estimate(&chat, 0.15766)
}

#[test]
fn a_final_usage_report_replaces_the_same_responses_earlier_report() -> TestResult {
    let mut chat = confirmed(super::super::MODEL)?;
    chat.observe(&response("response.cancelled", "one", usage())?);
    let mut final_usage = usage();
    final_usage["output_tokens"] = json!(600);
    final_usage["total_tokens"] = json!(3600);
    final_usage["output_token_details"]["audio_tokens"] = json!(500);
    chat.observe(&response("response.done", "one", final_usage)?);
    chat.observe(&response("response.created", "one", json!(null))?);
    estimate(&chat, 0.08508)
}

#[test]
fn unknown_or_inconsistent_usage_never_becomes_a_zero_cost_estimate() -> TestResult {
    for invalid in [
        json!(null),
        json!({"total_tokens":3500,"input_tokens":3000,"output_tokens":500}),
        {
            let mut value = usage();
            value["input_token_details"]["cached_tokens_details"] = json!(null);
            value
        },
        {
            let mut value = usage();
            value["input_token_details"]["audio_tokens"] = json!(1);
            value
        },
        {
            let mut value = usage();
            value["input_token_details"]["cached_tokens_details"]["audio_tokens"] = json!(2500);
            value
        },
    ] {
        let mut chat = confirmed(super::super::MODEL)?;
        chat.observe(&response("response.done", "known", usage())?);
        chat.observe(&response("response.done", "missing", invalid)?);
        assert!(chat.estimated_usd().is_none());
    }
    Ok(())
}

#[test]
fn estimates_belong_to_one_call_and_require_a_supported_confirmed_model() -> TestResult {
    assert!(CurrentChat::default().estimated_usd().is_none());
    let mut first = confirmed("gpt-realtime-2025-08-28")?;
    estimate(&first, 0.0)?;
    first.observe(&response("response.done", "one", usage())?);
    estimate(&first, 0.07868)?;
    estimate(&confirmed(super::super::MODEL)?, 0.0)?;
    let mut unknown = confirmed("unknown-model")?;
    unknown.observe(&response("response.done", "one", usage())?);
    assert!(unknown.estimated_usd().is_none());
    Ok(())
}

#[test]
fn failed_transcription_and_accounting_overflow_remain_unknown() -> TestResult {
    let mut failed = confirmed(super::super::MODEL)?;
    failed.observe(&event(json!({"type":"conversation.item.input_audio_transcription.failed","event_id":"failure","item_id":"caption","content_index":0,"error":{"type":"transcription_error","code":"bad_audio","message":"test failure"}}))?);
    assert!(failed.estimated_usd().is_none());
    let mut chat = confirmed(super::super::MODEL)?;
    let mut invalid = usage();
    invalid["input_tokens"] = json!(u32::MAX);
    chat.observe(&response("response.done", "bad", invalid)?);
    assert!(chat.estimated_usd().is_none());
    let mut chat = confirmed(super::super::MODEL)?;
    for id in 0..=MAX_ITEMS {
        chat.observe(&response(
            "response.created",
            &format!("response-{id}"),
            json!(null),
        )?);
    }
    assert!(chat.estimated_usd().is_none());
    Ok(())
}
