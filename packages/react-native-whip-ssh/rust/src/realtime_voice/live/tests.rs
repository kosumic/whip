use super::*;
use serde_json::json;

#[test]
fn native_live_calls_negotiate_audio_on_webrtc_while_previews_keep_pcm()
-> Result<(), Box<dyn std::error::Error>> {
    let mut config: Config =
        serde_json::from_value(json!({"live":true,"webrtc":true,"global":true,"voice":"quartz"}))?;
    let session = serde_json::to_value(LiveVoiceAdapter::session(&config)?)?;
    assert!(session["audio"].get("format").is_none());
    assert_eq!(session["audio"]["output"]["voice"], "quartz");
    assert_eq!(session["delegation"]["type"], "responses");
    config.global = false;
    config.preview = true;
    let preview = serde_json::to_value(LiveVoiceAdapter::session(&config)?)?;
    assert_eq!(preview["audio"]["format"]["rate"], 24_000);
    Ok(())
}

#[test]
fn live_preview_uses_custom_text_without_an_agent_or_tools()
-> Result<(), Box<dyn std::error::Error>> {
    let mut config: Config = serde_json::from_value(
        json!({"live":true,"preview":true,"voice":"quartz","previewText":"こんにちは。"}),
    )?;
    let session = LiveVoiceAdapter::session(&config)?;
    let encoded: Value =
        serde_json::from_str(&codec().encode(&ClientEvent::new(Command::Start { session }))?)?;
    assert_eq!(encoded["session"]["audio"]["output"]["voice"], "quartz");
    assert_eq!(encoded["session"]["store"], false);
    assert_eq!(encoded["session"]["input"][0]["role"], "developer");
    assert!(
        encoded["session"]["input"][0]["content"][0]["text"]
            .as_str()
            .ok_or("missing preview text")?
            .contains("こんにちは。")
    );
    assert!(encoded["session"].get("tools").is_none());
    config.target = Some(serde_json::from_value(
        json!({"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"}),
    )?);
    assert!(LiveVoiceAdapter::validate(&config).is_err());
    config.target = None;
    config.preview = false;
    assert!(LiveVoiceAdapter::validate(&config).is_err());
    Ok(())
}

#[test]
fn public_configuration_uses_its_own_voice_and_client_delegation()
-> Result<(), Box<dyn std::error::Error>> {
    let config: Config = serde_json::from_value(
        json!({"live":true,"voice":"quartz","target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"}}),
    )?;
    let session = LiveVoiceAdapter::session(&config)?;
    let encoded = codec().encode(&ClientEvent::new(Command::Start { session }))?;
    let encoded: Value = serde_json::from_str(&encoded)?;
    assert_eq!(encoded["session"]["model"], "gpt-live-1");
    assert_eq!(encoded["session"]["audio"]["output"]["voice"], "quartz");
    assert_eq!(encoded["session"]["delegation"]["type"], "client");
    assert!(encoded["session"].get("tools").is_none());
    Ok(())
}

#[test]
fn cumulative_usage_is_monotonic_and_final_usage_is_not_added() -> Result<(), &'static str> {
    let mut usage = usage::Usage::default();
    assert_eq!(usage.estimate(), None);
    usage.observe(12.0, false)?;
    usage.observe(15.0, false)?;
    usage.observe(12.0, false)?;
    assert_eq!(usage.provider.seconds, 15.0);
    assert!(!usage.provider.finalized);
    usage.observe(16.0, true)?;
    usage.observe(16.0, true)?;
    usage.observe(99.0, false)?;
    assert_eq!(usage.provider.seconds, 16.0);
    assert!((usage.estimate().ok_or("missing estimate")? - 16.0 * 0.05 / 60.0).abs() < 1e-12);
    Ok(())
}

