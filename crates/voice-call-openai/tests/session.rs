#[path = "support/flows.rs"]
mod flows;
use futures::SinkExt;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use tokio_tungstenite::tungstenite::Message;
use voice_call_openai::session::{
    Call, Config, Delegate, Event, Flow, LiveConfig, Session, Transport,
};
mod support;

#[tokio::test(start_paused = true)]
async fn automatic_replies_consume_pending_tool_continuations() -> flows::TestResult {
    for webrtc in [false, true] {
        flows::realtime_automatic_continuation(webrtc).await?;
    }
    Ok(())
}

#[tokio::test]
async fn webrtc_tools_run_during_speech_but_continuations_wait_for_server_audio()
-> flows::TestResult {
    for completion in ["output_audio_buffer.stopped", "output_audio_buffer.cleared"] {
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            flows::webrtc_continuation(completion),
        )
        .await??;
    }
    Ok(())
}

#[tokio::test]
async fn realtime_call_runs_with_an_independent_app_and_accounts_after_hangup() -> flows::TestResult
{
    tokio::time::timeout(std::time::Duration::from_secs(10), flows::realtime()).await??;
    Ok(())
}

#[tokio::test]
async fn live_call_runs_with_an_independent_app_and_accounts_after_hangup() -> flows::TestResult {
    tokio::time::timeout(std::time::Duration::from_secs(10), flows::live()).await??;
    Ok(())
}

#[tokio::test]
async fn cancelled_owned_calls_do_not_access_credentials_for_either_transport() -> flows::TestResult
{
    let audio = Arc::new(support::App::new(false)?);
    let credential = support::MockCredential::default();
    for transport in [Transport::WebRtc, Transport::WebSocket] {
        let config = Config::Realtime {
            settings: flows::realtime_config(),
            update: voice_call_openai::typed(
                json!({"type":"session.update","session":{"type":"realtime"}}),
            )?,
        };
        let failure = Call::connect(audio.clone(), &credential, config, transport)
            .await
            .err()
            .ok_or("Cancelled call connected")?;
        assert_eq!(failure.message, voice_call_openai::recovery::CANCELLED);
    }
    for transport in [Transport::WebRtc, Transport::WebSocket] {
        let config = Config::Live {
            session: serde_json::from_value(
                json!({"model":"custom-live","audio":{"output":{"voice":"custom-voice"}},"delegation":{"type":"client"}}),
            )?,
        };
        let failure = Call::connect(audio.clone(), &credential, config, transport)
            .await
            .err()
            .ok_or("Cancelled call connected")?;
        assert_eq!(failure.message, voice_call_openai::recovery::CANCELLED);
    }
    assert_eq!(credential.0.load(Ordering::Relaxed), 0);
    Ok(())
}

