use super::*;
use crate::host_runtime::realtime_agent::Delegation;

fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

#[test]
fn both_providers_receive_agent_updates_as_quiet_context_without_a_user_turn_or_response_request()
-> Result<(), Box<dyn std::error::Error>> {
    use futures::{FutureExt, StreamExt};
    crate::runtime()?.block_on(async {
        for live in [false, true] {
            let (mut socket, mut wire, _events) = socket::Socket::relay();
            let mut session = if live {
                voice_call_openai::session::Session::live(&mut socket,
                    voice_call_openai::session::LiveConfig { model: "gpt-live".into(), voice: "quartz".into(), backend_model: None, session_id: None }, true)
            } else {
                let config: Config = serde_json::from_value(json!({"global":true,"voice":"cedar"}))?;
                voice_call_openai::session::Session::realtime(&mut socket,
                    voice_call_openai::session::RealtimeConfig { model: config.model()?.id.clone(), audio: config.audio_settings()? }, true)
            };
            let text = format!("{}\n{}", observer::GUIDANCE,
                json!({"source":{"host_id":"explicit-host","pane_id":"pinned-pane"},"message_id":"m","part_id":"p","text":"Public answer."}));
            deliver_agent_context(&mut session, &text).await?;
            let mut content = String::new();
            while let Some(Some(message)) = wire.next().now_or_never() {
                let value: Value = serde_json::from_str(message.to_text()?)?;
                if live {
                    assert_eq!(value["type"], "session.thinking.append");
                    assert!(value["delegation_id"].is_null());
                    content.push_str(value["content"].as_str().ok_or("missing thinking content")?);
                } else {
                    assert_eq!(value["type"], "conversation.item.create");
                    assert_eq!(value["item"]["role"], "assistant");
                    assert_eq!(value["item"]["content"][0]["type"], "output_text");
                    content.push_str(value["item"]["content"][0]["text"].as_str().ok_or("missing context")?);
                    assert!(!session.realtime_state()?.responses.can_create());
                }
            }
            assert_eq!(content, text);
        }
        Ok::<_, Box<dyn std::error::Error>>(())
    })
}

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
    assert!(names.contains(&"agents_prompt"));
    assert!(names.contains(&"agents_read"));
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
    assert!(
        !agent["session"]["tools"]
            .as_array()
            .ok_or("No agent tools")?
            .iter()
            .any(|tool| tool["name"] == "agents_read")
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
    let mut handoff = feedback::Handoff::new("call".into(), "original".into(), false, now);
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
    let mut handoff = feedback::Handoff::new("fast".into(), "original".into(), false, now);
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
fn audio_overflow_and_invalid_frames_remain_bounded() {
    let mut output = Output::default();
    assert!(
        output
            .append("three".into(), 0, vec![0; MAX_OUTPUT * 2 + 2])
            .is_err()
    );
    assert!(output.append("three".into(), 0, vec![0]).is_err());
}

// Mobile equivalents of the PCM pause and flush regressions in Codex PR #46880.
// The native sink pulls from Output without blocking a speaker writer.
#[test]
fn queued_pcm_survives_a_pause_partial_reads_and_an_underrun() -> Result<(), &'static str> {
    let mut output = Output::default();
    let first = vec![1000_i16; FRAME];
    let second: Vec<_> = [0_i16, -2000, 2000]
        .into_iter()
        .cycle()
        .take(FRAME)
        .collect();
    output.append("item".into(), 0, pcm_bytes(&first))?;
    let epoch = output.epoch;
    // Nothing consumes or rewrites queued PCM while the producer is paused.
    // Queue both buffers before the device next asks for a partial buffer.
    std::thread::sleep(Duration::from_millis(20));
    output.append("item".into(), 0, pcm_bytes(&second))?;
    std::thread::sleep(Duration::from_millis(20));
    let expected: Vec<_> = first.into_iter().chain(second).collect();
    let mut actual = Vec::new();
    let mut buffer = [0; FRAME / 3];
    while actual.len() < expected.len() {
        let count = output.read(&mut buffer);
        assert!(count > 0);
        actual.extend_from_slice(&buffer[..count]);
        output.acknowledge(epoch, actual.len());
    }
    assert_eq!(actual, expected);
    assert_eq!(output.read(&mut buffer), 0);
    assert_eq!(output.played, expected.len());

    // Native silence on an underrun must not consume future provider samples.
    output.append("item".into(), 0, pcm_bytes(&[3000; FRAME]))?;
    let mut resumed = [0; FRAME];
    assert_eq!(output.read(&mut resumed), FRAME);
    assert_eq!(resumed, [3000; FRAME]);
    output.acknowledge(epoch, actual.len() + FRAME);
    assert_eq!(output.played, output.generated);
    Ok(())
}

