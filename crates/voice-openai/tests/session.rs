#[path = "support/flows.rs"]
mod flows;
use futures::SinkExt;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use tokio_tungstenite::tungstenite::Message;
use voice_openai::session::{Call, Config, Delegate, Event, Flow, LiveConfig, Session, Transport};
mod support;

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
            update: voice_openai::typed(
                json!({"type":"session.update","session":{"type":"realtime"}}),
            )?,
        };
        let failure = Call::connect(audio.clone(), &credential, config, transport)
            .await
            .err()
            .ok_or("Cancelled call connected")?;
        assert_eq!(failure.message, voice_openai::recovery::CANCELLED);
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
        assert_eq!(failure.message, voice_openai::recovery::CANCELLED);
    }
    assert_eq!(credential.0.load(Ordering::Relaxed), 0);
    Ok(())
}

#[derive(Default)]
struct Observer {
    final_seconds: Option<f64>,
    events: usize,
}
impl Delegate for Observer {
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
    fn event(
        &mut self,
        _: &mut Session<'_>,
        _: Event,
    ) -> impl std::future::Future<Output = Result<Flow, &'static str>> + Send {
        self.events += 1;
        std::future::ready(Ok(Flow::Continue))
    }
    fn live_usage(&mut self, seconds: f64, finalized: bool) {
        if finalized {
            self.final_seconds = Some(seconds);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn server_hangup_finishes_without_an_app_stop_command() -> flows::TestResult {
    let audio = support::App::new(true)?;
    let (socket, _commands, mut events) = voice_openai::RealtimeSocket::relay();
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
    let (socket, _commands, mut events) = voice_openai::RealtimeSocket::relay();
    events.send(Ok(Message::Text(json!({"type":"session.created","event_id":"wrong-model","session":{"id":"session","object":"realtime.session","type":"realtime","model":"other-model","expires_at":2_000_000_000,"output_modalities":["audio"]}}).to_string().into()))).await?;
    let call = Call::from_realtime(socket, flows::realtime_config());
    let mut observer = Observer::default();
    assert_eq!(
        call.run(&audio, &mut observer).await,
        Err(voice_openai::models::MISMATCH)
    );
    assert_eq!(observer.events, 0);
    assert!(audio.rendered().is_empty());
    Ok(())
}