#[test]
fn duplicate_events_do_not_duplicate_requests_or_captions() -> Result<(), Box<dyn std::error::Error>>
{
    let mut state = State::default();
    let event=codec().decode_server(r#"{"type":"session.input_transcript.delta","event_id":"one","delta":"hello hello","start_ms":0,"end_ms":100}"#)?;
    assert!(state.protocol.unique(&event)?);
    assert!(!state.protocol.unique(&event)?);
    Ok(())
}

fn fragment(id: &str, role: &str, text: &str, start: f64, end: f64) -> captions::Fragment {
    captions::Fragment {
        id: id.into(),
        role: role.into(),
        text: text.into(),
        start_ms: start,
        end_ms: end,
        event: None,
    }
}
#[test]
fn late_caption_fragments_preserve_speaker_order_and_repeated_words() -> Result<(), &'static str> {
    let mut captions = captions::Transcript::default();
    captions.append(fragment("two", "user", " hello", 50.0, 100.0))?;
    captions.append(fragment("overlap", "assistant", "Okay", 25.0, 90.0))?;
    captions.append(fragment("one", "user", "hello", 0.0, 50.0))?;
    captions.append(fragment("one", "user", "hello", 0.0, 50.0))?;
    assert_eq!(captions.messages().as_array().map(Vec::len), Some(2));
    assert!(captions.request(0.0, 100.0)?.contains("hello hello"));
    assert!(!captions.request(0.0, 100.0)?.contains("Okay"));
    assert!(captions.request(150.0, 100.0).is_err());
    Ok(())
}

#[test]
fn live_highlighting_waits_for_device_playback_and_preserves_fragment_timing()
-> Result<(), &'static str> {
    let mut captions = captions::Transcript::default();
    captions.audio(0, &1000_i16.to_le_bytes());
    captions.append(fragment("one", "assistant", "hello", 1000.0, 1500.0))?;
    captions.append(fragment("two", "assistant", " world", 1700.0, 2300.0))?;
    let messages = captions.messages();
    assert_eq!(messages[0]["spokenUtf16"], 0);
    assert_eq!(messages[0]["active"], false);
    captions.played(super::super::RATE / 4);
    let messages = captions.messages();
    assert_eq!(messages[0]["spokenUtf16"], 2);
    assert_eq!(messages[0]["active"], true);
    // More caption delivery cannot advance speech while device playback pauses.
    captions.append(fragment("late", "user", "yes", 1100.0, 1200.0))?;
    assert_eq!(captions.messages()[0]["spokenUtf16"], 2);
    captions.played(super::super::RATE);
    assert_eq!(captions.messages()[0]["spokenUtf16"], 8);
    captions.played(super::super::RATE * 2);
    let messages = captions.messages();
    assert_eq!(messages[0]["spokenUtf16"], 11);
    assert_eq!(messages[0]["active"], false);
    Ok(())
}

#[test]
fn interrupted_live_captions_cannot_become_heard_during_a_later_reply() -> Result<(), &'static str>
{
    let mut captions = captions::Transcript::default();
    captions.audio(0, &1000_i16.to_le_bytes());
    captions.append(fragment("old", "assistant", "unfinished", 0.0, 1000.0))?;
    captions.played(super::super::RATE / 2);
    captions.stop();
    captions.audio(0, &1000_i16.to_le_bytes());
    captions.append(fragment("new", "assistant", "new reply", 4000.0, 5000.0))?;
    captions.played(super::super::RATE);
    let messages = captions.messages();
    assert_eq!(messages[0]["spokenUtf16"], 5);
    assert_eq!(messages[0]["active"], false);
    assert_eq!(messages[1]["spokenUtf16"], 9);
    Ok(())
}