#[test]
fn a_full_pcm_queue_preserves_speech_and_flush_retires_device_acknowledgements()
-> Result<(), &'static str> {
    let mut output = Output::default();
    let pcm = |sample: i16, count: usize| sample.to_le_bytes().repeat(count);
    output.append("old".into(), 0, pcm(1000, MAX_OUTPUT))?;
    let epoch = output.epoch;
    let mut submitted = [0; FRAME];
    assert_eq!(output.read(&mut submitted), FRAME);
    assert_eq!(submitted, [1000; FRAME]);
    // Reading into the device does not free the bound until it is heard.
    assert!(output.append("old".into(), 0, pcm(2000, 1)).is_err());
    output.acknowledge(epoch, FRAME);
    output.append("old".into(), 0, pcm(2000, FRAME))?;
    assert!(output.append("old".into(), 0, pcm(3000, 1)).is_err());
    let mut retained = vec![0; MAX_OUTPUT];
    assert_eq!(output.read(&mut retained), MAX_OUTPUT);
    assert_eq!(
        &retained[..MAX_OUTPUT - FRAME],
        vec![1000; MAX_OUTPUT - FRAME]
    );
    assert_eq!(&retained[MAX_OUTPUT - FRAME..], [2000; FRAME]);

    // A full device queue cannot hold up cancellation. Reset it before the
    // replacement audio arrives; delayed old completions must remain inert.
    output.clear();
    assert!(output.epoch > epoch);
    assert_eq!(output.read(&mut submitted), 0);
    output.append("new".into(), 0, pcm(3000, FRAME))?;
    assert_eq!(output.read(&mut submitted), FRAME);
    output.acknowledge(epoch, MAX_OUTPUT + FRAME);
    assert_eq!(output.played, 0);
    assert_eq!(submitted, [3000; FRAME]);
    output.acknowledge(output.epoch, FRAME);
    assert_eq!(output.played, FRAME);
    Ok(())
}

#[test]
fn consecutive_replies_preserve_queued_speech_and_the_device_tail() -> Result<(), &'static str> {
    let mut output = Output::default();
    output.append("one".into(), 0, pcm_bytes(&[1, 2, 3, 4]))?;
    let epoch = output.epoch;
    let mut submitted = [0; 2];
    assert_eq!(output.read(&mut submitted), 2);
    output.acknowledge(epoch, 1);
    // Both the device tail and Rust's unread tail precede the next response.
    output.append("two".into(), 0, pcm_bytes(&[5, 6, 7]))?;
    let mut next = [0; 5];
    assert_eq!(output.read(&mut next), 5);
    assert_eq!(submitted, [1, 2]);
    assert_eq!(next, [3, 4, 5, 6, 7]);
    output.acknowledge(epoch, 7);
    assert_eq!(output.played, output.generated);
    Ok(())
}

#[test]
fn interruption_uses_the_audible_items_offset_across_a_queued_reply() -> Result<(), &'static str> {
    let mut output = Output::default();
    output.append("one".into(), 0, vec![0; RATE * 2])?;
    output.append("two".into(), 1, vec![0; RATE * 2])?;
    let epoch = output.epoch;
    output.read(&mut vec![0; RATE * 2]);
    output.acknowledge(epoch, RATE + RATE / 4);
    assert!(
        matches!(output.interrupt(), Some(ClientEvent::ConversationItemTruncate {
        item_id, content_index: 1, audio_end_ms: 250, ..
    }) if item_id == "two")
    );
    output.acknowledge(epoch, RATE * 2);
    assert_eq!(output.played, 0);
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
    let mut handoff = feedback::Handoff::new("call".into(), "response".into(), false, now);
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

