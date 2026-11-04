use super::*;

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
    assert_eq!(ledger.begin("call-1", "agent_prompt", "{}"), Ok(true));
    assert_eq!(
        ledger.begin("call-1", "agent_prompt", "{}"),
        Err("duplicate")
    );
    assert_eq!(
        ledger.begin("call-2", "agent_prompt", "{}"),
        Err("agent_busy")
    );
    assert_eq!(ledger.begin("call-3", "agent_status", "{}"), Ok(false));
    ledger.complete(true, true);
    assert_eq!(
        ledger.begin("call-4", "agent_prompt", "{}"),
        Err("outcome_unknown")
    );
    assert_eq!(ledger.begin("call-5", "agent_read", "{}"), Ok(false));
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
    assert_eq!(event["session"]["tool_choice"], "none");
    assert_eq!(event["session"]["max_output_tokens"], 256);
    config.validate_audio(serde_json::from_value(event["session"]["audio"].clone())?)?;
    let response = serde_json::to_value(preview_response()?)?;
    assert_eq!(response["response"]["conversation"], "none");
    assert_eq!(response["response"]["input"], json!([]));
    assert_eq!(response["response"]["tool_choice"], "none");
    assert_eq!(response["response"]["max_output_tokens"], 256);
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