#[test]
fn late_live_captions_catch_up_to_heard_speech_without_including_leading_silence()
-> Result<(), &'static str> {
    use super::super::{Output, RATE};
    // Exercise the same PCM queue and hardware acknowledgement path as a call.
    for captions_first in [true, false] {
        let mut output = Output {
            live_transcript: Some(captions::Transcript::default()),
            ..Output::default()
        };
        if captions_first {
            output
                .live_transcript
                .as_mut()
                .ok_or("missing captions")?
                .append(fragment("words", "assistant", "hello", 4000.0, 5000.0))?;
        }
        let mut pcm = vec![0_i16; RATE];
        pcm.extend(vec![1000_i16; RATE]);
        output.append(
            "live-stream".into(),
            0,
            pcm.iter().flat_map(|s| s.to_le_bytes()).collect(),
        )?;
        let mut device = vec![0; RATE + RATE / 2];
        assert_eq!(output.read(&mut device), device.len());
        // Speech is queued but not yet played by the device.
        if captions_first {
            assert_eq!(
                output
                    .live_transcript
                    .as_ref()
                    .ok_or("missing captions")?
                    .messages()[0]["spokenUtf16"],
                0
            );
        }
        output.acknowledge(output.epoch, device.len());
        let transcript = output.live_transcript.as_mut().ok_or("missing captions")?;
        if !captions_first {
            transcript.append(fragment("words", "assistant", "hello", 4000.0, 5000.0))?;
        }
        // Half the speech has played, regardless of caption delivery order.
        assert_eq!(transcript.messages()[0]["spokenUtf16"], 2);
        assert_eq!(transcript.messages()[0]["active"], true);
    }
    Ok(())
}
#[test]
fn private_agent_payloads_are_not_spoken_and_status_is_not_completion() {
    let result = public_result(
        &json!({"completion":"submitted","accepted":true,"reasoning":"PRIVATE","tools":["SECRET"],"turn_id":"internal"}),
    );
    assert!(result.contains("Completion is not confirmed"));
    assert!(!result.contains("PRIVATE"));
    assert!(!result.contains("SECRET"));
    assert!(!result.contains("internal"));
    let result = public_result(&json!({"error":"approval_required"}));
    assert!(result.contains("No approval was accepted"));
}
#[test]
fn context_chunks_preserve_unicode_within_public_append_limit() {
    let original = "👋日本語".repeat(120);
    let split = chunks(&original);
    assert_eq!(split.concat(), original);
    assert!(split.iter().all(|chunk| chunk.len() <= CONTEXT_BYTES));
}

