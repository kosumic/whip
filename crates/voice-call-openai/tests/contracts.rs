mod support;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use support::{App, MockCredential};
use tokio_tungstenite::tungstenite::Message;
use voice_call_openai::{
    live::{Control, Selection, usage::DurationUsage},
    recovery::CANCELLED,
    socket::Socket,
    tools::{Access, Ledger},
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

#[tokio::test]
async fn cancelled_startup_creates_neither_realtime_nor_live_provider_sessions() -> Result {
    let credential = MockCredential::default();
    let app = Arc::new(App::new(false)?);
    let update =
        voice_call_openai::typed(json!({"type":"session.update","session":{"type":"realtime"}}))?;
    let result = voice_call_openai::connect_realtime(
        app.clone(),
        &credential,
        update,
        "custom-realtime-model",
    )
    .await;
    assert_eq!(
        result.err().ok_or("cancelled Realtime connected")?.message,
        CANCELLED
    );
    let result = voice_call_openai::connect_live(
        app.clone(),
        &credential,
        json!({"model":"custom-live-model"}),
    )
    .await;
    assert_eq!(result.err().ok_or("cancelled Live connected")?, CANCELLED);
    assert_eq!(credential.0.load(Ordering::Relaxed), 0);
    app.input.close();
    Ok(())
}

#[test]
fn unknown_or_uncertain_tool_mutations_cannot_be_replayed() -> Result {
    let mut ledger = Ledger::default();
    assert_eq!(
        ledger.begin("unknown", "{}", Access::Unknown),
        Err("invalid_tool")
    );
    assert_eq!(
        ledger.begin("unknown", "{}", Access::Mutate),
        Err("duplicate")
    );
    let mutation = ledger.begin("first", "{}", Access::Mutate)?;
    ledger.complete(mutation, true);
    assert_eq!(
        ledger.begin("next", "{}", Access::Mutate),
        Err("outcome_unknown")
    );
    assert!(!ledger.begin("read", "{}", Access::Read)?);
    assert_eq!(ledger.begin("first", "{}", Access::Read), Err("duplicate"));
    Ok(())
}

#[test]
fn live_identity_voice_and_backend_selection_are_pinned_without_an_app_catalog() -> Result {
    let snapshot = |id: &str,
                    model: &str,
                    voice: &str|
     -> Result<oai_rt_rs::live::SessionSnapshot> {
        Ok(serde_json::from_value(
            json!({"id":id,"expires_at":2_000_000_000,"model":model,"status":"active",
            "audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":voice}},"delegation":{"type":"client"}}),
        )?)
    };
    let selection = Selection {
        model: "custom-live",
        voice: "custom-voice",
        backend_model: None,
    };
    let mut control = Control::new(Some("call-one".into()));
    control.pin_session(
        &snapshot("call-one", "custom-live", "custom-voice")?,
        &selection,
    )?;
    for (id, model, voice) in [
        ("call-two", "custom-live", "custom-voice"),
        ("call-one", "other-model", "custom-voice"),
        ("call-one", "custom-live", "other-voice"),
    ] {
        assert!(
            control
                .pin_session(&snapshot(id, model, voice)?, &selection)
                .is_err()
        );
    }
    let backend = Selection {
        backend_model: Some("custom-backend"),
        ..selection
    };
    assert!(
        control
            .pin_session(
                &snapshot("call-one", "custom-live", "custom-voice")?,
                &backend
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn interrupted_live_audio_needs_fresh_input_and_correlated_mute_confirmation() {
    let mut control = Control::default();
    control.interrupted(100.0);
    assert!(!control.input_caption(90.0));
    assert!(control.input_caption(110.0));
    control.muted = Some(("new".into(), false, std::time::Instant::now()));
    assert!(!control.confirm_mute(Some("old"), false));
    assert!(!control.confirm_mute(Some("new"), true));
    assert!(control.confirm_mute(Some("new"), false));
    assert!(!control.confirm_mute(Some("new"), false));
}

#[test]
fn cumulative_live_usage_is_monotonic_and_finalized_only_by_valid_reports() -> Result {
    let mut usage = DurationUsage::default();
    usage.observe(15.0, false)?;
    usage.observe(10.0, false)?;
    assert_eq!(usage.seconds, 15.0);
    for seconds in [f64::NAN, f64::INFINITY, -1.0, 14.0] {
        assert!(usage.observe(seconds, true).is_err());
    }
    assert!(!usage.finalized);
    usage.observe(16.0, true)?;
    usage.observe(18.0, false)?;
    assert_eq!(usage.seconds, 16.0);
    Ok(())
}

#[derive(Default)]
struct UsageSink {
    responses: usize,
}
impl voice_call_openai::shutdown::UsageSink for UsageSink {
    fn has_pending_usage(&self) -> bool {
        true
    }
    fn observe(&mut self, event: &voice_call_openai::ServerEvent) {
        if matches!(event, voice_call_openai::ServerEvent::ResponseDone { .. }) {
            self.responses += 1;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn shutdown_collects_usage_without_dispatching_tools_or_replaying_work() -> Result {
    let (mut socket, mut commands, mut events) = Socket::relay();
    let provider = tokio::spawn(async move {
        for _ in 0..4 {
            let command = commands
                .next()
                .await
                .ok_or("missing stop command")?
                .into_text()
                .map_err(|_| "not text")?;
            let value: Value = serde_json::from_str(&command).map_err(|_| "invalid command")?;
            assert!(matches!(
                value["type"].as_str(),
                Some(
                    "session.update"
                        | "input_audio_buffer.clear"
                        | "response.cancel"
                        | "output_audio_buffer.clear"
                )
            ));
        }
        events
            .send(Ok(Message::Text(
                json!({"type":"response.done","event_id":"final-response","response":{
                    "id":"reply", "object":"realtime.response", "status":"cancelled", "output":[],
                    "usage":{"total_tokens":2,"input_tokens":1,"output_tokens":1}
                }})
                .to_string()
                .into(),
            )))
            .await
            .map_err(|_| "receiver ended")?;
        std::future::pending::<()>().await;
        Ok::<_, &'static str>(())
    });
    let mut usage = UsageSink::default();
    voice_call_openai::shutdown::collect(&mut socket, &mut usage, true, || true).await;
    assert_eq!(usage.responses, 1);
    provider.abort();
    let _ = provider.await;
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn revoked_credentials_skip_the_entire_shutdown_exchange() {
    let (mut socket, mut commands, _events) = Socket::relay();
    voice_call_openai::shutdown::collect(&mut socket, &mut UsageSink::default(), true, || false)
        .await;
    drop(socket);
    assert!(commands.next().await.is_none());
}

#[test]
fn effective_realtime_settings_gate_native_capture_and_reject_later_mismatches() -> Result {
    use voice_call_openai::{
        captions::Language,
        settings::{AudioSettings, Settings},
    };
    let expected = AudioSettings {
        voice: "cedar".into(),
        preview: false,
        language: Language::Auto,
        turn_detection: Some(serde_json::from_value(
            json!({"type":"server_vad","threshold":0.4,"prefix_padding_ms":256,"silence_duration_ms":800}),
        )?),
    };
    let mut event = json!({"type":"session.created", "event_id":"initial", "session":{
        "id":"session", "object":"realtime.session", "type":"realtime", "model":"custom-realtime",
        "expires_at":2_000_000_000, "output_modalities":["audio"],
        "audio":{"input":{"format":{"type":"audio/pcm","rate":24000},
            "transcription":{"model":"gpt-4o-mini-transcribe"},
            "turn_detection":{"type":"server_vad","threshold":0.4,"prefix_padding_ms":256,"silence_duration_ms":800,"create_response":true,"interrupt_response":true}},
            "output":{"format":{"type":"audio/pcm","rate":24000},"voice":"cedar"}}
    }});
    let mut settings = Settings::default();
    assert!(!settings.observe(&expected, &serde_json::from_value(event.clone())?)?);
    assert!(!settings.is_confirmed());
    event["type"] = json!("session.updated");
    assert!(settings.observe(&expected, &serde_json::from_value(event.clone())?)?);
    assert!(settings.is_confirmed());
    event["session"]["audio"]["input"]["turn_detection"]["interrupt_response"] = json!(false);
    assert!(
        settings
            .observe(&expected, &serde_json::from_value(event)?)
            .is_err()
    );
    assert!(!settings.is_confirmed());
    Ok(())
}

#[test]
fn realtime_hosts_can_disable_automatic_responses_or_turn_detection() -> Result {
    use voice_call_openai::{captions::Language, settings::AudioSettings};
    let mut expected = AudioSettings {
        voice: "cedar".into(),
        preview: false,
        language: Language::Auto,
        turn_detection: Some(serde_json::from_value(
            json!({"type":"server_vad", "create_response":false, "interrupt_response":false}),
        )?),
    };
    let mut audio = json!({"input":{"format":{"type":"audio/pcm","rate":24000},
        "turn_detection":{"type":"server_vad","create_response":false,"interrupt_response":false}},
        "output":{"format":{"type":"audio/pcm","rate":24000},"voice":"cedar"}});
    expected.validate_audio(serde_json::from_value(audio.clone())?)?;
    expected.turn_detection = None;
    assert!(
        expected
            .validate_audio(serde_json::from_value(audio.clone())?)
            .is_err()
    );
    audio["input"]["turn_detection"] = Value::Null;
    expected.validate_audio(serde_json::from_value(audio)?)?;
    Ok(())
}
