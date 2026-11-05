use super::*;
use crate::host_runtime::realtime_agent::Delegation;

#[test]
fn global_voice_configuration_has_an_explicit_exclusive_scope_and_no_remote_authority()
-> Result<(), Box<dyn std::error::Error>> {
    let mut value = json!({"global":true,"voice":"cedar","vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}});
    let config: Config = serde_json::from_value(value.clone())?;
    let session = serde_json::to_value(config.session_update()?)?;
    let names: Vec<_> = session["session"]["tools"]
        .as_array()
        .ok_or("No tools")?
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"hosts_list"));
    assert!(names.contains(&"app_navigate"));
    assert!(names.contains(&"herdr_delegate"));
    assert!(!names.contains(&"background_agent"));
    assert!(!names.contains(&"terminal_exec"));
    assert!(!names.contains(&"device_shizuku_exec"));
    assert!(!names.contains(&"browser_eval"));
    assert!(!names.contains(&"device_shizuku_status"));
    let mut privileged = value.clone();
    privileged["globalShizukuAccess"] = json!(true);
    let enabled = serde_json::to_value(
        serde_json::from_value::<Config>(privileged.clone())?.session_update()?,
    )?;
    let exec = enabled["session"]["tools"]
        .as_array()
        .ok_or("No tools")?
        .iter()
        .find(|tool| tool["name"] == "device_shizuku_exec")
        .ok_or("No Shizuku exec")?;
    assert_eq!(exec["parameters"]["required"], json!(["argv"]));
    privileged["global"] = json!(false);
    assert!(
        serde_json::from_value::<Config>(privileged)?
            .session_update()
            .is_err()
    );
    value["target"] = json!({"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"});
    assert!(
        serde_json::from_value::<Config>(value.clone())?
            .session_update()
            .is_err()
    );
    value["global"] = json!(false);
    let agent =
        serde_json::to_value(serde_json::from_value::<Config>(value.clone())?.session_update()?)?;
    assert!(
        !agent["session"]["tools"]
            .as_array()
            .ok_or("No agent tools")?
            .iter()
            .any(|tool| tool["name"] == "hosts_list")
    );
    value["global"] = json!(true);
    value["target"] = Value::Null;
    value["preview"] = json!(true);
    assert!(
        serde_json::from_value::<Config>(value)?
            .session_update()
            .is_err()
    );
    let typed = serde_json::to_value(global_submitted_message("Show saved hosts")?)?;
    assert_eq!(typed["item"]["content"][0]["text"], "Show saved hosts");
    Ok(())
}

#[test]
fn acknowledgement_can_speak_during_a_pending_tool_and_results_take_priority()
-> Result<(), Box<dyn std::error::Error>> {
    let now = Instant::now();
    let mut handoff = feedback::Handoff::new("call".into(), "original".into(), None, false, now);
    let mut queue = response::ResponseCreateQueue::default();
    queue.mark_started("original".into());
    assert!(next_response(&queue, Some(&mut handoff), now)?.is_none());
    queue.mark_finished("original");
    let event = serde_json::to_value(
        next_response(&queue, Some(&mut handoff), now)?.ok_or("missing acknowledgement")?,
    )?;
    assert_eq!(event["response"]["tool_choice"], "auto");
    queue.mark_requested();
    assert!(next_response(&queue, Some(&mut handoff), now)?.is_none());
    queue.mark_started("acknowledgement".into());
    queue.request_create(); // The actual tool result arrived while audio plays.
    assert!(next_response(&queue, None, now)?.is_none());
    queue.mark_finished("acknowledgement");
    assert!(matches!(
        next_response(&queue, None, now)?,
        Some(ClientEvent::ResponseCreate { response: None, .. })
    ));
    queue.mark_requested();
    assert!(next_response(&queue, None, now)?.is_none());

    // A fast tool result wins over a still-unspoken acknowledgement.
    let mut queue = response::ResponseCreateQueue::default();
    let mut handoff = feedback::Handoff::new("fast".into(), "original".into(), None, false, now);
    queue.request_create();
    assert!(matches!(
        next_response(&queue, Some(&mut handoff), now)?,
        Some(ClientEvent::ResponseCreate { response: None, .. })
    ));
    Ok(())
}