/// Explicit opt-in only: billable, synthetic speech, no host or agent mutations.
#[tokio::test]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
async fn public_live_api_smoke() -> Result<(), Box<dyn std::error::Error>> {
    use std::ffi::c_void;
    unsafe extern "C" fn read(context: *mut c_void, out: *mut u8, capacity: usize) -> i32 {
        // SAFETY: the test lends its live key string for this synchronous callback.
        let key = unsafe { &*context.cast::<String>() };
        if key.len() > capacity {
            return -4;
        }
        // SAFETY: the caller supplies capacity writable bytes; the copy is bounded above.
        unsafe { std::ptr::copy_nonoverlapping(key.as_ptr(), out, key.len()) };
        i32::try_from(key.len()).unwrap_or(-4)
    }

    let mut key =
        std::env::var("OPENAI_API_KEY").map_err(|_| "Missing API key for opt-in smoke test")?;
    let response=reqwest::Client::new().post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(&key).json(&json!({"model":"gpt-4o-mini-tts","voice":"coral","response_format":"pcm","input":"Please ask the coding agent to check the synthetic test status."}))
        .send().await.map_err(|_| "Synthetic speech request failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "Synthetic speech HTTP status {}",
            response.status().as_u16()
        )
        .into());
    }
    let mut audio = response
        .bytes()
        .await
        .map_err(|_| "Synthetic speech audio unavailable")?
        .to_vec();
    audio.extend(vec![0; super::super::RATE * 2 * 30]);
    // SAFETY: key lives throughout this synchronous read; the callback retains no pointers.
    let credential =
        unsafe { native_credentials::NativeCredential::read(read, (&raw mut key).cast()) }
            .map_err(|_| "Native credential read failed")?;
    key.clear();
    let config: Config = serde_json::from_value(
        json!({"live":true,"voice":"quartz","model":"gpt-live-1","target":{"runtimeId":"synthetic","terminalId":"synthetic","paneId":"synthetic","bindingToken":"synthetic"}}),
    )?;
    let socket = super::super::connect_raw(&credential, URL).await?;
    let mut socket = super::super::socket::Socket::Direct(Box::new(socket));
    drop(credential);
    send(
        &mut socket,
        Command::Start {
            session: LiveVoiceAdapter::session(&config)?,
        },
    )
    .await?;
    let mut state = State::default();
    let mut usage = usage::Usage::default();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut position = 0;
    let mut input = 0;
    let mut output = 0;
    let mut output_text = String::new();
    let mut audio_bytes = 0;
    let mut delegations = 0;
    let mut pending_result: Option<String> = None;
    let mut result_at: Option<(String, Instant)> = None;
    let mut acknowledgements = 0;
    let mut closing = false;
    let deadline = Instant::now() + Duration::from_secs(42);
    let result=async {
        loop {
            tokio::select! {
                frame=socket.next()=>{
                    let frame=frame.ok_or("Live socket ended")?.map_err(|_| "Live transport failed")?;
                    let Message::Text(text)=frame else {continue};
                    let frame=codec().decode_server(&text).map_err(|_| "Malformed Live event")?;
                    match frame.event {
                        ServerEvent::Started {session,..}=>state.pin_session(&session,&config)?,
                        ServerEvent::InputTranscriptDelta {..}=>input+=1,
                        ServerEvent::OutputTranscriptDelta {delta,..}=>{output+=1;output_text.push_str(&delta);},
                        ServerEvent::OutputAudioDelta {delta,..}=>audio_bytes+=STANDARD.decode(delta)?.len(),
                        ServerEvent::DelegationCreated {delegation,..}=>{
                            if delegation.target!=api::DelegationTarget::Client {return Err("Wrong delegation mode".into());}
                            delegations+=1;
                            append(&mut socket,Some(&delegation.id),"The synthetic status check is in progress.",Channel::Thinking).await?;
                            pending_result=Some(delegation.id);
                        }
                        ServerEvent::ThinkingAppended {..}=>{
                            acknowledgements+=1;
                            if let Some(id)=pending_result.take() { result_at=Some((id,Instant::now()+Duration::from_millis(1500))); }
                        }
                        ServerEvent::CommentaryAppended {..}=>acknowledgements+=1,
                        ServerEvent::UsageUpdated {usage:reported,..}=>usage.observe(reported.seconds,false)?,
                        ServerEvent::Closed {session,usage:reported,reason,..}=>{
                            state.pin_session(&session,&config)?;
                            if reason!=api::CloseReason::CloseRequested {return Err("Unconfirmed close reason".into());}
                            usage.observe(reported.seconds,true)?;
                            break;
                        }
                        ServerEvent::Error {error,..}=>{
                            // Print only a small allowlist of protocol error codes.
                            let category=match error.code.as_deref() {
                                Some("invalid_api_key")=>"invalid_api_key", Some("model_not_found")=>"model_not_found",
                                Some("insufficient_quota")=>"insufficient_quota", Some("invalid_request_error")=>"invalid_request_error",_=>"provider_error",
                            };
                            return Err(format!("Live smoke rejected: {category}").into());
                        }
                        _=>{}
                    }
                },
                _=tick.tick()=>{
                    if Instant::now()>deadline {return Err("Live smoke deadline exceeded".into());}
                    if state.protocol.session_id.is_some() && !closing {
                        if result_at.as_ref().is_some_and(|(_, at)| Instant::now() >= *at)
                            && let Some((id,_))=result_at.take()
                        {
                            let result=public_result(&json!({"completion":"completed","assistant_output":"The synthetic build passed successfully. No workspace changes were made."}));
                            append(&mut socket,Some(&id),&result,Channel::Commentary).await?;
                        }
                        if position<audio.len() {
                            let end=(position+super::super::FRAME*2).min(audio.len());
                            send(&mut socket,Command::InputAudioAppend {audio:STANDARD.encode(&audio[position..end])}).await?;
                            position=end;
                        }
                        if (delegations>0 && acknowledgements>=2 && audio_bytes>0 && output>0 && input>0 && ["passed", "success", "succeeded"].iter().any(|word|output_text.to_ascii_lowercase().contains(word))) || position==audio.len() {
                            send(&mut socket,Command::Close).await?; closing=true;
                        }
                    }
                }
            }
        }
        Ok::<(),Box<dyn std::error::Error>>(())
    }.await;
    if result.is_err() {
        let _ =
            LiveVoiceAdapter::graceful_close(&config, &mut socket, &mut state, &mut usage).await;
    }
    result?;
    eprintln!(
        "Live smoke observations: input={input}, output={output}, audio_bytes={audio_bytes}, delegations={delegations}, acks={acknowledgements}, seconds={}",
        usage.provider.seconds
    );
    assert!(usage.provider.finalized, "Final provider usage missing");
    assert!(
        output_text.to_ascii_lowercase().contains("passed"),
        "The synthetic result was not spoken"
    );
    assert!(delegations > 0, "Synthetic request was not delegated");
    assert!(
        input > 0 && output > 0 && audio_bytes > 0,
        "Speech or captions missing"
    );
    assert!(
        acknowledgements >= 2,
        "Public context updates were not acknowledged"
    );
    eprintln!(
        "Live API smoke: voice=quartz, input_events={input}, output_events={output}, audio_bytes={audio_bytes}, delegations={delegations}, context_acks={acknowledgements}, final_seconds={}",
        usage.provider.seconds
    );
    Ok(())
}