#[derive(Default)]
struct Observer<'a> {
    final_seconds: Option<f64>,
    events: usize,
    rejections: usize,
    transcripts: usize,
    unmute_on_start: Option<&'a support::App>,
}
impl Delegate for Observer<'_> {
    type Work = ();
    async fn next_work(&mut self) -> Option<()> {
        std::future::pending().await
    }
    fn work(
        &mut self,
        _: &mut Session<'_>,
        _: (),
    ) -> impl std::future::Future<Output = Result<Flow, &'static str>> + Send {
        std::future::ready(Ok(Flow::Stop))
    }
    async fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> Result<Flow, &'static str> {
        self.events += 1;
        if let Event::Live(frame) = event {
            match frame.event {
                oai_rt_rs::live::ServerEvent::Error { .. } => self.rejections += 1,
                oai_rt_rs::live::ServerEvent::OutputTranscriptDelta { .. } => self.transcripts += 1,
                oai_rt_rs::live::ServerEvent::Started { .. } => {
                    if let Some(audio) = self.unmute_on_start.take() {
                        session.mute(audio, false).await?;
                    }
                }
                _ => {}
            }
        }
        Ok(Flow::Continue)
    }
    fn live_usage(&mut self, seconds: f64, finalized: bool) {
        if finalized {
            self.final_seconds = Some(seconds);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_rejected_live_command_keeps_speech_and_final_usage_alive_without_replay()
-> flows::TestResult {
    for code in [Some("unknown_parameter"), None] {
        let audio = support::App::new(true)?;
        let (socket, mut commands, mut events) = voice_call_openai::RealtimeSocket::relay();
        let snapshot =
            json!({"id":"call","model":"custom-live","status":"active","expires_at":2_000_000_000});
        for event in [
            json!({"type":"session.started","event_id":"started","session":snapshot}),
            json!({"type":"error","event_id":"rejected","error":{"type":"invalid_request_error","code":code,"message":"Rejected an individual command","param":"session.voice","client_event_id":"voice-live:7"}}),
            json!({"type":"session.output_transcript.delta","event_id":"still-speaking","delta":"We can continue.","start_ms":1000,"end_ms":2000}),
            json!({"type":"session.usage.updated","event_id":"usage","usage":{"seconds":3.0}}),
            json!({"type":"session.closed","event_id":"closed","session":snapshot,"reason":"close_requested","usage":{"seconds":4.0}}),
        ] {
            events
                .send(Ok(Message::Text(event.to_string().into())))
                .await?;
        }
        let call = Call::from_live(
            socket,
            LiveConfig {
                model: "custom-live".into(),
                voice: "custom-voice".into(),
                backend_model: None,
                session_id: None,
            },
        );
        let mut observer = Observer::default();
        call.run(&audio, &mut observer).await?;
        assert_eq!(observer.rejections, 1);
        assert_eq!(observer.transcripts, 1);
        assert_eq!(observer.final_seconds, Some(4.0));
        use futures::StreamExt;
        assert!(
            commands.next().await.is_none(),
            "a rejected command must not be resent or end the call"
        );
    }
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn authentication_and_startup_rejections_still_fail_the_live_call() -> flows::TestResult {
    for (started, error_type, code, expected) in [
        (
            false,
            "authentication_error",
            "invalid_api_key",
            "GPT-Live rejected the API key. Check the saved OpenAI API key.",
        ),
        (
            true,
            "authentication_error",
            "invalid_api_key",
            "GPT-Live rejected the API key. Check the saved OpenAI API key.",
        ),
        (
            false,
            "invalid_request_error",
            "unknown_parameter",
            "GPT-Live rejected a session command. Please use the agent chat; no request will be replayed.",
        ),
    ] {
        let audio = support::App::new(true)?;
        let (socket, _commands, mut events) = voice_call_openai::RealtimeSocket::relay();
        let snapshot =
            json!({"id":"call","model":"custom-live","status":"active","expires_at":2_000_000_000});
        if started {
            events
                .send(Ok(Message::Text(
                    json!({"type":"session.started","event_id":"started","session":snapshot})
                        .to_string()
                        .into(),
                )))
                .await?;
        }
        events.send(Ok(Message::Text(json!({"type":"error","event_id":"rejected","error":{"type":error_type,"code":code,"message":"private provider details"}}).to_string().into()))).await?;
        events.send(Ok(Message::Text(json!({"type":"session.closed","event_id":"closed","session":snapshot,"reason":"close_requested","usage":{"seconds":0.0}}).to_string().into()))).await?;
        let call = Call::from_live(
            socket,
            LiveConfig {
                model: "custom-live".into(),
                voice: "custom-voice".into(),
                backend_model: None,
                session_id: None,
            },
        );
        assert_eq!(
            call.run(&audio, &mut Observer::default()).await,
            Err(expected)
        );
    }
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn a_rejected_unmute_never_reopens_capture_or_replays_the_command() -> flows::TestResult {
    use futures::StreamExt;
    use voice_call_openai::session::Audio;
    let audio = support::App::new(true)?;
    let (socket, mut commands, mut events) = voice_call_openai::RealtimeSocket::relay();
    let server = tokio::spawn(async move {
        let snapshot =
            json!({"id":"call","model":"custom-live","status":"active","expires_at":2_000_000_000});
        events
            .send(Ok(Message::Text(
                json!({"type":"session.started","event_id":"started","session":snapshot})
                    .to_string()
                    .into(),
            )))
            .await?;
        let Message::Text(command) = commands.next().await.ok_or("Missing unmute")? else {
            return Err("Unexpected command".into());
        };
        let command: serde_json::Value = serde_json::from_str(&command)?;
        assert_eq!(command["type"], "session.input_audio.unmute");
        events.send(Ok(Message::Text(json!({"type":"error","event_id":"rejected","error":{"type":"invalid_request_error","code":"unknown_parameter","message":"unmute rejected","client_event_id":command["event_id"]}}).to_string().into()))).await?;
        let Message::Text(close) = commands.next().await.ok_or("Missing close")? else {
            return Err("Unexpected command".into());
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&close)?["type"],
            "session.close"
        );
        events.send(Ok(Message::Text(json!({"type":"session.closed","event_id":"closed","session":snapshot,"reason":"close_requested","usage":{"seconds":3.0}}).to_string().into()))).await?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });
    let call = Call::from_live(
        socket,
        LiveConfig {
            model: "custom-live".into(),
            voice: "custom-voice".into(),
            backend_model: None,
            session_id: None,
        },
    );
    let mut observer = Observer {
        unmute_on_start: Some(&audio),
        ..Default::default()
    };
    assert_eq!(
        call.run(&audio, &mut observer).await,
        Err(voice_call_openai::live::errors::MICROPHONE_REJECTED)
    );
    assert!(audio.is_muted());
    assert_eq!(observer.final_seconds, Some(3.0));
    server.await??;
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn server_hangup_finishes_without_an_app_stop_command() -> flows::TestResult {
    let audio = support::App::new(true)?;
    let (socket, _commands, mut events) = voice_call_openai::RealtimeSocket::relay();
    let snapshot =
        json!({"id":"call","model":"custom-live","status":"active","expires_at":2_000_000_000});
    for event in [
        json!({"type":"session.started","event_id":"started","session":snapshot}),
        json!({"type":"session.closed","event_id":"closed","session":snapshot,"reason":"close_requested","usage":{"seconds":3.0}}),
    ] {
        events
            .send(Ok(Message::Text(event.to_string().into())))
            .await?;
    }
    let call = Call::from_live(
        socket,
        LiveConfig {
            model: "custom-live".into(),
            voice: "custom-voice".into(),
            backend_model: None,
            session_id: None,
        },
    );
    let mut observer = Observer::default();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        call.run(&audio, &mut observer),
    )
    .await??;
    assert_eq!(observer.events, 2);
    assert_eq!(observer.final_seconds, Some(3.0));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn wrong_provider_model_ends_the_call_without_opening_capture() -> flows::TestResult {
    let audio = support::App::new(true)?;
    let (socket, _commands, mut events) = voice_call_openai::RealtimeSocket::relay();
    events.send(Ok(Message::Text(json!({"type":"session.created","event_id":"wrong-model","session":{"id":"session","object":"realtime.session","type":"realtime","model":"other-model","expires_at":2_000_000_000,"output_modalities":["audio"]}}).to_string().into()))).await?;
    let call = Call::from_realtime(socket, flows::realtime_config());
    let mut observer = Observer::default();
    assert_eq!(
        call.run(&audio, &mut observer).await,
        Err(voice_call_openai::models::MISMATCH)
    );
    assert_eq!(observer.events, 0);
    assert!(audio.rendered().is_empty());
    Ok(())
}
