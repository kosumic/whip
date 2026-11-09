use super::*;
use serde_json::json;
type TestResult = Result<(), Box<dyn std::error::Error>>;

fn call(scope: &str, mode: &str) -> Result<SavedCall, serde_json::Error> {
    serde_json::from_value(json!({
        "id":"original", "model":"gpt-realtime-1.5", "endedAtMs":20,
        "usage":{"session_id":"original", "provider":"openai", "mode":mode,
            "model":"gpt-realtime-1.5", "voice":"marin", "scope":scope, "started_at_ms":10},
        "fragments":[{"id":"user", "role":"user", "text":"My project is called Orion."},
            {"id":"assistant", "role":"assistant", "text":"I will remember Orion."},
            {"id":"old-tool-id", "role":"assistant", "text":"Old tool",
                "event":{"kind":"delegation", "name":"secret-tool", "status":"queued", "input":"DO NOT REPLAY"}}]
    }))
}

#[test]
fn global_realtime_and_live_restore_conversation_without_tool_work() -> TestResult {
    for mode in ["realtime", "live"] {
        let restored = prepare(call("global", mode)?)?;
        let context = restored.continuation;
        assert_eq!(context.context.len(), 2);
        assert_eq!(context.context[0].role, "user");
        assert_eq!(context.context[1].role, "assistant");
        let instructions = context.instructions("Current call policy")?;
        assert!(instructions.contains("Orion"));
        assert!(instructions.contains("Wait for new user input"));
        assert!(!instructions.contains("DO NOT REPLAY"));
        assert!(!instructions.contains("old-tool-id"));
        assert!(!instructions.contains("secret-tool"));
        assert!(!context.truncated);
    }
    Ok(())
}

#[test]
fn unsupported_calls_and_missing_transcripts_or_targets_cannot_resume() -> TestResult {
    for (scope, mode) in [
        ("agent", "realtime"),
        ("agent", "live"),
        ("global", "turn_based"),
        ("speech", "tts"),
        ("speech", "stt"),
        ("preview", "realtime"),
        ("terminal", "live"),
    ] {
        assert!(prepare(call(scope, mode)?).is_err());
    }
    assert!(prepare(call("terminal", "realtime")?).is_err());
    let mut missing = call("global", "realtime")?;
    missing.fragments.clear();
    assert!(prepare(missing).is_err());
    let mut no_speech = call("global", "live")?;
    no_speech
        .fragments
        .retain(|caption| caption.event.is_some());
    assert!(prepare(no_speech).is_err());
    let mut legacy = call("global", "live")?;
    legacy.usage = None;
    assert!(prepare(legacy).is_err());
    Ok(())
}

#[test]
fn deleted_or_missing_archive_ids_fail_without_selecting_another_conversation() -> TestResult {
    let saved = serde_json::to_string(&vec![call("global", "realtime")?])?;
    assert!(from_archive(Some(&saved), "original").is_ok());
    assert!(from_archive(Some(&saved), "different-call").is_err());
    assert!(from_archive(None, "original").is_err());
    assert!(from_archive(Some("not valid JSON"), "original").is_err());
    let deleted = super::super::remove(Some(&saved), None, "original")?;
    assert!(from_archive(Some(&deleted), "original").is_err());
    Ok(())
}

#[test]
fn context_is_bounded_in_unicode_bytes_and_latest_messages_with_explicit_truncation() -> TestResult
{
    let mut saved = call("global", "realtime")?;
    let mut caption = saved.fragments[0].clone();
    caption.text = "猫".repeat(MAX_CONTEXT_TEXT);
    saved.fragments = vec![caption; MAX_CONTEXT_MESSAGES * 2];
    saved.fragments.last_mut().ok_or("no last message")?.text = "Latest follow-up".into();
    let restored = prepare(saved)?;
    let context = restored.continuation;
    assert!(context.truncated);
    assert!(context.context.len() <= MAX_CONTEXT_MESSAGES);
    assert!(
        context
            .context
            .iter()
            .map(|caption| caption.text.len())
            .sum::<usize>()
            <= MAX_CONTEXT_BYTES
    );
    assert!(
        context
            .context
            .iter()
            .all(|caption| caption.text.len() <= MAX_CONTEXT_TEXT)
    );
    assert_eq!(
        context.context.last().ok_or("no context")?.text,
        "Latest follow-up"
    );
    assert!(
        context
            .instructions("Policy")?
            .contains("Context truncated: true")
    );
    Ok(())
}

#[test]
fn resuming_again_keeps_prior_context_and_preserves_original_history() -> TestResult {
    let original = call("global", "live")?;
    let before = serde_json::to_value(&original)?;
    let context = prepare(call("global", "live")?)?.continuation;
    let mut resumed = call("global", "live")?;
    resumed.id = "new-call".into();
    resumed
        .usage
        .as_mut()
        .ok_or("no usage")?
        .session_id
        .clone_from(&resumed.id);
    resumed.fragments.truncate(1);
    resumed.fragments[0].text = "What was my project called?".into();
    resumed.continuation = Some(context);
    let saved = super::super::append(
        Some(&serde_json::to_string(&vec![original])?),
        None,
        resumed,
    )?;
    let mut calls: Vec<SavedCall> = serde_json::from_str(&saved)?;
    assert_eq!(calls.len(), 2);
    assert_eq!(serde_json::to_value(&calls[0])?, before);
    assert_ne!(calls[0].id, calls[1].id);
    let again = prepare(calls.pop().ok_or("no resumed call")?)?.continuation;
    assert!(again.instructions("Policy")?.contains("Orion"));
    assert_eq!(
        again.context.last().ok_or("no follow-up")?.text,
        "What was my project called?"
    );
    Ok(())
}