#[test]
fn handoff_feedback_uses_backend_context_and_tool_free_spoken_notices()
-> Result<(), Box<dyn std::error::Error>> {
    let event = serde_json::to_value(feedback_message("Checking the spot quote.")?)?;
    assert_eq!(event["item"]["role"], "user");
    assert_eq!(event["item"]["content"][0]["type"], "input_text");
    assert_eq!(
        event["item"]["content"][0]["text"],
        "[BACKEND] Checking the spot quote."
    );
    for notice in [
        feedback::Notice::Acknowledgement,
        feedback::Notice::Progress,
    ] {
        let event = serde_json::to_value(feedback_response(notice)?)?;
        assert_eq!(event["type"], "response.create");
        assert_eq!(event["response"]["tools"], json!([silence_tool()]));
        assert_eq!(event["response"]["tool_choice"], "auto");
        assert_eq!(event["response"]["output_modalities"], json!(["audio"]));
        assert_eq!(event["response"]["max_output_tokens"], 96);
    }
    Ok(())
}

#[test]
fn playback_is_ordered_and_interrupts_at_audio_actually_heard() -> Result<(), &'static str> {
    let mut output = Output::default();
    output.append(
        "item".into(),
        0,
        [1_i16, -2, 3, 4]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect(),
    )?;
    let epoch = output.epoch;
    let mut samples = [0; 3];
    assert_eq!(output.read(&mut samples), 3);
    assert_eq!(samples, [1, -2, 3]);
    output.acknowledge(epoch, 2);
    let event = output.interrupt().ok_or("no truncate")?;
    assert!(matches!(
        event,
        ClientEvent::ConversationItemTruncate {
            audio_end_ms: 0,
            ..
        }
    ));
    output.acknowledge(epoch, 9999);
    assert_eq!(output.played, 0);
    assert_eq!(output.read(&mut samples), 0);
    Ok(())
}

#[test]
fn truncation_uses_played_sample_count_and_stale_acknowledgements_are_ignored()
-> Result<(), &'static str> {
    let mut output = Output::default();
    output.append("one".into(), 0, vec![0; RATE * 2])?;
    let epoch = output.epoch;
    let mut samples = vec![0; RATE];
    output.read(&mut samples);
    output.acknowledge(epoch, RATE / 2);
    assert!(matches!(
        output.interrupt(),
        Some(ClientEvent::ConversationItemTruncate {
            audio_end_ms: 500,
            ..
        })
    ));
    output.append("two".into(), 0, vec![0; FRAME * 2])?;
    output.acknowledge(epoch, RATE);
    assert_eq!(output.played, 0);
    Ok(())
}

#[test]
fn audio_overflow_and_overlapping_items_fail_instead_of_reordering() -> Result<(), &'static str> {
    let mut output = Output::default();
    output.append("one".into(), 0, vec![0; 2])?;
    assert!(output.append("two".into(), 0, vec![0; 2]).is_err());
    output.clear();
    assert!(
        output
            .append("three".into(), 0, vec![0; MAX_OUTPUT * 2 + 2])
            .is_err()
    );
    assert!(output.append("three".into(), 0, vec![0]).is_err());
    Ok(())
}

#[test]
fn tool_ids_cannot_repeat_and_uncertain_prompts_cannot_replay() {
    let mut ledger = ToolLedger::default();
    assert_eq!(ledger.begin("call-1", BACKGROUND_AGENT, "{}"), Ok(true));
    assert_eq!(
        ledger.begin("call-1", BACKGROUND_AGENT, "{}"),
        Err("duplicate")
    );
    assert_eq!(ledger.begin("call-2", BACKGROUND_AGENT, "{}"), Ok(true));
    assert_eq!(ledger.begin("call-3", REMAIN_SILENT, "{}"), Ok(false));
    ledger.complete(true, true);
    assert_eq!(
        ledger.begin("call-4", BACKGROUND_AGENT, "{}"),
        Err("outcome_unknown")
    );
    assert_eq!(ledger.begin("call-5", REMAIN_SILENT, "{}"), Ok(false));
    assert_eq!(ledger.begin("call-6", "shell", "{}"), Err("invalid_tool"));
}