#[test]
fn resumed_global_calls_restore_text_in_both_protocols_and_keep_new_usage_ids()
-> Result<(), Box<dyn std::error::Error>> {
    use crate::app_database::{VoiceUsageMode, VoiceUsageScope};
    use crate::voice_history::{Continuation, Conversation, Restored};
    for live in [false, true] {
        let mut config: Config = serde_json::from_value(json!({
            "global":true, "live":live, "voice":"marin", "resumeCallId":"old-call",
            "vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}
        }))?;
        let mut conversation = Conversation::default();
        conversation.user("My project is Orion");
        conversation.assistant("I remember Orion");
        config.accept_history(Restored {
            mode: if live {
                VoiceUsageMode::Live
            } else {
                VoiceUsageMode::Realtime
            },
            scope: VoiceUsageScope::Global,
            continuation: Continuation {
                context: conversation.into_captions(),
                ..Continuation::default()
            },
        })?;
        if live {
            let session: Value = serde_json::from_str(&voice_call_openai::live::codec().encode(
                &oai_rt_rs::live::ClientEvent::new(oai_rt_rs::live::Command::Start {
                    session: live::LiveVoiceAdapter::session(&config)?,
                }),
            )?)?;
            assert!(
                session["session"]["instructions"]
                    .as_str()
                    .ok_or("no voice instructions")?
                    .contains("Orion")
            );
            assert!(
                session["session"]["delegation"]["responses"]["instructions"]
                    .as_str()
                    .ok_or("no backend instructions")?
                    .contains("Orion")
            );
        } else {
            let update =
                serde_json::to_value(config.history_update(Some(config.session_update()?))?)?;
            assert_eq!(update["type"], "session.update");
            assert!(
                update["session"]["instructions"]
                    .as_str()
                    .ok_or("no instructions")?
                    .contains("Orion")
            );
            assert!(
                update["session"]["instructions"]
                    .as_str()
                    .ok_or("no instructions")?
                    .contains("Wait for new user input")
            );
            let first = cost::CurrentChat::start(&config)?;
            let second = cost::CurrentChat::start(&config)?;
            assert_ne!(
                first.history_identity().ok_or("no first ID")?.session_id,
                second.history_identity().ok_or("no second ID")?.session_id
            );
        }
    }
    Ok(())
}

#[test]
fn resumed_terminal_configuration_cannot_redirect_to_a_new_target_or_scope()
-> Result<(), Box<dyn std::error::Error>> {
    use crate::app_database::{VoiceUsageMode, VoiceUsageScope};
    use crate::voice_history::{Continuation, Restored};
    let target: TerminalTarget = serde_json::from_value(
        json!({"runtimeId":"host", "runtimeIncarnation":1,
        "connectionGeneration":1, "terminalId":"original", "operationEpoch":42, "recoveryRevision":0, "processEpoch":"process"}),
    )?;
    let mut config: Config = serde_json::from_value(
        json!({"voice":"marin", "terminalTarget":target,
        "vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}}),
    )?;
    let restored = || Restored {
        mode: VoiceUsageMode::Realtime,
        scope: VoiceUsageScope::Terminal,
        continuation: Continuation {
            terminal_target: Some(target.clone()),
            ..Continuation::default()
        },
    };
    config.accept_history(restored())?;
    let session = serde_json::to_value(config.history_update(Some(config.session_update()?))?)?;
    let names: Vec<_> = session["session"]["tools"]
        .as_array()
        .ok_or("no tools")?
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"terminal_exec"));
    assert!(!names.contains(&"agents_prompt"));
    let costs = cost::CurrentChat::start(&config)?;
    assert_eq!(
        costs.history_identity().ok_or("no identity")?.scope,
        VoiceUsageScope::Terminal
    );
    config
        .terminal_target
        .as_mut()
        .ok_or("no terminal")?
        .terminal_id = "different-terminal".into();
    assert!(config.accept_history(restored()).is_err());
    config.terminal_target = None;
    config.global = true;
    assert!(config.accept_history(restored()).is_err());
    Ok(())
}