#[test]
fn admitted_speech_is_never_delegated_again_and_late_old_speech_is_ignored()
-> Result<(), &'static str> {
    let mut captions = captions::Transcript::default();
    captions.append(fragment("request", "user", "Check this", 0.0, 100.0))?;
    assert!(captions.request(0.0, 100.0)?.contains("Check this"));
    captions.admit(100.0);
    captions.append(fragment("late", "user", " old words", 50.0, 100.0))?;
    captions.append(fragment("correction", "user", "Use Thursday", 150.0, 200.0))?;
    let request = captions.request(100.0, 220.0)?;
    assert!(request.contains("Use Thursday"));
    assert!(!request.contains("Check this"));
    assert!(!request.contains("old words"));
    Ok(())
}

#[test]
fn session_identity_model_and_voice_are_pinned() -> Result<(), Box<dyn std::error::Error>> {
    let config: Config = serde_json::from_value(
        json!({"live":true,"voice":"quartz","target":{"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"}}),
    )?;
    let snapshot = |id: &str,
                    model: &str,
                    voice: &str|
     -> Result<api::SessionSnapshot, serde_json::Error> {
        serde_json::from_value(
            json!({"id":id,"expires_at":2_000_000_000,"model":model,"status":"active","audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":voice}},"delegation":{"type":"client"}}),
        )
    };
    // WebSocket learns identity from the first event; WebRTC pins the POST's
    // identity before its parallel control connection becomes available.
    for session_id in [None, Some("one".to_owned())] {
        let mut state = State {
            protocol: voice_openai::live::Control::new(session_id),
            ..State::default()
        };
        state.pin_session(&snapshot("one", "gpt-live-1", "quartz")?, &config)?;
        assert!(
            state
                .pin_session(&snapshot("two", "gpt-live-1", "quartz")?, &config)
                .is_err()
        );
        assert!(
            state
                .pin_session(&snapshot("one", "gpt-realtime-1.5", "quartz")?, &config)
                .is_err()
        );
        assert!(
            state
                .pin_session(&snapshot("one", "gpt-live-1", "marin")?, &config)
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn missing_final_usage_retains_an_estimate_and_invalid_reports_cannot_finalize()
-> Result<(), &'static str> {
    let mut usage = usage::Usage::default();
    usage.observe(12.0, false)?;
    assert!(usage.observe(f64::NAN, true).is_err());
    assert!(usage.observe(11.0, true).is_err());
    assert!(usage.estimate().is_some());
    assert_eq!(usage.provider.seconds, 12.0);
    assert!(!usage.provider.finalized);
    Ok(())
}

#[test]
fn credentials_in_public_assistant_prose_are_withheld() {
    let result = public_result(
        &json!({"completion":"completed","assistant_output":"API key: sk-synthetic-secret"}),
    );
    assert!(!result.contains("sk-synthetic-secret"));
    assert!(result.contains("Inspect the agent chat"));
}

fn client_delegation(id: &str) -> api::Delegation {
    api::Delegation {
        id: id.into(),
        item_type: api::DelegationType::Delegation,
        target: api::DelegationTarget::Client,
        response_id: None,
    }
}
#[test]
fn delegation_ids_are_call_scoped_and_a_full_queue_does_not_replay() -> Result<(), &'static str> {
    let mut state = State::default();
    assert_eq!(
        state.delegate(&client_delegation("first"), 100.0, 0)?,
        Admission::Queued
    );
    assert_eq!(
        state.delegate(&client_delegation("first"), 200.0, 0)?,
        Admission::Duplicate
    );
    assert_eq!(state.pending.len(), 1);
    assert_eq!(
        state.delegate(&client_delegation("full"), 300.0, MAX_PENDING)?,
        Admission::Full
    );
    assert_eq!(
        state.delegate(&client_delegation("full"), 300.0, 0)?,
        Admission::Duplicate
    );
    let mut replacement = State::default();
    assert_eq!(
        replacement.delegate(&client_delegation("first"), 100.0, 0)?,
        Admission::Queued
    );
    assert!(
        replacement
            .delegate(&client_delegation("bad"), f64::NAN, 0)
            .is_err()
    );
    Ok(())
}
#[test]
fn interruption_suppresses_audio_until_new_speech_and_mute_acks_cannot_cross_commands() {
    let mut state = State::default();
    state.protocol.interrupted(100.0);
    state.protocol.input_caption(90.0);
    assert!(state.protocol.suppress_output_after.is_some());
    state.protocol.input_caption(110.0);
    assert!(state.protocol.suppress_output_after.is_none());
    state.protocol.muted = Some(("new".into(), false, Instant::now()));
    assert!(!state.protocol.confirm_mute(Some("old"), false));
    assert!(!state.protocol.confirm_mute(Some("new"), true));
    assert!(state.protocol.confirm_mute(Some("new"), false));
    assert!(!state.protocol.confirm_mute(Some("new"), false));
}
#[test]
fn output_channels_use_public_context_commands_and_delegation_identity()
-> Result<(), Box<dyn std::error::Error>> {
    for command in [
        Command::ThinkingAppend {
            content: "Public progress".into(),
            delegation_id: Nullable(Some("task".into())),
        },
        Command::CommentaryAppend {
            content: "Public result".into(),
            delegation_id: Nullable(Some("task".into())),
        },
    ] {
        let kind = command.kind();
        let encoded = codec().encode(&ClientEvent::new(command))?;
        let value: Value = serde_json::from_str(&encoded)?;
        assert_eq!(value["type"], kind);
        assert_eq!(value["delegation_id"], "task");
    }
    Ok(())
}

#[test]
fn mirroring_already_submitted_text_cannot_delegate_previous_speech() -> Result<(), &'static str> {
    let mut captions = captions::Transcript::default();
    captions.append(fragment(
        "old",
        "user",
        "Use the current project",
        0.0,
        100.0,
    ))?;
    captions.admit(500.0); // the composer has already submitted a request
    assert!(captions.request(500.0, 600.0).is_err());
    captions.append(fragment(
        "new",
        "user",
        "Actually use the other branch",
        700.0,
        800.0,
    ))?;
    let request = captions.request(500.0, 900.0)?;
    assert!(request.contains("Actually use the other branch"));
    assert!(!request.contains("Use the current project"));
    Ok(())
}