#[test]
fn public_session_configuration_preserves_voice_and_server_vad_settings()
-> Result<(), Box<dyn std::error::Error>> {
    for vad in [
        json!({"type":"server_vad","threshold":0.6,"prefix_padding_ms":300,"silence_duration_ms":700}),
        json!({"type":"server_vad","threshold":0.0,"prefix_padding_ms":0,"silence_duration_ms":100}),
    ] {
        let config: Config = serde_json::from_value(
            json!({"target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"},"voice":"cedar","vad":vad}),
        )?;
        let event = serde_json::to_value(config.session_update()?)?;
        let tools = event["session"]["tools"]
            .as_array()
            .ok_or("missing voice tools")?;
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], BACKGROUND_AGENT);
        assert_eq!(tools[0]["parameters"]["required"], json!(["prompt"]));
        assert_eq!(
            tools[0]["parameters"]["properties"]["delivery"]["enum"],
            json!(["now", "later"])
        );
        assert_eq!(tools[1]["name"], REMAIN_SILENT);
        config.validate_audio(serde_json::from_value(event["session"]["audio"].clone())?)?;
        let mut wrong_audio = event["session"]["audio"].clone();
        wrong_audio["output"]["format"]["rate"] = json!(48_000);
        assert!(
            config
                .validate_audio(serde_json::from_value(wrong_audio)?)
                .is_err()
        );
        let mut wrong_vad = event["session"]["audio"].clone();
        wrong_vad["input"]["turn_detection"]["interrupt_response"] = json!(false);
        assert!(
            config
                .validate_audio(serde_json::from_value(wrong_vad)?)
                .is_err()
        );
        assert_eq!(event["session"]["audio"]["output"]["voice"], "cedar");
        assert_eq!(
            event["session"]["audio"]["input"]["noise_reduction"]["type"],
            "near_field"
        );
        assert_eq!(
            event["session"]["audio"]["input"]["turn_detection"]["type"],
            vad["type"]
        );
        assert_eq!(
            event["session"]["audio"]["input"]["turn_detection"]["interrupt_response"],
            true
        );
        assert_eq!(event["session"]["audio"]["output"]["format"]["rate"], RATE);
    }
    Ok(())
}

#[test]
fn preview_uses_selected_realtime_voice_without_microphone_turns_or_agent_tools()
-> Result<(), Box<dyn std::error::Error>> {
    let config: Config = serde_json::from_value(json!({"preview":true,"voice":"cedar"}))?;
    let event = serde_json::to_value(config.session_update()?)?;
    assert_eq!(event["session"]["audio"]["output"]["voice"], "cedar");
    assert_eq!(
        event["session"]["audio"]["input"]["turn_detection"]["type"],
        "server_vad"
    );
    assert_eq!(
        event["session"]["audio"]["input"]["turn_detection"]["create_response"],
        false
    );
    assert_eq!(
        event["session"]["audio"]["input"]["turn_detection"]["interrupt_response"],
        false
    );
    assert_eq!(event["session"]["tools"], json!([]));
    assert!(
        event["session"]["audio"]["input"]
            .get("transcription")
            .is_none()
    );
    assert_eq!(event["session"]["tool_choice"], "none");
    assert_eq!(event["session"]["max_output_tokens"], PREVIEW_TOKEN_LIMIT);
    config.validate_audio(serde_json::from_value(event["session"]["audio"].clone())?)?;
    let response = serde_json::to_value(preview_response(&config)?)?;
    assert_eq!(response["response"]["conversation"], "none");
    assert_eq!(response["response"]["input"], json!([]));
    assert_eq!(response["response"]["tool_choice"], "none");
    assert_eq!(
        response["response"]["max_output_tokens"],
        PREVIEW_TOKEN_LIMIT
    );
    Ok(())
}

#[test]
fn previews_use_custom_text_and_reject_empty_or_oversized_samples()
-> Result<(), Box<dyn std::error::Error>> {
    let mut config: Config =
        serde_json::from_value(json!({"preview":true,"voice":"cedar","previewText":"Bonjour !"}))?;
    let response = serde_json::to_value(preview_response(&config)?)?;
    assert!(
        response["response"]["instructions"]
            .as_str()
            .ok_or("missing instructions")?
            .contains("Bonjour !")
    );
    for text in [
        String::new(),
        "  ".into(),
        "語".repeat(PREVIEW_TEXT_LIMIT + 1),
    ] {
        config.preview_text = Some(text);
        assert!(config.session_update().is_err());
    }
    Ok(())
}

#[test]
fn transcription_defaults_to_auto_and_preserves_explicit_spoken_language_hints()
-> Result<(), Box<dyn std::error::Error>> {
    for (language, expected) in [
        (None, None),
        (Some("auto"), None),
        (Some("en"), Some("en")),
        (Some("zh-Hant"), Some("zh")),
        (Some("zh-Hans"), Some("zh")),
        (Some("ja"), Some("ja")),
        (Some("es"), Some("es")),
        (Some("fr"), Some("fr")),
    ] {
        let mut value = json!({"target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"},"voice":"cedar","vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}});
        if let Some(language) = language {
            value["language"] = json!(language);
        }
        let config: Config = serde_json::from_value(value)?;
        // Check the actual typed client's wire serialization, not just our JSON.
        let event = serde_json::to_value(config.session_update()?)?;
        let transcription = &event["session"]["audio"]["input"]["transcription"];
        assert_eq!(transcription["model"], "gpt-4o-mini-transcribe");
        if let Some(expected) = expected {
            assert_eq!(transcription["language"], expected);
        } else {
            assert!(transcription.get("language").is_none());
        }
        assert!(transcription.get("prompt").is_none());
    }
    Ok(())
}

#[test]
fn realtime_rejects_semantic_turn_detection() {
    let config = json!({"voice":"marin","target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"},"vad":{"type":"semantic_vad","eagerness":"low"}});
    assert!(serde_json::from_value::<Config>(config).is_err());
}

#[test]
fn previews_reject_agent_targets_and_calls_require_a_binding_and_vad()
-> Result<(), Box<dyn std::error::Error>> {
    let mut value = json!({"preview":true,"voice":"marin","target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"}});
    assert!(
        serde_json::from_value::<Config>(value.clone())?
            .session_update()
            .is_err()
    );
    value["preview"] = json!(false);
    assert!(
        serde_json::from_value::<Config>(value)?
            .session_update()
            .is_err()
    );
    let invalid_voice: Config = serde_json::from_value(json!({"preview":true,"voice":"quartz"}))?;
    assert!(invalid_voice.session_update().is_err());
    Ok(())
}

#[test]
fn deferred_work_is_bounded_fifo_and_cancellation_drops_unsent_requests()
-> Result<(), Box<dyn std::error::Error>> {
    fn pending(id: usize) -> Result<delegation::Pending, &'static str> {
        Ok(delegation::Pending {
            call_id: id.to_string(),
            request: Delegation::parse(
                &json!({"prompt":format!("task {id}"),"delivery":"later"}).to_string(),
            )?,
        })
    }
    let mut queue = delegation::Deferred::default();
    for id in 0..delegation::MAX_PENDING - 1 {
        queue.push(pending(id)?, 1)?;
    }
    assert_eq!(queue.push(pending(100)?, 1), Err("queue_full"));
    let first = queue.take().ok_or("missing first task")?;
    assert_eq!(first.call_id, "0");
    assert!(queue.take().is_none()); // The second task cannot overtake active work.
    queue.finish();
    assert_eq!(queue.take().ok_or("missing second task")?.call_id, "1");
    assert_eq!(queue.cancel(), delegation::MAX_PENDING - 3);
    queue.finish();
    assert!(queue.take().is_none());
    Ok(())
}

#[test]
fn silence_is_an_empty_noop_and_suppresses_pending_notices() -> Result<(), &'static str> {
    assert!(serde_json::from_str::<SilentArguments>("{}").is_ok());
    assert!(serde_json::from_str::<SilentArguments>(r#"{"prompt":"stop"}"#).is_err());
    let now = Instant::now();
    let mut handoff = feedback::Handoff::new("call".into(), "response".into(), None, false, now);
    handoff.silence();
    let responses = response::ResponseCreateQueue::default();
    assert!(next_response(&responses, Some(&mut handoff), now)?.is_none());
    Ok(())
}

#[test]
fn typed_input_adds_user_context_without_resubmitting_agent_work()
-> Result<(), Box<dyn std::error::Error>> {
    let text = "Please also check 日本語 captions 👋";
    let event = serde_json::to_value(submitted_message(text)?)?;
    assert_eq!(event["type"], "conversation.item.create");
    assert_eq!(event["item"]["role"], "user");
    assert_eq!(event["item"]["content"][0]["type"], "input_text");
    assert_eq!(
        event["item"]["content"][0]["text"],
        format!("{TYPED_PREFIX}{text}")
    );
    assert!(submitted_message("   ").is_err());
    assert!(submitted_message(&"x".repeat(MAX_TEXT + 1)).is_err());
    Ok(())
}
